# ESP32-C3 battery devboard (V1): bare ESP32-C3FH4, USB-C, TI BQ24075 charger with power path, TI TLV75733 3.3 V LDO,
# LSM6DS3 IMU and BMP280 barometer on I2C, Johanson chip antenna, Pico-size edge pins.
R0402, C0402, C0603 = "Resistor_SMD:R_0402_1005Metric", "Capacitor_SMD:C_0402_1005Metric", "Capacitor_SMD:C_0603_1608Metric"
HDR = "Connector_PinHeader_2.54mm:PinHeader_1x20_P2.54mm_Vertical"
BTN = "Button_Switch_SMD:SW_Push_SPST_NO_Alps_SKRK"
P = {
    "J1": {"lib": "Connector:USB_C_Receptacle_USB2.0_16P", "value": "USB-C", "footprint": "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal"},
    "U6": {"lib": "Power_Protection:TPD2E2U06DCK", "value": "TPD2E2U06DCK", "footprint": "Package_TO_SOT_SMD:SOT-323_SC-70"},
    "U2": {"lib": "Battery_Management:BQ24075RGT", "value": "BQ24075RGT", "footprint": "Package_DFN_QFN:QFN-16-1EP_3x3mm_P0.5mm_EP1.7x1.7mm"},
    "J4": {"lib": "Connector_Generic_MountingPin:Conn_01x02_MountingPin", "value": "LiPo JST-SH", "footprint": "Connector_JST:JST_SH_BM02B-SRSS-TB_1x02-1MP_P1.00mm_Vertical"},
    "D1": {"lib": "Device:LED", "value": "CHG", "footprint": "LED_SMD:LED_0402_1005Metric"},
    "U3": {"lib": "Regulator_Linear:TLV75733PDBV", "value": "TLV75733PDBV", "footprint": "Package_TO_SOT_SMD:SOT-23-5"},
    "U1": {"lib": "MCU_Espressif:ESP32-C3", "value": "ESP32-C3FH4", "footprint": "Package_DFN_QFN:QFN-32-1EP_5x5mm_P0.5mm_EP3.7x3.7mm"},
    "Y1": {"lib": "Device:Crystal_GND24", "value": "40MHz", "footprint": "Crystal:Crystal_SMD_2016-4Pin_2.0x1.6mm"},
    "L1": {"lib": "Device:L", "value": "2.7nH", "footprint": "Inductor_SMD:L_0402_1005Metric"},
    "AE1": {"lib": "Device:Antenna_Chip", "value": "2450AT18A100", "footprint": "RF_Antenna:Johanson_2450AT18x100"},
    "SW1": {"lib": "Switch:SW_Push", "value": "RESET", "footprint": BTN},
    "SW2": {"lib": "Switch:SW_Push", "value": "BOOT", "footprint": BTN},
    "U4": {"lib": "Sensor_Motion:LSM6DS3", "value": "LSM6DS3TR-C", "footprint": "Package_LGA:LGA-14_3x2.5mm_P0.5mm_LayoutBorder3x4y"},
    "U5": {"lib": "Sensor_Pressure:BMP280", "value": "BMP280", "footprint": "Package_LGA:Bosch_LGA-8_2x2.5mm_P0.65mm_ClockwisePinNumbering"},
    "J2": {"lib": "Connector_Generic:Conn_01x20", "value": "Pins 1-20", "footprint": HDR},
    "J3": {"lib": "Connector_Generic:Conn_01x20", "value": "Pins 21-40", "footprint": HDR},
}
def many(lib, fp, table):
    for value, refs in table.items():
        for ref in refs.split():
            P[ref] = {"lib": lib, "value": value, "footprint": fp}
many("Device:C", C0402, {"1uF": "C1 C4 C5 C10 C13", "100nF": "C7 C8 C9 C11 C18 C19 C20 C21", "12pF": "C14 C15", "1.0pF": "C16 C17"})
many("Device:C", C0603, {"4.7uF": "C2 C3", "10uF": "C6"})
many("Device:R", R0402, {"5.1k": "R1 R2", "3.6k": "R3", "3.24k": "R4", "10k": "R5 R7 R8 R9 R10", "1k": "R6", "4.7k": "R13 R14", "220k": "R15 R16"})
# what to order: maker and part number on every part, the voltage rating on every capacitor, the crystal's load capacitance
YAGEO = {"5.1k": "5K1", "3.6k": "3K6", "3.24k": "3K24", "10k": "10K", "1k": "1K", "4.7k": "4K7", "220k": "220K"}
CAPS = {("1uF", C0402): ("CL05A105KA5NQNC", "25V"), ("100nF", C0402): ("CL05B104KO5NNNC", "16V"), ("12pF", C0402): ("CL05C120JB5NNNC", "50V"),
        ("1.0pF", C0402): ("CL05C010CB5NNNC", "50V"), ("4.7uF", C0603): ("CL10A475KO8NNNC", "16V"), ("10uF", C0603): ("CL10A106KP8NNNC", "10V")}
BUY = {"J1": ("GCT", "USB4105-GF-A"), "U6": ("Texas Instruments", "TPD2E2U06DCKR"), "U2": ("Texas Instruments", "BQ24075RGTR"), "J4": ("JST", "BM02B-SRSS-TB"),
       "D1": ("Lite-On", "LTST-C281KGKT"), "U3": ("Texas Instruments", "TLV75733PDBVR"), "U1": ("Espressif", "ESP32-C3FH4"), "Y1": ("NDK", "NX2016SA-40M-EXS00A-CS06465"),
       "L1": ("Murata", "LQG15HS2N7S02D"), "AE1": ("Johanson Technology", "2450AT18A100E"), "SW1": ("Alps Alpine", "SKRKAEE020"), "SW2": ("Alps Alpine", "SKRKAEE020"),
       "U4": ("STMicroelectronics", "LSM6DS3TR-C"), "U5": ("Bosch Sensortec", "BMP280"), "J2": ("Wurth Elektronik", "61302011121"), "J3": ("Wurth Elektronik", "61302011121")}
for ref, p in P.items():
    if ref in BUY:
        p["fields"] = {"MFR": BUY[ref][0], "MPN": BUY[ref][1]}
    elif p["lib"] == "Device:R":
        p["fields"] = {"MFR": "Yageo", "MPN": "RC0402FR-07%sL" % YAGEO[p["value"]]}
    elif p["lib"] == "Device:C":
        mpn, volts = CAPS[(p["value"], p["footprint"])]
        p["fields"] = {"MFR": "Samsung Electro-Mechanics", "MPN": mpn, "Voltage": volts}
P["Y1"]["fields"]["CL"] = "10pF"
SUPPLIES = {"+3V3": {"volts": (3.2, 3.3, 3.4), "amps": (None, 0.15, 1.0)}, "+BATT": {"volts": (3.0, 3.7, 4.2), "amps": (None, 0.15, 1.0)},
            "VDD_SPI": {"volts": (3.0, 3.3, 3.6), "amps": (None, 0.01, 0.04)}}
N = {
    "VBUS": "J1.A4 J1.A9 J1.B4 J1.B9 U2.13 C1.1 J3.20",
    "VSYS": "U2.10 U2.11 C2.1 U2.5 R6.1 U3.1 U3.3 C4.1 J3.19",
    "+BATT": "U2.2 U2.3 C3.1 J4.1 R15.1 J3.17",
    "+3V3": "U3.5 C5.1 U1.2 U1.3 U1.11 U1.17 U1.31 U1.32 C6.1 C7.1 C8.1 C9.1 C11.1 R7.1 R8.1 R9.1 R10.1 U4.5 U4.8 U4.12 C18.1 C19.1 R13.1 R14.1 U5.2 U5.6 U5.8 C20.1 C21.1 J3.16",
    "GND": "J1.A1 J1.A12 J1.B1 J1.B12 J1.SH R1.2 R2.2 U6.3 U2.8 U2.17 U2.4 U2.6 U2.15 C1.2 C2.2 C3.2 R3.2 R4.2 R5.2 J4.2 J4.MP U3.2 C4.2 C5.2 "
           "U1.33 C6.2 C7.2 C8.2 C9.2 C10.2 C11.2 C13.2 SW1.2 SW2.2 Y1.2 Y1.4 C14.2 C15.2 C16.2 C17.2 U4.1 U4.2 U4.3 U4.6 U4.7 C18.2 C19.2 U5.1 U5.5 U5.7 C20.2 C21.2 R16.2 "
           "J2.3 J2.8 J2.13 J2.18 J3.3 J3.8 J3.13 J3.18",
    "CC1": "J1.A5 R1.1", "CC2": "J1.B5 R2.1",
    "USB_D+": "J1.A6 J1.B6 U6.1 U1.26", "USB_D-": "J1.A7 J1.B7 U6.2 U1.25",
    "CHG_ISET": "U2.16 R3.1", "CHG_ILIM": "U2.12 R4.1", "CHG_TS": "U2.1 R5.1", "CHG_N": "U2.9 D1.1", "CHG_LED": "D1.2 R6.2",
    "VDD_SPI": "U1.18 C10.1",
    "CHIP_EN": "U1.7 R7.2 C13.1 SW1.1 J3.4",
    "GPIO9_BOOT": "U1.15 R8.2 SW2.1 J3.12", "GPIO8": "U1.14 R9.2 J3.11", "GPIO2": "U1.6 R10.2 J2.15",
    "XTAL_P": "U1.30 Y1.1 C14.1", "XTAL_N": "U1.29 Y1.3 C15.1",
    "RF_LNA": "U1.1 C16.1 L1.1", "RF_ANT": "L1.2 C17.1 AE1.1",
    "I2C_SDA": "U1.12 U4.14 U5.3 R13.2 J3.9", "I2C_SCL": "U1.13 U4.13 U5.4 R14.2 J3.10",
    "IMU_INT1": "U4.4 U1.16 J3.14",
    "VBAT_SENSE": "R15.2 R16.1 U1.8 J3.5",
    "GPIO0": "U1.4 J3.2", "GPIO1": "U1.5 J2.16", "GPIO4": "U1.9 J3.6", "GPIO5": "U1.10 J3.7",
    "MCU_RX": "U1.27 J2.11", "MCU_TX": "U1.28 J2.12",
}
G = {
    "USB-C input": "J1 R1 R2 U6",
    "LiPo charger and power path (TI BQ24075)": "U2 C1 C2 C3 R3 R4 R5 D1 R6 J4",
    "3.3 V regulator (TI TLV75733)": "U3 C4 C5",
    "ESP32-C3FH4 (Wi-Fi and Bluetooth LE, flash inside)": "U1 C6 C7 C8 C9 C10 C11 R9 R10",
    "40 MHz crystal": "Y1 C14 C15",
    "2.4 GHz antenna and matching": "C16 L1 C17 AE1",
    "Reset and boot buttons": "SW1 R7 C13 SW2 R8",
    "IMU (LSM6DS3TR-C, I2C 0x6A)": "U4 C18 C19 R13 R14",
    "Barometer (BMP280, I2C 0x76)": "U5 C20 C21",
    "Battery voltage sense": "R15 R16",
    "Pico-style edge pins": "J2 J3",
}
NOTES = {      # only the power limits: what may go in and what comes out
    "USB-C input": ["In: 5 V from USB, 500 mA max (limit set by R4 on the charger)."],
    "LiPo charger and power path (TI BQ24075)": [
        "In: VBUS 4.35 to 6.4 V (survives 28 V), 500 mA max = 1610 / R4.",
        "Out: VSYS = VBUS (5.5 V max) on USB, battery voltage (3.0 to 4.2 V) without. Charge: 4.2 V, 250 mA max = 890 / R3.",
        "J4 pin 1 is battery +: one LiPo cell, 250 mAh or larger."],
    "3.3 V regulator (TI TLV75733)": ["In: VSYS, 5.5 V max. Out: 3.3 V, 1 A max."],
}
NC = "J1.A8 J1.B8 U2.14 U2.7 U1.19 U1.20 U1.21 U1.22 U1.23 U1.24 U4.9 U4.10 U4.11 AE1.2".split()
used = {p for v in N.values() for p in v.split()}
NC += [f"J{j}.{i}" for j in (2, 3) for i in range(1, 21) if f"J{j}.{i}" not in used]
LABELS = "XTAL_P XTAL_N USB_D+ USB_D- CHIP_EN RF_ANT".split()
sch = project.schematic()
sch.clear()
built = sch.build(P, {k: v.split() for k, v in N.items()}, {k: v.split() for k, v in G.items()}, no_connect=NC, notes=NOTES, labels=LABELS, supplies=SUPPLIES)
left = sch.tidy()
sch.title("ESP32-C3 battery devboard (V1)", rev="V1")
if hasattr(sch, "fit_page"):
    print("page", sch.fit_page())
print("schematic", {k: built.get(k) for k in ("placed", "nets", "page", "overlaps", "problems", "unconnected", "pins_swapped")})
print("overlaps", sch.overlaps()[:12], "tidy", left)
print("erc", sch.check())
rv = sch.review()
print("review", rv["errors"], rv["warnings"], [f[:300] for f in rv["findings"]])
