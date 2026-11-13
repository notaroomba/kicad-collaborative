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
    "C7": (10.0, 37.6, 90), "C6": (5.3, 38.2, 0), "R10": (12.6, 37.75, 90),
    # crystal
    "Y1": (5.55, 34.0, 90), "C15": (4.5, 31.9, 180), "C14": (4.45, 36.1, 180), "C11": (6.4, 36.1, 180),
    # antenna matching, straight down from LNA_IN, and the chip antenna
    "C16": (8.27, 37.2, 180), "L1": (8.75, 38.8, 270), "C17": (8.27, 40.4, 180), "AE1": (10.2, 46.0, 0),
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
# antenna: no copper on any layer around it; only the feed may enter, through the corridor above pad 1
KY = 43.5
board.keepout((X0 + 3.0, Y0 + KY, X0 + 7.9, Y0 + H), name="antenna keepout left")
board.keepout((X0 + 9.6, Y0 + KY, X0 + 18.0, Y0 + H), name="antenna keepout right")
board.keepout((X0 + 7.9, Y0 + KY, X0 + 9.6, Y0 + H), tracks=False, vias=True, copper=True, name="antenna feed")
for dx, dy in ((-1, -1), (1, -1), (-1, 1), (1, 1), (0, 0)):
    board.via("GND", (X0 + 10.5 + dx, Y0 + 33.5 + dy))
board.via("GND", (X0 + 13.9, Y0 + 13.7))
# ground via fence down both sides of the antenna matching network, up to the edge of the antenna keepout
for fy in (38.4, 39.9, 41.4, 42.9):
    board.via("GND", (X0 + 7.0, Y0 + fy))
for fy in (39.4, 40.9, 42.4):
    board.via("GND", (X0 + 10.0, Y0 + fy))
have = board.nets()
critical = [n for n in ["USB_D+", "USB_D-", "XTAL_P", "XTAL_N", "RF_LNA", "Net-(AE1-FEED)", "I2C_SDA", "I2C_SCL", "IMU_INT1", "VBUS", "VSYS", "+BATT"] if n in have or "/" + n in have]
r = board.route(order=critical, widths={"VBUS": 0.4, "VSYS": 0.4, "+BATT": 0.4, "+3V3": 0.3}, time_s=120, max_vias=2)
print("routed", {k: r.get(k) for k in ("routed", "connections", "vias", "length_mm", "unrouted", "left", "zones_filled", "ground_vias", "domains")})
left = board.unrouted()
if left:
    print("retry", board.route(nets=list(left), time_s=60, max_vias=2).get("left"))
d = board.check(limit=20)
print("drc", d["errors"], d["warnings"], d["by_kind"], d["first"])
print("board", board.info())
print("models", board.models())
