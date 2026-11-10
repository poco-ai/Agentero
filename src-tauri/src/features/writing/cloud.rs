use crate::core::error::{ApiResult, AppError};
use agentero_core::features::sync::{config, lock::SyncLock, writing_cloud_database};
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

fn open_database(path: &Path) -> Result<Connection, AppError> {
    let db = Connection::open(path)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    db.execute_batch(
        "PRAGMA synchronous = FULL;
         CREATE TABLE IF NOT EXISTS writing_checkout (
             project_id TEXT PRIMARY KEY,
             checkpoint TEXT NOT NULL
         );",
    )?;
    Ok(db)
}

fn cloud_state(
    vault_path: &str,
    project_id: &str,
    checkpoint: Option<String>,
) -> Result<Option<String>, AppError> {
    uuid::Uuid::parse_str(project_id).map_err(|_| AppError::message("invalid writing project"))?;
    let vault = crate::core::fs::resolve_vault(vault_path)?.canonicalize()?;
    let database = writing_cloud_database(&vault);
    if let Some(checkpoint) = checkpoint {
        if checkpoint.len() > 64 * 1024 * 1024 {
            return Err(AppError::message("writing checkpoint too large"));
        }
        let directory = database.parent().expect("writing database parent");
        if directory
            .symlink_metadata()
            .is_ok_and(|meta| meta.is_symlink())
        {
            return Err(AppError::message("invalid writing database path"));
        }
        let _lease = if !database.exists() || checkpoint.is_empty() {
            Some(
                SyncLock::try_acquire(&vault)?
                    .ok_or_else(|| AppError::message("another vault sync is running"))?,
            )
        } else {
            None
        };
        if config::get(vault_path.trim()).is_some() {
            return Err(AppError::domain(
                "writing_vault_sync_conflict",
                "Disconnect Vault Sync before enabling project collaboration.",
            ));
        }
        std::fs::create_dir_all(directory)?;
        if directory.symlink_metadata()?.is_symlink()
            || database
                .symlink_metadata()
                .is_ok_and(|meta| meta.is_symlink())
        {
            return Err(AppError::message("invalid writing database path"));
        }
        if checkpoint.is_empty() {
            if database.exists() {
                let db = open_database(&database)?;
                db.execute(
                    "DELETE FROM writing_checkout WHERE project_id=?1",
                    [project_id],
                )?;
                let remaining: usize =
                    db.query_row("SELECT count(*) FROM writing_checkout", [], |row| {
                        row.get(0)
                    })?;
                drop(db);
                if remaining == 0 {
                    std::fs::remove_file(database)?;
                }
            }
            return Ok(None);
        }
        open_database(&database)?.execute(
            "INSERT INTO writing_checkout(project_id,checkpoint) VALUES (?1,?2)
             ON CONFLICT(project_id) DO UPDATE SET checkpoint=excluded.checkpoint",
            rusqlite::params![project_id, checkpoint],
        )?;
        return Ok(None);
    }
    if !database.exists() {
        return Ok(None);
    }
    if database.symlink_metadata()?.is_symlink() {
        return Err(AppError::message("invalid writing database path"));
    }
    let db = Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(db
        .query_row(
            "SELECT checkpoint FROM writing_checkout WHERE project_id=?1",
            [project_id],
            |row| row.get(0),
        )
        .optional()?)
}

#[tauri::command]
#[specta::specta]
pub async fn writing_cloud_state(
    vault_path: String,
    project_id: String,
    checkpoint: Option<String>,
) -> ApiResult<Option<String>> {
    match tokio::task::spawn_blocking(move || cloud_state(&vault_path, &project_id, checkpoint))
        .await
    {
        Ok(Ok(value)) => ApiResult::ok(value),
        Ok(Err(error)) => ApiResult::err(error),
        Err(error) => ApiResult::err(AppError::message(error.to_string())),
    }
}

pub(super) fn check_project_git_write(path: &Path) -> Result<(), AppError> {
    // A shared checkout is marked by its portable ID, independent of where its
    // user chooses to place the project in the local classification tree.
    let Some(id) = std::fs::read(path.join("agentero.project.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|config| config["projectId"].as_str().map(str::to_owned))
    else {
        return Ok(());
    };
    for directory in path
        .ancestors()
        .skip(1)
        .filter(|entry| entry.file_name().and_then(|name| name.to_str()) == Some("thesis"))
    {
        if let Some(vault) = directory.parent() {
            if cloud_state(&vault.to_string_lossy(), &id, None)?.is_some() {
                return Err(AppError::domain(
                    "writing_project_shared",
                    "Git sync and Git restore are disabled for a shared writing project.",
                ));
            }
        }
    }
    Ok(())
}
