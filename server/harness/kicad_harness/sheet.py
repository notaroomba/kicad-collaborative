"""Drawing a functional block of a schematic the way a person does, from its netlist.

The model is a datasheet's typical application circuit: the IC in the middle, a wire leaving each pin, capacitors
and pull resistors hanging from that wire to ground or a supply, series parts (a resistor, an inductor, a switch)
in line with it, a divider stacked under the node it measures.  Inside a block parts are joined by wires; a net
label appears only where a net leaves the block.  Supply symbols point up and ground symbols point down, labels
are horizontal, and decoupling capacitors of one supply stand in a row on shared rails with one symbol each.

Every block is drawn as clusters (an IC with what hangs on its pins, a bank of capacitors, a chain of small parts),
each at a scratch position off the page, measured as drawn and moved beside the previous one.
"""
from __future__ import annotations

import math

from .transport import HarnessError

G = 2.54
SCRATCH = (1524.0, 508.0)
SCRATCH_BOX = [SCRATCH[0] - 600.0, SCRATCH[1] - 400.0, SCRATCH[0] + 600.0, SCRATCH[1] + 400.0]
ASSEMBLY_X = 2794.0


def _up(v: float, g: float = G) -> float:
    return math.ceil(v / g - 1e-6) * g


def _hit(a, b, eps: float = 0.05) -> bool:
    return a[0] < b[2] - eps and a[2] > b[0] + eps and a[1] < b[3] - eps and a[3] > b[1] + eps


def _rect(x0, y0, x1, y1):
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


class Blocks:
    def __init__(self, sch, parts: dict, nets: dict, groups: dict, intent: dict, ground):
        self.s = sch
        self.parts = {r: (p if isinstance(p, dict) else {"lib": p}) for r, p in parts.items()}
        self.groups = groups
        self.intent = intent
        self.ground = ground
        self.gof = {r: g for g, rs in groups.items() for r in rs}
        self.netpins: dict = {}
        for (ref, num), net in intent.items():
            self.netpins.setdefault(net, []).append((ref, num))
        self.done: set = set()
        self.force: set = set()     # nets that carry a label in their block after all
        self.problems: list = []
        self._offs: dict = {}
        self._sides: dict = {}

    # ---- facts
    def lib(self, ref):
        return self.parts[ref].get("lib")

    def offs(self, ref, rot=0) -> dict:
        key = (ref, rot)
        if key not in self._offs:
            pins = self.s._lib_pins(self.lib(ref), rot)[1]
            self._offs[key] = {q[0]: (q[2], q[3]) for q in pins}
            self._sides[key] = [q[4] for q in pins]
        return self._offs[key]

    def small(self, ref) -> bool:
        lib = self.lib(ref)
        if isinstance(lib, dict) or hasattr(lib, "symbol"):
            return False
        try:
            o = self.offs(ref)
        except HarnessError:
            return False
        if len(o) != 2:
            return False
        return set(self._sides[(ref, 0)]) in ({"left", "right"}, {"top", "bottom"})   # a part a wire passes through

    def kind(self, net) -> str:
        if not net or not self.s._is_power(net):
            return "sig"
        return "gnd" if self.ground.search(net) else "sup"

    def other(self, ref, net):
        """(pin on this net, the other pin, the other pin's net) of a two pin part."""
        nums = list(self.offs(ref))
        a = next((n for n in nums if self.intent.get((ref, n)) == net), nums[0])
        b = next(n for n in nums if n != a)
        return a, b, self.intent.get((ref, b))

    def smalls_on(self, net, g, skip=()) -> list:
        out = []
        for ref, _ in self.netpins.get(net, []):
            if self.gof.get(ref) == g and ref not in self.done and ref not in skip and ref not in out and self.small(ref):
                out.append(ref)
        return out

    def need_label(self, net, g, wired=()) -> bool:
        """Does this net leave the block, or reach a pin in it that no wire of ours goes to?"""
        if net in self.force:
            return True
        for ref, num in self.netpins.get(net, []):
            if (ref, num) in wired:
                continue
            if self.gof.get(ref) != g or not self.small(ref):
                return True
        return False

    def width(self, *texts) -> float:
        return self.s._width(*[str(t) for t in texts if t])

    def span(self, ref) -> float:
        (ax, ay), (bx, by) = self.offs(ref).values()
        return abs(ax - bx) + abs(ay - by)

    def plain(self, ref) -> bool:
        return str(self.lib(ref)).startswith(("Device:R", "Device:C"))

    def across(self, ref) -> float:
        """How far a part drawn in line reaches above and below its wire."""
        if str(self.lib(ref)).startswith("Device:"):
            return 1.2
        try:
            b = self.s.lib(self.lib(ref))["units"][0].get("body_box") or [-2, -2, 2, 2]
        except HarnessError:
            return 2.0
        (ax, ay), (bx, by) = self.offs(ref).values()
        return max(abs(b[0]), abs(b[2])) if abs(ax - bx) < 1e-6 else max(abs(b[1]), abs(b[3]))

    # ---- planning: ops are tuples, nothing touches the sheet until emit()
    def put(self, ops, ref, point, num, face):
        """Plan a two pin part with pin `num` on `point`, that pin lying on the `face` side of the body.  Returns the other pin's point."""
        rot, o = 0, self.offs(ref, 0)
        for rot in (0, 90, 180, 270):
            o = self.offs(ref, rot)
            ox, oy = o[num]
            if (face[0] and ox * face[0] > 1e-6 and abs(oy) < 1e-6) or (face[1] and oy * face[1] > 1e-6 and abs(ox) < 1e-6):
                break
        ox, oy = o[num]
        c = (point[0] - ox, point[1] - oy)
        b = next(n for n in o if n != num)
        ops.append(("part", ref, c, rot))
        return (c[0] + o[b][0], c[1] + o[b][1])

    def sym_rect(self, net, at):
        w = max(self.width(net), 2.6) / 2 + 0.4
        if self.kind(net) == "gnd":
            return _rect(at[0] - w, at[1], at[0] + w, at[1] + 5.4)
        return _rect(at[0] - w, at[1] - 6.4, at[0] + w, at[1])

    def trunk(self, g, net, x, y, d, label, first=None, lead=G, used=(), wired=()):
        """Plan what hangs on and follows a wire leaving (x, y) in direction d (+1 right, -1 left) on this net."""
        k = self.kind(net)
        ops, rects, refs, ends, inline = [], [], [], [], []
        hung, series = [], []
        for r in self.smalls_on(net, g, skip=used):
            if r == first:
                continue
            m = self.other(r, net)[2]
            if k != "sig":
                if k == "sup" and self.kind(m) == "gnd" and first is None:
                    hung.append((r,))
                continue
            (hung if self.kind(m) != "sig" else series).append((r,) if self.kind(m) != "sig" else r)
        if k == "sup" and len(hung) > 3:
            hung = []            # a row of decoupling capacitors is drawn as a bank, not on one pin
        if first:
            series = [first]
        elif k == "sig":
            for r in list(series):   # a divider: this part, then one more from its far side to a rail
                a, b, m = self.other(r, net)
                rest = [q for q in self.smalls_on(m, g, skip=tuple(used) + (r,))]
                if len(rest) == 1 and self.kind(self.other(rest[0], m)[2]) != "sig" and self.plain(r) and self.plain(rest[0]):
                    series.remove(r)
                    hung.append((r, rest[0]))
            if len(series) > 1:
                label, series = True, []          # several branches: each starts from its own label
            if not series and hung:
                singles = [h for h in hung if len(h) == 1]
                rails = {self.kind(self.other(h[0], net)[2]) for h in singles if self.plain(h[0])}
                paired = rails == {"sup", "gnd"}       # a pull-up over a pull-down stays a stack on the node
                pick = next((h for h in singles if not self.plain(h[0])), singles[-1] if singles and not label and not paired else None)
                if pick:
                    hung.remove(pick)
                    series = [pick[0]]
        cx, pts, dots = x, [(x, y)], []
        if label and series and k == "sig":      # the net's name sits on the wire before the part in line
            w = self.width(net)
            ax = cx + lead if d > 0 else cx - _up(lead + w + 0.5)
            pts.append((ax, y))
            ops.append(("label", net, (ax, y), 0))
            rects.append(_rect(ax, y - 1.9, ax + w + 0.5, y + 0.3))
            cx, lead = (ax + _up(w + 1.0) - G, G) if d > 0 else (ax, G)
            label = False
        last_px, last_v = None, 0
        hung.sort(key=lambda h: 0 if len(h) == 1 and self.plain(h[0]) else 1)     # single resistors and capacitors first, so a pull-up and a pull-down pair up
        for h in hung:
            r = h[0]
            a, b, m = self.other(r, net)
            fw = max(self.width(q, self.parts[q].get("value")) for q in h) + 1.5
            lw = 0.0
            mid_label = None
            if len(h) == 2:
                a2, b2, m2 = self.other(h[1], m)
                if self.need_label(m, g, wired=((r, b), (h[1], a2))):
                    mid_label = m
                    lw = self.width(m) + 3.5
                rail = m2
            else:
                rail = m
            v = -1 if self.kind(rail) == "sup" else 1
            stacked = len(h) == 1 and last_v == -v and self.plain(r)     # a divider: one part up to the supply, the next down to ground from the same node
            if stacked:
                px, nlead = last_px, max(lead, _up(fw + 2.5) if d > 0 else 2 * G)
            elif d > 0:
                px = cx + max(lead, 2 * G, _up(lw) if lw else 0)
                nlead = _up(fw + 2.5)
            else:
                px = cx - max(lead, _up(fw + 2.5))
                nlead = max(2 * G, _up(lw) if lw else 0)
            far = self.put(ops, r, (px, y), a, (0, -v))
            depth = self.span(r)
            if len(h) == 2:
                if mid_label:
                    ops.append(("wire", [far, (far[0] - G, far[1])]))
                    ops.append(("label", m, (far[0] - G, far[1]), 180))
                    ops.append(("dot", far))
                far = self.put(ops, h[1], far, a2, (0, -v))
                depth += self.span(h[1])
            ops.append(("sym", rail, far))
            rects.append(_rect(px - 2.3 - lw, y, px + 1.2 + fw, y + v * (depth + (5.4 if v > 0 else 6.4))))
            if not stacked:
                pts.append((px, y))
                dots.append((px, y))
            refs += list(h)
            cx, lead, last_px = px, nlead, px
            last_v = 0 if stacked or len(h) != 1 or not self.plain(r) else v
        if k != "sig" and not first:
            if last_px is None:
                return None
            ops.append(("sym", net, (last_px, y)))       # the supply's own symbol stands over the node its capacitors hang from
            rects.append(self.sym_rect(net, (last_px, y)))
        elif series:
            r = series[0]
            a, b, m = self.other(r, net)
            wr, wv = self.width(r), self.width(self.parts[r].get("value"))
            pre_w, post_w = (wr, wv) if d > 0 else (wv, wr)
            pre = lead + max(0.0, _up(pre_w - 1.0))
            A = (cx + d * pre, y)
            B = self.put(ops, r, A, a, (-d, 0))
            inline.append(r)
            refs.append(r)
            h = self.across(r)
            lo, hi = min(A[0], B[0]), max(A[0], B[0])
            inset = 1.0 if self.plain(r) else 0.0       # the pin stubs of a resistor or capacitor are wire, not body
            rects.append(_rect(lo + inset, y - h, hi - inset, y + h))
            rects.append(_rect(lo + 0.8 - wr, y - 1.9, lo + 0.8, y - 0.25))      # the reference, on the wire before the body
            rects.append(_rect(hi - 0.8, y - 1.9, hi - 0.8 + wv, y - 0.25))      # the value, on the wire after it
            pts.append(A)
            cx, lead = B[0], max(G, _up(post_w - 0.2))
            sub = None
            if m is not None and self.kind(m) == "sup" and not self.plain(r):
                # an inductor or bead feeding a supply: that supply's capacitors hang at its output, under the supply's symbol
                sub = self.trunk(g, m, B[0], y, d, False, lead=lead, used=tuple(used) + tuple(refs))
            if sub:
                for key, mine in (("ops", ops), ("rects", rects), ("refs", refs), ("ends", ends), ("inline", inline)):
                    mine += sub[key]
            elif m is not None and self.kind(m) != "sig":
                E = (cx + d * lead, y)
                ops.append(("wire", [B, E]))
                ends.append((E, m, d))
            elif m is not None:
                sub = self.trunk(g, m, B[0], y, d, self.need_label(m, g, wired=((r, b),)), lead=lead, used=tuple(used) + tuple(refs), wired=((r, b),))
                if sub:
                    for key, mine in (("ops", ops), ("rects", rects), ("refs", refs), ("ends", ends), ("inline", inline)):
                        mine += sub[key]
        elif label:
            w = self.width(net)
            E = (cx + d * max(lead, G), y)
            pts.append(E)
            ops.append(("label", net, E, 0 if d > 0 else 180))
            rects.append(_rect(E[0], y - 1.9, E[0] + d * (w + 1.2), y + 0.3))
        if not ops:
            return None
        if len(pts) > 1:
            ops.append(("wire", pts))
            rects.append(_rect(pts[0][0], y - 0.2, pts[-1][0], y + 0.2))
        for p in dots:
            if p != pts[-1] or (k != "sig" and not first):
                ops.append(("dot", p))
        return {"ops": ops, "rects": rects, "refs": refs, "ends": ends, "inline": inline}

    # ---- drawing
    def emit(self, ops) -> None:
        s = self.s
        r = lambda v: round(v, 4)
        for op in ops:
            if op[0] == "wire":
                pts = []
                for p in op[1]:
                    if not pts or abs(p[0] - pts[-1][0]) > 1e-6 or abs(p[1] - pts[-1][1]) > 1e-6:
                        pts.append([r(p[0]), r(p[1])])
                if len(pts) > 1:
                    s._edit({"op": "add_wire", "points": pts})
            elif op[0] == "dot":
                s._edit({"op": "add_junction", "x": r(op[1][0]), "y": r(op[1][1])})
            elif op[0] == "sym":
                s._edit({"op": "add_symbol", "lib_id": "power:" + op[1], "x": r(op[2][0]), "y": r(op[2][1]), "rotation": 0})
            elif op[0] == "label":
                s._edit({"op": "add_label", "kind": "label", "text": op[1], "x": r(op[2][0]), "y": r(op[2][1]), "rotation": op[3]})
            elif op[0] == "part":
                spec = self.parts[op[1]]
                s.place(spec.get("lib"), at=op[2], ref=op[1], value=spec.get("value"), footprint=spec.get("footprint"), fields=spec.get("fields"), rotation=op[3])
                self.done.add(op[1])

    def power_ends(self, ends) -> list:
        """Wires that end on a rail: neighbours on the same rail are joined and share one symbol."""
        ops, i = [], 0
        while i < len(ends):
            j = i
            while j + 1 < len(ends) and ends[j + 1][1] == ends[i][1] and ends[j + 1][2] == ends[i][2] and abs(ends[j + 1][0][1] - ends[j][0][1]) <= 2 * G + 1e-6:
                j += 1
            run, net, d = ends[i:j + 1], ends[i][1], ends[i][2]
            if len(run) == 1:
                ops.append(("sym", net, run[0][0]))
            else:
                X = max(e[0][0] * d for e in run) * d
                ys = sorted(e[0][1] for e in run)
                for e in run:
                    ops.append(("wire", [e[0], (X, e[0][1])]))
                ops.append(("wire", [(X, yy) for yy in ys]))
                for yy in ys[1:-1]:
                    ops.append(("dot", (X, yy)))
                ops.append(("sym", net, (X, ys[-1] if self.kind(net) == "gnd" else ys[0])))
            i = j + 1
        return ops

    def big(self, g, ref) -> list:
        """An IC or connector at the scratch position with everything that hangs on its pins.  Returns the parts drawn in line."""
        s, spec = self.s, self.parts[ref]
        s.place(spec.get("lib"), at=SCRATCH, ref=ref, value=spec.get("value"), footprint=spec.get("footprint"), fields=spec.get("fields"), rotation=spec.get("rotation", 0))
        self.done.add(ref)
        s.flush()
        sides: dict = {}
        for p in s.pins(ref):
            if not p["hidden"]:
                sides.setdefault(p["side"], []).append(p)
        want = lambda p: self.intent.get((ref, p["number"])) or ""
        inline: list = []
        drawn: dict = {}      # what each side's wiring occupies, for the capacitors that hang from the supply rail above
        top_nets = {want(p) for p in sides.get("top", [])}
        for side in ("left", "right"):
            ps = sorted(sides.get(side, []), key=lambda p: p["y"])
            d = -1 if side == "left" else 1
            runs = []
            for p in ps:
                if not want(p):
                    continue
                if runs and want(runs[-1][-1]) == want(p) and abs(p["y"] - runs[-1][-1]["y"]) <= G + 1e-3 and ps.index(p) == ps.index(runs[-1][-1]) + 1:
                    runs[-1].append(p)
                else:
                    runs.append([p])
            taken, later, ends = [], [], []
            for run in runs:
                net = want(run[0])
                k = self.kind(net)
                wired = tuple((ref, p["number"]) for p in run)
                at = run[-1] if k == "gnd" else run[0] if k == "sup" else run[len(run) // 2]
                blocked = False
                if k != "sig":      # the symbol hangs from the pin of the run where it lies over no other pin's row
                    sx = (run[0]["x"] + d * G if len(run) > 1 else run[0]["x"]) + d * G
                    others = [q["y"] for q in ps if want(q) and q not in run]

                    def free(p):
                        r = self.sym_rect(net, (sx, p["y"]))
                        return not any(r[1] + 0.05 < yy < r[3] - 0.05 for yy in others)
                    pick = next((p for p in (reversed(run) if k == "gnd" else run) if free(p)), None)
                    blocked, at = pick is None, pick or at
                ops = []
                if len(run) > 1:
                    bx = run[0]["x"] + d * G
                    for p in run:
                        ops.append(("wire", [(p["x"], p["y"]), (bx, p["y"])]))
                    ops.append(("wire", [(bx, p["y"]) for p in run]))
                    for p in run[1:-1]:
                        ops.append(("dot", (bx, p["y"])))
                    origin = (bx, at["y"])
                    taken.append(_rect(run[0]["x"], run[0]["y"] - 0.2, bx, run[-1]["y"] + 0.2))
                else:
                    origin = (at["x"], at["y"])
                self.emit(ops)
                # a supply's capacitors hang at its supply pin on top of the part when it has one, not at a strap pin on the side
                busy = bool(self.smalls_on(net, g)) if k == "sig" else k == "sup" and net not in top_nets and 0 < len([r for r in self.smalls_on(net, g) if self.kind(self.other(r, net)[2]) == "gnd"]) <= 3
                if k == "sig" and not busy:
                    if self.need_label(net, g, wired=wired):
                        E = (origin[0] + d * G, origin[1])
                        self.emit([("wire", [origin, E]), ("label", net, E, 0 if d > 0 else 180)] + ([("dot", origin)] if len(run) > 1 else []))
                        taken.append(_rect(origin[0], origin[1] - 1.9, E[0] + d * (self.width(net) + 1.2), origin[1] + 0.3))
                    continue
                later.append((run, net, k, origin, wired, busy, len(run) > 1, blocked))
            lines: list = []
            soft: list = []      # rail symbols at the ends of wires: a neighbour ending on the same rail joins them instead of avoiding them
            clash = lambda rs: any(_hit(a, b) for a in rs for b in taken) or any(a[3] - a[1] > 0.5 and _hit(a, b) for a in rs for b in lines)

            def fits(plan):
                mine = {e[1] for e in plan["ends"]}
                if clash(plan["rects"]) or clash([self.sym_rect(e[1], e[0]) for e in plan["ends"]]):
                    return False
                return not any(_hit(a, b) for a in plan["rects"] for b, net in soft if net not in mine)
            # a supply or ground on several pins of one side: one bus beside the pins and one symbol, above for a supply, below for ground
            rows = [p["y"] for p in ps]
            for net in dict.fromkeys(e[1] for e in later if not e[5]):
                mine = [e for e in later if e[1] == net and not e[5]]
                gnd = self.kind(net) == "gnd"
                # one ground pin with a few pins under it drops past them the same way, so its symbol covers none of their wires
                drop = gnd and len(mine) == 1 and mine[0][7] and len([yy for yy in rows if yy > mine[0][3][1]]) <= 3
                if len(mine) < 2 and not drop:
                    continue
                ys = sorted(e[3][1] for e in mine)
                end = max(rows) + G if gnd else min(rows) - G
                for i in range(2, 60):
                    X = ps[0]["x"] + d * i * G
                    rs = [_rect(X - 1.0, min(ys[0], end), X + 1.0, max(ys[-1], end)), self.sym_rect(net, (X, end))]
                    if not clash(rs):
                        break
                ops = []
                for e in mine:
                    ops.append(("wire", [e[3], (X, e[3][1])]))
                    if e[6]:
                        ops.append(("dot", e[3]))
                    taken.append(_rect(e[3][0], e[3][1] - 0.2, X, e[3][1] + 0.2))
                ops.append(("wire", [(X, yy) for yy in (ys + [end] if gnd else [end] + ys)]))
                ops += [("dot", (X, yy)) for yy in (ys[1:] if gnd else ys[:-1])]
                ops.append(("sym", net, (X, end)))
                self.emit(ops)
                taken.append(self.sym_rect(net, (X, end)))
                lines.append(_rect(X - 0.3, min(ys[0], end), X + 0.3, max(ys[-1], end)))
                later = [e for e in later if e not in mine]
            later.sort(key=lambda e: (2, e[3][1]) if e[7] and not e[5] else (0, -e[3][1]) if e[2] == "gnd" and not e[5] else (1, e[3][1]))
            for run, net, k, origin, wired, busy, barred, _ in later:
                plan = None
                if busy:
                    for i in range(1, 44):
                        plan = self.trunk(g, net, origin[0], origin[1], d, k == "sig" and self.need_label(net, g, wired=wired), lead=i * G, wired=wired)
                        if not plan or fits(plan):
                            break
                        plan = None
                if plan:
                    if barred:
                        plan["ops"].append(("dot", origin))
                    self.emit(plan["ops"])
                    taken += plan["rects"]
                    soft += [(self.sym_rect(e[1], e[0]), e[1]) for e in plan["ends"]]
                    ends += plan["ends"]
                    inline += plan["inline"]
                    continue
                if k == "sig":      # no room on this pin: a label here, and its parts are drawn beside the IC from the same label
                    self.force.add(net)
                    for i in range(1, 30):
                        E = (origin[0] + d * i * G, origin[1])
                        if not clash([_rect(E[0], origin[1] - 1.9, E[0] + d * (self.width(net) + 1.2), origin[1] + 0.3)]) or i == 29:
                            break
                    self.emit([("wire", [origin, E]), ("label", net, E, 0 if d > 0 else 180)] + ([("dot", origin)] if barred else []))
                    taken.append(_rect(origin[0], origin[1] - 1.9, E[0] + d * (self.width(net) + 1.2), origin[1] + 0.3))
                    continue
                for i in range(1, 40):   # a supply or ground symbol, upright, clear of the neighbours' text
                    E = (origin[0] + d * i * G, origin[1])
                    rs = [self.sym_rect(net, E), _rect(origin[0], origin[1] - 0.2, E[0], origin[1] + 0.2)]
                    if not clash(rs) and not any(_hit(a, b) for a in rs for b, _ in soft):
                        break
                else:
                    E = (origin[0] + d * G, origin[1])
                    rs = [self.sym_rect(net, E)]
                self.emit([("wire", [origin, E]), ("sym", net, E)] + ([("dot", origin)] if barred else []))
                taken += rs
            self.emit(self.power_ends(sorted(ends, key=lambda e: e[0][1])))
            drawn[side] = taken + [r for r, _ in soft] + [_rect(e[0][0] - 3.0, e[0][1] - 7.0, e[0][0] + 3.0 + G, e[0][1] + 7.0) for e in ends]
        for side in ("top", "bottom"):
            ps = sorted(sides.get(side, []), key=lambda p: p["x"])
            v = -1 if side == "top" else 1
            power = [p for p in ps if want(p) and self.kind(want(p)) != "sig"]
            signal = [p for p in ps if want(p) and self.kind(want(p)) == "sig"]
            natural = lambda net: (self.kind(net) == "sup") == (side == "top")
            railed: set = set()
            dense = len(power) > 1 and not signal and min(b["x"] - a["x"] for a, b in zip(power, power[1:])) < 2 * G - 1e-3
            order = [n for n in dict.fromkeys(want(p) for p in power) if natural(n) and len([p for p in power if want(p) == n]) > 1] if dense else []
            # the supply's own capacitors (up to three) hang from its rail to the right of the part, as in a datasheet's application circuit
            caps: list = []
            if side == "top" and not signal and len(order) <= 1:
                nets_here = list(dict.fromkeys(want(p) for p in power if natural(want(p))))
                if len(nets_here) == 1 and (not order or order == nets_here):
                    caps = [r for r in self.smalls_on(nets_here[0], g) if self.kind(self.other(r, nets_here[0])[2]) == "gnd"]
                    if 0 < len(caps) <= 3 and len({self.other(r, nets_here[0])[2] for r in caps}) == 1:
                        order = nets_here
                    else:
                        caps = []
            if order:
                lo, hi = power[0]["x"], power[-1]["x"]
                for kk, net in enumerate(order):
                    mine = [p for p in power if want(p) == net]
                    rail = mine[0]["y"] + v * (G + kk * G)
                    if len(order) == 1:      # one rail: its symbol stands centred over (or under) its pins
                        sx = round((mine[0]["x"] + mine[-1]["x"]) / 2 / 1.27) * 1.27
                    else:
                        sx = lo - 3 * G * (kk // 2 + 1) if kk % 2 == 0 else hi + 3 * G * (kk // 2 + 1)
                    ops, capx = [], []
                    if caps:
                        try:
                            body = s.lib(self.lib(ref))["units"][0].get("body_box") or [0, 0, 0, 0]
                        except HarnessError:
                            body = [0, 0, 0, 0]
                        right = drawn.get("right", [])
                        edge = max([hi + G, SCRATCH[0] + body[2]] + [r[2] for r in right])
                        pitch = max(4 * G, _up(max(self.width(r, self.parts[r].get("value")) for r in caps) + 5.0))
                        x0 = hi + _up(edge - hi + 2 * G)
                        gnet = self.other(caps[0], net)[2]
                        bots = []
                        for i, r in enumerate(caps):
                            cx = x0 + i * pitch
                            a, _, _ = self.other(r, net)
                            bots.append(self.put(ops, r, (cx, rail), a, (0, -1)))
                            capx.append(cx)
                        if any(_hit(_rect(hi, rail - 0.3, capx[-1], rail + 0.3), r) for r in right):
                            ops, capx = [], []        # something on the right reaches up through the rail: these stay a bank beside the part
                        elif len(caps) == 1:
                            ops.append(("sym", gnet, bots[0]))
                        else:
                            by = max(q[1] for q in bots) + G
                            for q in bots:
                                ops.append(("wire", [q, (q[0], by)]))
                            ops.append(("wire", [(q[0], by) for q in bots]))
                            ops += [("dot", (q[0], by)) for q in bots[1:-1]]
                            ops.append(("sym", gnet, (bots[0][0], by)))
                    pinx = {p["x"] for p in mine}
                    xs = sorted(pinx | {sx} | set(capx))
                    ops += [("wire", [(p["x"], p["y"]), (p["x"], rail)]) for p in mine]
                    if len(xs) > 1:
                        ops.append(("wire", [(xx, rail) for xx in xs]))
                    for i, xx in enumerate(xs):      # a dot wherever three or more ends meet
                        n = (xx in pinx) + (abs(xx - sx) < 1e-6) + (xx in capx) + (i > 0) + (i < len(xs) - 1)
                        if n >= 3:
                            ops.append(("dot", (xx, rail)))
                    ops.append(("sym", net, (sx, rail)))
                    self.emit(ops)
                    railed |= {p["number"] for p in mine}
            prev = None
            for p in power:
                if p["number"] in railed:
                    continue
                net = want(p)
                near = prev is not None and p["x"] - prev[0] < 2 * G - 1e-3
                n = 3 if near and prev[1] == 1 else 1
                E = (p["x"], p["y"] + v * n * G)
                if natural(net):
                    self.emit([("wire", [(p["x"], p["y"]), E]), ("sym", net, E)])
                else:                      # a ground pin on top or a supply pin underneath: out, aside, then upright
                    F = (E[0] + (3 * G if p["x"] >= SCRATCH[0] else -3 * G), E[1])
                    self.emit([("wire", [(p["x"], p["y"]), E, F]), ("sym", net, F)])
                prev = (p["x"], n)
            for i, p in enumerate(sorted(signal, key=lambda p: -p["x"])):   # labels stay horizontal: out, a step aside, then the name
                net = want(p)
                if not self.need_label(net, g, wired=((ref, p["number"]),)) and not self.smalls_on(net, g):
                    continue
                self.force.add(net)
                E = (p["x"], p["y"] + v * (i + 1) * G)
                F = (E[0] + G, E[1])
                self.emit([("wire", [(p["x"], p["y"]), E, F]), ("label", net, F, 0)])
        return inline

    def bank(self, refs, sup, gnd) -> None:
        """Parts between one supply and ground in a row on shared rails, with one supply symbol and one ground symbol."""
        x, y = SCRATCH
        pitch = max(4 * G, _up(max(self.width(r, self.parts[r].get("value")) for r in refs) + 5.0))
        ops, tops, bots = [], [], []
        for i, r in enumerate(refs):
            a, b, _ = self.other(r, sup)
            half = self.span(r) / 2
            top = (x + i * pitch, y - half)
            bot = self.put(ops, r, top, a, (0, -1))
            tops.append(top)
            bots.append(bot)
        if len(refs) == 1:
            ops += [("sym", sup, tops[0]), ("sym", gnd, bots[0])]
        else:
            ty, by = min(t[1] for t in tops) - G, max(b[1] for b in bots) + G
            for t, b in zip(tops, bots):
                ops.append(("wire", [t, (t[0], ty)]))
                ops.append(("wire", [b, (b[0], by)]))
            ops.append(("wire", [(t[0], ty) for t in tops]))
            ops.append(("wire", [(b[0], by) for b in bots]))
            ops += [("dot", (t[0], ty)) for t in tops[:-1]] + [("dot", (b[0], by)) for b in bots[:-1]]
            ops += [("sym", sup, (tops[0][0], ty)), ("sym", gnd, (bots[0][0], by))]
        self.emit(ops)

    def chain(self, g, ref) -> list:
        """Small parts that hang on no IC pin, drawn left to right from a label or a rail.  Returns the parts drawn in line."""
        x, y = SCRATCH
        nets = [self.intent.get((ref, n)) for n in self.offs(ref)]
        start = next((n for n in nets if n and self.kind(n) == "sig" and self.need_label(n, g)), None)
        plan, head = None, []
        if start:
            head = [("label", start, (x, y), 180)]
            plan = self.trunk(g, start, x, y, 1, False)
            if not plan or ref not in plan["refs"]:
                plan = self.trunk(g, start, x, y, 1, False, first=ref)
        else:
            start = next((n for n in nets if n and self.kind(n) == "sup"), None) or next((n for n in nets if n and self.kind(n) == "gnd"), None)
            if start:
                head = [("sym", start, (x, y))]
            else:
                start = next((n for n in nets if n), None)
            if start:
                plan = self.trunk(g, start, x, y, 1, False, first=ref)
        if plan and ref in plan["refs"]:
            self.emit(head + plan["ops"] + self.power_ends(plan["ends"]))
            return plan["inline"]
        ops: list = []      # nothing to follow: the part alone, each pin with its symbol or its label
        nums = list(self.offs(ref))
        far = self.put(ops, ref, (x, y), nums[0], (-1, 0))
        for at, num, rot in (((x, y), nums[0], 180), (far, nums[1], 0)):
            net = self.intent.get((ref, num))
            if net and self.kind(net) != "sig":
                ops.append(("sym", net, at))
            elif net:
                ops.append(("label", net, at, rot))
        self.emit(ops)
        return [ref]

    # ---- the clusters of one block, side by side
    def settle(self, inline, at) -> list | None:
        """Fields into place, then the cluster as drawn is measured and moved so its top left corner is at `at`."""
        s = self.s
        s.flush()
        s._edit({"op": "autoplace_fields", "within": SCRATCH_BOX})
        s.flush()
        if inline:
            s._edit({"op": "clear_fields", "refs": list(inline), "inline": True})
            s.flush()
        s._edit({"op": "clear_fields", "within": SCRATCH_BOX})
        s.flush()
        ext = s.layout(within=SCRATCH_BOX, limit=1).get("extent")
        if not ext:
            return None
        dx, dy = _up(at[0] - ext[0]), _up(at[1] - ext[1])
        s._edit({"op": "move_region", "x0": SCRATCH_BOX[0], "y0": SCRATCH_BOX[1], "x1": SCRATCH_BOX[2], "y1": SCRATCH_BOX[3], "dx": dx, "dy": dy})
        s.flush()
        return [ext[0] + dx, ext[1] + dy, ext[2] + dx, ext[3] + dy]

    def run(self):
        """Draw every block in the assembly area, one under the other.  Returns [(name, band)], the parts placed, problems."""
        bands, placed, gy = [], [], 254.0
        for g, refs in self.groups.items():
            for r in refs:
                if r not in self.parts:
                    raise HarnessError(f"Group {g} names {r}, which is not in parts.")
            bigs = [r for r in refs if not self.small(r)]
            x0, y, w = ASSEMBLY_X, gy, 0.0
            for r in bigs:
                ext = self.settle(self.big(g, r), (x0, y))
                if ext:
                    y, w = ext[3] + 3 * G, max(w, ext[2] - x0)
            height = y - gy
            # beside the ICs: rows of capacitor banks and chains, wrapped
            cx0 = x0 + (w + 4 * G if bigs else 0)
            cx, cy, row = cx0, gy, 0.0
            limit = max(150.0, w)
            per_row = 10

            def beside(inline):
                nonlocal cx, cy, row, height
                ext = self.settle(inline, (cx, cy))
                if not ext:
                    return
                if cx > cx0 and ext[2] - cx0 > limit:        # past the row's end: start the next row and put it there
                    dx, dy = _up(cx0 - ext[0]), _up(cy + row + 2 * G - ext[1])
                    self.s._edit({"op": "move_region", "x0": ext[0] - 0.5, "y0": ext[1] - 0.5, "x1": ext[2] + 0.5, "y1": ext[3] + 0.5, "dx": dx, "dy": dy})
                    self.s.flush()
                    ext = [ext[0] + dx, ext[1] + dy, ext[2] + dx, ext[3] + dy]
                    cy, row = ext[1], 0.0
                cx, row = ext[2] + 3 * G, max(row, ext[3] - cy)
                height = max(height, ext[3] - gy)

            banks: dict = {}
            for r in refs:
                if r in self.done or not self.small(r):
                    continue
                kinds = {self.kind(self.intent.get((r, n))): self.intent.get((r, n)) for n in self.offs(r)}
                if "sup" in kinds and "gnd" in kinds:
                    banks.setdefault((kinds["sup"], kinds["gnd"]), []).append(r)
            if bigs and height > 70 and banks:      # beside a tall IC the capacitor rows stack to its height instead of running wide
                rows_free = max(1, int(height // 30))
                per_row = min(10, max(3, math.ceil(sum(len(v) for v in banks.values()) / rows_free)))
                limit = max(60.0, per_row * 13.0)
            for (sup, gnd), rs in banks.items():
                n = math.ceil(len(rs) / per_row)       # rows of even length: nine capacitors are three rows of three, not four, four and one
                size = math.ceil(len(rs) / n)
                for i in range(0, len(rs), size):
                    self.bank(rs[i:i + size], sup, gnd)
                    beside([])
            for labelled in (True, False):      # chains that start from a net's label first, then what is left
                for r in refs:
                    if r in self.done:
                        continue
                    if labelled and not any(n and self.kind(n) == "sig" and self.need_label(n, g) for n in (self.intent.get((r, q)) for q in self.offs(r))):
                        continue
                    beside(self.chain(g, r))
            placed += refs
            bands.append((g, [ASSEMBLY_X - 25.4, gy - 25.4, ASSEMBLY_X + 1200.0, gy + max(height, 25.4) + 25.4]))
            gy = _up(gy + max(height, 25.4) + 127.0)
        return bands, placed, self.problems
