#!/usr/bin/env python3
"""Generate server/web/generated/kicad-context-spec.json: the TOOL_ACTION metadata and icons the
right-click context menus need beyond what the toolbar spec (kicad-ui-spec.json) already carries.

The menus themselves are transcribed in server/web/editor/ctxmenus.ts from the tools' Init()
functions; every entry there names its action the way the C++ does ("SCH_ACTIONS::rotateCCW",
"ACT_PlaceThroughVia") and every submenu its BITMAPS icon (icon: "zoom_selection").  This script
scans that file for those names and emits, for each, the friendly name, tooltip, icon and default
hotkey straight from the C++ tree, plus the icons the toolbar spec does not have:

  common/tool/actions.cpp, eeschema/tools/sch_actions.cpp, pcbnew/tools/pcb_actions.cpp,
  pcbnew/router/router_tool.cpp (the ACT_* router actions)            TOOL_ACTION metadata
  resources/bitmaps_png/sources/{light,dark}/<icon>.svg               icons

Run from the repository root:  python3 server/scripts/gen_kicad_context.py
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(__file__))
import gen_kicad_ui as ui  # noqa: E402

TABLES = os.path.join(ui.ROOT, "server", "web", "editor", "ctxmenus.ts")
OUT = os.path.join(ui.ROOT, "server", "web", "generated", "kicad-context-spec.json")
MAIN = os.path.join(ui.ROOT, "server", "web", "generated", "kicad-ui-spec.json")


def router_actions():
    """pcbnew/router/router_tool.cpp declares its actions as file-level statics: ACT_Name( TOOL_ACTION_ARGS()… )."""
    out = {}
    s = ui.read("pcbnew/router/router_tool.cpp")
    for m in re.finditer(r"static const TOOL_ACTION\s+(ACT_\w+)\s*\(\s*TOOL_ACTION_ARGS\(\)(.*?)\)\s*;", s, re.S):
        name, body = m.groups()

        def field(key):
            r = re.search(r"\." + key + r"\(\s*_?\(?\s*\"((?:[^\"\\]|\\.)*)\"", body)
            return r.group(1).replace('\\"', '"') if r else None

        icon = re.search(r"\.Icon\(\s*BITMAPS::(\w+)", body)
        hk = re.search(r"\.DefaultHotkey\(\s*(.*?)\)\s*\n", body)
        out[name] = {"id": name, "label": field("FriendlyName"), "tip": field("Tooltip"),
                     "icon": icon.group(1) if icon else None, "key": ui.fmt_hotkey(hk.group(1)) if hk else None}
    return out


def main():
    actions = ui.parse_actions()
    actions.update(router_actions())
    with open(TABLES, encoding="utf-8") as f:
        src = f.read()
    wanted = sorted(set(re.findall(r'"((?:ACTIONS|SCH_ACTIONS|PCB_ACTIONS)::\w+|ACT_\w+)"', src)))
    used, missing = {}, []
    for w in wanted:
        if w in actions:
            used[w] = actions[w]
        else:
            missing.append(w)
    if missing:
        print("unknown actions in ctxmenus.ts:", ", ".join(missing), file=sys.stderr)
        sys.exit(1)
    names = {a["icon"] for a in used.values() if a.get("icon")}
    names |= set(re.findall(r'\bicon:\s*"(\w+)"', src))
    names |= set(re.findall(r'new CondMenu\("[^"]*",\s*"(\w+)"\)', src))
    names.discard("INVALID_BITMAP")
    with open(MAIN, encoding="utf-8") as f:
        have = set(json.load(f)["icons"].keys())
    icons = ui.collect_icons(names - have)
    spec = {"generated": "server/scripts/gen_kicad_context.py from the TOOL_ACTIONs named in server/web/editor/ctxmenus.ts and resources/bitmaps_png — do not edit by hand",
            "actions": used, "icons": icons}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(spec, f, separators=(",", ":"), ensure_ascii=False)
        f.write("\n")
    print("context actions:", len(used), "extra icons:", len(icons), "bytes:", os.path.getsize(OUT))


if __name__ == "__main__":
    main()
