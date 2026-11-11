#!/usr/bin/env python3
"""Generate server/web/generated/kicad-menu-spec.json and kicad-menu-icons.json from KiCad's own sources.

The menu bar, the hotkey handling and Help > List Hotkeys need more of KiCad's TOOL_ACTIONs than the
toolbars use (gen_kicad_ui.py keeps only those): every action of the three action tables with its
friendly name, tooltip, icon name and default hotkey(s) — the Linux / Windows one, plus the macOS one where it
differs — keyed by its C++ name (kicad-menu-spec.json, which
the editor bundle reads for its key handling), plus the icons of the actions the menus in server/web/tables.ts
list that the toolbar spec does not already carry (kicad-menu-icons.json, chrome bundle only).

Run from the repository root:  python3 server/scripts/gen_kicad_menus.py
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(__file__))
import gen_kicad_ui as base  # noqa: E402

OUT = os.path.join(base.ROOT, "server", "web", "generated", "kicad-menu-spec.json")
OUT_ICONS = os.path.join(base.ROOT, "server", "web", "generated", "kicad-menu-icons.json")
UI_SPEC = os.path.join(base.ROOT, "server", "web", "generated", "kicad-ui-spec.json")
TABLES = os.path.join(base.ROOT, "server", "web", "tables.ts")
# Icons the menu chrome uses that belong to no action (sub-menu titles, the About box).
EXTRA_ICONS = {"import", "export_file", "fabrication", "language", "add_zone", "contrast_mode", "mw_add_line", "add_aligned_dimension",
               "measurement", "mode_module", "puzzle_piece", "swap", "locked", "show_ratsnest", "group", "component_select_unit",
               "special_tools", "align_items", "convert", "unit_mm", "checked_ok", "right", "text_align_left", "icon_kicad", "hotkeys", "about"}


MAC_IF = r"#\s*if(?:def\s+|\s+defined\(\s*)__WX(?:OSX_)?MAC__[ \t]*\)?[^\n]*\n"


def platform_branch(s, mac):
    """Resolve the #if __WXMAC__ … #else … #endif blocks to one platform's branch."""
    s = re.sub(MAC_IF + r"(.*?)#\s*else[^\n]*\n(.*?)#\s*endif", lambda m: m.group(1 if mac else 2), s, flags=re.S)
    return re.sub(MAC_IF + r"(.*?)#\s*endif", lambda m: m.group(1) if mac else "", s, flags=re.S)


def fmt_hotkey(expr):
    """"MD_CTRL + MD_SHIFT + 'G'" → "Ctrl+Shift+G"; ' ' is Space, '\\\\' the backslash, '\\'' the apostrophe."""
    expr = expr.strip()
    if not expr or expr == "0":
        return None
    mods = [label for mod, label in (("MD_CTRL", "Ctrl"), ("MD_SHIFT", "Shift"), ("MD_ALT", "Alt")) if mod in expr]
    key = None
    m = re.search(r"'(\\.|[^'\\])'", expr)
    if m:
        c = m.group(1)
        c = c[1] if c.startswith("\\") else c
        key = "Space" if c == " " else c.upper() if c.isalpha() else c
    else:
        for k, v in base.KEYS.items():
            if re.search(r"\b" + k + r"\b", expr):
                key = v
                break
    return "+".join(mods + [key]) if key else None


def parse_actions(mac=False):
    """All TOOL_ACTIONs of one platform: {"CLS::name": {id, label, tip, icon, key, alt}}."""
    out = {}
    for src in base.ACTION_SOURCES:
        s = platform_branch(base.read(src), mac)
        for m in re.finditer(r"TOOL_ACTION\s+(\w+)::(\w+)\s*\(\s*TOOL_ACTION_ARGS\(\)(.*?)\)\s*;", s, re.S):
            cls, name, body = m.groups()

            def field(key):
                r = re.search(r"\." + key + r"\(\s*_?\(?\s*((?:\"(?:[^\"\\]|\\.)*\"\s*)+)", body)
                if not r:
                    return None
                return "".join(p.replace('\\"', '"') for p in re.findall(r"\"((?:[^\"\\]|\\.)*)\"", r.group(1)))

            icon = re.search(r"\.Icon\(\s*BITMAPS::(\w+)", body)
            hk = re.search(r"\.DefaultHotkey\(\s*([^)]*)\)", body)
            alt = re.search(r"\.DefaultHotkeyAlt\(\s*([^)]*)\)", body)
            label = field("FriendlyName")
            if not label:
                continue
            a = {"id": name, "label": label, "tip": field("Tooltip"), "icon": icon.group(1) if icon else None,
                 "key": fmt_hotkey(hk.group(1)) if hk else None}
            if alt and fmt_hotkey(alt.group(1)):
                a["alt"] = fmt_hotkey(alt.group(1))
            out[f"{cls}::{name}"] = a
    return out


def all_actions():
    """The Linux / Windows table, each action carrying "mac" where the macOS default hotkey differs ("" = none there)."""
    actions, mac = parse_actions(False), parse_actions(True)
    for name, a in actions.items():
        m = mac.get(name)
        if m and m["key"] != a["key"]:
            a["mac"] = m["key"] or ""
    return actions


def main():
    actions = all_actions()
    with open(UI_SPEC, encoding="utf-8") as f:
        have = set(json.load(f)["icons"])
    with open(TABLES, encoding="utf-8") as f:
        t = f.read()
    menus = t[t.index("export const MENUS"):t.index("export const HOME_MENUS")]
    listed = set(re.findall(r"\"([A-Za-z0-9]+)(?:\|[^\"]*)?\"", menus))
    names = set(EXTRA_ICONS)
    for a in actions.values():
        if a["id"] in listed and a["icon"] and a["icon"] != "INVALID_BITMAP":
            names.add(a["icon"])
    icons = base.collect_icons(names - have)
    note = "server/scripts/gen_kicad_menus.py from KiCad's TOOL_ACTIONs and resources/bitmaps_png — do not edit by hand"
    for path, data in ((OUT, {"generated": note, "actions": actions}), (OUT_ICONS, {"generated": note, "icons": icons})):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
            f.write("\n")
    print("actions:", len(actions), "icons:", len(icons), "bytes:", os.path.getsize(OUT), os.path.getsize(OUT_ICONS))


if __name__ == "__main__":
    main()
