"""Parts made without a model: symbols and footprints from datasheets and package dimensions.

    from kicad_harness import parts
    part = parts.from_datasheet("W25Q64JV.pdf", name="W25Q64JV", package="SOIC-8")
    print(part.report)            # what was read, from which page, and what is missing
    ref = sch.place(part)         # symbol on the sheet; its footprint follows on board.sync()

    part = parts.make("MYCHIP", pins=[(1, "VIN"), (2, "GND"), (3, "EN"), (4, "FB"), (5, "SW")], package="SOT-23-5")

The order of trust: KiCad's own library footprint when the package is a standard one, then the
datasheet's dimension table through the IPC-7351 calculators, then JEDEC standard dimensions.
`part.report["missing"]` lists the few things that could not be read; `part.fix(...)` fills them in.
"""
from __future__ import annotations

import hashlib
import json
import os
import re

from . import datasheet as ds
from . import footprint as fpgen
from . import symbol as symgen
from ..transport import HarnessError
from .search import find, lookup  # noqa: F401

__all__ = ["Part", "make", "from_datasheet", "footprint", "find", "lookup"]

# JEDEC standard dimensions, used when a datasheet's own drawing was not read: span, lead length, lead width, body width
_STD_DUAL = {
    ("SOIC", 1.27, "narrow"): ((5.8, 6.2), (0.4, 1.27), (0.31, 0.51), 3.9),
    ("SOIC", 1.27, "wide"): ((10.0, 10.65), (0.4, 1.27), (0.31, 0.51), 7.5),
    ("TSSOP", 0.65, ""): ((6.2, 6.6), (0.45, 0.75), (0.19, 0.30), 4.4),
    ("TSSOP", 0.5, ""): ((6.2, 6.6), (0.45, 0.75), (0.17, 0.27), 4.4),
    ("MSOP", 0.65, ""): ((4.75, 5.05), (0.4, 0.8), (0.22, 0.38), 3.0),
    ("MSOP", 0.5, ""): ((4.75, 5.05), (0.4, 0.8), (0.17, 0.27), 3.0),
    ("SSOP", 0.65, ""): ((7.4, 8.2), (0.55, 0.95), (0.22, 0.38), 5.3),
}
_STD_SOT = {  # pins: pitch, span, lead length, lead width, body
    3: (0.95, (2.1, 2.64), (0.3, 0.6), (0.3, 0.5), (1.3, 2.9)), 5: (0.95, (2.6, 3.0), (0.3, 0.6), (0.3, 0.5), (1.6, 2.9)),
    6: (0.95, (2.6, 3.0), (0.3, 0.6), (0.3, 0.5), (1.6, 2.9)), 8: (0.65, (2.6, 3.0), (0.3, 0.6), (0.22, 0.38), (1.6, 2.9)),
}
_STD_LEAD = {0.35: (0.12, 0.22), 0.4: (0.15, 0.25), 0.5: (0.18, 0.30), 0.65: (0.25, 0.35), 0.8: (0.25, 0.40), 0.95: (0.3, 0.5), 1.0: (0.35, 0.5), 1.27: (0.35, 0.48)}


def _fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _parse_package(text: str) -> dict:
    """"QFN-56", "SOIC-8", "TSSOP-20", "SOT-23-5", "LQFP-48 7x7", "0603": family, pins and body when written."""
    t = text.strip()
    if re.fullmatch(r"\d{4}", t) and t in fpgen.CHIP:
        return {"family": "CHIP", "pins": 2, "code": t}
    body = None
    m = re.search(r"(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)", t)
    if m:
        body = (float(m.group(1)), float(m.group(2)))
        t = t[:m.start()] + t[m.end():]
    got = ds.packages(t + " ")
    if not got:
        m = re.match(r"^\s*([A-Za-z]+)[- ]?(\d+)", t)
        if not m:
            raise ValueError(f'package "{text}" is not understood; write it like QFN-32, SOIC-8, TSSOP-20, SOT-23-5, LQFP-48 or BGA-64')
        return {"family": m.group(1).upper(), "pins": int(m.group(2)), "body": body}
    p = dict(got[0])
    p["body"] = body or p.get("body")
    return p


def footprint(package: str, pitch: float | None = None, body=None, ep=None, dims: dict | None = None, density: str = "N", name: str | None = None,
              span=None, lead_len=None, lead_width=None, ball: float | None = None, grid: tuple | None = None, wide: bool = False):
    """A footprint for a package from its dimensions, through the IPC-7351 calculators.

    package: "QFN-32", "DFN-8", "SOIC-8", "TSSOP-20", "MSOP-10", "SOT-23-5", "LQFP-48", "BGA-64", "DIP-8", "0603".
    dims: a datasheet's symbols when you have them ({"e": 0.5, "b": (0.18, 0.30), "L": (0.3, 0.5), "D": 5, "E": 5,
    "D2": 3.4, "E2": 3.4}); otherwise pitch, body=(w, l), ep=(w, h).  Returns (Footprint, how its numbers were chosen).
    """
    p = _parse_package(package)
    fam, n = p["family"], p["pins"]
    d = dims if isinstance(dims, ds.DimTable) else _table(dims or {})
    body = body or p.get("body")
    used = []
    pitch = pitch or d.nom("e")
    if fam == "CHIP":
        return fpgen.chip(p["code"], density=density, name=name), "chip size table"
    if fam in ("QFN", "DFN"):
        bw = d.rng("E") or (body and (body[0], body[0]) if fam == "QFN" else body and (min(body), min(body)))
        bl = d.rng("D") or (body and (body[-1], body[-1]) if fam == "QFN" else body and (max(body), max(body)))
        if fam == "DFN" and body and not d.rng("E"):
            # the rows run along the side the terminals fit on
            bw, bl = ((body[1],) * 2, (body[0],) * 2) if pitch and (n // 2 - 1) * pitch + 0.3 > body[1] else ((body[0],) * 2, (body[1],) * 2) if pitch and (n // 2 - 1) * pitch + 0.3 > body[0] else (bw, bl)
        if not (bw and bl):
            raise ValueError(f"{package} needs its body size: body=(width, length) in mm, or the D and E dimensions")
        sides = 4 if fam == "QFN" else 2
        if not pitch:
            per = n // sides
            along = sum(bl) / 2
            pitch = next((q for q in (1.27, 0.95, 0.8, 0.65, 0.5, 0.4, 0.35) if (per - 1) * q + 0.5 <= along - (0.6 if sides == 4 else 0)), 0.4)
            used.append(f"pitch {pitch} chosen to fit {per} terminals on {along} mm")
        ll = d.rng("L") or (0.3, 0.5) if pitch < 0.9 else d.rng("L") or (0.4, 0.6)
        lw = d.rng("b") or _STD_LEAD.get(pitch, (pitch * 0.4, pitch * 0.6))
        if ep is None and d.nom("D2") and d.nom("E2"):
            ep = (d.nom("E2"), d.nom("D2"))
        nm = name or f"{fam}-{n}{'-1EP' if ep else ''}_{_fmt(sum(bw) / 2)}x{_fmt(sum(bl) / 2)}mm_P{_fmt(pitch)}mm" + (f"_EP{_fmt(ep[0])}x{_fmt(ep[1])}mm" if ep else "")
        if not (d.rng("L") and d.rng("b")):
            used.append("typical terminal size for this pitch")
        return fpgen.nolead(nm, n, pitch, (bw, bl), ll, lw, density, ep=ep, sides=sides), "; ".join(used)
    if fam in ("SOIC", "TSSOP", "MSOP", "SSOP"):
        default_pitch = {"SOIC": 1.27, "TSSOP": 0.65, "MSOP": 0.65 if n <= 8 else 0.5, "SSOP": 0.65}[fam]
        pitch = pitch or default_pitch
        cands = [x for x in (d.rng("E"), d.rng("H"), d.rng("HE")) if x]
        sp = span or (max(cands, key=lambda x: x[1]) if cands else None)
        inner = [x for x in (d.rng("E1"), d.rng("E")) if x and sp and x[1] < sp[0]]
        bw = (body[0] if body else None) or (sum(inner[0]) / 2 if inner else None)
        bl = (body[1] if body else None) or d.nom("D")
        std = _STD_DUAL.get((fam, pitch, ("wide" if wide or (bw and bw > 6) or n > 16 else "narrow") if fam == "SOIC" else ""))
        if not sp or (inner == [] and not span and not d.rng("H", "HE") and d.rng("E") and not d.rng("E1")):
            if not std:
                raise ValueError(f"{package} at pitch {pitch} has no standard dimensions here; give span, lead_len, lead_width and body")
            sp = span or std[0]
            used.append("JEDEC standard span")
        ll = lead_len or d.rng("L") or (std[1] if std else (0.4, 0.8))
        lw = lead_width or d.rng("b") or (std[2] if std else _STD_LEAD.get(pitch))
        bw = bw or (std[3] if std else sum(sp) / 2 - 2)
        bl = bl or round((n // 2 - 1) * pitch + (1.1 if pitch >= 1 else 0.8), 2)
        nm = name or f"{fam}-{n}{'-1EP' if ep else ''}_{_fmt(bw)}x{_fmt(bl)}mm_P{_fmt(pitch)}mm"
        if ep is None and d.nom("D2") and d.nom("E2"):
            ep = (d.nom("E2"), d.nom("D2"))
        if not (d.rng("L") and d.rng("b")):
            used.append("JEDEC standard lead dimensions")
        return fpgen.dual(nm, n, pitch, sp, ll, lw, (bw, bl), density, ep=ep), "; ".join(used)
    if fam == "QFP":
        pitch = pitch or (0.5 if n >= 48 else 0.8)
        b = body[0] if body else d.nom("D1", "E1") or {32: 7, 44: 10, 48: 7, 64: 10, 80: 12, 100: 14, 144: 20}.get(n)
        if not b:
            raise ValueError(f"{package} needs its body size: body=(w, l)")
        sp = span or d.rng("D", "E") if (d.nom("D1") and d.nom("D") and d.nom("D") > d.nom("D1")) else span or (b + 1.8, b + 2.2)
        ll = lead_len or d.rng("L") or (0.45, 0.75)
        lw = lead_width or d.rng("b") or _STD_LEAD.get(pitch, (0.17, 0.27))
        nm = name or f"LQFP-{n}_{_fmt(b)}x{_fmt(b)}mm_P{_fmt(pitch)}mm"
        return fpgen.quad(nm, n, pitch, sp, ll, lw, b, density, ep=ep), "" if d.rng("L") and d.rng("b") else "JEDEC standard lead dimensions"
    if fam in ("SOT-23", "SC-70"):
        std = _STD_SOT.get(n)
        if not std:
            raise ValueError(f"{package}: SOT packages of 3, 5, 6 and 8 leads are known")
        pt, sp, ll, lw, bd = std
        if fam == "SC-70":
            pt, sp, ll, lw, bd = 0.65, (1.8, 2.4), (0.26, 0.46), (0.15, 0.30), (1.25, 2.0)
        nm = name or (f"SOT-23{'' if n == 3 else '-' + str(n)}" if fam == "SOT-23" else f"SC-70-{n}")
        return fpgen.sot(nm, n, pitch or pt, span or sp, lead_len or ll, lead_width or lw, body or bd, density=density), "JEDEC standard dimensions"
    if fam == "BGA":
        pitch = pitch or 0.8
        if not grid:
            side = round(n ** 0.5)
            grid = (side, side) if side * side == n else None
        if not grid:
            raise ValueError(f"{package} needs its grid: grid=(columns, rows)")
        ball = ball or d.nom("b") or (0.5 if pitch >= 1 else 0.4 if pitch >= 0.8 else 0.3 if pitch >= 0.5 else 0.25)
        b = body or (d.nom("D") or (grid[0] + 1) * pitch, d.nom("E") or (grid[1] + 1) * pitch)
        return fpgen.bga(name or f"BGA-{n}_{_fmt(b[0])}x{_fmt(b[1])}mm_P{_fmt(pitch)}mm", grid[0], grid[1], pitch, ball, b), "ball land reduced per IPC-7351"
    if fam == "DIP":
        return fpgen.tht_dual(name or f"DIP-{n}_W7.62mm", n, pitch or 2.54, 7.62 if n <= 20 else 15.24), "JEDEC standard dimensions"
    raise ValueError(f'package family "{fam}" has no generator; use a KiCad library footprint or give pads directly')


def _table(dims: dict) -> ds.DimTable:
    t = ds.DimTable(0, "")
    for k, v in dims.items():
        if isinstance(v, (int, float)):
            t.dims[k] = (None, float(v), None)
        elif len(v) == 2:
            t.dims[k] = (float(v[0]), None, float(v[1]))
        else:
            t.dims[k] = tuple(v)
    return t


def library_candidates(fp: fpgen.Footprint, fam: str) -> list:
    """Where KiCad's own library would keep this footprint, by its naming convention."""
    lib = {"QFN": "Package_DFN_QFN", "DFN": "Package_DFN_QFN", "SOIC": "Package_SO", "TSSOP": "Package_SO", "MSOP": "Package_SO", "SSOP": "Package_SO",
           "QFP": "Package_QFP", "SOT-23": "Package_TO_SOT_SMD", "SC-70": "Package_TO_SOT_SMD", "DIP": "Package_DIP", "BGA": "Package_BGA"}.get(fam)
    return [f"{lib}:{fp.name}"] if lib else []


class Part:
    """A part with its symbol and footprint, ready to place."""

    def __init__(self, name: str, pins: list, package: str | None = None, reference: str = "U", datasheet: str = "", description: str = "", **fp_args):
        self.name = re.sub(r"[^A-Za-z0-9_.+\-]", "_", name)
        self.pins = [(str(p[0]), str(p[1]) if len(p) > 1 else "", p[2] if len(p) > 2 else "") for p in pins]
        self.package, self.reference, self.datasheet, self.description = package, reference, datasheet, description
        self.fp_args = fp_args
        self.footprint_id = ""
        self.footprint = ""
        self.report: dict = {"name": self.name, "missing": []}
        self._build()

    def _build(self) -> None:
        self.report["missing"] = [m for m in self.report.get("missing", []) if not m.startswith(("footprint", "package"))]
        fp = None
        if self.package:
            try:
                fp, how = footprint(self.package, **self.fp_args)
                self.fp = fp
                self.footprint, self.footprint_id = fp.sexpr(), f"Generated:{fp.name}"
                self.report.update(package=self.package, footprint=self.footprint_id, footprint_from=self.report.get("footprint_from") or how, footprint_summary=fp.summary())
                nums = {p["number"] for p in fp.pads}
                extra = [p[0] for p in self.pins if p[0] not in nums and not re.fullmatch(r"EP|EPAD|PAD|TAB", p[0], re.I)]
                if extra:
                    self.report["missing"].append(f"footprint has no pad for pins {', '.join(extra[:12])}")
            except ValueError as e:
                self.report["missing"].append(f"footprint: {e}")
        else:
            self.report["missing"].append("package: not known; give package= (for example QFN-32, SOIC-8, SOT-23-5)")
        pins = self.pins
        if fp:   # the exposed pad takes the number the footprint gave it
            ep = str(len([p for p in fp.pads if p["number"].isdigit()]))
            pins = [((ep if re.fullmatch(r"EP|EPAD|PAD|TAB", p[0], re.I) else p[0]), p[1] if not re.fullmatch(r"Exposed|Thermal", p[1], re.I) else "EP", p[2]) for p in pins]
        self.symbol, self._facts = symgen.symbol(self.name, pins, self.reference, self.footprint_id, self.datasheet, self.description)
        self.lib_id = f"Generated:{self.name}"
        self.report["pins"] = len(pins)

    def facts(self) -> dict:
        return self._facts

    def fields(self) -> dict:
        f = {}
        if self.footprint_id:
            f["Footprint"] = self.footprint_id
        if self.datasheet:
            f["Datasheet"] = self.datasheet
        return f

    def fix(self, pins: list | None = None, package: str | None = None, **fp_args) -> "Part":
        """Fill in what could not be read: the pin list, the package, or package dimensions (pitch=, body=, ep=, dims=)."""
        if pins is not None:
            self.pins = [(str(p[0]), str(p[1]) if len(p) > 1 else "", p[2] if len(p) > 2 else "") for p in pins]
            self.report["missing"] = [m for m in self.report["missing"] if not m.startswith("pins")]
            self.report["pins_from"] = "given"
        if package:
            self.package = package
        if fp_args:
            self.fp_args.update(fp_args)
            self.report["footprint_from"] = None
        self._build()
        return self

    def use_library(self, project, footprint_id: str | None = None) -> bool:
        """Use KiCad's own library footprint when it has this package (checked by name and pad count)."""
        fam = _parse_package(self.package)["family"] if self.package else ""
        for cand in ([footprint_id] if footprint_id else library_candidates(self.fp, fam) if getattr(self, "fp", None) else []):
            try:
                got = project.transport.call("get_library_part", {"id": cand, "kind": "footprint"})
            except Exception:
                continue
            if footprint_id or got.get("pads") == len(self.fp.pads):
                self.footprint_id, self.footprint = cand, ""
                self.report.update(footprint=cand, footprint_from="KiCad library")
                self.symbol, self._facts = symgen.symbol(self.name, self._sym_pins(), self.reference, cand, self.datasheet, self.description)
                return True
        return False

    def _sym_pins(self):
        return [(p["number"], p["name"], p["type"]) for p in self._facts["units"][0]["pins"]]

    def save(self, folder: str) -> list:
        """Write the part into a project folder as KiCad libraries: Generated.kicad_sym and Generated.pretty/."""
        os.makedirs(folder, exist_ok=True)
        sym = os.path.join(folder, "Generated.kicad_sym")
        have = []
        if os.path.exists(sym):
            text = open(sym, encoding="utf-8").read()
            have = [b for b in re.split(r"(?m)^(?=\t\(symbol )", text)[1:]]
            have = [b.rstrip()[:-1].rstrip() + "\n" if b.rstrip().endswith("))") and i == len(have) - 1 else b for i, b in enumerate(have)]
            have = [b for b in have if not b.startswith(f'\t(symbol "{self.name}"')]
        with open(sym, "w", encoding="utf-8") as f:
            f.write(symgen.library(have + [self.symbol]))
        out = [sym]
        if self.footprint:
            os.makedirs(os.path.join(folder, "Generated.pretty"), exist_ok=True)
            path = os.path.join(folder, "Generated.pretty", self.footprint_id.split(":", 1)[1] + ".kicad_mod")
            with open(path, "w", encoding="utf-8") as f:
                f.write(self.footprint)
            out.append(path)
        return out

    def __repr__(self):
        return f"Part({self.name}, {len(self.pins)} pins, {self.package or 'no package'}, missing: {self.report['missing'] or 'nothing'})"


def make(name: str, pins: list, package: str | None = None, **kw) -> Part:
    """A part from a pin list ((number, name[, type]) each) and a package."""
    return Part(name, pins, package, **kw)


def _cache_dir() -> str | None:
    d = os.environ.get("KC_HARNESS_CACHE") or os.path.join(os.path.expanduser("~"), ".cache", "kicad-harness")
    try:
        os.makedirs(os.path.join(d, "parts"), exist_ok=True)
        return os.path.join(d, "parts")
    except OSError:
        return None


def _project(project=None):
    """The project given, or the one a run_python script is running for."""
    if project is not None:
        return project
    import kicad_harness
    return getattr(kicad_harness, "_current", None)


def _pages(source, project=None) -> tuple:
    """(page texts by page number, where they came from)."""
    if isinstance(source, (bytes, bytearray)) or (isinstance(source, str) and not re.match(r"^https?://", source)):
        return dict(enumerate(ds.pdf_pages(source), 1)), "file"
    if project is not None and project.transport.kind != "local" or (project is not None and getattr(project.transport, "_server", None)):
        # the server's datasheet reader has the file's pages cached for everyone: ask for the pages that matter
        pages: dict = {}
        for q in ("pin description pin name pin number function", "pin configuration pinout", "package dimensions millimeters min nom max", "package outline mechanical data"):
            try:
                r = project.transport.call("read_datasheet", {"url": source, "query": q, "max_pages": 6})
            except Exception:
                continue
            nums = [p["page"] for p in r.get("pages", [])]
            if nums:
                full = project.transport.call("read_datasheet", {"url": source, "pages": nums[:6]})
                for p in full.get("pages", []):
                    pages[p["page"]] = p.get("text", "")
        if pages:
            return pages, "server"
    import urllib.request
    req = urllib.request.Request(source, headers={"user-agent": "kicad-harness"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return dict(enumerate(ds.pdf_pages(r.read()), 1)), "download"
    except OSError as e:
        raise HarnessError(f"The datasheet at {source} could not be read ({e}). Give another address, a PDF file, or make the part with parts.make(name, pins, package).") from e


def from_datasheet(source, name: str | None = None, package: str | None = None, project=None, reference: str = "U", density: str = "N", cache: bool = True) -> Part:
    """Make a part from a datasheet: the pin table gives the symbol, the package drawing's dimensions give the footprint.

    source: a PDF path, its bytes, or its https address.  package picks one of the packages the datasheet covers
    ("SOIC-8", "WSON-8 6x5", "SOT-23-5").  The result is cached per datasheet and package, so asking again costs nothing.
    Check `part.report`: it names the pages used and lists under "missing" what has to be supplied with part.fix().
    """
    project = _project(project)
    if isinstance(source, str) and not re.match(r"^https?://", source) and not os.path.exists(source) and re.fullmatch(r"[A-Za-z0-9\-./+#]{4,40}", source.strip()) and not source.lower().endswith(".pdf"):
        # a part number: its datasheet is looked up at the maker and the distributors
        from . import search
        found = search.lookup(source.strip(), project=project)
        if not found.get("datasheet"):
            raise HarnessError(f"No datasheet was found for {source}. Give its address or a PDF file" + (f" (tried {', '.join(found['datasheet_candidates'][:3])})" if found.get("datasheet_candidates") else "") + ".")
        name = name or source.strip().upper()
        source = found["datasheet"]
    key = None
    if cache and isinstance(source, str) and _cache_dir():
        stamp = str(os.path.getmtime(source)) if os.path.exists(source) else ""
        key = os.path.join(_cache_dir(), hashlib.sha1(f"{source}|{stamp}|{package}|{name}|{density}|1".encode()).hexdigest() + ".json")
        if os.path.exists(key):
            try:
                with open(key) as f:
                    c = json.load(f)
                part = Part(c["name"], c["pins"], c["package"], reference=reference, datasheet=c["datasheet"], density=density, **c["fp_args"])
                part.report.update(c["report_extra"], cached=True)
                if project is not None:
                    part.use_library(project)
                return part
            except (ValueError, KeyError, TypeError):
                pass
    pages, origin = _pages(source, project)
    order = sorted(pages)
    texts = [pages[n] for n in order]
    real = lambda t: order[t - 1]   # a table's page index back to the datasheet's page number
    everything = "\n".join(texts)
    want = _parse_package(package) if package else None
    tables = ds.pin_tables(texts)
    report_extra: dict = {"datasheet_pages": len(order), "read_from": origin}
    missing = []
    chosen, col = None, 0
    for exact in (True, False):   # first a column whose numbered pins match the package, then one that matches with its exposed pad
        for t in tables:
            for c in range(t.columns):
                full, _ = t.complete(c)
                n = t.count(c)
                numeric = sum(1 for p in t.pins(c) if p[0].isdigit())
                if not full or numeric < 2:
                    continue
                if want and (numeric != want["pins"] if exact else n != want["pins"]):
                    continue
                if want and t.headers and len(t.headers) == t.columns and not _same_family(t.headers[c], want):
                    continue
                chosen, col = t, c
                break
            if chosen:
                break
        if chosen or not want:
            break
    pins = chosen.pins(col) if chosen else []
    if chosen:
        report_extra["pins_from"] = f"datasheet page {real(chosen.page)}" + (f", column {chosen.headers[col]}" if chosen.headers and col < len(chosen.headers) else "")
        others = sorted({t.count(c) for t in tables for c in range(t.columns) if t.complete(c)[0] and t.count(c) != len(pins) and t.count(c) >= 3})
        if others and not want:
            report_extra["other_pin_tables"] = f"the datasheet also has pin tables of {', '.join(map(str, others[:6]))} pins; pass package= to pick one"
    else:
        missing.append("pins: no complete pin table was read" + (f" for {package}" if package else "") + "; give pins=[(number, name), ...] with part.fix()")
    # the package
    pk = want
    if not pk:
        n = sum(1 for p in pins if p[0].isdigit())
        named = [p for p in ds.packages(everything) if p["pins"] == n] if n else ds.packages(everything)[:1]
        pk = named[0] if named else None
    fp_args: dict = {}
    pkg_name = None
    if pk:
        pkg_name = package or f"{pk['family']}-{pk['pins']}"
        dims = [d for d in ds.dim_tables(texts) if _title_matches(d.title, pk)]
        if pk.get("body") and len(dims) > 1:
            close = [d for d in dims if d.nom("D") and d.nom("E") and sorted((round(d.nom("D")), round(d.nom("E")))) == sorted((round(pk["body"][0]), round(pk["body"][1])))]
            dims = close or dims
        if dims:
            fp_args["dims"] = {k: v for k, v in dims[0].dims.items()}
            report_extra["dimensions_page"] = f"page {real(dims[0].page)} ({dims[0].title[:60]})"
        if pk.get("body") and not package:
            fp_args["body"] = pk["body"]
    part = Part(name or "PART", pins, pkg_name, reference=reference, datasheet=source if isinstance(source, str) and source.startswith("http") else "", density=density, **fp_args)
    part.report.update(report_extra)
    how = part.report.get("footprint_from") or ""
    if "JEDEC standard" in how:
        part.report["warnings"] = [f"the footprint uses standard {pkg_name} dimensions, not this datasheet's drawing; check the body width and pitch against the datasheet before ordering boards"]
    elif "dimensions_page" in report_extra:
        part.report["footprint_from"] = f"datasheet dimensions, {report_extra['dimensions_page']}, IPC-7351 density {density}" + (f"; {how}" if how else "")
    part.report["missing"] = missing + part.report["missing"]
    if key and not part.report["missing"]:
        try:
            with open(key, "w") as f:
                json.dump({"name": part.name, "pins": part.pins, "package": part.package, "datasheet": part.datasheet, "fp_args": _plain(fp_args), "report_extra": report_extra}, f)
        except (OSError, TypeError):
            pass
    if project is not None:
        part.use_library(project)
    return part


def _plain(o):
    if isinstance(o, dict):
        return {k: _plain(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_plain(v) for v in o]
    return o


def _same_family(header: str, want: dict) -> bool:
    got = ds.packages(header + " ")
    return any(g["family"] == want["family"] for g in got) or want["family"] in header.upper()


def _title_matches(title: str, pk: dict) -> bool:
    got = ds.packages(title + " ")
    return any(g["family"] == pk["family"] and g["pins"] == pk["pins"] for g in got)
