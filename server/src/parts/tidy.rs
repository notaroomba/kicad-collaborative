//! Rearranges a vendor's box symbol into KiCad library style.
//!
//! Vendor drawings (EasyEDA for LCSC, and the LCSC twin that DigiKey, Mouser and
//! Farnell parts borrow) usually list an IC's pins down two sides in package
//! order.  KiCad's own libraries (MCU_ST_*, RF_Module, Regulator_*, Connector)
//! draw them by function instead:
//!
//! * supply pins on top, ground and the exposed pad on the bottom;
//! * inputs and control (reset, boot, enable, oscillator) on the left;
//! * outputs, USB and RF on the right;
//! * GPIO ports kept whole and in order (PA0…PA15), whole ports shared between
//!   the two sides so the body stays roughly square;
//! * a regulator reads like its datasheet: VIN and EN on the left, VOUT, SW, BST
//!   and FB on the right, GND below;
//! * a connector's duplicate pins (GND ×4, VBUS ×4, shield) stack into one.
//!
//! Only plain box symbols are touched: one unit, rectangles for the body and
//! nothing else drawn.  Transistors, diodes, passives and anything with its own
//! artwork keep the vendor's drawing.  Pin names, numbers and count never change;
//! only where each pin sits.

use super::easyeda::{fnum, q};

/// One pin as the converter read it.
#[derive(Debug, Clone)]
pub struct RawPin {
    pub etype: String,
    pub style: String,
    pub name: String,
    pub number: String,
}

/// What else a unit draws besides its pins.
#[derive(Debug, Clone, Default)]
pub struct Art {
    pub rects: usize,
    /// circles and ellipses (EasyEDA's pin-1 dot)
    pub dots: usize,
    /// lines, arcs, curves, polygons: the symbol has artwork of its own
    pub other: usize,
}

const G: f64 = 2.54;
/// Rough advance of one character of KiCad's stroke font at 1.27 mm.
const CW: f64 = 1.2;
const NAME_OFFSET: f64 = 1.016;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Side {
    Left,
    Right,
    Top,
    Bottom,
}

/// Rank orders groups down a side; lower is higher up.
#[derive(Debug, Clone)]
struct Group {
    key: String,
    rank: u8,
    side: Option<Side>,
    pins: Vec<usize>,
}

fn up(s: &str) -> String {
    // KiCad overbar markup ~{X} and a leading ~ / trailing # / n prefix mean active low; they don't
    // change what the pin is for
    s.replace("~{", "").replace('}', "").trim_start_matches('~').to_ascii_uppercase()
}

/// The pin name's words: "PC14-OSC32_IN" → ["PC14", "OSC32", "IN"].
fn words(n: &str) -> Vec<String> {
    n.split(|c: char| matches!(c, '-' | '/' | '_' | '(' | ')' | ' ' | ',' | '|' | '.'))
        .filter(|w| !w.is_empty())
        .map(|w| w.to_string())
        .collect()
}

/// The first word of the name, the pin's primary function.
fn head(n: &str) -> String {
    words(n).into_iter().next().unwrap_or_default()
}

fn is_nc(n: &str) -> bool {
    matches!(n, "NC" | "N.C." | "N/C" | "DNC" | "NIC" | "RESERVED" | "RSVD") || n.starts_with("NC_") || (n.starts_with("NC") && n[2..].chars().all(|c| c.is_ascii_digit()) && n.len() > 2)
}

fn is_ground(n: &str) -> bool {
    let h = head(n);
    let base = h.trim_end_matches(|c: char| c.is_ascii_digit());
    base.starts_with("GND")
        || base.starts_with("VSS")
        || matches!(base, "AGND" | "DGND" | "PGND" | "SGND" | "EGND" | "CGND" | "EP" | "EPAD" | "PAD" | "THERMAL" | "0V" | "VEE" | "V-" | "SHIELD" | "SHELL" | "EH" | "MH" | "MP" | "SH")
        || n == "GND(EP)"
        || n.contains("EXPOSED")
}

/// A supply pin drawn on top.
fn is_supply(n: &str) -> bool {
    let h = head(n);
    let h = h.as_str();
    h.contains("VDD")
        || h.contains("VCC")
        || h.starts_with("VBAT")
        || h.starts_with("VREF")
        || h.starts_with("VBUS")
        || h.starts_with("VIO")
        || h.starts_with("VREG")
        || h.starts_with("VDDIO")
        || h.starts_with("AVCC")
        || h.starts_with("VIN")
        || h.starts_with("PVIN")
        || h.starts_with("AVIN")
        || h == "VS"
        || h == "V+"
        || h == "VPP"
        || h == "VSUP"
        || h == "VSYS"
        || n.starts_with("3V3")
        || n.starts_with("+3V3")
        || n.starts_with("3.3V")
        || n.starts_with("5V")
        || n.starts_with("+5V")
        || n.starts_with("V3P3")
        || n == "VPWR"
        || n == "USB_VDD"
        || n == "ADC_AVDD"
}

/// Supply-related pins that are not a rail: an internal SMPS's switch node and
/// feedback, decoupling outputs of on-chip regulators.  Drawn on the left, low.
fn is_power_misc(n: &str) -> bool {
    let h = head(n);
    h.starts_with('V') && h.len() >= 3 && !is_supply(n) && !is_ground(n) && !h[1..].chars().all(|c| c.is_ascii_digit()) && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '+')
}

/// GPIO port and number: PA3 → ("PA", 3), GPIO12 → ("GPIO", 12), P1.04 → ("P1", 4).
fn port_of(n: &str) -> Option<(String, u32)> {
    let h = head(n);
    let b = h.as_bytes();
    let digits_from = |i: usize| -> Option<u32> {
        let d = &h[i..];
        if !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()) {
            d.parse().ok()
        } else {
            None
        }
    };
    // STM32 / CH32 / nRF style "PA3", PIC "RB4"
    if b.len() >= 3 && (b[0] == b'P' || b[0] == b'R') && (b'A'..=b'K').contains(&b[1]) {
        if let Some(k) = digits_from(2) {
            return Some((h[..2].to_string(), k));
        }
    }
    for p in ["GPIO", "IO", "GP", "PIO"] {
        if let Some(rest) = h.strip_prefix(p) {
            if let Some(k) = digits_from(p.len()) {
                let _ = rest;
                return Some(("GPIO".to_string(), k));
            }
        }
    }
    // "P0.13" / "P1_04": port number, dot, pin
    let w = words(n);
    if w.len() >= 2 && w[0].len() >= 2 && w[0].starts_with('P') && w[0][1..].chars().all(|c| c.is_ascii_digit()) && w[1].chars().all(|c| c.is_ascii_digit()) {
        return Some((w[0].clone(), w[1].parse().ok()?));
    }
    None
}

fn has_word(n: &str, set: &[&str]) -> bool {
    words(n).iter().any(|w| set.contains(&w.as_str()))
}

fn is_clock(n: &str) -> bool {
    let w = words(n);
    w.iter().any(|w| {
        let w = w.as_str();
        w.starts_with("OSC") || w.starts_with("XTAL") || w.starts_with("XIN") || w.starts_with("XOUT") || w.starts_with("X32") || matches!(w, "XI" | "XO" | "XTL" | "CLKIN" | "HSE" | "LSE" | "XC1" | "XC2" | "XL1" | "XL2" | "XTAL1" | "XTAL2")
    })
}

fn is_control(n: &str) -> bool {
    let h = head(n);
    has_word(n, &["NRST", "RST", "RESET", "NRESET", "MCLR", "RUN", "CHIP_PU", "BOOT", "BOOT0", "BOOT1", "BOOTSEL", "TESTEN", "TEST", "PWRKEY", "WAKE", "NSLEEP", "SLEEP"])
        || n.starts_with("RESET")
        || n.starts_with("BOOT")
        || matches!(h.as_str(), "EN" | "CE" | "CHIP" | "SHDN" | "PD" | "ON" | "STBY")
        || n == "CHIP_PU"
        || n == "CHIP_EN"
}

fn is_debug(n: &str) -> bool {
    has_word(n, &["SWD", "SWDIO", "SWCLK", "SWO", "TCK", "TMS", "TDI", "TDO", "NJTRST", "JTCK", "JTMS", "JTDI", "JTDO", "SWCLK"])
}

fn is_usb(n: &str) -> bool {
    let h = head(n);
    n.starts_with("USB_D") || n.starts_with("USBD") || n.starts_with("USB_DP") || n.starts_with("USB_DM")
        || matches!(h.as_str(), "DP" | "DM" | "D+" | "D-" | "DP1" | "DP2" | "DN1" | "DN2" | "DM1" | "DM2" | "UD+" | "UD-" | "USBDP" | "USBDM")
        || n == "D+" || n == "D-"
}

fn is_rf(n: &str) -> bool {
    let h = head(n);
    h.starts_with("RF") || h.starts_with("ANT") || h == "LNA_IN" || h == "RFIO"
}

/// Connector pins that belong to the USB-C configuration channel and sideband.
fn is_cc(n: &str) -> bool {
    let h = head(n);
    h.starts_with("CC") || h.starts_with("SBU") || h.starts_with("VCONN")
}

fn is_input_name(n: &str) -> bool {
    let w = words(n);
    let h = head(n);
    h.contains("IN+") || h.contains("IN-") || h.ends_with("IN") || h.starts_with("IN") || w.iter().any(|w| w == "IN") || matches!(h.as_str(), "RXD" | "RX" | "RXD0" | "RXD1" | "DI" | "SDI" | "MOSI" | "D" | "SCL" | "SCK" | "CS" | "NCS" | "SS" | "RS" | "STB" | "S")
}

/// A transceiver's bus side: drawn right, like KiCad's interface symbols.
fn is_line_side(n: &str) -> bool {
    matches!(head(n).as_str(), "CANH" | "CANL" | "CAN" | "LIN" | "A" | "B" | "Y" | "Z" | "TXP" | "TXN" | "RXP" | "RXN" | "TD+" | "TD-" | "RD+" | "RD-" | "SPLIT" | "BUS")
}

fn is_output_name(n: &str) -> bool {
    let h = head(n);
    if is_line_side(n) {
        return true;
    }
    h.contains("OUT") || matches!(h.as_str(), "TXD" | "TX" | "TXD0" | "TXD1" | "DO" | "SDO" | "MISO" | "R" | "INT" | "IRQ" | "Q" | "QB" | "Y")
}

/// The part is a regulator, charger or switch: it has a power output.
fn regulator(names: &[String]) -> bool {
    let out = names.iter().any(|n| {
        let h = head(n);
        matches!(h.as_str(), "VOUT" | "OUT" | "VO" | "SW" | "LX" | "PH" | "BAT" | "VBAT" | "OUT1" | "OUT2" | "VOUT1" | "VOUT2" | "SW1" | "SW2" | "LX1" | "LX2")
    });
    let inp = names.iter().any(|n| {
        let h = head(n);
        matches!(h.as_str(), "VIN" | "IN" | "VI" | "PVIN" | "AVIN" | "VCC" | "VDD" | "VIN1" | "VIN2" | "PVDD" | "VBUS")
    });
    // a microcontroller has VBAT too; a regulator has few pins
    out && inp && names.len() <= 24 && !names.iter().any(|n| port_of(n).is_some())
}

fn reg_side(n: &str) -> Option<(Side, u8, &'static str)> {
    let h = head(n);
    let h = h.trim_end_matches(|c: char| c.is_ascii_digit());
    Some(match h {
        "VIN" | "IN" | "VI" | "PVIN" | "AVIN" | "VCC" | "VDD" | "PVDD" | "VBUS" => (Side::Left, 0, "in"),
        "EN" | "CE" | "SHDN" | "ON" | "MODE" | "SYNC" | "SS" | "TR" | "UVLO" | "RT" | "PROG" | "TEMP" | "ILIM" | "ISET" | "NC" | "CTRL" | "STBY" | "RUN" => (Side::Left, 1, "ctl"),
        "VOUT" | "OUT" | "VO" | "BAT" | "VBAT" => (Side::Right, 0, "out"),
        "SW" | "LX" | "PH" => (Side::Right, 1, "sw"),
        "BST" | "VBST" | "BOOT" | "CB" | "BS" => (Side::Right, 1, "sw"),
        "FB" | "VFB" | "ADJ" | "SENSE" | "VSENSE" | "VOS" => (Side::Right, 2, "fb"),
        "PG" | "PGOOD" | "POK" | "CHRG" | "STDBY" | "FLT" | "FAULT" | "STAT" => (Side::Right, 3, "status"),
        _ => return None,
    })
}

/// Natural order: "PA2" before "PA10", "VDD" before "VDDA".
fn natural(a: &str, b: &str) -> std::cmp::Ordering {
    let split = |s: &str| -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for c in s.chars() {
            let d = c.is_ascii_digit();
            match out.last_mut() {
                Some((pd, buf)) if *pd == d => buf.push(c),
                _ => out.push((d, c.to_string())),
            }
        }
        out
    };
    let (x, y) = (split(a), split(b));
    for (p, r) in x.iter().zip(y.iter()) {
        let o = if p.0 && r.0 {
            p.1.parse::<u64>().unwrap_or(0).cmp(&r.1.parse::<u64>().unwrap_or(0))
        } else {
            p.1.cmp(&r.1)
        };
        if o != std::cmp::Ordering::Equal {
            return o;
        }
    }
    x.len().cmp(&y.len())
}

/// The family a pin belongs to: "QSPI_SD1" → "QSPI", "1IN+" → "1", "SBU2" → "SBU".
fn family(n: &str) -> String {
    let h = head(n);
    // op-amp channels: "1IN-", "2OUT", "INA+", "OUTB"
    if let Some(c) = h.chars().next().filter(|c| c.is_ascii_digit()) {
        if h.len() > 1 && h[1..].starts_with(|c: char| c.is_ascii_alphabetic()) {
            return format!("ch{c}");
        }
    }
    for p in ["IN", "OUT"] {
        if let Some(rest) = h.strip_prefix(p) {
            let ch = rest.trim_matches(|c| c == '+' || c == '-');
            if ch.len() == 1 && ch.chars().all(|c| c.is_ascii_alphabetic()) {
                return format!("ch{ch}");
            }
        }
    }
    let w = words(n);
    const BUSES: &[&str] = &["QSPI", "OSPI", "SPI", "SPI0", "SPI1", "I2C", "I2C0", "I2C1", "UART", "UART0", "UART1", "SDIO", "SDMMC", "JTAG", "USB", "ETH", "RMII", "MII", "CAN", "I2S", "PDM", "ADC", "DAC", "LCD", "CSI", "DSI", "SWD"];
    if w.len() > 1 && BUSES.contains(&w[0].as_str()) {
        return w[0].clone();
    }
    if w.iter().any(|w| (w.len() == 3 && w.starts_with("SD") && w.as_bytes()[2].is_ascii_digit()) || w == "CMD") || (w.iter().any(|w| w == "CLK") && w.iter().any(|w| w == "SCK")) {
        return "SDIO".into();
    }
    if w.iter().any(|w| w.starts_with("TXD") || w.starts_with("RXD") || w == "TX" || w == "RX" || w == "RTS" || w == "CTS") {
        return "UART".into();
    }
    if w.len() > 1 {
        return w[0].trim_end_matches(|c: char| c.is_ascii_digit()).to_string();
    }
    h.trim_end_matches(|c: char| c.is_ascii_digit() || c == '+' || c == '-').to_string()
}

pub struct Tidied {
    /// The unit's contents: body rectangle and pins.
    pub unit: String,
    pub bbox: [f64; 4],
}

fn connector_prefix(prefix: &str) -> bool {
    let p = prefix.to_ascii_uppercase();
    p.starts_with('J') || p.starts_with("CN") || p.starts_with("USB") || p.starts_with("CON") || p == "P" || p == "X" || p == "H"
}

/// Rearrange the pins of a one-unit box symbol, or `None` when the symbol is not one
/// this applies to (artwork, too few pins, a plain numbered header).
pub fn arrange(pins: &[RawPin], art: &Art, prefix: &str) -> Option<Tidied> {
    let pfx = prefix.trim_end_matches('?').to_ascii_uppercase();
    let connector = connector_prefix(&pfx);
    let ic = matches!(pfx.as_str(), "U" | "IC" | "A" | "M" | "MOD" | "VR" | "" | "N" | "DA" | "DD");
    if !(ic || connector) || pins.len() < 3 || art.rects != 1 || art.other > 0 {
        return None;
    }
    let names: Vec<String> = pins.iter().map(|p| up(&p.name)).collect();
    // a numbered header or terminal block already is in its natural order
    if names.iter().all(|n| n.is_empty() || n == "~" || n.chars().all(|c| c.is_ascii_digit()) || n.starts_with("PIN")) {
        return None;
    }
    let reg = !connector && regulator(&names);
    let mut groups: Vec<Group> = Vec::new();
    let mut pref: Vec<Option<Side>> = vec![None; pins.len()];
    let mut add = |key: String, rank: u8, side: Option<Side>, i: usize, groups: &mut Vec<Group>| {
        if let Some(g) = groups.iter_mut().find(|g| g.key == key) {
            g.pins.push(i);
        } else {
            groups.push(Group { key, rank, side, pins: vec![i] });
        }
    };
    for (i, n) in names.iter().enumerate() {
        let et = pins[i].etype.as_str();
        if is_nc(n) || et == "no_connect" {
            add("nc".into(), 9, None, i, &mut groups);
        } else if is_ground(n) {
            add("gnd".into(), 0, Some(Side::Bottom), i, &mut groups);
        } else if reg && reg_side(n).is_some() {
            let (s, r, k) = reg_side(n).unwrap();
            add(format!("reg:{k}"), r, Some(s), i, &mut groups);
        } else if n == "VREF" && !names.iter().any(|m| port_of(m).is_some()) {
            // a transceiver's or reference's VREF is an output, not a rail
            pref[i] = Some(Side::Right);
            add("f:VREF".into(), 5, Some(Side::Right), i, &mut groups);
        } else if is_supply(n) || et == "power_in" && !n.starts_with('P') {
            add("vcc".into(), 0, Some(Side::Top), i, &mut groups);
        } else if connector {
            let key = if is_usb(n) {
                "usb".to_string()
            } else if is_cc(n) {
                "cc".to_string()
            } else {
                format!("f:{}", family(n))
            };
            let rank = match key.as_str() {
                "cc" => 0,
                "usb" => 1,
                _ => 2,
            };
            add(key, rank, Some(Side::Right), i, &mut groups);
        } else if is_control(n) && port_of(n).map_or(true, |_| head(n).starts_with("BOOT") || n.contains("BOOT")) {
            add("ctl".into(), 0, Some(Side::Left), i, &mut groups);
        } else if is_clock(n) {
            add("clk".into(), 1, Some(Side::Left), i, &mut groups);
        } else if is_debug(n) && port_of(n).is_none() {
            add("dbg".into(), 2, Some(Side::Left), i, &mut groups);
        } else if is_rf(n) {
            add("rf".into(), 7, Some(Side::Right), i, &mut groups);
        } else if let Some((port, _)) = port_of(n) {
            add(format!("port:{port}"), 4, None, i, &mut groups);
        } else if is_usb(n) {
            add("usb".into(), 6, Some(Side::Right), i, &mut groups);
        } else if is_power_misc(n) {
            add("pwrmisc".into(), 8, Some(Side::Left), i, &mut groups);
        } else {
            let fam = family(n);
            let side = match et {
                "input" => Some(Side::Left),
                "output" | "power_out" => Some(Side::Right),
                _ if is_output_name(n) && !is_input_name(n) => Some(Side::Right),
                _ if is_input_name(n) => Some(Side::Left),
                _ => None,
            };
            pref[i] = side;
            // an op-amp channel keeps its inputs left and its output right
            let key = if fam.starts_with("ch") { format!("{fam}:{side:?}") } else { format!("f:{fam}") };
            add(key, 5, if fam.starts_with("ch") { side } else { Some(Side::Left) }, i, &mut groups);
        }
    }
    // a signal family goes to the side all its pins prefer; a mixed one (RXD + TXD) is placed freely
    for g in groups.iter_mut().filter(|g| g.key.starts_with("f:")) {
        let first = pref[g.pins[0]];
        g.side = if g.pins.iter().all(|&i| pref[i] == first) { first } else { None };
    }

    // sort each group's pins
    for g in groups.iter_mut() {
        let key = g.key.clone();
        g.pins.sort_by(|&a, &b| {
            let (na, nb) = (&names[a], &names[b]);
            if key.starts_with("port:") {
                port_of(na).map(|p| p.1).cmp(&port_of(nb).map(|p| p.1))
            } else if key == "clk" {
                // pair IN before OUT within each oscillator
                let base = |n: &str| n.replace("OUT", "").replace("IN", "").replace("XO", "X").replace("XI", "X");
                natural(&base(na), &base(nb)).then_with(|| natural(na, nb))
            } else if key == "gnd" {
                // the exposed pad last
                let ep = |n: &str| n.starts_with("EP") || n.contains("PAD") || n.starts_with("SH") || n == "EH" || n == "MH";
                ep(na).cmp(&ep(nb)).then_with(|| natural(na, nb))
            } else if key.starts_with("ch") {
                // IN+ above IN- above OUT, KiCad's op-amp order
                let r = |n: &str| if n.contains("IN+") || n.ends_with('+') { 0 } else if n.contains("IN-") || n.ends_with('-') { 1 } else { 2 };
                r(na).cmp(&r(nb)).then_with(|| natural(na, nb))
            } else {
                natural(na, nb).then_with(|| natural(&pins[a].number, &pins[b].number))
            }
        });
    }

    // a connector's same-name pins stack into one place: (visible pin, hidden ones)
    let mut stacked: Vec<Vec<usize>> = Vec::new();
    let mut slot_of = vec![usize::MAX; pins.len()];
    for g in groups.iter() {
        for &i in &g.pins {
            if connector {
                if let Some(s) = stacked.iter().position(|s| names[s[0]] == names[i]) {
                    stacked[s].push(i);
                    slot_of[i] = s;
                    continue;
                }
            }
            slot_of[i] = stacked.len();
            stacked.push(vec![i]);
        }
    }
    // groups as lists of slots
    let slots = |g: &Group| -> Vec<usize> {
        let mut v: Vec<usize> = Vec::new();
        for &i in &g.pins {
            let s = slot_of[i];
            if !v.contains(&s) {
                v.push(s);
            }
        }
        v
    };

    // place the free groups (ports, unknown signals, NC): whole groups to the shorter side, in order;
    // a port larger than the gap left is split so both sides come out even
    let count = |side: Side, gs: &[(Group, Vec<usize>)]| -> usize {
        let v: Vec<usize> = gs.iter().filter(|(g, _)| g.side == Some(side)).map(|(_, s)| s.len()).collect();
        v.iter().sum::<usize>() + v.len().saturating_sub(1)
    };
    let mut placed: Vec<(Group, Vec<usize>)> = Vec::new();
    let mut free: Vec<(Group, Vec<usize>)> = Vec::new();
    for g in groups.into_iter() {
        let s = slots(&g);
        if g.side.is_some() {
            placed.push((g, s));
        } else {
            free.push((g, s));
        }
    }
    free.sort_by(|a, b| a.0.rank.cmp(&b.0.rank).then_with(|| natural(&a.0.key, &b.0.key)));
    let total_free: usize = free.iter().map(|(_, s)| s.len()).sum();
    for (mut g, s) in free.into_iter() {
        let (l, r) = (count(Side::Left, &placed), count(Side::Right, &placed));
        let target = (l + r + total_free + 1) / 2;
        let (short, long_n, short_n) = if l <= r { (Side::Left, r, l) } else { (Side::Right, l, r) };
        let _ = long_n;
        if g.key.starts_with("port:") && short_n + 1 + s.len() > target + 4 && s.len() > 8 {
            // split the port: the first part fills the shorter side up to the target, the rest goes across
            let room = target.saturating_sub(short_n + 1).clamp(4, s.len() - 4);
            let (a, b) = s.split_at(room);
            let other = if short == Side::Left { Side::Right } else { Side::Left };
            let mut g2 = g.clone();
            g.side = Some(short);
            g2.side = Some(other);
            g2.key = format!("{}#2", g2.key);
            placed.push((g, a.to_vec()));
            placed.push((g2, b.to_vec()));
        } else {
            g.side = Some(if g.key == "nc" && !connector { if l <= r { Side::Left } else { Side::Right } } else { short });
            placed.push((g, s));
        }
    }

    // build each side's column: groups by rank, a blank row between groups.  `align` holds the
    // rows where the left column's groups start, so an op-amp's output lines up with its inputs.
    let column = |side: Side, align: &[(String, usize)]| -> (Vec<Option<usize>>, Vec<(String, usize)>) {
        let mut gs: Vec<&(Group, Vec<usize>)> = placed.iter().filter(|(g, _)| g.side == Some(side)).collect();
        gs.sort_by_key(|(g, _)| g.rank);
        let mut out: Vec<Option<usize>> = Vec::new();
        let mut starts: Vec<(String, usize)> = Vec::new();
        let mut last: Option<(u8, usize)> = None;
        for (g, s) in gs {
            let lone = |r: u8, n: usize| r == 5 && n == 1;
            let tight = last.is_some_and(|(r, n)| lone(r, n) && lone(g.rank, s.len()));
            if !out.is_empty() && !tight && !(side == Side::Top || side == Side::Bottom) {
                out.push(None);
            }
            if let Some(ch) = g.key.strip_suffix(":Some(Right)") {
                if let Some((_, row)) = align.iter().find(|(k, _)| k.strip_suffix(":Some(Left)") == Some(ch)) {
                    while out.len() < *row {
                        out.push(None);
                    }
                }
            }
            last = Some((g.rank, s.len()));
            starts.push((g.key.clone(), out.len()));
            out.extend(s.iter().map(|&x| Some(x)));
        }
        (out, starts)
    };
    let (left, lstarts) = column(Side::Left, &[]);
    let (right, _) = column(Side::Right, &lstarts);
    let (top, _) = column(Side::Top, &[]);
    let (bottom, _) = column(Side::Bottom, &[]);

    // sizes
    let name_len = |s: usize| -> f64 {
        let n = &pins[stacked[s][0]].name;
        if n.is_empty() || n == "~" {
            0.0
        } else {
            n.replace("~{", "").replace('}', "").chars().count() as f64 * CW
        }
    };
    let widest = |col: &[Option<usize>]| col.iter().flatten().map(|&s| name_len(s)).fold(0.0, f64::max);
    let (wl, wr, dt, db) = (widest(&left), widest(&right), widest(&top), widest(&bottom));
    let numlen = pins.iter().map(|p| p.number.chars().count()).max().unwrap_or(1);
    let plen = if numlen > 3 { 5.08 } else if numlen > 2 { 3.81 } else { G };
    let snap_up = |v: f64, step: f64| (v / step - 1e-9).ceil() * step;
    let lr_name_w = |w: f64| if w > 0.0 { w + NAME_OFFSET } else { 0.0 };
    let span = |n: usize| if n == 0 { 0.0 } else { (n - 1) as f64 * G };
    let (nt, nb) = (top.len(), bottom.len());
    let side_need = lr_name_w(wl) + lr_name_w(wr) + G;
    // the width that keeps the top and bottom pins' names clear of the side names
    // (the top and bottom pins sit centred, so the wider side decides; 1.9 mm keeps the vertical names apart)
    let clear_w = |n: usize| if n == 0 { 0.0 } else { 2.0 * lr_name_w(wl).max(lr_name_w(wr)) + span(n) + 2.0 * 1.9 };
    let base_w = side_need.max(span(nt) + 2.0 * G).max(span(nb) + 2.0 * G).max(5.08 * 2.0);
    let rows = left.len().max(right.len());
    let has_sides = rows > 0;
    // top clearance: either widen the body, or start the side pins below the top names; take the cheaper
    let vert = |d: f64| snap_up(d + NAME_OFFSET + 1.27, G);
    let mut w = base_w;
    let (mut top_m, mut bot_m) = (G, G);
    for (n, d, is_top) in [(nt, dt, true), (nb, db, false)] {
        if n == 0 || !has_sides {
            continue;
        }
        let widen = (clear_w(n) - w).max(0.0);
        let lower = (vert(d) - G).max(0.0);
        if widen <= lower * 1.5 {
            w = w.max(clear_w(n));
        } else if is_top {
            top_m = vert(d);
        } else {
            bot_m = vert(d);
        }
    }
    if !has_sides {
        // only top and bottom pins: leave room for both names
        top_m = vert(dt).max(G);
        bot_m = vert(db).max(G);
    }
    let w = snap_up(w, 2.0 * G);
    let h = snap_up(top_m + span(rows.max(1)) + bot_m, G);
    let x0 = -w / 2.0;
    let x1 = w / 2.0;
    let y1 = snap_up(h / 2.0, G);
    let y0 = y1 - h;

    let mut out = String::new();
    out.push_str(&format!(
        "\t\t\t(rectangle (start {} {}) (end {} {}) (stroke (width 0.254) (type default)) (fill (type background)))\n",
        fnum(x0),
        fnum(y1),
        fnum(x1),
        fnum(y0)
    ));
    let mut bbox = [x0, y0, x1, y1];
    let mut emit = |s: usize, x: f64, y: f64, angle: i32, out: &mut String| {
        for (k, &i) in stacked[s].iter().enumerate() {
            let p = &pins[i];
            let n = &names[i];
            // KiCad's electrical types where the vendor left them unspecified
            let et = if p.etype == "unspecified" && ic {
                if is_nc(n) {
                    "no_connect"
                } else if is_ground(n) || is_supply(n) {
                    "power_in"
                } else if reg && matches!(reg_side(n), Some((Side::Right, 0, _))) {
                    "power_out"
                } else if port_of(n).is_some() {
                    "bidirectional"
                } else {
                    p.etype.as_str()
                }
            } else {
                p.etype.as_str()
            };
            out.push_str(&format!(
                "\t\t\t(pin {} {} (at {} {} {}) (length {}){} (name {} (effects (font (size 1.27 1.27)))) (number {} (effects (font (size 1.27 1.27)))))\n",
                et,
                p.style,
                fnum(x),
                fnum(y),
                angle,
                fnum(plen),
                if k > 0 { " (hide yes)" } else { "" },
                q(if p.name.is_empty() { "~" } else { &p.name }),
                q(if p.number.is_empty() { "~" } else { &p.number }),
            ));
        }
        bbox[0] = bbox[0].min(x);
        bbox[1] = bbox[1].min(y);
        bbox[2] = bbox[2].max(x);
        bbox[3] = bbox[3].max(y);
    };
    let ystart = y1 - top_m;
    for (r, s) in left.iter().enumerate() {
        if let Some(s) = s {
            emit(*s, x0 - plen, ystart - r as f64 * G, 0, &mut out);
        }
    }
    for (r, s) in right.iter().enumerate() {
        if let Some(s) = s {
            emit(*s, x1 + plen, ystart - r as f64 * G, 180, &mut out);
        }
    }
    let row_x = |n: usize, k: usize| ((-(span(n)) / 2.0) / G).round() * G + k as f64 * G;
    for (k, s) in top.iter().enumerate() {
        if let Some(s) = s {
            emit(*s, row_x(nt, k), y1 + plen, 270, &mut out);
        }
    }
    for (k, s) in bottom.iter().enumerate() {
        if let Some(s) = s {
            emit(*s, row_x(nb, k), y0 - plen, 90, &mut out);
        }
    }
    Some(Tidied { unit: out, bbox })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(n: &str, num: &str) -> RawPin {
        RawPin { etype: "unspecified".into(), style: "line".into(), name: n.into(), number: num.into() }
    }
    fn art() -> Art {
        Art { rects: 1, dots: 1, other: 0 }
    }
    fn where_is(t: &Tidied, name: &str) -> (f64, f64, i32) {
        let l = t.unit.lines().find(|l| l.contains(&format!("(name \"{name}\""))).unwrap_or_else(|| panic!("{name} missing"));
        let at: Vec<&str> = l.split("(at ").nth(1).unwrap().split(')').next().unwrap().split(' ').collect();
        (at[0].parse().unwrap(), at[1].parse().unwrap(), at[2].parse().unwrap())
    }

    #[test]
    fn buck_regulator_reads_like_its_datasheet() {
        let pins: Vec<RawPin> = [("GND", "1"), ("SW", "2"), ("VIN", "3"), ("VFB", "4"), ("EN", "5"), ("VBST", "6")].iter().map(|(n, k)| pin(n, k)).collect();
        let t = arrange(&pins, &art(), "U?").unwrap();
        assert_eq!(where_is(&t, "VIN").2, 0, "VIN on the left");
        assert_eq!(where_is(&t, "EN").2, 0);
        assert_eq!(where_is(&t, "SW").2, 180, "SW on the right");
        assert_eq!(where_is(&t, "VFB").2, 180);
        assert_eq!(where_is(&t, "GND").2, 90, "GND below");
        assert!(where_is(&t, "VIN").1 > where_is(&t, "EN").1);
    }

    #[test]
    fn microcontroller_power_top_ground_bottom_ports_in_order() {
        let mut pins = vec![pin("VBAT", "1"), pin("PC13", "2"), pin("PC14-OSC32_IN", "3"), pin("NRST", "7"), pin("VDD", "20"), pin("VSS", "21"), pin("EP", "49")];
        for k in 0..16 {
            pins.push(pin(&format!("PA{k}"), &format!("{}", 30 + k)));
        }
        let t = arrange(&pins, &art(), "U").unwrap();
        assert_eq!(where_is(&t, "VDD").2, 270);
        assert_eq!(where_is(&t, "VBAT").2, 270);
        assert_eq!(where_is(&t, "VSS").2, 90);
        assert!(where_is(&t, "EP").0 > where_is(&t, "VSS").0, "exposed pad last");
        assert_eq!(where_is(&t, "NRST").2, 0);
        // a port reads top to bottom on one side
        let (a0, a1) = (where_is(&t, "PA0"), where_is(&t, "PA1"));
        assert_eq!(a0.2, a1.2);
        assert!(a0.1 > a1.1);
        // every pin on the 50 mil grid
        for l in t.unit.lines().filter(|l| l.contains("(pin ")) {
            let at: Vec<f64> = l.split("(at ").nth(1).unwrap().split(' ').take(2).map(|v| v.parse().unwrap()).collect();
            for v in at {
                assert!(((v / 1.27) - (v / 1.27).round()).abs() < 1e-6, "{l}");
            }
        }
    }

    #[test]
    fn usb_c_receptacle_stacks_duplicates() {
        let pins: Vec<RawPin> = [("GND", "A1B12"), ("VBUS", "A4B9"), ("CC1", "A5"), ("DP1", "A6"), ("DN1", "A7"), ("SBU1", "A8"), ("CC2", "B5"), ("DP2", "B6"), ("DN2", "B7"), ("SBU2", "B8"), ("VBUS", "B4A9"), ("GND", "B1A12"), ("SHELL", "1"), ("SHELL", "2")]
            .iter()
            .map(|(n, k)| RawPin { etype: "passive".into(), ..pin(n, k) })
            .collect();
        let t = arrange(&pins, &art(), "USB?").unwrap();
        assert_eq!(t.unit.matches("(hide yes)").count(), 3);
        assert_eq!(where_is(&t, "VBUS").2, 270);
        assert_eq!(where_is(&t, "CC1").2, 180);
        assert_eq!(where_is(&t, "GND").2, 90);
    }

    #[test]
    fn artwork_and_headers_are_left_alone() {
        let pins = vec![pin("G", "1"), pin("S", "2"), pin("D", "3")];
        assert!(arrange(&pins, &Art { rects: 0, dots: 0, other: 3 }, "Q").is_none());
        let hdr: Vec<RawPin> = (1..=6).map(|k| pin(&k.to_string(), &k.to_string())).collect();
        assert!(arrange(&hdr, &art(), "J").is_none());
    }
}
