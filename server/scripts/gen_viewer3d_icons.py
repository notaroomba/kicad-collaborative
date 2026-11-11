#!/usr/bin/env python3
"""Generate server/web/viewer3d/icons.json: the icons of KiCad's 3D viewer toolbar, menus and
appearance panel (3d-viewer/3d_viewer/toolbars_3d.cpp, 3d_menubar.cpp, tools/eda_3d_actions.cpp),
taken from resources/bitmaps_png/sources/{light,dark} exactly as gen_kicad_ui.py does for the editors.

    python3 server/scripts/gen_viewer3d_icons.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_kicad_ui import collect_icons  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "viewer3d", "icons.json")

NAMES = [
    # EDA_3D_ACTIONS / ACTIONS used by the top toolbar, in toolbar order
    "import3d", "copy", "ray_tracing", "refresh", "zoom_in", "zoom_out", "zoom_fit_in_page",
    "rotate_cw_x", "rotate_ccw_x", "rotate_cw_y", "rotate_ccw_y", "rotate_cw_z", "rotate_ccw_z",
    "flip_board", "left", "right", "up", "down", "ortho", "layers_manager",
    # menus
    "export_file", "exit", "grid", "rotate_cw", "move",
    "axis3d_top", "axis3d_bottom", "axis3d_right", "axis3d_left", "axis3d_front", "axis3d_back",
    "show_tht", "show_smt", "show_other", "three_d",
]


def main():
    icons = collect_icons(NAMES)
    with open(OUT, "w") as f:
        json.dump(icons, f, separators=(",", ":"), sort_keys=True)
        f.write("\n")
    print("icons:", len(icons), "bytes:", os.path.getsize(OUT))


if __name__ == "__main__":
    main()
