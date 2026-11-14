//! EasyEDA (LCSC / JLCPCB) component data → KiCad library s-expressions.
//!
//! LCSC's catalogue shares its drawings with EasyEDA: one request for a part number
//! answers with the schematic symbol and the PCB package in EasyEDA's own text
//! format — shapes as `~`-separated records, lengths in units of 10 mil, Y down.
//! This module turns that into a KiCad library symbol (`(symbol "NAME" …)`, Y up,
//! millimetres) and a footprint (`(footprint "NAME" …)`), the same forms a
//! `.kicad_sym` library and a `.kicad_mod` file hold, so the result can be embedded
//! in a schematic or board, or written out as a library, with no further conversion.
//!
//! Nothing here touches the network; `convert` is a pure function of the response.

use serde_json::Value;

/// Bumped whenever the conversion changes, so cached drawings are rebuilt from the
/// stored vendor response instead of being served stale.
pub const CONVERTER_VERSION: i32 = 3;

/// EasyEDA length unit (10 mil) in millimetres.
const U: f64 = 0.254;

#[derive(Debug, Clone, Default)]
pub struct Converted {
    pub name: String,
    pub prefix: String,
    pub package: String,
    pub manufacturer: String,
    pub mpn: String,
    pub description: String,
    pub datasheet: String,
    pub symbol: Option<SymbolOut>,
    pub footprint: Option<FootprintOut>,
}

#[derive(Debug, Clone)]
pub struct SymbolOut {
    pub name: String,
    /// `(symbol "NAME" …)` with its units, without properties that depend on the
    /// library it ends up in (the caller adds Footprint, vendor fields, …).
    pub body: String,
    pub units: usize,
    pub pins: usize,
    /// Extent of the drawing in symbol coordinates (mm, Y up): min x, min y, max x, max y.
    pub bbox: [f64; 4],
    pub hide_pin_names: bool,
    pub hide_pin_numbers: bool,
    /// The pins were rearranged into KiCad library style ([`super::tidy`]).
    pub tidied: bool,
}

#[derive(Debug, Clone)]
pub struct FootprintOut {
    pub name: String,
    /// The children of the footprint after its header and properties: graphics, pads.
    pub body: String,
    pub pads: usize,
    pub through_hole: bool,
    pub bbox: [f64; 4],
    pub model: Option<Model3d>,
}

#[derive(Debug, Clone)]
pub struct Model3d {
    pub uuid: String,
    pub title: String,
    pub offset: [f64; 3],
    pub rotate: [f64; 3],
}

// ------------------------------------------------------------------ small helpers

/// A number the way KiCad writes it: fixed point, no trailing zeros, no "-0".
pub fn fnum(v: f64) -> String {
    let v = if v.is_finite() { v } else { 0.0 };
    let mut s = format!("{:.4}", v);
    while s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    if s == "-0" {
        s = "0".into();
    }
    s
}

/// A quoted s-expression string.
pub fn q(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => {}
            c if (c as u32) < 0x20 => o.push(' '),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// A name KiCad accepts for a library item: no `:` or `/`, no quotes, no spaces.
pub fn lib_name(s: &str) -> String {
    let mut o: String = s
        .trim()
        .chars()
        .map(|c| match c {
            ':' | '/' | '\\' | '"' | '\'' | '<' | '>' | '|' | '*' | '?' | '{' | '}' | '$' => '_',
            c if c.is_whitespace() || c.is_control() => '_',
            c => c,
        })
        .collect();
    while o.contains("__") {
        o = o.replace("__", "_");
    }
    let o = o.trim_matches('_').to_string();
    if o.is_empty() {
        "PART".into()
    } else {
        o
    }
}

fn f(s: &str) -> f64 {
    s.trim().parse::<f64>().unwrap_or(0.0)
}

fn fopt(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

fn vstr<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// A JSON value that may be a number or a numeric string.
fn vnum(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => f(s),
        _ => 0.0,
    }
}

fn shown(flag: &str) -> bool {
    !matches!(flag.trim(), "0" | "none" | "hide" | "false" | "N")
}

#[derive(Clone, Copy, Debug)]
struct BBox {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl BBox {
    fn empty() -> Self {
        BBox { x0: f64::MAX, y0: f64::MAX, x1: f64::MIN, y1: f64::MIN }
    }
    fn add(&mut self, x: f64, y: f64) {
        self.x0 = self.x0.min(x);
        self.y0 = self.y0.min(y);
        self.x1 = self.x1.max(x);
        self.y1 = self.y1.max(y);
    }
    fn is_empty(&self) -> bool {
        self.x0 > self.x1
    }
    fn arr(&self) -> [f64; 4] {
        if self.is_empty() {
            [0.0; 4]
        } else {
            [self.x0, self.y0, self.x1, self.y1]
        }
    }
}

// ------------------------------------------------------------------ SVG path data

#[derive(Debug, Clone, Copy)]
enum Seg {
    Line([f64; 2], [f64; 2]),
    Arc { from: [f64; 2], to: [f64; 2], rx: f64, ry: f64, rot: f64, large: bool, sweep: bool },
    Cubic([f64; 2], [f64; 2], [f64; 2], [f64; 2]),
}

/// The subset of SVG path data EasyEDA writes: M L H V A C Z, absolute or relative.
fn parse_path(d: &str) -> Vec<Seg> {
    let mut toks: Vec<String> = Vec::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, toks: &mut Vec<String>| {
        if !cur.is_empty() {
            toks.push(std::mem::take(cur));
        }
    };
    let mut prev = ' ';
    for c in d.chars() {
        if c.is_ascii_alphabetic() && c != 'e' && c != 'E' {
            flush(&mut cur, &mut toks);
            toks.push(c.to_string());
        } else if c == ',' || c.is_whitespace() {
            flush(&mut cur, &mut toks);
        } else if (c == '-' || c == '+') && !cur.is_empty() && prev != 'e' && prev != 'E' {
            flush(&mut cur, &mut toks);
            cur.push(c);
        } else if c == '.' && cur.contains('.') && !cur.contains('e') && !cur.contains('E') {
            flush(&mut cur, &mut toks);
            cur.push(c);
        } else {
            cur.push(c);
        }
        prev = c;
    }
    flush(&mut cur, &mut toks);

    let mut segs = Vec::new();
    let mut i = 0usize;
    let mut cmd = ' ';
    let mut p = [0.0f64, 0.0];
    let mut start = p;
    let next = |i: &mut usize, toks: &Vec<String>| -> Option<f64> {
        let v = toks.get(*i).and_then(|t| t.parse::<f64>().ok());
        if v.is_some() {
            *i += 1;
        }
        v
    };
    let mut guard = 0;
    while i < toks.len() && guard < 100_000 {
        guard += 1;
        let t = &toks[i];
        if t.len() == 1 && t.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            cmd = t.chars().next().unwrap();
            i += 1;
            if cmd == 'Z' || cmd == 'z' {
                if p != start {
                    segs.push(Seg::Line(p, start));
                }
                p = start;
                continue;
            }
        }
        let rel = cmd.is_ascii_lowercase();
        let base = if rel { p } else { [0.0, 0.0] };
        match cmd.to_ascii_uppercase() {
            'M' => {
                let (Some(x), Some(y)) = (next(&mut i, &toks), next(&mut i, &toks)) else { break };
                p = [base[0] + x, base[1] + y];
                start = p;
                // further pairs after a moveto are linetos
                cmd = if rel { 'l' } else { 'L' };
            }
            'L' => {
                let (Some(x), Some(y)) = (next(&mut i, &toks), next(&mut i, &toks)) else { break };
                let n = [base[0] + x, base[1] + y];
                segs.push(Seg::Line(p, n));
                p = n;
            }
            'H' => {
                let Some(x) = next(&mut i, &toks) else { break };
                let n = [if rel { p[0] + x } else { x }, p[1]];
                segs.push(Seg::Line(p, n));
                p = n;
            }
            'V' => {
                let Some(y) = next(&mut i, &toks) else { break };
                let n = [p[0], if rel { p[1] + y } else { y }];
                segs.push(Seg::Line(p, n));
                p = n;
            }
            'A' => {
                let mut v = [0.0; 7];
                let mut ok = true;
                for slot in v.iter_mut() {
                    match next(&mut i, &toks) {
                        Some(x) => *slot = x,
                        None => {
                            ok = false;
                            break;
                        }
                    }
                }
                if !ok {
                    break;
                }
                let n = [base[0] + v[5], base[1] + v[6]];
                segs.push(Seg::Arc { from: p, to: n, rx: v[0].abs(), ry: v[1].abs(), rot: v[2], large: v[3] != 0.0, sweep: v[4] != 0.0 });
                p = n;
            }
            'C' => {
                let mut v = [0.0; 6];
                let mut ok = true;
                for slot in v.iter_mut() {
                    match next(&mut i, &toks) {
                        Some(x) => *slot = x,
                        None => {
                            ok = false;
                            break;
                        }
                    }
                }
                if !ok {
                    break;
                }
                let c1 = [base[0] + v[0], base[1] + v[1]];
                let c2 = [base[0] + v[2], base[1] + v[3]];
                let n = [base[0] + v[4], base[1] + v[5]];
                segs.push(Seg::Cubic(p, c1, c2, n));
                p = n;
            }
            _ => {
                // an unsupported command: skip its numbers
                while next(&mut i, &toks).is_some() {}
            }
        }
    }
    segs
}

/// Centre, start angle and signed sweep (radians, in the path's own Y-down frame)
/// of an SVG elliptical arc; None when it degenerates to a line.
fn arc_center(from: [f64; 2], to: [f64; 2], rx: f64, ry: f64, rot_deg: f64, large: bool, sweep: bool) -> Option<([f64; 2], f64, f64, f64, f64)> {
    if rx < 1e-9 || ry < 1e-9 || (from[0] - to[0]).hypot(from[1] - to[1]) < 1e-9 {
        return None;
    }
    let phi = rot_deg.to_radians();
    let (s, c) = phi.sin_cos();
    let dx = (from[0] - to[0]) / 2.0;
    let dy = (from[1] - to[1]) / 2.0;
    let x1 = c * dx + s * dy;
    let y1 = -s * dx + c * dy;
    let (mut rx, mut ry) = (rx, ry);
    let lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if lam > 1.0 {
        let k = lam.sqrt();
        rx *= k;
        ry *= k;
    }
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let mut co = if den.abs() < 1e-12 { 0.0 } else { (num / den).max(0.0).sqrt() };
    if large == sweep {
        co = -co;
    }
    let cx1 = co * rx * y1 / ry;
    let cy1 = -co * ry * x1 / rx;
    let cx = c * cx1 - s * cy1 + (from[0] + to[0]) / 2.0;
    let cy = s * cx1 + c * cy1 + (from[1] + to[1]) / 2.0;
    let ang = |ux: f64, uy: f64| uy.atan2(ux);
    let a1 = ang((x1 - cx1) / rx, (y1 - cy1) / ry);
    let a2 = ang((-x1 - cx1) / rx, (-y1 - cy1) / ry);
    let mut d = a2 - a1;
    if sweep && d < 0.0 {
        d += std::f64::consts::TAU;
    } else if !sweep && d > 0.0 {
        d -= std::f64::consts::TAU;
    }
    Some(([cx, cy], a1, d, rx, ry))
}

/// Points along an elliptical arc (endpoints included).
fn arc_polyline(from: [f64; 2], to: [f64; 2], rx: f64, ry: f64, rot: f64, large: bool, sweep: bool, steps: usize) -> Vec<[f64; 2]> {
    let Some((c, a1, d, rx, ry)) = arc_center(from, to, rx, ry, rot, large, sweep) else { return vec![from, to] };
    let (s, co) = rot.to_radians().sin_cos();
    let n = steps.max(2);
    (0..=n)
        .map(|k| {
            let a = a1 + d * (k as f64) / (n as f64);
            let (ex, ey) = (rx * a.cos(), ry * a.sin());
            [c[0] + co * ex - s * ey, c[1] + s * ex + co * ey]
        })
        .collect()
}

/// The point halfway along a circular arc.
fn arc_mid(from: [f64; 2], to: [f64; 2], r: f64, large: bool, sweep: bool) -> Option<[f64; 2]> {
    let (c, a1, d, r, _) = arc_center(from, to, r, r, 0.0, large, sweep)?;
    let a = a1 + d / 2.0;
    Some([c[0] + r * a.cos(), c[1] + r * a.sin()])
}

fn cubic_polyline(p: [[f64; 2]; 4], steps: usize) -> Vec<[f64; 2]> {
    (0..=steps)
        .map(|k| {
            let t = k as f64 / steps as f64;
            let u = 1.0 - t;
            let w = [u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t];
            [
                w[0] * p[0][0] + w[1] * p[1][0] + w[2] * p[2][0] + w[3] * p[3][0],
                w[0] * p[0][1] + w[1] * p[1][1] + w[2] * p[2][1] + w[3] * p[3][1],
            ]
        })
        .collect()
}

fn parse_points(s: &str) -> Vec<[f64; 2]> {
    let nums: Vec<f64> = s.split(|c: char| c == ' ' || c == ',').filter(|t| !t.is_empty()).filter_map(fopt).collect();
    nums.chunks_exact(2).map(|c| [c[0], c[1]]).collect()
}

// ------------------------------------------------------------------ symbol

const STROKE: &str = "(stroke (width 0) (type default))";
const FONT: &str = "(effects (font (size 1.27 1.27)))";

struct SymCtx {
    ox: f64,
    oy: f64,
    bbox: BBox,
}

impl SymCtx {
    /// EasyEDA sheet coordinates → KiCad symbol coordinates (mm, Y up).
    fn pt(&mut self, x: f64, y: f64) -> (f64, f64) {
        let kx = (x - self.ox) * U;
        let ky = -(y - self.oy) * U;
        self.bbox.add(kx, ky);
        (kx, ky)
    }
    fn xy(&mut self, p: [f64; 2]) -> String {
        let (x, y) = self.pt(p[0], p[1]);
        format!("(xy {} {})", fnum(x), fnum(y))
    }
}

fn fill_of(fill: &str, stroke: &str) -> &'static str {
    let fl = fill.trim().to_ascii_lowercase();
    if fl.is_empty() || fl == "none" || fl == "transparent" {
        "(fill (type none))"
    } else if fl == stroke.trim().to_ascii_lowercase() {
        "(fill (type outline))"
    } else {
        "(fill (type background))"
    }
}

/// EasyEDA's library marks the pins of resistors, capacitors, connectors and the
/// like as inputs, which KiCad's ERC would report as undriven.  Only an IC's or a
/// transistor's pin types mean something; everything else is passive.
fn passive_part(prefix: &str) -> bool {
    !matches!(prefix.trim_end_matches('?').to_ascii_uppercase().as_str(), "U" | "IC" | "Q" | "T" | "VR" | "A" | "M" | "")
}

fn pin_type(code: &str, passive: bool) -> &'static str {
    if passive {
        return "passive";
    }
    match code.trim() {
        "1" => "input",
        "2" => "output",
        "3" => "bidirectional",
        "4" => "power_in",
        _ => "unspecified",
    }
}

struct PinStats {
    passive: bool,
    count: usize,
    names_hidden: usize,
    numbers_hidden: usize,
    /// the pins as read, and what else the unit draws, for [`super::tidy::arrange`]
    pins: Vec<super::tidy::RawPin>,
    art: super::tidy::Art,
}

/// One unit's shapes → its graphics and pins, appended to `out`.
fn symbol_shapes(shapes: &[Value], cx: &mut SymCtx, out: &mut String, stats: &mut PinStats) {
    for sh in shapes {
        let Some(line) = sh.as_str() else { continue };
        let segs: Vec<&str> = line.split("^^").collect();
        let fl: Vec<&str> = segs[0].split('~').collect();
        let g = |i: usize| -> &str { fl.get(i).copied().unwrap_or("") };
        match fl[0] {
            "P" => {
                let (px, py) = (f(g(4)), f(g(5)));
                let rot = f(g(6));
                // The pin's line, drawn from the connection point toward the body.
                let path = segs.get(2).map(|s| s.split('~').next().unwrap_or("")).unwrap_or("");
                let mut len = 10.0;
                let mut angle: Option<i32> = None;
                let lower = path.to_ascii_lowercase();
                if let Some(pos) = lower.rfind('h') {
                    if let Some(v) = fopt(lower[pos + 1..].split_whitespace().next().unwrap_or("")) {
                        len = v.abs();
                        if path.as_bytes()[pos] == b'h' {
                            angle = Some(if v >= 0.0 { 0 } else { 180 });
                        }
                    }
                } else if let Some(pos) = lower.rfind('v') {
                    if let Some(v) = fopt(lower[pos + 1..].split_whitespace().next().unwrap_or("")) {
                        len = v.abs();
                        if path.as_bytes()[pos] == b'v' {
                            // EasyEDA's +y is down the sheet; a KiCad pin at 270° runs downward.
                            angle = Some(if v >= 0.0 { 270 } else { 90 });
                        }
                    }
                }
                let angle = angle.unwrap_or_else(|| (((180.0 + rot) as i32 % 360) + 360) % 360);
                let name_f: Vec<&str> = segs.get(3).map(|s| s.split('~').collect()).unwrap_or_default();
                let num_f: Vec<&str> = segs.get(4).map(|s| s.split('~').collect()).unwrap_or_default();
                let name = name_f.get(4).copied().unwrap_or("").trim();
                let number = num_f.get(4).copied().unwrap_or("").trim();
                let number = if number.is_empty() { g(3).trim() } else { number };
                let dot = segs.get(5).map(|s| shown(s.split('~').next().unwrap_or("0"))).unwrap_or(false);
                let clock = segs.get(6).map(|s| shown(s.split('~').next().unwrap_or("0"))).unwrap_or(false);
                let style = match (dot, clock) {
                    (true, true) => "inverted_clock",
                    (true, false) => "inverted",
                    (false, true) => "clock",
                    _ => "line",
                };
                stats.count += 1;
                if !name_f.first().map(|s| shown(s)).unwrap_or(true) {
                    stats.names_hidden += 1;
                }
                if !num_f.first().map(|s| shown(s)).unwrap_or(true) {
                    stats.numbers_hidden += 1;
                }
                let (kx, ky) = cx.pt(px, py);
                // the far end of the pin counts toward the extent too
                let l = len * U;
                let (ex, ey) = match angle {
                    0 => (kx + l, ky),
                    180 => (kx - l, ky),
                    90 => (kx, ky + l),
                    _ => (kx, ky - l),
                };
                cx.bbox.add(ex, ey);
                stats.pins.push(super::tidy::RawPin {
                    etype: pin_type(g(2), stats.passive).to_string(),
                    style: style.to_string(),
                    name: name.to_string(),
                    number: number.to_string(),
                });
                out.push_str(&format!(
                    "\t\t\t(pin {} {} (at {} {} {}) (length {}) (name {} {FONT}) (number {} {FONT}))\n",
                    pin_type(g(2), stats.passive),
                    style,
                    fnum(kx),
                    fnum(ky),
                    angle,
                    fnum(l),
                    q(if name.is_empty() { "~" } else { name }),
                    q(if number.is_empty() { "~" } else { number }),
                ));
            }
            "R" => {
                stats.art.rects += 1;
                let (x, y, w, h) = (f(g(1)), f(g(2)), f(g(5)), f(g(6)));
                let (x0, y0) = cx.pt(x, y);
                let (x1, y1) = cx.pt(x + w, y + h);
                // An IC's body is filled with the sheet's body colour, as KiCad's own
                // libraries do; EasyEDA leaves it empty.  Passives stay as drawn.
                let fill = if stats.passive { fill_of(g(10), g(7)) } else { "(fill (type background))" };
                out.push_str(&format!("\t\t\t(rectangle (start {} {}) (end {} {}) {STROKE} {fill})\n", fnum(x0), fnum(y0), fnum(x1), fnum(y1)));
            }
            "C" => {
                stats.art.dots += 1;
                let (x, y, r) = (f(g(1)), f(g(2)), f(g(3)));
                let (kx, ky) = cx.pt(x, y);
                cx.pt(x - r, y - r);
                cx.pt(x + r, y + r);
                out.push_str(&format!(
                    "\t\t\t(circle (center {} {}) (radius {}) {STROKE} {})\n",
                    fnum(kx),
                    fnum(ky),
                    fnum(r * U),
                    fill_of(g(7), g(4))
                ));
            }
            "E" => {
                stats.art.dots += 1;
                let (x, y, rx, ry) = (f(g(1)), f(g(2)), f(g(3)), f(g(4)));
                if (rx - ry).abs() < 1e-6 {
                    let (kx, ky) = cx.pt(x, y);
                    cx.pt(x - rx, y - rx);
                    cx.pt(x + rx, y + rx);
                    out.push_str(&format!(
                        "\t\t\t(circle (center {} {}) (radius {}) {STROKE} {})\n",
                        fnum(kx),
                        fnum(ky),
                        fnum(rx * U),
                        fill_of(g(8), g(5))
                    ));
                } else {
                    let pts: Vec<String> = (0..=36)
                        .map(|k| {
                            let a = (k as f64) * std::f64::consts::TAU / 36.0;
                            cx.xy([x + rx * a.cos(), y + ry * a.sin()])
                        })
                        .collect();
                    out.push_str(&format!("\t\t\t(polyline (pts {}) {STROKE} {})\n", pts.join(" "), fill_of(g(8), g(5))));
                }
            }
            "PL" | "PG" => {
                stats.art.other += 1;
                let mut pts = parse_points(g(1));
                if pts.len() < 2 {
                    continue;
                }
                if fl[0] == "PG" && pts.first() != pts.last() {
                    pts.push(pts[0]);
                }
                let s: Vec<String> = pts.iter().map(|p| cx.xy(*p)).collect();
                out.push_str(&format!("\t\t\t(polyline (pts {}) {STROKE} {})\n", s.join(" "), fill_of(g(5), g(2))));
            }
            "A" | "PT" => {
                stats.art.other += 1;
                let fill = fill_of(g(if fl[0] == "A" { 6 } else { 5 }), g(if fl[0] == "A" { 3 } else { 2 }));
                let path = parse_path(g(1));
                // consecutive straight runs become one polyline; arcs and curves their own shapes
                let mut run: Vec<[f64; 2]> = Vec::new();
                let flush = |run: &mut Vec<[f64; 2]>, cx: &mut SymCtx, out: &mut String| {
                    if run.len() >= 2 {
                        let s: Vec<String> = run.iter().map(|p| cx.xy(*p)).collect();
                        out.push_str(&format!("\t\t\t(polyline (pts {}) {STROKE} {fill})\n", s.join(" ")));
                    }
                    run.clear();
                };
                for sg in path {
                    match sg {
                        Seg::Line(a, b) => {
                            if run.last() != Some(&a) {
                                flush(&mut run, cx, out);
                                run.push(a);
                            }
                            run.push(b);
                        }
                        Seg::Arc { from, to, rx, ry, rot, large, sweep } => {
                            flush(&mut run, cx, out);
                            if (rx - ry).abs() < 1e-6 {
                                if let Some(mid) = arc_mid(from, to, rx, large, sweep) {
                                    let (sx, sy) = cx.pt(from[0], from[1]);
                                    let (mx, my) = cx.pt(mid[0], mid[1]);
                                    let (ex, ey) = cx.pt(to[0], to[1]);
                                    out.push_str(&format!(
                                        "\t\t\t(arc (start {} {}) (mid {} {}) (end {} {}) {STROKE} {fill})\n",
                                        fnum(sx),
                                        fnum(sy),
                                        fnum(mx),
                                        fnum(my),
                                        fnum(ex),
                                        fnum(ey)
                                    ));
                                    continue;
                                }
                            }
                            let pts = arc_polyline(from, to, rx, ry, rot, large, sweep, 24);
                            let s: Vec<String> = pts.iter().map(|p| cx.xy(*p)).collect();
                            out.push_str(&format!("\t\t\t(polyline (pts {}) {STROKE} {fill})\n", s.join(" ")));
                        }
                        Seg::Cubic(a, b, c, d) => {
                            flush(&mut run, cx, out);
                            let s: Vec<String> = [a, b, c, d].iter().map(|p| cx.xy(*p)).collect();
                            out.push_str(&format!("\t\t\t(bezier (pts {}) {STROKE} {fill})\n", s.join(" ")));
                        }
                    }
                }
                flush(&mut run, cx, out);
            }
            "T" => {
                // T~mark~x~y~rotation~color~font~size~weight~style~baseline~type~text~visible~anchor~id
                let text = g(12);
                if g(11) != "comment" || text.trim().is_empty() || !shown(g(13)) {
                    continue;
                }
                let (kx, ky) = cx.pt(f(g(2)), f(g(3)));
                let rot = ((f(g(4)) as i32 % 360) + 360) % 360;
                let justify = match g(14) {
                    "start" => " (justify left)",
                    "end" => " (justify right)",
                    _ => "",
                };
                out.push_str(&format!(
                    "\t\t\t(text {} (at {} {} {}) (effects (font (size 1.27 1.27)){justify}))\n",
                    q(text),
                    fnum(kx),
                    fnum(ky),
                    if rot == 90 || rot == 270 { 900 } else { 0 }
                ));
            }
            _ => {}
        }
    }
}

/// Where the first pin of a unit sits relative to the declared origin, modulo the
/// 50 mil grid: shifting the origin by that much puts the pins on KiCad's grid.
fn grid_shift(shapes: &[Value], ox: f64, oy: f64) -> (f64, f64) {
    for sh in shapes {
        let Some(line) = sh.as_str() else { continue };
        if !line.starts_with("P~") {
            continue;
        }
        let fl: Vec<&str> = line.split("^^").next().unwrap_or("").split('~').collect();
        if fl.len() > 5 {
            let r = |v: f64| {
                let m = v.rem_euclid(5.0);
                if m > 2.5 {
                    m - 5.0
                } else {
                    m
                }
            };
            return (r(f(fl[4]) - ox), r(f(fl[5]) - oy));
        }
    }
    (0.0, 0.0)
}

fn convert_symbol(name: &str, prefix: &str, units: &[&Value], tidy: bool) -> Option<SymbolOut> {
    let mut body = String::new();
    let mut stats = PinStats { passive: passive_part(prefix), count: 0, names_hidden: 0, numbers_hidden: 0, pins: Vec::new(), art: Default::default() };
    let mut bbox = BBox::empty();
    let mut n_units = 0;
    for data in units {
        let Some(shapes) = data.get("shape").and_then(Value::as_array) else { continue };
        let head = data.get("head");
        let ox = vnum(head.and_then(|h| h.get("x")));
        let oy = vnum(head.and_then(|h| h.get("y")));
        let (sx, sy) = grid_shift(shapes, ox, oy);
        let mut cx = SymCtx { ox: ox + sx, oy: oy + sy, bbox: BBox::empty() };
        let mut unit = String::new();
        symbol_shapes(shapes, &mut cx, &mut unit, &mut stats);
        if unit.is_empty() {
            continue;
        }
        n_units += 1;
        body.push_str(&format!("\t\t(symbol {}\n{unit}\t\t)\n", q(&format!("{name}_{n_units}_1"))));
        if !cx.bbox.is_empty() {
            bbox.add(cx.bbox.x0, cx.bbox.y0);
            bbox.add(cx.bbox.x1, cx.bbox.y1);
        }
    }
    if n_units == 0 {
        return None;
    }
    // one plain box: redraw it in KiCad library style (power up, ground down, ports in order)
    let mut tidied = false;
    if tidy && n_units == 1 {
        if let Some(t) = super::tidy::arrange(&stats.pins, &stats.art, prefix) {
            body = format!("\t\t(symbol {}\n{}\t\t)\n", q(&format!("{name}_1_1")), t.unit);
            bbox = BBox::empty();
            bbox.add(t.bbox[0], t.bbox[1]);
            bbox.add(t.bbox[2], t.bbox[3]);
            tidied = true;
        }
    }
    Some(SymbolOut {
        tidied,
        name: name.to_string(),
        body,
        units: n_units,
        pins: stats.count,
        bbox: bbox.arr(),
        hide_pin_names: stats.count > 0 && stats.names_hidden == stats.count,
        hide_pin_numbers: stats.count > 0 && stats.numbers_hidden == stats.count,
    })
}

// ------------------------------------------------------------------ footprint

fn fp_layer(id: &str) -> Option<&'static str> {
    Some(match id.trim() {
        "1" => "F.Cu",
        "2" => "B.Cu",
        "3" => "F.SilkS",
        "4" => "B.SilkS",
        "5" => "F.Paste",
        "6" => "B.Paste",
        "7" => "F.Mask",
        "8" => "B.Mask",
        "10" | "11" => "Edge.Cuts",
        "12" => "Cmts.User",
        "13" => "F.Fab",
        "14" => "B.Fab",
        "15" => "Dwgs.User",
        "99" | "100" | "101" => "F.Fab",
        _ => return None,
    })
}

struct FpCtx {
    ox: f64,
    oy: f64,
    /// Extent of pads and outline, for the courtyard.
    bbox: BBox,
}

impl FpCtx {
    fn pt(&self, x: f64, y: f64) -> (f64, f64) {
        ((x - self.ox) * U, (y - self.oy) * U)
    }
    fn grow(&mut self, x: f64, y: f64) {
        self.bbox.add(x, y);
    }
}

fn fp_stroke(w: f64) -> String {
    format!("(stroke (width {}) (type solid))", fnum(w.max(0.01)))
}

fn is_layer_id(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.len() <= 3 && t.chars().all(|c| c.is_ascii_digit())
}

fn pad_number(raw: &str) -> String {
    let raw = raw.trim();
    // "A(1)"-style numbers name the pin in the brackets
    if let (Some(a), Some(b)) = (raw.find('('), raw.rfind(')')) {
        if b > a + 1 {
            return raw[a + 1..b].to_string();
        }
    }
    raw.to_string()
}

fn norm_angle(a: f64) -> f64 {
    let mut a = a % 360.0;
    if a > 180.0 {
        a -= 360.0;
    } else if a <= -180.0 {
        a += 360.0;
    }
    a
}

fn convert_footprint(name: &str, data: &Value) -> Option<FootprintOut> {
    let shapes = data.get("shape").and_then(Value::as_array)?;
    let head = data.get("head");
    let mut cx = FpCtx { ox: vnum(head.and_then(|h| h.get("x"))), oy: vnum(head.and_then(|h| h.get("y"))), bbox: BBox::empty() };
    let mut gfx = String::new();
    let mut pads = String::new();
    let mut n_pads = 0usize;
    let mut through_hole = false;
    let mut model: Option<Model3d> = None;

    for sh in shapes {
        let Some(line) = sh.as_str() else { continue };
        let fl: Vec<&str> = line.split('~').collect();
        let g = |i: usize| -> &str { fl.get(i).copied().unwrap_or("") };
        match fl[0] {
            "PAD" => {
                let shape = g(1);
                let (x, y) = cx.pt(f(g(2)), f(g(3)));
                let (mut w, mut h) = (f(g(4)) * U, f(g(5)) * U);
                let layer = g(6).trim();
                let number = pad_number(g(8));
                let hole_r = f(g(9)) * U;
                let rot = norm_angle(f(g(11)));
                let hole_len = f(g(13)) * U;
                let plated = !matches!(g(15).trim(), "N" | "n" | "false" | "0");
                let th = hole_r > 0.0;
                if w <= 0.0 {
                    w = h.max(0.1);
                }
                if h <= 0.0 {
                    h = w;
                }
                let (kind, layers) = if th {
                    through_hole = true;
                    if plated {
                        ("thru_hole", "\"*.Cu\" \"*.Mask\"")
                    } else {
                        ("np_thru_hole", "\"*.Cu\" \"*.Mask\"")
                    }
                } else if layer == "2" {
                    ("smd", "\"B.Cu\" \"B.Paste\" \"B.Mask\"")
                } else {
                    ("smd", "\"F.Cu\" \"F.Paste\" \"F.Mask\"")
                };
                let drill = if !th {
                    String::new()
                } else if hole_len > 0.0 && (hole_len - hole_r * 2.0).abs() > 1e-6 {
                    // a slot: its long axis follows the pad's long axis
                    let d = hole_r * 2.0;
                    let (long, short) = (hole_len.max(d), hole_len.min(d));
                    if h > w {
                        format!(" (drill oval {} {})", fnum(short), fnum(long))
                    } else {
                        format!(" (drill oval {} {})", fnum(long), fnum(short))
                    }
                } else {
                    format!(" (drill {})", fnum(hole_r * 2.0))
                };
                let pts = if shape == "POLYGON" { parse_points(g(10)) } else { Vec::new() };
                if shape == "POLYGON" && pts.len() >= 3 {
                    // a custom pad: a small anchor at the pad's position plus the outline, in pad coordinates
                    let rel: Vec<String> = pts
                        .iter()
                        .map(|p| {
                            let (px, py) = cx.pt(p[0], p[1]);
                            cx.grow(px, py);
                            format!("(xy {} {})", fnum(px - x), fnum(py - y))
                        })
                        .collect();
                    let a = w.min(h).clamp(0.05, 0.2);
                    pads.push_str(&format!(
                        "\t(pad {} {kind} custom (at {} {}) (size {} {}){drill} (layers {layers}) (options (clearance outline) (anchor circle)) (primitives (gr_poly (pts {}) (width 0) (fill yes))))\n",
                        q(&number),
                        fnum(x),
                        fnum(y),
                        fnum(a),
                        fnum(a),
                        rel.join(" ")
                    ));
                } else {
                    let kshape = match shape {
                        "RECT" => "rect",
                        "OVAL" => "oval",
                        "ELLIPSE" => {
                            if (w - h).abs() < 1e-6 {
                                "circle"
                            } else {
                                "oval"
                            }
                        }
                        _ => "rect",
                    };
                    let at = if rot.abs() > 1e-6 {
                        format!("(at {} {} {})", fnum(x), fnum(y), fnum(rot))
                    } else {
                        format!("(at {} {})", fnum(x), fnum(y))
                    };
                    pads.push_str(&format!(
                        "\t(pad {} {kind} {kshape} {at} (size {} {}){drill} (layers {layers}))\n",
                        q(&number),
                        fnum(w),
                        fnum(h)
                    ));
                    // extent, allowing for a quarter-turned pad
                    let quarter = ((rot.abs() / 90.0).round() as i64) % 2 == 1;
                    let (ew, eh) = if quarter { (h, w) } else { (w, h) };
                    cx.grow(x - ew / 2.0, y - eh / 2.0);
                    cx.grow(x + ew / 2.0, y + eh / 2.0);
                }
                n_pads += 1;
            }
            "TRACK" => {
                let Some(layer) = fp_layer(g(2)) else { continue };
                let w = f(g(1)) * U;
                let pts = parse_points(g(4));
                for pair in pts.windows(2) {
                    let (x0, y0) = cx.pt(pair[0][0], pair[0][1]);
                    let (x1, y1) = cx.pt(pair[1][0], pair[1][1]);
                    if layer.ends_with("SilkS") || layer.ends_with("Fab") {
                        cx.grow(x0, y0);
                        cx.grow(x1, y1);
                    }
                    gfx.push_str(&format!(
                        "\t(fp_line (start {} {}) (end {} {}) {} (layer {}))\n",
                        fnum(x0),
                        fnum(y0),
                        fnum(x1),
                        fnum(y1),
                        fp_stroke(w),
                        q(layer)
                    ));
                }
            }
            "CIRCLE" => {
                let Some(layer) = fp_layer(g(5)) else { continue };
                let (x, y) = cx.pt(f(g(1)), f(g(2)));
                let r = f(g(3)) * U;
                if r <= 0.0 {
                    continue;
                }
                if layer.ends_with("SilkS") || layer.ends_with("Fab") {
                    cx.grow(x - r, y - r);
                    cx.grow(x + r, y + r);
                }
                gfx.push_str(&format!(
                    "\t(fp_circle (center {} {}) (end {} {}) {} (fill no) (layer {}))\n",
                    fnum(x),
                    fnum(y),
                    fnum(x + r),
                    fnum(y),
                    fp_stroke(f(g(4)) * U),
                    q(layer)
                ));
            }
            "ARC" => {
                let Some(layer) = fp_layer(g(2)) else { continue };
                let w = f(g(1)) * U;
                for sg in parse_path(g(4)) {
                    match sg {
                        Seg::Arc { from, to, rx, ry, rot, large, sweep } => {
                            let circular = (rx - ry).abs() < 1e-6;
                            if let Some(mid) = if circular { arc_mid(from, to, rx, large, sweep) } else { None } {
                                let (sx, sy) = cx.pt(from[0], from[1]);
                                let (mx, my) = cx.pt(mid[0], mid[1]);
                                let (ex, ey) = cx.pt(to[0], to[1]);
                                gfx.push_str(&format!(
                                    "\t(fp_arc (start {} {}) (mid {} {}) (end {} {}) {} (layer {}))\n",
                                    fnum(sx),
                                    fnum(sy),
                                    fnum(mx),
                                    fnum(my),
                                    fnum(ex),
                                    fnum(ey),
                                    fp_stroke(w),
                                    q(layer)
                                ));
                            } else {
                                let pts = arc_polyline(from, to, rx, ry, rot, large, sweep, 16);
                                for pair in pts.windows(2) {
                                    let (x0, y0) = cx.pt(pair[0][0], pair[0][1]);
                                    let (x1, y1) = cx.pt(pair[1][0], pair[1][1]);
                                    gfx.push_str(&format!(
                                        "\t(fp_line (start {} {}) (end {} {}) {} (layer {}))\n",
                                        fnum(x0),
                                        fnum(y0),
                                        fnum(x1),
                                        fnum(y1),
                                        fp_stroke(w),
                                        q(layer)
                                    ));
                                }
                            }
                        }
                        Seg::Line(a, b) => {
                            let (x0, y0) = cx.pt(a[0], a[1]);
                            let (x1, y1) = cx.pt(b[0], b[1]);
                            gfx.push_str(&format!(
                                "\t(fp_line (start {} {}) (end {} {}) {} (layer {}))\n",
                                fnum(x0),
                                fnum(y0),
                                fnum(x1),
                                fnum(y1),
                                fp_stroke(w),
                                q(layer)
                            ));
                        }
                        Seg::Cubic(..) => {}
                    }
                }
            }
            "RECT" => {
                // RECT~x~y~width~height~layer~id~locked~strokeWidth~…  (older data swaps layer and stroke)
                let (layer_s, stroke_s) = if is_layer_id(g(5)) && fp_layer(g(5)).is_some() { (g(5), g(8)) } else { (g(7), g(5)) };
                let Some(layer) = fp_layer(layer_s) else { continue };
                let (x0, y0) = cx.pt(f(g(1)), f(g(2)));
                let (x1, y1) = cx.pt(f(g(1)) + f(g(3)), f(g(2)) + f(g(4)));
                let w = f(stroke_s) * U;
                let filled = w <= 0.0;
                gfx.push_str(&format!(
                    "\t(fp_rect (start {} {}) (end {} {}) {} (fill {}) (layer {}))\n",
                    fnum(x0),
                    fnum(y0),
                    fnum(x1),
                    fnum(y1),
                    fp_stroke(if filled { 0.0 } else { w }),
                    if filled { "yes" } else { "no" },
                    q(layer)
                ));
            }
            "HOLE" => {
                let (x, y) = cx.pt(f(g(1)), f(g(2)));
                let d = f(g(3)) * U * 2.0;
                if d <= 0.0 {
                    continue;
                }
                through_hole = true;
                cx.grow(x - d / 2.0, y - d / 2.0);
                cx.grow(x + d / 2.0, y + d / 2.0);
                pads.push_str(&format!(
                    "\t(pad \"\" np_thru_hole circle (at {} {}) (size {} {}) (drill {}) (layers \"*.Cu\" \"*.Mask\"))\n",
                    fnum(x),
                    fnum(y),
                    fnum(d),
                    fnum(d),
                    fnum(d)
                ));
            }
            "VIA" => {
                let (x, y) = cx.pt(f(g(1)), f(g(2)));
                let d = f(g(3)) * U;
                let drill = f(g(5)) * U * 2.0;
                if d <= 0.0 || drill <= 0.0 {
                    continue;
                }
                through_hole = true;
                pads.push_str(&format!(
                    "\t(pad \"\" thru_hole circle (at {} {}) (size {} {}) (drill {}) (layers \"*.Cu\" \"*.Mask\"))\n",
                    fnum(x),
                    fnum(y),
                    fnum(d),
                    fnum(d),
                    fnum(drill)
                ));
            }
            "SOLIDREGION" => {
                // SOLIDREGION~layer~net~path~type~id — drawings only; copper pours inside a package are left out
                let Some(layer) = fp_layer(g(1)) else { continue };
                if layer.ends_with(".Cu") || layer == "Edge.Cuts" || g(4) != "solid" {
                    continue;
                }
                let mut pts: Vec<[f64; 2]> = Vec::new();
                for sg in parse_path(g(3)) {
                    match sg {
                        Seg::Line(a, b) => {
                            if pts.last() != Some(&a) {
                                pts.push(a);
                            }
                            pts.push(b);
                        }
                        Seg::Arc { from, to, rx, ry, rot, large, sweep } => pts.extend(arc_polyline(from, to, rx, ry, rot, large, sweep, 12)),
                        Seg::Cubic(a, b, c, d) => pts.extend(cubic_polyline([a, b, c, d], 12)),
                    }
                }
                pts.dedup();
                if pts.len() < 3 {
                    continue;
                }
                let s: Vec<String> = pts
                    .iter()
                    .map(|p| {
                        let (x, y) = cx.pt(p[0], p[1]);
                        format!("(xy {} {})", fnum(x), fnum(y))
                    })
                    .collect();
                gfx.push_str(&format!("\t(fp_poly (pts {}) (stroke (width 0) (type solid)) (fill yes) (layer {}))\n", s.join(" "), q(layer)));
            }
            "TEXT" => {
                // TEXT~type~x~y~strokeWidth~rotation~mirror~layer~net~fontSize~text~path~display~id
                if matches!(g(1), "N" | "P" | "PK") || !shown(g(12)) || g(10).trim().is_empty() {
                    continue;
                }
                let Some(layer) = fp_layer(g(7)) else { continue };
                let (x, y) = cx.pt(f(g(2)), f(g(3)));
                let size = (f(g(9)) * U).clamp(0.4, 3.0);
                let thick = (f(g(4)) * U).clamp(0.05, size / 4.0);
                let rot = norm_angle(f(g(5)));
                let mirror = if layer.starts_with("B.") { " (justify mirror)" } else { "" };
                gfx.push_str(&format!(
                    "\t(fp_text user {} (at {} {} {}) (layer {}) (effects (font (size {} {}) (thickness {})){mirror}))\n",
                    q(g(10)),
                    fnum(x),
                    fnum(y),
                    fnum(rot),
                    q(layer),
                    fnum(size),
                    fnum(size),
                    fnum(thick)
                ));
            }
            "SVGNODE" => {
                let Ok(node) = serde_json::from_str::<Value>(g(1)) else { continue };
                let attrs = node.get("attrs").cloned().unwrap_or(Value::Null);
                if vstr(&attrs, "c_etype") != "outline3D" || vstr(&attrs, "uuid").is_empty() {
                    continue;
                }
                let origin: Vec<f64> = vstr(&attrs, "c_origin").split(',').map(f).collect();
                let rot: Vec<f64> = vstr(&attrs, "c_rotation").split(',').map(f).collect();
                let (mx, my) = if origin.len() >= 2 { cx.pt(origin[0], origin[1]) } else { (0.0, 0.0) };
                let z = vnum(attrs.get("z")) * U;
                let r = |i: usize| (360.0 - rot.get(i).copied().unwrap_or(0.0)).rem_euclid(360.0);
                model = Some(Model3d {
                    uuid: vstr(&attrs, "uuid").to_string(),
                    title: vstr(&attrs, "title").to_string(),
                    // KiCad's model offset has Y up
                    offset: [(mx * 1000.0).round() / 1000.0, (-my * 1000.0).round() / 1000.0, (-z * 1000.0).round() / 1000.0],
                    rotate: [r(0), r(1), r(2)],
                });
            }
            _ => {}
        }
    }
    if n_pads == 0 && gfx.is_empty() {
        return None;
    }
    Some(FootprintOut { name: name.to_string(), body: format!("{gfx}{pads}"), pads: n_pads, through_hole, bbox: cx.bbox.arr(), model })
}

// ------------------------------------------------------------------ entry point

/// The first non-empty of several spellings of a component parameter (older data
/// prefixes the purchasing fields with `BOM_`).
pub fn cpara_any<'a>(cpara: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter().map(|k| vstr(cpara, k)).find(|v| !v.trim().is_empty()).unwrap_or("")
}

/// "ST(意法半导体)" → "ST": the catalogue appends the maker's Chinese name in brackets.
pub fn clean_maker(s: &str) -> String {
    let cut = s.find(|c| c == '(' || c == '\u{ff08}').unwrap_or(s.len());
    let head = s[..cut].trim();
    if head.is_empty() { s.trim().to_string() } else { head.to_string() }
}

/// Whether imported box symbols are redrawn in KiCad library style.  Off unless the
/// server runs with `KC_TIDY_SYMBOLS=1`, until the owner has reviewed the results.
pub fn tidy_enabled() -> bool {
    std::env::var("KC_TIDY_SYMBOLS").map(|v| matches!(v.trim(), "1" | "true" | "yes" | "on")).unwrap_or(false)
}

/// Convert the `result` object of EasyEDA's `/api/products/<Cnnn>/components` answer.
pub fn convert(result: &Value) -> Result<Converted, String> {
    convert_with(result, tidy_enabled())
}

/// [`convert`], choosing whether box symbols are tidied ([`super::tidy`]).
pub fn convert_with(result: &Value, tidy: bool) -> Result<Converted, String> {
    let data = result.get("dataStr").ok_or("the vendor answer has no symbol data")?;
    let cpara = data.get("head").and_then(|h| h.get("c_para")).cloned().unwrap_or(Value::Null);
    let title = vstr(result, "title");
    let raw_name = if !vstr(&cpara, "name").is_empty() { vstr(&cpara, "name") } else { title };
    let name = lib_name(raw_name);
    let prefix = vstr(&cpara, "pre").trim_end_matches('?').trim().to_string();

    // Multi-unit parts keep each unit in `subparts`; single-unit ones in dataStr itself.
    let mut units: Vec<&Value> = Vec::new();
    if let Some(subs) = result.get("subparts").and_then(Value::as_array) {
        for s in subs {
            if let Some(d) = s.get("dataStr") {
                units.push(d);
            }
        }
    }
    if units.is_empty() {
        units.push(data);
    }
    let symbol = convert_symbol(&name, &prefix, &units, tidy);

    let pkg = result.get("packageDetail");
    let pkg_data = pkg.and_then(|p| p.get("dataStr"));
    let pkg_cpara = pkg_data.and_then(|d| d.get("head")).and_then(|h| h.get("c_para")).cloned().unwrap_or(Value::Null);
    let pkg_name_raw = if !vstr(&pkg_cpara, "package").is_empty() {
        vstr(&pkg_cpara, "package").to_string()
    } else if let Some(t) = pkg.map(|p| vstr(p, "title")).filter(|t| !t.is_empty()) {
        t.to_string()
    } else {
        vstr(&cpara, "package").to_string()
    };
    let footprint = pkg_data.and_then(|d| convert_footprint(&lib_name(&pkg_name_raw), d));

    if symbol.is_none() && footprint.is_none() {
        return Err("the vendor has no symbol or footprint drawing for this part".into());
    }
    // Only the symbol's own link: a footprint is shared by every part in that package and
    // its link is whichever datasheet its drawer copied the land pattern from (a WCH CH592D
    // came out pointing at a TI regulator).
    let datasheet = Some(vstr(&cpara, "link")).filter(|l| l.starts_with("http")).unwrap_or("").to_string();
    Ok(Converted {
        name,
        prefix: if prefix.is_empty() { "U".into() } else { prefix },
        package: if vstr(&cpara, "package").is_empty() { pkg_name_raw } else { vstr(&cpara, "package").to_string() },
        manufacturer: clean_maker(cpara_any(&cpara, &["Manufacturer", "BOM_Manufacturer"])),
        mpn: cpara_any(&cpara, &["Manufacturer Part", "BOM_Manufacturer Part"]).to_string(),
        description: vstr(result, "description").to_string(),
        datasheet,
        symbol,
        footprint,
    })
}

// ------------------------------------------------------------------ assembling library items

/// The complete library symbol: header, properties, units.  `fields` are extra
/// (name, value) properties such as LCSC / MPN / Manufacturer, kept hidden.
pub fn symbol_sexpr(sym: &SymbolOut, reference: &str, value: &str, footprint: &str, datasheet: &str, description: &str, fields: &[(String, String)]) -> String {
    let [_, y0, _, y1] = sym.bbox;
    let mut o = format!("(symbol {}\n", q(&sym.name));
    if sym.hide_pin_numbers {
        o.push_str("\t\t(pin_numbers (hide yes))\n");
    }
    o.push_str(&format!("\t\t(pin_names (offset 1.016){})\n", if sym.hide_pin_names { " (hide yes)" } else { "" }));
    o.push_str("\t\t(exclude_from_sim no)\n\t\t(in_bom yes)\n\t\t(on_board yes)\n");
    let prop = |name: &str, val: &str, y: f64, hide: bool| {
        format!(
            "\t\t(property {} {} (at 0 {} 0) (effects (font (size 1.27 1.27)){}))\n",
            q(name),
            q(val),
            fnum(y),
            if hide { " (hide yes)" } else { "" }
        )
    };
    // 50 mil grid, clear of the body
    let snap = |v: f64| (v / 1.27).round() * 1.27;
    o.push_str(&prop("Reference", reference, snap(y1 + 2.54), false));
    o.push_str(&prop("Value", value, snap(y0 - 2.54), false));
    o.push_str(&prop("Footprint", footprint, snap(y0 - 5.08), true));
    o.push_str(&prop("Datasheet", if datasheet.is_empty() { "~" } else { datasheet }, snap(y0 - 7.62), true));
    o.push_str(&prop("Description", description, snap(y0 - 10.16), true));
    let mut y = y0 - 12.7;
    for (k, v) in fields {
        if v.is_empty() {
            continue;
        }
        o.push_str(&prop(k, v, snap(y), true));
        y -= 2.54;
    }
    o.push_str(&sym.body);
    o.push_str("\t)");
    o
}

/// The complete footprint as a `.kicad_mod` file holds it.
pub fn footprint_sexpr(fp: &FootprintOut, value: &str, description: &str, tags: &str, model_path: Option<&str>) -> String {
    let b = fp.bbox;
    let (x0, y0, x1, y1) = (b[0], b[1], b[2], b[3]);
    let mut o = format!(
        "(footprint {}\n\t(version 20241229)\n\t(generator \"kicad-collab-parts\")\n\t(generator_version \"9.0\")\n\t(layer \"F.Cu\")\n",
        q(&fp.name)
    );
    if !description.is_empty() {
        o.push_str(&format!("\t(descr {})\n", q(description)));
    }
    if !tags.is_empty() {
        o.push_str(&format!("\t(tags {})\n", q(tags)));
    }
    let text = |name: &str, val: &str, y: f64, layer: &str, hide: bool| {
        format!(
            "\t(property {} {} (at 0 {} 0) (layer {}){} (effects (font (size 1 1) (thickness 0.15))))\n",
            q(name),
            q(val),
            fnum(y),
            q(layer),
            if hide { " (hide yes)" } else { "" }
        )
    };
    o.push_str(&text("Reference", "REF**", y0 - 1.5, "F.SilkS", false));
    o.push_str(&text("Value", value, y1 + 1.5, "F.Fab", false));
    o.push_str(&text("Datasheet", "", 0.0, "F.Fab", true));
    o.push_str(&text("Description", description, 0.0, "F.Fab", true));
    o.push_str(&format!("\t(attr {})\n", if fp.through_hole { "through_hole" } else { "smd" }));
    o.push_str(&fp.body);
    // EasyEDA packages carry no courtyard; KiCad's DRC wants one.
    if x1 > x0 && y1 > y0 {
        let m = 0.25;
        let r = |v: f64| (v / 0.05).round() * 0.05;
        o.push_str(&format!(
            "\t(fp_rect (start {} {}) (end {} {}) (stroke (width 0.05) (type solid)) (fill no) (layer \"F.CrtYd\"))\n",
            fnum(r(x0 - m)),
            fnum(r(y0 - m)),
            fnum(r(x1 + m)),
            fnum(r(y1 + m))
        ));
    }
    o.push_str("\t(fp_text user \"${REFERENCE}\" (at 0 0 0) (layer \"F.Fab\") (effects (font (size 0.8 0.8) (thickness 0.12))))\n");
    if let (Some(m), Some(path)) = (&fp.model, model_path) {
        o.push_str(&format!(
            "\t(model {}\n\t\t(offset (xyz {} {} {}))\n\t\t(scale (xyz 1 1 1))\n\t\t(rotate (xyz {} {} {}))\n\t)\n",
            q(path),
            fnum(m.offset[0]),
            fnum(m.offset[1]),
            fnum(m.offset[2]),
            fnum(m.rotate[0]),
            fnum(m.rotate[1]),
            fnum(m.rotate[2])
        ));
    }
    o.push(')');
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_names() {
        assert_eq!(fnum(2.5400000001), "2.54");
        assert_eq!(fnum(-0.00001), "0");
        assert_eq!(fnum(10.0), "10");
        assert_eq!(lib_name("LQFP-48(7x7) / A:B"), "LQFP-48(7x7)_A_B");
        assert_eq!(q("a\"b"), "\"a\\\"b\"");
    }

    #[test]
    fn path_and_arc() {
        let segs = parse_path("M 0 0 L 10 0 l 0 10 h -10 Z");
        assert_eq!(segs.len(), 4);
        // quarter circle from (10,0) to (0,10), centre at the origin, sweep flag set (clockwise on a Y-down sheet)
        let mid = arc_mid([10.0, 0.0], [0.0, 10.0], 10.0, false, true).unwrap();
        assert!((mid[0] - 7.0711).abs() < 1e-3 && (mid[1] - 7.0711).abs() < 1e-3, "{mid:?}");
    }

    #[test]
    fn pin_orientation_follows_its_line() {
        let data = serde_json::json!({
            "head": { "x": 400, "y": 300, "c_para": { "name": "T", "pre": "U?" } },
            "shape": [
                "R~380~280~~~40~40~#880000~1~0~none~gge1~0",
                "P~show~0~1~370~290~180~gge5~0^^370~290^^M 370 290 h 10~#880000^^1~383.7~294~0~VCC~start~~~#0000FF^^1~379.5~289~0~1~end~~~#0000FF^^0~377~290^^0~M 380 293 L 383 290 L 380 287",
                "P~show~0~2~430~290~0~gge6~0^^430~290^^M 430 290 h -10~#880000^^1~416~294~0~OUT~end~~~#0000FF^^1~420~289~0~2~start~~~#0000FF^^0~423~290^^0~M 420 287 L 417 290 L 420 293"
            ]
        });
        let sym = convert_symbol("T", "U", &[&data], false).unwrap();
        assert_eq!(sym.pins, 2);
        // left pin: 30 units left of the origin, runs toward +x
        assert!(sym.body.contains("(at -7.62 2.54 0) (length 2.54) (name \"VCC\""), "{}", sym.body);
        assert!(sym.body.contains("(at 7.62 2.54 180) (length 2.54) (name \"OUT\""), "{}", sym.body);
        assert!(sym.body.contains("(rectangle (start -5.08 5.08) (end 5.08 -5.08)"), "{}", sym.body);
    }
}

/// The converter against real EasyEDA answers (tests/fixtures/vendor, captured by
/// scripts/capture-vendor-fixtures.sh).
#[cfg(test)]
mod fixture_tests {
    use super::*;

    fn load(id: &str) -> Value {
        let path = format!("{}/tests/fixtures/vendor/easyeda_{id}.json", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        serde_json::from_str::<Value>(&text).unwrap()["result"].clone()
    }

    /// Parentheses balance outside quoted strings.
    fn balanced(s: &str) -> bool {
        let (mut depth, mut in_str, mut esc) = (0i32, false, false);
        for c in s.chars() {
            if in_str {
                if esc {
                    esc = false;
                } else if c == '\\' {
                    esc = true;
                } else if c == '"' {
                    in_str = false;
                }
            } else if c == '"' {
                in_str = true;
            } else if c == '(' {
                depth += 1;
            } else if c == ')' {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
        }
        depth == 0 && !in_str
    }

    fn full(id: &str) -> (Converted, String, String) {
        let c = convert(&load(id)).unwrap();
        let sym = symbol_sexpr(c.symbol.as_ref().unwrap(), &c.prefix, &c.mpn, "LCSC:X", "", &c.description, &[("LCSC".into(), id.into())]);
        let fp = footprint_sexpr(c.footprint.as_ref().unwrap(), &c.mpn, &c.description, id, Some("x.step"));
        (c, sym, fp)
    }

    #[test]
    fn every_fixture_converts_to_balanced_sexpr() {
        let dir = format!("{}/tests/fixtures/vendor", env!("CARGO_MANIFEST_DIR"));
        let mut n = 0;
        for e in std::fs::read_dir(dir).unwrap() {
            let name = e.unwrap().file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_prefix("easyeda_C").and_then(|r| r.strip_suffix(".json")) else { continue };
            let id = format!("C{id}");
            let (c, sym, fp) = full(&id);
            assert!(balanced(&sym), "{id} symbol");
            assert!(balanced(&fp), "{id} footprint");
            assert!(c.symbol.as_ref().unwrap().pins > 0, "{id} has pins");
            assert!(c.footprint.as_ref().unwrap().pads > 0, "{id} has pads");
            assert!(!c.mpn.is_empty() && !c.manufacturer.is_empty(), "{id} names its maker and part");
            assert!(!sym.contains("NaN") && !fp.contains("NaN") && !fp.contains("inf"), "{id}");
            if let Ok(out) = std::env::var("PARTS_DUMP_DIR") {
                std::fs::write(format!("{out}/{id}.kicad_sym"), format!("(kicad_symbol_lib (version 20241209) (generator \"t\")\n\t{sym}\n)\n")).unwrap();
                std::fs::write(format!("{out}/{id}.kicad_mod"), &fp).unwrap();
            }
            n += 1;
        }
        assert!(n >= 10, "fixtures present ({n})");
    }

    #[test]
    fn resistor_0603() {
        let (c, sym, fp) = full("C25804");
        assert_eq!(c.prefix, "R");
        assert_eq!(c.mpn, "0603WAF1002T5E");
        assert_eq!(c.manufacturer, "UNI-ROYAL");
        let s = c.symbol.as_ref().unwrap();
        assert_eq!((s.units, s.pins), (1, 2));
        assert!(s.hide_pin_names, "a resistor's pin names are hidden");
        // two pins 40 units (10.16 mm) apart, facing each other, on the 1.27 mm grid
        assert!(sym.contains("(pin passive line (at 5.08 0 180) (length 2.54) (name \"2\""), "{sym}");
        assert!(sym.contains("(pin passive line (at -5.08 0 0) (length 2.54) (name \"1\""), "{sym}");
        let f = c.footprint.as_ref().unwrap();
        assert_eq!((f.pads, f.through_hole), (2, false));
        // pads 0.8065 × 0.864 mm centred ±0.7534 mm
        assert!(fp.contains("(pad \"1\" smd rect (at -0.7534 0) (size 0.8065 0.864) (layers \"F.Cu\" \"F.Paste\" \"F.Mask\"))"), "{fp}");
        assert!(fp.contains("(pad \"2\" smd rect (at 0.7534 0)"), "{fp}");
        assert!(fp.contains("(attr smd)") && fp.contains("F.CrtYd"));
        assert_eq!(f.model.as_ref().unwrap().uuid, "6bd5cd867e9542ebae21caaf5d2d4c4d");
    }

    #[test]
    fn lqfp48_microcontroller() {
        let (c, sym, fp) = full("C8734");
        assert_eq!(c.mpn, "STM32F103C8T6");
        assert_eq!(c.manufacturer, "ST");
        let s = c.symbol.as_ref().unwrap();
        assert_eq!(s.pins, 48);
        assert!(sym.contains("(name \"VBAT\""));
        // every pin sits on the 50 mil grid
        for line in sym.lines().filter(|l| l.contains("(pin ")) {
            let at = line.split("(at ").nth(1).unwrap();
            let mut it = at.split(|c| c == ' ' || c == ')');
            for _ in 0..2 {
                let v: f64 = it.next().unwrap().parse().unwrap();
                let steps = v / 1.27;
                assert!((steps - steps.round()).abs() < 1e-6, "off grid: {line}");
            }
        }
        let f = c.footprint.as_ref().unwrap();
        assert_eq!(f.pads, 48);
        // 0.5 mm pitch between pads 1 and 2
        let x = |n: &str| -> f64 {
            let l = fp.lines().find(|l| l.contains(&format!("(pad \"{n}\" "))).unwrap();
            l.split("(at ").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap()
        };
        assert!(((x("2") - x("1")) - 0.5).abs() < 0.002, "{} {}", x("1"), x("2"));
        // the body is 9 mm lead to lead: the footprint is roughly centred on its origin
        let b = f.bbox;
        assert!((b[0] + b[2]).abs() < 0.3 && (b[1] + b[3]).abs() < 0.3, "{b:?}");
    }

    #[test]
    fn usb_c_connector_has_slots_and_holes() {
        let (c, _, fp) = full("C165948");
        let f = c.footprint.as_ref().unwrap();
        assert!(f.through_hole);
        assert!(fp.contains("(drill oval "), "slotted shield pins");
        assert!(fp.contains("np_thru_hole circle"), "locating holes");
        assert!(fp.contains("custom (at"), "polygon pads");
        assert!(fp.contains("(attr through_hole)"));
    }

    /// Writes each part's library symbol as the vendor drew it and as tidied, for review:
    /// `TIDY_IN=<dir of easyeda_C*.json> TIDY_OUT=<dir> cargo test dump_tidy_examples -- --ignored`
    #[test]
    #[ignore]
    fn dump_tidy_examples() {
        let (Ok(inp), Ok(out)) = (std::env::var("TIDY_IN"), std::env::var("TIDY_OUT")) else { return };
        for e in std::fs::read_dir(&inp).unwrap().flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let r = v.get("result").unwrap_or(&v);
            let stem = path.file_stem().unwrap().to_string_lossy().to_string();
            for (tag, tidy) in [("before", false), ("after", true)] {
                let Ok(c) = convert_with(r, tidy) else { continue };
                let Some(s) = c.symbol.as_ref() else { continue };
                let sx = symbol_sexpr(s, &c.prefix, &c.name, "", "", "", &[]);
                std::fs::write(format!("{out}/{stem}.{tag}.kicad_sym"), &sx).unwrap();
                println!("{stem} {tag} tidied={} pins={}", s.tidied, s.pins);
            }
        }
    }
}
