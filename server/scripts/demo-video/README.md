# The demo video

The video in the repository README is built here from the real application: Ada and Ben draw a
Raspberry Pi Pico board in one schematic from two browsers, ask an AI for the crystal circuit
they are stuck on, route the board together and look at it in 3D.

- `pico/design.py` and `pico/board.py` are the harness scripts that design the board.
  `build-pico.mjs` makes the project and runs them through the `run_python` MCP tool.
- `prepare.mjs` takes every schematic item and every track, via and zone out of the project and
  keeps them in `out/pico-items.json` (with the change each one goes back in with).
- `record-pico.mjs` puts the design back on camera, scene by scene (`schematic`, `ai`, `route`,
  `finish`): each item through the editor of the person it is given to, with that person's
  mouse moving to it, while both windows are photographed. The `ai` scene is a real live
  `run_python` call through an access key named "Claude"; the crystal's items are written into
  its script. Photographs go to `out/<scene>/<who>/*.jpg` with `frames.json`, and what each scene
  returned to `out/state.json`.
- `compose.html` is the video as a page, a function of time: it frames the photographs and
  adds captions, the chat panel and title cards. Nothing in it draws a schematic or a board.
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
node build-pico.mjs             # the project, designed by the harness scripts
node prepare.mjs                # take it apart
node record-pico.mjs            # all scenes, about an hour here; or name scenes to redo some
node render.mjs --stills        # a look at each scene first, then:
node render.mjs                 # out/junction-demo.mp4 and out/junction-demo-poster.jpg
cp out/junction-demo.mp4 out/junction-demo-poster.jpg ../../../docs/media/
```

Then put the new mp4 in the README on github.com (drag it into the editor where the poster
line is), because GitHub plays inline only videos it hosts itself.

`build-pico.mjs` deletes the earlier `rp2040-pico` project of its test user (`ada`) in the
database it is pointed at. Use a throwaway database. Wait five minutes after it (or restart
the server) before recording, so its headless editor has left the document.

## What is and is not real time

- A mouse movement is photographed once per step and each step counts as 1/30 s. A headless
  browser on a build machine paints slower than a desktop, and the video is not about that.
- The drawing and routing are shown at about the speed a step takes; the AI's call is recorded
  in real time. Where the video is faster than recorded, it says so in the corner.
- The 3D scene skips most of the wait while part models load.
- The pointer is drawn by the page (`POINTER` in `lib.mjs`): a headless browser has none.
