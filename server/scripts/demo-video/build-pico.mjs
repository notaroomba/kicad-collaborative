// Builds the Pico design the video replays: a project made through MCP, the schematic and the
// board drawn by the two scripts in pico/ through run_python (not live), so the finished design
// exists before the recording.  Prints what each script printed.
//
//   node build-pico.mjs            → out/pico.json { project }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PG_URL, mintJwt, mcp } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(here, 'out'); fs.mkdirSync(OUT, { recursive: true });
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false }); await db.connect();
const mkUser = async (ghId, login, name) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name RETURNING id`, [ghId, login, name])).rows[0].id;
const adaId = await mkUser(-7701, 'ada', 'Ada');
await db.query(`DELETE FROM projects WHERE owner_id = $1 AND name = 'rp2040-pico'`, [adaId]);
const ada = mintJwt(adaId, 'ada');
const p = await mcp(ada, 'create_project', { name: 'rp2040-pico' });
const project = p.data.project_id;
async function run(file, title) {
  let r = await mcp(ada, 'run_python', { project, code: fs.readFileSync(path.join(here, 'pico', file), 'utf8'), title, live: false, timeout_s: 400 });
  while (r.data && r.data.running) r = await mcp(ada, 'get_run', { run_id: r.data.run_id });
  console.log(`== ${file}`, r.isError ? 'ERROR' : '', '\n' + (r.data ? r.data.output + '\n' + (r.data.notes || []).join('\n') : r.text));
  if (r.isError || !r.data || !r.data.ok) process.exit(1);
}
await run('design.py', 'RP2040 Pico board schematic');
if (!process.argv.includes('--schematic')) await run('board.py', 'RP2040 Pico board layout');
fs.writeFileSync(path.join(OUT, 'pico.json'), JSON.stringify({ project }));
await db.end();
