use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::AppHandle;
use uuid::Uuid;

use crate::app_settings::load_settings;
use crate::file_management::{AlbumItem, get_albums, save_albums};
use crate::formats::is_raw_file;
use crate::image_processing::{ImageMetadata, is_image_edited, resolve_tonemapper_override};
use crate::preset_converter::{convert_xmp_to_preset, lrtemplate_to_xmp};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LrImportSummary {
    imported: usize,
    skipped_edited: usize,
    missing_files: usize,
    estimated_white_balance: usize,
    albums: usize,
}

struct Row {
    id: i64,
    master: Option<i64>,
    folder: i64,
    path: String,
    rating: u8,
    lr_steps: u8,
    exif_steps: u8,
    text: String,
    width: f64,
    height: f64,
}

type Scalars<'a> = HashMap<&'a str, &'a str>;

// Lightroom zlib-compresses some text columns behind a 4-byte length prefix.
fn decode_text(bytes: &[u8]) -> String {
    let mut s = String::new();
    if bytes.len() > 4
        && flate2::read::ZlibDecoder::new(&bytes[4..])
            .read_to_string(&mut s)
            .is_ok()
    {
        return s;
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// Top-level lines of a develop settings table. Nested tables (masks, retouch, the
/// profile's Look with its own tone curve) are dropped, except the tone curves.
fn top_level_lines(text: &str) -> Vec<&str> {
    let body = text
        .trim()
        .strip_prefix("s = {")
        .and_then(|b| b.strip_suffix('}'))
        .unwrap_or("");
    let mut out = Vec::new();
    let (mut depth, mut keep) = (0i32, false);
    for line in body.lines() {
        let line = line.trim();
        if depth == 0 {
            keep = !line.contains('{') || line.starts_with("ToneCurvePV2012");
        }
        if keep {
            out.push(line);
        }
        depth += line.matches('{').count() as i32 - line.matches('}').count() as i32;
    }
    out
}

fn scalars<'a>(lines: &[&'a str]) -> Scalars<'a> {
    lines
        .iter()
        .filter_map(|l| {
            let (k, v) = l.split_once(" = ")?;
            let v = v.trim_end_matches(',').trim().trim_matches('"');
            (!v.starts_with('{') && k.chars().all(|c| c.is_ascii_alphanumeric())).then_some((k, v))
        })
        .collect()
}

fn num(s: &Scalars, key: &str) -> Option<f64> {
    s.get(key)?.parse().ok()
}

fn as_shot_wb(s: &Scalars) -> Option<(f64, f64)> {
    (s.get("WhiteBalance") == Some(&"As Shot"))
        .then(|| Some((num(s, "Temperature")?, num(s, "Tint")?)))
        .flatten()
}

fn develop_to_adjustments(
    lines: &[&str],
    s: &Scalars,
    as_shot: Option<(f64, f64)>,
) -> Result<Map<String, Value>, String> {
    let mut lua = String::new();
    for l in lines {
        let key = l.split(" = ").next().unwrap_or("");
        // Temperature/Tint are absolute in Lightroom; they are re-added below relative to as-shot.
        // Sharpness 40 and color NR 25 are Lightroom's raw defaults, not edits.
        let skip = matches!(key, "Temperature" | "Tint")
            || (key == "Sharpness" && s.get(key) == Some(&"40"))
            || (key == "ColorNoiseReduction" && s.get(key) == Some(&"25"));
        if !skip {
            lua += l.trim_end_matches(',');
            lua += ",\n";
        }
    }
    if let (Some((t, tint)), Some(temp), Some(cur_tint)) =
        (as_shot, num(s, "Temperature"), num(s, "Tint"))
    {
        lua += &format!(
            "Temperature = {temp},\nAsShotTemperature = {t},\nTint = {},\n",
            cur_tint - tint
        );
    }

    let preset = convert_xmp_to_preset(&lrtemplate_to_xmp(&lua))?;
    let Value::Object(mut adj) = preset.adjustments else {
        return Ok(Map::new());
    };
    // The frontend only merges one level deep, so partial color entries need all fields.
    for group in ["hsl", "colorGrading"] {
        if let Some(Value::Object(g)) = adj.get_mut(group) {
            for v in g.values_mut() {
                if let Value::Object(o) = v {
                    for k in ["hue", "saturation", "luminance"] {
                        o.entry(k).or_insert(json!(0));
                    }
                }
            }
        }
    }
    Ok(adj)
}

/// Lightroom stores the crop as sensor-frame fractions: the diagonal corners of a rectangle
/// rotated by CropAngle. RapidRAW rotates the oriented image about its center, then crops in pixels.
fn apply_geometry(adj: &mut Map<String, Value>, s: &Scalars, row: &Row) {
    let steps = (row.lr_steps + 4 - row.exif_steps) % 4;
    if steps != 0 {
        adj.insert("orientationSteps".into(), json!(steps));
    }

    let l = num(s, "CropLeft").unwrap_or(0.0);
    let t = num(s, "CropTop").unwrap_or(0.0);
    let r = num(s, "CropRight").unwrap_or(1.0);
    let b = num(s, "CropBottom").unwrap_or(1.0);
    let angle = num(s, "CropAngle").unwrap_or(0.0);
    if (l, t, r, b) == (0.0, 0.0, 1.0, 1.0) && angle == 0.0 {
        return;
    }

    let (sin, cos) = angle.to_radians().sin_cos();
    let (dx, dy) = ((r - l) * row.width, (b - t) * row.height);
    let (mut cw, mut ch) = (dx * cos + dy * sin, -dx * sin + dy * cos);
    let (mut cx, mut cy) = ((l + r) / 2.0 * row.width, (t + b) / 2.0 * row.height);
    let (mut w, mut h) = (row.width, row.height);
    for _ in 0..row.lr_steps {
        (cx, cy) = (h - cy, cx);
        (w, h) = (h, w);
        (cw, ch) = (ch, cw);
    }

    let (ex, ey) = (cx - w / 2.0, cy - h / 2.0);
    let (cx, cy) = (w / 2.0 + ex * cos + ey * sin, h / 2.0 - ex * sin + ey * cos);
    let x = (cx - cw / 2.0).round().max(0.0);
    let y = (cy - ch / 2.0).round().max(0.0);
    adj.insert(
        "crop".into(),
        json!({
            "unit": "px",
            "x": x,
            "y": y,
            "width": cw.round().min(w - x),
            "height": ch.round().min(h - y),
        }),
    );
    if angle != 0.0 {
        adj.insert("rotation".into(), json!(-angle));
    }
    if s.get("CropConstrainAspectRatio") == Some(&"true") {
        adj.insert("aspectRatio".into(), json!(cw / ch));
    }
}

fn lr_steps(orientation: &str) -> u8 {
    match orientation {
        "BC" => 1,
        "CD" => 2,
        "DA" => 3,
        _ => 0,
    }
}

fn exif_steps(xmp: &str) -> u8 {
    match xmp
        .split("tiff:Orientation=\"")
        .nth(1)
        .and_then(|v| v.chars().next())
    {
        Some('6') => 1,
        Some('3') => 2,
        Some('8') => 3,
        _ => 0,
    }
}

fn history_as_shot(conn: &Connection, image: i64) -> Option<(f64, f64)> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT text FROM Adobe_libraryImageDevelopHistoryStep WHERE image = ? ORDER BY dateCreated",
        )
        .ok()?;
    let mut rows = stmt.query([image]).ok()?;
    while let Ok(Some(row)) = rows.next() {
        let text = decode_text(row.get_ref(0).ok()?.as_bytes_or_null().ok()??);
        if let Some(wb) = as_shot_wb(&scalars(&top_level_lines(&text))) {
            return Some(wb);
        }
    }
    None
}

fn median(v: &mut [f64]) -> Option<f64> {
    v.sort_by(f64::total_cmp);
    v.get(v.len() / 2).copied()
}

fn virtual_path(row: &Row) -> String {
    match row.master {
        Some(_) => format!("{}?vc={:06x}", row.path, row.id % 0x100_0000),
        None => row.path.clone(),
    }
}

fn read_rows(conn: &Connection) -> rusqlite::Result<Vec<Row>> {
    let mut stmt = conn.prepare(
        "SELECT i.id_local, i.masterImage, i.rating, i.orientation, fo.id_local,
                rf.absolutePath || fo.pathFromRoot || f.baseName || '.' || f.extension,
                d.text, d.fileWidth, d.fileHeight, m.xmp
         FROM Adobe_images i
         JOIN AgLibraryFile f ON f.id_local = i.rootFile
         JOIN AgLibraryFolder fo ON fo.id_local = f.folder
         JOIN AgLibraryRootFolder rf ON rf.id_local = fo.rootFolder
         JOIN Adobe_imageDevelopSettings d ON d.image = i.id_local
         LEFT JOIN Adobe_AdditionalMetadata m ON m.image = i.id_local
         WHERE d.text IS NOT NULL AND d.text <> ''",
    )?;
    let bytes = |r: &rusqlite::Row, i| -> rusqlite::Result<String> {
        Ok(r.get_ref(i)?
            .as_bytes_or_null()?
            .map(decode_text)
            .unwrap_or_default())
    };
    stmt.query_map([], |r| {
        Ok(Row {
            id: r.get(0)?,
            master: r.get(1)?,
            rating: r.get::<_, Option<f64>>(2)?.unwrap_or(0.0) as u8,
            lr_steps: lr_steps(&r.get::<_, Option<String>>(3)?.unwrap_or_default()),
            folder: r.get(4)?,
            path: r.get(5)?,
            text: bytes(r, 6)?,
            width: r.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
            height: r.get::<_, Option<f64>>(8)?.unwrap_or(0.0),
            exif_steps: exif_steps(&bytes(r, 9)?),
        })
    })?
    .collect()
}

fn import_catalog(catalog_path: &str, app_handle: &AppHandle) -> Result<LrImportSummary, String> {
    // immutable=1 reads the catalog even while Lightroom holds its lock.
    let uri = format!(
        "file:{}?immutable=1",
        catalog_path
            .replace('%', "%25")
            .replace(' ', "%20")
            .replace('?', "%3f")
            .replace('#', "%23")
    );
    let conn = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("Could not open catalog: {e}"))?;
    let rows = read_rows(&conn).map_err(|e| format!("Could not read catalog: {e}"))?;
    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let mut folder_wb: HashMap<i64, (Vec<f64>, Vec<f64>)> = HashMap::new();
    for row in &rows {
        if let Some((t, tint)) = as_shot_wb(&scalars(&top_level_lines(&row.text))) {
            let e = folder_wb.entry(row.folder).or_default();
            e.0.push(t);
            e.1.push(tint);
        }
    }

    let mut summary = LrImportSummary::default();
    let mut paths_by_id: HashMap<i64, String> = HashMap::new();
    for row in &rows {
        if !Path::new(&row.path).exists() {
            summary.missing_files += 1;
            continue;
        }
        let path = virtual_path(row);
        paths_by_id.insert(row.id, path.clone());

        let (_, sidecar) = crate::file_management::parse_virtual_path(&path);
        let is_raw = is_raw_file(&row.path);
        if sidecar.exists() {
            let existing = crate::exif_processing::load_sidecar(&sidecar);
            let tm = resolve_tonemapper_override(&settings, is_raw);
            if is_image_edited(&existing.adjustments, is_raw, tm) {
                summary.skipped_edited += 1;
                continue;
            }
        }

        let lines = top_level_lines(&row.text);
        let s = scalars(&lines);
        let as_shot = match s.get("WhiteBalance") {
            Some(&"As Shot") | None => None,
            _ => history_as_shot(&conn, row.id)
                .or_else(|| history_as_shot(&conn, row.master?))
                .or_else(|| {
                    let (temps, tints) = folder_wb.get_mut(&row.folder)?;
                    summary.estimated_white_balance += 1;
                    Some((median(temps)?, median(tints)?))
                }),
        };

        let mut adj = develop_to_adjustments(&lines, &s, as_shot)?;
        apply_geometry(&mut adj, &s, row);

        let metadata = ImageMetadata {
            rating: row.rating,
            adjustments: Value::Object(adj),
            ..Default::default()
        };
        let json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
        std::fs::write(&sidecar, json).map_err(|e| format!("{}: {e}", sidecar.display()))?;
        summary.imported += 1;
    }

    let mut stmt = conn
        .prepare(
            "SELECT c.name, ci.image FROM AgLibraryCollection c
             JOIN AgLibraryCollectionImage ci ON ci.collection = c.id_local
             WHERE c.creationId = 'com.adobe.ag.library.collection'
             ORDER BY c.id_local, ci.positionInCollection",
        )
        .map_err(|e| e.to_string())?;
    let mut collections: Vec<(String, Vec<String>)> = Vec::new();
    let members = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    for (name, image) in members.filter_map(Result::ok) {
        let Some(path) = paths_by_id.get(&image) else {
            continue;
        };
        let name = if name == "quick collection" {
            "Quick Collection".into()
        } else {
            name
        };
        match collections.last_mut() {
            Some((n, paths)) if *n == name => paths.push(path.clone()),
            _ => collections.push((name, vec![path.clone()])),
        }
    }

    if !collections.is_empty() {
        let mut tree = get_albums(app_handle.clone())?;
        for (name, paths) in collections {
            let existing = tree.iter_mut().find_map(|item| match item {
                AlbumItem::Album {
                    name: n, images, ..
                } if *n == name => Some(images),
                _ => None,
            });
            match existing {
                Some(images) => {
                    for p in paths {
                        if !images.contains(&p) {
                            images.push(p);
                        }
                    }
                }
                None => tree.push(AlbumItem::Album {
                    id: Uuid::new_v4().to_string(),
                    name,
                    icon: None,
                    images: paths,
                }),
            }
            summary.albums += 1;
        }
        save_albums(tree, app_handle.clone())?;
    }

    Ok(summary)
}

#[tauri::command]
pub async fn import_lightroom_catalog(
    catalog_path: String,
    app_handle: AppHandle,
) -> Result<LrImportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || import_catalog(&catalog_path, &app_handle))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed from a real catalog row (image 22478): DA orientation, angled 16:9 crop.
    const DEVELOP: &str = r#"s = { AutoLateralCA = 1,
CropAngle = -0.83,
CropBottom = 0.800236,
CropConstrainAspectRatio = true,
CropLeft = 0.039968,
CropRight = 0.861633,
CropTop = 0.204714,
Look = { Amount = 1,
Parameters = { ToneCurvePV2012 = { 0,
20,
255,
255 } } },
Sharpness = 40,
ToneCurvePV2012 = { 0,
0,
255,
255 },
Whites2012 = -10 }"#;

    #[test]
    fn catalog_row_maps_crop_and_skips_nested_tables() {
        let lines = top_level_lines(DEVELOP);
        let s = scalars(&lines);
        assert!(
            !lines
                .iter()
                .any(|l| l.contains("Look") || l.contains("20,"))
        );
        assert_eq!(s.get("Whites2012"), Some(&"-10"));

        let row = Row {
            id: 1,
            master: None,
            folder: 1,
            path: String::new(),
            rating: 0,
            lr_steps: 3,
            exif_steps: 3,
            text: String::new(),
            width: 4000.0,
            height: 3000.0,
        };
        let mut adj = develop_to_adjustments(&lines, &s, None).unwrap();
        apply_geometry(&mut adj, &s, &row);

        // Lightroom reports this crop as 3260x1834 before orientation; DA turns it portrait.
        let crop = &adj["crop"];
        assert_eq!(
            (crop["width"].as_f64(), crop["height"].as_f64()),
            (Some(1834.0), Some(3260.0))
        );
        assert_eq!(adj["rotation"], json!(0.83));
        assert!(adj.get("orientationSteps").is_none());
        assert!(adj.get("sharpness").is_none());
        assert_eq!(
            adj["curves"]["luma"],
            json!([{"x": 0, "y": 0}, {"x": 255, "y": 255}])
        );
    }
}
