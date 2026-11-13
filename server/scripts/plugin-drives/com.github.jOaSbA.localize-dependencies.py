"""Localize Dependencies: tick "Also include standard KiCad libraries", press Localize, and afterwards Revert.

The project (three schematic sheets and a board) takes symbols from five of KiCad's own libraries and footprints from
two.  Expect: each of those symbol libraries copied whole into libs/<name>_local.kicad_sym, holding every symbol the
sheets use from it; the footprints copied into libs/<name>_local.pretty; every lib_id of the sheets and every such
footprint of the open board pointing at the copies, with no footprint moved; rows for the copies in the project's
library tables.  Revert then puts the sheets, the tables and the board's footprints back exactly as they were."""
# board: demos/openair-max/One-Air-Max.kicad_pcb
import glob
import json
import os
import re
import pcbnew
import kicad_web
from drive_util import click, messages, tick

P = "/project"
SYM_LIBS = ["Connector", "Device", "Jumper", "Transistor_FET", "power"]
seen = {"phase": 0}


def read(rel):
    with open(os.path.join(P, rel), encoding="utf-8") as fh:
        return fh.read()


def sheets():
    return sorted(os.path.basename(p) for p in glob.glob(P + "/*.kicad_sch"))


def lib_ids(text):
    return re.findall(r'\(lib_id "([^":]+):([^"]+)"\)', text)


def places():
    return {fp.m_Uuid.AsString(): (fp.GetFPIDAsString(), fp.GetPosition().x, fp.GetPosition().y, fp.GetOrientationDegrees(), fp.IsFlipped()) for fp in pcbnew.GetBoard().GetFootprints()}


def status(dlg):
    out = {}
    for r in dlg.rows:
        out.setdefault((r["type"], r["status"]), []).append(r)
    return out


def modal(dlg):
    seen["phase"] += 1
    if seen["phase"] == 1:
        seen["texts"] = {n: read(n) for n in sheets()}
        seen["board"] = places()
        st = status(dlg)
        std_syms = st.get(("symbol", "standard"), [])
        assert sorted({r["name"].split(":")[0] for r in std_syms}) == SYM_LIBS, sorted({r["name"].split(":")[0] for r in std_syms})
        assert all(r["source"].endswith("/%s.kicad_sym" % r["name"].split(":")[0]) for r in std_syms), std_syms[0]
        seen["fps"] = sorted(r["name"] for r in st.get(("footprint", "standard"), []))
        assert len(seen["fps"]) == 7 and {n.split(":")[0] for n in seen["fps"]} == {"Jumper", "TestPoint"}, seen["fps"]
        assert not dlg.btn_revert.IsEnabled(), "Revert is offered before anything was localized"
        tick(dlg.include_std, True)
        # rows are ticked one by one too: unticking one footprint takes it out of the count, ticking puts it back
        i = next(k for k, r in enumerate(dlg.rows) if r["type"] == "footprint" and r["status"] == "standard")
        assert dlg.list.IsItemChecked(i) and "7 footprints" in dlg.summary.GetLabel(), dlg.summary.GetLabel()
        dlg.list.CheckItem(i, False)
        assert "6 footprints" in dlg.summary.GetLabel(), dlg.summary.GetLabel()
        dlg.list.CheckItem(i, True)
        assert "7 footprints" in dlg.summary.GetLabel(), dlg.summary.GetLabel()
        missing = next(k for k, r in enumerate(dlg.rows) if r["status"] == "missing")
        assert not dlg.list.IsItemChecked(missing)
        # a click on a heading sorts by that column
        dlg.list._wx_col_click(dlg.list._col_els[2])
        names = [dlg.list.GetItemText(k, 2) for k in range(dlg.list.GetItemCount())]
        assert dlg.sort_col == 2 and names[0].lower() <= names[len(names) // 2].lower() <= names[-1].lower(), (dlg.sort_col, names[:3])
        click("Localize", dlg)
        said = messages()[-1]
        assert "Symbols: 5 libraries, 193 references" in said and "Footprints: 2 libraries, 2 files, 7 references" in said, said
        after = status(dlg)
        assert ("symbol", "standard") not in after and ("footprint", "standard") not in after, sorted(after)
        assert len(after[("symbol", "local")]) == len(std_syms) and len(after[("footprint", "local")]) == 7
        assert dlg.btn_revert.IsEnabled()
        # the copies are the whole libraries, with every symbol the sheets use
        used = {}
        for text in seen["texts"].values():
            for lib, name in lib_ids(text):
                used.setdefault(lib, set()).add(name)
        for lib in SYM_LIBS:
            copy = read("libs/%s_local.kicad_sym" % lib)
            assert copy.startswith("(kicad_symbol_lib"), copy[:40]
            for name in used[lib]:
                assert '(symbol "%s"' % name in copy, (lib, name)
            m = re.findall(r'\(extends "([^"]+)"\)', copy)
            assert all('(symbol "%s"' % parent in copy for parent in m), lib
        assert len(re.findall(r'^\t\(symbol "', read("libs/power_local.kicad_sym"), re.M)) > 100
        for fpid in set(seen["fps"]):
            lib, name = fpid.split(":")
            assert read("libs/%s_local.pretty/%s.kicad_mod" % (lib, name)).lstrip().startswith(("(footprint", "(module")), fpid
        # every reference now names the copy
        for n, was in seen["texts"].items():
            now = read(n)
            assert [(l + "_local" if l in SYM_LIBS else l, s) for l, s in lib_ids(was)] == lib_ids(now), n
        sym_table, fp_table = read("sym-lib-table"), read("fp-lib-table")
        for lib in SYM_LIBS:
            assert '(name "%s_local")' % lib in sym_table and "${KIPRJMOD}/libs/%s_local.kicad_sym" % lib in sym_table, sym_table
        for lib in ("Jumper", "TestPoint"):
            assert "${KIPRJMOD}/libs/%s_local.pretty" % lib in fp_table, fp_table
        seen["localized"] = {n: read(n) for n in sheets()}
    else:
        assert dlg.btn_revert.IsEnabled(), "Revert is not offered after a localize run"
        click("Revert", dlg)
        said = messages()[-1]
        assert said.startswith("Localize Dependencies: Restored ") and "Errors" not in said, said
        for n, was in seen["texts"].items():
            assert read(n) == was, "%s was not restored" % n
        assert not os.path.exists(P + "/libs/power_local.kicad_sym") and not os.path.exists(P + "/sym-lib-table")
        st = status(dlg)
        assert sorted({r["name"].split(":")[0] for r in st[("symbol", "standard")]}) == SYM_LIBS and len(st[("footprint", "standard")]) == 7


def after_run(_action):
    assert seen["phase"] == 1, seen
    # the open board: the seven footprints name the copies, and nothing moved
    was, now = seen["board"], places()
    assert set(was) == set(now)
    changed = sorted(u for u in was if was[u] != now[u])
    assert len(changed) == 7, len(changed)
    for u in changed:
        lib, name = was[u][0].split(":")
        assert now[u][0] == "%s_local:%s" % (lib, name) and now[u][1:] == was[u][1:], (was[u], now[u])
    # run it again and revert
    index = next(i for i, a in enumerate(kicad_web.describe()["actions"]) if a["name"] == _action)
    out = json.loads(kicad_web.run_action(index))
    assert out.get("ok") and seen["phase"] == 2, (out, seen["phase"])
    assert places() == was, "the board's footprints were not put back"
    return {"symbol_libraries": len(SYM_LIBS), "references": 193, "footprints": 7, "reverted": True}
