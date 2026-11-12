# board: demos/ecc83/ecc83-pp.kicad_pcb
# insert: (gr_rect (start 121.285 90.17) (end 173.355 136.525) (stroke (width 0.1) (type default)) (fill no) (layer "Cmts.User") (uuid "5b0e6c1e-7d0a-4c55-9a55-0f3f6a1c2d01"))
# select: 5b0e6c1e-7d0a-4c55-9a55-0f3f6a1c2d01
"""KiPNG: a rectangle around the board is selected as the viewport (the plugin asks for that before it opens); then the
"Front" preset and "Generate PNG".  The plugin exports the layers as SVG with kicad-cli, stacks them, and has cairosvg
draw the PNG, which must come out at the size it announced and with the board actually on it."""
import glob
import os

from drive_util import windows, click, texts, messages


def after_run(_action):
    assert windows(), "the plugin's window did not open: %s" % messages()[-2:]
    click("Front")
    before = set(glob.glob("/project/*.png"))
    click("Generate PNG")
    made = sorted(set(glob.glob("/project/*.png")) - before)
    assert made, "no PNG was written: %s / %s" % (messages()[-3:], [t for t in texts() if t][-6:])
    from PIL import Image
    im = Image.open(made[0]).convert("RGBA")
    colours = im.getcolors(1 << 24) or []
    drawn = sum(n for n, c in colours if c[3] > 0)
    import wx
    if wx._DOM:      # this harness's stand-in editor exports blank layers; in the browser the board must be on the picture
        assert drawn > im.width * im.height * 0.01, "the PNG is empty (%d of %d pixels drawn)" % (drawn, im.width * im.height)
    announced = [t.strip() for t in texts() if "x" in t and t.strip().replace("x", "").isdigit()]
    if announced:
        assert announced[0] == "%dx%d" % im.size, "the PNG is %dx%d, the window announced %s" % (im.width, im.height, announced[0])
    return {"file": os.path.basename(made[0]), "size": [im.width, im.height], "announced": announced[:1], "pixels_drawn": drawn, "colours": len(colours)}
