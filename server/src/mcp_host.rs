//! The headless editors behind the MCP endpoint.
//!
//! Reading a design as components and nets, checking it and changing it is done by the web
//! editor's own modules (web/ai, the schematic and board tools, the autorouter): TypeScript
//! that works on a parsed document.  This server never parses a KiCad file, so for MCP it
//! runs those modules in Node (web/mcp/host.ts, built into static/dist/mcp-host.js and
//! embedded here): one process per person using the endpoint, started on their first tool
//! call and gone after a quarter of an hour of silence.  A process holds the documents the
//! person's calls touched, joined over the collaboration socket like any editor, and takes
//! one call at a time.
//!
//! One process per person, not one for everybody: a call can be an autoroute that computes
//! for minutes, and it must not hold up anyone else's.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

const HOST_JS: &str = include_str!("../static/dist/mcp-host.js");
/// The process a run_python script runs in (web/harness/sandbox.ts); the host starts it from beside itself.
const SANDBOX_JS: &str = include_str!("../static/dist/harness-sandbox.js");

#[derive(Debug)]
pub enum HostError {
    /// Node is not installed, or the program could not be started.
    Unavailable(String),
    /// Every slot is taken by a call that is still running.
    Busy,
    /// The call ran past its time limit and its process was stopped.
    TimedOut,
    /// The process ended before it answered.
    Died,
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostError::Unavailable(why) => write!(f, "The design tools cannot run on this server: {why}"),
            HostError::Busy => write!(f, "The server is working on too many designs at once. Try again in a minute."),
            HostError::TimedOut => write!(f, "The tool ran out of time and was stopped. If it was routing or placing, ask for less at once or give it a smaller time_s."),
            HostError::Died => write!(f, "The design tools stopped unexpectedly. Try the call again."),
        }
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

struct Host {
    /// Held for the length of a call: the process runs one at a time, and a call's time
    /// limit must start when it starts running, not while it waits behind a long one.
    gate: tokio::sync::Mutex<()>,
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    last_used: Mutex<Instant>,
    /// Dropping the child stops the process (kill_on_drop).
    child: Mutex<Option<Child>>,
}

impl Host {
    fn stop(&self) {
        self.alive.store(false, Ordering::Relaxed);
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
        self.pending.lock().unwrap().clear();
    }

    fn idle(&self) -> bool {
        self.gate.try_lock().is_ok() && self.pending.lock().unwrap().is_empty()
    }
}

pub struct HostPool {
    hosts: Mutex<HashMap<i64, Arc<Host>>>,
    next_id: AtomicU64,
    max: usize,
}

fn node_binary() -> String {
    std::env::var("KC_NODE").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "node".into())
}

/// The embedded program, written out once per server process.
fn script_path() -> Result<&'static PathBuf, String> {
    static PATH: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    PATH.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("kc-mcp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("no temporary directory ({e})"))?;
        let path = dir.join("mcp-host.js");
        std::fs::write(&path, HOST_JS).map_err(|e| format!("the tool program could not be written ({e})"))?;
        std::fs::write(dir.join("harness-sandbox.js"), SANDBOX_JS).map_err(|e| format!("the tool program could not be written ({e})"))?;
        Ok(path)
    })
    .as_ref()
    .map_err(Clone::clone)
}

impl HostPool {
    pub fn new() -> Self {
        let max = std::env::var("MCP_MAX_HOSTS").ok().and_then(|v| v.parse().ok()).filter(|n| *n > 0).unwrap_or(24);
        HostPool { hosts: Mutex::new(HashMap::new()), next_id: AtomicU64::new(1), max }
    }

    async fn spawn(&self) -> Result<Arc<Host>, HostError> {
        let script = script_path().map_err(HostError::Unavailable)?;
        let mut child = Command::new(node_binary())
            // An autoroute of a dense board allocates a lot; the default heap of a small container is not enough.
            .arg("--max-old-space-size=1024")
            .arg(script)
            // run_python needs the Python runtime; without it that one tool says so and the rest work
            .env("KC_PYODIDE_DIR", crate::pcm::runtime_dir().and_then(|d| d.canonicalize().ok()).map(|d| d.into_os_string()).unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| HostError::Unavailable(format!("Node.js could not be started ({e}). Install node 22 or set KC_NODE to its path.")))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));

        tokio::spawn({
            let pending = pending.clone();
            let alive = alive.clone();
            async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                    let Some(id) = msg.get("id").and_then(Value::as_u64) else { continue };
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(msg);
                    }
                }
                // The process is gone: whoever is still waiting learns it by their sender being dropped.
                alive.store(false, Ordering::Relaxed);
                pending.lock().unwrap().clear();
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!("mcp host: {line}");
            }
        });

        Ok(Arc::new(Host {
            gate: tokio::sync::Mutex::new(()),
            stdin: tokio::sync::Mutex::new(stdin),
            pending,
            alive,
            last_used: Mutex::new(Instant::now()),
            child: Mutex::new(Some(child)),
        }))
    }

    async fn host_for(&self, user_id: i64) -> Result<Arc<Host>, HostError> {
        {
            let mut hosts = self.hosts.lock().unwrap();
            hosts.retain(|_, h| h.alive.load(Ordering::Relaxed));
            if let Some(h) = hosts.get(&user_id) {
                return Ok(h.clone());
            }
            if hosts.len() >= self.max {
                // Make room by stopping the process that has been quiet the longest.
                let quiet = hosts
                    .iter()
                    .filter(|(_, h)| h.idle())
                    .min_by_key(|(_, h)| *h.last_used.lock().unwrap())
                    .map(|(id, _)| *id);
                match quiet {
                    Some(id) => {
                        if let Some(h) = hosts.remove(&id) {
                            h.stop();
                        }
                    }
                    None => return Err(HostError::Busy),
                }
            }
        }
        let host = self.spawn().await?;
        let mut hosts = self.hosts.lock().unwrap();
        // Two first calls of one person can race here; the second process is dropped and stops.
        Ok(hosts.entry(user_id).or_insert(host).clone())
    }

    /// Run one tool call in the person's process and wait for its answer.
    pub async fn call(&self, user_id: i64, mut request: Value, limit: Duration) -> Result<Value, HostError> {
        let mut host = self.host_for(user_id).await?;
        let mut running = host.gate.lock().await;
        if !host.alive.load(Ordering::Relaxed) {
            // It was stopped while this call waited its turn (the one ahead timed out).
            drop(running);
            host = self.host_for(user_id).await?;
            running = host.gate.lock().await;
        }
        let _running = running;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        request["id"] = id.into();
        let (tx, rx) = oneshot::channel();
        host.pending.lock().unwrap().insert(id, tx);
        *host.last_used.lock().unwrap() = Instant::now();

        let mut line = request.to_string();
        line.push('\n');
        let written = {
            let mut stdin = host.stdin.lock().await;
            match stdin.write_all(line.as_bytes()).await {
                Ok(()) => stdin.flush().await,
                Err(e) => Err(e),
            }
        };
        if written.is_err() {
            host.stop();
            self.hosts.lock().unwrap().retain(|_, h| !Arc::ptr_eq(h, &host));
            return Err(HostError::Died);
        }
        match tokio::time::timeout(limit, rx).await {
            Ok(Ok(reply)) => {
                *host.last_used.lock().unwrap() = Instant::now();
                Ok(reply)
            }
            Ok(Err(_)) => Err(HostError::Died),
            Err(_) => {
                // Calls are run one after another, so a call that never returns blocks the
                // person's next ones: stop the process, the next call starts a fresh one.
                host.stop();
                self.hosts.lock().unwrap().retain(|_, h| !Arc::ptr_eq(h, &host));
                Err(HostError::TimedOut)
            }
        }
    }
}
