# kicad_harness

Drive KiCad schematics and boards with plain Python calls, so that a model (or a person) designs
by writing a short script instead of editing file text or looking at screenshots.

```python
import kicad_harness as kh

project = kh.new("blinky")                       # or kh.open("my_board/") for existing KiCad files
sch = project.schematic()
sch.place("Timer:NE555D", ref="U1", footprint="Package_SO:SOIC-8_3.9x4.9mm_P1.27mm")
sch.net("GND", "U1.GND"); sch.net("+5V", "U1.VCC", "U1.RST")
r1 = sch.attach("U1.DISCH", "Device:R", value="10k", to="+5V")
sch.connect("U1.THRES", "U1.TRIG")
print(sch.check())                               # ERC

board = project.board()
board.sync(); board.outline(100, 100, 125, 120)
board.autoplace(); print(board.route()); print(board.check())
project.save()                                   # writes .kicad_sch / .kicad_pcb / .kicad_pro
```

Nothing here writes KiCad file text. Every call becomes an edit for the design engine, which is the
web editor's own code (the same symbol placement, connectivity, ERC/DRC, placement engine and
autorouter), so the files stay valid and open in KiCad.

## Three ways to run it

| | Where the design is | How |
|---|---|---|
| Local files | a folder of KiCad files | `kh.open(folder)` / `kh.new(folder)`, then `project.save()`. Needs Node 20+ for the engine. |
| Online project, from your computer | a project on a Junction server | `kh.connect("https://site", token, "project name")`. Edits appear live for everyone, with a cursor. |
| Online project, from an AI assistant | the same | The assistant calls the server's `run_python` MCP tool with a script; `project`, `kh` and `parts` are already defined. |

Install for local use, from the repository:

```bash
pip install -e server/harness            # add [pdf] to read datasheet PDFs locally
```

The engine is `server/static/dist/harness-engine.js` (built by `npm run build:harness`); an editable
install finds it there. Otherwise set `KC_HARNESS_ENGINE` to its path, and `KC_NODE` if `node` is
not on the PATH. KiCad's libraries are read from a KiCad installation when there is one
(`KICAD_SYMBOL_DIR`, `KICAD_FOOTPRINT_DIR`), else from KiCad's library repository, cached in
`~/.cache/kicad-harness`.

With a coding agent (Claude Code, Codex, Gemini CLI, Cursor, Copilot and the like), the cheapest
setup is local: ask it to write and run a script with this package in the project folder. For a
project on the server, add the MCP server `https://<site>/mcp` to the agent (the site's `/connect`
page has the line for each one) and it uses `run_python`. No model is assumed anywhere: the package
is plain Python and the server speaks standard MCP.

## The calls

Schematic (`project.schematic()`): `place`, `attach`, `decouple`, `connect`, `net`, `label`, `power`,
`no_connect`, `move`, `rotate`, `remove`, `set`, `text`, `build` (a whole sheet from a netlist), and to
read: `refs`, `parts`, `pins`, `pin`, `nets`, `net_of`, `unconnected`, `check`.

How the sheet reads: `build(groups={"Title": [refs]}, notes={"Title": "why ..."})` draws each group as a
framed section with its title and notes; `section(title, refs, notes)`, `frame(box, title, notes)` and
`note(text, near=ref)` do the same on a sheet that exists. `overlaps()` lists everything that is drawn on top
of something else or off the page (an empty list is a clean sheet), `tidy()` moves any reference or value
that is drawn over something to the nearest clear spot and reports what is left (fields that are clear stay,
so a built sheet keeps its look), `autoplace_fields(refs)` puts fields back beside their parts, `title("Name (V1)", rev="V1")` fills in the title block, `clear()` empties
the sheet for a rebuild (`board.clear()` does the same on the board and keeps the outline), `page("A3")`, `fit_page()` (the smallest paper that holds the drawing, clear of the title block, with the drawing moved to the middle of it; `build` ends with it), `layout()`, `sections()` and `svg(path)` (a picture, on
local files) are the tools around them. `build` draws every block off the page, measures it as drawn and
packs the blocks onto the smallest page they fit on, so its result has `overlaps: 0`.

3D models: a footprint from KiCad's library or from a vendor names its model, and the web 3D view loads it by
itself (KiCad's 3D library first, the vendor's STEP file for a vendor part). `board.models()` says how many
parts show as their real model and lists under `without_model` the ones drawn as a stand-in shape, with the reason.

`build` swaps pins for a clean drawing, as a person does in the symbol editor: on the left and right of an IC (up to
24 pins) supply straps go to the top, then pins whose parts rise to a supply, supply pins, signals, pins whose parts
drop to ground, and ground straps at the bottom and a supply or ground pin drawn on the side of a sensor or logic part moves to the top or bottom edge, so all its supply pins share one rail with their capacitors (a regulator or charger reads left to right: its supply input moves to the left side with the input capacitor, outputs stay on the right) (`pins_swapped` in the result; `swap_pins=False` turns it off). A
supply name KiCad's power library does not have (`VSYS`, `VDD_SPI`) gets a power symbol made for it instead of a
label; `sch.supply("VMOTOR")` declares any name a supply. Pins tied together by a short bus get their rail straight off the end of that bus, an even number of tied signal pins sends its wire or name out from the middle of the tie, and a wire that crosses its own net gets a junction (`sch.crossings()` lists any that are left, and `sch.overlaps()` reports them). A part with one connected pin (an antenna) stands on the
end of the chain that feeds it.

`build` draws each block like a datasheet's application circuit (`kicad_harness/sheet.py`): a wire leaves each
IC pin, capacitors and pull resistors hang from it, series parts sit in line with it, dividers stack under
their node, same-net pins are tied together, decoupling capacitors of one supply stand in a row on shared
rails. Supply symbols point up, ground symbols down, labels are horizontal, and a label appears only where
a net leaves its block. A net wired inside its block has no label (KiCad names it after a pin); pass
`labels=["NAME"]` to keep a name on the sheet.

Board (`project.board()`): `sync`, `outline`, `rules`, `zone`, `autoplace`, `place`, `move`, `rotate`,
`flip`, `group`, `layers`, `route`, `fill`, `fix_thermals`, `pad_connection`, `connect`, `track`, `via`,
and to read: `refs`, `parts`, `pads`, `pad`, `nets`, `unrouted`, `info`, `check`. `layers(4, planes=["In1.Cu"])`
makes a four layer board. `board.fence("GND", [(x, y), ...], spacing=1.5, gaps=[box])` puts a row of ground stitching vias along a path (beside an RF feed, round an antenna keep-out), leaving out positions too close to other pads. `courtyards()` gives each part's size as placed and `clashes()` lists the pairs that sit on top of each other (with by how much), so a floorplan is checked in seconds before `route()`, the slow step. `route()` reports `left` (connections still open by net) instead of failing on a
blocked net, lays tracks where the filled pour leaves a pad open, and joins a pad with a starved thermal
relief solidly. `check(kind="clearance")` lists one kind of violation. Net names are the schematic's:
`"SW"` finds the board's `"/SW"`.

Pins are `"U1.3"` or `"U1.VDD"`. Positions are millimetres and are optional almost everywhere: parts
go to free space, wires are routed between the pins you name. Results are short summaries (references,
counts, what went wrong), never file contents.

## Parts from datasheets

```python
from kicad_harness import parts

part = parts.from_datasheet("W25Q64JV.pdf", package="SOIC-8")   # a PDF, its address, or a part number
print(part.report)        # pages used, where the footprint came from, and what is missing
sch.place(part, ref="U3") # the board gets the footprint on board.sync()
part.save("lib/")         # Generated.kicad_sym and Generated.pretty/ for KiCad
```

The pin table gives the symbol (KiCad library conventions: inputs left, outputs right, supplies top,
grounds bottom). The footprint comes, in this order, from KiCad's own library when it has the
package, from the datasheet's dimension table through the IPC-7351B land pattern formulas, or from
the JEDEC standard dimensions of the package with a warning. What could not be read is listed
under `report["missing"]` and supplied with `part.fix(pins=[...], package=..., pitch=..., body=..., ep=...)`.
`parts.make(name, pins, package)` makes a part without a datasheet. Results are cached per datasheet.

Finding parts: `parts.find("3.3V LDO SOT-23-5")` searches LCSC, and Mouser and DigiKey when their
keys are set (`MOUSER_API_KEY`, `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET`; on an online project the
server's accounts are used). `parts.lookup("TPS54331DR")` gives one part's maker, package and
datasheet address, including Texas Instruments and Analog Devices product pages.

## Examples and tests

`examples/rp2040_devboard.py` builds a complete RP2040 board (37 parts, 51 nets, routed) from one
script. `python -m unittest discover -s tests` runs the package's tests (the engine tests need Node
and KiCad's libraries, and skip themselves otherwise).
