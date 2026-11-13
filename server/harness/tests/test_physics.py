"""The layout physics: the checks of review-physics.ts and the calls that put in the copper they ask for.

The boards are written out as small KiCad files so each test states exactly the copper it is about.  Needs Node and
the built engine (server/static/dist/harness-engine.js); skipped when they are missing.
"""
import os
import shutil
import tempfile
import unittest

import kicad_harness as kh

HEAD2 = ('(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) '
         '(5 "F.SilkS" user) (25 "Edge.Cuts" user)) (setup (pad_to_mask_clearance 0)) ')


def part(ref, at, pads, value="", lib="T:P"):
    """pads: [(number, dx, dy, w, h, net)] or with a seventh item, the pin's function."""
    out = f'(footprint "{lib}" (layer "F.Cu") (uuid "fp-{ref}") (at {at[0]} {at[1]}) (property "Reference" "{ref}" (at 0 -3) (layer "F.SilkS") (uuid "r-{ref}")) (property "Value" "{value}" (at 0 3) (layer "F.SilkS") (uuid "v-{ref}") (hide yes))'
    for p in pads:
        fn = f' (pinfunction "{p[6]}")' if len(p) > 6 else ""
        net = f' (net "{p[5]}")' if p[5] else ""
        out += f' (pad "{p[0]}" smd rect (at {p[1]} {p[2]}) (size {p[3]} {p[4]}) (layers "F.Cu" "F.Mask"){net}{fn} (uuid "p-{ref}-{p[0]}"))'
    return out + ")"


def track(net, pts, layer="F.Cu", width=0.25):
    return " ".join(f'(segment (start {a[0]} {a[1]}) (end {b[0]} {b[1]}) (width {width}) (layer "{layer}") (net "{net}") (uuid "t-{net}-{layer}-{i}-{a[0]}-{a[1]}"))' for i, (a, b) in enumerate(zip(pts, pts[1:])))


def via(net, at):
    return f'(via (at {at[0]} {at[1]}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "{net}") (uuid "v-{net}-{at[0]}-{at[1]}"))'


def zone(net, layer, box):
    x0, y0, x1, y1 = box
    return (f'(zone (net "{net}") (layer "{layer}") (uuid "z-{net}-{layer}-{x0}") (hatch edge 0.5) (connect_pads yes (clearance 0.25)) (min_thickness 0.2) '
            f'(fill (thermal_gap 0.3) (thermal_bridge_width 0.4)) (polygon (pts (xy {x0} {y0}) (xy {x1} {y0}) (xy {x1} {y1}) (xy {x0} {y1}))))')


def edge(box):
    return f'(gr_rect (start {box[0]} {box[1]}) (end {box[2]} {box[3]}) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))'


class Boards(unittest.TestCase):
    def open(self, *items):
        self.dir = tempfile.mkdtemp(prefix="kh-physics-")
        with open(os.path.join(self.dir, "p.kicad_pcb"), "w", encoding="utf-8") as f:
            f.write(HEAD2 + " ".join(items) + ")\n")
        with open(os.path.join(self.dir, "p.kicad_pro"), "w", encoding="utf-8") as f:
            f.write('{ "meta": { "filename": "p.kicad_pro", "version": 3 }, "net_settings": { "classes": [], "meta": { "version": 4 } }, "board": { "design_settings": { "rules": {} } } }\n')
        try:
            self.project = kh.open(self.dir)
        except (kh.HarnessError, OSError) as e:
            shutil.rmtree(self.dir, ignore_errors=True)
            self.skipTest(f"the design engine is not available: {e}")
        self.addCleanup(lambda: (self.project.close(), shutil.rmtree(self.dir, ignore_errors=True)))
        return self.project.board()

    @staticmethod
    def failed(rv):
        return {f.split(":", 1)[0].split(" ", 1)[1] for f in rv["findings"] if not f.startswith("note")}

    @staticmethod
    def finding(rv, rule):
        return " | ".join(f for f in rv["findings"] if f.split(":", 1)[0].endswith(" " + rule))


class Physics(Boards):
    def radio(self, *more):
        box = (100, 100, 140, 130)
        return self.open(edge(box), zone("GND", "F.Cu", box), zone("GND", "B.Cu", box),
                         part("U1", (110, 118), [("1", 0, 0, 1, 0.6, "ANT"), ("2", 0, 1.27, 1, 0.6, "GND"), ("3", 0, -1.27, 1, 0.6, "GND")], value="ESP32-C3"),
                         part("AE1", (132, 103), [("1", -1.5, 0, 0.8, 1, "ANT"), ("2", 1.5, 0, 0.8, 1, "")], value="2450AT18A100", lib="RF_Antenna:Johanson_2450AT18x100"),
                         track("ANT", [(110, 118), (126, 118), (130.5, 113.5), (130.5, 103)]), *more)

    def test_an_antenna_gets_its_keepout_and_its_ground_edge_stitched(self):
        board = self.radio()
        rv = board.review()
        self.assertIn("antenna.keepout", self.failed(rv))        # the pours run under it
        self.assertIn("pour", self.finding(rv, "antenna.keepout"))
        self.assertIn("error antenna.fence", self.finding(rv, "antenna.fence"))      # and nothing ties them together beside it
        self.assertIn("board.fence_net", self.finding(rv, "rf.feed"))
        got = board.antenna("AE1")["AE1"]
        self.assertIsNotNone(got["keepout"])
        self.assertGreaterEqual(got["vias"], 6)
        self.assertEqual(got["frequency_ghz"], 2.45)
        fence = board.fence_net("ANT")
        self.assertGreaterEqual(fence["vias"], 8)
        rv = board.review()
        self.assertFalse({"antenna.keepout", "antenna.fence"} & self.failed(rv), rv["findings"])
        self.assertNotIn("fence it", self.finding(rv, "rf.feed"))        # what is left is the width: no 50 ohm on two layers
        self.assertEqual(board.check()["errors"], 0, board.check())
        self.assertEqual(board.antenna("AE1")["AE1"]["keepout"], None)      # a second call finds the keep-out and adds nothing
        self.project.save()
        with open(os.path.join(self.dir, "p.kicad_pcb"), encoding="utf-8") as f:
            self.assertIn("AE1 antenna keep-out", f.read())

    def test_an_rf_feed_with_a_via_a_sharp_corner_and_no_ground_under_it_is_named(self):
        box = (100, 100, 140, 130)
        board = self.open(edge(box), zone("GND", "B.Cu", (100, 100, 118, 130)),      # the plane stops half way
                          part("U1", (104, 115), [("1", 0, 0, 1, 0.6, "RF_OUT"), ("2", 0, 1.27, 1, 0.6, "GND")], value="SX1262"),
                          part("J1", (136, 115), [("1", 0, 0, 1, 1, "RF_OUT"), ("2", 0, 2, 1, 1, "GND")], value="SMA", lib="Connector_Coaxial:SMA"),
                          track("RF_OUT", [(104, 115), (120, 115), (120, 110)]), via("RF_OUT", (120, 110)), track("RF_OUT", [(120, 110), (136, 110), (136, 115)], layer="B.Cu"))
        text = self.finding(board.review(), "rf.feed")
        self.assertIn("error rf.feed", text)
        self.assertIn("1 via", text)
        self.assertIn("sharp corner", text)
        self.assertIn("no ground under it", text)
        self.assertIn("ohm", text)          # 0.25 mm on a two-layer board is nowhere near 50 ohm

    def test_fast_nets_need_ground_under_them_a_return_via_and_matched_pairs(self):
        box = (100, 100, 150, 130)
        board = self.open(edge(box), zone("GND", "B.Cu", (100, 100, 125, 130)), zone("GND", "F.Cu", (100, 100, 125, 130)),
                          part("U1", (105, 110), [("1", 0, 0, 0.6, 0.6, "SPI_CLK"), ("2", 0, 2, 0.6, 0.6, "USB_D+"), ("3", 0, 3, 0.6, 0.6, "USB_D-"), ("4", 0, 5, 0.6, 0.6, "GND")]),
                          part("U2", (145, 110), [("1", 0, 0, 0.6, 0.6, "SPI_CLK"), ("2", 0, 2, 0.6, 0.6, "USB_D+"), ("3", 0, 3, 0.6, 0.6, "USB_D-"), ("4", 0, 5, 0.6, 0.6, "GND")]),
                          track("SPI_CLK", [(105, 110), (120, 110)]), via("SPI_CLK", (120, 110)), track("SPI_CLK", [(120, 110), (145, 110)], layer="B.Cu"),
                          track("USB_D+", [(105, 112), (145, 112)]), track("USB_D-", [(105, 113), (110, 113), (110, 116), (140, 116), (140, 113), (145, 113)]))
        rv = board.review()
        self.assertIn("SPI_CLK", self.finding(rv, "return.path"))
        self.assertIn("SPI_CLK", self.finding(rv, "return.vias"))
        pairs = self.finding(rv, "pairs")
        self.assertIn("usb2", pairs)
        self.assertIn("limit 1.27 mm", pairs)
        self.assertIn("without its partner", pairs)

    def test_the_part_checks_name_the_part_and_thermal_vias_fix_the_pad(self):
        box = (100, 100, 160, 150)
        qfn = [(str(i + 1), -2.0, -1.0 + i * 0.5, 0.8, 0.25, "GND" if i == 0 else f"IO{i}") for i in range(5)] + [("6", 0.2, 0, 2.4, 2.4, "GND")]
        board = self.open(edge(box), zone("GND", "B.Cu", box),
                          part("U1", (110, 110), qfn + [("7", 2.0, -1.0, 0.8, 0.25, "XIN"), ("8", 2.0, -0.5, 0.8, 0.25, "XOUT"), ("9", 2.0, 0.5, 0.8, 0.25, "SD_CLK"), ("10", 2.0, 1.0, 0.8, 0.25, "SD_D0"), ("11", 2.0, 1.5, 0.8, 0.25, "SD_D1")], value="MCU"),
                          part("Y1", (140, 105), [("1", -1, 0, 0.8, 1, "XIN"), ("2", 1, 0, 0.8, 1, "XOUT")], value="12MHz", lib="Crystal:Crystal_SMD_3225-4Pin"),
                          track("XIN", [(112, 109), (139, 109), (139, 105)]), track("IO3", [(120, 100.5), (140, 105.2), (150, 105.2)]),
                          part("J1", (155, 120), [("1", 0, 0, 0.8, 0.8, "SD_CLK"), ("2", 0, 1.5, 0.8, 0.8, "SD_D0"), ("3", 0, 3, 0.8, 0.8, "SD_D1")], value="microSD", lib="Connector_Card:microSD"),
                          track("SD_CLK", [(112, 110.5), (155, 110.5), (155, 120)]), track("SD_D0", [(112, 111), (130, 111), (130, 121.5), (155, 121.5)]),
                          track("SD_D1", [(112, 111.5), (120, 111.5), (120, 140), (150, 140), (150, 123), (155, 123)]),
                          part("U2", (120, 135), [("1", -2, -1.27, 1, 0.6, "+48V"), ("2", -2, 1.27, 1, 0.6, "GND"), ("3", 2, 1.27, 1, 0.6, "ISO_GND"), ("4", 2, -1.27, 1, 0.6, "ISO_OUT")], value="PC817", lib="Package_DIP:SMDIP-4"),
                          track("IO1", [(120, 130), (120, 139)]),
                          track("+48V", [(104, 133.73), (118, 133.73)]), track("IO2", [(104, 134.15), (112, 134.15)]),
                          part("U3", (135, 140), [("1", -1.5, -1, 0.6, 0.4, "AMP_OUT", "~"), ("2", -1.5, 0, 0.6, 0.4, "AMP_INV", "-"), ("3", -1.5, 1, 0.6, 0.4, "AMP_IN", "+")], value="OPA333", lib="Amplifier_Operational:OPA333xxDBV"),
                          part("R1", (150, 146), [("1", -0.5, 0, 0.5, 0.5, "AMP_INV"), ("2", 0.5, 0, 0.5, 0.5, "AMP_OUT")], value="100k"),
                          track("AMP_INV", [(133.5, 140), (133.5, 146), (149.5, 146)]))
        rv = board.review()
        bad = self.failed(rv)
        for rule in ("crystal", "bus.match", "isolation", "creepage", "thermal.pad", "amplifier.input"):
            self.assertIn(rule, bad, rv["findings"])
        self.assertIn("Y1", self.finding(rv, "crystal"))
        self.assertIn("IO3", self.finding(rv, "crystal"))               # routed under the crystal
        self.assertIn("SD_D1", self.finding(rv, "bus.match"))
        self.assertNotIn("SD_D0 ", self.finding(rv, "bus.match"))        # within 2.5 mm of the clock
        self.assertIn("IO1", self.finding(rv, "isolation"))
        self.assertIn("48 V needs 0.3 mm", self.finding(rv, "creepage"))
        self.assertIn("U1", self.finding(rv, "thermal.pad"))
        self.assertIn("R1", self.finding(rv, "amplifier.input"))
        got = board.thermal_vias("U1")["U1"]
        self.assertEqual((got["pad"], got["net"]), ("6", "GND"))
        self.assertGreaterEqual(got["vias"], 4)
        self.assertNotIn("warning thermal.pad", self.finding(board.review(), "thermal.pad"))
        with self.assertRaises(kh.HarnessError):
            board.thermal_vias("Y1")                                    # no exposed pad there

    def test_the_plan_is_made_from_the_netlist_before_anything_is_placed(self):
        box = (100, 100, 150, 140)
        board = self.open(edge(box), zone("GND", "F.Cu", box), zone("GND", "B.Cu", box),
                          part("U1", (112, 125), [("1", 0, -2, 0.8, 0.4, "RF"), ("2", 0, -1, 0.8, 0.4, "+3V3"), ("3", 0, 0, 0.8, 0.4, "GND"), ("4", 0, 1, 0.8, 0.4, "XIN"), ("5", 0, 2, 0.8, 0.4, "XOUT"), ("6", 0, 3, 0.8, 0.4, "USB_D+")], value="ESP32-C3"),
                          part("C1", (104, 104), [("1", -0.5, 0, 0.5, 0.5, "+3V3"), ("2", 0.5, 0, 0.5, 0.5, "GND")], value="100nF"),
                          part("C5", (108, 104), [("1", -0.5, 0, 0.5, 0.5, "+3V3"), ("2", 0.5, 0, 0.5, 0.5, "GND")], value="10uF"),
                          part("Y1", (104, 108), [("1", -1, 0, 0.8, 1, "XIN"), ("2", 1, 0, 0.8, 1, "XOUT")], value="40MHz", lib="Crystal:Crystal_SMD_2016-4Pin"),
                          part("C2", (104, 112), [("1", -0.5, 0, 0.5, 0.5, "XIN"), ("2", 0.5, 0, 0.5, 0.5, "GND")], value="10pF"),
                          part("L1", (104, 116), [("1", -0.5, 0, 0.5, 0.5, "RF"), ("2", 0.5, 0, 0.5, 0.5, "ANT")], value="2.7nH"),
                          part("AE1", (125, 120), [("1", -1.5, 0, 0.8, 1, "ANT"), ("2", 1.5, 0, 0.8, 1, "")], value="2450AT18A100", lib="RF_Antenna:Johanson_2450AT18x100"),
                          part("U2", (140, 130), [("1", -1, -1, 0.6, 0.4, "VBUS", "VIN"), ("2", -1, 0, 0.6, 0.4, "GND", "GND"), ("3", -1, 1, 0.6, 0.4, "SW", "SW"), ("4", 1, 0, 0.6, 0.4, "FB", "FB")], value="TPS62160"),
                          part("L2", (104, 124), [("1", -1.5, 0, 1, 2.5, "SW"), ("2", 1.5, 0, 1, 2.5, "+3V3")], value="2.2uH"),
                          part("C4", (104, 130), [("1", -0.5, 0, 0.5, 0.5, "VBUS"), ("2", 0.5, 0, 0.5, 0.5, "GND")], value="10uF"),
                          part("R1", (104, 134), [("1", -0.5, 0, 0.5, 0.5, "FB"), ("2", 0.5, 0, 0.5, 0.5, "+3V3")], value="100k"),
                          part("J1", (145, 105), [("1", 0, 0, 0.8, 0.8, "USB_D+"), ("2", 0, 1.5, 0.8, 0.8, "VBUS"), ("3", 0, 3, 0.8, 0.8, "GND")], value="USB_C", lib="Connector_USB:USB_C_Receptacle"),
                          part("D1", (110, 104), [("1", -0.5, 0, 0.5, 0.5, "USB_D+"), ("2", 0.5, 0, 0.5, 0.5, "GND")], value="ESD5V0", lib="Diode_SMD:D_SOD-523"))
        plan = board.plan()
        near = plan["place"]["near"]
        self.assertEqual({r: near.get(r) for r in ("C1", "C5", "Y1", "C2", "L1", "L2", "C4", "R1", "D1")},
                         {"C1": "L2", "C5": "U1", "Y1": "U1", "C2": "Y1", "L1": "AE1", "L2": "U2", "C4": "U2", "R1": "U2", "D1": "J1"})
        self.assertEqual(plan["place"]["edges"], {"AE1": "top"})
        self.assertIn(["AE1", "L2"], plan["apart"])                      # the converter's inductor away from the antenna
        self.assertEqual(plan["route"]["kinds"], {"ANT": "rf", "RF": "rf"})
        self.assertEqual(plan["route"]["widths"]["+3V3"], 0.5)
        self.assertTrue(any("50 ohm" in n for n in plan["notes"]))       # two layers cannot give a practical 50 ohm track
        self.assertTrue(any("Four layers" in n for n in plan["notes"]))
        self.assertIn("input capacitor", plan["why"]["C4"])
        self.assertEqual(plan["radio_ghz"], 2.45)
        # after placement: the antenna on the top edge gets its clear area before a track exists
        board.place("AE1", (125, 102.5))
        got = board.prepare()["antennas"]["AE1"]
        self.assertAlmostEqual(got["keepout"][1], 100, delta=0.05)                          # run out to the board edge
        self.assertGreaterEqual(got["vias"], 5)
        fin = board.finish(stitch=None)
        self.assertEqual(fin["antennas"]["AE1"]["keepout"], None)
        self.assertNotIn("antenna.fence", self.failed(board.review()))

    def test_the_sums(self):
        c = kh.calc
        self.assertAlmostEqual(c.wavelength(2.45e9, er=1), 122.4, delta=0.2)
        self.assertAlmostEqual(c.via_pitch(2.45e9), 2.92, delta=0.05)          # a twentieth of a wavelength in FR-4
        self.assertGreater(c.via_pitch(915e6), 7)
        self.assertAlmostEqual(c.quarter_wave(868e6), 86.3, delta=0.3)
        self.assertAlmostEqual(c.critical_length(1.0), 27.5, delta=1)
        self.assertAlmostEqual(c.track_width(1.0), 0.30, delta=0.02)           # 1 A, 10 K, 1 oz, outer layer
        self.assertAlmostEqual(c.track_current(c.track_width(3.0, internal=True), internal=True), 3.0, delta=0.01)
        self.assertGreater(c.track_width(1.0, internal=True), 2 * c.track_width(1.0))
        self.assertGreaterEqual(c.vias_for(3.0), 3)
        self.assertEqual([c.spacing(12), c.spacing(48), c.spacing(325), c.spacing(325, "inner"), c.spacing(600, "bare")], [0.075, 0.3, 1.6, 0.25, 3.0])
        self.assertAlmostEqual(c.microstrip(c.width_for(50, 0.2), 0.2), 50, delta=0.2)
        self.assertAlmostEqual(c.width_for(50, 0.2), 0.36, delta=0.04)         # the usual four-layer answer
        self.assertLess(c.pair(0.2, 0.15, 0.2), 2 * c.microstrip(0.2, 0.2))
        self.assertEqual(c.i2c_pullup(3.3, 100, 400)["min"], 967)
        self.assertEqual(c.interface("USB 2.0")["pair_impedance"], 90)
        self.assertEqual(c.interface("ddr5")["bus_skew_mm"], 0.13)
        self.assertIn("ddr1", c.interface())
        with self.assertRaises(kh.HarnessError):
            c.interface("firewire800x")

    def test_the_interface_rules_are_the_engines(self):
        board = self.open(edge((100, 100, 120, 120)))
        eng = board._call("review_design", plan={"what": "interfaces"})["interfaces"]
        self.assertEqual(set(eng), set(kh.physics.INTERFACES))
        for name, r in kh.physics.INTERFACES.items():
            self.assertEqual((r["impedance"], r["pair_impedance"], r["skew_mm"], r["bus_skew_mm"], r["max_mm"], r["max_vias"]),
                             (eng[name]["z"], eng[name]["zd"], eng[name]["skew"], eng[name]["bus"], eng[name]["max"], eng[name]["vias"]), name)


if __name__ == "__main__":
    unittest.main()
