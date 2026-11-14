use crate::decode::formats::{is_raw_file, is_supported_image_file};
use crate::metadata::exif_processing;
use chrono::{DateTime, Utc};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use sysinfo::Disks;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

/// Polls mounted disks and emits `removable-volume-mounted` with the mount path when a
/// removable disk (or any disk with a DCIM folder) appears while the app is running.
// ponytail: 3s polling, swap for OS mount notifications (DiskArbitration/udev/WM_DEVICECHANGE) if latency matters
#[cfg(not(target_os = "android"))]
pub fn start_removable_volume_watcher(app_handle: AppHandle) {
    let mount_points = || -> Vec<(PathBuf, bool)> {
        Disks::new_with_refreshed_list()
            .list()
            .iter()
            .map(|d| (d.mount_point().to_path_buf(), d.is_removable()))
            .collect()
    };

    thread::spawn(move || {
        let mut known: HashSet<PathBuf> = mount_points().into_iter().map(|(p, _)| p).collect();
        loop {
            thread::sleep(std::time::Duration::from_secs(3));
            let current = mount_points();
            for (path, removable) in &current {
                if !known.contains(path) && (*removable || path.join("DCIM").is_dir()) {
                    let _ = app_handle.emit("removable-volume-mounted", path.to_string_lossy());
                }
            }
            known = current.into_iter().map(|(p, _)| p).collect();
        }
    });
}

/// Lists supported images in an import source: everything under DCIM if present, otherwise up to 4 levels deep.
#[tauri::command]
pub async fn scan_import_source(folder: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&folder);
        let dcim = root.join("DCIM");
        let (scan_root, max_depth) = if dcim.is_dir() {
            (dcim, usize::MAX)
        } else {
            (root, 4)
        };
        list_supported_images(&scan_root, max_depth)
            .into_iter()
            .map(|(p, _)| p.to_string_lossy().into_owned())
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

fn list_supported_images(root: &Path, max_depth: usize) -> Vec<(PathBuf, fs::Metadata)> {
    WalkDir::new(root)
        .max_depth(max_depth)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_supported_image_file(e.path()))
        .filter_map(|e| Some((e.path().to_path_buf(), e.metadata().ok()?)))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub path: String,
    pub size: u64,
    /// Local modified time as `YYYY-MM-DDTHH:MM:SS`; cameras write the capture time here.
    /// `read_import_previews` returns the EXIF capture time that `import_files` uses.
    pub captured: String,
    pub duplicate: bool,
}

fn modified_secs(meta: &fs::Metadata) -> Option<u64> {
    Some(
        meta.modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs(),
    )
}

fn format_local(date: DateTime<Utc>) -> String {
    date.with_timezone(&chrono::Local)
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string()
}

/// Returns metadata for each source file using only filesystem metadata, flagging ones already present
/// anywhere under the destination. A duplicate matches a destination file on name + size or size + modified time
/// (copies keep the camera-set modified time).
// ponytail: only checks the destination tree, not every library root
#[tauri::command]
pub async fn get_import_candidates(
    source_paths: Vec<String>,
    destination_folder: String,
) -> Result<Vec<ImportCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut by_name_size = HashSet::new();
        let mut by_size_mtime = HashSet::new();
        for (path, meta) in list_supported_images(Path::new(&destination_folder), usize::MAX) {
            by_name_size.insert((path.file_name().map(|n| n.to_os_string()), meta.len()));
            if let Some(secs) = modified_secs(&meta) {
                by_size_mtime.insert((meta.len(), secs));
            }
        }

        let mut candidates: Vec<ImportCandidate> = source_paths
            .into_par_iter()
            .filter_map(|path_str| {
                let path = Path::new(&path_str);
                let meta = fs::metadata(path).ok()?;
                let size = meta.len();
                let secs = modified_secs(&meta);
                let duplicate = by_name_size
                    .contains(&(path.file_name().map(|n| n.to_os_string()), size))
                    || secs.is_some_and(|s| by_size_mtime.contains(&(size, s)));
                let captured = format_local(meta.modified().ok()?.into());
                Some(ImportCandidate {
                    path: path_str,
                    size,
                    captured,
                    duplicate,
                })
            })
            .collect();
        candidates.sort_by(|a, b| (&a.captured, &a.path).cmp(&(&b.captured, &b.path)));
        candidates
    })
    .await
    .map_err(|e| e.to_string())
}

/// Reports which folders (relative to `base`) already exist, so the import preview can mark new ones.
#[tauri::command]
pub fn check_import_folders(base: String, relative: Vec<String>) -> Vec<bool> {
    let base = PathBuf::from(base);
    relative.iter().map(|r| base.join(r).is_dir()).collect()
}

const RAW_SIBLING_EXTENSIONS: [&str; 6] = ["JPG", "jpg", "JPEG", "jpeg", "HEIC", "heic"];

/// Capture date used for import date folders: the file's own EXIF, else the EXIF of a same-named JPEG/HEIC next to a
/// raw, else the modified time.
// ponytail: skips rawler's metadata parse (~300ms per RW2 on an SD card); for raws with no readable EXIF and no JPEG
// sibling the modified time stands in, which cameras set to the capture time.
pub fn import_capture_date(path: &Path) -> DateTime<Utc> {
    if let Some(date) = exif_processing::try_get_exif_creation_date_fast(path) {
        return date;
    }
    if is_raw_file(path)
        && let Some(date) = RAW_SIBLING_EXTENSIONS
            .iter()
            .map(|ext| path.with_extension(ext))
            .find(|sibling| sibling.is_file())
            .and_then(|sibling| exif_processing::try_get_exif_creation_date_fast(&sibling))
    {
        return date;
    }
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(DateTime::<Utc>::from)
        .unwrap_or_else(|_| Utc::now())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub path: String,
    /// Local capture time as `YYYY-MM-DDTHH:MM:SS`, matching the date folder `import_files` creates.
    pub captured: String,
    /// The EXIF thumbnail as a `data:` URL, when the file embeds one.
    pub thumbnail: Option<String>,
    /// EXIF orientation (1 = upright); the thumbnail is stored unrotated.
    pub orientation: u32,
    /// Unrotated width / height of the full image; EXIF thumbnails pad other ratios with bars to 4:3.
    pub aspect: f32,
}

/// Reads capture dates and embedded EXIF thumbnails. Only the EXIF block at the start of each file is read.
// ponytail: RW2/CR3-only files have no EXIF thumbnail here; decode their embedded preview if raw-only cards matter
#[tauri::command]
pub async fn read_import_previews(paths: Vec<String>) -> Result<Vec<ImportPreview>, String> {
    use base64::Engine;
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_par_iter()
            .map(|path_str| {
                let path = Path::new(&path_str);
                let exif_obj = fs::File::open(path).ok().and_then(|file| {
                    exif::Reader::new()
                        .read_from_container(&mut std::io::BufReader::new(&file))
                        .ok()
                });
                let thumbnail = exif_obj.as_ref().and_then(|e| {
                    let offset = e
                        .get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?
                        .value
                        .get_uint(0)? as usize;
                    let len = e
                        .get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?
                        .value
                        .get_uint(0)? as usize;
                    let bytes = e.buf().get(offset..offset + len)?;
                    Some(format!(
                        "data:image/jpeg;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(bytes)
                    ))
                });
                let date = exif_obj
                    .as_ref()
                    .and_then(exif_processing::creation_date_from_exif)
                    .unwrap_or_else(|| import_capture_date(path));
                let orientation = exif_obj
                    .as_ref()
                    .and_then(|e| e.get_field(exif::Tag::Orientation, exif::In::PRIMARY))
                    .and_then(|f| f.value.get_uint(0))
                    .unwrap_or(1);
                let dimension = |tag| {
                    exif_obj
                        .as_ref()?
                        .get_field(tag, exif::In::PRIMARY)?
                        .value
                        .get_uint(0)
                        .filter(|&v| v > 0)
                };
                let aspect = match (
                    dimension(exif::Tag::PixelXDimension),
                    dimension(exif::Tag::PixelYDimension),
                ) {
                    (Some(w), Some(h)) => w as f32 / h as f32,
                    _ => 4.0 / 3.0,
                };
                ImportPreview {
                    path: path_str,
                    captured: format_local(date),
                    thumbnail,
                    orientation,
                    aspect,
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use uuid::Uuid;

    #[test]
    fn import_candidates_flag_files_already_in_destination() {
        let root = std::env::temp_dir().join(format!("rr-import-dupes-{}", Uuid::new_v4()));
        let (source, dest) = (root.join("card"), root.join("library/2026/09-27"));
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(source.join("DSC_0001.jpg"), b"same-bytes").unwrap();
        fs::write(source.join("DSC_0002.jpg"), b"new photo").unwrap();
        fs::write(dest.join("DSC_0001.jpg"), b"same-bytes").unwrap();
        fs::write(dest.join("DSC_0002.jpg"), b"different size").unwrap();

        let sources = ["DSC_0001.jpg", "DSC_0002.jpg"]
            .map(|n| source.join(n).to_string_lossy().into_owned())
            .to_vec();
        let candidates = tauri::async_runtime::block_on(get_import_candidates(
            sources,
            root.join("library").to_string_lossy().into_owned(),
        ))
        .unwrap();
        let dupes: HashMap<_, _> = candidates
            .iter()
            .map(|c| {
                (
                    Path::new(&c.path).file_name().unwrap().to_owned(),
                    c.duplicate,
                )
            })
            .collect();

        assert!(dupes[std::ffi::OsStr::new("DSC_0001.jpg")]);
        assert!(!dupes[std::ffi::OsStr::new("DSC_0002.jpg")]);
        fs::remove_dir_all(root).unwrap();
    }
}
