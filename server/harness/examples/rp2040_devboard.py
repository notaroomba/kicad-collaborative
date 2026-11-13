"""An RP2040 dev board (V1) from nothing: USB-C, 3.3 V regulator, QSPI flash, crystal, buttons, LED, Pico-style headers.

The whole design is this one script: a netlist for the schematic, a floorplan and one routing call for the board.
Run it on files (python rp2040_devboard.py out_folder) or paste the part below the imports into run_python.
"""
import sys
import kicad_harness as kh

project = kh.new(sys.argv[1] if len(sys.argv) > 1 else "rp2040-devboard", "rp2040-devboard")

# ---- schematic: parts, then nets by pin number
R0402, C0402, C0603 = "Resistor_SMD:R_0402_1005Metric", "Capacitor_SMD:C_0402_1005Metric", "Capacitor_SMD:C_0603_1608Metric"
parts = {
    "D1": {"lib": "Device:LED", "value": "LED", "footprint": "LED_SMD:LED_0603_1608Metric"},
    "J1": {"lib": "Connector:USB_C_Receptacle_USB2.0_16P", "value": "USB-C", "footprint": "Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12"},
    "J2": {"lib": "Connector_Generic:Conn_01x20", "value": "Conn_01x20", "footprint": "Connector_PinHeader_2.54mm:PinHeader_1x20_P2.54mm_Vertical"},
    "J3": {"lib": "Connector_Generic:Conn_01x20", "value": "Conn_01x20", "footprint": "Connector_PinHeader_2.54mm:PinHeader_1x20_P2.54mm_Vertical"},
    "J4": {"lib": "Connector_Generic:Conn_01x03", "value": "SWD", "footprint": "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical"},
    "SW1": {"lib": "Switch:SW_Push", "value": "BOOTSEL", "footprint": "Button_Switch_SMD:SW_Push_SPST_NO_Alps_SKRK"},
    "SW2": {"lib": "Switch:SW_Push", "value": "RESET", "footprint": "Button_Switch_SMD:SW_Push_SPST_NO_Alps_SKRK"},
    "U1": {"lib": "MCU_RaspberryPi:RP2040", "value": "RP2040", "footprint": "Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm"},
    "U2": {"lib": "Regulator_Linear:AP2112K-3.3", "value": "AP2112K-3.3", "footprint": "Package_TO_SOT_SMD:SOT-23-5"},
    "U3": {"lib": "Memory_Flash:W25Q16JVSS", "value": "W25Q16JVSS", "footprint": "Package_SO:SOIC-8_5.3x5.3mm_P1.27mm"},
    "Y1": {"lib": "Device:Crystal_GND24", "value": "12MHz", "footprint": "Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm"},
}
for value, refs in {"1uF": "C1 C2 C11 C14", "100nF": "C3 C4 C5 C6 C7 C8 C9 C10 C12 C13 C15", "15pF": "C16 C17"}.items():
    for ref in refs.split():
        parts[ref] = {"lib": "Device:C", "value": value, "footprint": C0402}
for value, refs in {"5.1k": "R1 R2", "27": "R3 R4", "10k": "R5 R8", "1k": "R6 R7 R9"}.items():
    for ref in refs.split():
        parts[ref] = {"lib": "Device:R", "value": value, "footprint": R0402}
nets = {
    "+1V1": "C12.1 C13.1 C14.1 U1.23 U1.45 U1.50",
    "+3V3": "C2.1 C3.1 C4.1 C5.1 C6.1 C7.1 C8.1 C9.1 C10.1 C11.1 C15.1 J3.15 J3.16 R5.1 R8.1 U1.1 U1.10 U1.22 U1.33 U1.42 U1.43 U1.44 U1.48 U1.49 U2.5 U3.8",
    "GND": "C1.2 C2.2 C3.2 C4.2 C5.2 C6.2 C7.2 C8.2 C9.2 C10.2 C11.2 C12.2 C13.2 C14.2 C15.2 C16.2 C17.2 D1.1 J1.A1 J1.A12 J1.B1 J1.B12 J1.SH J2.3 J2.8 J2.13 J2.18 J3.3 J3.8 J3.13 J3.18 J4.2 R1.2 R2.2 SW1.2 SW2.2 U1.19 U1.57 U2.2 U3.4 Y1.2 Y1.4",
    "GPIO0": "J2.1 U1.2",
    "GPIO1": "J2.2 U1.3",
    "GPIO10": "J2.14 U1.13",
    "GPIO11": "J2.15 U1.14",
    "GPIO12": "J2.16 U1.15",
    "GPIO13": "J2.17 U1.16",
    "GPIO14": "J2.19 U1.17",
    "GPIO15": "J2.20 U1.18",
    "GPIO16": "J3.1 U1.27",
    "GPIO17": "J3.2 U1.28",
    "GPIO18": "J3.4 U1.29",
    "GPIO19": "J3.5 U1.30",
    "GPIO2": "J2.4 U1.4",
    "GPIO20": "J3.6 U1.31",
    "GPIO21": "J3.7 U1.32",
    "GPIO22": "J3.9 U1.34",
    "GPIO25": "R9.1 U1.37",
    "GPIO26_ADC0": "J3.11 U1.38",
    "GPIO27_ADC1": "J3.12 U1.39",
    "GPIO28_ADC2": "J3.14 U1.40",
    "GPIO3": "J2.5 U1.5",
    "GPIO4": "J2.6 U1.6",
    "GPIO5": "J2.7 U1.7",
    "GPIO6": "J2.9 U1.8",
    "GPIO7": "J2.10 U1.9",
    "GPIO8": "J2.11 U1.11",
    "GPIO9": "J2.12 U1.12",
    "QSPI_SCLK": "U1.52 U3.6",
    "QSPI_SD0": "U1.53 U3.5",
    "QSPI_SD1": "U1.55 U3.2",
    "QSPI_SD2": "U1.54 U3.3",
    "QSPI_SD3": "U1.51 U3.7",
    "QSPI_SS": "R5.2 R6.1 U1.56 U3.1",
    "RUN": "J3.10 R8.2 SW2.1 U1.26",
    "SWCLK": "J4.1 U1.24",
    "SWDIO": "J4.3 U1.25",
    "USB_CONN_D-": "J1.A7 J1.B7 R3.1",
    "USB_CONN_D+": "J1.A6 J1.B6 R4.1",
    "VBUS": "C1.1 J1.A4 J1.A9 J1.B4 J1.B9 J3.19 J3.20 U2.1 U2.3",
    "XIN": "C16.1 U1.20 Y1.1",
    "XOUT": "R7.2 U1.21",
    "XTAL_OUT": "C17.1 R7.1 Y1.3",
    "LED_A": "D1.2 R9.2",
    "CC1": "J1.A5 R1.1",
    "CC2": "J1.B5 R2.1",
    "BOOTSEL": "R6.2 SW1.1",
    "USB_DM": "R3.2 U1.46",
    "USB_DP": "R4.2 U1.47",
}
# One titled frame per functional block, and a note wherever a choice is not the textbook one.
groups = {"USB-C connector": "J1 R1 R2 R3 R4", "3.3 V regulator": "U2 C1 C2", "RP2040 and decoupling": "U1 C3 C4 C5 C6 C7 C8 C9 C10 C11 C12 C13 C14",
          "QSPI flash and BOOTSEL": "U3 C15 R5 R6 SW1", "12 MHz crystal": "Y1 R7 C16 C17", "Reset and LED": "SW2 R8 D1 R9", "Headers and SWD": "J2 J3 J4"}
notes = {
    "USB-C connector": ["R3 and R4 are 27 ohm, not 22: the RP2040 datasheet asks for 27 ohm in series with D+ and D- to match the USB impedance.",
                        "The shield is tied straight to ground; there is no RC filter because the board has no metal case."],
    "12 MHz crystal": "R7 (1k) in series with XOUT limits the drive level of the crystal, as in the Raspberry Pi hardware design guide.",
    "QSPI flash and BOOTSEL": "R6 is 1k so that BOOTSEL can pull QSPI_SS low without fighting the flash chip select.",
    "Reset and LED": "D1 is on GPIO25 like the Pico, so Pico example code blinks it unchanged.",
}
sch = project.schematic()
built = sch.build(parts, {k: v.split() for k, v in nets.items()}, {k: v.split() for k, v in groups.items()},
                  no_connect="J1.A8 J1.B8 U1.35 U1.36 U1.41 J3.17".split(), notes=notes)
sch.title("RP2040 dev board (V1)", rev="V1")                                # this demo is version 1 of the design, and its title block says so
assert sch.overlaps() == [], sch.overlaps()                                 # nothing drawn over anything else, nothing off the page
print("schematic", built, sch.check())

# ---- board: Pico outline, floorplan in mm from the top left corner, rules for the 0.4 mm QFN, ground pour, one routing call
X0, Y0, W, H = 100, 50, 26, 51.1
FLOOR = {
    "J1": (13, 2.5, 180), "J4": (10.46, H - 1.61, 90),
    "R2": (9.5, 9.2, 0), "R1": (16.5, 9.2, 0), "R4": (12.4, 9.4, 270), "R3": (13.6, 9.4, 270),
    "U2": (19.3, 12.5, 0), "C1": (16.6, 12.5, 90), "C2": (22.0, 14.5, 90),
    "U3": (8.2, 15, 0), "C15": (8.2, 11.3, 0), "R5": (6.5, 19.2, 0), "R6": (9.9, 19.2, 0), "SW1": (18.5, 19.5, 90),
    "U1": (13, 31, 0),
    "C3": (7.8, 25.9, 0), "C10": (16.4, 24.9, 90), "C11": (17.6, 24.9, 90), "C14": (18.8, 24.9, 90), "C9": (20.0, 24.9, 90),
    "C4": (7.8, 27.2, 0), "C5": (7.8, 35.4, 0), "C7": (18.2, 27.2, 0), "C8": (18.2, 35.4, 0),
    "C6": (16.4, 37.1, 90), "C13": (17.6, 37.1, 90), "C12": (18.8, 37.1, 90),
    "Y1": (10.5, 40.5, 0), "R7": (11.6, 37.3, 0), "C16": (7.4, 40.0, 90), "C17": (13.6, 41.0, 90),
    "D1": (20.5, 41.5, 0), "R9": (20.5, 39.8, 0), "SW2": (18.5, 45.5, 0), "R8": (14.6, 43.6, 90),
}
board = project.board()
print("sync", board.sync())
board.outline(X0, Y0, X0 + W, Y0 + H)
board.rules(clearance=0.15, track_width=0.2, via_diameter=0.6, via_drill=0.3, min_track_width=0.15, min_clearance=0.15, edge_clearance=0.3)
fixed = {ref: (X0 + x, Y0 + y, rot) for ref, (x, y, rot) in FLOOR.items()}
fixed["J2"] = (X0 + 1.57, Y0 + 1.42, 0)                                     # header rows exactly 22.86 mm apart, pin 1 top left
fixed["J3"] = (X0 + 1.57 + 22.86, Y0 + 1.42 + 48.26, 180)                    # pin 21 bottom right, as on a Pico
placed = board.autoplace(fixed=fixed, outline=(X0, Y0, X0 + W, Y0 + H))
print("placed", placed["score"])
board.zone("GND", layer="B.Cu")
board.via("GND", (X0 + 13, Y0 + 31))                                       # the RP2040's exposed pad is its only ground
critical = [n for n in board.nets() if any(k in n for k in ("USB_D", "XIN", "XOUT", "QSPI"))]
print("routed", board.route(order=critical, widths={"VBUS": 0.4}, time_s=120))
print("drc", board.check())
if len(sys.argv) > 2:
    sch.svg(sys.argv[2])
print("board", board.info())
project.save()
