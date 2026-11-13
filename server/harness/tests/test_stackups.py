"""Stackups, materials and fabricator limits: board.stackup(), board.bend_area() and the flex and material checks.

Needs Node and the built engine (server/static/dist/harness-engine.js); skipped when they are missing.
"""
import os
import re
import unittest

import kicad_harness as kh

from test_physics import Boards, edge, part, track, via, zone


class Stackups(Boards):
    def text(self):
        self.project.save()
        with open(os.path.join(self.dir, "p.kicad_pcb"), encoding="utf-8") as f:
            return f.read()

    def test_fab_build_is_written_to_the_board(self):
        """JLCPCB's four-layer build: the layer count, each thickness, the finish, the board thickness and their limits as rules."""
        b = self.open(edge([100, 100, 140, 130]))
        self.assertTrue(b.stackup()["assumed"])
        r = b.stackup(fab="jlcpcb", layers=4, finish="enig")
        self.assertEqual(r["build"], "JLC04161H-7628")
        self.assertEqual(r["copper_layers"], ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"])
        self.assertEqual(r["finish"], "ENIG")
        self.assertFalse(r["derived"])
        self.assertEqual(r["rules"]["min_track_width"], 0.09)
        # 50 ohm over 0.21 mm of 7628: about 0.35 mm
        self.assertAlmostEqual(r["outer"]["width_50_ohm"], 0.36, delta=0.06)
        now = b.stackup()
        self.assertFalse(now["assumed"])
        self.assertEqual([l["thickness"] for l in now["layers"] if l["type"] == "copper"], [0.035, 0.0152, 0.0152, 0.035])
        self.assertEqual([l["material"] for l in now["layers"] if l["type"] in ("prepreg", "core")], ["7628", "FR4", "7628"])
        self.assertAlmostEqual(now["thickness"], 1.6, delta=0.05)
        t = self.text()
        self.assertIn('(copper_finish "ENIG")', t)
        self.assertIn('(material "7628")', t)
        self.assertRegex(t, r'\(layer "In1\.Cu" \(type "copper"\) \(thickness 0\.0152\)\)')
        self.assertRegex(t, r"\(general\s*\(thickness 1\.6\)")
        self.assertEqual(len(re.findall(r"\(stackup", t)), 1)
        # the thinner prepreg gives a narrower 50 ohm track
        thin = b.stackup(build="JLC04161H-3313")
        self.assertLess(thin["outer"]["width_50_ohm"], 0.22)
        self.assertEqual(b.info()["min_track_width"], 0.09)

    def test_the_file_opens_again_with_the_stackup(self):
        b = self.open(edge([100, 100, 140, 130]))
        b.stackup(fab="pcbway", layers=4)
        self.project.save()
        again = kh.open(self.dir)
        self.addCleanup(again.close)
        now = again.board().stackup()
        self.assertEqual(len(now["copper_layers"]), 4)
        self.assertEqual([l["epsilon_r"] for l in now["layers"] if l["type"] == "prepreg"], [4.74, 4.74])

    def test_finish_the_fab_does_not_offer(self):
        b = self.open(edge([100, 100, 140, 130]))
        with self.assertRaises(kh.HarnessError):
            b.stackup(fab="jlcpcb", layers=6, finish="hasl")
        with self.assertRaises(kh.HarnessError):
            b.stackup(fab="jlcpcb", material="flex", finish="osp")

    def test_flex_board(self):
        """A flex build, its bend area, and the checks on what crosses the bend."""
        b = self.open(edge([100, 100, 160, 112]),
                      part("J1", (104, 106), [("1", 0, -1, 1, 1, "SDA"), ("2", 0, 1, 1, 1, "SCL")], lib="Connector:FPC"),
                      part("J2", (156, 106), [("1", 0, -1, 1, 1, "SDA"), ("2", 0, 1, 1, 1, "SCL")], lib="Connector:FPC"),
                      part("R9", (130, 110), [("1", -0.5, 0, 0.5, 0.5, "SCL"), ("2", 0.5, 0, 0.5, 0.5, "X")]),
                      track("SDA", [(104, 105), (128, 105), (130, 103), (156, 105)]),
                      track("SCL", [(104, 107), (156, 107)]), track("SCL", [(110, 107), (150, 107)], layer="B.Cu"),
                      via("SDA", (131, 104)), zone("GND", "B.Cu", [100, 100, 160, 112]))
        r = b.stackup(fab="jlcpcb", material="flex", layers=2)
        self.assertEqual(r["finish"], "ENIG")
        self.assertAlmostEqual(r["thickness"], 0.116, delta=0.01)
        self.assertEqual(r["rules"]["edge_clearance"], 0.3)
        self.assertTrue(b.stackup()["flex"])
        rev = b.review()
        self.assertIn("flex.bend", self.failed(rev) | {f.split(":", 1)[0].split(" ", 1)[1] for f in rev["findings"]})          # no bend area marked yet
        b.bend_area([120, 100, 140, 112])
        self.assertEqual(b.stackup()["bend_areas"], [[120, 100, 140, 112]])
        rev = b.review()
        said = self.finding(rev, "flex.bend")
        self.assertIn("via at", said)
        self.assertIn("R9", said)
        self.assertIn("SDA turns a corner", said)
        self.assertIn("pour", said)
        self.assertIn("SCL over SCL", self.finding(rev, "flex.copper"))
        self.assertEqual(kh.calc.bend_radius(0.116, 2), 1.16)

    def test_metal_core_is_one_sided(self):
        b = self.open(edge([100, 100, 140, 130]), part("D1", (110, 110), [("1", -1, 0, 1, 1, "A"), ("2", 1, 0, 1, 1, "GND")], lib="LED_SMD:LED"),
                      track("A", [(109, 110), (105, 110)]), via("A", (105, 110)), track("A", [(105, 110), (105, 120)], layer="B.Cu"))
        r = b.stackup(fab="jlcpcb", material="aluminium")
        self.assertIn("one-sided", " ".join(r["notes"]))
        self.assertIn("stackup.material", self.failed(b.review()))

    def test_choosing(self):
        self.assertEqual(kh.materials.choose(ghz=5.8)["material"], "ro4350b")
        self.assertEqual(kh.materials.choose(ghz=2.4, radio=True)["layers"], 4)
        self.assertEqual(kh.materials.choose(flex=True, dynamic=True)["layers"], 1)
        self.assertEqual(kh.materials.choose(led=True)["material"], "aluminium")
        c = kh.materials.choose(fast=True, bga=True, fine_pitch=0.5)
        self.assertEqual((c["material"], c["layers"], c["finish"]), ("fr4", 6, "enig"))
        self.assertEqual(kh.materials.get("rogers")["epsilon_r"], 3.66)
        six = kh.stackups.build("jlcpcb", 6)
        self.assertAlmostEqual(sum(l["thickness"] for l in six["layers"]), 1.54, delta=0.06)
        for n in (4, 8):
            d = kh.stackups.build(None, n, 1.2)
            self.assertAlmostEqual(sum(l["thickness"] for l in d["layers"]), 1.2, delta=0.02)


if __name__ == "__main__":
    unittest.main()
