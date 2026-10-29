#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::path::{Component, Path, PathBuf};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Deserialize)]
struct ExportFile {
    name: String,
    text: String,
}

// Only plain relative paths are accepted: no "..", no drive letters, no absolute paths.
fn safe_rel(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() { None } else { Some(out) }
}

// Returns the saved location, or an empty string if the user cancelled.
#[tauri::command]
async fn export_files(app: tauri::AppHandle, files: Vec<ExportFile>) -> Result<String, String> {
    if files.is_empty() {
        return Err("Nothing to export".into());
    }
    let mut rels = Vec::new();
    for f in &files {
        rels.push(safe_rel(&f.name).ok_or_else(|| format!("Invalid file name: {}", f.name))?);
    }

    if files.len() == 1 {
        let default = rels[0].file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let picked = app
            .dialog()
            .file()
            .set_file_name(&default)
            .add_filter("XML Schema", &["xsd"])
            .blocking_save_file();
        let Some(fp) = picked else { return Ok(String::new()) };
        let path = fp.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, files[0].text.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(path.to_string_lossy().to_string());
    }

    let picked = app.dialog().file().blocking_pick_folder();
    let Some(fp) = picked else { return Ok(String::new()) };
    let dir = fp.into_path().map_err(|e| e.to_string())?;
    let existing: Vec<String> = rels
        .iter()
        .filter(|r| dir.join(r).exists())
        .map(|r| r.to_string_lossy().to_string())
        .collect();
    if !existing.is_empty() {
        let ok = app
            .dialog()
            .message(format!("{} file(s) already exist in this folder and will be overwritten.", existing.len()))
            .title("Overwrite files?")
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show();
        if !ok {
            return Ok(String::new());
        }
    }
    for (f, r) in files.iter().zip(&rels) {
        let target = dir.join(r);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, f.text.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(dir.to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![export_files])
        .run(tauri::generate_context!())
        .expect("error while running Wagashi");
}
