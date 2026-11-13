"""Board stackups, materials, finishes and what each fabricator can build.

    board.stackup(fab="jlcpcb", layers=4)                  # JLC04161H-7628, their 1.6 mm four-layer build, plus their limits as rules
    board.stackup(fab="jlcpcb", layers=4, build="JLC04161H-3313")
    board.stackup(fab="jlcpcb", material="flex", layers=2) # 0.11 mm polyimide, coverlay, ENIG, flex limits as rules
    board.stackup(material="ro4350b", thickness=0.508)     # two-layer RF laminate
    board.stackup()                                        # what the board has now
    board.bend_area([x0, y0, x1, y1])                      # where a flex board bends: vias and parts are kept out
    kh.materials.choose(ghz=5.8)                           # which material, finish and layer count suit the job, and why
    kh.FABS["jlcpcb"]["flex"]                              # a fabricator's limits

Choose the stackup BEFORE placing or routing: the 50 ohm width, the via size, the clearances and the layer count all
follow from it.  The fabricator figures are from JLCPCB's and PCBWay's capability and stackup pages (read 2026-11);
where a page did not give a figure the entry says "derived" or "typical" and the order should be checked against the
fabricator's own calculator.  Material constants are the makers' datasheet values.
"""
from __future__ import annotations

from .transport import HarnessError

OZ = 0.035          # 1 oz copper, mm

# name: dielectric constant, loss tangent, what it is for
MATERIALS = {
    "fr4": {"name": "FR4", "epsilon_r": 4.5, "loss_tangent": 0.02, "use": "Everything up to a few gigahertz on short runs: digital, power, 2.4 GHz radios with the antenna close to the chip."},
    "fr4-tg170": {"name": "FR4 TG170", "epsilon_r": 4.5, "loss_tangent": 0.02, "use": "Lead-free assembly of thick or many-layer boards, hot environments, automotive: FR-4 that keeps its shape to 170 C."},
    "polyimide": {"name": "Polyimide", "epsilon_r": 3.3, "loss_tangent": 0.008, "use": "Flex circuits: cables, hinges, folded boards, wearables.  Bends; everything else is harder (ENIG only, parts need stiffeners)."},
    "aluminium": {"name": "Aluminium core", "epsilon_r": 4.5, "loss_tangent": 0.02, "use": "LED boards and power stages that must dump heat: one copper layer on a thin dielectric on an aluminium plate.  Surface-mount only, no plated holes."},
    "copper-core": {"name": "Copper core", "epsilon_r": 4.5, "loss_tangent": 0.02, "use": "The hottest LEDs and power parts: like aluminium core with about twice the heat spreading, heavier and dearer."},
    "ro4350b": {"name": "Rogers RO4350B", "epsilon_r": 3.66, "loss_tangent": 0.0037, "use": "RF from about 3 GHz up, or long 50 ohm runs, filters and couplers at any frequency: a quarter of FR-4's loss and a dielectric constant held to a tight tolerance.  Processes like FR-4."},
    "ro4003c": {"name": "Rogers RO4003C", "epsilon_r": 3.55, "loss_tangent": 0.0027, "use": "As RO4350B with a little less loss; not flame rated."},
    "ro3003": {"name": "Rogers RO3003", "epsilon_r": 3.0, "loss_tangent": 0.001, "use": "Millimetre-wave (24 and 77 GHz radar): ceramic-filled PTFE, very low loss, stable over temperature."},
    "ptfe": {"name": "PTFE", "epsilon_r": 2.2, "loss_tangent": 0.0009, "use": "The lowest loss there is (RT/duroid 5880 class): microwave and millimetre-wave antennas, low-noise front ends.  Soft, dear, two layers at most at prototype fabs."},
}
_MAT_ALIAS = {"fr-4": "fr4", "flex": "polyimide", "pi": "polyimide", "fpc": "polyimide", "kapton": "polyimide", "aluminum": "aluminium", "al": "aluminium", "ims": "aluminium", "mcpcb": "aluminium",
              "copper": "copper-core", "copper core": "copper-core", "rogers": "ro4350b", "ro4350": "ro4350b", "ro4003": "ro4003c", "teflon": "ptfe", "duroid": "ptfe", "high-tg": "fr4-tg170", "tg170": "fr4-tg170"}

# what to ask for -> KiCad's name for it (Board Setup, Board Finish)
FINISHES = {
    "none": ("None", ""),
    "hasl": ("HAL SnPb", "Cheapest, solders well, leaded.  The surface is uneven: not for 0.5 mm pitch and finer, BGAs or QFNs."),
    "hasl-lf": ("HAL lead-free", "Lead-free and cheap.  Uneven like leaded HASL: not for fine pitch."),
    "enig": ("ENIG", "Flat gold over nickel: the one to use for BGAs, QFNs, 0.5 mm pitch and finer, flex boards, touch pads and contacts that are pressed rather than soldered.  Keeps on the shelf."),
    "enepig": ("ENEPIG", "ENIG with a palladium layer: for wire bonding and the most demanding joints."),
    "osp": ("OSP", "A flat organic coating: cheap and good for fine pitch, but it keeps only months and tolerates few reflow passes."),
    "immersion-silver": ("Immersion silver", "Flat and low loss at microwave frequencies; tarnishes, so pack and assemble promptly."),
    "immersion-tin": ("Immersion tin", "Flat, good for press-fit pins; short shelf life."),
    "hard-gold": ("Hard gold", "Thick plated gold for edge connectors and contacts that are mated many times.  Not for soldering."),
}
_FIN_ALIAS = {"hal": "hasl", "leaded hasl": "hasl", "lead-free hasl": "hasl-lf", "lead free hasl": "hasl-lf", "hasl lead-free": "hasl-lf", "lf-hasl": "hasl-lf", "immersion gold": "enig", "gold": "enig", "silver": "immersion-silver", "tin": "immersion-tin", "gold fingers": "hard-gold"}

# What each fabricator can make, mm.  "rules" is what board.stackup() writes into the board's design rules.
FABS = {
    "jlcpcb": {
        "name": "JLCPCB",
        "rigid": {"layers": "1 to 32", "thickness": [0.4, 0.6, 0.8, 1.0, 1.2, 1.6, 2.0], "outer_copper_oz": [1, 2], "inner_copper_oz": [0.5, 1, 2],
                  "track_space": {"1oz 2-layer": 0.10, "1oz multilayer": 0.09, "2oz 2-layer": 0.16, "2oz multilayer": 0.15},
                  "via": {"hole": 0.15, "diameter": 0.25, "preferred_hole": 0.2, "note": "the via pad is at least 0.1 mm (better 0.15) larger than its hole; 0.3 mm hole with a 0.6 mm pad costs nothing extra"},
                  "annular_ring": 0.15, "hole_to_hole": 0.2, "via_to_track": 0.2, "pth_to_track": 0.28, "copper_to_edge": 0.2, "copper_to_vcut": 0.4,
                  "mask_bridge": 0.10, "silk_line": 0.15, "silk_height": 1.0, "castellated_hole": 0.5, "bga_pad": 0.25,
                  "finishes": ["hasl", "hasl-lf", "enig", "osp"], "finish_notes": "No HASL on six layers and up, on boards 0.4 mm thick, or on RF laminates.  Aluminium boards are HASL only.",
                  "impedance": "controlled on 4 layers and up, +/-10 percent"},
        "flex": {"layers": [1, 2, 4], "thickness": {"1": [0.07, 0.11, 0.12], "2": [0.11, 0.12, 0.2, 0.19], "4": [0.2, 0.25, 0.3, 0.35, 0.4, 0.45]}, "copper_um": [12, 18, 35],
                 "track_space": {"12um": 0.076, "18um": 0.09, "35um": 0.10}, "via": {"hole": 0.3, "diameter": 0.55, "extreme": "0.10 / 0.30 on two layers, 0.15 / 0.35 on four, at extra cost"},
                 "annular_ring": 0.18, "copper_to_edge": 0.3, "coverlay_opening_to_track": 0.15, "coverlay_bridge": 0.5, "silk_line": 0.15, "silk_height": 1.0,
                 "stiffeners": {"polyimide": [0.1, 0.15, 0.2, 0.225, 0.25], "fr4": [0.1, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.6], "steel": [0.1, 0.2, 0.3], "tape": ["3M9077 0.05", "3M468 0.13", "tesa8854 0.1"]},
                 "finishes": ["enig"], "bend_radius": "6 x thickness for one layer, 10 x for more, bent once; 10 to 15 x and adhesiveless polyimide if it flexes in use",
                 "connector": "a 0.3 mm FPC connector takes the 0.11 mm board plus a 0.225 mm polyimide stiffener behind the contacts", "impedance": "not controlled; width only", "rigid_flex": False},
        "metal": {"layers": [1], "finishes": ["hasl", "hasl-lf"], "note": "Aluminium and copper core are single-layer."},
        "rf": {"layers": [2], "note": "Two-layer Rogers and PTFE cores, 1 oz copper; no HASL."},
    },
    "pcbway": {
        "name": "PCBWay",
        "rigid": {"layers": "1 to 14 quick-turn, more as advanced", "thickness": [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.6, 2.0, 2.4, 2.6, 2.8, 3.0, 3.2], "outer_copper_oz": [1, 2, 3, 4, 5, 6, 7, 8], "inner_copper_oz": [1, 1.5, 2, 3, 4],
                  "track_space": {"standard": 0.10, "1oz advanced (no surcharge)": 0.127, "2oz": 0.18},
                  "via": {"hole": 0.2, "diameter": 0.45, "note": "0.15 mm holes are an extra charge; hole to board thickness no more than 1:8"},
                  "annular_ring": 0.15, "hole_to_hole": 0.28, "copper_to_edge": 0.25, "mask_bridge": 0.10, "silk_line": 0.15, "silk_height": 0.8, "castellated_hole": 0.4,
                  "finishes": ["hasl", "hasl-lf", "enig", "osp", "hard-gold", "immersion-silver", "immersion-tin", "enepig"], "impedance": "+/-10 percent"},
        "flex": {"layers": "1 to 12", "track_space": {"all": 0.05}, "via": {"hole": 0.1, "diameter": 0.3}, "coverlay_bridge": 0.2, "copper_to_edge": 0.3,
                 "finishes": ["hasl", "enig", "enepig", "hard-gold", "immersion-silver", "osp", "immersion-tin"], "bend_radius": "3 to 6 x thickness for one layer, 7 to 10 x for two, 10 to 15 x for more",
                 "impedance": "+/-10 percent at 50 ohm and above", "rigid_flex": True, "note": "copper to edge and the via pad are derived (the page gives the drill only)"},
        "metal": {"layers": [1, 2], "note": "Aluminium and copper base."},
        "rf": {"layers": "2 and up", "note": "Rogers 4000 series alone or mixed with FR-4, PTFE; pure PTFE multilayer is not made."},
    },
}
_FAB_ALIAS = {"jlc": "jlcpcb", "jlcpcb": "jlcpcb", "pcbway": "pcbway", "pcb way": "pcbway"}


def _cu(name, oz):
    return {"name": name, "type": "copper", "thickness": round(OZ * oz, 4)}


def _di(kind, t, material="FR4", er=4.5, loss=0.02):
    return {"type": kind, "thickness": round(t, 4), "material": material, "epsilon_r": er, "loss_tangent": loss}


def _names(n):
    return ["F.Cu"] + [f"In{i}.Cu" for i in range(1, n - 1)] + ["B.Cu"]


# The fabricators' own named builds, as their stackup pages give them (copper, prepreg and core thickness in mm).
BUILDS = {
    "JLC04161H-7628": {"fab": "jlcpcb", "layers": 4, "thickness": 1.6, "pre": [("7628", 0.2104, 4.4)], "core": 1.065, "inner_oz": 0.0152 / OZ, "note": "JLCPCB's default four-layer build: 50 ohm on the outer layers is a track about 0.35 mm wide."},
    "JLC04161H-3313": {"fab": "jlcpcb", "layers": 4, "thickness": 1.6, "pre": [("3313", 0.0994, 4.1)], "core": 1.265, "inner_oz": 0.0152 / OZ, "note": "Thin prepreg: 50 ohm on the outer layers is a track about 0.17 mm wide, which suits fine-pitch chips and RF."},
    "JLC04161H-1080": {"fab": "jlcpcb", "layers": 4, "thickness": 1.6, "pre": [("1080", 0.0764, 3.91)], "core": 1.265, "inner_oz": 0.0152 / OZ, "note": "The thinnest prepreg: tightest coupling to the plane, narrowest 50 ohm track."},
    "JLC06161H-3313": {"fab": "jlcpcb", "layers": 6, "thickness": 1.6, "six": [("3313", 0.0994, 4.1), 0.55, ("2116", 0.1088, 4.16), 0.55, ("3313", 0.0994, 4.1)], "inner_oz": 0.0152 / OZ, "note": "JLCPCB's six-layer build with thin outer prepreg."},
    "JLC06161H-7628": {"fab": "jlcpcb", "layers": 6, "thickness": 1.6, "six": [("7628", 0.2104, 4.4), 0.4, ("7628", 0.2028, 4.4), 0.4, ("7628", 0.2104, 4.4)], "inner_oz": 0.0152 / OZ, "note": "JLCPCB's six-layer build in 7628."},
    "PCBWAY-4L-1.6": {"fab": "pcbway", "layers": 4, "thickness": 1.6, "pre": [("7628", 0.1855, 4.74)], "core": 1.03, "inner_oz": 1.0, "note": "PCBWay's 1.6 mm four-layer build with 1 oz inner copper."},
}
_DEFAULT_BUILD = {("jlcpcb", 4): "JLC04161H-7628", ("jlcpcb", 6): "JLC06161H-3313", ("pcbway", 4): "PCBWAY-4L-1.6"}


def material(name: str) -> dict:
    """A material's constants and what it is for: material("rogers"), material("flex")."""
    key = str(name or "fr4").strip().lower()
    key = _MAT_ALIAS.get(key, key)
    if key not in MATERIALS:
        raise HarnessError(f'No material "{name}". Known: {", ".join(MATERIALS)}.')
    return dict(MATERIALS[key], key=key)


def _fab(name):
    if not name:
        return None
    key = _FAB_ALIAS.get(str(name).strip().lower())
    if not key:
        raise HarnessError(f'No fabricator "{name}". Known: {", ".join(FABS)}.')
    return key


def build(fab: str | None = None, layers: int = 2, thickness: float | None = None, material_name: str = "fr4", copper_oz: float = 1.0, name: str | None = None) -> dict:
    """The stack for an order: {"layers": [...top to bottom...], "thickness", "mask", "title", "derived", "notes"}.

    A named build (BUILDS) is the fabricator's own figures.  Anything else is worked out from the board thickness
    and is marked derived: check it against the fabricator's calculator before ordering controlled impedance."""
    fab = _fab(fab)
    m = material(material_name)
    notes: list = []
    if name or (m["key"] == "fr4" and thickness in (None, 1.6) and (fab, layers) in _DEFAULT_BUILD and copper_oz == 1.0):
        bname = name or _DEFAULT_BUILD[(fab, layers)]
        b = BUILDS.get(bname)
        if not b:
            raise HarnessError(f'No build "{bname}". Known: {", ".join(BUILDS)}.')
        n = b["layers"]
        cu = _names(n)
        if n == 4:
            p = b["pre"][0]
            rows = [_cu(cu[0], 1), _di("prepreg", p[1], p[0], p[2]), _cu(cu[1], b["inner_oz"]), _di("core", b["core"], "FR4", 4.6), _cu(cu[2], b["inner_oz"]), _di("prepreg", p[1], p[0], p[2]), _cu(cu[3], 1)]
        else:
            s = b["six"]
            rows = [_cu(cu[0], 1), _di("prepreg", s[0][1], s[0][0], s[0][2]), _cu(cu[1], b["inner_oz"]), _di("core", s[1], "FR4", 4.6), _cu(cu[2], b["inner_oz"]),
                    _di("prepreg", s[2][1], s[2][0], s[2][2]), _cu(cu[3], b["inner_oz"]), _di("core", s[3], "FR4", 4.6), _cu(cu[4], b["inner_oz"]), _di("prepreg", s[4][1], s[4][0], s[4][2]), _cu(cu[5], 1)]
        return {"layers": rows, "thickness": b["thickness"], "mask": {"thickness": 0.01, "epsilon_r": 3.8}, "title": bname, "derived": False, "notes": [b["note"]], "fab": b["fab"], "material": "fr4"}

    key = m["key"]
    if key == "polyimide":
        if layers not in (1, 2, 4):
            notes.append("Prototype flex is one, two or four layers; more is a quoted job.")
        n = max(2, layers)
        cu_t = 0.018 if copper_oz == 1.0 else round(OZ * copper_oz, 4)       # half-ounce is the flex default: thinner copper bends further
        thick_pi = thickness is not None and thickness >= 0.17 and n == 2
        pi = 0.05 if thick_pi else 0.025
        cover = {"thickness": 0.05 if thick_pi else 0.0275, "material": "Polyimide coverlay", "epsilon_r": 2.9, "color": "Yellow"}
        rows = []
        for i, nm in enumerate(_names(n)):
            rows.append({"name": nm, "type": "copper", "thickness": cu_t})
            if i < n - 1:
                rows.append(_di("core" if i % 2 == 0 else "prepreg", pi, "Polyimide", 3.3, 0.008))
        total = round(sum(r["thickness"] for r in rows) + 2 * cover["thickness"], 3)
        if layers == 1:
            notes.append("A one-layer flex has copper on the front only: keep B.Cu empty.")
        if n > 2:
            notes.append("The four-layer flex stack is derived: the fabricator's page gives finished thicknesses (0.2 to 0.45 mm), not the layers.")
        notes.append(f"Bend it no tighter than {round(total * (6 if layers == 1 else 10), 2)} mm radius once, {round(total * 15, 2)} mm if it flexes in use. Parts and connector contacts need a stiffener behind them.")
        return {"layers": rows, "thickness": total, "mask": cover, "title": f"{n}-layer flex, {int(pi * 1000)} um polyimide", "derived": n > 2 or fab == "pcbway", "notes": notes, "fab": fab, "material": key, "finish": "enig"}
    if key in ("aluminium", "copper-core"):
        total = thickness or 1.6
        rows = [_cu("F.Cu", copper_oz), _di("prepreg", 0.1, "Thermal dielectric", 4.5, 0.02), _di("core", round(total - 0.1 - 2 * OZ * copper_oz, 4), m["name"], 4.5, 0.02), _cu("B.Cu", copper_oz)]
        notes.append(f"{m['name']} boards are one-sided: every part is surface-mount on the front, nothing is routed on B.Cu and there are no vias. The review holds the board to that. The 0.1 mm dielectric is a typical figure.")
        return {"layers": rows, "thickness": total, "mask": {"thickness": 0.01, "epsilon_r": 3.8, "color": "White"}, "title": f"{m['name']}, {total} mm", "derived": True, "notes": notes, "fab": fab, "material": key, "finish": "hasl-lf"}
    if key in ("ro4350b", "ro4003c", "ro3003", "ptfe"):
        if layers != 2:
            notes.append("Prototype RF laminate is two layers. For more, ask for a hybrid: the RF laminate as the outer pair on an FR-4 core (PCBWay quotes it).")
        total = thickness or 0.508
        rows = [_cu("F.Cu", copper_oz), _di("core", round(total - 2 * OZ * copper_oz, 4) if total > 0.3 else total, m["name"], m["epsilon_r"], m["loss_tangent"]), _cu("B.Cu", copper_oz)]
        notes.append("The usual cores are 0.254, 0.508, 0.762 and 1.524 mm; confirm the one the fabricator stocks.")
        return {"layers": rows, "thickness": total, "mask": {"thickness": 0.01, "epsilon_r": 3.8}, "title": f"{m['name']}, {total} mm", "derived": True, "notes": notes, "fab": fab, "material": key, "finish": "enig"}

    # FR-4, any layer count and thickness
    total = thickness or 1.6
    n = max(2, layers)
    cu = _names(n)
    er, loss, mat = m["epsilon_r"], m["loss_tangent"], m["name"]
    if n == 2:
        rows = [_cu(cu[0], copper_oz), _di("core", round(total - 2 * OZ * copper_oz, 4), mat, er, loss), _cu(cu[1], copper_oz)]
        return {"layers": rows, "thickness": total, "mask": {"thickness": 0.01, "epsilon_r": 3.8}, "title": f"2-layer {mat}, {total} mm", "derived": False, "notes": [f"On two layers a 50 ohm track over {total} mm of board is about {round(total * 1.85, 2)} mm wide: use four layers, or a coplanar track with ground beside it, for radio and fast signals."], "fab": fab, "material": key}
    inner = 0.5 if fab == "jlcpcb" else 1.0
    pre = min(0.2104, max(0.0764, (total - n * OZ) / (n - 1) * 0.6))
    gaps = n - 1
    kinds = ["prepreg" if (i % 2 == 0) else "core" for i in range(gaps)]
    n_pre = kinds.count("prepreg")
    copper_total = 2 * OZ * copper_oz + (n - 2) * OZ * inner
    core = max(0.08, (total - copper_total - n_pre * pre) / max(1, kinds.count("core")))
    rows = []
    for i, nm in enumerate(cu):
        rows.append(_cu(nm, copper_oz if i in (0, n - 1) else inner))
        if i < gaps:
            rows.append(_di(kinds[i], pre if kinds[i] == "prepreg" else core, "7628" if kinds[i] == "prepreg" and pre > 0.15 else mat, 4.4 if kinds[i] == "prepreg" else 4.6, loss))
    notes.append("This stack is derived from the board thickness. For controlled impedance use one of the fabricator's named builds (kh.BUILDS) or their calculator.")
    return {"layers": rows, "thickness": total, "mask": {"thickness": 0.01, "epsilon_r": 3.8}, "title": f"{n}-layer {mat}, {total} mm", "derived": True, "notes": notes, "fab": fab, "material": key}


def rules_for(fab: str, material_name: str = "fr4", layers: int = 2, copper_oz: float = 1.0) -> dict:
    """The fabricator's limits as design rules (mm), for board.rules(**...)."""
    f = FABS[_fab(fab)]
    key = material(material_name)["key"]
    if key == "polyimide":
        x = f["flex"]
        ts = x["track_space"]
        w = ts.get("all") or (ts["35um"] if copper_oz > 1.0 else ts["18um"])
        return {"min_track_width": w, "min_clearance": w, "edge_clearance": x["copper_to_edge"], "hole_clearance": 0.2, "via_diameter": max(0.55, x["via"]["diameter"]), "via_drill": max(0.3, x["via"]["hole"])}
    r = f["rigid"]
    ts = r["track_space"]
    if _fab(fab) == "jlcpcb":
        w = ts[("2oz" if copper_oz >= 2 else "1oz") + (" multilayer" if layers > 2 else " 2-layer")]
    else:
        w = ts["2oz"] if copper_oz >= 2 else ts["1oz advanced (no surcharge)"]
    return {"min_track_width": w, "min_clearance": w, "edge_clearance": max(0.2, r["copper_to_edge"]), "hole_clearance": r.get("via_to_track", 0.2)}


def choose(ghz: float | None = None, flex: bool = False, dynamic: bool = False, watts: float | None = None, led: bool = False, fine_pitch: float | None = None,
           bga: bool = False, fast: bool = False, radio: bool = False, edge_connector: bool = False, lead_free: bool = True) -> dict:
    """Which material, layer count and finish suit a board, and why.

    ghz: the highest radio frequency on it.  flex: it must bend (dynamic: it bends in use, not just once at
    assembly).  watts / led: heat to get rid of.  fine_pitch: the finest pin pitch in mm.  bga: it has a BGA.
    fast: USB 3, HDMI, DDR, PCIe or the like.  radio: any antenna.  edge_connector: gold fingers.
    Returns {"material", "layers", "finish", "why": [...], "stackup": the arguments for board.stackup()}."""
    why: list = []
    mat, layers, finish = "fr4", 2, "hasl-lf" if lead_free else "hasl"
    if flex:
        mat, layers, finish = "polyimide", 2, "enig"
        why.append("It bends, so it is a polyimide flex circuit; the finish is ENIG (the only one prototype flex fabs offer, and it is flat).")
        if dynamic:
            layers = 1 if not (fast or radio) else 2
            why.append("It flexes in use: one or two layers, the thinnest copper, adhesiveless polyimide, bend radius at least 10 to 15 times the thickness, no vias or parts in the bend.")
        else:
            why.append("It bends once at assembly: radius at least 6 times the thickness for one layer, 10 times for two or more.")
    elif (watts and watts >= 3 and not (fast or radio or bga)) or led:
        mat, layers = ("copper-core" if watts and watts >= 30 else "aluminium"), 1
        why.append("The heat goes straight through a thin dielectric into a metal plate; that beats any number of thermal vias in FR-4. One copper layer, surface-mount parts only.")
    elif ghz and ghz >= 20:
        mat, layers, finish = "ro3003", 2, "immersion-silver"
        why.append("Above about 20 GHz only PTFE-based laminate keeps the loss and the dielectric constant in hand; silver or ENIG, never HASL.")
    elif ghz and ghz >= 3:
        mat, layers, finish = "ro4350b", 2, "enig"
        why.append(f"At {ghz} GHz FR-4 loses several times what a hydrocarbon-ceramic laminate does and its dielectric constant varies from batch to batch; RO4350B holds 50 ohm and filter dimensions. If only a short feed carries the signal (a chip antenna beside the radio), four-layer FR-4 still does.")
    if mat == "fr4":
        if fast or radio or bga or (ghz and ghz >= 0.4):
            layers = 4
            why.append("Four layers: a solid ground plane directly under the top layer gives every fast or radio track its return path and a 50 ohm width that is routable.")
        if bga and fine_pitch and fine_pitch <= 0.65:
            layers = 6
            why.append("A BGA at 0.65 mm pitch or finer needs more escape layers; at 0.4 mm it needs HDI (laser microvias in the pads), which is a quoted job.")
        if fast and layers < 6 and bga:
            layers = 6
            why.append("Six layers let the fast buses run between two ground planes.")
    if mat in ("fr4", "fr4-tg170"):
        if bga or (fine_pitch and fine_pitch <= 0.5) or radio or layers >= 6:
            finish = "enig"
            why.append("ENIG: flat pads for the fine-pitch parts" + (", and JLCPCB does not offer HASL on six layers" if layers >= 6 else "") + ".")
        if edge_connector:
            why.append("Ask for hard gold on the edge-connector fingers, with a bevel; ENIG wears through after a few insertions.")
    return {"material": mat, "layers": layers, "finish": finish, "why": why, "stackup": {"material": mat, "layers": layers, "finish": finish}}


class materials:      # noqa: N801  (a namespace: kh.materials.choose(...))
    """Board materials and finishes: kh.materials.table, kh.materials.finishes, kh.materials.get(name), kh.materials.choose(...)."""
    table = MATERIALS
    finishes = {k: v[1] for k, v in FINISHES.items() if v[1]}
    get = staticmethod(material)
    choose = staticmethod(choose)


def bend_radius(thickness: float, layers: int = 2, dynamic: bool = False) -> float:
    """The tightest radius in mm a flex board of this thickness should be bent to: 6 times the thickness for one
    layer and 10 times for more when it is bent once; 15 times when it flexes in use."""
    return round(thickness * (15 if dynamic else 6 if layers <= 1 else 10), 3)


def _stackup(self, fab: str | None = None, layers: int | None = None, thickness: float | None = None, material: str | None = None, finish: str | None = None,
             build: str | None = None, copper_oz: float = 1.0, rules: bool = True, custom: list | None = None) -> dict:
    """Read or set the board's physical stackup (KiCad's Board Setup, Physical Stackup).

    With no arguments: what the board has now ({"layers", "thickness", "finish", "flex", "outer": {"width_50_ohm"}}).
    fab: "jlcpcb" or "pcbway": their build for this layer count, and their manufacturing limits written into the
    design rules so the rule check holds the board to what they can make.  layers: the copper layer count (the
    board is changed to it).  material: "fr4", "flex", "aluminium", "copper-core", "rogers", "ptfe" (kh.MATERIALS).
    finish: "enig", "hasl", "hasl-lf", "osp", ... (kh.FINISHES).  build: one of the fabricator's named stacks
    (kh.BUILDS, for example "JLC04161H-3313").  custom: your own stack top to bottom, [{"name": "F.Cu", "type":
    "copper", "thickness": 0.035}, {"type": "prepreg", "thickness": 0.1, "material": "3313", "epsilon_r": 4.1}, ...].
    Do this before placing and routing: track widths for 50 and 90 ohm come from it.
    Returns what was set, with the 50 ohm width on the outer layer and notes on what the choice means."""
    from . import physics as _physics
    self.flush()
    if fab is None and layers is None and thickness is None and material is None and finish is None and build is None and custom is None:
        return _physics._plan(self, what="stackup")
    have = len(self.info().get("copper_layers") or ["F.Cu", "B.Cu"])
    notes: list = []
    if custom is not None:
        st = {"layers": list(custom), "thickness": thickness, "mask": {"thickness": 0.01, "epsilon_r": 3.8}, "title": "custom", "derived": False, "notes": [], "fab": _fab(fab), "material": globals()["material"](material or "fr4")["key"]}
        want = sum(1 for r in custom if r.get("type") == "copper")
    else:
        b = BUILDS.get(build) if build else None
        if build and not b:
            raise HarnessError(f'No build "{build}". Known: {", ".join(BUILDS)}.')
        want = b["layers"] if b else (layers or have)
        st = globals()["build"](fab or (b["fab"] if b else None), want, thickness, material or "fr4", copper_oz, build)
    want = max(2, want)
    if want != have:
        self.layers(want, planes=[f"In{i}.Cu" for i in range(1, want - 1) if i in (1, want - 2)] if want > 2 else None)
    fkey = str(finish or st.get("finish") or "").strip().lower()
    fkey = _FIN_ALIAS.get(fkey, fkey)
    if fkey and fkey not in FINISHES:
        raise HarnessError(f'No finish "{finish}". Known: {", ".join(FINISHES)}.')
    fabkey = st.get("fab")
    if fabkey and fkey and finish:
        group = "flex" if st["material"] == "polyimide" else "metal" if st["material"] in ("aluminium", "copper-core") else "rigid"
        offered = FABS[fabkey].get(group, {}).get("finishes")
        if offered and fkey not in offered:
            raise HarnessError(f"{FABS[fabkey]['name']} does not offer {FINISHES[fkey][0]} on this kind of board; it offers {', '.join(offered)}.")
        if fabkey == "jlcpcb" and group == "rigid" and fkey.startswith("hasl") and want >= 6:
            raise HarnessError("JLCPCB does not offer HASL on six layers and up; use ENIG.")
    e = {"op": "set_stackup", "layers": st["layers"], "mask": st["mask"], "title": st["title"], "controlled": bool(fabkey and want >= 4)}
    if st.get("thickness"):
        e["thickness"] = st["thickness"]
    if fkey:
        e["finish"] = FINISHES[fkey][0]
    self._edit(e)
    self.flush()
    self._geom = None
    applied = None
    if rules and fabkey:
        applied = rules_for(fabkey, st["material"], want, copper_oz)
        self.rules(**applied)
    now = _physics._plan(self, what="stackup")
    notes += st["notes"]
    if fkey and FINISHES[fkey][1]:
        notes.append(f"{FINISHES[fkey][0]}: {FINISHES[fkey][1]}")
    if fabkey and FABS[fabkey].get("rigid", {}).get("finish_notes") and st["material"] == "fr4":
        notes.append(FABS[fabkey]["rigid"]["finish_notes"])
    out = {"build": st["title"], "fab": FABS[fabkey]["name"] if fabkey else None, "material": st["material"], "copper_layers": now.get("copper_layers"), "thickness": now.get("thickness"), "finish": now.get("finish"),
           "derived": st["derived"], "outer": now.get("outer"), "rules": applied, "notes": notes}
    return out


def _bend_area(self, box, name: str = "bend") -> None:
    """Mark where a flex board bends: a rule area over [x0, y0, x1, y1] on every copper layer that keeps vias and
    footprints out (the autorouter, the placer and the rule check honour it).  Tracks may cross it; the review
    checks that they cross straight, that the two sides are staggered and that no solid pour lies in it."""
    if "bend" not in name.lower() and "flex" not in name.lower() and "fold" not in name.lower():
        name = "bend " + name
    self.keepout(box, tracks=False, vias=True, copper=False, footprints=True, name=name)
    self.flush()


def install(Board) -> None:
    Board.stackup = _stackup
    Board.bend_area = _bend_area
