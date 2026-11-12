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
| Online project, from your computer | a project on a KiCad Collaborative server | `kh.connect("https://site", token, "project name")`. Edits appear live for everyone, with a cursor. |
| Online project, from Claude | the same | Claude calls the server's `run_python` MCP tool with a script; `project`, `kh` and `parts` are already defined. |

Install for local use, from the repository:

```bash
pip install -e server/harness            # add [pdf] to read datasheet PDFs locally
```

The engine is `server/static/dist/harness-engine.js` (built by `npm run build:harness`); an editable
install finds it there. Otherwise set `KC_HARNESS_ENGINE` to its path, and `KC_NODE` if `node` is
not on the PATH. KiCad's libraries are read from a KiCad installation when there is one
(`KICAD_SYMBOL_DIR`, `KICAD_FOOTPRINT_DIR`), else from KiCad's library repository, cached in
`~/.cache/kicad-harness`.

With Claude Code, the cheapest setup is local: ask it to write and run a script with this package in
the project folder. For a project on the server, add the MCP server (`claude mcp add --transport
http kicad https://<site>/mcp`) and it uses `run_python`.

## The calls

Schematic (`project.schematic()`): `place`, `attach`, `decouple`, `connect`, `net`, `label`, `power`,
`no_connect`, `move`, `rotate`, `remove`, `set`, `text`, `build` (a whole sheet from a netlist), and to
read: `refs`, `parts`, `pins`, `pin`, `nets`, `net_of`, `unconnected`, `check`.

Board (`project.board()`): `sync`, `outline`, `rules`, `zone`, `autoplace`, `place`, `move`, `rotate`,
`flip`, `group`, `route`, `connect`, `track`, `via`, and to read: `refs`, `parts`, `pads`, `pad`,
`nets`, `unrouted`, `info`, `check`.

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
