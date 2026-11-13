# PCB design rules built into the harness

This is the reference behind `board.plan()`, `board.stackup()`, `board.prepare()`, `board.finish()`, `board.review()`
and `kh.calc`. Each rule says what to do, why, and how the harness applies or checks it. Rules marked **checked** are
tested automatically by `board.review()` (`review_design` on the board); rules marked **planned** are applied before
placement or routing by `board.plan()`; rules marked **manual** are printed in the review's manual checklist because
they cannot be read from the copper.

Code: `server/web/ai/review-physics.ts` (checks and plans), `server/harness/kicad_harness/physics.py` (calls and sums),
`server/harness/kicad_harness/stackups.py` (stackups, materials, fabricators). Tests: `server/harness/tests/test_physics.py`,
`test_stackups.py`.

## Sources, and how far to trust them

Read directly while writing this (figures taken from the documents):

- Espressif, ESP32-C3 Hardware Design Guidelines, PCB layout chapter.
- Johanson Technology, chip antenna layout notes (2450AT series).
- Texas Instruments SPRAAR7, High-Speed Interface Layout Guidelines.
- Texas Instruments SLMA002, PowerPAD Thermally Enhanced Package.
- Texas Instruments LMR33630 datasheet, layout section (buck converter).
- Texas Instruments OPA858 datasheet, layout section (high-speed amplifier, transimpedance).
- Analog Devices, photodiode front-end layout notes (guarding).
- IPC-2221 table 6-1 (electrical clearance) and its current formula.
- JLCPCB capability, impedance stackup and flex capability pages; PCBWay capability, stackup and flex pages (read 2026-11).

Standard texts whose well-known results are used but which were not re-read page by page: Johnson and Graham,
*High-Speed Digital Design*; Bogatin, *Signal and Power Integrity Simplified*; Ott, *Electromagnetic Compatibility
Engineering*; Hartley's stackup and return-current papers; JEDEC and vendor memory layout guides (Micron TN-46-14,
TN-41-13, TN-40-40; NXP and TI DDR application notes); ST AN2867 (oscillator design; its layout section was not
obtained). Memory-bus tolerances and the material constants come from these and from makers' datasheets as commonly
quoted. Treat every number as a starting point: the part's own datasheet and the fabricator's own calculator win.

## The order of work

Physics is decided before placement, not found by a review at the end.

1. `board.sync()`, outline.
2. `board.plan()`: from the netlist it works out what sits beside what, what goes on an edge, what must be kept
   apart, the width and kind of every net, the routing order, each interface's impedance and skew, and the stackup.
3. `board.stackup(fab=..., layers=..., material=..., finish=...)`: the physical layers and the fabricator's limits
   become the design rules. Track widths for 50 and 90 ohm follow from this, so it comes before routing.
4. `board.autoplace(near=plan["place"]["near"], edges=plan["place"]["edges"])`.
5. Ground zones on every layer that carries them.
6. `board.prepare()`: antenna keep-outs and their ground vias, before the router can put copper there.
7. `board.route(**plan["route"])`.
8. `board.finish()`: RF fences, thermal vias, the antenna's ground edge, stitching, refill.
9. `board.review()` until clean.

## The circuit, before the board

`sch.review()` checks the support circuits from the netlist (`server/web/ai/review-circuit.ts`,
`harness/tests/test_circuit.py`), because a board laid out perfectly round a wrong circuit is still wrong:

- One small bypass capacitor for each supply pin, not one per chip (`bypass.count`).
- Exactly one pull-up per I2C line, and no smaller than (V - 0.4 V) / 3 mA, which is 967 ohm at 3.3 V; above
  about 10k the edges are too slow for 400 kHz (`i2c.pullups`).
- A crystal has a capacitor each side, both the same, C = 2 x (CL - Cstray) with 2 to 5 pF of stray; the crystal's
  CL comes from a `CL` field (`crystal.load`).
- A USB-C socket has its own resistor on CC1 and on CC2: 5.1k to ground for a device, 56k, 22k or 10k to VBUS for
  a source; joined CC pins or a missing resistor mean no power from a C-to-C cable (`usbc.cc`). USB data lines
  have an ESD part (`usb.esd`).
- A regulator has a capacitor on its input and its output (`regulator.caps`); its feedback divider sets
  Vout = Vref x (1 + Rtop / Rbottom) and that must be the voltage the output net is named for
  (`regulator.setpoint`; the reference voltages of common adjustable regulators are built in, others take a `Vref`
  field); a linear regulator loses P = (Vin - Vout) x I in a package good for about 1 W (SOT-223), 0.5 W
  (SOT-89) or 0.3 W (SOT-23) (`regulator.heat`).
- Every LED has a series resistor; more than 20 mA, or more than about 8 mA from an IC pin, is flagged
  (`led.current`).
- Net names that differ only in case or separators, or by one dropped or swapped letter, and named nets that
  reach a single pin (`nets.typos`). One passive package size where possible (`passives.sizes`).

## Stackup and return paths

- Every signal has a return current, and above a few hundred kilohertz it flows in the plane directly under the
  track. A track is only as good as the unbroken copper beneath it. **checked** (`return.path`: fast and RF tracks
  are walked and each point must have ground on the adjacent layer; a gap in the pour under a fast track is an error.)
- Four layers as soon as there is a radio or a fast bus: signal, ground, power, signal. Layer 2 is solid ground
  (Espressif). Six layers: signal, ground, signal, power, ground, signal, so inner signals run between planes.
  **planned** (`plan["stackup"]`), **checked** (`stackup.reference`).
- Do not split the ground plane. Separate by placement; never route across a gap.
- A fast signal that changes layer needs a ground via beside it so the return current can change planes too: within
  200 mil (5 mm) per TI, closer is better. **checked** (`return.vias`).
- Stitch ground pours together about every centimetre, and no further apart than a twentieth of a wavelength of the
  highest frequency on the board. **checked** (`ground.stitching` in the layout checklist; `antenna.fence` for RF).
- Keep fast tracks away from the plane edge (TI: pairs at least 90 mil from the edge of the reference plane).

## Impedance

`kh.calc.microstrip(width, height, er)`, `stripline`, `width_for(ohms, height, er)`, `pair(...)`; the router sizes RF nets from the
board's stackup. On JLCPCB's default four-layer build (0.21 mm of 7628 prepreg) 50 ohm is about 0.35 mm; on the
3313 build (0.1 mm) about 0.17 mm. On a two-layer 1.6 mm board a 50 ohm microstrip is about 3 mm wide: use four
layers or a coplanar feed. **checked** (`rf.feed` compares each RF track's width with the stackup's 50 ohm width).

## Radio and RF (Bluetooth, WiFi, LoRa, GPS, sub-GHz, anything with an antenna)

- The antenna sits at a board edge, ideally a corner, pointing away from the board. **planned**, **checked**
  (`antenna.keepout`).
- Chip and trace antennas: no copper on any layer under or beside the antenna, sized to its datasheet (Johanson:
  ground more than 2 mm from the short edges and 4 mm from the long edge). `board.antenna(ref)` adds the keep-out.
  **checked**.
- Patch antennas (GPS, GNSS) are the opposite: unbroken ground under and around them. **checked**.
- The ground edge facing the antenna, and the pours beside the feed, are stitched with vias no further apart than
  a twentieth of a wavelength in the board: about 2.9 mm at 2.45 GHz, 1.2 mm at 5.8 GHz, 4.5 mm at 1.575 GHz
  (GPS), 7.8 mm at 915 MHz (LoRa); the harness never goes wider than 8 mm. The harness reads the band from part values and net
  names. `board.antenna()`, `board.fence_net(net)`. **checked** (`antenna.fence`).
- The feed is 50 ohm, on the outer layer, over solid ground, with no vias, no stubs and no right angles (135 degree
  bends or arcs), and as short as placement allows (Espressif). **checked** (`rf.feed`).
- The matching network (pi or CLC) sits at the antenna end in a straight line, with its shunt parts grounded
  directly. **planned**.
- Keep switching converters, their inductors and crystals away from the antenna. **planned** (`apart`), **checked**.
- Nothing metal within about 15 mm of the antenna in the finished product; tune the match on the real board.
  **manual**.
- Above about 3 GHz, or for long 50 ohm runs, filters and couplers, use a low-loss laminate (RO4350B); above
  20 GHz PTFE. **planned** (`kh.materials.choose`), **checked** (`stackup.material`).
- LNA and PA stages: input and output on opposite sides, ground vias at every ground pad, supply decoupled per
  stage with the smallest capacitor nearest the pin, DC feed through a choke.

## High-speed digital and interfaces

`kh.calc.interface(name)` returns each row with its notes. Differential impedance in ohm, skew within the pair,
and the rule the review applies:

| Interface | Impedance | Pair skew | Notes |
|---|---|---|---|
| USB 2.0 | 90 | 1.27 mm (50 mil) | short, one layer, at most 4 vias, ESD at the connector |
| USB 3, HDMI, DisplayPort, PCIe, SATA | 85 to 100 | 0.13 mm (5 mil) | AC capacitors at the transmitter, no stubs, ground via at each layer change |
| Ethernet (MDI) | 100 | 1.27 mm | magnetics close to the PHY, no plane under the magnetics' line side |
| MIPI CSI/DSI, LVDS | 100 | 0.13 mm | lanes matched to the clock |
| CAN, RS-485 | 120 | loose | termination at the ends of the cable, TVS at the connector |
| SD, eMMC, QSPI | 50 single-ended | data matched to clock | series resistors at the driver |
| SDRAM, DDR1 to DDR5, LPDDR4 | 40 to 60 single-ended, 80 to 100 strobes and clocks | per byte lane | below |
| I2C, SPI, I2S, JTAG | not controlled | none | pull-ups once per bus, clock away from analog |

- A pair's two tracks have the same length, the same layer, the same vias and a constant gap; skew is made up
  near the end where it arises. **checked** (`pairs`).
- A track is a transmission line once it is longer than about a sixth of the rise time's length
  (`kh.calc.critical_length(rise_s)`); then it needs a reference plane and, usually, termination.
- No test points, stubs or tees on fast lines (TI). ESD parts directly at the connector, in line. **checked**
  (`esd.near`).

### Memory: SDRAM to DDR5

- Group signals by byte lane: eight data, the mask and the strobe pair of a lane route together, on the same layer,
  with the same via count. Match every line of a lane to its strobe (the harness uses 0.65 mm for DDR2, 0.5 mm for DDR3, 0.25 mm for DDR4,
  0.13 mm for DDR5, and 0.13 to 0.25 mm inside a strobe or clock pair), strobes to clock loosely (fly-by
  levelling takes up the rest from DDR3 on), and address, command and control to the clock.
- Topology: SDRAM, DDR1 and DDR2 use a balanced tree for address and clock; DDR3, DDR4 and DDR5 use fly-by
  (a daisy chain through the chips in order, terminated to VTT at the far end).
- Reference: data lanes over ground; address lines over ground or a solid VDD plane. No track crosses a plane
  split. VREF is a wide, quiet track with its own decoupling; VTT gets a small plane and bulk capacitance.
- Spacing: three track widths between unrelated signals, more to clocks and strobes. Decoupling under the chip.
- DDR5 adds 1.1 V rails from an on-module PMIC, tighter matching and back-drilled or blind vias on long channels.
- **checked** (`bus.match`: every line of a lane or bus is compared with its strobe or clock, with the tolerance
  of the interface the net names indicate).

## Power

- Track width for current: IPC-2221, `kh.calc.track_width(amps, rise=10, oz=1, internal=False)`. On 1 oz outer copper for a
  10 K rise: 0.3 mm for 1 A, 0.53 mm for 1.5 A, 0.78 mm for 2 A, 1.37 mm for 3 A. A 0.3 mm via carries about 1 A; use
  `kh.calc.vias_for(amps)`. Espressif's own figures: 25 mil for the main supply, 20 mil for the 3.3 V rail, 10 mil
  for small branches. **planned** (`route.widths`), **checked** (`power.width` in the layout checklist; `power.path` for nets through an
  inductor or from a battery).
- Switching converters: the hot loop (input capacitor, switch, ground) is as small as the parts allow, the input
  capacitor directly across VIN and GND of the chip; the switch node is short and compact, not a pour; the
  inductor is next to the switch pin with nothing sensitive beside or under it; the feedback divider sits at the
  FB pin and its sense track leaves from the output capacitor, away from the inductor (TI LMR33630). **planned**,
  **checked** (`switcher.loop`, `switcher.node`).
- Linear regulators and power parts: copper area and thermal vias for the dissipation
  (`kh.calc.thermal_rise(watts, theta_ja)`).

## Decoupling and power integrity

- One small capacitor per supply pin, closer to the pin than anything else, with its ground end on a via straight
  into the plane; the loop from pin through capacitor to ground is what matters, not the value. **planned**,
  **checked** (`bypass.near` in the layout checklist, `bypass.return`).
- Bulk capacitance where the supply enters and at each regulator output. A capacitor is only a capacitor below
  its self-resonance (`kh.calc.decoupling_resonance(farads, nh)`); smaller packages have less inductance.
- A power plane next to a ground plane is the best high-frequency decoupling there is.

## EMC

- Small loops radiate less: keep every fast signal against its return, every switching loop tight.
- Clocks and switch nodes stay away from connectors and board edges; filter and protect every line that leaves
  the board, at the connector. **checked** (`esd.near`).
- Crystals: against the oscillator pins (Espressif: about 2 mm from the pin at least, to keep the chip's noise off
  it, and no further than needed), load capacitors beside it, ground underneath, no tracks through or under it,
  no vias on its tracks, a ring of ground vias around it. **planned**, **checked** (`crystal`).
- Connector shells to chassis ground; the cable shield never to signal ground through a track.

## Analog and amplifiers

- Analog, digital, switching and radio each get their own area over one unbroken ground. **planned**, **checked**
  (`analog.separation`: analog tracks beside switch nodes).
- Op-amp inputs are the sensitive nodes: feedback and gain parts sit at the pins, the inverting node is as small
  as possible, and for fast amplifiers the planes are cut away under the input pins to remove their capacitance
  (TI OPA858). Outputs driving capacitance get a series resistor at the pin. **checked** (`amplifier.input`).
- References and ADC inputs: route with their return beside them, away from clocks; filter at the pin.
- Star the returns of high-current stages to the supply so their current does not flow under the input stage.
- Audio: keep inputs away from class-D outputs and the supply inductor; ground the input connector at one point.

## Optoelectronics and high-impedance nodes

- A photodiode feeding a transimpedance amplifier is a picoamp node: the diode on the same side as the amplifier,
  millimetres from the input, on one layer, with a guard ring driven to the same potential around it and nothing
  routed beside or under it (ADI, TI). Clean the board: flux residue leaks. **checked** (`analog.highz`).
- Optocouplers and digital isolators: nothing crosses the gap under the part on any layer, pours included.
  **checked** (`isolation`).
- LEDs and laser drivers: the pulse current loop (capacitor, switch, emitter) is as small as a converter's hot
  loop; power LEDs go on a metal-core board or a field of thermal vias. Image sensors and their MIPI lanes follow
  the interface table; keep their analog supply quiet.

## High voltage

- Clearance for the voltage between conductors follows IPC-2221 table 6-1 (`kh.calc.spacing(volts, "B2")`):
  for example 0.64 mm at 150 V on uncoated outer layers at sea level, 1.25 mm at 300 V, 2.5 mm at 500 V. Mains
  needs the safety standard's creepage as well (often 6 mm and more reinforced), and slots where the surface
  path is too short. **checked** (`creepage`: net voltages are read from net names).

## Heat

- An exposed pad is the package's heat path: an array of vias inside it to the ground planes, about 1.2 mm apart,
  drill 0.3 mm or less so solder does not wick, no thermal relief (TI SLMA002). `board.thermal_vias(ref)`.
  **checked** (`thermal.pad`).
- Heat spreads in copper, not in FR-4: give hot parts solid copper on every layer under them, tied with vias.
- Real heat (LEDs, power stages of several watts) wants aluminium or copper core. **planned**
  (`kh.materials.choose(watts=..., led=True)`), **checked** (`stackup.material`: nothing on the back, no plated
  holes).

## Stackups, materials and finishes

`board.stackup()` writes KiCad's physical stackup (Board Setup, Physical Stackup), the board thickness and the
copper finish, and with `fab=` the fabricator's limits as design rules.

Named builds (the fabricators' own figures, mm):

| Build | Stack |
|---|---|
| JLC04161H-7628 | 0.035 Cu, 0.2104 prepreg 7628 (er 4.4), 0.0152 Cu, 1.065 core, 0.0152 Cu, 0.2104 prepreg, 0.035 Cu |
| JLC04161H-3313 | as above with 0.0994 prepreg 3313 (er 4.1) and a 1.265 core |
| JLC04161H-1080 | as above with 0.0764 prepreg 1080 (er 3.91) and a 1.265 core |
| JLC06161H-3313 | 0.035, 3313 0.0994, 0.0152, core 0.55, 0.0152, 2116 0.1088, 0.0152, core 0.55, 0.0152, 3313 0.0994, 0.035 |
| JLC06161H-7628 | 0.035, 7628 0.2104, 0.0152, core 0.4, 0.0152, 7628 0.2028, 0.0152, core 0.4, 0.0152, 7628 0.2104, 0.035 |
| PCBWAY-4L-1.6 | 0.035, 7628 0.1855 (er 4.74), 0.035, core 1.03 (er 4.6), 0.035, 7628 0.1855, 0.035 |

Any other layer count or thickness is worked out from the thickness and returned with `derived: True`; use the
fabricator's impedance calculator before ordering controlled impedance on those. PCBWay's page gave no six-layer
stack.

Fabricator limits (`kh.FABS`), mm:

| | JLCPCB rigid | PCBWay rigid | JLCPCB flex |
|---|---|---|---|
| Track and space, 1 oz | 0.10 two-layer, 0.09 multilayer | 0.10 minimum, 0.127 without surcharge | 0.09 (18 um copper), 0.10 (35 um) |
| Via hole / pad | 0.15 / 0.25 minimum, 0.3 / 0.6 standard | 0.2 (0.15 extra) | 0.3 / 0.55 |
| Annular ring | 0.15 | 0.15 | 0.18 |
| Copper to edge | 0.2 (0.4 to a V-cut) | 0.25 | 0.3 |
| Mask bridge | 0.10 | 0.10 | coverlay bridge 0.5 |
| Silkscreen | 0.15 line, 1.0 high | 0.15 line, 0.8 high | 0.15 line, 1.0 high |
| Finishes | HASL, lead-free HASL, ENIG, OSP | those plus hard gold, silver, tin, ENEPIG | ENIG only |

Materials (`kh.MATERIALS`, `kh.materials.choose(...)`):

| Material | er | Loss tangent | Use it for |
|---|---|---|---|
| FR-4 (and TG170) | 4.5 | 0.02 | almost everything; high-Tg for many layers, lead-free, heat |
| Polyimide (flex) | 3.3 | 0.008 | anything that bends |
| Aluminium core | | | LEDs and power that must lose heat; one-sided |
| Copper core | | | the hottest parts; one-sided |
| Rogers RO4350B / RO4003C | 3.66 / 3.55 | 0.0037 / 0.0027 | RF from about 3 GHz, long 50 ohm runs, filters |
| Rogers RO3003, PTFE | 3.0 / 2.2 | 0.001 / 0.0009 | radar and millimetre-wave |

HDI (laser microvias, via in pad, blind and buried vias) is a build, not a material: it is needed when a BGA is
0.5 mm pitch or finer. Both fabricators quote it; the harness does not yet place blind or buried vias.

Finishes: ENIG for BGAs, QFNs, 0.5 mm pitch and finer, flex, and pressed contacts; HASL (leaded or lead-free) when
cost matters and nothing is fine-pitch; OSP for cheap fine pitch assembled soon; immersion silver for microwave;
hard gold with a bevel on edge-connector fingers; ENEPIG for wire bonding. JLCPCB does not offer HASL on six layers
and up, on 0.4 mm boards or on RF laminate; aluminium there is HASL only. The harness refuses a finish the chosen
fabricator does not offer on that kind of board.

## Flex

- Stack: `board.stackup(fab="jlcpcb", material="flex", layers=2)` gives 25 um polyimide, 18 um copper each side
  and a 27.5 um coverlay each side (12.5 um polyimide on 15 um adhesive), 0.11 mm finished, ENIG. A thickness of
  0.19 asks for the 50 um polyimide build. Four-layer flex is derived.
- Bend radius: at least 6 times the thickness for one layer, 10 times for two or more, bent once; 10 to 15 times,
  one or two layers and adhesiveless polyimide when it flexes in use (JLCPCB; PCBWay quotes 3 to 6, 7 to 10 and
  10 to 15 by layer count). `kh.calc.bend_radius(...)`.
- Mark every bend with `board.bend_area(box)`. In a bend: no vias, no pads, no parts; tracks cross straight, at
  right angles to the fold, and turn their corners outside it; tracks on the two sides are staggered, never one
  over the other; no solid pour (hatch it); the fewest layers. **checked** (`flex.bend`, `flex.copper`).
- Everywhere on flex: copper at least 0.3 mm from the outline; rounded track corners and teardrops at every pad
  and via; pads a little larger than on a rigid board and held down by the coverlay; inside corners of the outline
  rounded, with a relief hole or a copper tear stop.
- Parts and connector contacts need a stiffener behind them: FR-4 under parts, polyimide behind ZIF fingers
  (a 0.3 mm connector takes the 0.11 mm board plus a 0.225 mm polyimide stiffener), steel where it must be thin
  and stiff. Say which stiffeners the order needs. **manual**.
- Impedance on prototype flex is not controlled at JLCPCB; PCBWay controls it and also builds rigid-flex.

## Manufacture

- Design to the fabricator's standard limits, not their minimum: `board.stackup(fab=...)` writes them into the
  rules and the DRC holds the board to them.
- No open via in a small part's pad (tombstoning) unless the order is for filled and capped vias. **checked**
  (`dfm.via_in_pad`).
- Fiducials, test points, readable silkscreen, one passive size where possible, parts in stock: the layout
  checklist in the guide covers these.

## What is not automatic yet

- Blind, buried and micro vias (HDI) and back-drilling.
- Rigid-flex stackups with different layer counts per region.
- Creepage along slots and around the board edge; the check is straight-line clearance.
- Simulation: no field solver, no eye diagrams, no PDN impedance plot. The sums are closed-form estimates.
- The checks have run on test boards built for them, not yet on the ESP32-C3 board that started this work.
