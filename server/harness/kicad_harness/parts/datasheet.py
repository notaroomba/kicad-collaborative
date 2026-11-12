"""Reading a datasheet without a model: page text, the pin table and the package drawing's numbers.

Datasheets are laid out for people, so this is a set of careful heuristics, and it says how sure
it is.  What it cannot read is reported as missing, and only that small remainder needs a
person or a model (`Part.fix`).
"""
from __future__ import annotations

import io
import re

# ---------------------------------------------------------------- page text

def pdf_pages(source) -> list:
    """The text of each page of a PDF given as a path or bytes.  Uses whichever of pypdf, pdfminer.six or pdfplumber is installed."""
    data = source if isinstance(source, (bytes, bytearray)) else open(source, "rb").read()
    errors = []
    try:
        import pypdf
        return [(p.extract_text() or "") for p in pypdf.PdfReader(io.BytesIO(data)).pages]
    except ImportError:
        pass
    except Exception as e:  # a damaged file: let the next reader try
        errors.append(str(e))
    try:
        from pdfminer.high_level import extract_text
        text = extract_text(io.BytesIO(data))
        return text.split("\f")
    except ImportError:
        pass
    except Exception as e:
        errors.append(str(e))
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            return [(p.extract_text() or "") for p in pdf.pages]
    except ImportError:
        pass
    raise RuntimeError("The PDF could not be read" + (": " + "; ".join(errors) if errors else ". Install pypdf (pip install pypdf)."))


# ---------------------------------------------------------------- packages named in the text

_FAMILIES = [
    ("QFN", r"(?:[A-Z]{0,3}QFN|QFN|MLF|LFCSP|VQFN|WQFN|UQFN|UFQFPN|VFQFPN|TQFN|HVQFN)"), ("DFN", r"(?:[A-Z0-9]{0,3}-?DFN|SON|WSON|USON|XSON|VSON|UDFN|TDFN)"),
    ("TSSOP", r"(?:TSSOP|HTSSOP)"), ("MSOP", r"(?:MSOP|VSSOP|uMAX|µMAX)"), ("SSOP", r"(?:SSOP|QSOP)"), ("SOIC", r"(?:SOIC|SOP|SO)(?![A-Z])"),
    ("QFP", r"(?:LQFP|TQFP|QFP|PQFP|VQFP)"), ("SOT-23", r"(?:SOT-?23|SOT-?25|SOT-?26|TSOT-?23|SC-?59|SC-?74)"), ("SOT-223", r"SOT-?223"), ("SOT-89", r"SOT-?89"),
    ("SC-70", r"(?:SC-?70|SOT-?323|SOT-?353|SOT-?363)"), ("BGA", r"(?:[A-Z]{0,4}BGA|WLCSP|CSP)"), ("DIP", r"(?:P?DIP|PDIP)"),
]


def packages(text: str) -> list:
    """Package names found in text, as {"family", "pins", "body": (w, l) or None, "name"}; most often named first."""
    found: dict = {}
    for m in re.finditer(r"(?<![A-Za-z])[A-Z0-9]{0,3}-?(DFN|QFN|SON)(\d)(\d)(\d)(\d)-(\d{1,2})\b", text):   # X2-DFN1010-4: body 1.0 x 1.0, 4 terminals
        fam = "QFN" if m.group(1) == "QFN" else "DFN"
        e = found.setdefault((fam, int(m.group(6))), {"family": fam, "pins": int(m.group(6)), "body": (int(m.group(2) + m.group(3)) / 10, int(m.group(4) + m.group(5)) / 10), "name": m.group(0), "count": 0})
        e["count"] += 2
    for fam, pat in _FAMILIES:
        for m in re.finditer(r"(?<![A-Za-z])(?:(\d{1,3})[- ]?(?:[Pp]ins?|[Ll]eads?|[Pp]ads?|[Bb]alls?|ld|L)[- ]+)?(" + pat + r")", text):
            name = m.group(2)
            tail = text[m.end(2):m.end(2) + 40].split("\n")[0]
            pins = m.group(1)
            if not pins:
                pm = re.match(r"[- ]?(\d{1,3})(?![\d.]|\s*[xX×]|-?\s?mil)", tail)
                pins = pm.group(1) if pm else None
            if fam == "SOT-23":
                d = re.search(r"(25|26)$", name)
                pm = re.match(r"-(\d)\b", tail)
                pins = pm.group(1) if pm else ({"25": "5", "26": "6"}[d.group(1)] if d else pins if pins and int(pins) <= 8 else None)
            if not pins and fam not in ("SOT-23", "SOT-223", "SOT-89"):
                continue
            if pins and (not 2 <= int(pins) <= 400 or (fam not in ("BGA", "QFP", "QFN") and int(pins) > 80)):
                continue
            key = (fam, int(pins) if pins else {"SOT-23": 3, "SOT-223": 4, "SOT-89": 3}[fam])
            bm = re.search(r"(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×X]\s*(\d+(?:\.\d+)?)\s*-?\s*mm", tail)
            body = (float(bm.group(1)), float(bm.group(2))) if bm else None
            e = found.setdefault(key, {"family": fam, "pins": key[1], "body": body, "name": name, "count": 0})
            e["count"] += 1
            if body and not e["body"]:
                e["body"] = body
    return sorted(found.values(), key=lambda e: -e["count"])


# ---------------------------------------------------------------- pin tables

_ID = r"(?:\d{1,3}|[A-HJ-NP-RT-Y]{1,2}\d{1,2}|EP|EPAD|PAD|TAB|[-–—]{1,3})"
_NAME = r"[/~!]?[A-Za-z+][A-Za-z0-9_+\-/#\[\].]*(?:\s?\((?:[A-Za-z0-9_/+\-]+)\))?"
_TYPE = r"(?:I/O/Z|I/O|IO|AI/O|AIO|AI|AO|DI|DO|I|O|P|PWR|S|G|GND|A|D|OD|O/D|NC|Power|Supply|Ground|Input|Output|Analog|Digital|Bidirectional|[-–—])"
_ROW_NUM_FIRST = re.compile(rf"^\s*((?:{_ID}\s+){{1,6}})({_NAME})(?:\s+({_TYPE}))?(?:\s+(.*))?$")
_ROW_NAME_FIRST = re.compile(rf"^\s*({_NAME})\s+((?:{_ID})(?:\s*,\s*{_ID})*)(?:\s+({_TYPE}))?(?:\s+(.*))?$")
_NOT_NAME = re.compile(r"^(Min|Max|Typ|Nom|Note|Notes|Table|Figure|Rev|Page|of|to|and|or|the|mm|V|mA|MHz|kHz|ns|pF|Symbol|Parameter|Unit|Units|Pin|No|Name|Type|Description|Function|BSC|REF|DS\d+)$", re.I)


class PinTable:
    """One table of pins found in a datasheet."""

    def __init__(self, page: int, columns: int, order: str):
        self.page, self.columns, self.order = page, columns, order
        self.rows: list = []          # (ids per column, name, type, description)
        self.headers: list = []       # package name of each id column, when the table names them
        self.title = ""

    def pins(self, column: int = 0) -> list:
        """(number, name, type) for one id column, exposed pads last."""
        out, seen = [], set()
        for ids, name, ty, _ in self.rows:
            if column >= len(ids):
                continue
            for i in [x.strip() for x in ids[column].split(",")]:
                if re.fullmatch(r"[-–—]{1,3}", i) or not i or i in seen:
                    continue
                seen.add(i)
                out.append((i, name, ty))
        return out

    def count(self, column: int = 0) -> int:
        return len(self.pins(column))

    def complete(self, column: int = 0) -> tuple:
        """(is every number 1..N present, the missing numbers)."""
        nums = sorted(int(p[0]) for p in self.pins(column) if p[0].isdigit())
        if not nums:
            return (bool(self.pins(column)), [])
        missing = [n for n in range(1, nums[-1] + 1) if n not in set(nums)]
        return (not missing, missing)


def _clean_name(name: str) -> str:
    name = re.sub(r"\s+", "", name.strip())
    m = re.match(r"^(.*?)\((.*)\)$", name)   # "DO (IO1)" -> "DO/IO1"
    if m and m.group(1):
        name = f"{m.group(1)}/{m.group(2)}"
    return name


def pin_tables(pages: list) -> list:
    """Every run of lines that reads as a pin table, best first."""
    tables = []
    for pno, text in enumerate(pages, 1):
        lines = text.splitlines()
        i = 0
        while i < len(lines):
            for order, rx in (("number", _ROW_NUM_FIRST), ("name", _ROW_NAME_FIRST)):
                rows, j, gap, cols = [], i, 0, None
                while j < len(lines) and gap <= (7 if cols and cols > 2 else 3):
                    m = rx.match(lines[j])
                    ok = False
                    if m:
                        if order == "number":
                            ids, name, ty, desc = m.group(1).split(), m.group(2), m.group(3) or "", m.group(4) or ""
                        else:
                            name, ids, ty, desc = m.group(1), [m.group(2)], m.group(3) or "", m.group(4) or ""
                        if not _NOT_NAME.match(name.split("(")[0].strip()) and not re.fullmatch(r"\d+(\.\d+)?", name) and (cols is None or len(ids) == cols) \
                                and any(re.fullmatch(r"\d{1,3}|[A-HJ-NP-RT-Y]{1,2}\d{1,2}|EP|EPAD|PAD|TAB", x.strip()) for part in ids for x in part.split(",")):
                            # a unit after a number ("3.3 V", "10 mA") is a parameter table, not a pin table
                            if not (order == "number" and re.fullmatch(r"(V|mV|A|mA|µA|uA|Hz|kHz|MHz|ns|ms|s|pF|nF|µF|uF|Ω|kΩ|°C|mm|mil|%|W|mW|dB|bits?|ppm)", name)):
                                cols = len(ids)
                                rows.append((ids, _clean_name(name), ty.strip("-–—"), desc.strip()))
                                ok = True
                    if ok:
                        gap = 0
                    else:
                        gap += 1
                    j += 1
                if len(rows) >= 3:
                    t = PinTable(pno, cols or 1, order)
                    t.rows = rows
                    head = " ".join(lines[max(0, i - 14):i])
                    t.headers = [p["name"] + (str(p["pins"]) if not re.search(r"\d$", p["name"]) else "") for p in _header_packages(head)][-(cols or 1):] if (cols or 1) > 1 else []
                    t.title = next((l.strip() for l in reversed(lines[max(0, i - 6):i]) if re.search(r"pin|pad|ball|terminal", l, re.I)), "")
                    tables.append(t)
                    i = j - gap - 1
                    break
            i += 1
    # numeric sequences in running text also match now and then: keep tables whose numbers look like a pin list
    good = []
    for t in tables:
        best = max(range(t.columns), key=lambda c: t.count(c))
        nums = [int(p[0]) for p in t.pins(best) if p[0].isdigit()]
        if t.count(best) >= 3 and (not nums or (min(nums) <= 2 and len(set(nums)) >= 0.6 * max(nums))):
            good.append(t)
    def score(t):
        best = max(range(t.columns), key=lambda c: t.count(c))
        full, missing = t.complete(best)
        numeric = sum(1 for p in t.pins(best) if p[0].isdigit())
        typed = sum(1 for r in t.rows if r[2])
        return (full and numeric >= 3, numeric - 2 * len(missing), typed)
    return sorted(good, key=score, reverse=True)


def _header_packages(text: str) -> list:
    out = []
    for m in re.finditer(r"(?<![A-Za-z])([A-Z][A-Z0-9]*(?:QFN|QFPN|DFN|SOP|SOIC|SOT|QFP|BGA|CSP|DIP|SON)[A-Z]*)[- ]?(\d{0,3}(?:-\d)?)", text):
        out.append({"name": m.group(1) + (m.group(2) or ""), "pins": ""})
    return out


# ---------------------------------------------------------------- package dimensions

_DIM_ROW = re.compile(r"^\s*(A1|A2|A3|A|b1|b2|b|B|c|C|D1|D2|D|E1|E2|E|e1|e|HE|HD|H|L1|L2|L|k|K|N|ND|NE)\s+((?:(?:\d*\.\d+|\d+|[-–—]{1,3}|BSC|REF|TYP|NOM)\.?\s*)+)$")
_NUM = re.compile(r"\d*\.\d+|\d+|[-–—]{1,3}|BSC|REF|TYP")


class DimTable:
    """The dimension table of one package drawing: symbol -> (min, nom, max) in millimetres."""

    def __init__(self, page: int, title: str):
        self.page, self.title, self.dims = page, title, {}

    def get(self, *names):
        for n in names:
            if n in self.dims:
                return self.dims[n]
        return None

    def rng(self, *names):
        """(min, max) of a dimension, from whichever of its three numbers are given."""
        d = self.get(*names)
        if not d:
            return None
        v = [x for x in d if x is not None]
        return (min(v), max(v)) if v else None

    def nom(self, *names):
        d = self.get(*names)
        if not d:
            return None
        if d[1] is not None:
            return d[1]
        v = [x for x in d if x is not None]
        return sum(v) / len(v) if v else None


def dim_tables(pages: list) -> list:
    """Dimension tables of package drawings: runs of rows such as `b 0.35 0.42 0.48`."""
    out = []
    for pno, text in enumerate(pages, 1):
        lines = text.splitlines()
        i = 0
        while i < len(lines):
            if not _DIM_ROW.match(lines[i]):
                i += 1
                continue
            j, rows = i, []
            while j < len(lines) and (_DIM_ROW.match(lines[j]) or (rows and j + 1 < len(lines) and _DIM_ROW.match(lines[j + 1]) and len(lines[j]) < 30)):
                m = _DIM_ROW.match(lines[j])
                if m:
                    rows.append((m.group(1), _NUM.findall(m.group(2))))
                j += 1
            if len(rows) >= 4:
                head = " ".join(lines[max(0, i - 6):i])
                order = [w.lower()[:3] for w in re.findall(r"\b(Min|Minimum|Nom|Nominal|Typ|Typical|Max|Maximum)\b\.?", head, re.I)][:3]
                if len(order) < 2:
                    order = ["min", "nom", "max"]
                inch_first = bool(re.search(r"inch", head, re.I)) and (not re.search(r"mil+imet|\bmm\b", head, re.I) or head.lower().find("inch") < min([x for x in (head.lower().find("millimet"), head.lower().find("mm")) if x >= 0] or [10 ** 9]))
                near = [l.strip() for l in reversed(lines[max(0, i - 14):i]) if l.strip()]
                fam = re.compile("|".join(p for _, p in _FAMILIES))
                title = next((l for l in near if fam.search(l)), None) or next((l for l in near if re.search(r"package|outline", l, re.I)), "")
                t = DimTable(pno, title)
                for sym, vals in rows:
                    n = len(order)
                    if inch_first and len(vals) >= 2 * n:
                        vals = vals[n:2 * n]
                    elif inch_first:
                        vals = [str(round(float(v) * 25.4, 3)) if re.match(r"[\d.]", v) else v for v in vals]
                    num = lambda s: float(s) if re.match(r"^\d*\.?\d+$", s) else None
                    if len(vals) >= 2 and vals[1] in ("BSC", "REF", "TYP"):
                        d = (None, num(vals[0]), None)
                    elif len(vals) == 1:
                        d = (None, num(vals[0]), None)
                    else:
                        got = dict(zip(order, [num(v) for v in vals[:n]]))
                        d = (got.get("min"), got.get("nom", got.get("typ")), got.get("max"))
                    if any(x is not None for x in d) and sym not in t.dims:
                        t.dims[sym] = d
                if "e" in t.dims or "b" in t.dims or "D" in t.dims:
                    out.append(t)
            i = max(j, i + 1)
    return out
