# Starter templates

`node server/scripts/templates/gen.mjs` writes `server/templates/`: one folder per template with a KiCad
project, schematic and board, KiCad's own pictures of both, and `index.json`, which the server compiles in
(`src/templates.rs`) and the New project dialog lists.

A template is described in `gen.mjs` as a schematic (parts from KiCad's libraries, wires, power symbols,
labels) and a placement. Everything else comes from KiCad 10 itself, through `kicad-cli` in the official
`kicad/kicad:10.0` image:

1. the netlist of the schematic, which gives the board its nets;
2. the editor's own autorouter routes the board (`web/router`);
3. KiCad fills the pour and saves the board, then saves the schematic;
4. KiCad runs ERC, and DRC with schematic parity, at every severity. A template is written only when all of
   them report nothing;
5. `kicad-cli pcb render` and `sch export svg` make `board.png` and `schematic.png`.

The 555 blinker is not described here: it is the home page's demo (`web/landing/demo`, written by
`scripts/landing-demo`), copied as it stands so that the board a visitor routes in the home page's small
editor fits the project it is handed to. `blinker.guided.kicad_pcb` is that board with four connections taken
out, for the guided first project. A unit test fails when the copy and the demo differ: run the generator again.

## Running it

```sh
(dockerd > /tmp/dockerd.log 2>&1 &)          # if no Docker daemon is running
docker pull kicad/kicad:10.0
npm run build:canvas && npm run build:router  # the generator uses the editor's parser and router
node scripts/templates/gen.mjs                # all templates, and index.json
node scripts/templates/gen.mjs --check        # verify only: ERC and DRC on what the generator writes now
```

`lib/` holds the library parts in use, copied unchanged from KiCad 10.0's libraries (CC-BY-SA 4.0 with the
design exception). A derived symbol is stored flattened, as a schematic keeps it. To use a part that is not
there yet, copy the image's libraries out once and point `KICAD_SHARE` at them:

```sh
docker run --rm -v /tmp/kicad-share:/out kicad/kicad:10.0 cp -r /usr/share/kicad/symbols /usr/share/kicad/footprints /out/
KICAD_SHARE=/tmp/kicad-share node scripts/templates/gen.mjs
```

## Adding a template

Add an entry to `TEMPLATES` in `gen.mjs` (`sch(s)` draws the schematic with the helpers in `kit.mjs`, `place`
positions every footprint, `size` and `holes` give the outline), run the generator until KiCad reports
nothing, then add the folder to `TEMPLATES` in `src/templates.rs`.
