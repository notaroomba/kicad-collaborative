"""kicad_ipc.py — KiCad's IPC API, answered inside the web editor.

KiCad's newer plugins do not import pcbnew: they are separate programs that talk to KiCad
through kipy (the kicad-python package), which sends protobuf requests over a socket.  Here
the real kipy runs unchanged; its socket (our pynng module) hands every request to handle()
below, which answers it from the same collaborative board the pcbnew module works on.  Edits
therefore go out the same way: as one change everyone in the document sees, one undo step.
"""

import json
import math
import os
import uuid as _uuid

import pcbnew

_P = {}            # the protobuf modules, imported on first use (they need the kipy package)
_state = {"commit": None, "label": "", "token": "kicad-web"}


class ApiFail(Exception):
    def __init__(self, message, code=None):
        Exception.__init__(self, message)
        self.code = code


def _p():
    if not _P:
        from kipy.proto.common import envelope_pb2
        from kipy.proto.common.types import base_types_pb2, enums_pb2, project_settings_pb2
        from kipy.proto.common.commands import base_commands_pb2, editor_commands_pb2, project_commands_pb2
        from kipy.proto.board import board_pb2, board_types_pb2, board_commands_pb2
        from google.protobuf import empty_pb2
        _P.update(env=envelope_pb2, base=base_types_pb2, en=enums_pb2, ps=project_settings_pb2, cc=base_commands_pb2, ec=editor_commands_pb2,
                  pc=project_commands_pb2, b=board_pb2, bt=board_types_pb2, bc=board_commands_pb2, empty=empty_pb2)
    return _P


def _web():
    import kicad_web
    return kicad_web


def _board():
    if pcbnew._Host.board is None:
        _web().load_board()
    return pcbnew._Host.board


# ----------------------------------------------------------------------------- small conversions

def _vec(dst, p):
    dst.x_nm, dst.y_nm = int(round(p.x)), int(round(p.y))


def _pt(v):
    return pcbnew.VECTOR2I(int(v.x_nm), int(v.y_nm))


def _layer(layer):
    bt = _p()["bt"]
    name = pcbnew.LayerName(int(layer)) if not isinstance(layer, str) else layer
    return getattr(bt, "BL_" + str(name).replace(".", "_"), bt.BL_UNDEFINED)


def _unlayer(bl):
    bt = _p()["bt"]
    try:
        name = bt.BoardLayer.Name(int(bl))
    except ValueError:
        return pcbnew.UNDEFINED_LAYER
    if not name.startswith("BL_") or name in ("BL_UNKNOWN", "BL_UNDEFINED", "BL_UNSELECTED"):
        return pcbnew.UNDEFINED_LAYER
    return pcbnew._layer_id(name[3:].replace("_", ".", 1))


def _locked(dst, item):
    base = _p()["base"]
    dst.locked = base.LS_LOCKED if _try(item.IsLocked, False) else base.LS_UNLOCKED


def _try(fn, default=None, *a):
    try:
        return fn(*a)
    except Exception:
        return default


def _id(item):
    return item.m_Uuid.AsString()


def _net(dst, item):
    code = _try(item.GetNetCode, 0) or 0
    dst.code.value = int(code)
    dst.name = str(_try(item.GetNetname, "") or "")


def _apply_net(item, net):
    board = _board()
    name = net.name
    if name:
        code = board.GetNetcodeFromNetname(name)
        if code is not None and code >= 0 and (code or not name):
            item.SetNetCode(code)
            return
        ni = board.FindNet(name)
        if ni is not None:
            item.SetNet(ni) if hasattr(item, "SetNet") else item.SetNetCode(ni.GetNetCode())
            return
        try:
            ni = pcbnew.NETINFO_ITEM(board, name)
            board.Add(ni)
            item.SetNetCode(ni.GetNetCode())
            return
        except Exception:
            pass
    item.SetNetCode(int(net.code.value))


def _parent(dst, item):
    fp = _try(item.GetParentFootprint)
    if fp is not None:
        dst.parent.value = _id(fp)
    else:
        g = _try(item.GetParentGroup)
        if g is not None:
            dst.parent.value = _id(g)


# ----------------------------------------------------------------------------- board items -> messages

def _track(t):
    m = _p()["bt"].Track()
    m.id.value = _id(t)
    _vec(m.start, t.GetStart())
    _vec(m.end, t.GetEnd())
    m.width.value_nm = int(t.GetWidth())
    _locked(m, t)
    m.layer = _layer(t.GetLayer())
    _net(m.net, t)
    return m


def _arc(t):
    m = _p()["bt"].Arc()
    m.id.value = _id(t)
    _vec(m.start, t.GetStart())
    _vec(m.mid, t.GetMid())
    _vec(m.end, t.GetEnd())
    m.width.value_nm = int(t.GetWidth())
    _locked(m, t)
    m.layer = _layer(t.GetLayer())
    _net(m.net, t)
    return m


_VIA_TYPES = None


def _via_types():
    global _VIA_TYPES
    if _VIA_TYPES is None:
        bt = _p()["bt"]
        _VIA_TYPES = {pcbnew.VIATYPE_THROUGH: bt.VT_THROUGH, pcbnew.VIATYPE_BLIND_BURIED: bt.VT_BLIND_BURIED, pcbnew.VIATYPE_MICROVIA: bt.VT_MICRO}
    return _VIA_TYPES


def _via(v):
    bt = _p()["bt"]
    m = bt.Via()
    m.id.value = _id(v)
    _vec(m.position, v.GetPosition())
    _locked(m, v)
    _net(m.net, v)
    m.type = _via_types().get(v.GetViaType(), bt.VT_THROUGH)
    top, bottom = v.TopLayer(), v.BottomLayer()
    ps = m.pad_stack
    ps.type = bt.PST_NORMAL
    ps.layers.extend([_layer(top), _layer(bottom)])
    ps.drill.start_layer, ps.drill.end_layer = _layer(top), _layer(bottom)
    d = int(v.GetDrill())
    ps.drill.diameter.x_nm = ps.drill.diameter.y_nm = d
    ps.drill.shape = bt.DS_CIRCLE
    ps.unconnected_layer_removal = bt.ULR_KEEP
    cl = ps.copper_layers.add()
    cl.layer = bt.BL_F_Cu
    cl.shape = bt.PSS_CIRCLE
    w = int(_try(v.GetWidth, 0, pcbnew.F_Cu) or _try(v.GetWidth, 0) or 0)
    cl.size.x_nm = cl.size.y_nm = w
    return m


_PAD_SHAPES = None


def _pad_shapes():
    global _PAD_SHAPES
    if _PAD_SHAPES is None:
        bt = _p()["bt"]
        _PAD_SHAPES = {pcbnew.PAD_SHAPE_CIRCLE: bt.PSS_CIRCLE, pcbnew.PAD_SHAPE_RECT: bt.PSS_RECTANGLE, pcbnew.PAD_SHAPE_OVAL: bt.PSS_OVAL,
                       pcbnew.PAD_SHAPE_TRAPEZOID: bt.PSS_TRAPEZOID, pcbnew.PAD_SHAPE_ROUNDRECT: bt.PSS_ROUNDRECT,
                       pcbnew.PAD_SHAPE_CHAMFERED_RECT: bt.PSS_CHAMFEREDRECT, pcbnew.PAD_SHAPE_CUSTOM: bt.PSS_CUSTOM}
    return _PAD_SHAPES


def _pad(p):
    bt = _p()["bt"]
    m = bt.Pad()
    m.id.value = _id(p)
    _locked(m, p)
    m.number = str(p.GetNumber())
    _net(m.net, p)
    a = p.GetAttribute()
    m.type = {pcbnew.PAD_ATTRIB_PTH: bt.PT_PTH, pcbnew.PAD_ATTRIB_SMD: bt.PT_SMD, pcbnew.PAD_ATTRIB_CONN: bt.PT_EDGE_CONNECTOR, pcbnew.PAD_ATTRIB_NPTH: bt.PT_NPTH}.get(a, bt.PT_SMD)
    _vec(m.position, p.GetPosition())
    fp = _try(p.GetParentFootprint)
    if fp is not None:
        m.parent.value = _id(fp)
    ps = m.pad_stack
    ps.type = bt.PST_NORMAL
    layers = [l for l in _try(lambda: list(p.GetLayerSet().Seq()), []) or []]
    ps.layers.extend([_layer(l) for l in layers])
    ps.angle.value_degrees = float(_try(p.GetOrientationDegrees, 0.0) or 0.0)
    dr = _try(p.GetDrillSize)
    if dr is not None and (dr.x or dr.y):
        ps.drill.diameter.x_nm, ps.drill.diameter.y_nm = int(dr.x), int(dr.y)
        ps.drill.shape = bt.DS_OBLONG if dr.x != dr.y else bt.DS_CIRCLE
        ps.drill.start_layer, ps.drill.end_layer = bt.BL_F_Cu, bt.BL_B_Cu
    cl = ps.copper_layers.add()
    cl.layer = bt.BL_F_Cu
    cl.shape = _pad_shapes().get(p.GetShape(), bt.PSS_RECTANGLE)
    size = p.GetSize()
    cl.size.x_nm, cl.size.y_nm = int(size.x), int(size.y)
    cl.corner_rounding_ratio = float(_try(p.GetRoundRectRadiusRatio, 0.0) or 0.0)
    off = _try(p.GetOffset)
    if off is not None:
        cl.offset.x_nm, cl.offset.y_nm = int(off.x), int(off.y)
    m.pad_to_die_length.value_nm = int(_try(p.GetPadToDieLength, 0) or 0)
    return m


def _text_attrs(dst, t):
    en = _p()["en"]
    size = _try(t.GetTextSize)
    if size is not None:
        dst.size.x_nm, dst.size.y_nm = int(size.x), int(size.y)
    dst.stroke_width.value_nm = int(_try(t.GetTextThickness, 0) or 0)
    dst.angle.value_degrees = float(_try(t.GetTextAngleDegrees, 0.0) or 0.0)
    dst.italic = bool(_try(t.IsItalic, False))
    dst.bold = bool(_try(t.IsBold, False))
    dst.mirrored = bool(_try(t.IsMirrored, False))
    dst.visible = bool(_try(t.IsVisible, True))
    dst.keep_upright = bool(_try(t.IsKeepUpright, True))
    h = _try(t.GetHorizJustify, 0)
    v = _try(t.GetVertJustify, 0)
    dst.horizontal_alignment = {-1: en.HA_LEFT, 0: en.HA_CENTER, 1: en.HA_RIGHT}.get(h, en.HA_CENTER)
    dst.vertical_alignment = {-1: en.VA_TOP, 0: en.VA_CENTER, 1: en.VA_BOTTOM}.get(v, en.VA_CENTER)
    dst.line_spacing = 1.0
    dst.multiline = "\n" in str(_try(t.GetText, "") or "")


def _text(t):
    m = _p()["bt"].BoardText()
    m.id.value = _id(t)
    m.text.text = str(t.GetText())
    _vec(m.text.position, t.GetPosition())
    _text_attrs(m.text.attributes, t)
    m.layer = _layer(t.GetLayer())
    m.knockout = bool(_try(t.IsKnockout, False))
    _locked(m, t)
    _parent(m, t)
    return m


def _polyline(dst, chain):
    for i in range(chain.PointCount()):
        _vec(dst.nodes.add().point, chain.CPoint(i))
    dst.closed = True


def _polyset(dst, poly):
    for i in range(poly.OutlineCount()):
        pg = dst.polygons.add()
        _polyline(pg.outline, poly.Outline(i))
        for h in range(poly.HoleCount(i)):
            _polyline(pg.holes.add(), poly.Hole(i, h))


def _shape(s):
    base = _p()["base"]
    m = _p()["bt"].BoardGraphicShape()
    m.id.value = _id(s)
    m.layer = _layer(s.GetLayer())
    _locked(m, s)
    _parent(m, s)
    if _try(s.GetNetCode, 0):
        _net(m.net, s)
    g = m.shape
    g.attributes.stroke.width.value_nm = int(_try(s.GetWidth, 0) or 0)
    # the file's line styles in order (default, solid, dash, dot, dash-dot, dash-dot-dot); KiCad reports "default" as solid
    g.attributes.stroke.style = (_p()["en"].SLS_SOLID, _p()["en"].SLS_SOLID, _p()["en"].SLS_DASH, _p()["en"].SLS_DOT, _p()["en"].SLS_DASHDOT,
                                 _p()["en"].SLS_DASHDOTDOT)[int(_try(s.GetLineStyle, 0) or 0)]
    filled = bool(_try(s.IsFilled, False))
    g.attributes.fill.fill_type = getattr(base, "GFT_FILLED", 2) if filled else getattr(base, "GFT_UNFILLED", 1)
    kind = s.GetShape()
    if kind == pcbnew.SHAPE_T_SEGMENT:
        _vec(g.segment.start, s.GetStart())
        _vec(g.segment.end, s.GetEnd())
    elif kind == pcbnew.SHAPE_T_RECT:
        a, b = s.GetStart(), s.GetEnd()
        g.rectangle.top_left.x_nm, g.rectangle.top_left.y_nm = int(min(a.x, b.x)), int(min(a.y, b.y))
        g.rectangle.bottom_right.x_nm, g.rectangle.bottom_right.y_nm = int(max(a.x, b.x)), int(max(a.y, b.y))
    elif kind == pcbnew.SHAPE_T_ARC:
        _vec(g.arc.start, s.GetStart())
        _vec(g.arc.mid, s.GetArcMid())
        _vec(g.arc.end, s.GetEnd())
    elif kind == pcbnew.SHAPE_T_CIRCLE:
        c = s.GetCenter()
        _vec(g.circle.center, c)
        g.circle.radius_point.x_nm, g.circle.radius_point.y_nm = int(c.x + s.GetRadius()), int(c.y)
    elif kind == pcbnew.SHAPE_T_POLY:
        _polyset(g.polygon, s.GetPolyShape())
    elif kind == pcbnew.SHAPE_T_BEZIER:
        _vec(g.bezier.start, s.GetStart())
        _vec(g.bezier.control1, s.GetBezierC1())
        _vec(g.bezier.control2, s.GetBezierC2())
        _vec(g.bezier.end, s.GetEnd())
    return m


def _zone(z):
    bt = _p()["bt"]
    m = bt.Zone()
    m.id.value = _id(z)
    rule = bool(_try(z.GetIsRuleArea, False))
    layers = _try(lambda: list(z.GetLayerSet().Seq()), []) or []
    copper = any(pcbnew.IsCopperLayer(l) for l in layers)
    m.type = bt.ZT_RULE_AREA if rule else (bt.ZT_TEARDROP if _try(z.IsTeardropArea, False) else (bt.ZT_COPPER if copper else bt.ZT_GRAPHICAL))
    m.layers.extend([_layer(l) for l in layers])
    _try(lambda: _polyset(m.outline, z.Outline()))
    m.name = str(_try(z.GetZoneName, "") or "")
    m.priority = max(0, int(_try(z.GetAssignedPriority, 0) or 0))
    m.filled = bool(_try(z.IsFilled, False))
    _locked(m, z)
    if rule:
        r = m.rule_area_settings
        for field, getter in (("keepout_copper", "GetDoNotAllowZoneFills"), ("keepout_vias", "GetDoNotAllowVias"), ("keepout_tracks", "GetDoNotAllowTracks"),
                              ("keepout_pads", "GetDoNotAllowPads"), ("keepout_footprints", "GetDoNotAllowFootprints")):
            setattr(r, field, bool(_try(getattr(z, getter, lambda: False), False)))
    else:
        c = m.copper_settings
        _net(c.net, z)
        c.clearance.value_nm = int(_try(z.GetLocalClearance, 0) or 0)
        c.min_thickness.value_nm = int(_try(z.GetMinThickness, 0) or 0)
        c.fill_mode = bt.ZFM_HATCHED if _try(z.GetFillMode, 0) else bt.ZFM_SOLID
        c.island_mode = {0: bt.IRM_ALWAYS, 1: bt.IRM_NEVER, 2: bt.IRM_AREA}.get(_try(z.GetIslandRemovalMode, 0), bt.IRM_ALWAYS)
        for l in layers:
            poly = _try(z.GetFilledPolysList, None, l)
            if poly is not None and _try(poly.OutlineCount, 0):
                fp = m.filled_polygons.add()
                fp.layer = _layer(l)
                _polyset(fp.shapes, poly)
    return m


def _field(dst, f, fid, name):
    dst.id.id = fid
    dst.name = name
    dst.visible = bool(_try(f.IsVisible, True))
    t = dst.text
    t.id.value = _id(f)
    t.text.text = str(f.GetText())
    _vec(t.text.position, f.GetPosition())
    _text_attrs(t.text.attributes, f)
    t.layer = _layer(f.GetLayer())


def _any(msg):
    from google.protobuf.any_pb2 import Any
    a = Any()
    a.Pack(msg)
    return a


def _footprint(f):
    bt = _p()["bt"]
    m = bt.FootprintInstance()
    m.id.value = _id(f)
    _vec(m.position, f.GetPosition())
    m.orientation.value_degrees = float(f.GetOrientationDegrees())
    m.layer = _layer(f.GetLayer())
    _locked(m, f)
    d = m.definition
    fpid = f.GetFPID()
    d.id.library_nickname = str(_try(fpid.GetLibNickname, "") or "")
    d.id.entry_name = str(_try(fpid.GetLibItemName, "") or "")
    _field(m.reference_field, f.Reference(), 0, "Reference")
    _field(m.value_field, f.Value(), 1, "Value")
    for name, fid, dst in (("Datasheet", 2, m.datasheet_field), ("Description", 3, m.description_field)):
        fld = _try(f.GetFieldByName, None, name)
        if fld is not None:
            _field(dst, fld, fid, name)
    at = m.attributes
    at.description = str(_try(f.GetDescription, "") or "")
    at.keywords = str(_try(f.GetKeywords, "") or "")
    at.do_not_populate = bool(_try(f.IsDNP, False))
    at.exclude_from_bill_of_materials = bool(_try(f.IsExcludedFromBOM, False))
    at.exclude_from_position_files = bool(_try(f.IsExcludedFromPosFiles, False))
    at.not_in_schematic = bool(_try(f.IsBoardOnly, False))
    attrs = int(_try(f.GetAttributes, 0) or 0)
    at.mounting_style = bt.FMS_SMD if attrs & pcbnew.FP_SMD else (bt.FMS_THROUGH_HOLE if attrs & pcbnew.FP_THROUGH_HOLE else bt.FMS_UNSPECIFIED)
    d.attributes.CopyFrom(at)
    path = str(_try(lambda: f.GetPath().AsString(), "") or "")
    for part in [x for x in path.split("/") if x]:
        m.symbol_path.path.add().value = part
    m.symbol_sheet_name = str(_try(f.GetSheetname, "") or "")
    m.symbol_sheet_filename = str(_try(f.GetSheetfile, "") or "")
    for p in f.Pads():
        d.items.append(_any(_pad(p)))
    for g in f.GraphicalItems():
        msg = _to_message(g)
        if msg is not None:
            d.items.append(_any(msg))
    for fld in _try(f.GetFields, []) or []:
        name = str(_try(fld.GetName, "") or "")
        if name in ("Reference", "Value", "Datasheet", "Description"):
            continue
        fm = bt.Field()
        _field(fm, fld, 100, name)
        d.items.append(_any(fm))
    return m


def _group(g):
    m = _p()["bt"].Group()
    m.id.value = _id(g)
    m.name = str(_try(g.GetName, "") or "")
    for it in _try(g.GetItems, []) or []:
        m.items.add().value = _id(it)
    return m


def _to_message(it):
    """The protobuf message for one board item, or None for a kind the API does not describe here."""
    if isinstance(it, pcbnew.PCB_VIA):
        return _via(it)
    if isinstance(it, pcbnew.PCB_ARC):
        return _arc(it)
    if isinstance(it, pcbnew.PCB_TRACK):
        return _track(it)
    if isinstance(it, pcbnew.FOOTPRINT):
        return _footprint(it)
    if isinstance(it, pcbnew.PAD):
        return _pad(it)
    if isinstance(it, pcbnew.ZONE):
        return _zone(it)
    if isinstance(it, pcbnew.PCB_GROUP):
        return _group(it)
    if isinstance(it, pcbnew.PCB_FIELD):
        fm = _p()["bt"].Field()
        _field(fm, it, 100, str(_try(it.GetName, "") or ""))
        return fm
    if isinstance(it, pcbnew.PCB_TEXT) and not isinstance(it, pcbnew.PCB_TEXTBOX):
        return _text(it)
    if isinstance(it, pcbnew.PCB_SHAPE):
        return _shape(it)
    return None


def _kinds():
    en = _p()["en"]
    return {
        en.KOT_PCB_TRACE: lambda b: [t for t in b.GetTracks() if isinstance(t, pcbnew.PCB_TRACK) and not isinstance(t, (pcbnew.PCB_VIA, pcbnew.PCB_ARC))],
        en.KOT_PCB_ARC: lambda b: [t for t in b.GetTracks() if isinstance(t, pcbnew.PCB_ARC)],
        en.KOT_PCB_VIA: lambda b: [t for t in b.GetTracks() if isinstance(t, pcbnew.PCB_VIA)],
        en.KOT_PCB_FOOTPRINT: lambda b: list(b.GetFootprints()),
        en.KOT_PCB_PAD: lambda b: list(b.GetPads()),
        en.KOT_PCB_ZONE: lambda b: list(b.Zones()),
        en.KOT_PCB_SHAPE: lambda b: [d for d in b.GetDrawings() if isinstance(d, pcbnew.PCB_SHAPE)],
        en.KOT_PCB_TEXT: lambda b: [d for d in b.GetDrawings() if isinstance(d, pcbnew.PCB_TEXT) and not isinstance(d, pcbnew.PCB_TEXTBOX)],
        en.KOT_PCB_GROUP: lambda b: list(b.Groups()),
        en.KOT_PCB_FIELD: lambda b: [fld for f in b.GetFootprints() for fld in (_try(f.GetFields, []) or [])],
    }


def _items_of(types):
    board = _board()
    kinds = _kinds()
    out = []
    for t in (types or list(kinds)):
        fn = kinds.get(t)
        if fn is not None:
            out.extend(fn(board))
    return out


def _kind_of(it):
    en = _p()["en"]
    if isinstance(it, pcbnew.PCB_VIA):
        return en.KOT_PCB_VIA
    if isinstance(it, pcbnew.PCB_ARC):
        return en.KOT_PCB_ARC
    if isinstance(it, pcbnew.PCB_TRACK):
        return en.KOT_PCB_TRACE
    if isinstance(it, pcbnew.FOOTPRINT):
        return en.KOT_PCB_FOOTPRINT
    if isinstance(it, pcbnew.PAD):
        return en.KOT_PCB_PAD
    if isinstance(it, pcbnew.ZONE):
        return en.KOT_PCB_ZONE
    if isinstance(it, pcbnew.PCB_GROUP):
        return en.KOT_PCB_GROUP
    if isinstance(it, pcbnew.PCB_FIELD):
        return en.KOT_PCB_FIELD
    if isinstance(it, pcbnew.PCB_TEXT):
        return en.KOT_PCB_TEXT
    if isinstance(it, pcbnew.PCB_SHAPE):
        return en.KOT_PCB_SHAPE
    return en.KOT_UNKNOWN


def _pack_items(dst, items, types=None):
    for it in items:
        if types and _kind_of(it) not in types:
            continue
        msg = _try(_to_message, None, it)
        if msg is not None:
            dst.append(_any(msg))


def _find(kiid):
    board = _board()
    value = kiid.value if hasattr(kiid, "value") else str(kiid)
    return board.GetItem(value) if value else None


# ----------------------------------------------------------------------------- messages -> board items

def _set_locked(item, m):
    base = _p()["base"]
    if m.locked != base.LS_UNKNOWN:
        item.SetLocked(m.locked == base.LS_LOCKED)


def _write_track(t, m):
    t.SetStart(_pt(m.start))
    t.SetEnd(_pt(m.end))
    if m.width.value_nm:
        t.SetWidth(int(m.width.value_nm))
    layer = _unlayer(m.layer)
    if layer != pcbnew.UNDEFINED_LAYER:
        t.SetLayer(layer)
    _apply_net(t, m.net)
    _set_locked(t, m)


def _write_arc(t, m):
    t.SetStart(_pt(m.start))
    t.SetMid(_pt(m.mid))
    t.SetEnd(_pt(m.end))
    if m.width.value_nm:
        t.SetWidth(int(m.width.value_nm))
    layer = _unlayer(m.layer)
    if layer != pcbnew.UNDEFINED_LAYER:
        t.SetLayer(layer)
    _apply_net(t, m.net)
    _set_locked(t, m)


def _write_via(v, m):
    bt = _p()["bt"]
    v.SetPosition(_pt(m.position))
    v.SetViaType({bt.VT_BLIND_BURIED: pcbnew.VIATYPE_BLIND_BURIED, bt.VT_BLIND: pcbnew.VIATYPE_BLIND_BURIED, bt.VT_BURIED: pcbnew.VIATYPE_BLIND_BURIED,
                  bt.VT_MICRO: pcbnew.VIATYPE_MICROVIA}.get(m.type, pcbnew.VIATYPE_THROUGH))
    ps = m.pad_stack
    if ps.drill.diameter.x_nm:
        v.SetDrill(int(ps.drill.diameter.x_nm))
    if len(ps.copper_layers) and ps.copper_layers[0].size.x_nm:
        v.SetWidth(int(ps.copper_layers[0].size.x_nm))
    top, bottom = _unlayer(ps.drill.start_layer), _unlayer(ps.drill.end_layer)
    if top == pcbnew.UNDEFINED_LAYER or bottom == pcbnew.UNDEFINED_LAYER:
        ls = [_unlayer(l) for l in ps.layers]
        ls = [l for l in ls if l != pcbnew.UNDEFINED_LAYER and pcbnew.IsCopperLayer(l)]
        top, bottom = (ls[0], ls[-1]) if len(ls) >= 2 else (pcbnew.F_Cu, pcbnew.B_Cu)
    v.SetLayerPair(top, bottom)
    _apply_net(v, m.net)
    _set_locked(v, m)


def _write_text_attrs(t, a):
    en = _p()["en"]
    if a.size.x_nm or a.size.y_nm:
        t.SetTextSize(pcbnew.VECTOR2I(int(a.size.x_nm), int(a.size.y_nm)))
    if a.stroke_width.value_nm:
        t.SetTextThickness(int(a.stroke_width.value_nm))
    _try(t.SetTextAngleDegrees, None, float(a.angle.value_degrees))
    _try(t.SetItalic, None, bool(a.italic))
    _try(t.SetBold, None, bool(a.bold))
    _try(t.SetMirrored, None, bool(a.mirrored))
    if a.horizontal_alignment in (en.HA_LEFT, en.HA_CENTER, en.HA_RIGHT):
        _try(t.SetHorizJustify, None, {en.HA_LEFT: -1, en.HA_CENTER: 0, en.HA_RIGHT: 1}[a.horizontal_alignment])
    if a.vertical_alignment in (en.VA_TOP, en.VA_CENTER, en.VA_BOTTOM):
        _try(t.SetVertJustify, None, {en.VA_TOP: -1, en.VA_CENTER: 0, en.VA_BOTTOM: 1}[a.vertical_alignment])


def _write_text(t, m):
    t.SetText(m.text.text)
    t.SetPosition(_pt(m.text.position))
    layer = _unlayer(m.layer)
    if layer != pcbnew.UNDEFINED_LAYER:
        t.SetLayer(layer)
    _write_text_attrs(t, m.text.attributes)
    _set_locked(t, m)


def _chain_points(pl):
    pts = []
    for node in pl.nodes:
        which = node.WhichOneof("geometry")
        if which == "point":
            pts.append(_pt(node.point))
        elif which == "arc":
            # an arc in an outline: its three points keep the shape close enough for an outline
            for v in (node.arc.start, node.arc.mid, node.arc.end):
                p = _pt(v)
                if not pts or (pts[-1].x, pts[-1].y) != (p.x, p.y):
                    pts.append(p)
    return pts


def _read_polyset(ps):
    poly = pcbnew.SHAPE_POLY_SET()
    for pg in ps.polygons:
        poly.NewOutline()
        for p in _chain_points(pg.outline):
            poly.Append(p.x, p.y)
        for hole in pg.holes:
            poly.NewHole()
            for p in _chain_points(hole):
                poly.Append(p.x, p.y, -1, -1)
    return poly


def _write_shape(s, m):
    base = _p()["base"]
    g = m.shape
    which = g.WhichOneof("geometry")
    if which == "segment":
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(_pt(g.segment.start))
        s.SetEnd(_pt(g.segment.end))
    elif which == "rectangle":
        s.SetShape(pcbnew.SHAPE_T_RECT)
        s.SetStart(_pt(g.rectangle.top_left))
        s.SetEnd(_pt(g.rectangle.bottom_right))
    elif which == "arc":
        s.SetShape(pcbnew.SHAPE_T_ARC)
        s.SetArcGeometry(_pt(g.arc.start), _pt(g.arc.mid), _pt(g.arc.end))
    elif which == "circle":
        s.SetShape(pcbnew.SHAPE_T_CIRCLE)
        s.SetCenter(_pt(g.circle.center))
        s.SetEnd(_pt(g.circle.radius_point))
    elif which == "polygon":
        s.SetShape(pcbnew.SHAPE_T_POLY)
        s.SetPolyShape(_read_polyset(g.polygon))
    elif which == "bezier":
        raise ApiFail("Bezier curves cannot be created through the IPC interface in the web editor yet")
    s.SetWidth(int(g.attributes.stroke.width.value_nm))
    en = _p()["en"]
    s.SetLineStyle({en.SLS_SOLID: 1, en.SLS_DASH: 2, en.SLS_DOT: 3, en.SLS_DASHDOT: 4, en.SLS_DASHDOTDOT: 5}.get(g.attributes.stroke.style, 0))
    if which in ("rectangle", "circle", "polygon"):
        s.SetFilled(g.attributes.fill.fill_type == getattr(base, "GFT_FILLED", 2))
    layer = _unlayer(m.layer)
    if layer != pcbnew.UNDEFINED_LAYER:
        s.SetLayer(layer)
    _set_locked(s, m)


def _write_zone(z, m):
    bt = _p()["bt"]
    layers = [l for l in (_unlayer(x) for x in m.layers) if l != pcbnew.UNDEFINED_LAYER]
    if layers:
        ls = pcbnew.LSET()
        for l in layers:
            ls.AddLayer(l)
        z.SetLayerSet(ls)
    if len(m.outline.polygons):
        z.SetOutline(_read_polyset(m.outline))
    z.SetZoneName(m.name)
    z.SetAssignedPriority(int(m.priority))
    if m.type == bt.ZT_RULE_AREA or m.WhichOneof("settings") == "rule_area_settings":
        z.SetIsRuleArea(True)
        r = m.rule_area_settings
        for setter, value in (("SetDoNotAllowZoneFills", r.keepout_copper), ("SetDoNotAllowVias", r.keepout_vias), ("SetDoNotAllowTracks", r.keepout_tracks),
                              ("SetDoNotAllowPads", r.keepout_pads), ("SetDoNotAllowFootprints", r.keepout_footprints)):
            _try(getattr(z, setter, lambda v: None), None, bool(value))
    else:
        c = m.copper_settings
        _apply_net(z, c.net)
        if c.clearance.value_nm:
            z.SetLocalClearance(int(c.clearance.value_nm))
        if c.min_thickness.value_nm:
            z.SetMinThickness(int(c.min_thickness.value_nm))
    _set_locked(z, m)
    _try(z.UnFill)


def _write_field(f, m):
    if m.text.text.text != str(f.GetText()):
        f.SetText(m.text.text.text)
    _try(f.SetVisible, None, bool(m.visible))
    pos = _pt(m.text.text.position)
    cur = f.GetPosition()
    if (pos.x, pos.y) != (cur.x, cur.y) and (pos.x or pos.y):
        f.SetPosition(pos)
    layer = _unlayer(m.text.layer)
    if layer != pcbnew.UNDEFINED_LAYER and layer != f.GetLayer():
        f.SetLayer(layer)
    if m.text.text.attributes.size.x_nm:
        _write_text_attrs(f, m.text.text.attributes)


def _write_footprint(f, m):
    pos = _pt(m.position)
    cur = f.GetPosition()
    if (pos.x, pos.y) != (cur.x, cur.y):
        f.SetPosition(pos)
    layer = _unlayer(m.layer)
    if layer in (pcbnew.F_Cu, pcbnew.B_Cu) and layer != f.GetLayer():
        f.Flip(f.GetPosition(), False)
    if abs(((m.orientation.value_degrees - f.GetOrientationDegrees()) + 180.0) % 360.0 - 180.0) > 1e-6:
        f.SetOrientationDegrees(float(m.orientation.value_degrees))
    _set_locked(f, m)
    if m.HasField("reference_field") and m.reference_field.text.text.text and m.reference_field.text.text.text != f.GetReference():
        f.SetReference(m.reference_field.text.text.text)
    if m.HasField("value_field") and m.value_field.text.text.text != f.GetValue() and m.value_field.text.text.text:
        f.SetValue(m.value_field.text.text.text)
    for fld, src in ((f.Reference(), m.reference_field), (f.Value(), m.value_field)):
        if m.HasField("reference_field" if src is m.reference_field else "value_field"):
            _try(fld.SetVisible, None, bool(src.visible))
    if m.HasField("attributes"):
        at = m.attributes
        _try(f.SetDNP, None, bool(at.do_not_populate))
        _try(f.SetExcludedFromBOM, None, bool(at.exclude_from_bill_of_materials))
        _try(f.SetExcludedFromPosFiles, None, bool(at.exclude_from_position_files))


def _write_pad(p, m):
    _apply_net(p, m.net)
    if m.number and m.number != str(p.GetNumber()):
        p.SetNumber(m.number)


_MAKERS = None


def _makers():
    """type name -> (class to create, writer, class that may be updated)."""
    global _MAKERS
    if _MAKERS is None:
        _MAKERS = {
            "Track": (pcbnew.PCB_TRACK, _write_track, pcbnew.PCB_TRACK),
            "Arc": (pcbnew.PCB_ARC, _write_arc, pcbnew.PCB_ARC),
            "Via": (pcbnew.PCB_VIA, _write_via, pcbnew.PCB_VIA),
            "BoardText": (pcbnew.PCB_TEXT, _write_text, pcbnew.PCB_TEXT),
            "BoardGraphicShape": (pcbnew.PCB_SHAPE, _write_shape, pcbnew.PCB_SHAPE),
            "Zone": (pcbnew.ZONE, _write_zone, pcbnew.ZONE),
            "FootprintInstance": (None, _write_footprint, pcbnew.FOOTPRINT),
            "Pad": (None, _write_pad, pcbnew.PAD),
            "Field": (None, _write_field, pcbnew.PCB_FIELD),
        }
    return _MAKERS


def _unpack(any_msg):
    name = any_msg.type_url.rsplit(".", 1)[-1]
    cls = getattr(_p()["bt"], name, None)
    if cls is None:
        return name, None
    m = cls()
    any_msg.Unpack(m)
    return name, m


def _message_id(name, m):
    if name == "Field":
        return m.text.id.value
    return m.id.value if hasattr(m, "id") and hasattr(m.id, "value") else ""


# ----------------------------------------------------------------------------- commits

def _changed():
    """Something was edited: outside a commit it reaches the editor at once, as KiCad does it."""
    if _state["commit"] is None:
        _push()


def _push(label=None):
    web = _web()
    if label:
        web._label[0] = str(label)[:80]
    web.flush()
    web._export_outputs()


def _reload():
    pcbnew._Host.board = None
    return _web().load_board()


# ----------------------------------------------------------------------------- the commands

def _ok_status():
    return _p()["base"].IRS_OK


def get_version(cmd):
    r = _p()["cc"].GetVersionResponse()
    parts = (str(pcbnew._Host.version).split("-")[0].split(".") + ["0", "0", "0"])[:3]
    nums = [int("".join(ch for ch in x if ch.isdigit()) or 0) for x in parts]
    r.version.major, r.version.minor, r.version.patch = nums
    r.version.full_version = str(pcbnew._Host.version)
    return r


def ping(cmd):
    return _p()["empty"].Empty()


def _document():
    base = _p()["base"]
    board = _board()
    d = base.DocumentSpecifier()
    d.type = base.DOCTYPE_PCB
    d.board_filename = os.path.basename(board.GetFileName())
    d.project.name = os.path.splitext(d.board_filename)[0]
    d.project.path = os.path.dirname(board.GetFileName())
    return d


def get_open_documents(cmd):
    base = _p()["base"]
    r = _p()["ec"].GetOpenDocumentsResponse()
    if cmd.type in (base.DOCTYPE_PCB, base.DOCTYPE_UNKNOWN):
        r.documents.append(_document())
    elif cmd.type == base.DOCTYPE_PROJECT:
        d = _document()
        d.type = base.DOCTYPE_PROJECT
        d.ClearField("board_filename")
        r.documents.append(d)
    return r


def get_items(cmd):
    r = _p()["ec"].GetItemsResponse()
    r.header.CopyFrom(cmd.header)
    r.status = _ok_status()
    _pack_items(r.items, _items_of(list(cmd.types)))
    return r


def get_items_by_id(cmd):
    r = _p()["ec"].GetItemsResponse()
    r.header.CopyFrom(cmd.header)
    r.status = _ok_status()
    _pack_items(r.items, [it for it in (_find(k) for k in cmd.items) if it is not None])
    return r


def get_selection(cmd):
    r = _p()["ec"].SelectionResponse()
    _pack_items(r.items, _board().GetCurrentSelection(), list(cmd.types))
    return r


def _select(cmd, on):
    for k in cmd.items:
        it = _find(k)
        if it is not None:
            it.SetSelected() if on else it.ClearSelected()
    _board()._selection_changed = True
    _changed()
    r = _p()["ec"].SelectionResponse()
    _pack_items(r.items, _board().GetCurrentSelection())
    return r


def add_to_selection(cmd):
    return _select(cmd, True)


def remove_from_selection(cmd):
    return _select(cmd, False)


def clear_selection(cmd):
    b = _board()
    b.ClearSelected()
    b._selection_changed = True
    _changed()
    return _p()["empty"].Empty()


def create_items(cmd):
    ec = _p()["ec"]
    board = _board()
    r = ec.CreateItemsResponse()
    r.header.CopyFrom(cmd.header)
    r.status = _ok_status()
    for a in cmd.items:
        res = r.created_items.add()
        name, m = _unpack(a)
        cls, write, _ = _makers().get(name, (None, None, None))
        if m is None or cls is None:
            res.status.code = ec.ISC_INVALID_TYPE
            res.status.error_message = f"{name} items cannot be created through the IPC interface in the web editor yet"
            continue
        try:
            item = cls(board)
            write(item, m)
            # KiCad keeps the identifier a caller supplies for a new item, as long as nothing on the board has it yet.
            want = str(_message_id(name, m) or "")
            if want and board.GetItem(want) is None:
                try:
                    import uuid as _uuid
                    pcbnew._set_kid(item._node, "uuid", str(_uuid.UUID(want)))
                except (ValueError, AttributeError):
                    pass
            board.Add(item)
            res.status.code = ec.ISC_OK
            res.item.Pack(_to_message(item))
        except ApiFail as e:
            res.status.code = ec.ISC_INVALID_DATA
            res.status.error_message = str(e)
    _changed()
    return r


def update_items(cmd):
    ec = _p()["ec"]
    r = ec.UpdateItemsResponse()
    r.header.CopyFrom(cmd.header)
    r.status = _ok_status()
    for a in cmd.items:
        res = r.updated_items.add()
        name, m = _unpack(a)
        _, write, kind = _makers().get(name, (None, None, None))
        if m is None or write is None:
            res.status.code = ec.ISC_INVALID_TYPE
            res.status.error_message = f"{name} items cannot be changed through the IPC interface in the web editor yet"
            continue
        item = _board().GetItem(_message_id(name, m))
        if item is None or not isinstance(item, kind):
            res.status.code = ec.ISC_NONEXISTENT
            continue
        try:
            write(item, m)
            res.status.code = ec.ISC_OK
            res.item.Pack(_to_message(item))
        except ApiFail as e:
            res.status.code = ec.ISC_INVALID_DATA
            res.status.error_message = str(e)
    _changed()
    return r


def delete_items(cmd):
    ec = _p()["ec"]
    board = _board()
    r = ec.DeleteItemsResponse()
    r.header.CopyFrom(cmd.header)
    r.status = _ok_status()
    for k in cmd.item_ids:
        res = r.deleted_items.add()
        res.id.value = k.value
        item = _find(k)
        if item is None:
            res.status = ec.IDS_NONEXISTENT
            continue
        parent = _try(item.GetParentFootprint)
        try:
            (parent if parent is not None else board).Remove(item)
            res.status = ec.IDS_OK
        except Exception:
            res.status = ec.IDS_IMMUTABLE
    _changed()
    return r


def begin_commit(cmd):
    r = _p()["ec"].BeginCommitResponse()
    if _state["commit"] is not None:
        raise ApiFail("a commit is already in progress")
    _push()                                  # what came before is its own step
    _state["commit"] = str(_uuid.uuid4())
    r.id.value = _state["commit"]
    return r


def end_commit(cmd):
    ec = _p()["ec"]
    if _state["commit"] is None:
        raise ApiFail("no commit is in progress")
    _state["commit"] = None
    if cmd.action == ec.CMA_DROP:
        _reload()
    else:
        _push(cmd.message or None)
    return ec.EndCommitResponse()


def get_bounding_box(cmd):
    r = _p()["ec"].GetBoundingBoxResponse()
    for k in cmd.items:
        it = _find(k)
        if it is None:
            continue
        box = _try(it.GetBoundingBox)
        if box is None:
            continue
        r.items.add().value = k.value
        b = r.boxes.add()
        b.position.x_nm, b.position.y_nm = int(box.GetX()), int(box.GetY())
        b.size.x_nm, b.size.y_nm = int(box.GetWidth()), int(box.GetHeight())
    return r


def hit_test(cmd):
    ec = _p()["ec"]
    r = ec.HitTestResponse()
    it = _find(cmd.id)
    hit = False
    if it is not None:
        hit = bool(_try(it.HitTest, False, _pt(cmd.position), int(cmd.tolerance)))
    r.result = ec.HTR_HIT if hit else ec.HTR_NO_HIT
    return r


def _board_text():
    _push()
    info = _web()._call("design.board") or {}
    return str(info.get("text") or "")


def save_document(cmd):
    _push()                                  # the editor saves every change as it is made
    return _p()["empty"].Empty()


def save_copy(cmd):
    text = _board_text()
    path = cmd.path
    if not os.path.isabs(path):
        path = os.path.join(os.getcwd(), path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    _web()._export_outputs()
    return _p()["empty"].Empty()


def save_to_string(cmd):
    r = _p()["ec"].SavedDocumentResponse()
    r.document.CopyFrom(_document())
    r.contents = _board_text()
    return r


def save_selection_to_string(cmd):
    r = _p()["ec"].SavedSelectionResponse()
    parts = []
    for it in _board().GetCurrentSelection():
        node = getattr(it, "_node", None)
        if node is not None:
            parts.append(pcbnew._dump(node))
    r.contents = "\n".join(parts)
    return r


def revert_document(cmd):
    _state["commit"] = None
    _reload()
    return _p()["empty"].Empty()


def run_action(cmd):
    ec = _p()["ec"]
    r = ec.RunActionResponse()
    name = cmd.action.lower()
    if "zoom" in name or "focus" in name:
        sel = _board().GetCurrentSelection()
        if sel and pcbnew._Host.focus is not None:
            _try(pcbnew._Host.focus, None, sel[0])
        r.status = ec.RAS_OK
    elif "refresh" in name or "selectionclear" in name or "zonefill" in name:
        if "zonefill" in name:
            _refill()
            _changed()
        r.status = ec.RAS_OK
    else:
        r.status = ec.RAS_INVALID
    return r


def refresh_editor(cmd):
    return _p()["empty"].Empty()


def get_title_block(cmd):
    r = _p()["base"].TitleBlockInfo()
    tb = _board().GetTitleBlock()
    r.title, r.date, r.revision, r.company = (str(_try(getattr(tb, g), "") or "") for g in ("GetTitle", "GetDate", "GetRevision", "GetCompany"))
    for i in range(9):
        setattr(r, f"comment{i + 1}", str(_try(tb.GetComment, "", i) or ""))
    return r


def get_plugin_settings_path(cmd):
    r = _p()["cc"].StringResponse()
    safe = "".join(c if (c.isalnum() or c in "._-") else "_" for c in (cmd.identifier or "plugin"))
    path = f"{pcbnew._Host.config_dir}/plugins/{safe}"
    os.makedirs(path, exist_ok=True)
    r.response = path
    return r


def get_binary_path(cmd):
    r = _p()["cc"].PathResponse()
    r.path = "/usr/bin/" + (cmd.binary_name or "kicad")
    return r


# ---- board

def get_nets(cmd):
    r = _p()["bc"].NetsResponse()
    board = _board()
    wanted = set(cmd.netclass_filter)
    for code, ni in sorted(dict(board.GetNetsByNetcode()).items()):
        name = str(ni.GetNetname())
        if wanted and pcbnew._netclass_name(name) not in wanted:
            continue
        n = r.nets.add()
        n.code.value = int(code)
        n.name = name
    return r


def _netclass_message(dst, name, nc):
    dst.name = name
    dst.priority = int(nc.get("priority", 0) or 0)
    dst.type = getattr(_p()["ps"], "NCT_EXPLICIT", 1)
    b = dst.board
    mm = pcbnew.FromMM
    for field, key in (("clearance", "clearance"), ("track_width", "track_width"), ("diff_pair_track_width", "diff_pair_width"),
                       ("diff_pair_gap", "diff_pair_gap"), ("diff_pair_via_gap", "diff_pair_via_gap")):
        v = nc.get(key)
        if isinstance(v, (int, float)):
            getattr(b, field).value_nm = int(mm(v))
    via, drill = nc.get("via_diameter"), nc.get("via_drill")
    if isinstance(via, (int, float)):
        bt = _p()["bt"]
        b.via_stack.type = bt.PST_NORMAL
        cl = b.via_stack.copper_layers.add()
        cl.layer, cl.shape = bt.BL_F_Cu, bt.PSS_CIRCLE
        cl.size.x_nm = cl.size.y_nm = int(mm(via))
        if isinstance(drill, (int, float)):
            b.via_stack.drill.diameter.x_nm = b.via_stack.drill.diameter.y_nm = int(mm(drill))


def _netclass_table():
    out = {}
    for nc in (pcbnew._net_settings().get("classes") or []):
        if isinstance(nc, dict) and nc.get("name"):
            out[str(nc["name"])] = nc
    out.setdefault("Default", {"name": "Default", "clearance": 0.2, "track_width": 0.2, "via_diameter": 0.6, "via_drill": 0.3})
    return out


def get_netclass_for_nets(cmd):
    r = _p()["bc"].NetClassForNetsResponse()
    table = _netclass_table()
    for net in cmd.net:
        name = pcbnew._netclass_name(net.name) or "Default"
        _netclass_message(r.classes[net.name], name, table.get(name, table["Default"]))
    return r


def get_net_classes(cmd):
    r = _p()["pc"].NetClassesResponse()
    for name, nc in _netclass_table().items():
        _netclass_message(r.net_classes.add(), name, nc)
    return r


def get_text_variables(cmd):
    r = _p()["ps"].TextVariables()
    for k, v in (pcbnew._project().get("text_variables") or {}).items():
        r.variables[str(k)] = str(v)
    return r


def expand_text_variables(cmd):
    r = _p()["pc"].ExpandTextVariablesResponse()
    for t in cmd.text:
        r.text.append(str(_try(pcbnew.ExpandTextVars, t, t, None) or t))
    return r


def get_enabled_layers(cmd):
    r = _p()["bc"].BoardEnabledLayersResponse()
    board = _board()
    r.copper_layer_count = int(board.GetCopperLayerCount())
    r.layers.extend([_layer(l) for l in board.GetEnabledLayers().Seq()])
    return r


def get_layer_name(cmd):
    r = _p()["bc"].BoardLayerNameResponse()
    r.name = str(_board().GetLayerName(_unlayer(cmd.layer)))
    return r


def get_layer_by_name(cmd):
    r = _p()["bc"].BoardLayerResponse()
    r.layer = _layer(_board().GetLayerID(cmd.name))
    return r


def get_active_layer(cmd):
    r = _p()["bc"].BoardLayerResponse()
    r.layer = _p()["bt"].BL_F_Cu
    return r


def get_visible_layers(cmd):
    r = _p()["bc"].BoardLayers()
    r.layers.extend([_layer(l) for l in _board().GetEnabledLayers().Seq()])
    return r


def nothing(cmd):
    return _p()["empty"].Empty()


def get_origin(cmd):
    r = _p()["base"].Vector2()
    setup = _board()._setup
    key = "grid_origin" if cmd.type == _p()["bc"].BOT_GRID else "aux_axis_origin"
    k = pcbnew._kid(setup, key) if setup is not None else None
    if k is not None and len(k) >= 3:
        r.x_nm, r.y_nm = int(pcbnew.FromMM(pcbnew._f(k[1]))), int(pcbnew.FromMM(pcbnew._f(k[2])))
    return r


def _stackup_rows():
    """The board's physical stackup as (kind, name, thickness mm, material, epsilon_r, loss tangent, type word)."""
    board = _board()
    setup = board._setup
    st = pcbnew._kid(setup, "stackup") if setup is not None else None
    rows = []
    if st is not None:
        for layer in pcbnew._kids(st, "layer"):
            name = str(layer[1]) if len(layer) > 1 else ""
            kind = pcbnew._kid(layer, "type")
            word = str(kind[1]) if kind and len(kind) > 1 else ""
            get = lambda key, d=0.0: (pcbnew._f(pcbnew._kid(layer, key)[1], d) if pcbnew._kid(layer, key) and len(pcbnew._kid(layer, key)) > 1 else d)
            mat = pcbnew._kid(layer, "material")
            rows.append((name, word, get("thickness"), str(mat[1]) if mat and len(mat) > 1 else "", get("epsilon_r"), get("loss_tangent")))
    if not any(r[1] == "copper" for r in rows):
        # no stackup stored: KiCad's default for the board's copper layer count and thickness
        n = max(2, int(board.GetCopperLayerCount()))
        total = pcbnew.ToMM(board.GetDesignSettings().GetBoardThickness()) or 1.6
        cu = 0.035
        diel = max(0.05, (total - n * cu) / (n - 1))
        names = ["F.Cu"] + [f"In{i}.Cu" for i in range(1, n - 1)] + ["B.Cu"]
        rows = [("F.SilkS", "Top Silk Screen", 0.0, "", 0.0, 0.0), ("F.Paste", "Top Solder Paste", 0.0, "", 0.0, 0.0), ("F.Mask", "Top Solder Mask", 0.01, "", 3.3, 0.0)]
        for i, nm in enumerate(names):
            rows.append((nm, "copper", cu, "", 0.0, 0.0))
            if i < n - 1:
                rows.append((f"dielectric {i + 1}", "core" if i % 2 == 0 else "prepreg", diel, "FR4", 4.5, 0.02))
        rows += [("B.Mask", "Bottom Solder Mask", 0.01, "", 3.3, 0.0), ("B.Paste", "Bottom Solder Paste", 0.0, "", 0.0, 0.0), ("B.SilkS", "Bottom Silk Screen", 0.0, "", 0.0, 0.0)]
    return rows


def get_stackup(cmd):
    b, bt = _p()["b"], _p()["bt"]
    r = _p()["bc"].BoardStackupResponse()
    for name, word, thick, material, er, tan in _stackup_rows():
        layer = r.stackup.layers.add()
        layer.thickness.value_nm = int(pcbnew.FromMM(thick))
        layer.enabled = True
        layer.material_name = material
        low = word.lower()
        try:                                # the name the layer has on this board ("top_cu"), as KiCad reports it
            lid = _board().GetLayerID(name)
            layer.user_name = str(_board().GetLayerName(lid)) if lid is not None and lid >= 0 else name
        except Exception:
            layer.user_name = name
        if low == "copper":
            layer.type = b.BSLT_COPPER
            layer.layer = _layer(name)
        elif low in ("core", "prepreg"):
            layer.type = b.BSLT_DIELECTRIC
            layer.layer = bt.BL_UNDEFINED
            layer.dielectric.type = b.BSDT_CORE if low == "core" else b.BSDT_PREPREG
            d = layer.dielectric.layer.add()
            d.epsilon_r, d.loss_tangent, d.material_name = float(er or 4.5), float(tan), material
            d.thickness.value_nm = int(pcbnew.FromMM(thick))
        elif "mask" in low:
            layer.type = b.BSLT_SOLDERMASK
            layer.layer = _layer(name)
        elif "silk" in low:
            layer.type = b.BSLT_SILKSCREEN
            layer.layer = _layer(name)
        elif "paste" in low:
            layer.type = b.BSLT_SOLDERPASTE
            layer.layer = _layer(name)
        else:
            layer.type = b.BSLT_UNDEFINED
    return r


def _refill():
    b = _board()
    pcbnew.ZONE_FILLER(b).Fill([z for z in b.Zones() if not z.GetIsRuleArea()])


def refill_zones(cmd):
    _refill()
    _changed()
    return _p()["empty"].Empty()


def get_items_by_net(cmd):
    r = _p()["ec"].GetItemsResponse()
    r.header.CopyFrom(cmd.header)
    r.status = _ok_status()
    codes = {int(n.code.value) for n in cmd.nets}
    names = {n.name for n in cmd.nets if n.name}
    types = list(cmd.types) or [_p()["en"].KOT_PCB_TRACE, _p()["en"].KOT_PCB_ARC, _p()["en"].KOT_PCB_VIA, _p()["en"].KOT_PCB_PAD, _p()["en"].KOT_PCB_ZONE]
    hits = [it for it in _items_of(types) if (_try(it.GetNetname, "") in names if names else _try(it.GetNetCode, -1) in codes)]
    _pack_items(r.items, hits)
    return r


def get_items_by_netclass(cmd):
    r = _p()["ec"].GetItemsResponse()
    r.header.CopyFrom(cmd.header)
    r.status = _ok_status()
    wanted = set(cmd.net_classes)
    types = list(cmd.types) or [_p()["en"].KOT_PCB_TRACE, _p()["en"].KOT_PCB_ARC, _p()["en"].KOT_PCB_VIA, _p()["en"].KOT_PCB_PAD, _p()["en"].KOT_PCB_ZONE]
    hits = [it for it in _items_of(types) if (pcbnew._netclass_name(str(_try(it.GetNetname, "") or "")) or "Default") in wanted]
    _pack_items(r.items, hits)
    return r


def get_connected_items(cmd):
    r = _p()["ec"].GetItemsResponse()
    r.header.CopyFrom(cmd.header)
    r.status = _ok_status()
    codes = {_try(it.GetNetCode, 0) for it in (_find(k) for k in cmd.items) if it is not None}
    codes.discard(0)
    types = list(cmd.types) or [_p()["en"].KOT_PCB_TRACE, _p()["en"].KOT_PCB_ARC, _p()["en"].KOT_PCB_VIA, _p()["en"].KOT_PCB_PAD]
    _pack_items(r.items, [it for it in _items_of(types) if _try(it.GetNetCode, 0) in codes])
    return r


def _pad_outline(p):
    """A pad's copper as a polygon, in board coordinates."""
    size = p.GetSize()
    w, h = size.x / 2.0, size.y / 2.0
    shape = p.GetShape()
    pts = []
    if shape == pcbnew.PAD_SHAPE_CIRCLE:
        pts = [(w * math.cos(2 * math.pi * i / 32), w * math.sin(2 * math.pi * i / 32)) for i in range(32)]
    elif shape == pcbnew.PAD_SHAPE_OVAL:
        r = min(w, h)
        dx, dy = w - r, h - r
        for cx, cy, a0 in ((dx, dy, 0), (-dx, dy, 90), (-dx, -dy, 180), (dx, -dy, 270)):
            for i in range(9):
                a = math.radians(a0 + i * 90.0 / 8)
                pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    elif shape == pcbnew.PAD_SHAPE_ROUNDRECT:
        r = min(w, h) * 2 * float(_try(p.GetRoundRectRadiusRatio, 0.25) or 0.0)
        r = min(r, w, h)
        for cx, cy, a0 in ((w - r, h - r, 0), (-(w - r), h - r, 90), (-(w - r), -(h - r), 180), (w - r, -(h - r), 270)):
            for i in range(5):
                a = math.radians(a0 + i * 90.0 / 4)
                pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    else:
        pts = [(-w, -h), (w, -h), (w, h), (-w, h)]
    ang = -math.radians(float(_try(p.GetOrientationDegrees, 0.0) or 0.0))
    c, s = math.cos(ang), math.sin(ang)
    pos = p.GetPosition()
    off = _try(p.GetOffset)
    ox, oy = (off.x, off.y) if off is not None else (0, 0)
    return [(pos.x + (x + ox) * c - (y + oy) * s, pos.y + (x + ox) * s + (y + oy) * c) for x, y in pts]


def get_pad_polygons(cmd):
    r = _p()["bc"].PadShapeAsPolygonResponse()
    for k in cmd.pads:
        p = _find(k)
        if p is None or not isinstance(p, pcbnew.PAD):
            continue
        r.pads.add().value = k.value
        pg = r.polygons.add()
        for x, y in _pad_outline(p):
            n = pg.outline.nodes.add()
            n.point.x_nm, n.point.y_nm = int(round(x)), int(round(y))
        pg.outline.closed = True
    return r


def padstack_presence(cmd):
    bc = _p()["bc"]
    r = bc.PadstackPresenceResponse()
    for k in cmd.items:
        it = _find(k)
        if it is None:
            continue
        for bl in cmd.layers:
            e = r.entries.add()
            e.item.value = k.value
            e.layer = bl
            e.presence = bc.PSP_PRESENT if _try(it.IsOnLayer, False, _unlayer(bl)) else bc.PSP_NOT_PRESENT
    return r


def flip_items(cmd):
    bc, ec = _p()["bc"], _p()["ec"]
    r = bc.FlipItemsResponse()
    r.header.CopyFrom(cmd.header)
    r.status = _ok_status()
    for k in cmd.items:
        it = _find(k)
        res = r.flipped_items.add()
        if it is None:
            res.status.code = ec.ISC_NONEXISTENT
            continue
        it.Flip(it.GetPosition(), cmd.direction == bc.BFD_TOP_BOTTOM)
        res.status.code = ec.ISC_OK
        res.item.Pack(_to_message(it))
    _changed()
    return r


def get_appearance(cmd):
    bc = _p()["bc"]
    r = bc.BoardEditorAppearanceSettings()
    r.inactive_layer_display, r.net_color_display, r.board_flip, r.ratsnest_display = bc.ILDM_NORMAL, bc.NCDM_RATSNEST, bc.BFM_NORMAL, bc.RDM_ALL_LAYERS
    return r


def get_graphics_defaults(cmd):
    return _p()["bc"].GraphicsDefaultsResponse()


def get_text_extents(cmd):
    r = _p()["base"].Box2()
    a = cmd.text.attributes
    lines = cmd.text.text.split("\n") or [""]
    w = max(len(x) for x in lines) * (a.size.x_nm or 1000000) * 0.9
    h = len(lines) * (a.size.y_nm or 1000000) * 1.3
    r.position.x_nm, r.position.y_nm = int(cmd.text.position.x_nm - w / 2), int(cmd.text.position.y_nm - h / 2)
    r.size.x_nm, r.size.y_nm = int(w), int(h)
    return r


_HANDLERS = None


def _handlers():
    global _HANDLERS
    if _HANDLERS is None:
        p = _p()
        cc, ec, pc, bc = p["cc"], p["ec"], p["pc"], p["bc"]
        table = [
            (cc.GetVersion, get_version), (cc.Ping, ping), (cc.GetPluginSettingsPath, get_plugin_settings_path), (cc.GetKiCadBinaryPath, get_binary_path),
            (cc.GetTextExtents, get_text_extents),
            (ec.GetOpenDocuments, get_open_documents), (ec.GetItems, get_items), (ec.GetItemsById, get_items_by_id), (ec.GetSelection, get_selection),
            (ec.AddToSelection, add_to_selection), (ec.RemoveFromSelection, remove_from_selection), (ec.ClearSelection, clear_selection),
            (ec.CreateItems, create_items), (ec.UpdateItems, update_items), (ec.DeleteItems, delete_items), (ec.BeginCommit, begin_commit), (ec.EndCommit, end_commit),
            (ec.GetBoundingBox, get_bounding_box), (ec.HitTest, hit_test), (ec.SaveDocument, save_document), (ec.SaveCopyOfDocument, save_copy),
            (ec.SaveDocumentToString, save_to_string), (ec.SaveSelectionToString, save_selection_to_string), (ec.RevertDocument, revert_document),
            (ec.RunAction, run_action), (ec.RefreshEditor, refresh_editor), (ec.GetTitleBlockInfo, get_title_block),
            (pc.GetNetClasses, get_net_classes), (pc.GetTextVariables, get_text_variables), (pc.ExpandTextVariables, expand_text_variables),
            (bc.GetNets, get_nets), (bc.GetNetClassForNets, get_netclass_for_nets), (bc.GetBoardEnabledLayers, get_enabled_layers),
            (bc.GetBoardLayerName, get_layer_name), (bc.GetBoardLayerByName, get_layer_by_name), (bc.GetActiveLayer, get_active_layer),
            (bc.SetActiveLayer, nothing), (bc.GetVisibleLayers, get_visible_layers), (bc.SetVisibleLayers, nothing), (bc.GetBoardOrigin, get_origin),
            (bc.GetBoardStackup, get_stackup), (bc.RefillZones, refill_zones), (bc.GetItemsByNet, get_items_by_net), (bc.GetItemsByNetClass, get_items_by_netclass),
            (bc.GetConnectedItems, get_connected_items), (bc.GetPadShapeAsPolygon, get_pad_polygons), (bc.CheckPadstackPresenceOnLayers, padstack_presence),
            (bc.FlipItems, flip_items), (bc.GetBoardEditorAppearanceSettings, get_appearance), (bc.SetBoardEditorAppearanceSettings, nothing),
            (bc.GetGraphicsDefaults, get_graphics_defaults),
        ]
        _HANDLERS = {cls.DESCRIPTOR.full_name: (cls, fn) for cls, fn in table}
    return _HANDLERS


def handle(data):
    """One request from kipy (a serialized ApiRequest) -> the serialized ApiResponse."""
    env = _p()["env"]
    req = env.ApiRequest()
    resp = env.ApiResponse()
    resp.header.kicad_token = _state["token"]
    try:
        req.ParseFromString(data)
        name = req.message.type_url.rsplit("/", 1)[-1]
        hit = _handlers().get(name)
        if hit is None:
            resp.status.status = env.AS_UNHANDLED
            resp.status.error_message = f"{name.rsplit('.', 1)[-1]} is not available in the web editor"
        else:
            cls, fn = hit
            cmd = cls()
            req.message.Unpack(cmd)
            out = fn(cmd)
            resp.message.Pack(out)
            resp.status.status = env.AS_OK
    except ApiFail as e:
        resp.status.status = e.code or env.AS_BAD_REQUEST
        resp.status.error_message = str(e)
    except pcbnew.WebUnsupported as e:
        resp.status.status = env.AS_UNIMPLEMENTED
        resp.status.error_message = str(e)
    except Exception as e:           # the plugin sees KiCad's own kind of error, not ours
        import traceback
        traceback.print_exc()
        resp.status.status = env.AS_BAD_REQUEST
        resp.status.error_message = f"{type(e).__name__}: {e}"
    return resp.SerializeToString()


def reset():
    """A new run of a plugin starts with no commit open."""
    _state["commit"] = None
