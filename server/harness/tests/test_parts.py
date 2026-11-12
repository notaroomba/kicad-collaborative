"""Parts: land patterns, symbols, package names and the datasheet text readers (no engine needed)."""
import importlib
import unittest

from kicad_harness import parts

fpgen = importlib.import_module("kicad_harness.parts.footprint")
symgen = importlib.import_module("kicad_harness.parts.symbol")
ds = importlib.import_module("kicad_harness.parts.datasheet")
search = importlib.import_module("kicad_harness.parts.search")


class Footprints(unittest.TestCase):
    def test_soic8_matches_the_ipc_land_pattern(self):
        fp = fpgen.dual("SOIC-8", 8, 1.27, (5.8, 6.2), (0.4, 1.27), (0.31, 0.51), ((3.8, 4.0), (4.8, 5.0)))
        self.assertEqual(len(fp.pads), 8)
        p1, p8 = fp.pads[0], fp.pads[7]
        self.assertAlmostEqual(p1["x"], -p8["x"], places=3)
        self.assertAlmostEqual(p1["y"], p8["y"], places=3)
        self.assertTrue(2.4 < abs(p1["x"]) < 2.9, p1)          # KiCad's SOIC-8 has its pads at 2.475
        self.assertTrue(1.3 < p1["w"] < 2.1 and 0.5 < p1["h"] < 0.7, p1)
        text = fp.sexpr()
        self.assertIn('(footprint "SOIC-8"', text)
        self.assertIn("F.CrtYd", text)
        self.assertEqual(text.count("(pad "), 8)

    def test_qfn_has_four_sides_and_an_exposed_pad(self):
        fp = fpgen.nolead("QFN-32", 32, 0.5, (5, 5), 0.4, 0.25, ep=(3.1, 3.1))
        self.assertEqual(len(fp.pads), 33)
        left = [p for p in fp.pads[:32] if p["x"] < -2]
        self.assertEqual(len(left), 8)
        self.assertEqual(fp.pads[32]["number"], "33")
        self.assertEqual(fp.notes, [])

    def test_two_sided_package_is_turned_when_the_exposed_pad_only_fits_that_way(self):
        given = fpgen.nolead("WSON-8_6x5mm", 8, 1.27, (6, 5), 0.6, 0.4, ep=(3.4, 4.3))
        turned = fpgen.nolead("WSON-8_5x6mm", 8, 1.27, (5, 6), 0.6, 0.4, ep=(4.3, 3.4))
        self.assertEqual([(p["x"], p["y"]) for p in given.pads], [(p["x"], p["y"]) for p in turned.pads])
        self.assertEqual((turned.pads[8]["w"], turned.pads[8]["h"]), (3.4, 4.3))
        self.assertEqual(turned.name, "WSON-8_6x5mm")
        self.assertEqual(given.notes, [])

    def test_standard_packages_by_name(self):
        for name, pads in (("SOT-23-5", 5), ("SOIC-8", 8), ("0603", 2), ("TSSOP-16", 16), ("QFN-24", 25)):
            try:
                fp, how = parts.footprint(name, **({"ep": (2.6, 2.6), "pitch": 0.5, "body": (4, 4)} if name == "QFN-24" else {}))
            except ValueError as e:
                self.fail(f"{name}: {e}")
            self.assertEqual(len(fp.pads), pads, name)
            self.assertTrue(how)


class Symbols(unittest.TestCase):
    def test_pins_are_sorted_to_their_sides_and_named_the_kicad_way(self):
        text, facts = symgen.symbol("MYREG", [("1", "VIN", ""), ("2", "GND", ""), ("3", "/EN", ""), ("4", "NC", ""), ("5", "VOUT", "")], "U", "Generated:SOT-23-5")
        self.assertIn('(symbol "MYREG"', text)
        self.assertIn("~{EN}", text)
        self.assertEqual(text.count("(pin "), 5)
        self.assertEqual(symgen.guess_type("GND"), "power_in")
        self.assertEqual(symgen.kicad_name("/CS"), "~{CS}")

    def test_a_part_reports_what_is_missing(self):
        p = parts.make("X1", pins=[(1, "A"), (2, "B")])
        self.assertTrue(any(m.startswith("package") for m in p.report["missing"]))
        p.fix(package="SOT-23")
        self.assertTrue(any("no pad" in m for m in p.report["missing"]) or p.report["missing"] == [] or len(p.fp.pads) == 3)
        q = parts.make("MYREG", package="SOT-23-5", pins=[(1, "VIN"), (2, "GND"), (3, "EN"), (4, "NC"), (5, "VOUT")])
        self.assertEqual(q.report["missing"], [])
        self.assertEqual(q.footprint_id, "Generated:SOT-23-5")
        self.assertIn("Footprint", q.fields())


class DatasheetText(unittest.TestCase):
    def test_package_names(self):
        found = {(p["family"], p["pins"]) for p in ds.packages("Available in 8-pin SOIC 208-mil, 8-pad WSON 6x5-mm and SOT-23-5 packages. Also QFN-32 (5 mm x 5 mm).")}
        self.assertIn(("SOIC", 8), found)
        self.assertIn(("SOT-23", 5), found)
        self.assertIn(("QFN", 32), found)
        self.assertFalse(any(n == 208 for _, n in found))

    def test_pin_table(self):
        page = "PIN DESCRIPTION\nPIN NO.  PIN NAME  I/O  FUNCTION\n1  /CS  I  Chip Select Input\n2  DO  O  Data Output\n3  /WP  I  Write Protect\n4  GND    Ground\n5  DI  I  Data Input\n6  CLK  I  Serial Clock\n7  /HOLD  I  Hold Input\n8  VCC    Power Supply\n"
        tables = ds.pin_tables([page])
        self.assertTrue(tables)
        pins = tables[0].pins(0)
        self.assertEqual([p[0] for p in pins], [str(i) for i in range(1, 9)])
        self.assertEqual(pins[3][1], "GND")

    def test_dimension_table(self):
        page = "8-Pin SOIC 150-mil\nSYMBOL  MIN  NOM  MAX\nA  1.35  1.60  1.75\nA1  0.10  0.15  0.25\nb  0.33  0.41  0.51\nD  4.80  4.90  5.00\nE  5.80  6.00  6.20\nE1  3.80  3.90  4.00\ne  1.27 BSC\nL  0.40  0.71  1.27\n"
        tables = ds.dim_tables([page])
        self.assertTrue(tables)
        t = tables[0]
        self.assertAlmostEqual(t.nom("D"), 4.9)
        self.assertAlmostEqual(t.nom("e"), 1.27)


class Search(unittest.TestCase):
    def test_maker_is_recognised_from_the_part_number(self):
        self.assertEqual(search.maker("TPS54331DR"), "ti")
        self.assertEqual(search.maker("LTC3780EG"), "adi")
        self.assertEqual(search.maker("AD8232ACPZ"), "adi")
        self.assertEqual(search.ti("TPS54331DR", check=False)["id"], "TPS54331")
        self.assertIn("ti.com", search.ti("LM358", check=False)["datasheet"])
        self.assertIn("analog.com", search.adi("ADXL345BCCZ", check=False)["url"])


if __name__ == "__main__":
    unittest.main()
