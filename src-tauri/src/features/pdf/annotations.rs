use std::{fs, io::ErrorKind, path::Path, sync::Mutex};

use crate::core::blocking::run_blocking;
use crate::core::error::{ApiResult, AppError};

static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn write_if_current(paper: &Path, expected: Option<&str>, data: &str) -> Result<bool, AppError> {
    let _lock = WRITE_LOCK
        .lock()
        .map_err(|_| AppError::message("PDF annotation writer is unavailable"))?;
    let legacy = paper.join("annotations.json");
    let marks = paper.join("marks");
    if marks
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
    {
        return Err(AppError::message(
            "PDF annotations directory must not be a symbolic link",
        ));
    }
    let path = marks.join("annotations.json");
    let read = |path: &Path| match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    };
    let current = match read(&path)? {
        Some(current) => Some(current),
        None => read(&legacy)?,
    };
    if current.as_deref() != expected {
        return Ok(false);
    }
    fs::create_dir_all(marks)?;
    agentero_core::fs::atomic_write(&path, data.as_bytes())?;
    let _ = fs::remove_file(legacy);
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub async fn pdf_save_annotations(
    vault_path: String,
    path: String,
    expected: Option<String>,
    data: String,
) -> ApiResult<bool> {
    run_blocking(move || {
        let result = (|| {
            let vault = agentero_core::fs::resolve_vault(&vault_path)?.canonicalize()?;
            let (paper, _) = agentero_core::fs::resolve_paper_dir(&vault, &path)?;
            let paper = paper.canonicalize()?;
            if !paper.starts_with(&vault) || paper == vault {
                return Err(AppError::message(
                    "PDF annotations must stay inside the vault",
                ));
            }
            if !serde_json::from_str::<serde_json::Value>(&data)?.is_array() {
                return Err(AppError::message("Invalid PDF annotations file"));
            }
            write_if_current(&paper, expected.as_deref(), &data)
        })();
        match result {
            Ok(saved) => ApiResult::ok(saved),
            Err(error) => ApiResult::err(error),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotation_save_rejects_stale_snapshots_and_keeps_legacy_until_migration() {
        let paper = tempfile::tempdir().unwrap();
        let legacy = paper.path().join("annotations.json");
        fs::write(&legacy, "[]").unwrap();
        assert!(!write_if_current(paper.path(), None, "[]").unwrap());
        assert!(legacy.exists());
        let edited = r#"[{"annotation":{"id":"a","contents":"local edit"}}]"#;
        assert!(write_if_current(paper.path(), Some("[]"), edited).unwrap());
        assert!(!legacy.exists());
        assert!(!write_if_current(paper.path(), Some("[]"), "[]").unwrap());
        assert_eq!(
            fs::read_to_string(paper.path().join("marks/annotations.json")).unwrap(),
            edited
        );
    }
}
