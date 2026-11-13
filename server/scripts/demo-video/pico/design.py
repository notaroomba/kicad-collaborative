# A Raspberry Pi Pico style RP2040 board: USB-C, TI TLV62569 buck (5 V to 3.3 V), W25Q16 flash, 12 MHz crystal,
# BOOTSEL and RESET buttons, a status LED, SWD and two 20-pin headers.
# Drawn from the RP2040 sensor board's script with the IMU and barometer taken out.
R0402, C0402, C0603 = "Resistor_SMD:R_0402_1005Metric", "Capacitor_SMD:C_0402_1005Metric", "Capacitor_SMD:C_0603_1608Metric"
HDR = "Connector_PinHeader_2.54mm:PinHeader_1x20_P2.54mm_Vertical"
P = {
    "D1": {"lib": "Device:LED", "value": "LED", "footprint": "LED_SMD:LED_0603_1608Metric"},
    "J1": {"lib": "Connector:USB_C_Receptacle_USB2.0_16P", "value": "USB-C", "footprint": "Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12"},
    "J2": {"lib": "Connector_Generic:Conn_01x20", "value": "GPIO0-15", "footprint": HDR},
    "J3": {"lib": "Connector_Generic:Conn_01x20", "value": "GPIO16-28", "footprint": HDR},
    "J4": {"lib": "Connector_Generic:Conn_01x03", "value": "SWD", "footprint": "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical"},
    "SW1": {"lib": "Switch:SW_Push", "value": "BOOTSEL", "footprint": "Button_Switch_SMD:SW_Push_SPST_NO_Alps_SKRK"},
    "SW2": {"lib": "Switch:SW_Push", "value": "RESET", "footprint": "Button_Switch_SMD:SW_Push_SPST_NO_Alps_SKRK"},
    "U1": {"lib": "MCU_RaspberryPi:RP2040", "value": "RP2040", "footprint": "Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm"},
    "U2": {"lib": "Regulator_Switching:TLV62569DBV", "value": "TLV62569DBV", "footprint": "Package_TO_SOT_SMD:SOT-23-5"},
    "U3": {"lib": "Memory_Flash:W25Q16JVSS", "value": "W25Q16JVSS", "footprint": "Package_SO:SOIC-8_5.3x5.3mm_P1.27mm"},
    "L1": {"lib": "Device:L", "value": "2.2uH", "footprint": "Inductor_SMD:L_1008_2520Metric"},
    "Y1": {"lib": "Device:Crystal_GND24", "value": "12MHz", "footprint": "Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm"},
}
def many(lib, fp, table):
    for value, refs in table.items():
        for ref in refs.split():
            P[ref] = {"lib": lib, "value": value, "footprint": fp}
many("Device:C", C0402, {"1uF": "C11 C14", "100nF": "C3 C4 C5 C6 C7 C8 C9 C10 C12 C13 C15", "15pF": "C16 C17"})
many("Device:C", C0603, {"10uF": "C1 C2 C18"})
many("Device:R", R0402, {"5.1k": "R1 R2", "27": "R3 R4", "10k": "R5 R8", "1k": "R6 R7 R9", "453k": "R10", "100k": "R11"})
N = {
    "+1V1": "C12.1 C13.1 C14.1 U1.23 U1.45 U1.50",
    "+3V3": "L1.2 C2.1 C18.1 R10.1 C3.1 C4.1 C5.1 C6.1 C7.1 C8.1 C9.1 C10.1 C11.1 C15.1 J3.15 J3.16 R5.1 R8.1 U1.1 U1.10 U1.22 U1.33 U1.42 U1.43 U1.44 U1.48 U1.49 U3.8",
    "GND": "C1.2 C2.2 C18.2 R11.2 U2.2 C3.2 C4.2 C5.2 C6.2 C7.2 C8.2 C9.2 C10.2 C11.2 C12.2 C13.2 C14.2 C15.2 C16.2 C17.2 D1.1 J1.A1 J1.A12 J1.B1 J1.B12 J1.SH "
           "J2.3 J2.8 J2.13 J2.18 J3.3 J3.8 J3.13 J3.18 J4.2 R1.2 R2.2 SW1.2 SW2.2 U1.19 U1.57 U3.4 Y1.2 Y1.4",
    "VBUS": "C1.1 J1.A4 J1.A9 J1.B4 J1.B9 J3.19 J3.20 U2.4 U2.1",
    "SW": "U2.3 L1.1", "FB": "U2.5 R10.2 R11.1",
    "GPIO25": "R9.1 U1.37", "GPIO26_ADC0": "J3.11 U1.38", "GPIO27_ADC1": "J3.12 U1.39", "GPIO28_ADC2": "J3.14 U1.40",
    "QSPI_SCLK": "U1.52 U3.6", "QSPI_SD0": "U1.53 U3.5", "QSPI_SD1": "U1.55 U3.2", "QSPI_SD2": "U1.54 U3.3", "QSPI_SD3": "U1.51 U3.7",
    "QSPI_SS": "R5.2 R6.1 U1.56 U3.1", "RUN": "J3.10 R8.2 SW2.1 U1.26", "SWCLK": "J4.1 U1.24", "SWDIO": "J4.3 U1.25",
    "USB_D-": "J1.A7 J1.B7 R3.1", "USB_D+": "J1.A6 J1.B6 R4.1", "XIN": "C16.1 U1.20 Y1.1", "XOUT": "R7.2 U1.21",
    "XTAL_R": "C17.1 R7.1 Y1.3", "LED_K": "D1.2 R9.2", "CC1": "J1.A5 R1.1", "CC2": "J1.B5 R2.1", "BOOT": "R6.2 SW1.1",
    "USB_DM": "R3.2 U1.46", "USB_DP": "R4.2 U1.47",
}
# the remaining GPIOs straight to the headers: (gpio, RP2040 pin, header pin)
for g, u, j in [(0, 2, "J2.1"), (1, 3, "J2.2"), (2, 4, "J2.4"), (3, 5, "J2.5"), (4, 6, "J2.6"), (5, 7, "J2.7"), (6, 8, "J2.9"), (7, 9, "J2.10"), (8, 11, "J2.11"), (9, 12, "J2.12"), (10, 13, "J2.14"), (11, 14, "J2.15"),
                (12, 15, "J2.16"), (13, 16, "J2.17"), (14, 17, "J2.19"), (15, 18, "J2.20"), (16, 27, "J3.1"), (17, 28, "J3.2"), (18, 29, "J3.4"),
                (19, 30, "J3.5"), (20, 31, "J3.6"), (21, 32, "J3.7"), (22, 34, "J3.9")]:
    N[f"GPIO{g}"] = f"U1.{u} {j}"
G = {"USB-C power and data": "J1 R1 R2 R3 R4", "3.3 V buck regulator (TI TLV62569)": "U2 L1 C1 C2 C18 R10 R11", "RP2040 microcontroller": "U1 C3 C4 C5 C6 C7 C8 C9 C10 C11 C12 C13 C14",
     "QSPI flash and BOOTSEL": "U3 C15 R5 R6 SW1", "12 MHz crystal": "Y1 R7 C16 C17", "Reset and status LED": "SW2 R8 D1 R9", "GPIO headers and SWD": "J2 J3 J4"}
NOTES = {      # only the power limits: what may go in and what comes out
    "3.3 V buck regulator (TI TLV62569)": ["In: VBUS 2.5 to 5.5 V. Out: 3.3 V, 2 A max."],
    "USB-C power and data": ["In: 5 V from USB, 500 mA max."],
}
LABELS = "SW FB XIN XOUT XTAL_R USB_DP USB_DM USB_D+ USB_D- QSPI_SS QSPI_SCLK QSPI_SD0 QSPI_SD1 QSPI_SD2 QSPI_SD3".split()
sch = project.schematic()
sch.clear()
built = sch.build(P, {k: v.split() for k, v in N.items()}, {k: v.split() for k, v in G.items()}, no_connect="J1.A8 J1.B8 U1.35 U1.36 U1.41 J3.17".split(), notes=NOTES, labels=LABELS)
left = sch.tidy()
print("schematic", {k: built.get(k) for k in ("placed", "nets", "page", "overlaps", "problems", "unconnected")}, "sections", built.get("sections"))
print("overlaps", sch.overlaps()[:12], "tidy", left)
sch.title("RP2040 Pico board", rev="V1")
if hasattr(sch, "fit_page"):
    print("page", sch.fit_page())
print("erc", sch.check())
