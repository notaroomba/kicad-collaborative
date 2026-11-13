"""Finding parts: LCSC, Mouser and DigiKey listings, and Texas Instruments and Analog Devices datasheets.

    from kicad_harness import parts
    rows = parts.find("3.3V LDO SOT-23-5 500mA")            # every vendor that is set up, merged
    rows = parts.find("TPS54331", vendors=["digikey"])
    hit = parts.lookup("TPS54331")                          # one part: maker, datasheet, where to buy

With a project open on a Junction server (`project=`), the server's vendor search is
used, with the keys saved there.  Without one, the vendors are asked directly:

- LCSC needs no key.
- Mouser needs MOUSER_API_KEY (a Search API key).
- DigiKey needs DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET.
- Texas Instruments and Analog Devices have no open search, but their datasheet addresses follow
  the part number, so `lookup` builds them and checks that they answer.

Rows are short: vendor, id, mpn, manufacturer, description, package, stock, price, datasheet.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

_UA = "kicad-harness"
_TIMEOUT = 20
_tokens: dict = {}


def _env(name: str, default: str) -> str:
    return (os.environ.get(name) or default).rstrip("/")


def _http(url: str, data=None, headers: dict | None = None, form: bool = False):
    h = {"user-agent": _UA, "accept": "application/json"}
    body = None
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            h["content-type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode()
            h["content-type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(url, data=body, headers=h, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace") or "null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace") or "null")
        except ValueError:
            return e.code, None


def _row(vendor, vid, mpn, mfr, desc, package="", stock=None, price=None, datasheet="", url="") -> dict:
    ds = datasheet or ""
    if ds.startswith("//"):
        ds = "https:" + ds
    r = {"vendor": vendor, "id": str(vid), "mpn": mpn or "", "manufacturer": mfr or "", "description": (desc or "")[:140], "package": package or ""}
    if stock is not None:
        r["stock"] = stock
    if price:
        r["price"] = price
    if ds:
        r["datasheet"] = ds
    if url:
        r["url"] = url
    return r


# ---------------------------------------------------------------- the vendors

def lcsc(query: str, limit: int = 8) -> list:
    """LCSC / JLCPCB parts by description or part number (no key needed)."""
    base = _env("JLCSEARCH_URL", "https://jlcsearch.tscircuit.com")
    status, v = _http(f"{base}/api/search?" + urllib.parse.urlencode({"q": query, "limit": limit, "full": "true"}))
    if status >= 400 or not isinstance(v, dict):
        raise RuntimeError(f"The LCSC parts index answered {status}.")
    out = []
    for c in v.get("components", [])[:limit]:
        num = c.get("lcsc")
        if num is None:
            continue
        price = c.get("price")
        if isinstance(price, str):
            try:
                price = json.loads(price)
            except ValueError:
                price = None
        first = None
        if isinstance(price, list) and price:
            first = price[0].get("price") if isinstance(price[0], dict) else None
        elif isinstance(price, (int, float)):
            first = price
        vid = f"C{num}" if not str(num).upper().startswith("C") else str(num).upper()
        out.append(_row("lcsc", vid, c.get("mfr"), c.get("manufacturer") or "", c.get("description"), c.get("package"), c.get("stock"),
                        f"{first} USD" if first is not None else None, c.get("datasheet") or "", f"https://www.lcsc.com/product-detail/{vid}.html"))
    return out


def mouser(query: str, limit: int = 8, key: str | None = None) -> list:
    """Mouser parts by keyword.  Needs a Search API key (MOUSER_API_KEY); an Order or Cart key is refused."""
    key = key or os.environ.get("MOUSER_API_KEY")
    if not key:
        raise RuntimeError("Mouser needs a Search API key in MOUSER_API_KEY.")
    base = _env("MOUSER_API_URL", "https://api.mouser.com")
    status, v = _http(f"{base}/api/v1/search/keyword?apiKey={urllib.parse.quote(key)}",
                      {"SearchByKeywordRequest": {"keyword": query, "records": limit, "startingRecord": 0, "searchOptions": "", "searchWithYourSignUpLanguage": ""}})
    errors = [e.get("Message", "") for e in (v or {}).get("Errors") or []] if isinstance(v, dict) else []
    if status in (401, 403) or any("api key" in m.lower() or "invalid unique identifier" in m.lower() for m in errors):
        raise RuntimeError("Mouser did not accept the API key (it must be a Search API key).")
    if status >= 400 or errors:
        raise RuntimeError("Mouser answered: " + ("; ".join(errors) or str(status)))
    out = []
    for p in ((v or {}).get("SearchResults") or {}).get("Parts") or []:
        breaks = p.get("PriceBreaks") or []
        price = f"{breaks[0].get('Price')}" if breaks else None
        stock = re.match(r"\s*([\d,]+)", p.get("Availability") or "")
        out.append(_row("mouser", p.get("MouserPartNumber"), p.get("ManufacturerPartNumber"), p.get("Manufacturer"), p.get("Description"), "",
                        int(stock.group(1).replace(",", "")) if stock else None, price, p.get("DataSheetUrl") or "", p.get("ProductDetailUrl") or ""))
    return out[:limit]


def _digikey_token(cid: str, secret: str) -> str:
    hit = _tokens.get(cid)
    if hit and hit[1] > time.time():
        return hit[0]
    base = _env("DIGIKEY_API_URL", "https://api.digikey.com")
    status, v = _http(f"{base}/v1/oauth2/token", {"client_id": cid, "client_secret": secret, "grant_type": "client_credentials"}, form=True)
    tok = (v or {}).get("access_token") if isinstance(v, dict) else None
    if status >= 400 or not tok:
        raise RuntimeError("DigiKey did not accept the client id and secret.")
    _tokens[cid] = (tok, time.time() + max(60, int((v or {}).get("expires_in") or 600)) - 30)
    return tok


def digikey(query: str, limit: int = 8, client_id: str | None = None, client_secret: str | None = None) -> list:
    """DigiKey parts by keyword.  Needs DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET (a production app of the Product Information API)."""
    cid, secret = client_id or os.environ.get("DIGIKEY_CLIENT_ID"), client_secret or os.environ.get("DIGIKEY_CLIENT_SECRET")
    if not (cid and secret):
        raise RuntimeError("DigiKey needs DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET.")
    base = _env("DIGIKEY_API_URL", "https://api.digikey.com")
    headers = {"authorization": "Bearer " + _digikey_token(cid, secret), "x-digikey-client-id": cid,
               "x-digikey-locale-site": os.environ.get("DIGIKEY_SITE", "US"), "x-digikey-locale-language": "en", "x-digikey-locale-currency": os.environ.get("DIGIKEY_CURRENCY", "USD")}
    status, v = _http(f"{base}/products/v4/search/keyword", {"Keywords": query, "Limit": min(limit, 50), "Offset": 0}, headers)
    if status >= 400 or not isinstance(v, dict):
        raise RuntimeError(f"DigiKey answered {status}" + (f": {v.get('detail') or v.get('title')}" if isinstance(v, dict) else ""))
    out, seen = [], set()
    for key in ("ExactMatches", "Products"):
        for p in v.get(key) or []:
            vars_ = p.get("ProductVariations") or []
            pick = next((x for x in vars_ if "cut tape" in str((x.get("PackageType") or {}).get("Name", "")).lower()), vars_[0] if vars_ else {})
            vid = pick.get("DigiKeyProductNumber") or p.get("ManufacturerProductNumber")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            pkg = next((q.get("ValueText") for q in p.get("Parameters") or [] if "package" in str(q.get("ParameterText", "")).lower()), "")
            out.append(_row("digikey", vid, p.get("ManufacturerProductNumber"), (p.get("Manufacturer") or {}).get("Name"), (p.get("Description") or {}).get("ProductDescription"),
                            pkg, p.get("QuantityAvailable"), f"{p.get('UnitPrice')} USD" if p.get("UnitPrice") is not None else None, p.get("DatasheetUrl") or "", p.get("ProductUrl") or ""))
    return out[:limit]


# ---------------------------------------------------------------- manufacturers

_TI = re.compile(r"^(TPS|TLV|TPA|TL\d|LM[\dVRPC]|LP\d|LMR|LMZ|OPA|INA|SN[67]\d|SN\d|CD4|CD74|BQ|DRV|ADS|DAC\d|TMP|MSP4|CC\d|TCA|TXS|TXB|UCC|UC\d|REF\d|ISO\d|THS|TMUX|TUSB|DP83|AM\d|TMS|PCA9|PCF8|LMK|CDC|XTR|NE55|ULN|DS90|TAS|PCM)", re.I)
_ADI = re.compile(r"^(AD\d|ADP|ADM|ADUM|ADXL|ADA\d|ADG|ADF|ADE|ADN|ADR\d|ADT|ADIS|ADAU|AD[A-Z]{1,2}\d|LT[CM]?\d|HMC|MAX\d|DS\d{4}|SSM|OP\d)", re.I)


def maker(mpn: str) -> str:
    """The manufacturer a part number most likely belongs to, by its prefix: "ti", "adi" or ""."""
    m = mpn.strip()
    if _ADI.match(m) and not re.match(r"^ADS\d", m, re.I):
        return "adi"
    if _TI.match(m):
        return "ti"
    return ""


def _base_part(mpn: str) -> str:
    """The generic part of an orderable number: TPS54331DR -> TPS54331, ADP150AUJZ-3.3-R7 -> ADP150."""
    m = re.match(r"^([A-Za-z]+\d+(?:[A-Za-z]{1,4}\d+)*)", mpn.strip())
    return m.group(1) if m else mpn.strip()


def _answers(url: str) -> bool:
    try:
        req = urllib.request.Request(url, headers={"user-agent": "Mozilla/5.0 (kicad-harness)", "range": "bytes=0-7"})
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            return r.status in (200, 206) and (r.read(8) or b"").startswith(b"%PDF")
    except (urllib.error.URLError, OSError, ValueError):
        return False


def ti(mpn: str, check: bool = True) -> dict:
    """Texas Instruments: the product page and datasheet of a part number."""
    base = _base_part(mpn).lower()
    cands = [f"https://www.ti.com/lit/ds/symlink/{base}.pdf", f"https://www.ti.com/lit/gpn/{base}"]
    ds = next((u for u in cands if _answers(u)), "") if check else cands[0]
    return {"vendor": "ti", "id": base.upper(), "mpn": mpn.upper(), "manufacturer": "Texas Instruments", "datasheet": ds, "datasheet_candidates": cands if not ds else None,
            "url": f"https://www.ti.com/product/{base.upper()}"}


def adi(mpn: str, check: bool = True) -> dict:
    """Analog Devices (with Linear Technology and Maxim): the product page and datasheet of a part number."""
    base = _base_part(mpn)
    root = "https://www.analog.com/media/en/technical-documentation/data-sheets/"
    cands = [root + base.upper() + ".pdf", root + base.lower() + ".pdf"]
    lt = re.match(r"^LT[CM]?(\d+)", base, re.I)
    if lt:   # Linear Technology files are named by the number and a revision letter
        cands += [root + lt.group(1) + f + ".pdf" for f in ("fa", "fb", "fc", "fd", "fe", "ff", "f")]
    ds = next((u for u in cands if _answers(u)), "") if check else cands[0]
    return {"vendor": "adi", "id": base.upper(), "mpn": mpn.upper(), "manufacturer": "Analog Devices", "datasheet": ds, "datasheet_candidates": cands if not ds else None,
            "url": f"https://www.analog.com/en/products/{base.lower()}.html"}


# ---------------------------------------------------------------- one front door

_VENDORS = {"lcsc": lcsc, "mouser": mouser, "digikey": digikey}


def find(query: str, vendors: list | None = None, limit: int = 8, project=None) -> list:
    """Parts matching a description or part number, from every vendor that is set up (or the ones named).

    Vendors that are not set up or do not answer are skipped; a row {"vendor": ..., "error": ...} says why.
    """
    rows: list = []
    want = [v.lower() for v in vendors] if vendors else None
    if project is None:
        import kicad_harness
        project = getattr(kicad_harness, "_current", None)   # inside run_python: the server's vendor accounts
    if project is not None and project.transport.kind != "local":
        for v in (want or [None]):
            if v in ("ti", "adi"):
                continue
            try:
                args = {"query": query, "kind": "symbol"}
                if v:
                    args["vendor"] = v
                r = project.transport.call("find_parts", args)
            except Exception as e:  # the server's own message says what is not set up
                rows.append({"vendor": v or "server", "error": str(e)})
                continue
            for p in r.get("vendor_parts") or []:
                rows.append(_row(p.get("vendor"), p.get("id"), p.get("mpn"), p.get("manufacturer"), p.get("description"), p.get("package"), p.get("stock"), p.get("unit_price"), p.get("datasheet") or ""))
            for msg in r.get("vendor_errors") or []:
                rows.append({"vendor": v or "server", "error": msg})
    else:
        for name, fn in _VENDORS.items():
            if want and name not in want:
                continue
            if not want and ((name == "mouser" and not os.environ.get("MOUSER_API_KEY")) or (name == "digikey" and not os.environ.get("DIGIKEY_CLIENT_ID"))):
                continue
            try:
                rows += fn(query, limit)
            except Exception as e:
                rows.append({"vendor": name, "error": str(e)})
    if re.fullmatch(r"[A-Za-z0-9\-./+]{4,}", query.strip()) and (not want or "ti" in want or "adi" in want):
        m = maker(query)
        if m and (not want or m in want):
            rows.append((ti if m == "ti" else adi)(query, check=False))
    return rows


def lookup(mpn: str, project=None) -> dict:
    """One part number: who makes it, its datasheet and where it can be bought.  The datasheet address feeds parts.from_datasheet."""
    rows = [r for r in find(mpn, project=project, limit=5) if not r.get("error")]
    exact = [r for r in rows if r.get("mpn", "").upper().startswith(_base_part(mpn).upper())] or rows
    out = {"mpn": mpn, "manufacturer": next((r["manufacturer"] for r in exact if r.get("manufacturer")), ""), "package": next((r["package"] for r in exact if r.get("package")), ""),
           "description": next((r["description"] for r in exact if r.get("description")), ""), "datasheet": next((r["datasheet"] for r in exact if r.get("datasheet") and r["vendor"] not in ("ti", "adi")), ""),
           "buy": [{k: r[k] for k in ("vendor", "id", "stock", "price") if k in r} for r in exact if r["vendor"] not in ("ti", "adi")][:6]}
    m = maker(mpn)
    if m:
        own = (ti if m == "ti" else adi)(mpn, check=not out["datasheet"])
        out["manufacturer"] = out["manufacturer"] or own["manufacturer"]
        out["product_page"] = own["url"]
        if own.get("datasheet") and (not out["datasheet"] or "ti.com" in own["datasheet"] or "analog.com" in own["datasheet"]):
            out["datasheet"] = own["datasheet"]
        elif not out["datasheet"] and own.get("datasheet_candidates"):
            out["datasheet_candidates"] = own["datasheet_candidates"]
    return out
