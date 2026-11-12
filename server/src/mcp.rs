//! The MCP endpoint: `POST /mcp` (Streamable HTTP), where an AI assistant (any model or service that speaks MCP) works on a person's online
//! projects.
//!
//! A tool call here does what the design assistant in the web editor does (web/ai), with the
//! same tool definitions and the same code: the assistant's tool list (web/ai/tools.json) is
//! the base of the catalog, and the calls are run by the same modules in a headless editor
//! (mcp_host.rs, web/mcp/host.ts) that has the document open over the collaboration socket.
//! An edit therefore travels the ordinary op pipeline and appears live for everybody in the
//! document.  The one difference from the assistant is deliberate: in the editor a person
//! accepts a proposal card, here the person approves the tool call in their own AI client, so
//! `apply_changes` applies.  Every change is recorded with its inverse and can be taken back
//! with `undo_changes`.
//!
//! Sign-in is OAuth (oauth.rs).  The endpoint keeps no session of its own: every request
//! carries a bearer token and stands alone, so any replica can answer it.

use std::sync::OnceLock;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use base64::Engine;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::error::AppResult;
use crate::mcp_host::HostPool;
use crate::oauth::{self, Caller};
use crate::{persist, AppState};

const ASSISTANT_TOOLS: &str = include_str!("../web/ai/tools.json");
const MCP_TOOLS: &str = include_str!("../web/mcp/tools.json");
const GUIDE: &str = include_str!("../web/mcp/guide.md");

const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL: &str = "2025-06-18";
/// What a tool may return as text before it is cut (the assistant's own limit).
const MAX_RESULT_CHARS: usize = 120_000;
/// An undo is not kept for a change whose inverse is larger than this (a deleted pour with its fill).
const MAX_UNDO_BYTES: usize = 6 * 1024 * 1024;

const INSTRUCTIONS: &str = "KiCad Collaborative: the person's online KiCad projects (schematics and boards), shared live with their collaborators. \
Start with list_projects, then get_design_overview for the project. Every design tool takes the project (id or exact name) and usually a document (a path from get_project, or \"board\"). \
Read the design with the tools instead of guessing: coordinates are millimetres with Y down, schematic items sit on a 1.27 mm grid, and pins connect only when a wire end or label lands exactly on the pin's connection point. \
render_view shows a sheet or the board as a picture. apply_changes edits the design at once and everyone in the project sees it live, so change only what the person asked for, use dry_run when unsure, check the result with run_checks and render_view, and take a wrong change back with undo_changes. \
Before drawing or rearranging a schematic, laying out or routing a board, or reviewing a design, read get_design_guide once; its schematic drawing rules are the owner's and are not optional.";

// ------------------------------------------------------------------ the catalog

struct Tool {
    def: Value,
    write: bool,
    /// Runs in the headless editor (false: answered here).
    host: bool,
    /// Takes a `project`.
    project: bool,
}

/// How an assistant tool is offered here: its name there, whether it takes a document,
/// its title, and a description when the assistant's speaks of the editor it runs in.
const REUSED: &[(&str, bool, &str, Option<&str>)] = &[
    ("get_design_overview", false, "Design overview", Some(
        "Summary of a project and of one of its documents: the project's schematic sheets and board, the person's role, and for the document its title block, how many symbols or footprints, wires or tracks and nets it has, its libraries and sub-sheets. Describes the root schematic sheet unless document names another sheet or the board. Call this first when you do not yet know what the design is.")),
    ("list_components", true, "List components", Some(
        "List the components of a schematic sheet (symbols) or of the board (footprints): reference, value, footprint, library id, position, and whether a Datasheet link and part number fields are present. Power symbols are left out unless include_power is true.")),
    ("get_component", true, "Get component", None),
    ("list_nets", true, "List nets", None),
    ("run_checks", true, "Run ERC or DRC", None),
    ("get_board_info", false, "Board info", None),
    ("get_items", true, "Get items", None),
    ("find_datasheets", true, "Find datasheets", Some(
        "For the parts of a schematic sheet or the board, grouped by part: the references that use it, value, footprint, the Datasheet field and any manufacturer, part number or distributor fields. Fetch the link to read the datasheet, or search the web for the part number when there is no usable link.")),
    ("read_datasheet", false, "Read datasheet", Some(
        "Read a PDF datasheet, application note or hardware design guide by its https address. The server downloads and indexes the file once and returns only the pages that answer the query, with page numbers, so a question costs a few thousand tokens instead of the whole document. Ask one focused question per call in the datasheet's own words (\"crystal load capacitance\", \"absolute maximum ratings\", a pin name), or give pages to read by number (up to 6). find_datasheets lists the datasheet links of a design's parts.")),
    ("find_parts", false, "Find parts", None),
    ("get_library_part", false, "Get library part", None),
];

const APPLY_HEAD: &str = "Change a schematic sheet or the board. The edits are validated against the live document and applied together as one change, through the same collaboration pipeline as a person's own edits: everyone who has the project open sees them at once, marked as made by the person through this app. If any edit is invalid nothing is applied and each problem is reported with its reason, so correct it and call again. With dry_run nothing is applied and the result says what the edits would do. Returns what each edit did, for a schematic how pin connections changed (a tidy-up must leave them unchanged), the engines' reports for placement and routing, and a change_id that undo_changes takes to revert the whole call. Only make changes the person asked for. Before drawing on a schematic read get_design_guide (topic schematic): the site's owner has firm drawing rules (wires inside a block and labels only between blocks, horizontal labels, supplies up and ground down, decoupling capacitors in a row on shared rails). ";

fn project_prop() -> Value {
    json!({ "type": "string", "description": "Project id or exact name, as listed by list_projects." })
}

fn document_prop() -> Value {
    json!({ "type": "string", "description": "Which document: its path as listed by get_project or get_design_overview (for example \"power.kicad_sch\"), or \"board\" for the board." })
}

fn annotations(title: &str, write: bool, destructive: bool) -> Value {
    json!({ "title": title, "readOnlyHint": !write, "destructiveHint": write && destructive, "idempotentHint": !write, "openWorldHint": false })
}

fn build_catalog() -> Vec<Tool> {
    let assistant: Vec<Value> = serde_json::from_str(ASSISTANT_TOOLS).expect("web/ai/tools.json is valid JSON");
    let find = |name: &str| -> &Value {
        assistant.iter().find(|t| t["name"] == name).unwrap_or_else(|| panic!("web/ai/tools.json has no tool {name}"))
    };
    let mut out = Vec::new();

    for (name, document, title, description) in REUSED {
        let src = find(name);
        let mut schema = src["input_schema"].clone();
        let takes_project = !matches!(*name, "find_parts" | "get_library_part" | "read_datasheet");
        {
            let props = schema["properties"].as_object_mut().expect("tool schema has properties");
            // The assistant reads "the open document" unless told otherwise; here every call names its own.
            props.remove("doc");
            let mut ordered = Map::new();
            if takes_project {
                ordered.insert("project".into(), project_prop());
            }
            if *document || *name == "get_design_overview" {
                ordered.insert("document".into(), document_prop());
            }
            ordered.extend(std::mem::take(props));
            *props = ordered;
        }
        let mut required: Vec<Value> = schema["required"].as_array().cloned().unwrap_or_default();
        if *document {
            required.insert(0, json!("document"));
        }
        if takes_project {
            required.insert(0, json!("project"));
        }
        if !required.is_empty() {
            schema["required"] = Value::Array(required);
        }
        let description = description
            .map(str::to_string)
            .unwrap_or_else(|| src["description"].as_str().unwrap_or("").replace("in the same proposal", "in the same apply_changes call"));
        out.push(Tool {
            def: json!({ "name": name, "title": title, "description": description, "inputSchema": schema, "annotations": annotations(title, false, false) }),
            write: false,
            host: true,
            project: takes_project,
        });
    }

    // apply_changes is the assistant's propose_changes: the same edits, applied instead of parked on a card.
    {
        let src = find("propose_changes");
        let text = src["description"].as_str().unwrap_or("");
        let ops = text.find("Edits, by `op`:").map(|at| &text[at..]).expect("propose_changes describes its edits");
        let ops = ops
            .replace("run the board autorouter over the missing connections of these nets (every unrouted net when nets is omitted) and propose the tracks and vias it finds", "run the board autorouter over the missing connections of these nets (every unrouted net when nets is omitted) and add the tracks and vias it finds")
            .replace("put it in a proposal of its own", "put it in a call of its own")
            .replace("so wires in the same proposal end exactly on the pins", "so wires in the same call end exactly on the pins")
            .replace("written to the project file when accepted", "written to the project file");
        debug_assert!(!ops.contains("proposal") && !ops.contains("propose"), "apply_changes still speaks of proposals");
        let mut schema = src["input_schema"].clone();
        {
            let props = schema["properties"].as_object_mut().expect("propose_changes has properties");
            let mut ordered = Map::new();
            ordered.insert("project".into(), project_prop());
            ordered.insert("document".into(), document_prop());
            ordered.insert("title".into(), json!({ "type": "string", "description": "A few words naming the change. It is what the person sees in the list of changes." }));
            ordered.insert("rationale".into(), json!({ "type": "string", "description": "One or two sentences on why, for someone who has not read the conversation." }));
            ordered.insert("edits".into(), props["edits"].clone());
            ordered.insert("dry_run".into(), json!({ "type": "boolean", "description": "Validate and describe the edits without applying them." }));
            ordered.insert("live".into(), json!({ "type": "boolean", "description": "Draw the change a few items at a time with your cursor on them, so people in the document can follow (default false: applied at once)." }));
            *props = ordered;
        }
        schema["required"] = json!(["project", "document", "title", "edits"]);
        out.push(Tool {
            def: json!({ "name": "apply_changes", "title": "Apply changes", "description": format!("{APPLY_HEAD}{ops}"), "inputSchema": schema, "annotations": annotations("Apply changes", true, true) }),
            write: true,
            host: true,
            project: true,
        });
    }

    let extra: Vec<Value> = serde_json::from_str(MCP_TOOLS).expect("web/mcp/tools.json is valid JSON");
    for t in extra {
        let name = t["name"].as_str().expect("tool name").to_string();
        let title = t["title"].as_str().unwrap_or(&name).to_string();
        let write = t["write"].as_bool().unwrap_or(false);
        let project = t["input_schema"]["properties"].get("project").is_some();
        let host = !matches!(name.as_str(), "list_projects" | "get_project" | "list_changes" | "get_design_guide");
        out.push(Tool {
            def: json!({ "name": name, "title": title, "description": t["description"], "inputSchema": t["input_schema"],
                         "annotations": annotations(&title, write, name == "undo_changes" || name == "redo_changes") }),
            write,
            host,
            project,
        });
    }

    // The order a model reads them in: find the project, read, look, change, then the rest.
    let order = [
        "list_projects", "get_project", "get_design_overview", "get_design_guide", "list_components", "get_component", "list_nets",
        "get_items", "run_checks", "check_layout", "get_board_info", "render_view", "find_datasheets", "read_datasheet", "find_parts", "get_library_part", "run_python", "apply_changes",
        "undo_changes", "redo_changes", "list_changes", "read_document", "list_comments", "add_comment", "resolve_comment", "list_checkpoints",
        "create_checkpoint", "create_project", "get_geometry",
    ];
    out.sort_by_key(|t| order.iter().position(|n| t.def["name"] == *n).unwrap_or(order.len()));
    out
}

fn catalog() -> &'static [Tool] {
    static CATALOG: OnceLock<Vec<Tool>> = OnceLock::new();
    CATALOG.get_or_init(build_catalog)
}

fn hosts() -> &'static HostPool {
    static POOL: OnceLock<HostPool> = OnceLock::new();
    POOL.get_or_init(HostPool::new)
}

// ------------------------------------------------------------------ prompts

const PROMPTS: &[(&str, &str, &str, &str)] = &[
    ("review_design", "Review a design", "Review a project's schematic and board and report the problems, ranked.",
     "Review the KiCad project {project} on KiCad Collaborative. Read get_design_guide (topic review) first, then the design itself: the overview, the components and nets of every sheet, the ERC and the DRC, a picture of each sheet and of the board, and the datasheets of the ICs. Report what would stop it from working first, then what is risky, then polish, naming the references and nets. Do not change anything unless I ask."),
    ("tidy_schematic", "Tidy a schematic", "Rearrange a schematic sheet so it reads cleanly, without changing any connection.",
     "Tidy the schematic of the KiCad project {project} on KiCad Collaborative so it reads like a careful engineer drew it. Read get_design_guide (topic schematic) first. Work one functional block per change, look at the sheet with render_view before and after, and make sure every change reports connectivity unchanged; undo any that does not."),
    ("design_board", "Design a board from a description", "Take a design from a description to a placed and routed board, in stages.",
     "Design this on KiCad Collaborative, in the project {project} (create it if it does not exist): {description}. Read get_design_guide first and work in its stages: requirements, parts with their datasheets, the schematic block by block, the board (update from schematic, outline, placement), rules and routing, then the checks and a short report of what to look at before ordering."),
];

fn prompts_list() -> Value {
    json!({ "prompts": PROMPTS.iter().map(|(name, title, description, text)| {
        let mut args = vec![json!({ "name": "project", "description": "The project's name", "required": true })];
        if text.contains("{description}") {
            args.push(json!({ "name": "description", "description": "What to build", "required": true }));
        }
        json!({ "name": name, "title": title, "description": description, "arguments": args })
    }).collect::<Vec<_>>() })
}

fn prompt_get(params: &Value) -> Result<Value, (i64, String)> {
    let name = params["name"].as_str().unwrap_or("");
    let Some((_, _, description, text)) = PROMPTS.iter().find(|p| p.0 == name) else {
        return Err((-32602, format!("unknown prompt {name}")));
    };
    let arg = |k: &str| params["arguments"][k].as_str().unwrap_or("").trim().to_string();
    let project = arg("project");
    let text = text
        .replace("{project}", if project.is_empty() { "(ask me which project)" } else { &project })
        .replace("{description}", &arg("description"));
    Ok(json!({ "description": description, "messages": [{ "role": "user", "content": { "type": "text", "text": text } }] }))
}

// ------------------------------------------------------------------ HTTP

fn unauthorized(state: &AppState, headers: &HeaderMap) -> Response {
    let challenge = format!("Bearer resource_metadata=\"{}\"", oauth::resource_metadata_url(state, headers));
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, HeaderValue::from_str(&challenge).unwrap_or(HeaderValue::from_static("Bearer")))],
        Json(json!({ "error": "unauthorized", "message": "Sign in to use this MCP server: your client will send you to the sign-in page." })),
    )
        .into_response()
}

/// `GET /mcp`: a browser gets the page that explains how to connect; an MCP client asking
/// for a server-to-client stream is told there is none (the endpoint only answers requests).
pub async fn get(headers: HeaderMap) -> Response {
    let accept = headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).unwrap_or("");
    if accept.contains("text/html") {
        return Redirect::to("/connect").into_response();
    }
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
}

/// `DELETE /mcp`: there is no session to end.
pub async fn delete() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// `POST /mcp`: one JSON-RPC message (or a batch of them, for clients of the older revision).
pub async fn post(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let caller = match oauth::caller(&state, &headers).await {
        Ok(Some(c)) => c,
        Ok(None) => return unauthorized(&state, &headers),
        Err(e) => {
            tracing::error!("mcp: authentication failed: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(rpc_error(Value::Null, -32700, "the body is not JSON"))).into_response();
    };
    let caller = std::sync::Arc::new(caller);
    let site = oauth::origin_of(&state, &headers);

    if let Value::Array(batch) = message {
        let mut replies = Vec::new();
        for m in batch {
            if let Some(reply) = handle(&state, &caller, &site, m).await {
                replies.push(reply);
            }
        }
        return if replies.is_empty() { StatusCode::ACCEPTED.into_response() } else { Json(Value::Array(replies)).into_response() };
    }

    // A tool call can compute for minutes (the autorouter).  When the client takes a stream,
    // answer with one and keep it warm, so nothing in between gives up on a silent connection.
    let accept = headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).unwrap_or("");
    let slow = message["method"] == "tools/call" && message.get("id").is_some() && accept.contains("text/event-stream");
    if !slow {
        return match handle(&state, &caller, &site, message).await {
            Some(reply) => Json(reply).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        };
    }

    let progress = message["params"]["_meta"].get("progressToken").cloned();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(8);
    tokio::spawn(async move {
        let work = handle(&state, &caller, &site, message);
        tokio::pin!(work);
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        tick.tick().await;
        let mut n = 0u64;
        let reply = loop {
            tokio::select! {
                reply = &mut work => break reply,
                _ = tick.tick() => {
                    n += 1;
                    let frame = match &progress {
                        Some(token) => format!("event: message\ndata: {}\n\n", json!({
                            "jsonrpc": "2.0", "method": "notifications/progress",
                            "params": { "progressToken": token, "progress": n, "message": format!("Working ({} s)", n * 10) } })),
                        None => ": working\n\n".to_string(),
                    };
                    if tx.send(Ok(Bytes::from(frame))).await.is_err() {
                        return;   // the client went away; the call itself is left to finish
                    }
                }
            }
        };
        if let Some(reply) = reply {
            let _ = tx.send(Ok(Bytes::from(format!("event: message\ndata: {reply}\n\n")))).await;
        }
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache, no-transform"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

/// Answer one JSON-RPC message.  `None` for a notification or a response, which get no reply.
async fn handle(state: &AppState, caller: &Caller, site: &str, message: Value) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str)?.to_string();
    let id = message.get("id").cloned()?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result: Result<Value, (i64, String)> = match method.as_str() {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or("");
            let version = if PROTOCOL_VERSIONS.contains(&asked) { asked } else { DEFAULT_PROTOCOL };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false }, "prompts": { "listChanged": false } },
                "serverInfo": { "name": "kicad-collaborative", "title": "KiCad Collaborative", "version": env!("CARGO_PKG_VERSION"),
                    "websiteUrl": site,
                    "icons": [
                        { "src": format!("{site}/icon-192.png"), "mimeType": "image/png", "sizes": ["192x192"] },
                        { "src": format!("{site}/icon-512.png"), "mimeType": "image/png", "sizes": ["512x512"] },
                        { "src": format!("{site}/favicon.svg"), "mimeType": "image/svg+xml", "sizes": ["any"] },
                    ] },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({
            // An app that was allowed to read only is not shown the tools that change things.
            "tools": catalog().iter().filter(|t| caller.can_write || !t.write).map(|t| t.def.clone()).collect::<Vec<_>>(),
        })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = match params.get("arguments") {
                Some(Value::Object(o)) => Value::Object(o.clone()),
                None | Some(Value::Null) => json!({}),
                Some(_) => return Some(rpc_error(id, -32602, "arguments must be an object")),
            };
            match catalog().iter().find(|t| t.def["name"] == name.as_str()) {
                None => Err((-32602, format!("unknown tool {name}"))),
                Some(tool) => Ok(match call_tool(state, caller, site, tool, &name, args).await {
                    Ok(content) => json!({ "content": content, "isError": false }),
                    Err(message) => json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
                }),
            }
        }
        "prompts/list" => Ok(prompts_list()),
        "prompts/get" => prompt_get(&params),
        "logging/setLevel" => Ok(json!({})),
        _ => Err((-32601, format!("method {method} is not supported"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => rpc_error(id, code, &message),
    })
}

// ------------------------------------------------------------------ projects

struct ProjectCtx {
    id: Uuid,
    name: String,
    role: String,
    docs: Vec<persist::Document>,
}

impl ProjectCtx {
    fn to_json(&self) -> Value {
        json!({ "projectId": self.id, "name": self.name, "role": self.role,
                "docs": self.docs.iter().map(|d| json!({ "docId": d.id, "path": d.path, "docType": d.doc_type })).collect::<Vec<_>>() })
    }
}

fn internal(e: impl std::fmt::Display) -> String {
    tracing::error!("mcp: {e}");
    "The server had a problem answering. Try again.".to_string()
}

/// The project a tool call names, if the person may see it.
async fn resolve_project(state: &AppState, caller: &Caller, key: &Value) -> Result<ProjectCtx, String> {
    let key = key.as_str().map(str::trim).filter(|k| !k.is_empty()).ok_or("project is required: its id or exact name, from list_projects.")?;
    let mine = persist::list_projects_for_user(&state.pool, caller.user.id).await.map_err(internal)?;
    let found = if let Ok(id) = key.parse::<Uuid>() {
        match mine.iter().find(|p| p.id == id) {
            Some(p) => Some((p.id, p.name.clone(), p.role.clone())),
            // Not in the person's list, but perhaps public: readable, never writable.
            None => match persist::effective_role(&state.pool, caller.user.id, id).await.map_err(internal)? {
                Some(role) => persist::get_project(&state.pool, id).await.map_err(internal)?.map(|p| (p.id, p.name, role)),
                None => None,
            },
        }
    } else {
        let lower = key.to_lowercase();
        let exact: Vec<_> = mine.iter().filter(|p| p.name.to_lowercase() == lower).collect();
        match exact.len() {
            1 => Some((exact[0].id, exact[0].name.clone(), exact[0].role.clone())),
            0 => None,
            _ => {
                return Err(format!(
                    "{} projects are named \"{key}\". Use the id of the one you mean: {}.",
                    exact.len(),
                    exact.iter().map(|p| format!("{} (owner {})", p.id, p.owner_login)).collect::<Vec<_>>().join(", ")
                ))
            }
        }
    };
    let Some((id, name, role)) = found else {
        let names: Vec<_> = mine.iter().take(30).map(|p| p.name.as_str()).collect();
        return Err(format!(
            "There is no project \"{key}\" this person can open. Their projects: {}.",
            if names.is_empty() { "(none yet; create_project starts one)".to_string() } else { names.join(", ") }
        ));
    };
    let docs = persist::project_documents(&state.pool, id).await.map_err(internal)?;
    Ok(ProjectCtx { id, name, role, docs })
}

async fn list_projects(state: &AppState, caller: &Caller, site: &str, args: &Value) -> Result<Value, String> {
    let q = args["query"].as_str().unwrap_or("").to_lowercase();
    let mut rows = persist::list_projects_for_user(&state.pool, caller.user.id).await.map_err(internal)?;
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let rows: Vec<_> = rows
        .iter()
        .filter(|p| q.is_empty() || p.name.to_lowercase().contains(&q) || p.description.to_lowercase().contains(&q))
        .collect();
    let cap = 100;
    Ok(json!({
        "account": caller.user.login,
        "count": rows.len(),
        "projects": rows.iter().take(cap).map(|p| json!({
            "id": p.id, "name": p.name, "role": p.role, "owner": p.owner_login,
            "description": if p.description.is_empty() { None } else { Some(&p.description) },
            "documents": p.doc_count, "members": p.member_count, "starred": if p.starred { Some(true) } else { None },
            "updated": p.updated_at.to_rfc3339(), "url": format!("{site}/p/{}/edit", p.id),
        })).collect::<Vec<_>>(),
        "truncated": if rows.len() > cap { Some(format!("showing {cap} of {}; narrow with query", rows.len())) } else { None },
    }))
}

async fn get_project(state: &AppState, site: &str, p: &ProjectCtx) -> Result<Value, String> {
    let members = persist::list_members(&state.pool, p.id).await.map_err(internal)?;
    let kind = |t: &str| match t {
        "kicad_sch" => "schematic",
        "kicad_pcb" => "board",
        "kicad_pro" => "project file",
        _ => "other",
    };
    Ok(json!({
        "id": p.id, "name": p.name, "your_role": p.role, "url": format!("{site}/p/{}/edit", p.id),
        "documents": p.docs.iter().map(|d| json!({ "path": d.path, "type": kind(&d.doc_type) })).collect::<Vec<_>>(),
        "members": members.iter().map(|m| json!({ "login": m.login, "role": m.role })).collect::<Vec<_>>(),
        "note": "Schematic sheets and the board are what the document parameter of the other tools takes.",
    }))
}

async fn list_changes(state: &AppState, caller: &Caller, p: &ProjectCtx, args: &Value) -> Result<Value, String> {
    let only = match args["document"].as_str().filter(|d| !d.trim().is_empty()) {
        Some(name) => Some(find_doc(p, name)?.id),
        None => None,
    };
    let rows = sqlx::query(
        "SELECT id, doc_id, title, edits, client, undo IS NOT NULL AS can_undo, undone_at, created_at
         FROM mcp_changes WHERE project_id = $1 AND user_id = $2 AND ($3::uuid IS NULL OR doc_id = $3)
         ORDER BY id DESC LIMIT 50",
    )
    .bind(p.id)
    .bind(caller.user.id)
    .bind(only)
    .fetch_all(&state.pool)
    .await
    .map_err(internal)?;
    let changes: Vec<Value> = rows
        .iter()
        .map(|r| {
            let doc_id: Uuid = r.get("doc_id");
            let edits: Value = r.get("edits");
            let edits = edits.as_array().cloned().unwrap_or_default();
            json!({
                "change_id": r.get::<i64, _>("id"),
                "title": r.get::<String, _>("title"),
                "document": p.docs.iter().find(|d| d.id == doc_id).map(|d| d.path.clone()),
                "edits": edits.iter().take(12).collect::<Vec<_>>(),
                "more_edits": if edits.len() > 12 { Some(edits.len() - 12) } else { None },
                "made_with": Some(r.get::<String, _>("client")).filter(|c| !c.is_empty()).unwrap_or_else(|| "AI assistant".into()),
                "at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
                "undone": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("undone_at").map(|t| t.to_rfc3339()),
                "can_undo": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("undone_at").is_none() && r.get::<bool, _>("can_undo"),
                "can_redo": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("undone_at").is_some() && r.get::<bool, _>("can_undo"),
            })
        })
        .collect();
    Ok(json!({ "project": p.name, "count": changes.len(), "changes": changes }))
}

fn find_doc<'a>(p: &'a ProjectCtx, name: &str) -> Result<&'a persist::Document, String> {
    let q = name.trim().to_lowercase();
    let base = |path: &str| path.rsplit('/').next().unwrap_or(path).to_lowercase();
    p.docs
        .iter()
        .find(|d| d.path.to_lowercase() == q)
        .or_else(|| p.docs.iter().find(|d| base(&d.path) == q))
        .or_else(|| if matches!(q.as_str(), "board" | "pcb") { p.docs.iter().find(|d| d.doc_type == "kicad_pcb") } else { None })
        .ok_or_else(|| format!("There is no document \"{name}\" in {}.", p.name))
}

// ------------------------------------------------------------------ calling a tool

fn guide(topic: &str) -> Result<String, String> {
    let heading = match topic {
        "" | "all" => return Ok(GUIDE.to_string()),
        "schematic" => "## Drawing schematics",
        "board" => "## Designing a board from a prompt",
        "routing" => "## Routing a board",
        "review" => "## Reviewing a design",
        "python" => "## Scripting with Python",
        other => return Err(format!("There is no topic \"{other}\". Topics: all, python, schematic, board, routing, review.")),
    };
    // Every topic comes with the opening section: how changes work here applies to all of them.
    let section = |h: &str| -> &str {
        let start = GUIDE.find(h).unwrap_or(0);
        let rest = &GUIDE[start..];
        let end = rest[2..].find("\n## ").map(|i| i + 2).unwrap_or(rest.len());
        rest[..end].trim_end()
    };
    Ok(format!("{}\n\n{}\n", section("## Working on a design"), section(heading)))
}

fn text_content(result: &Value) -> Value {
    let mut text = match result {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if text.len() > MAX_RESULT_CHARS {
        let mut cut = MAX_RESULT_CHARS;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("… (cut: too long; ask for less with a filter)");
    }
    json!({ "type": "text", "text": text })
}

/// A token for the headless editor to act as the person against this server: short lived, it
/// never leaves the machine.
fn internal_token(state: &AppState, caller: &Caller) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = crate::auth::Claims { sub: caller.user.id, login: caller.user.login.clone(), iat: now, exp: now + 2 * 3600 };
    jsonwebtoken::encode(&jsonwebtoken::Header::default(), &claims, &jsonwebtoken::EncodingKey::from_secret(state.cfg.jwt_secret.as_bytes()))
        .expect("jwt encode")
}

fn own_address() -> String {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    format!("http://127.0.0.1:{port}")
}

/// Run a tool and return its MCP content, or the message of a failure the model can act on.
async fn call_tool(state: &AppState, caller: &Caller, site: &str, tool: &Tool, name: &str, mut args: Value) -> Result<Value, String> {
    if tool.write && !caller.can_write {
        return Err("This connection was allowed to read only. To let it make changes, disconnect it under Connected apps and connect again with \"Let it make changes\" ticked.".into());
    }
    let project = if tool.project { Some(resolve_project(state, caller, &args["project"]).await?) } else { None };

    // The person's role on the project decides, whatever the connection was allowed: a
    // commenter's assistant may comment, a viewer's may only read.  The endpoints the tools
    // go through refuse as well (http.rs, ws.rs); this is the answer a model can act on.
    if let (true, Some(p)) = (tool.write, &project) {
        let commenting = matches!(name, "add_comment" | "resolve_comment");
        let allowed = match p.role.as_str() {
            "editor" => true,
            "commenter" => commenting,
            _ => false,
        };
        if !allowed {
            return Err(match (p.role.as_str(), commenting) {
                ("commenter", _) => format!(
                    "This person can comment on \"{}\" but not change it. add_comment and resolve_comment work; to make changes they need the owner to give them the editor role.",
                    p.name
                ),
                (_, true) => format!(
                    "This person can only view \"{}\", not comment on it. They need the owner to give them the commenter or editor role.",
                    p.name
                ),
                _ => format!(
                    "This person can only view \"{}\". To change it they need the owner to give them the editor role.",
                    p.name
                ),
            });
        }
    }

    match name {
        "list_projects" => return Ok(json!([text_content(&list_projects(state, caller, site, &args).await?)])),
        "get_project" => return Ok(json!([text_content(&get_project(state, site, project.as_ref().expect("project")).await?)])),
        "list_changes" => return Ok(json!([text_content(&list_changes(state, caller, project.as_ref().expect("project"), &args).await?)])),
        "get_design_guide" => return Ok(json!([{ "type": "text", "text": guide(args["topic"].as_str().unwrap_or(""))? }])),
        _ => {}
    }
    debug_assert!(tool.host);

    // undo_changes and redo_changes: the record of what to take back (or, once undone, what to put
    // back) is kept here; the editor does it, and hands over the record for the opposite direction.
    let mut undoing: Option<(i64, bool)> = None;
    if name == "undo_changes" || name == "redo_changes" {
        let redo = name == "redo_changes";
        let p = project.as_ref().expect("project");
        let row = sqlx::query(
            "SELECT id, doc_id, title, undo, undone_at FROM mcp_changes
             WHERE project_id = $1 AND user_id = $2 AND ($3::bigint IS NULL OR id = $3)
               AND ($3::bigint IS NOT NULL OR (undone_at IS NOT NULL) = $4)
             ORDER BY CASE WHEN $4 THEN undone_at END DESC NULLS LAST, id DESC LIMIT 1",
        )
        .bind(p.id)
        .bind(caller.user.id)
        .bind(args["change_id"].as_i64())
        .bind(redo)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?;
        let Some(row) = row else {
            return Err(match args["change_id"].as_i64() {
                Some(id) => format!("There is no change {id} of yours in {}. list_changes shows them.", p.name),
                None if redo => format!("There is no undone change of yours in {} to redo.", p.name),
                None => format!("There is no change of yours in {} left to undo.", p.name),
            });
        };
        let id: i64 = row.get("id");
        let title: String = row.get("title");
        let undone = row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("undone_at").is_some();
        if undone != redo {
            return Err(if redo { format!("\"{title}\" (change {id}) has not been undone, so there is nothing to redo.") }
                       else { format!("\"{title}\" (change {id}) has already been undone. redo_changes puts it back.") });
        }
        let Some(undo) = row.get::<Option<Value>, _>("undo") else {
            return Err(format!("\"{title}\" (change {id}) is too large or too old to {} as a whole. Make a new change instead.", if redo { "redo" } else { "undo" }));
        };
        args["__record"] = json!({ "docId": row.get::<Uuid, _>("doc_id"), "title": title, "undo": undo });
        undoing = Some((id, redo));
    }
    if name == "create_project" {
        // Every other tool finds a project by its name, so a second one of the same name is a trap.
        let wanted = args["name"].as_str().unwrap_or("").trim().to_string();
        let taken: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM projects WHERE owner_id = $1 AND deleted_at IS NULL AND lower(name) = lower($2) LIMIT 1")
            .bind(caller.user.id).bind(&wanted).fetch_optional(&state.pool).await.map_err(|e| { tracing::error!("mcp create_project: {e}"); "The server could not check the project name.".to_string() })?;
        if let Some(id) = taken {
            return Err(format!("This person already has a project named \"{wanted}\" (id {id}). Work on that one, or choose another name."));
        }
        args["__site"] = json!(site);
    }

    let width_px = args["width_px"].as_u64().unwrap_or(1500).clamp(400, 2000) as u32;
    let request = json!({
        "base": own_address(),
        "token": internal_token(state, caller),
        "agent": if caller.client.is_empty() { "AI assistant" } else { caller.client.as_str() },
        "canWrite": caller.can_write,
        "user": { "id": caller.user.id, "login": caller.user.login, "name": caller.user.name.clone().unwrap_or_else(|| caller.user.login.clone()) },
        "tool": name,
        "project": project.as_ref().map(ProjectCtx::to_json),
        "args": args,
    });
    // The autorouter may be given up to five minutes by the call itself.
    let limit = Duration::from_secs(if name == "apply_changes" { 420 } else if name == "run_python" { 480 } else { 150 });
    let reply = hosts().call(caller.user.id, request, limit).await.map_err(|e| e.to_string())?;
    if reply["ok"] != true {
        return Err(reply["error"].as_str().unwrap_or("The tool failed.").to_string());
    }
    let mut result = reply["result"].clone();

    if let (Some(record), Some(p)) = (reply.get("record"), project.as_ref()) {
        match store_change(state, caller, p, record).await {
            Ok(id) => {
                result["change_id"] = json!(id);
                result["undo"] = json!(format!("undo_changes with change_id {id} takes this back."));
            }
            Err(e) => {
                tracing::error!("mcp: change record not stored: {e}");
                result["undo"] = json!("The change was applied, but no undo record could be stored for it.");
            }
        }
    }
    // run_python: one record per document the script changed
    if let (Some(records), Some(p)) = (reply.get("records").and_then(Value::as_array), project.as_ref()) {
        let mut ids = Vec::new();
        for record in records {
            match store_change(state, caller, p, record).await {
                Ok(id) => ids.push(id),
                Err(e) => tracing::error!("mcp: change record not stored: {e}"),
            }
        }
        if ids.len() == records.len() && !ids.is_empty() {
            result["change_ids"] = json!(ids);
            result["undo"] = json!("undo_changes takes the script's edits back, one document per call, newest first.");
        } else if !records.is_empty() {
            result["undo"] = json!("The edits were applied, but no undo record could be stored for all of them.");
        }
    }
    if let Some((id, redo)) = undoing {
        // The record now runs the other way: what this call did, to be taken back by the opposite tool.
        let back = reply.get("swap").filter(|u| u.to_string().len() <= MAX_UNDO_BYTES);
        if let Err(e) = sqlx::query("UPDATE mcp_changes SET undone_at = CASE WHEN $2 THEN NULL ELSE now() END, undo = $3 WHERE id = $1")
            .bind(id).bind(redo).bind(back).execute(&state.pool).await {
            tracing::error!("mcp: undo not recorded: {e}");
        }
        result["change_id"] = json!(id);
    }

    if let Some(svg) = reply["svg"].as_str() {
        let svg = svg.to_string();
        let png = tokio::task::spawn_blocking(move || rasterize(&svg, width_px)).await.map_err(internal)??;
        result["image_px"] = json!([png.1, png.2]);
        return Ok(json!([
            { "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(&png.0), "mimeType": "image/png" },
            text_content(&result),
        ]));
    }
    Ok(json!([text_content(&result)]))
}

async fn store_change(state: &AppState, caller: &Caller, p: &ProjectCtx, record: &Value) -> AppResult<i64> {
    let doc_id: Uuid = record["docId"].as_str().and_then(|s| s.parse().ok()).ok_or_else(|| anyhow::anyhow!("change record without a document"))?;
    let undo = Some(&record["undo"]).filter(|u| u.to_string().len() <= MAX_UNDO_BYTES);
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO mcp_changes (user_id, project_id, doc_id, title, edits, undo, client) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(caller.user.id)
    .bind(p.id)
    .bind(doc_id)
    .bind(record["title"].as_str().unwrap_or(""))
    .bind(&record["edits"])
    .bind(undo)
    .bind(&caller.client)
    .fetch_one(&state.pool)
    .await?;
    // An undo is for the recent past; the record of what was changed stays.
    sqlx::query("UPDATE mcp_changes SET undo = NULL WHERE undo IS NOT NULL AND created_at < now() - interval '30 days'")
        .execute(&state.pool)
        .await?;
    Ok(id)
}

/// SVG to PNG, the longest side `longest` pixels.  The picture carries its text as paths
/// (web/mcp/picture.ts), so no fonts are needed.
pub(crate) fn rasterize(svg: &str, longest: u32) -> Result<(Vec<u8>, u32, u32), String> {
    use resvg::{tiny_skia, usvg};
    let tree = usvg::Tree::from_str(svg, &usvg::Options::default()).map_err(|e| format!("The picture could not be drawn ({e})."))?;
    let size = tree.size();
    let scale = longest as f32 / size.width().max(size.height()).max(1.0);
    let (w, h) = (((size.width() * scale).ceil() as u32).max(1), ((size.height() * scale).ceil() as u32).max(1));
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or("The picture is too large to draw.")?;
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let png = pixmap.encode_png().map_err(|e| format!("The picture could not be encoded ({e})."))?;
    Ok((png, w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_complete_and_well_formed() {
        let tools = catalog();
        let names: Vec<&str> = tools.iter().map(|t| t.def["name"].as_str().unwrap()).collect();
        for want in ["list_projects", "get_design_overview", "list_components", "run_checks", "render_view", "apply_changes", "undo_changes", "add_comment"] {
            assert!(names.contains(&want), "{want} is missing");
        }
        // What only makes sense inside the editor is not offered.
        for gone in ["get_selection", "focus_view", "open_document", "propose_changes", "list_plugin_tools", "call_plugin_tool"] {
            assert!(!names.contains(&gone), "{gone} should not be offered");
        }
        let mut seen = std::collections::HashSet::new();
        for t in tools {
            let name = t.def["name"].as_str().unwrap();
            assert!(seen.insert(name), "{name} is listed twice");
            assert!(t.def["description"].as_str().is_some_and(|d| d.len() > 40), "{name} needs a real description");
            assert_eq!(t.def["inputSchema"]["type"], "object", "{name}");
            assert!(t.def["inputSchema"]["properties"].get("doc").is_none(), "{name} still takes doc");
            assert_eq!(t.project, t.def["inputSchema"]["properties"].get("project").is_some(), "{name}");
            if t.project {
                assert!(t.def["inputSchema"]["required"].as_array().is_some_and(|r| r.contains(&json!("project"))), "{name} must require project");
            }
            assert_eq!(t.def["annotations"]["readOnlyHint"], !t.write, "{name}");
        }
    }

    #[test]
    fn apply_changes_carries_every_edit_of_the_assistant() {
        let apply = catalog().iter().find(|t| t.def["name"] == "apply_changes").unwrap();
        let text = apply.def["description"].as_str().unwrap();
        for op in ["set_field", "add_symbol", "add_wire", "update_from_schematic", "auto_place", "autoroute", "set_rules", "add_item"] {
            assert!(text.contains(op), "{op}");
        }
        assert!(!text.contains("proposal") && !text.contains("propose") && !text.contains("card"), "apply_changes must not speak of proposals");
        assert!(apply.def["inputSchema"]["properties"]["edits"]["items"]["properties"]["op"]["enum"].as_array().unwrap().len() >= 16);
        assert!(apply.write);
    }

    #[test]
    fn guide_topics() {
        assert!(guide("").unwrap().contains("## Reviewing a design"));
        let routing = guide("routing").unwrap();
        assert!(routing.starts_with("## Working on a design") && routing.contains("## Routing a board") && !routing.contains("## Reviewing a design"));
        assert!(guide("nope").is_err());
    }

    #[test]
    fn picture_is_rasterised_to_the_asked_size() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20"><rect width="40" height="20" fill="#001023"/><path d="M2 2L38 18" stroke="#C83434" stroke-width="1" fill="none"/></svg>"##;
        let (png, w, h) = rasterize(svg, 800).unwrap();
        assert_eq!((w, h), (800, 400));
        assert_eq!(&png[1..4], b"PNG");
    }

    #[test]
    fn prompts_fill_in_their_arguments() {
        let p = prompt_get(&json!({ "name": "review_design", "arguments": { "project": "amp" } })).unwrap();
        assert!(p["messages"][0]["content"]["text"].as_str().unwrap().contains("project amp"));
        assert!(prompt_get(&json!({ "name": "nope" })).is_err());
    }
}
