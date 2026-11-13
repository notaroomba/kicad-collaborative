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

    def test_a_pour_connects_only_once_it_is_filled(self):
        p = self.project
        sch = p.schematic()
        sch.build({"R1": {"lib": "Device:R", "value": "1k", "footprint": "Resistor_SMD:R_0603_1608Metric"},
                   "R2": {"lib": "Device:R", "value": "1k", "footprint": "Resistor_SMD:R_0603_1608Metric"},
                   "C1": {"lib": "Device:C", "value": "1uF", "footprint": "Capacitor_SMD:C_0603_1608Metric"}},
                  {"GND": ["R1.2", "R2.2", "C1.2"], "SIG": ["R1.1", "R2.1", "C1.1"]}, labels=["SIG"])   # keep the name on the sheet for the board
        board = p.board()
        board.sync()
        board.outline(100, 100, 120, 112)
        board.autoplace(outline=(100, 100, 120, 112))
        board.zone("GND", layer="F.Cu", connect="solid")
        self.assertEqual(board.unrouted().get("GND"), 2)          # an unfilled zone joins nothing, as in KiCad
        filled = board.fill()
        self.assertEqual(filled["zones"], 1)
        self.assertNotIn("GND", filled.get("unconnected_by_net") or {})
        self.assertEqual(board.fill()["refilled"], 0)             # nothing moved: nothing to refill
        routed = board.route(widths={"SIG": 0.3}, time_s=10)      # the schematic's name for the board net "/SIG"
        self.assertEqual(routed["left"], {})
        self.assertEqual(routed["zones_filled"], 1)
        self.assertEqual(board.unrouted(), {})
        self.assertEqual(board.check()["errors"], 0)
        self.assertGreater(board.unroute("SIG"), 0)               # taken up again, and only that net
        self.assertEqual(board.unrouted(), {"/SIG": 2})
        self.assertEqual(board.route(nets=["SIG"], time_s=10, max_vias=2)["left"], {})

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

    def _sheet(self, **more):
        R, C = "Resistor_SMD:R_0402_1005Metric", "Capacitor_SMD:C_0402_1005Metric"
        parts = {"U1": {"lib": "Timer:NE555D", "footprint": "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm"},
                 "R1": {"lib": "Device:R", "value": "10k", "footprint": R}, "R2": {"lib": "Device:R", "value": "47k", "footprint": R},
                 "C1": {"lib": "Device:C", "value": "10uF", "footprint": C}, "C2": {"lib": "Device:C", "value": "100nF", "footprint": C},
                 "D1": {"lib": "Device:LED", "footprint": "LED_SMD:LED_0603_1608Metric"}, "R3": {"lib": "Device:R", "value": "330", "footprint": R},
                 "J1": {"lib": "Connector_Generic:Conn_01x02", "footprint": "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical"}}
        nets = {"+5V": ["U1.VCC", "U1.RST", "R1.1", "C2.1", "J1.1"], "GND": ["U1.GND", "C1.2", "C2.2", "R3.2", "J1.2"],
                "DISCH": ["U1.DISCH", "R1.2", "R2.1"], "THRES": ["U1.THRES", "U1.TRIG", "R2.2", "C1.1"], "OUT": ["U1.OUT", "D1.2"], "LED_K": ["D1.1", "R3.1"]}
        groups = {"Power input": ["J1", "C2"], "Timer": ["U1", "R1", "R2", "C1"], "Indicator": ["D1", "R3"]}
        sch = self.project.schematic()
        return sch, sch.build(parts, nets, groups, no_connect=["U1.CONT"], **more)

    def _wired(self, sch):
        """A net of the fixture that build() drew as a wire inside its block, so no label carries its name: (name, a pin, another pin)."""
        have = sch.nets()
        for name, pin, other in (("DISCH", "U1.7", "R1.2"), ("THRES", "U1.6", "R2.2"), ("LED_K", "D1.1", "R3.1")):
            if name not in have:
                return name, pin, other
        self.fail("no net of the fixture was wired inside its block")

    def test_groups_are_framed_sections_with_titles_and_notes_and_nothing_overlaps(self):
        sch, built = self._sheet(notes={"Indicator": "R3 is 330 ohm for 10 mA: the LED is read in daylight.", "Timer": ["C1 is 10 uF, not the usual 1 uF, for a 1 Hz blink."]})
        self.assertEqual(built["problems"], [])
        self.assertEqual(built["sections"], 3)
        self.assertEqual(built["overlaps"], 0, built.get("overlap_list"))
        self.assertEqual(sch.overlaps(), [])
        self.assertEqual(sch.unconnected(), [])
        self.assertEqual(sch.check()["errors"], 0)
        self.project.save()
        with open(os.path.join(self.dir, "blinky.kicad_sch"), encoding="utf-8") as f:
            text = f.read()
        secs = {s["title"]: s["parts"] for s in sch.sections()}
        self.assertEqual(secs, {"Power input": ["C2", "J1"], "Timer": ["C1", "R1", "R2", "U1"], "Indicator": ["D1", "R3"]})
        for title in ("Power input", "Timer", "Indicator"):
            self.assertIn(f'(text "{title}"', text)
        self.assertIn("Note: R3 is 330 ohm", text)
        self.assertIn("for a 1 Hz blink", text)
        lay = sch.layout()
        area = lay["drawing_area"]
        self.assertTrue(area[0] <= lay["extent"][0] and lay["extent"][2] <= area[2] and lay["extent"][3] <= area[3], lay)

    def test_tidy_keeps_a_built_sheet_and_clear_empties_sheet_and_board(self):
        sch, built = self._sheet()
        self.project.save()
        path = os.path.join(self.dir, "blinky.kicad_sch")
        with open(path, encoding="utf-8") as f:
            before = f.read()
        sch.title("Blinker (V1)", rev="V1")
        self.project.save()
        with open(path, encoding="utf-8") as f:
            before = f.read()
        self.assertIn('(title "Blinker (V1)")', before)
        self.assertIn('(rev "V1")', before)
        self.assertEqual(sch.overlaps(), [])
        self.assertEqual(sch.tidy()["overlaps"], 0)      # nothing is drawn over anything, so tidy moves nothing
        self.project.save()
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), before)
        board = self.project.board()
        board.outline(0, 0, 50, 40)
        board.sync()
        board.flush()
        self.assertGreater(len(board.parts()), 0)
        self.assertEqual(board.sync()["added"], 0)       # nothing to bring over is a result, not an error
        sch.page("A2")
        self.assertEqual(board.clear(), len(built and sch.parts()))
        self.assertEqual(board.parts(), [])
        self.assertEqual(board._call("get_items", kinds=["gr_rect", "gr_line", "gr_poly"])["count"] > 0, True)   # the outline stays
        self.assertGreater(sch.clear(), 0)
        self.assertEqual(sch.parts(), [])
        self.assertIsNone(sch.layout(limit=1).get("extent"))
        again = self._sheet()[1]                          # a cleared sheet is built on the smallest page again
        self.assertEqual(again["page"], built["page"])
        self.assertEqual(again["overlaps"], 0)

    def test_a_later_script_finds_an_unlabelled_net_by_the_name_the_sheet_was_built_with(self):
        sch, built = self._sheet()
        self.assertEqual(built["problems"], [])
        name, pin, other = self._wired(sch)                         # wired inside its block: no label carries the name
        board = self.project.board()
        board.outline(100, 100, 130, 125)
        board.sync()
        self.project.save()
        self.project.close()
        self.project = kh.open(self.dir)                             # another script, another day
        board = self.project.board()
        self.assertEqual(self.project.net_pins, {})
        real = board._net(name)
        self.assertNotEqual(real, name)
        self.assertEqual(real, board.pad(pin)["net"])
        self.assertEqual(sorted(p for p in board.nets()[real]["pads"]), sorted(board.nets()[board.pad(other)["net"]]["pads"]))
        self.assertEqual(self.project.schematic().pin_names("Timer:NE555D")["7"].split(" ")[0], "DISCH")

    def test_a_redrawn_sheet_keeps_a_routed_board_routed(self):
        sch, built = self._sheet()
        board = self.project.board()
        board.outline(100, 100, 135, 130)
        board.sync()
        board.autoplace(outline=(100, 100, 135, 130))
        routed = board.route(time_s=20)
        self.assertEqual(routed["routed"], routed["connections"])
        before = board.check()["errors"]
        tracks = board.info()["track_length_mm"]
        pin = self._wired(sch)[1]
        old = board.pad(pin)["net"]
        sch.clear()
        self._sheet(labels=["DISCH", "THRES", "LED_K"])                 # the same circuit drawn again, with other net names
        res = board.sync()
        self.assertEqual(res["added"], 0)
        self.assertIn(old, res.get("nets_renamed", {}))
        self.assertNotEqual(board.pad(pin)["net"], old)
        self.assertEqual(board.unrouted(), {})
        self.assertEqual(board.check()["errors"], before)
        self.assertEqual(board.info()["track_length_mm"], tracks)

    def test_fit_page_picks_the_smallest_paper_and_moves_the_drawing_onto_it(self):
        sch, built = self._sheet()
        nets = sch.nets()
        sch.page("A1")
        sch._edit({"op": "move_region", "x0": 0, "y0": 0, "x1": 841, "y1": 594, "dx": 300 * 1.27, "dy": 200 * 1.27})   # far corner of a big page
        sch.flush()
        fit = sch.fit_page()
        self.assertEqual((fit["paper"], fit["was"], fit["fits"]), (built["page"], "A1", True))
        lay = sch.layout(limit=1)
        self.assertEqual((lay["paper"], lay["count"]), (built["page"], 0))
        area, ext = lay["drawing_area"], lay["extent"]
        self.assertLess(abs((ext[0] - area[0]) - (area[2] - ext[2])), 2.6)      # in the middle, left to right
        self.assertEqual(sch.nets(), nets)                                       # moved as one piece: nothing came apart
        self.assertEqual(sch.fit_page()["moved"], [0.0, 0.0])                    # already fitted: nothing moves
        # a drawing a little too wide for A3 gets a page of its own size instead of a half empty A2
        ext = sch.layout(limit=1)["extent"]
        sch.text("Far out", (ext[0] + 400, ext[1] + 5))
        sch.flush()
        wide = sch.fit_page()
        self.assertEqual((wide["paper"], wide["fits"]), ("User", True))
        lay = sch.layout(limit=1)
        self.assertEqual((lay["paper"], lay["count"], lay["page"]), ("User", 0, wide["size"]))
        self.assertTrue(420 < wide["size"][0] < 594 and wide["size"][1] == 297, wide)
        self.assertEqual(sch.nets(), nets)
        self.assertEqual(sch.fit_page(custom=False)["paper"], "A2")              # standard sizes only, when asked
        self.project.save()
        with open(os.path.join(self.dir, "blinky.kicad_sch"), encoding="utf-8") as f:
            self.assertIn('(paper "A2")', f.read())
        sch.clear()
        self.assertEqual(sch.fit_page()["paper"], "A3")                         # an empty sheet is the smallest page

    def test_the_layout_check_finds_what_is_drawn_over_something_else(self):
        sch, built = self._sheet()
        self.assertEqual(built["overlaps"], 0, built.get("overlap_list"))
        x, y = [(p["x"], p["y"]) for p in sch.parts() if p["ref"] == "U1"][0]
        sch.text("In the way", (x - 4, y))                      # text across the IC
        sch.place("Device:R", at=(x, y), ref="R9")               # a part on top of it
        sch.flush()
        found = sch.overlaps()
        self.assertTrue(any(o.startswith("text over a symbol") and "In the way" in o for o in found), found)
        self.assertTrue(any(o.startswith("symbols overlap") and "R9" in o and "U1" in o for o in found), found)
        sch.remove("R9")
        sch.flush()
        self.assertFalse(any("R9" in o for o in sch.overlaps()))

    def test_a_section_and_a_note_can_be_added_to_a_sheet_that_exists(self):
        sch = self.project.schematic()
        sch.place("Device:R", at=(60.96, 60.96), ref="R1", value="4k7")
        sch.place("Device:R", at=(76.2, 60.96), ref="R2", value="4k7")
        sch.net("+3V3", "R1.1", "R2.1")
        sch.net("SDA", "R1.2")
        sch.net("SCL", "R2.2")
        box = sch.section("I2C pull-ups", ["R1", "R2"], notes="4k7 because the bus is 400 kHz with three devices on it.")
        self.assertEqual(sch.overlaps(), [])
        ext = sch.layout(of=["R1", "R2"])["extent"]
        self.assertTrue(box[0] < ext[0] and box[1] < ext[1] and box[2] > ext[2] and box[3] > ext[3], (box, ext))
        at = sch.note("R2 is fitted only on the board with the display.", near="R2")
        self.assertEqual(sch.overlaps(), [])
        self.assertTrue(abs(at[0] - 76.2) < 60 and abs(at[1] - 60.96) < 60, at)

    def test_a_design_too_large_for_the_page_gets_a_larger_page(self):
        sch = self.project.schematic()
        parts, nets, groups = {}, {}, {}
        for b in range(6):
            refs = []
            for i in range(10):
                r = f"R{b * 10 + i + 1}"
                parts[r] = {"lib": "Device:R", "value": "1k", "footprint": "Resistor_SMD:R_0402_1005Metric"}
                nets.setdefault(f"BUS{b}_{i}", []).append(r + ".1")
                nets.setdefault("GND", []).append(r + ".2")
                refs.append(r)
            groups[f"Bank {b + 1}"] = refs
        built = sch.build(parts, nets, groups)
        self.assertEqual(built["overlaps"], 0, built.get("overlap_list"))
        self.assertIn(built["page"], ("A3", "A2"))
        self.project.save()
        with open(os.path.join(self.dir, "blinky.kicad_sch"), encoding="utf-8") as f:
            self.assertIn(f'(paper "{built["page"]}")', f.read())

    def test_signal_domains_ground_vias_and_keepouts(self):
        p = self.project
        sch = p.schematic()
        r = {"lib": "Device:R", "value": "1k", "footprint": "Resistor_SMD:R_0603_1608Metric"}
        sch.build({"R1": r, "R2": r, "R3": r, "R4": r},
                  {"GND": ["R1.2", "R2.2", "R3.2", "R4.2"], "ANT": ["R1.1", "R2.1"], "TEMP_OUT": ["R3.1", "R4.1"]},
                  labels=["TEMP_OUT"])     # ANT is wired inside its block and has no label: the router still learns its name
        board = p.board()
        board.sync()
        board.outline(100, 100, 130, 120)
        for ref, at in {"R1": (105, 105), "R2": (125, 105), "R3": (105, 112), "R4": (125, 112)}.items():
            board.move(ref, at)
        board.zone("GND", layer="F.Cu", connect="solid")
        board.zone("GND", layer="B.Cu", connect="solid")
        board.keepout([112, 114, 118, 119], name="no copper here")
        routed = board.route(kinds={"TEMP_OUT": "analog"}, fence={"spacing": 2.5}, time_s=15)
        self.assertEqual(routed["left"], {}, routed)
        ant = board.pad("R1.1")["net"]
        self.assertTrue(ant.startswith("Net-("), ant)
        self.assertEqual(routed["domains"]["kept_apart"], {ant: "rf", "/TEMP_OUT": "analog"})
        fence = next(f for f in routed["ground_vias"] if f["net"] == ant)
        self.assertGreaterEqual(fence["fence"], 8, routed)          # a 20 mm run, both sides, every 2.5 mm
        self.assertEqual(fence["ground"], "GND")
        self.assertEqual(board.check()["errors"], 0)
        off = board.route(nets=["ANT"], separate=False, fence=False)   # both can be turned off; nothing left to route here
        self.assertEqual(off["routed"], 0)
        p.save()
        with open(os.path.join(self.dir, "blinky.kicad_pcb"), encoding="utf-8") as f:
            text = f.read()
        self.assertIn("(keepout", text)
        self.assertIn("(copperpour not_allowed)", text)
        with self.assertRaises(Exception):
            board.route(kinds={"TEMP_OUT": "loud"})

    def test_four_layers_plain_net_names_and_a_blocked_net_is_a_result(self):
        sch, built = self._sheet()
        board = self.project.board()
        board.sync()
        board.outline(100, 100, 130, 125)
        board.layers(4, planes=["In1.Cu"])
        self.assertEqual(board.info()["copper_layers"], ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"])
        board.zone("GND", layer="In1.Cu")
        board.autoplace(outline=(100, 100, 130, 125))
        self.assertTrue(any("THRES" in n for n in board.nets()))     # TRIG and THRES are tied at the chip now, so KiCad names the net after a pin
        routed = board.route(order=["THRES"], widths={"+5V": 0.4}, time_s=20)   # the schematic's names, without the slash
        self.assertEqual(routed["left"], {}, routed)
        self.assertEqual(board.check(kind="unconnected_items")["first"], [])
        again = board.route(nets=["THRES"])                                     # nothing left: a result, not an exception
        self.assertEqual(again["routed"], 0)
        self.project.save()
        with open(os.path.join(self.dir, "blinky.kicad_pcb"), encoding="utf-8") as f:
            self.assertIn('"In2.Cu"', f.read())

    def test_a_wrong_call_says_what_is_wrong(self):
        sch = self.project.schematic()
        with self.assertRaises(kh.HarnessError) as e:
            sch.pin("U9.1")
        self.assertIn("U9", str(e.exception))


if __name__ == "__main__":
    unittest.main()
