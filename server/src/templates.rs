//! Starter templates: a few finished KiCad projects a new project can begin from.
//!
//! The files live in `server/templates/<id>/` and are written by `scripts/templates/gen.mjs`, which only
//! keeps a template when KiCad's own ERC and DRC (schematic parity included) report nothing on it. They are
//! compiled into the binary; `index.json` beside them says what each one is.
//!
//! `POST /api/projects/from-template` makes a project from one. The files take the new project's name, as
//! KiCad's own "New Project from Template" does, and the three places a KiCad project spells its own file
//! name inside its files follow. The guided first project asks for the `guided` board (the blinker with a few
//! connections left to route); the home page's small editor hands over the board its visitor was working on.

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::http::{checked_name, doc_type_for, file_stem_for};
use crate::lenient_json::LenientJson;
use crate::persist;
use crate::AppState;

pub struct Template {
    pub id: &'static str,
    /// The base name of its files, and the project name written inside them.
    pub stem: &'static str,
    pub pro: &'static str,
    pub sch: &'static str,
    pub pcb: &'static str,
    /// The board with connections left open, for the guided first project.
    pub guided: Option<&'static str>,
    pub board_png: &'static [u8],
    pub schematic_png: &'static [u8],
}

macro_rules! template {
    ($id:literal, $stem:literal, $guided:expr) => {
        Template {
            id: $id,
            stem: $stem,
            pro: include_str!(concat!("../templates/", $id, "/", $stem, ".kicad_pro")),
            sch: include_str!(concat!("../templates/", $id, "/", $stem, ".kicad_sch")),
            pcb: include_str!(concat!("../templates/", $id, "/", $stem, ".kicad_pcb")),
            guided: $guided,
            board_png: include_bytes!(concat!("../templates/", $id, "/board.png")),
            schematic_png: include_bytes!(concat!("../templates/", $id, "/schematic.png")),
        }
    };
}

pub static TEMPLATES: &[Template] = &[
    template!("blinker", "blinker", Some(include_str!("../templates/blinker/blinker.guided.kicad_pcb"))),
    template!("usb-c-3v3-regulator", "usb-c-3v3-regulator", None),
    template!("i2c-sensor-breakout", "i2c-sensor-breakout", None),
    template!("attiny85-dev-board", "attiny85-dev-board", None),
];

const INDEX: &str = include_str!("../templates/index.json");

/// The largest board the home page's small editor may hand over (the blinker is about 75 kB).
const MAX_HANDED_BOARD: usize = 1024 * 1024;

fn find(id: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.id == id)
}

/// What the picker shows: index.json's entries, each with where its two pictures are.
pub fn catalog() -> Value {
    let mut index: Value = serde_json::from_str(INDEX).unwrap_or_else(|_| json!({ "templates": [] }));
    if let Some(list) = index.get_mut("templates").and_then(Value::as_array_mut) {
        list.retain(|t| t.get("id").and_then(Value::as_str).is_some_and(|id| find(id).is_some()));
        for t in list.iter_mut() {
            let id = t["id"].as_str().unwrap_or_default().to_string();
            t["board"] = json!(format!("/api/templates/{id}/board.png"));
            t["schematic"] = json!(format!("/api/templates/{id}/schematic.png"));
            t["guided"] = json!(find(&id).is_some_and(|x| x.guided.is_some()));
        }
    }
    index
}

/// GET /api/templates: open to everyone, the home page lists them too.
pub async fn list() -> Response {
    ([(header::CACHE_CONTROL, "public, max-age=300")], Json(catalog())).into_response()
}

/// GET /api/templates/{id}/{board.png|schematic.png}
pub async fn picture(Path((id, name)): Path<(String, String)>) -> Response {
    let Some(t) = find(&id) else { return StatusCode::NOT_FOUND.into_response() };
    let bytes = match name.as_str() {
        "board.png" => t.board_png,
        "schematic.png" => t.schematic_png,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    ([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "public, max-age=86400")], bytes).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FromTemplateRequest {
    pub template: String,
    /// The new project's name; the template's title when left out.
    #[serde(default)]
    pub name: Option<String>,
    /// Start from the board with connections left to route (templates that have one).
    #[serde(default)]
    pub guided: bool,
    /// A board to use in place of the template's: the one the visitor routed on the home page.
    #[serde(default)]
    pub board: Option<String>,
}

/// The template's files under the new project's file name. A KiCad project names itself in three places:
/// the project file's `meta.filename`, each symbol's `(instances (project "…"))` and each footprint's
/// `(sheetfile "….kicad_sch")`.
pub fn renamed(t: &Template, stem: &str, board: &str) -> [(String, String); 3] {
    let quoted = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""));
    let pro = t.pro.replace(
        &format!("\"filename\": {}", quoted(&format!("{}.kicad_pro", t.stem))),
        &format!("\"filename\": {}", quoted(&format!("{stem}.kicad_pro"))),
    );
    let sch = t.sch.replace(&format!("(project \"{}\"", t.stem), &format!("(project \"{stem}\""));
    let pcb = board.replace(&format!("(sheetfile \"{}.kicad_sch\")", t.stem), &format!("(sheetfile \"{stem}.kicad_sch\")"));
    [(format!("{stem}.kicad_pro"), pro), (format!("{stem}.kicad_sch"), sch), (format!("{stem}.kicad_pcb"), pcb)]
}

/// A handed-over board is taken only if it reads as a KiCad board: one balanced `(kicad_pcb …)` list.
fn is_board(text: &str) -> bool {
    let t = text.trim();
    if !t.starts_with("(kicad_pcb") || t.len() > MAX_HANDED_BOARD {
        return false;
    }
    let (mut depth, mut in_str, mut esc, mut closed) = (0i32, false, false, false);
    for c in t.chars() {
        if closed {
            return false; // something after the closing bracket
        }
        if in_str {
            if esc { esc = false } else if c == '\\' { esc = true } else if c == '"' { in_str = false }
            continue;
        }
        match c {
            '"' => in_str = true,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 { return false }
                if depth == 0 { closed = true }
            }
            _ => {}
        }
    }
    closed && !in_str
}

/// POST /api/projects/from-template
pub async fn create(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    LenientJson(req): LenientJson<FromTemplateRequest>,
) -> AppResult<Response> {
    let t = find(req.template.trim()).ok_or_else(|| AppError::BadRequest("there is no such template".into()))?;
    let title = catalog()["templates"]
        .as_array()
        .and_then(|l| l.iter().find(|x| x["id"] == t.id))
        .and_then(|x| x["title"].as_str().map(str::to_string))
        .unwrap_or_else(|| t.id.to_string());
    let name = req.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&title).to_string();
    checked_name(&name)?;
    let stem = file_stem_for(&name);
    let board: &str = match (&req.board, req.guided, t.guided) {
        (Some(b), _, _) => {
            if !is_board(b) {
                return Err(AppError::BadRequest("that board could not be read".into()));
            }
            b.as_str()
        }
        (None, true, Some(g)) => g,
        _ => t.pcb,
    };

    let project = persist::create_project(&state.pool, user.id, &name).await?;
    let mut docs = Vec::new();
    for (path, content) in renamed(t, &stem, board) {
        let doc = persist::create_document(&state.pool, project.id, &path, doc_type_for(&path)).await?;
        persist::insert_snapshot(&state.pool, doc.id, 0, content.as_bytes(), None, Some(user.id)).await?;
        docs.push(json!({ "docId": doc.id, "path": doc.path, "docType": doc.doc_type }));
    }
    Ok(Json(json!({ "projectId": project.id, "name": project.name, "docs": docs, "template": t.id })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_template_in_the_index_is_compiled_in_and_the_other_way_round() {
        let cat = catalog();
        let listed: Vec<&str> = cat["templates"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
        let index: Value = serde_json::from_str(INDEX).unwrap();
        assert_eq!(index["templates"].as_array().unwrap().len(), TEMPLATES.len(), "index.json and TEMPLATES list the same templates");
        for t in TEMPLATES {
            assert!(listed.contains(&t.id), "{} is in index.json", t.id);
            assert!(t.sch.starts_with("(kicad_sch") && t.pcb.starts_with("(kicad_pcb"), "{} holds KiCad files", t.id);
            assert!(serde_json::from_str::<Value>(t.pro).is_ok(), "{}'s project file is JSON", t.id);
            assert!(t.board_png.starts_with(b"\x89PNG") && t.schematic_png.starts_with(b"\x89PNG"), "{} has its pictures", t.id);
            assert!(is_board(t.pcb), "{}'s own board passes the check a handed-over board gets", t.id);
        }
        for t in cat["templates"].as_array().unwrap() {
            for key in ["title", "summary", "detail", "level"] {
                assert!(t[key].as_str().is_some_and(|s| !s.is_empty()), "{} has {key}", t["id"]);
            }
        }
    }

    #[test]
    fn the_blinker_template_is_the_home_page_demo() {
        // The small editor on the home page hands its board over to a project made from this template, so the
        // schematic that project gets must be the one that board was made for.
        let t = find("blinker").unwrap();
        assert_eq!(t.sch, include_str!("../web/landing/demo/blinker.kicad_sch"), "run node scripts/templates/gen.mjs after the demo changes");
        assert_eq!(t.pcb, include_str!("../web/landing/demo/blinker.kicad_pcb"), "run node scripts/templates/gen.mjs after the demo changes");
        let g = t.guided.unwrap();
        assert!(is_board(g) && g.contains("(filled_polygon") && g.len() < t.pcb.len(), "the guided board is the same board with connections taken out, pour still filled");
    }

    #[test]
    fn a_project_from_a_template_is_named_throughout() {
        let t = find("usb-c-3v3-regulator").unwrap();
        let [(pro_path, pro), (sch_path, sch), (pcb_path, pcb)] = renamed(t, "My_supply", t.pcb);
        assert_eq!((pro_path.as_str(), sch_path.as_str(), pcb_path.as_str()), ("My_supply.kicad_pro", "My_supply.kicad_sch", "My_supply.kicad_pcb"));
        assert!(pro.contains("\"filename\": \"My_supply.kicad_pro\"") && !pro.contains("usb-c-3v3-regulator.kicad_pro"));
        assert!(sch.contains("(project \"My_supply\"") && !sch.contains("(project \"usb-c-3v3-regulator\""));
        assert!(pcb.contains("(sheetfile \"My_supply.kicad_sch\")") && !pcb.contains("(sheetfile \"usb-c-3v3-regulator.kicad_sch\")"));
        // nothing else moved
        assert_eq!(sch.len() as i64 - t.sch.len() as i64, (sch.matches("(project \"My_supply\"").count() as i64) * ("My_supply".len() as i64 - t.stem.len() as i64));
    }

    #[test]
    fn a_handed_over_board_must_be_one_kicad_board() {
        assert!(is_board("(kicad_pcb (version 20241229) (generator \"pcbnew\"))"));
        assert!(is_board("  (kicad_pcb (gr_text \"a ) b \\\" (\" (at 0 0)))\n"));
        assert!(!is_board("(kicad_sch (version 1))"));
        assert!(!is_board("(kicad_pcb (version 1)"));
        assert!(!is_board("(kicad_pcb) (kicad_pcb)"));
        assert!(!is_board("(kicad_pcb))"));
        assert!(!is_board("hello"));
    }
}
