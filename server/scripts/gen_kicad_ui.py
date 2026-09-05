#!/usr/bin/env python3
"""Generate server/static/kicad-ui-spec.js from KiCad's own sources.

The web editor mirrors the desktop's toolbars, so the toolbar layout, the action
labels / tooltips / hotkeys and the icons all come straight from the C++ tree:

  eeschema/toolbars_sch_editor.cpp, pcbnew/toolbars_pcb_editor.cpp   toolbar order
  common/tool/actions.cpp, eeschema/tools/sch_actions.cpp,
  pcbnew/tools/pcb_actions.cpp                                        TOOL_ACTION metadata
  resources/bitmaps_png/sources/{light,dark}/<icon>.svg               icons

Run from the repository root:  python3 server/scripts/gen_kicad_ui.py
"""
import json, os, re, sys, xml.etree.ElementTree as ET

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "server", "static", "kicad-ui-spec.js")

ACTION_SOURCES = ["common/tool/actions.cpp", "eeschema/tools/sch_actions.cpp", "pcbnew/tools/pcb_actions.cpp"]
TOOLBAR_SOURCES = {"sch": "eeschema/toolbars_sch_editor.cpp", "pcb": "pcbnew/toolbars_pcb_editor.cpp"}
LOCS = {"TOP_MAIN": "top", "TOP_AUX": "aux", "LEFT": "left", "RIGHT": "right"}
# Standalone-only or debug-only entries the desktop hides in project mode.
SKIP = {"ACTIONS::doNew", "ACTIONS::open", "PCB_ACTIONS::importNetlist", "ACTIONS::toggleBoundingBoxes",
        "PCB_ACTIONS::zoneDisplayFractured", "PCB_ACTIONS::zoneDisplayTriangulated"}


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8", errors="replace") as f:
        return f.read()


def parse_actions():
    out = {}
    for src in ACTION_SOURCES:
        s = read(src)
        for m in re.finditer(r"TOOL_ACTION\s+(\w+)::(\w+)\s*\(\s*TOOL_ACTION_ARGS\(\)(.*?)\)\s*;", s, re.S):
            cls, name, body = m.groups()

            def field(key):
                r = re.search(r"\." + key + r"\(\s*_?\(?\s*\"((?:[^\"\\]|\\.)*)\"", body)
                return r.group(1).replace('\\"', '"') if r else None

            icon = re.search(r"\.Icon\(\s*BITMAPS::(\w+)", body)
            hk = re.search(r"\.DefaultHotkey\(\s*([^)]*)\)", body)
            out[f"{cls}::{name}"] = {"id": name, "label": field("FriendlyName"), "tip": field("Tooltip"),
                                     "icon": icon.group(1) if icon else None, "key": fmt_hotkey(hk.group(1)) if hk else None}
    return out


KEYS = {"WXK_F1": "F1", "WXK_F2": "F2", "WXK_F3": "F3", "WXK_F4": "F4", "WXK_F5": "F5", "WXK_F6": "F6", "WXK_F7": "F7",
        "WXK_F8": "F8", "WXK_F9": "F9", "WXK_F10": "F10", "WXK_F11": "F11", "WXK_F12": "F12", "WXK_DELETE": "Del",
        "WXK_BACK": "Backspace", "WXK_ESCAPE": "Esc", "WXK_HOME": "Home", "WXK_END": "End", "WXK_TAB": "Tab",
        "WXK_SPACE": "Space", "WXK_RETURN": "Enter", "WXK_INSERT": "Ins", "WXK_PAGEUP": "PgUp", "WXK_PAGEDOWN": "PgDn",
        "WXK_UP": "Up", "WXK_DOWN": "Down", "WXK_LEFT": "Left", "WXK_RIGHT": "Right", "WXK_NUMPAD_ADD": "Num+",
        "WXK_NUMPAD_SUBTRACT": "Num-", "WXK_NUMPAD_MULTIPLY": "Num*", "WXK_NUMPAD_DIVIDE": "Num/"}


def fmt_hotkey(expr):
    expr = expr.strip()
    if not expr or expr == "0":
        return None
    mods = []
    for mod, label in (("MD_CTRL", "Ctrl"), ("MD_SHIFT", "Shift"), ("MD_ALT", "Alt")):
        if mod in expr:
            mods.append(label)
    key = None
    m = re.search(r"'(.)'", expr)
    if m:
        key = m.group(1).upper() if m.group(1).isalpha() else m.group(1)
    else:
        for k, v in KEYS.items():
            if k in expr:
                key = v
                break
    if not key:
        return None
    return "+".join(mods + [key])


TOKEN = re.compile(r"case\s+TOOLBAR_LOC::(\w+)\s*:"
                   r"|\.AppendAction\(\s*(\w+::\w+)"
                   r"|\.AppendSeparator\(\)"
                   r"|\.AppendGroup\(\s*TOOLBAR_GROUP_CONFIG\(\s*_\(\s*\"([^\"]+)\""
                   r"|\.AddAction\(\s*(\w+::\w+)"
                   r"|\.AppendControl\(\s*(\w+::\w+)"
                   r"|\bbreak\s*;")


def parse_toolbars(path, actions):
    s = read(path)
    body = s[s.index("DefaultToolbarConfig"):]
    bars, cur, group = {}, None, None
    for m in TOKEN.finditer(body):
        loc, act, grp, gact, ctl = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
        if loc:
            cur = bars.setdefault(LOCS.get(loc, loc.lower()), [])
            group = None
            continue
        if cur is None:
            continue
        if m.group(0).startswith("break") and False:
            continue
        if act:
            group = None
            if act in SKIP:
                continue
            cur.append(item_for(act, actions))
        elif grp:
            group = {"group": grp, "items": []}
            cur.append(group)
        elif gact:
            if group is not None and gact not in SKIP:
                group["items"].append(item_for(gact, actions))
        elif ctl:
            group = None
            cur.append({"control": ctl.split("::")[-1]})
        elif m.group(0).startswith(".AppendSeparator"):
            group = None
            if cur and not cur[-1].get("sep"):
                cur.append({"sep": True})
    # trailing / leading separators
    for k, v in bars.items():
        while v and v[-1].get("sep"):
            v.pop()
        while v and v[0].get("sep"):
            v.pop(0)
    return bars


def item_for(act, actions):
    a = actions.get(act)
    if not a:
        return {"act": act, "id": act.split("::")[-1], "label": act.split("::")[-1], "tip": None, "icon": None, "key": None}
    return {"act": act, **a}


def scope_classes(text, prefix):
    text = re.sub(r"\.cls-(\d+)", lambda m: f".{prefix}-{m.group(1)}", text)
    text = re.sub(r'class="cls-(\d+)"', lambda m: f'class="{prefix}-{m.group(1)}"', text)
    return text


def clean_svg(path, prefix):
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
    root = ET.parse(path).getroot()
    for e in list(root):
        if e.tag.split("}")[-1] in ("metadata", "namedview", "title", "desc"):
            root.remove(e)
    for e in root.iter():
        for a in list(e.attrib):
            if a.startswith("{") and "w3.org/2000/svg" not in a and "xlink" not in a:
                del e.attrib[a]
            elif a in ("id", "data-name", "version", "sodipodi:docname"):
                del e.attrib[a]
    inner = "".join(ET.tostring(c, encoding="unicode") for c in root)
    inner = re.sub(r'\s+xmlns(:\w+)?="[^"]*"', "", inner)
    inner = re.sub(r"\s+", " ", inner).strip()
    return root.get("viewBox", "0 0 24 24"), scope_classes(inner, prefix)


def collect_icons(names):
    icons = {}
    for n in sorted(names):
        entry = {}
        for theme in ("light", "dark"):
            p = os.path.join(ROOT, "resources", "bitmaps_png", "sources", theme, n + ".svg")
            if os.path.exists(p):
                vb, inner = clean_svg(p, f"k-{n}-{theme[0]}")
                entry["vb"] = vb
                entry[theme] = inner
        if entry:
            icons[n] = entry
        else:
            print("missing icon:", n, file=sys.stderr)
    return icons


def walk(items):
    for it in items:
        if "items" in it:
            yield from walk(it["items"])
        else:
            yield it


def main():
    actions = parse_actions()
    toolbars = {k: parse_toolbars(v, actions) for k, v in TOOLBAR_SOURCES.items()}
    names = set()
    for bars in toolbars.values():
        for items in bars.values():
            for it in walk(items):
                if it.get("icon"):
                    names.add(it["icon"])
    names |= {"cursor", "delete_cursor", "zoom_area", "measurement", "layers_manager", "options_generic", "help", "info",
              "cursor_shape", "hidden_pin", "grid", "show_all_layers", "visibility", "visibility_off", "checked_ok",
              "color_materials", "left", "right", "up", "down", "refresh", "add_comment", "cancel", "distribute_horizontal",
              "save", "undo", "redo", "search", "edit", "group_enter", "group_leave", "annotate", "unlocked", "locked",
              "kicad_icon_small", "icon_eeschema_24", "icon_pcbnew_24", "list_nets", "language", "reload", "auto_associate"}
    icons = collect_icons(names)
    # keep only the metadata the UI needs for actions that made it into a toolbar, plus a few menu entries
    used = {it["act"]: {k: it[k] for k in ("id", "label", "tip", "icon", "key")} for bars in toolbars.values() for items in bars.values() for it in walk(items) if "act" in it}
    for extra in ("ACTIONS::selectAll", "ACTIONS::cut", "ACTIONS::copy", "ACTIONS::doDelete", "ACTIONS::duplicate",
                  "ACTIONS::zoomIn", "ACTIONS::zoomOut", "ACTIONS::zoomCenter", "ACTIONS::toggleCursor", "ACTIONS::measureTool",
                  "SCH_ACTIONS::navigateUp", "SCH_ACTIONS::leaveSheet", "SCH_ACTIONS::enterSheet",
                  "ACTIONS::gridProperties", "ACTIONS::showSearch", "SCH_ACTIONS::showNetNavigator", "PCB_ACTIONS::showNetInspector",
                  "ACTIONS::about", "ACTIONS::help", "ACTIONS::gettingStarted", "ACTIONS::reportBug", "ACTIONS::donate",
                  "ACTIONS::openPreferences", "ACTIONS::showLibraryBrowser"):
        if extra in actions:
            used[extra] = actions[extra]
    spec = {"actions": used, "toolbars": toolbars, "icons": icons}
    js = "// Generated by server/scripts/gen_kicad_ui.py from KiCad's toolbar configs, TOOL_ACTIONs and\n// resources/bitmaps_png — do not edit by hand.\nwindow.KICAD_UI = " + json.dumps(spec, separators=(",", ":"), ensure_ascii=False) + ";\n"
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)
    counts = {k: {loc: len(list(walk(items))) for loc, items in v.items()} for k, v in toolbars.items()}
    print("actions:", len(actions), "used:", len(used), "icons:", len(icons), "toolbars:", counts, "bytes:", os.path.getsize(OUT))


if __name__ == "__main__":
    main()
