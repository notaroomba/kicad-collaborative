// dialogs/wakatime.ts — Preferences → Common → WakaTime: where the browser editor's heartbeats go.  The desktop
// app has the same page (common/dialogs/panel_wakatime.cpp), which writes ~/.wakatime.cfg like every WakaTime
// plugin; here the key is kept by the server (src/timetrack.rs), which sends the heartbeats, so it never sits in a
// page script.  WakaTime, Hackatime and Wakapi all speak the same API; Custom takes any other server's API URL.
import { h, checkbox, select } from "./dom";
import * as W from "../wakatime/api";

export interface WakaPage { apply(): Promise<void> }

export function wakatimePage(pg: HTMLElement, box: (host: HTMLElement, title: string) => HTMLElement): WakaPage {
  let s: W.WakaSettings | null = null;
  let enabled = true, preset = "wakatime", url = "", key = "", touched = false;
  const sb = box(pg, "WakaTime");
  const status = h("div", { class: "kd-note", id: "kd-waka-status", style: "margin:8px 0 0", "aria-live": "polite" }, "Loading…");
  sb.append(status);
  const about = box(pg, "How it works");
  about.append(h("p", { class: "kd-note", style: "margin:0" },
    "While you move, draw or edit in a schematic or board, a heartbeat goes out at most every two minutes, like WakaTime's editor plugins. " +
    "The server sends it with your key, which is never shown again or put in the page. The desktop app sends its own through wakatime-cli and ~/.wakatime.cfg on your computer."),
    h("p", { class: "kd-note", style: "margin:8px 0 0" }, "Junction keeps its own record too: ",
      h("a", { href: "/time", id: "kd-waka-timelink" }, "see the time you spent"), "."));
  const fail = (e: unknown) => { status.textContent = e instanceof Error ? e.message : String(e); status.style.color = "var(--err)"; };

  const render = () => {
    if (!s) return;
    const cur = s;
    sb.replaceChildren(sb.firstChild!);   // keep the box title
    const on = checkbox("Send heartbeats to WakaTime while I work in the browser editor", enabled, (v) => { enabled = v; touched = true; }, { id: "kd-waka-on" });
    const keyLink = h("a", { href: "#", target: "_blank", rel: "noreferrer", id: "kd-waka-keylink" }, "Get your API key");
    const urlIn = h("input", { type: "text", id: "kd-waka-url", value: url, placeholder: cur.defaultApiUrl, spellcheck: "false", style: "width:100%" }) as HTMLInputElement;
    const sync = () => {
      const p = cur.presets.find((x) => x.id === preset);
      urlIn.disabled = preset !== "custom";
      if (p) urlIn.value = p.apiUrl || cur.defaultApiUrl;
      keyLink.setAttribute("href", (p || cur.presets[0]).keyUrl);
      keyLink.style.display = preset === "custom" ? "none" : "";
    };
    const server = select([...cur.presets.map((p) => [p.id, p.label] as [string, string]), ["custom", "Custom"]], preset, (v) => {
      preset = v; touched = true;
      const p = cur.presets.find((x) => x.id === v); url = p ? p.apiUrl : url; sync();
    }, { id: "kd-waka-server", style: "width:160px" });
    urlIn.addEventListener("input", () => { url = urlIn.value.trim(); touched = true; });
    const keyIn = h("input", { type: "password", id: "kd-waka-key", autocomplete: "off", spellcheck: "false", style: "width:100%",
      placeholder: cur.hasKey ? `Saved key ending in …${cur.hint} (type a new one to replace it)` : "waka_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }) as HTMLInputElement;
    keyIn.addEventListener("input", () => { key = keyIn.value.trim(); touched = true; });
    const forget = h("button", { type: "button", class: "btn", id: "kd-waka-forget", disabled: !cur.hasKey, onclick: async () => {
      try { s = await W.forgetSettings(); enabled = true; preset = "wakatime"; url = ""; key = ""; touched = false; render(); } catch (e) { fail(e); }
    } }, "Remove Key");
    const test = h("button", { type: "button", class: "btn", id: "kd-waka-test", onclick: async () => {
      test.setAttribute("disabled", ""); line.textContent = "Sending a test heartbeat…"; line.style.color = "";
      try { await page.apply(); const r = await W.testSettings(); s = r.settings; render(); }
      catch (e) { line.textContent = e instanceof Error ? e.message : String(e); line.style.color = "var(--err)"; test.removeAttribute("disabled"); }
    } }, "Send Test Heartbeat");
    const line = h("div", { id: "kd-waka-status", "aria-live": "polite", style: "flex:1;min-width:0" });
    if (cur.last) { line.textContent = `Last heartbeat ${W.ago(cur.last.at)}: ${cur.last.status}`; line.style.color = cur.last.ok ? "var(--ok, var(--ink-2))" : "var(--err)"; }
    else line.textContent = cur.hasKey ? "No heartbeat sent yet." : "No key saved: nothing is sent.";
    sb.append(on,
      h("div", { style: "display:grid;grid-template-columns:max-content minmax(0,1fr) max-content;gap:6px 10px;align-items:center;margin-top:10px" },
        h("label", { for: "kd-waka-server" }, "Server:"), server, h("span"),
        h("label", { for: "kd-waka-url" }, "API URL:"), urlIn, h("span"),
        h("label", { for: "kd-waka-key" }, "API key:"), keyIn, forget,
        h("span"), keyLink, h("span")),
      h("div", { class: "kd-row", style: "margin-top:10px;gap:10px" }, test, line));
    sync();
  };

  const page: WakaPage = {
    async apply() {
      if (!s || !touched) return;
      const body: { enabled: boolean; apiUrl: string; apiKey?: string } = { enabled, apiUrl: preset === "custom" ? url : (s.presets.find((p) => p.id === preset)?.apiUrl ?? "") };
      if (key) body.apiKey = key;
      s = await W.saveSettings(body); touched = false; key = "";
    },
  };
  W.getSettings().then((r) => { s = r; enabled = r.hasKey ? r.enabled : true; url = r.apiUrl; preset = W.presetOf(r, r.apiUrl); render(); }, fail);
  return page;
}
