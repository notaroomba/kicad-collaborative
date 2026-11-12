"""A small design made from nothing on local files: schematic, board, placement, routing, checks.

Needs Node, the built engine (server/static/dist/harness-engine.js) and KiCad's libraries (an
installation, or network access to KiCad's library repository); skipped when one is missing.
"""
import os
import shutil
import tempfile
import unittest

import kicad_harness as kh


class Blinker(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="kh-test-")
        try:
            self.project = kh.new(self.dir, "blinky")
            self.project.schematic().lib("Device:R")
        except (kh.HarnessError, OSError) as e:
            shutil.rmtree(self.dir, ignore_errors=True)
            self.skipTest(f"the design engine or KiCad's libraries are not available: {e}")

    def tearDown(self):
        self.project.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_schematic_to_routed_board(self):
        p = self.project
        sch = p.schematic()
        sch.place("Timer:NE555D", ref="U1", footprint="Package_SO:SOIC-8_3.9x4.9mm_P1.27mm")
        self.assertEqual(len(sch.pins("U1")), 8)
        self.assertEqual(sch.pin("U1.VCC")["number"], "8")
        sch.net("GND", "U1.GND")
        sch.net("+5V", "U1.VCC", "U1.RST")
        r1 = sch.attach("U1.DISCH", "Device:R", value="10k", footprint="Resistor_SMD:R_0402_1005Metric", to="+5V")
        r2 = sch.place("Device:R", value="47k", footprint="Resistor_SMD:R_0402_1005Metric")
        c1 = sch.place("Device:C", value="10uF", footprint="Capacitor_SMD:C_0603_1608Metric")
        sch.connect("U1.DISCH", f"{r2}.1")
        sch.connect(f"{r2}.2", "U1.THRES")
        sch.connect("U1.THRES", "U1.TRIG")
        sch.connect("U1.THRES", f"{c1}.1")
        sch.net("GND", f"{c1}.2")
        d1 = sch.attach("U1.OUT", "Device:LED", footprint="LED_SMD:LED_0603_1608Metric", part_pin="2")
        sch.attach(f"{d1}.1", "Device:R", value="330", footprint="Resistor_SMD:R_0402_1005Metric", to="GND")
        sch.no_connect("U1.CONT")
        self.assertEqual(sorted(sch.refs()), ["C1", "D1", "R1", "R2", "R3", "U1"])
        self.assertEqual(sch.unconnected(), [])
        self.assertEqual(sch.check()["errors"], 0)
        self.assertEqual(sch.net_of("U1.TRIG"), sch.net_of(f"{c1}.1"))
        self.assertEqual(sch.net_of(f"{r1}.2"), "+5V")

        board = p.board()
        self.assertEqual(board.sync()["added"], 6)
        board.outline(100, 100, 125, 120)
        placed = board.autoplace(outline=(100, 100, 125, 120))
        self.assertEqual(placed["score"]["courtyardClashes"], 0)
        routed = board.route(time_s=20)
        self.assertEqual(routed["routed"], routed["connections"])
        self.assertEqual(board.unrouted(), {})
        self.assertEqual(board.check()["errors"], 0)

        written = p.save()
        self.assertTrue(any(f.endswith(".kicad_pcb") for f in written))
        again = kh.open(self.dir)
        try:
            self.assertEqual(len(again.board().refs()), 6)
            self.assertEqual(sorted(again.schematic().refs()), ["C1", "D1", "R1", "R2", "R3", "U1"])
        finally:
            again.close()

    def test_a_netlist_becomes_a_sheet_and_a_generated_part_reaches_the_board(self):
        p = self.project
        reg = kh.parts.make("MYREG", package="SOT-23-5", pins=[(1, "VIN"), (2, "GND"), (3, "EN"), (4, "NC"), (5, "VOUT")])
        sch = p.schematic()
        built = sch.build(
            parts={"U1": {"lib": reg}, "C1": {"lib": "Device:C", "value": "1uF", "footprint": "Capacitor_SMD:C_0402_1005Metric"},
                   "C2": {"lib": "Device:C", "value": "1uF", "footprint": "Capacitor_SMD:C_0402_1005Metric"}},
            nets={"VBUS": ["U1.VIN", "U1.EN", "C1.1"], "+3V3": ["U1.VOUT", "C2.1"], "GND": ["U1.GND", "C1.2", "C2.2"]},
            no_connect=["U1.NC"])
        self.assertEqual(built["placed"], 3)
        self.assertEqual(built["problems"], [])
        self.assertEqual(sch.unconnected(), [])
        nets = sch.nets()
        self.assertEqual(sorted(nets["GND"]), ["C1.2", "C2.2", "U1.2"])
        board = p.board()
        self.assertEqual(board.sync()["problems"], [])
        self.assertEqual(len(board.pads("U1")), 5)

    def test_a_wrong_call_says_what_is_wrong(self):
        sch = self.project.schematic()
        with self.assertRaises(kh.HarnessError) as e:
            sch.pin("U9.1")
        self.assertIn("U9", str(e.exception))


if __name__ == "__main__":
    unittest.main()
