// TimePage.tsx — /time: the time spent in Junction, like a WakaTime dashboard.  Yours by day,
// project and app, or one project's (/time?project=<id>) by day, person and document.  Every
// signed-in client is counted (src/timetrack.rs); below it, where the browser editor's
// heartbeats go (the same settings as Preferences → Common → WakaTime).
import { useCallback, useEffect, useState } from "react";
import { Select } from "../components/Select";
import * as W from "../wakatime/api";
import { Avatar, Ic, toast } from "./ui";

const go = (path: string) => { if (window.CollabNav) window.CollabNav.navigate(path); else location.href = path; };
const RANGES = [{ value: "7", label: "Last 7 days" }, { value: "14", label: "Last 14 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }];
const CLIENTS: Record<string, string> = { web: "Browser editor", desktop: "Desktop app" };

function Bars({ days }: { days: W.DaySpan[] }) {
  const max = Math.max(3600, ...days.map((d) => d.seconds));
  const label = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
  return (
    <div className="tp-bars" role="img" aria-label="Time spent per day">
      {days.map((d) => (
        <div className="tp-bar" key={d.day} title={`${label(d.day)}: ${W.duration(d.seconds)}`}>
          <div className="tp-bar-track"><div className="tp-bar-fill" style={{ height: `${(100 * d.seconds) / max}%` }} /></div>
          <span className="tp-bar-day">{days.length <= 14 ? <><span className="wide">{label(d.day)}</span><span className="narrow">{+d.day.slice(8)}</span></> : ""}</span>
        </div>
      ))}
    </div>
  );
}

function Rows({ rows }: { rows: { key: string; label: React.ReactNode; seconds: number; onClick?: () => void; sub?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.seconds));
  if (!rows.length) return <p className="tp-none">Nothing yet.</p>;
  return (
    <ul className="tp-rows">
      {rows.map((r) => (
        <li key={r.key} className={r.onClick ? "tp-row link" : "tp-row"} onClick={r.onClick} tabIndex={r.onClick ? 0 : undefined}
          onKeyDown={(ev) => { if (r.onClick && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); r.onClick(); } }}>
          <div className="tp-row-name">{r.label}{r.sub ? <span className="tp-row-sub">{r.sub}</span> : null}</div>
          <div className="tp-row-meter"><div style={{ width: `${(100 * r.seconds) / max}%` }} /></div>
          <div className="tp-row-time">{W.duration(r.seconds)}</div>
        </li>
      ))}
    </ul>
  );
}

function WakaSettings() {
  const [s, setS] = useState<W.WakaSettings | null>(null);
  const [preset, setPreset] = useState("wakatime");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const take = (r: W.WakaSettings) => { setS(r); setPreset(W.presetOf(r, r.apiUrl)); setUrl(r.apiUrl); setEnabled(r.hasKey ? r.enabled : true); setKey(""); };
  useEffect(() => { W.getSettings().then(take, (e) => setErr(e instanceof Error ? e.message : String(e))); }, []);
  if (!s) return <section className="tp-card" id="wakatime"><h2>WakaTime</h2><p className="tp-none">{err || "Loading…"}</p></section>;
  const p = s.presets.find((x) => x.id === preset);
  const shownUrl = preset === "custom" ? url : (p?.apiUrl || s.defaultApiUrl);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const save = () => W.saveSettings({ enabled, apiUrl: preset === "custom" ? url : (p?.apiUrl ?? ""), ...(key ? { apiKey: key } : {}) }).then(take);
  return (
    <section className="tp-card" id="wakatime">
      <h2>WakaTime</h2>
      <p className="tp-lead">Send your time in the browser editor to WakaTime, Hackatime or Wakapi. Junction's server sends the heartbeats with your key, so the key is never put in a page. The desktop app uses wakatime-cli and ~/.wakatime.cfg on your computer, like every WakaTime plugin. Also in the editor under Preferences → Common → WakaTime.</p>
      <label className="tp-check"><input type="checkbox" id="tpWakaOn" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Send heartbeats while I work in the browser editor</label>
      <div className="tp-form">
        <label htmlFor="tpWakaServer">Server</label>
        <Select id="tpWakaServer" value={preset} onChange={(v) => { setPreset(v); const q = s.presets.find((x) => x.id === v); if (q) setUrl(q.apiUrl); }}
          options={[...s.presets.map((x) => ({ value: x.id, label: x.label })), { value: "custom", label: "Custom" }]} />
        <label htmlFor="tpWakaUrl">API URL</label>
        <input id="tpWakaUrl" className="input" value={shownUrl} disabled={preset !== "custom"} spellCheck={false} placeholder={s.defaultApiUrl} onChange={(e) => setUrl(e.target.value)} />
        <label htmlFor="tpWakaKey">API key</label>
        <div className="tp-keyrow">
          <input id="tpWakaKey" className="input" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value.trim())}
            placeholder={s.hasKey ? `Saved key ending in …${s.hint}` : "waka_xxxxxxxx-xxxx-…"} />
          {p ? <a href={p.keyUrl} target="_blank" rel="noreferrer">Get your key</a> : null}
        </div>
      </div>
      <div className="tp-acts">
        <button type="button" className="btn primary" id="tpWakaSave" disabled={busy} onClick={() => run(async () => { await save(); toast("WakaTime settings saved"); })}>Save</button>
        <button type="button" className="btn" id="tpWakaTest" disabled={busy || (!s.hasKey && !key)} onClick={() => run(async () => { await save(); const r = await W.testSettings(); take(r.settings); toast(r.ok ? "Test heartbeat accepted" : `Test heartbeat failed: ${r.status}`, { kind: r.ok ? "ok" : "err" }); })}>Send test heartbeat</button>
        {s.hasKey ? <button type="button" className="btn" id="tpWakaForget" disabled={busy} onClick={() => run(async () => { take(await W.forgetSettings()); toast("Key removed"); })}>Remove key</button> : null}
      </div>
      <p className={"tp-status" + (s.last && !s.last.ok ? " bad" : "")} id="tpWakaStatus" aria-live="polite">
        {err ? <span className="bad">{err}</span> : s.last ? `Last heartbeat ${W.ago(s.last.at)}: ${s.last.status}` : s.hasKey ? "No heartbeat sent yet." : "No key saved, so nothing is sent."}
      </p>
    </section>
  );
}

export function TimePage({ tick }: { tick: number }) {
  const project = new URLSearchParams(location.search).get("project");
  const [days, setDays] = useState(() => { try { return localStorage.getItem("kc.time.days") || "14"; } catch { return "14"; } });
  const [mine, setMine] = useState<W.MyTime | null>(null);
  const [proj, setProj] = useState<W.ProjectTime | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    try { if (project) { setProj(await W.projectTime(project, +days)); } else { setMine(await W.myTime(+days)); } }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [project, days]);
  useEffect(() => { load(); }, [load, tick]);
  const pick = (v: string) => { setDays(v); try { localStorage.setItem("kc.time.days", v); } catch { /* private window */ } };
  const data = project ? proj : mine;
  return (
    <>
      <header className="hp-head">
        <div className="hp-head-title">
          {project ? <button type="button" className="btn sm" onClick={() => go("/time")} aria-label="All your time"><span className="tp-back"><Ic name="chevron" size={14} /></span>Your time</button> : null}
          <h1>{project ? (proj ? `Time on ${proj.name}` : "Time on project") : "Time spent"}</h1>
        </div>
        <div className="hp-head-acts always"><Select id="tpRange" label="Period" value={days} onChange={pick} options={RANGES} /></div>
      </header>
      {err ? <div className="hp-error" role="alert"><span>{err}</span><button type="button" className="btn sm" onClick={load}>Try again</button></div> : null}
      {!data && !err ? <p className="tp-none">Loading…</p> : null}
      {data ? (
        <>
          <section className="tp-card">
            <div className="tp-total"><b id="tpTotal">{W.duration(data.total)}</b><span>{project ? "by everyone" : "in Junction"}, {RANGES.find((r) => r.value === days)?.label.toLowerCase()}</span></div>
            <Bars days={data.days} />
          </section>
          {proj && project ? (
            <div className="tp-cols">
              <section className="tp-card"><h2>People</h2>
                <Rows rows={proj.people.map((u) => ({ key: String(u.userId), label: <span className="tp-person"><Avatar login={u.login} url={u.avatarUrl} size={20} />{u.name || u.login}</span>, sub: `last ${W.ago(u.lastAt)}`, seconds: u.seconds }))} /></section>
              <section className="tp-card"><h2>Documents</h2>
                <Rows rows={proj.docs.map((d) => ({ key: d.path, label: d.path || "(removed)", seconds: d.seconds }))} /></section>
            </div>
          ) : mine ? (
            <div className="tp-cols">
              <section className="tp-card"><h2>Projects</h2>
                <Rows rows={mine.projects.map((p) => ({ key: p.projectId, label: p.name, sub: `last ${W.ago(p.lastAt)}`, seconds: p.seconds, onClick: () => go(`/time?project=${p.projectId}`) }))} /></section>
              <section className="tp-card"><h2>Apps</h2>
                <Rows rows={mine.clients.map((c) => ({ key: c.client, label: CLIENTS[c.client] || c.client, seconds: c.seconds }))} /></section>
            </div>
          ) : null}
          <p className="tp-foot">Counted like WakaTime: a heartbeat at most every two minutes while you move, draw or edit, and gaps of up to 15 minutes between them count as time spent.</p>
        </>
      ) : null}
      {!project ? <WakaSettings /> : null}
    </>
  );
}
