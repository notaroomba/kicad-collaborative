// pcm-fixture.mjs — a stand-in for KiCad's plugin repository, for tests and for machines that
// cannot reach repository.kicad.org.  It serves repository.json, packages.json and the package
// zips from two folders:
//
//   PCM_META=<kicad-addons metadata checkout>/packages   one folder per package, each a metadata.json
//   PCM_ZIPS=<folder>                                     <identifier>.zip, the package as PCM downloads it
//   PORT=8096 node pcm-fixture.mjs
//
// Point the server at it with KC_PCM_REPOSITORY=http://127.0.0.1:8096/repository.json.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export function startPcmFixture({ meta = process.env.PCM_META, zips = process.env.PCM_ZIPS, port = Number(process.env.PORT || 8096) } = {}) {
  if (!meta || !zips) throw new Error("set PCM_META and PCM_ZIPS");
  const base = `http://127.0.0.1:${port}`; const packages = [];
  for (const id of fs.readdirSync(meta).sort()) {
    const zip = path.join(zips, id + ".zip"); const file = path.join(meta, id, "metadata.json");
    if (!fs.existsSync(zip) || !fs.existsSync(file)) continue;
    let pkg; try { pkg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (pkg.type !== "plugin" || !Array.isArray(pkg.versions) || !pkg.versions.length) continue;
    const bytes = fs.readFileSync(zip); const last = pkg.versions[pkg.versions.length - 1];
    last.download_url = `${base}/zips/${encodeURIComponent(id)}.zip`; last.download_sha256 = crypto.createHash("sha256").update(bytes).digest("hex"); last.download_size = bytes.length;
    pkg.versions = [last]; packages.push(pkg);
  }
  const list = Buffer.from(JSON.stringify({ packages }));
  const repo = JSON.stringify({ $schema: "https://gitlab.com/kicad/code/kicad/-/raw/master/kicad/pcm/schemas/pcm.v1.schema.json#/definitions/Repository", name: "KiCad official repository (local copy)", packages: { url: `${base}/packages.json`, sha256: crypto.createHash("sha256").update(list).digest("hex"), update_time_utc: "2026-01-01 00:00:00", update_timestamp: 1767225600 } });
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/repository.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(repo); return; }
    if (url === "/packages.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(list); return; }
    const m = /^\/zips\/([A-Za-z0-9._-]+\.zip)$/.exec(url); const f = m ? path.join(zips, m[1]) : null;
    if (f && fs.existsSync(f)) { res.writeHead(200, { "content-type": "application/zip" }); fs.createReadStream(f).pipe(res); return; }
    res.writeHead(404); res.end("not found");
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, url: `${base}/repository.json`, count: packages.length })));
}

if (import.meta.url === `file://${process.argv[1]}`) startPcmFixture().then((f) => console.log(`${f.count} plugin packages at ${f.url}`));
