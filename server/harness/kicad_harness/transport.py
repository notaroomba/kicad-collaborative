"""How the harness reaches a design.

Every transport answers the same small set of calls (`list_components`, `get_geometry`,
`apply`, `run_checks`, ...), so `Project`, `Schematic` and `Board` do not care whether the
design is a folder of KiCad files, a live online project or the document open in the editor:

- `LocalEngine`: KiCad files on disk, through the design engine run with Node
  (`server/static/dist/harness-engine.js`, the editor's own code).
- `McpTransport`: an online project, through the server's MCP endpoint.  Edits are ordinary
  collaboration ops, so everyone in the document sees them as they happen.
- `HostTransport`: inside the MCP server's `run_python` tool, where the script runs in a
  sandbox and every call is answered by the server's headless editor.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading


class HarnessError(Exception):
    """A call the design engine refused, with its reason in plain words."""


class Transport:
    kind = "none"
    live = False

    def call(self, tool: str, args: dict | None = None) -> dict:
        raise NotImplementedError

    def save(self) -> list:
        return []

    def close(self) -> None:
        pass


def _find_engine() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    tries = [os.environ.get("KC_HARNESS_ENGINE") or "", os.path.join(here, "harness-engine.js"),
             os.path.normpath(os.path.join(here, "..", "..", "static", "dist", "harness-engine.js"))]
    for t in tries:
        if t and os.path.isfile(t):
            return t
    raise HarnessError("The design engine (harness-engine.js) was not found. Set KC_HARNESS_ENGINE to its path; "
                       "in the kicad-collaborative repository it is server/static/dist/harness-engine.js.")


class LocalEngine(Transport):
    """A project folder on this computer."""
    kind = "local"

    def __init__(self, files: list, name: str | None = None, libs: list | None = None, server: str | None = None,
                 token: str | None = None, engine: str | None = None, node: str | None = None):
        self._lock = threading.Lock()
        self._n = 0
        try:
            self._p = subprocess.Popen([node or os.environ.get("KC_NODE") or "node", engine or _find_engine()],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
        except FileNotFoundError as e:
            raise HarnessError("Node.js is needed to run the design engine and was not found (set KC_NODE).") from e
        ready = self._p.stdout.readline()
        if '"ready"' not in ready:
            raise HarnessError("The design engine did not start.")
        self.documents = self._send({"op": "open", "name": name, "files": [os.path.abspath(f) for f in files],
                                     "libs": libs or [], "server": server or "", "token": token or ""})

    def _send(self, req: dict):
        with self._lock:
            self._n += 1
            req["id"] = self._n
            try:
                self._p.stdin.write(json.dumps(req) + "\n")
                self._p.stdin.flush()
                line = self._p.stdout.readline()
            except (BrokenPipeError, OSError) as e:
                raise HarnessError("The design engine stopped.") from e
            if not line:
                raise HarnessError("The design engine stopped.")
            out = json.loads(line)
            if not out.get("ok"):
                raise HarnessError(out.get("error") or "The call failed.")
            return out.get("result")

    def call(self, tool, args=None):
        return self._send({"op": "call", "tool": tool, "args": args or {}})

    def save(self):
        return self._send({"op": "save"}).get("written", [])

    def close(self):
        try:
            self._p.stdin.close()
            self._p.wait(timeout=5)
        except Exception:
            self._p.kill()
        finally:
            try:
                self._p.stdout.close()
            except Exception:
                pass


class McpTransport(Transport):
    """An online project on a KiCad Collaborative server, through its MCP endpoint."""
    kind = "mcp"
    live = True
    _NAMES = {"apply": "apply_changes", "overview": "get_design_overview"}

    def __init__(self, url: str, token: str, project: str, live: bool = True):
        self.live_edits = live   # draw each batch step by step with a cursor, for the people watching
        self.url = url.rstrip("/") + ("" if url.rstrip("/").endswith("/mcp") else "/mcp")
        self.token = token
        self.project = project
        self._n = 0
        info = self._tool("get_project", {"project": project})
        self.documents = {"project": info.get("name") or project,
                          "documents": [{"path": d.get("path"), "type": d.get("type")} for d in info.get("documents", [])
                                        if str(d.get("path", "")).endswith((".kicad_sch", ".kicad_pcb"))]}

    def _tool(self, name: str, args: dict) -> dict:
        import urllib.error
        import urllib.request
        self._n += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._n, "method": "tools/call", "params": {"name": name, "arguments": args}}).encode()
        req = urllib.request.Request(self.url, data=body, method="POST", headers={
            "content-type": "application/json", "accept": "application/json, text/event-stream", "authorization": "Bearer " + self.token})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                raw = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raise HarnessError(f"The server answered {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from e
        except OSError as e:
            raise HarnessError(f"The server could not be reached: {e}") from e
        msg = None
        if raw.lstrip().startswith("{"):
            msg = json.loads(raw)
        else:
            for line in raw.splitlines():
                if line.startswith("data:"):
                    try:
                        m = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if isinstance(m, dict) and ("result" in m or "error" in m):
                        msg = m
        if msg is None:
            raise HarnessError("The server's answer could not be read.")
        if "error" in msg:
            raise HarnessError(str(msg["error"].get("message", msg["error"])))
        res = msg["result"]
        text = "".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        if res.get("isError"):
            raise HarnessError(text or "The call failed.")
        if isinstance(res.get("structuredContent"), dict):
            return res["structuredContent"]
        try:
            return json.loads(text)
        except ValueError:
            return {"text": text}

    def call(self, tool, args=None):
        args = dict(args or {})
        if tool == "documents":
            return self.documents
        if tool == "text":
            out, offset = [], 0
            while True:
                r = self._tool("read_document", {"project": self.project, "document": args.get("document"), "offset": offset, "max_chars": 100000})
                out.append(r.get("text", ""))
                if not r.get("next_offset"):
                    return {"document": r.get("document"), "text": "".join(out)}
                offset = r["next_offset"]
        args["project"] = self.project
        if tool == "apply":
            args.setdefault("title", "Python harness")
            if self.live_edits:
                args["live"] = True
        r = self._tool(self._NAMES.get(tool, tool), args)
        if tool == "apply":
            c = r.get("connectivity")
            r["connectivity"] = c.get("changed") if isinstance(c, dict) else None
        return r


class HostTransport(Transport):
    """Inside run_python: calls go to the headless editor that has the project open."""
    kind = "host"

    def __init__(self):
        import _kc_host  # provided by the runner
        self._host = _kc_host
        self.documents = self.call("documents")

    def call(self, tool, args=None):
        raw = self._host.call(tool, json.dumps(args or {}))
        out = json.loads(str(raw))
        if not out.get("ok"):
            raise HarnessError(out.get("error") or "The call failed.")
        return out.get("result")
