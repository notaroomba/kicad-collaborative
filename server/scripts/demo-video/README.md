# The demo video

The video in the repository README is built here from the real application.

- `record.mjs` starts real browsers against a local server, clicks and drags through the real
  interface, calls the real MCP endpoint, and keeps photographs of what the browser painted
  (`out/<scene>/*.jpg` with `frames.json`, and `out/state.json` with what each run returned).
- `design/design.py` and `design/board.py` are the two scripts an AI wrote for the ESP32-C3
  battery devboard. `record.mjs` sends them through the `run_python` MCP tool, as the AI did.
- `compose.html` is the video as a page, a function of time: it frames the photographs and
  adds captions and title cards. Nothing in it draws a schematic or a board.
- `render.mjs` builds the timeline, steps the page through every frame in a browser and
  encodes with ffmpeg. Caption numbers are read from `out/state.json`.

## Making it again

Needs Postgres, Node 22 with Playwright, ffmpeg, and network access to KiCad's library host
(for symbols, footprints and 3D models).

```sh
cd server && npm ci && npm run build && cargo build
PORT=8096 node scripts/kicad-libs-mirror.mjs &
DATABASE_URL=postgres://postgres:test@127.0.0.1:5432/collabtest JWT_SECRET=testsecret \
  PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 KICAD_LIBS_URL=http://127.0.0.1:8096 \
  ./target/debug/kicad-collab-server &

cd scripts && npm install --no-save --no-package-lock pg && cd demo-video
node record.mjs                 # all scenes, about ten minutes; or name scenes to redo some
node render.mjs --preview       # out/junction-demo.mp4 and out/junction-demo-preview.gif
cp out/junction-demo.mp4 out/junction-demo-preview.gif ../../../docs/media/
```

`record.mjs` deletes the projects of its two test users (`ada`, `ben`) in the database it is
pointed at. Use a throwaway database.

## What is and is not real time

- A mouse gesture is photographed once per step and each step counts as 1/30 s. A headless
  browser on a build machine paints slower than a desktop, and the video is not about that.
- Long runs (the two AI calls, the autorouter) are recorded in real time and shown faster; the
  video shows the factor in the corner.
- The 3D scene skips most of the wait while part models load (about 14 s here).
- The pointer is drawn by the page (`POINTER` in `lib.mjs`): a headless browser has none.
