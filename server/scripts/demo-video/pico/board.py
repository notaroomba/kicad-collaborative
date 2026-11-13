X0, Y0, W, H = 100, 50, 28.54, 56
OX = 1.27  # the header rows are 25.4 mm apart (one breadboard row wider than a Pico), parts sit centred between them
D = 3  # everything from the MCU down sits 3 mm lower than on a Pico, to make room for the buck
FLOOR = {
    "J1": (13, 2.5, 180), "R2": (9.5, 9.2, 0), "R1": (16.5, 9.2, 0), "R4": (12.4, 9.4, 270), "R3": (13.6, 9.4, 270),
    "U2": (19.6, 14.0, 0), "C1": (22.6, 14.6, 90), "L1": (15.3, 15.0, 90), "C2": (14.8, 11.9, 0), "C18": (15.0, 18.1, 0), "R10": (19.0, 11.4, 0), "R11": (21.4, 11.4, 0),
    "U3": (8.2, 15, 0), "C15": (8.2, 11.3, 0), "R5": (6.5, 19.2, 0), "R6": (9.3, 19.2, 0), "SW1": (13.9, 21.6, 0),
    "U1": (13, 31 + D, 0),
    "C3": (7.8, 25.9 + D, 0), "C10": (16.4, 24.9 + D, 90), "C11": (17.6, 24.9 + D, 90), "C14": (18.8, 24.9 + D, 90), "C9": (20.0, 24.9 + D, 90),
    "C4": (7.8, 27.2 + D, 0), "C5": (7.8, 35.4 + D, 0), "C7": (18.2, 27.2 + D, 0), "C8": (18.2, 35.4 + D, 0),
    "C6": (16.4, 37.1 + D, 90), "C13": (17.6, 37.1 + D, 90), "C12": (18.8, 37.1 + D, 90),
    "Y1": (10.5, 40.5 + D, 0), "R7": (11.6, 37.3 + D, 0), "C16": (7.4, 40.0 + D, 90), "C17": (13.6, 41.0 + D, 90),
    "D1": (20.5, 41.5 + D, 0), "R9": (20.5, 39.8 + D, 0), "SW2": (18.5, 45.5 + D, 0), "R8": (14.6, 43.6 + D, 90),
    "J4": (10.46, H - 2.0, 90),
}
board = project.board()
board.clear(outline=False)
print("sync", board.sync())
board.outline(X0, Y0, X0 + W, Y0 + H)
board.rules(clearance=0.15, track_width=0.15, via_diameter=0.5, via_drill=0.3, min_track_width=0.15, min_clearance=0.15, edge_clearance=0.3)
fixed = {r: (X0 + OX + x, Y0 + y, rot) for r, (x, y, rot) in FLOOR.items()}
fixed["J2"] = (X0 + 1.57, Y0 + 1.42, 0)
fixed["J3"] = (X0 + 1.57 + 25.4, Y0 + 1.42 + 48.26, 180)
placed = board.autoplace(fixed=fixed, outline=(X0, Y0, X0 + W, Y0 + H))
print("placed", placed["score"], "clashes", board.clashes())
if len(board.info().get("copper_layers", [])) < 4:
    board.layers(4, planes=["In1.Cu", "In2.Cu"])
board.zone("GND", layer="In1.Cu", connect="solid")
board.zone("+3V3", layer="In2.Cu", connect="solid")
board.zone("GND", layer="B.Cu", connect="solid")
board.zone("GND", layer="F.Cu", connect="solid")
# no track in the gap between a header row and the board edge
board.keepout((X0, Y0, X0 + 0.7, Y0 + H), tracks=True, vias=True, copper=False, name="left edge")
board.keepout((X0 + W - 0.7, Y0, X0 + W, Y0 + H), tracks=True, vias=True, copper=False, name="right edge")
board.via("GND", (X0 + OX + 13, Y0 + 31 + D))
critical = [n for n in board.nets() if any(k in n for k in ("USB_D", "XIN", "XOUT", "QSPI"))] + ["SW", "FB"]
critical = critical + ["+3V3", "+1V1"]
r = board.route(order=critical, widths={"VBUS": 0.4, "SW": 0.4, "+3V3": 0.3}, time_s=200, max_vias=2)
print("routed", {k: r.get(k) for k in ("routed", "connections", "vias", "length_mm", "unrouted", "left", "zones_filled")})
left = board.unrouted()
if left:   # one more try for whatever is still open, still within two vias
    print("retry", board.route(nets=list(left), time_s=60, max_vias=2)["unrouted"])
d = board.check(limit=20)
print("drc", d["errors"], d["warnings"], d["by_kind"], d["first"])
print("board", board.info())

# silkscreen: references beside their parts, header pin names, board name and version
board.rules(min_text_height=0.6)
print("silk", board.silkscreen(rev="V1"))
