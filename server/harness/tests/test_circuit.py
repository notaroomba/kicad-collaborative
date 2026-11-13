"""The circuit knowledge of review-circuit.ts: support circuits checked from the netlist.

Needs Node, the built engine and KiCad's libraries; skipped when one is missing.
"""
import shutil
import tempfile
import unittest

import kicad_harness as kh

R = "Resistor_SMD:R_0402_1005Metric"
C = "Capacitor_SMD:C_0402_1005Metric"


class Circuit(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="kh-circuit-")
        try:
            self.project = kh.new(self.dir, "circuit")
            self.project.schematic().lib("Device:R")
        except (kh.HarnessError, OSError) as e:
            shutil.rmtree(self.dir, ignore_errors=True)
            self.skipTest(f"the design engine or KiCad's libraries are not available: {e}")

    def tearDown(self):
        self.project.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    @staticmethod
    def said(rv, rule):
        return " | ".join(f for f in rv["findings"] if f.split(":", 1)[0].endswith(" " + rule))

    def parts(self, sch, kind, rows, x, y):
        for i, (ref, value) in enumerate(rows):
            sch.place(kind, ref=ref, value=value, at=(x + 12.7 * i, y), footprint=R if kind == "Device:R" else C if kind == "Device:C" else None)

    def test_the_usual_circuit_mistakes_are_named(self):
        sch = self.project.schematic()
        sch.place("Regulator_Linear:LM317_SOT-223", ref="U1", at=(50.8, 50.8), footprint="Package_TO_SOT_SMD:SOT-223-3_TabPin2")
        sch.place("Sensor_Temperature:TMP102xxDRL", ref="U2", at=(101.6, 50.8), footprint="Package_TO_SOT_SMD:SOT-563")
        sch.place("Device:Crystal", ref="Y1", value="16MHz", at=(152.4, 50.8), fields={"CL": "10pF"})
        sch.place("Connector:USB_C_Receptacle_USB2.0_16P", ref="J1", at=(203.2, 76.2))
        sch.place("Device:LED", ref="D1", value="LED", at=(50.8, 127))
        sch.place("Device:LED", ref="D2", value="LED", at=(76.2, 127))
        self.parts(sch, "Device:R", [("R1", "240"), ("R2", "1k"), ("R3", "5.1k"), ("R4", "4.7k"), ("R5", "4.7k"), ("R6", "470"), ("R7", "47"), ("R8", "10k"), ("R9", "10k")], 50.8, 152.4)
        self.parts(sch, "Device:C", [("C1", "22pF"), ("C2", "22pF")], 50.8, 177.8)
        sch.flush()
        sch.set("R9", footprint="Resistor_SMD:R_0805_2012Metric")
        sch.net("+12V", "U1.VI")
        sch.net("+3V3", "U1.VO", "R1.1", "U2.V+", "R4.1", "R5.1", "R6.1", "D1.A", "R7.1")
        sch.net("ADJ", "U1.ADJ", "R1.2", "R2.1")
        sch.net("GND", "R2.2", "U2.GND", "U2.ADD0", "C1.2", "C2.2", "R3.2", "D1.K", "D2.K", "J1.GND")
        sch.net("SDA", "U2.SDA", "R4.2", "R5.2")
        sch.net("SCL", "U2.SCL", "R6.2")
        sch.net("XIN", "Y1.1", "C1.1")
        sch.net("XOUT", "Y1.2", "C2.1")
        sch.net("CC", "J1.CC1", "J1.CC2", "R3.1")
        sch.net("USB_DP", "J1.D+")
        sch.net("USB_DM", "J1.D-")
        sch.net("LED2", "R7.2", "D2.A")
        sch.net("MOTOR_EN", "R8.1")
        sch.net("Motor-EN", "R8.2", "R9.1")
        sch.net("ORPHAN_SIG", "R9.2")
        sch.flush()
        rv = sch.review()
        self.assertIn("6.46 V", self.said(rv, "regulator.setpoint"))
        caps = self.said(rv, "regulator.caps")
        self.assertIn("input (+12V)", caps)
        self.assertIn("output (+3V3)", caps)
        self.assertIn("SOT-223", self.said(rv, "regulator.heat"))
        self.assertIn("R4 4.7k, R5 4.7k", self.said(rv, "i2c.pullups"))
        self.assertIn("SCL: 470R", self.said(rv, "i2c.pullups"))
        self.assertIn("Y1 (CL 10pF)", self.said(rv, "crystal.load"))
        self.assertIn("CC1 and CC2 are joined", self.said(rv, "usbc.cc"))
        self.assertIn("J1", self.said(rv, "usb.esd"))
        led = self.said(rv, "led.current")
        self.assertIn("D1 LED between", led)
        self.assertIn("D2 with R7 47", led)
        typos = self.said(rv, "nets.typos")
        self.assertIn("MOTOR_EN and Motor-EN", typos)
        self.assertIn("ORPHAN_SIG: only R9", typos)
        self.assertIn("0805: R9", self.said(rv, "passives.sizes"))

    def test_a_correct_circuit_raises_none_of_them(self):
        sch = self.project.schematic()
        sch.place("Regulator_Linear:LM317_SOT-223", ref="U1", at=(50.8, 50.8), footprint="Package_TO_SOT_SMD:SOT-223-3_TabPin2")
        sch.place("Sensor_Temperature:TMP102xxDRL", ref="U2", at=(101.6, 50.8), footprint="Package_TO_SOT_SMD:SOT-563")
        sch.place("Device:Crystal", ref="Y1", value="16MHz", at=(152.4, 50.8), fields={"CL": "10pF"})
        sch.place("Connector:USB_C_Receptacle_USB2.0_16P", ref="J1", at=(203.2, 76.2))
        sch.place("Device:LED", ref="D2", value="LED", at=(76.2, 127))
        self.parts(sch, "Device:R", [("R1", "240"), ("R2", "390"), ("R3", "5.1k"), ("R4", "4.7k"), ("R5", "5.1k"), ("R6", "4.7k"), ("R7", "680")], 50.8, 152.4)
        self.parts(sch, "Device:C", [("C1", "12pF"), ("C2", "12pF"), ("C3", "10uF"), ("C4", "10uF"), ("C5", "100nF")], 50.8, 177.8)
        sch.net("+5V", "U1.VI", "C3.1")
        sch.net("+3V3", "U1.VO", "R1.1", "U2.V+", "R4.1", "R6.1", "R7.1", "C4.1", "C5.1")
        sch.net("ADJ", "U1.ADJ", "R1.2", "R2.1")
        sch.net("GND", "R2.2", "U2.GND", "U2.ADD0", "C1.2", "C2.2", "R3.2", "R5.2", "D2.K", "J1.GND", "C3.2", "C4.2", "C5.2")
        sch.net("SDA", "U2.SDA", "R4.2")
        sch.net("SCL", "U2.SCL", "R6.2")
        sch.net("XIN", "Y1.1", "C1.1")
        sch.net("XOUT", "Y1.2", "C2.1")
        sch.net("CC1", "J1.CC1", "R3.1")
        sch.net("CC2", "J1.CC2", "R5.1")
        sch.net("LED2", "R7.2", "D2.A")
        sch.flush()
        rv = sch.review()
        rules = {f.split(":", 1)[0].split(" ", 1)[1] for f in rv["findings"]}
        for rule in ("regulator.setpoint", "regulator.caps", "i2c.pullups", "crystal.load", "usbc.cc", "led.current", "nets.typos", "passives.sizes", "bypass.count"):
            self.assertNotIn(rule, rules, self.said(rv, rule))
        # 1.25 V x (1 + 390 / 240) = 3.28 V, and 5 V to 3.3 V in a SOT-223 is about 580 mA: a note, not a warning
        self.assertTrue(self.said(rv, "regulator.heat").startswith("note"), self.said(rv, "regulator.heat"))


if __name__ == "__main__":
    unittest.main()
