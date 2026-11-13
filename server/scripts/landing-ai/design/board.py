# Board for the ESP32-C3 battery devboard (V1): Raspberry Pi Pico outline (21 x 51 mm), four layers, USB at the top, antenna at the bottom.
X0, Y0, W, H = 100, 50, 21, 51
FLOOR = {
    # USB-C and its protection
    "J1": (10.5, 2.5, 180), "U6": (10.5, 8.9, 0), "R1": (6.4, 8.7, 0), "R2": (14.6, 8.7, 0),
    # battery connector (left), charger with power path (right)
    "J4": (6.1, 13.0, 90),
    "U2": (13.9, 13.7, 0), "R5": (11.3, 10.9, 0), "R3": (13.25, 10.9, 0), "C1": (15.2, 10.9, 0), "C3": (10.9, 13.7, 90),
    "R4": (17.0, 12.0, 90), "C2": (16.83, 14.6, 90), "D1": (16.2, 16.7, 0), "R6": (14.2, 16.7, 0),
    # 3.3 V regulator
    "U3": (14.6, 19.8, 180), "C4": (15.9, 22.1, 0), "C5": (12.9, 22.1, 180),
    # sensors
    "C18": (10.6, 23.3, 0), "C19": (12.5, 23.3, 0), "C20": (14.4, 23.3, 0), "C21": (16.3, 23.3, 0),
    "U4": (12.6, 26.0, 180), "U5": (16.0, 26.0, 180), "R13": (15.9, 28.05, 180), "R14": (15.9, 29.1, 180),
    # boot button
    "R8": (5.4, 19.8, 0), "SW2": (5.4, 23.5, 90),
    # ESP32-C3: pin 1 (antenna) at the bottom left
    "U1": (10.5, 33.5, 90), "C9": (12.7, 29.3, 90), "C10": (11.5, 29.3, 90), "C8": (15.4, 34.25, 0), "R9": (15.6, 31.0, 180),
    "C7": (9.6, 37.6, 270), "C6": (5.3, 38.2, 0), "R10": (12.6, 37.75, 90),
    # crystal
    "Y1": (4.7, 34.0, 90), "C15": (4.5, 31.9, 180), "C14": (4.45, 36.1, 180), "C11": (6.4, 36.1, 180),
    # antenna matching, straight down from LNA_IN, and the chip antenna
    "C16": (8.27, 40.9, 180), "L1": (8.75, 42.5, 270), "C17": (8.27, 44.1, 180), "AE1": (10.2, 48.3, 0),
    # reset, battery sense
    "R7": (14.2, 37.2, 180), "C13": (16.2, 37.2, 0), "R15": (14.2, 38.4, 0), "R16": (16.2, 38.4, 0), "SW1": (14.65, 41.9, 0),
}
board = project.board()
board.clear(outline=False)
print("sync", board.sync().get("added"))
board.outline(X0, Y0, X0 + W, Y0 + H)
board.rules(clearance=0.15, track_width=0.15, via_diameter=0.5, via_drill=0.3, min_track_width=0.15, min_clearance=0.15, edge_clearance=0.3, hole_clearance=0.15)
fixed = {r: (X0 + x, Y0 + y, rot) for r, (x, y, rot) in FLOOR.items()}
fixed["J2"] = (X0 + 1.61, Y0 + 1.37, 0)
fixed["J3"] = (X0 + 1.61 + 17.78, Y0 + 1.37 + 48.26, 180)
placed = board.autoplace(fixed=fixed, outline=(X0, Y0, X0 + W, Y0 + H))
print("placed", placed.get("score"), "clashes", board.clashes())
if len(board.info().get("copper_layers", [])) < 4:
    board.layers(4, planes=["In1.Cu", "In2.Cu"])
board.zone("GND", layer="In1.Cu", connect="solid")
board.zone("+3V3", layer="In2.Cu", connect="solid")
board.zone("GND", layer="B.Cu", connect="solid")
board.zone("GND", layer="F.Cu", connect="solid")
# no track in the gap between a header row and the board edge
board.keepout((X0, Y0, X0 + 0.7, Y0 + H), tracks=True, vias=True, copper=False, name="left edge")
board.keepout((X0 + W - 0.7, Y0, X0 + W, Y0 + H), tracks=True, vias=True, copper=False, name="right edge")
board.stackup(fab="jlcpcb", layers=4)
board.rules(clearance=0.15, track_width=0.15, via_diameter=0.5, via_drill=0.3, min_track_width=0.15, min_clearance=0.15, edge_clearance=0.3, hole_clearance=0.15)
plan = board.plan(edge="bottom")
print("plan notes", plan["notes"])
# the RF path is one straight 50 ohm line on the front, chip pin to matching parts to antenna: drawn, not left to the router
RFW = plan["route"]["widths"].get("RF_LNA", 0.35)
board.track("RF_LNA", ["U1.1", "C16.1", "L1.1"], width=RFW)
board.track(next(n for n in board.nets() if n.endswith("RF_ANT")), ["L1.2", "C17.1", "AE1.1"], width=RFW)
# the pull-up's short hop to its pin, drawn so the fan-out of the pins beside it cannot close it off
board.track("GPIO8", ["U1.14", (X0 + 13.34, Y0 + 32.75), "R9.2"])
# the antenna's clear area on every layer and the ground vias along the edge that faces it
print("antenna", board.antenna())
print("thermal vias", board.thermal_vias())
# a ground via right at the ground pad of the capacitors that sit away from the pours
def ground_at(x, y):
    for dx, dy in ((0.75, 0), (0, 0.75), (0, -0.75), (0.75, 0.75), (0.75, -0.75), (-0.75, 0)):
        p = (X0 + x + dx, Y0 + y + dy)
        if board.fence([p, (p[0] + 0.01, p[1])], spacing=1.0, net="GND")["vias"]:
            board.track("GND", [(X0 + x, Y0 + y), p], width=0.2)
            return (round(dx, 2), round(dy, 2))
print("ground vias", {r: ground_at(*xy) for r, xy in {"C13": (16.68, 37.2), "C8": (15.88, 34.25), "C14": (3.97, 36.1), "U5.7": (16.325, 25.2), "U5.5": (15.025, 25.2), "U5.1": (16.975, 26.8)}.items()})
# the IMU's supply pin takes its own via down to the +3V3 plane, so no +3V3 track loops round its ground pads
board.track("+3V3", ["U4.8", (X0 + 11.45, Y0 + 24.6)])
board.via("+3V3", (X0 + 11.45, Y0 + 24.6))
have = board.nets()
R = plan["route"]
order = [n for n in R["order"] + ["I2C_SDA", "I2C_SCL", "IMU_INT1", "VBUS", "VSYS", "+BATT"] if n in have]
widths = {**R["widths"], "VBUS": 0.4, "VSYS": 0.4, "+BATT": 0.4, "+3V3": 0.3, "VDD_SPI": 0.3}
r = board.route(order=order, widths=widths, kinds=R["kinds"], time_s=120, max_vias=2)
print("routed", {k: r.get(k) for k in ("routed", "connections", "vias", "length_mm", "left")})
left = board.unrouted()
if left:
    print("retry", board.route(nets=list(left), widths=widths, kinds=R["kinds"], time_s=60, max_vias=2).get("left"))
left = [n for n in board.unrouted() if n != "GND"]
if left:
    print("retry 2", board.route(nets=left, widths=widths, time_s=60, max_vias=2, separate=False).get("left"))
# a ground pad the pours and the router left on its own gets a via right beside it
import re
for _ in range(3):
    d = board.check(kind="unconnected_items", limit=10)
    lone = [m.groups() for m in (re.search(r"net 'GND'.*at \(([\d.]+), ([\d.]+)\)", t) for t in d["first"]) if m]
    if not lone:
        break
    print("lone ground pads", [(x, y, ground_at(float(x) - X0, float(y) - Y0)) for x, y in lone])
    board.fill()
print("finish", board.finish())
if hasattr(board, "silkscreen"):
    board.rules(min_text_height=0.6)
    done = board.silkscreen(rev="V1")
    print("silk", done)
d = board.check(limit=20)
print("drc", d["errors"], d["warnings"], d["by_kind"], d["first"])
print("board", board.info())
print("models", board.models())
rv = board.review()
print("review", rv["errors"], rv["warnings"], rv["findings"])
print("final unrouted", [f"{n}: {k} open" for n, k in dict(board.unrouted()).items()])
