//! Three-way merge of KiCad s-expression files, item by item.
//!
//! A KiCad file is one list whose children are the design's items; nearly all of
//! them carry a `(uuid …)`.  That makes a real merge possible without understanding
//! the design: match items by identity, keep whichever side changed each one, and
//! only call it a conflict when both sides changed the same item differently.  An
//! item both sides changed is merged one level further down (a footprint moved on
//! one side and re-valued on the other merges cleanly).
//!
//! The merge never re-serialises anything: every item in the result is a byte-exact
//! span from one of the inputs, laid out in our file's order with its original
//! whitespace, so an item nobody touched comes out exactly as it went in.

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prefer {
    Ours,
    Theirs,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Conflict {
    /// Human label: `footprint R1`, `symbol U3 › at`, `segment 1a2b3c4d`.
    pub item: String,
    /// Which side's version went into the result.
    pub kept: &'static str,
}

#[derive(Debug)]
pub struct Merged {
    pub text: String,
    pub conflicts: Vec<Conflict>,
    /// Items taken from their side (changed, added or removed there).
    pub from_theirs: usize,
    /// Items where our side's change was kept.
    pub from_ours: usize,
}

struct Child<'a> {
    /// Whitespace between the previous sibling (or the list head) and this child.
    lead: &'a str,
    text: &'a str,
    key: String,
}

struct List<'a> {
    /// `(` plus the head token.
    head: &'a str,
    children: Vec<Child<'a>>,
    /// Everything after the last child: whitespace and the closing paren (and, at
    /// the top level, the file's trailing newline).
    tail: &'a str,
}

/// End (exclusive) of the s-expression element starting at `i`: a quoted string,
/// a bare atom or a balanced list.  None if the input ends first.
fn element_end(s: &[u8], i: usize) -> Option<usize> {
    match *s.get(i)? {
        b'"' => {
            let mut j = i + 1;
            while j < s.len() {
                match s[j] {
                    b'\\' => j += 2,
                    b'"' => return Some(j + 1),
                    _ => j += 1,
                }
            }
            None
        }
        b'(' => {
            let mut depth = 0usize;
            let mut j = i;
            while j < s.len() {
                match s[j] {
                    b'"' => {
                        j = element_end(s, j)?;
                        continue;
                    }
                    b'(' => depth += 1,
                    b')' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            None
        }
        b')' => None,
        _ => {
            let mut j = i;
            while j < s.len() && !s[j].is_ascii_whitespace() && s[j] != b'(' && s[j] != b')' {
                j += 1;
            }
            Some(j)
        }
    }
}

fn head_of(text: &str) -> &str {
    let b = text.as_bytes();
    if b.first() != Some(&b'(') {
        return "";
    }
    let end = element_end(b, 1).unwrap_or(1);
    &text[1..end]
}

/// The elements of a list after its head, as (start, end) spans.
fn spans(text: &str) -> Option<(usize, Vec<(usize, usize)>, usize)> {
    let b = text.as_bytes();
    let start = b.iter().position(|c| !c.is_ascii_whitespace())?;
    if b[start] != b'(' {
        return None;
    }
    let head_end = element_end(b, start + 1)?;
    let mut out = Vec::new();
    let mut i = head_end;
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            return None;
        }
        if b[i] == b')' {
            return Some((head_end, out, i));
        }
        let end = element_end(b, i)?;
        out.push((i, end));
        i = end;
    }
}

/// First argument of a list when it is an atom or a string (`(net 5 "GND")` -> `5`).
fn first_arg(text: &str) -> Option<&str> {
    let (_, sp, _) = spans(text)?;
    let (s, e) = *sp.first()?;
    (text.as_bytes()[s] != b'(').then(|| &text[s..e])
}

/// The value of a direct `(name value)` child.
fn direct_value<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let (_, sp, _) = spans(text)?;
    sp.iter().find_map(|&(s, e)| {
        let child = &text[s..e];
        (head_of(child) == name).then(|| first_arg(child)).flatten()
    })
}

fn parse(text: &str) -> Option<List<'_>> {
    let (head_end, sp, close) = spans(text)?;
    let start = text.len() - text.trim_start().len();
    let mut children = Vec::with_capacity(sp.len());
    let mut prev = head_end;
    for &(s, e) in &sp {
        children.push(Child { lead: &text[prev..s], text: &text[s..e], key: String::new() });
        prev = e;
    }

    // Identity: a uuid when the item has one; otherwise the head, qualified by the
    // first argument for the kinds that come in named sets (nets, properties,
    // library symbols), and by position when that repeats or it is a bare atom.
    // The rule must not depend on what else is in the list, or an item's identity
    // would change when a sibling is added or removed.
    let mut seen: HashMap<String, usize> = HashMap::new();
    for (i, c) in children.iter_mut().enumerate() {
        let head = head_of(c.text);
        let key = if head.is_empty() {
            format!("@{i}")
        } else if let Some(u) = direct_value(c.text, "uuid") {
            format!("uuid:{u}")
        } else if named_by_first_arg(head) {
            match first_arg(c.text) {
                Some(a) => format!("{head}:{a}"),
                None => head.to_string(),
            }
        } else {
            head.to_string()
        };
        let n = seen.entry(key.clone()).or_default();
        c.key = if *n == 0 { key } else { format!("{key}#{n}") };
        *n += 1;
    }

    let _ = close;
    Some(List { head: &text[start..head_end], children, tail: &text[prev..] })
}

/// Kinds of item without a uuid that are told apart by their first argument.
fn named_by_first_arg(head: &str) -> bool {
    matches!(
        head,
        "net" | "property" | "symbol" | "pad" | "fp_text" | "path" | "model" | "net_class" | "layer_pair"
            | "user" | "variant" | "file" | "project" | "class"
    )
}

fn has_sublist(text: &str) -> bool {
    text.starts_with('(') && text[1..].contains('(')
}

fn unquote(s: &str) -> &str {
    s.trim_matches('"')
}

fn label(text: &str) -> String {
    let head = head_of(text);
    if head.is_empty() {
        return text.chars().take(24).collect();
    }
    // Footprints and symbols are known to people by their reference.
    if let Some((_, sp, _)) = spans(text) {
        for &(s, e) in &sp {
            let child = &text[s..e];
            if head_of(child) == "property" && first_arg(child).map(unquote) == Some("Reference") {
                if let Some((_, psp, _)) = spans(child) {
                    if let Some(&(vs, ve)) = psp.get(1) {
                        return format!("{head} {}", unquote(&child[vs..ve]));
                    }
                }
            }
        }
    }
    // A property is known by its name even when it also carries a uuid.
    if named_by_first_arg(head) {
        if let Some(a) = first_arg(text).filter(|a| a.len() <= 40) {
            return format!("{head} {}", unquote(a));
        }
    }
    if let Some(u) = direct_value(text, "uuid") {
        return format!("{head} {}", &unquote(u)[..unquote(u).len().min(8)]);
    }
    match first_arg(text) {
        Some(a) if a.len() <= 40 && (has_sublist(text) || named_by_first_arg(head)) => format!("{head} {}", unquote(a)),
        _ => head.to_string(),
    }
}

/// Items where the two sides are never worth reporting: which program last wrote
/// the file.  They follow the side with the newer format version instead.
fn is_stamp(key: &str) -> bool {
    matches!(key, "version" | "generator" | "generator_version")
}

fn version_of(list: &List<'_>) -> i64 {
    list.children
        .iter()
        .find(|c| c.key == "version")
        .and_then(|c| first_arg(c.text))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

struct Ctx {
    prefer: Prefer,
    conflicts: Vec<Conflict>,
    from_theirs: usize,
    from_ours: usize,
}

fn merge_lists(
    base: Option<&str>,
    ours: &str,
    theirs: &str,
    depth: usize,
    path: &str,
    ctx: &mut Ctx,
) -> Option<String> {
    let o = parse(ours)?;
    let t = parse(theirs)?;
    if o.head != t.head {
        return None;
    }
    let b = base.and_then(parse);
    let empty: Vec<Child<'_>> = Vec::new();
    let b_children = b.as_ref().map(|l| &l.children).unwrap_or(&empty);

    let b_map: HashMap<&str, &str> = b_children.iter().map(|c| (c.key.as_str(), c.text)).collect();
    let o_map: HashMap<&str, &str> = o.children.iter().map(|c| (c.key.as_str(), c.text)).collect();
    let t_map: HashMap<&str, &Child<'_>> = t.children.iter().map(|c| (c.key.as_str(), c)).collect();

    // The stamps travel together with the newer file format: an item written in a
    // newer syntax under an older version stamp would not load.
    let theirs_newer = depth == 0 && version_of(&t) > version_of(&o);

    let mut out = String::with_capacity(ours.len().max(theirs.len()) + 64);
    out.push_str(o.head);
    let mut emitted: HashSet<&str> = HashSet::new();
    // Text to place before a child emitted where none stood in our file.
    let default_lead = o.children.first().map(|c| c.lead).unwrap_or(" ");

    // Their additions go in right after the sibling they follow in their file.
    let mut after: HashMap<&str, Vec<&Child<'_>>> = HashMap::new();
    let mut at_start: Vec<&Child<'_>> = Vec::new();
    {
        let mut anchor: Option<&str> = None;
        for c in &t.children {
            let key = c.key.as_str();
            let added = !o_map.contains_key(key) && !b_map.contains_key(key);
            if added {
                match anchor {
                    Some(a) => after.entry(a).or_default().push(c),
                    None => at_start.push(c),
                }
            } else if o_map.contains_key(key) {
                anchor = Some(key);
            }
        }
    }

    for c in &at_start {
        out.push_str(c.lead);
        out.push_str(c.text);
        emitted.insert(c.key.as_str());
        ctx.from_theirs += 1;
    }

    for c in &o.children {
        let key = c.key.as_str();
        let base_text = b_map.get(key).copied();
        let their = t_map.get(key).map(|c| c.text);
        let name = || {
            let l = label(c.text);
            if path.is_empty() { l } else { format!("{path} › {l}") }
        };

        let chosen: Option<String> = if depth == 0 && is_stamp(key) {
            Some(if theirs_newer { their.unwrap_or(c.text) } else { c.text }.to_string())
        } else {
            match their {
                Some(t_text) if t_text == c.text => Some(c.text.to_string()),
                Some(t_text) => {
                    if base_text == Some(c.text) {
                        ctx.from_theirs += 1;
                        Some(t_text.to_string())
                    } else if base_text == Some(t_text) {
                        ctx.from_ours += 1;
                        Some(c.text.to_string())
                    } else {
                        // Both changed it: try one level down, else pick a side.
                        let nested = (depth < 2 && has_sublist(c.text) && has_sublist(t_text))
                            .then(|| merge_lists(base_text, c.text, t_text, depth + 1, &name(), ctx))
                            .flatten();
                        match nested {
                            Some(text) => Some(text),
                            None => {
                                let ours_wins = ctx.prefer == Prefer::Ours;
                                ctx.conflicts.push(Conflict {
                                    item: name(),
                                    kept: if ours_wins { "online" } else { "github" },
                                });
                                Some(if ours_wins { c.text } else { t_text }.to_string())
                            }
                        }
                    }
                }
                None => match base_text {
                    // They removed it and we left it alone: it goes.
                    Some(bt) if bt == c.text => {
                        ctx.from_theirs += 1;
                        None
                    }
                    // They removed it, we changed it.
                    Some(_) => {
                        let ours_wins = ctx.prefer == Prefer::Ours;
                        ctx.conflicts.push(Conflict {
                            item: format!("{} (removed on GitHub, changed online)", name()),
                            kept: if ours_wins { "online" } else { "github" },
                        });
                        ours_wins.then(|| c.text.to_string())
                    }
                    // Ours alone: we added it.
                    None => Some(c.text.to_string()),
                },
            }
        };

        if let Some(text) = chosen {
            out.push_str(c.lead);
            out.push_str(&text);
        }
        emitted.insert(key);
        if let Some(adds) = after.get(key) {
            for a in adds {
                out.push_str(if a.lead.is_empty() { default_lead } else { a.lead });
                out.push_str(a.text);
                emitted.insert(a.key.as_str());
                ctx.from_theirs += 1;
            }
        }
    }

    // In their file and the base but gone from ours: we removed it.  If they also
    // changed it, that is a conflict; keeping it means putting it back at the end.
    for c in &t.children {
        let key = c.key.as_str();
        if emitted.contains(key) || o_map.contains_key(key) {
            continue;
        }
        match b_map.get(key) {
            Some(bt) if *bt == c.text => ctx.from_ours += 1,
            Some(_) => {
                let ours_wins = ctx.prefer == Prefer::Ours;
                ctx.conflicts.push(Conflict {
                    item: format!(
                        "{}{} (removed online, changed on GitHub)",
                        if path.is_empty() { String::new() } else { format!("{path} › ") },
                        label(c.text)
                    ),
                    kept: if ours_wins { "online" } else { "github" },
                });
                if !ours_wins {
                    out.push_str(if c.lead.is_empty() { default_lead } else { c.lead });
                    out.push_str(c.text);
                }
            }
            None => {
                // An addition whose anchor never appeared (handled above otherwise).
                out.push_str(if c.lead.is_empty() { default_lead } else { c.lead });
                out.push_str(c.text);
                ctx.from_theirs += 1;
            }
        }
    }

    out.push_str(o.tail);
    Some(out)
}

/// Merge `theirs` into `ours` relative to their common ancestor.  Without a base
/// (the two were never in sync) every difference is a both-sides change and items
/// present on only one side are kept.  None when a file is not a well-formed
/// s-expression or the two are different kinds of file.
pub fn merge3(base: Option<&str>, ours: &str, theirs: &str, prefer: Prefer) -> Option<Merged> {
    let mut ctx = Ctx { prefer, conflicts: Vec::new(), from_theirs: 0, from_ours: 0 };
    let text = merge_lists(base, ours, theirs, 0, "", &mut ctx)?;
    // The result must itself be a well-formed list — never hand back a broken file.
    parse(&text)?;
    Some(Merged { text, conflicts: ctx.conflicts, from_theirs: ctx.from_theirs, from_ours: ctx.from_ours })
}

/// One item that differs between two versions of a file.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct ItemChange {
    /// `added`, `removed` or `changed`.
    pub kind: &'static str,
    /// Human label: `footprint R1`, `segment 1a2b3c4d`.
    pub item: String,
    /// For a changed item, which of its parts differ: `at`, `property Value`, …
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<String>,
}

/// What turned `old` into `new`, item by item — the same matching the merge uses,
/// so the list is exactly what a merge would carry across.  None when either file
/// is not an s-expression.  The program stamps (version, generator) are left out.
pub fn diff(old: &str, new: &str) -> Option<Vec<ItemChange>> {
    let o = parse(old)?;
    let n = parse(new)?;
    let o_map: HashMap<&str, &str> = o.children.iter().map(|c| (c.key.as_str(), c.text)).collect();
    let n_keys: HashSet<&str> = n.children.iter().map(|c| c.key.as_str()).collect();
    let mut out = Vec::new();
    for c in &n.children {
        if is_stamp(&c.key) {
            continue;
        }
        match o_map.get(c.key.as_str()) {
            None => out.push(ItemChange { kind: "added", item: label(c.text), parts: Vec::new() }),
            Some(old_text) if *old_text != c.text => {
                let mut parts = Vec::new();
                if let (true, Some(oc), Some(nc)) = (has_sublist(c.text), parse(old_text), parse(c.text)) {
                    let om: HashMap<&str, &str> = oc.children.iter().map(|x| (x.key.as_str(), x.text)).collect();
                    let nk: HashSet<&str> = nc.children.iter().map(|x| x.key.as_str()).collect();
                    for x in &nc.children {
                        match om.get(x.key.as_str()) {
                            None => parts.push(format!("{} added", label(x.text))),
                            Some(t) if *t != x.text => parts.push(label(x.text)),
                            _ => {}
                        }
                    }
                    for x in &oc.children {
                        if !nk.contains(x.key.as_str()) {
                            parts.push(format!("{} removed", label(x.text)));
                        }
                    }
                    parts.truncate(12);
                }
                out.push(ItemChange { kind: "changed", item: label(c.text), parts });
            }
            _ => {}
        }
    }
    for c in &o.children {
        if !n_keys.contains(c.key.as_str()) && !is_stamp(&c.key) {
            out.push(ItemChange { kind: "removed", item: label(c.text), parts: Vec::new() });
        }
    }
    Some(out)
}

/// Whether a file of this document type is an s-expression the merge understands.
pub fn mergeable(doc_type: &str) -> bool {
    matches!(doc_type, "kicad_sch" | "kicad_pcb" | "symbol_lib" | "footprint" | "worksheet")
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "(kicad_pcb\n\t(version 20240108)\n\t(generator \"pcbnew\")\n\t(net 0 \"\")\n\t(net 1 \"GND\")\n\t(footprint \"R_0603\"\n\t\t(layer \"F.Cu\")\n\t\t(uuid \"aaaa1111\")\n\t\t(at 10 10)\n\t\t(property \"Reference\" \"R1\"\n\t\t\t(at 0 0)\n\t\t)\n\t\t(property \"Value\" \"10k\"\n\t\t\t(at 0 1)\n\t\t)\n\t)\n\t(footprint \"C_0603\"\n\t\t(layer \"F.Cu\")\n\t\t(uuid \"bbbb2222\")\n\t\t(at 20 20)\n\t\t(property \"Reference\" \"C1\"\n\t\t\t(at 0 0)\n\t\t)\n\t)\n\t(segment\n\t\t(start 1 1)\n\t\t(end 2 2)\n\t\t(uuid \"cccc3333\")\n\t)\n)\n";

    #[test]
    fn identical_inputs_round_trip_byte_for_byte() {
        let m = merge3(Some(BASE), BASE, BASE, Prefer::Ours).unwrap();
        assert_eq!(m.text, BASE);
        assert!(m.conflicts.is_empty());
    }

    #[test]
    fn independent_changes_both_land() {
        let ours = BASE.replace("(at 10 10)", "(at 15 15)");
        let theirs = BASE.replace("(at 20 20)", "(at 25 25)");
        let m = merge3(Some(BASE), &ours, &theirs, Prefer::Ours).unwrap();
        assert!(m.conflicts.is_empty(), "{:?}", m.conflicts);
        assert!(m.text.contains("(at 15 15)") && m.text.contains("(at 25 25)"));
        assert_eq!(m.text, BASE.replace("(at 10 10)", "(at 15 15)").replace("(at 20 20)", "(at 25 25)"));
    }

    #[test]
    fn same_item_different_fields_merges_one_level_down() {
        let ours = BASE.replace("(at 10 10)", "(at 15 15)");
        let theirs = BASE.replace("\"10k\"", "\"22k\"");
        let m = merge3(Some(BASE), &ours, &theirs, Prefer::Ours).unwrap();
        assert!(m.conflicts.is_empty(), "{:?}", m.conflicts);
        assert!(m.text.contains("(at 15 15)") && m.text.contains("\"22k\""));
    }

    #[test]
    fn same_field_is_a_conflict_resolved_by_preference() {
        let ours = BASE.replace("(at 10 10)", "(at 15 15)");
        let theirs = BASE.replace("(at 10 10)", "(at 99 99)");
        let m = merge3(Some(BASE), &ours, &theirs, Prefer::Ours).unwrap();
        assert_eq!(m.conflicts.len(), 1);
        assert_eq!(m.conflicts[0].item, "footprint R1 › at");
        assert!(m.text.contains("(at 15 15)") && !m.text.contains("(at 99 99)"));
        let m = merge3(Some(BASE), &ours, &theirs, Prefer::Theirs).unwrap();
        assert!(m.text.contains("(at 99 99)") && !m.text.contains("(at 15 15)"));
    }

    #[test]
    fn additions_and_removals_from_both_sides() {
        let ours = BASE.replace("\t(segment\n\t\t(start 1 1)\n\t\t(end 2 2)\n\t\t(uuid \"cccc3333\")\n\t)\n", "");
        let theirs = BASE.replace(
            "\t(segment",
            "\t(via\n\t\t(at 5 5)\n\t\t(uuid \"dddd4444\")\n\t)\n\t(segment",
        );
        let m = merge3(Some(BASE), &ours, &theirs, Prefer::Ours).unwrap();
        assert!(m.conflicts.is_empty(), "{:?}", m.conflicts);
        assert!(m.text.contains("dddd4444"), "their via is added");
        assert!(!m.text.contains("cccc3333"), "our removal sticks");
        assert!(m.text.ends_with("\n)\n"));
        // Their via sits after the footprint it followed, with its own indentation.
        assert!(m.text.contains("\t)\n\t(via\n\t\t(at 5 5)"));
    }

    #[test]
    fn their_removal_applies_when_we_left_the_item_alone() {
        let theirs = BASE.replace("\t(net 1 \"GND\")\n", "");
        let m = merge3(Some(BASE), BASE, &theirs, Prefer::Ours).unwrap();
        assert_eq!(m.text, theirs);
    }

    /// An item's identity must not depend on its siblings: with two nets, one
    /// removed on GitHub and the other renamed online, both changes land.
    #[test]
    fn identity_survives_a_sibling_being_removed() {
        let theirs = BASE.replace("\t(net 1 \"GND\")\n", "");
        let ours = BASE.replace("(net 0 \"\")", "(net 0 \"unconnected\")");
        let m = merge3(Some(BASE), &ours, &theirs, Prefer::Ours).unwrap();
        assert!(m.conflicts.is_empty(), "{:?}", m.conflicts);
        assert_eq!(m.text, ours.replace("\t(net 1 \"GND\")\n", ""));
    }

    #[test]
    fn newer_format_stamp_wins_without_a_conflict() {
        let theirs = BASE.replace("20240108", "20250101").replace("(at 20 20)", "(at 1 1)");
        let ours = BASE.replace("(at 10 10)", "(at 2 2)");
        let m = merge3(Some(BASE), &ours, &theirs, Prefer::Ours).unwrap();
        assert!(m.conflicts.is_empty());
        assert!(m.text.contains("(version 20250101)"));
        // …and an older stamp on their side never downgrades ours.
        let m = merge3(Some(&theirs), &theirs, BASE, Prefer::Theirs).unwrap();
        assert!(m.text.contains("(version 20250101)"));
    }

    #[test]
    fn without_a_base_differences_conflict_and_both_sides_items_survive() {
        let ours = BASE.replace("(at 10 10)", "(at 15 15)");
        let theirs = BASE.replace("\t(segment", "\t(via\n\t\t(uuid \"dddd4444\")\n\t)\n\t(segment");
        let m = merge3(None, &ours, &theirs, Prefer::Ours).unwrap();
        assert!(m.text.contains("dddd4444") && m.text.contains("(at 15 15)"));
        assert_eq!(m.conflicts.len(), 1);
    }

    #[test]
    fn strings_with_parens_and_escapes_do_not_confuse_the_scanner() {
        let base = "(kicad_sch\n\t(text \"a (b\\\" c)\"\n\t\t(uuid \"t1\")\n\t)\n\t(wire\n\t\t(uuid \"w1\")\n\t)\n)\n";
        let theirs = base.replace("a (b", "A (B");
        let m = merge3(Some(base), base, &theirs, Prefer::Ours).unwrap();
        assert_eq!(m.text, theirs);
    }

    /// Every KiCad file in the source tree (demos + qa data): merging a file with
    /// itself must return it byte for byte, and an edit made on one side must come
    /// out as exactly that edit.  `KICAD_FILES_DIR=.. cargo test -- --ignored real_files`
    #[test]
    #[ignore]
    fn real_files_round_trip() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    if !matches!(p.file_name().and_then(|n| n.to_str()), Some(".git" | "target" | "node_modules")) {
                        walk(&p, out);
                    }
                } else if matches!(
                    p.extension().and_then(|x| x.to_str()),
                    Some("kicad_pcb" | "kicad_sch" | "kicad_sym" | "kicad_mod" | "kicad_wks")
                ) {
                    out.push(p);
                }
            }
        }
        let dir = std::env::var("KICAD_FILES_DIR").expect("set KICAD_FILES_DIR");
        let mut files = Vec::new();
        walk(std::path::Path::new(&dir), &mut files);
        let (mut ok, mut skipped, mut edited) = (0, 0, 0);
        for f in &files {
            let Ok(text) = std::fs::read_to_string(f) else { skipped += 1; continue };
            // Legacy-format and deliberately broken test files are not s-expressions.
            let Some(m) = merge3(Some(&text), &text, &text, Prefer::Ours) else { skipped += 1; continue };
            assert_eq!(m.text, text, "{} did not round-trip", f.display());
            assert!(m.conflicts.is_empty());
            ok += 1;

            // Drop one item on our side, retitle on theirs: both must land, nothing else may move.
            let Some(list) = parse(&text) else { continue };
            let Some(victim) = list.children.iter().rev().find(|c| c.key.starts_with("uuid:")) else { continue };
            if text.matches(victim.text).count() != 1 || !text.contains("(paper \"A4\")") {
                continue;
            }
            let ours = text.replacen(&format!("{}{}", victim.lead, victim.text), "", 1);
            let theirs = text.replacen("(paper \"A4\")", "(paper \"A3\")", 1);
            let m = merge3(Some(&text), &ours, &theirs, Prefer::Ours).unwrap();
            assert!(m.conflicts.is_empty(), "{}: {:?}", f.display(), m.conflicts);
            assert_eq!(m.text, ours.replacen("(paper \"A4\")", "(paper \"A3\")", 1), "{}", f.display());
            edited += 1;
        }
        println!("{ok} files round-tripped, {edited} also merged an edit, {skipped} not s-expressions");
        assert!(ok > 100, "expected the KiCad tree's files, found {ok}");
    }

    #[test]
    fn diff_lists_items_and_their_changed_parts() {
        let new = BASE
            .replace("(at 10 10)", "(at 15 15)")
            .replace("\"10k\"", "\"22k\"")
            .replace("\t(net 1 \"GND\")\n", "")
            .replace("20240108", "20250101")
            .replace("\t(segment", "\t(via\n\t\t(at 5 5)\n\t\t(uuid \"dddd4444\")\n\t)\n\t(segment");
        let d = diff(BASE, &new).unwrap();
        let brief: Vec<String> = d.iter().map(|c| format!("{} {} [{}]", c.kind, c.item, c.parts.join(", "))).collect();
        assert_eq!(
            brief,
            vec![
                "changed footprint R1 [at, property Value]",
                "added via dddd4444 []",
                "removed net 1 []",
            ]
        );
        assert!(diff(BASE, BASE).unwrap().is_empty());
        assert!(diff("{}", BASE).is_none());
    }

    #[test]
    fn garbage_is_refused() {
        assert!(merge3(None, "(kicad_pcb (a)", "(kicad_pcb (a))", Prefer::Ours).is_none());
        assert!(merge3(None, "{\"json\": 1}", "{\"json\": 2}", Prefer::Ours).is_none());
        assert!(merge3(None, "(kicad_pcb (a))", "(kicad_sch (a))", Prefer::Ours).is_none());
    }
}
