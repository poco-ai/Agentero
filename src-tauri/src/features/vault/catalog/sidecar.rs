//! Per-paper metadata sidecar: `{paper}/metadata.json`.
//!
//! Catalog SQLite stays the fast query surface, but every authoritative field
//! (tags, is_read, urls, …) is projected into this file so a catalog row can
//! be rebuilt from disk alone. This keeps the vault self-contained (backup /
//! sync tools only need plain files) and honors local-first.

use super::papers::PaperRecord;
use std::fs;
use std::path::Path;

pub const SIDECAR_FILE: &str = "metadata.json";

/// Project a catalog row into `{vault}/{record.path}/metadata.json`.
/// Best-effort: catalog write already succeeded; a failed projection only
/// logs (next upsert rewrites it).
pub fn write_sidecar(vault_root: &Path, record: &PaperRecord) {
    let dir = vault_root.join(&record.path);
    if !dir.is_dir() {
        return;
    }
    let write = || -> std::io::Result<()> {
        let raw = serde_json::to_vec_pretty(record)?;
        crate::core::fs::atomic_write(&dir.join(SIDECAR_FILE), &raw)
    };
    if let Err(e) = write() {
        log::warn!(
            target: "agentero::catalog",
            "failed to write sidecar for {}: {e}",
            record.path
        );
    }
}

/// Read `{vault}/{rel_path}/metadata.json` as a catalog row.
/// `path` always comes from the on-disk location (sidecars move with their
/// folder, so any embedded path may be stale). Tolerates the older
/// `PaperMeta`-shaped files written by the Connector.
pub fn read_sidecar(vault_root: &Path, rel_path: &str) -> Option<PaperRecord> {
    let raw = fs::read_to_string(vault_root.join(rel_path).join(SIDECAR_FILE)).ok()?;
    let mut record: PaperRecord = serde_json::from_str(&raw).ok()?;
    record.path = rel_path.to_string();
    Some(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn minimal_record(path: &str) -> PaperRecord {
        serde_json::from_value(serde_json::json!({
            "path": path,
            "id": "x",
            "type": "article",
            "title": "T",
            "authors": [],
            "status": "completed",
            "added_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-02T00:00:00Z",
        }))
        .expect("minimal record")
    }

    #[test]
    fn sidecar_roundtrip_overrides_stale_path() {
        let vault = std::env::temp_dir().join(format!("agentero-sidecar-{}", Uuid::new_v4()));
        fs::create_dir_all(vault.join("papers/x")).unwrap();
        let mut record = minimal_record("papers/x");
        record.is_read = true;
        write_sidecar(&vault, &record);

        // Simulate a folder move: read back from the new location.
        fs::create_dir_all(vault.join("papers/nlp")).unwrap();
        fs::rename(vault.join("papers/x"), vault.join("papers/nlp/x")).unwrap();
        let loaded = read_sidecar(&vault, "papers/nlp/x").expect("sidecar readable");
        assert_eq!(loaded.path, "papers/nlp/x");
        assert!(loaded.is_read);
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn read_sidecar_tolerates_connector_paper_meta_shape() {
        let vault = std::env::temp_dir().join(format!("agentero-sidecar-meta-{}", Uuid::new_v4()));
        fs::create_dir_all(vault.join("papers/y")).unwrap();
        // Connector-era metadata.json: no `path`, tags as bare strings.
        fs::write(
            vault.join("papers/y/metadata.json"),
            r#"{"id":"y","type":"article","title":"Old","authors":["A"],"tags":["nlp"],
                "status":"completed","added_at":"t","updated_at":"t"}"#,
        )
        .unwrap();
        let loaded = read_sidecar(&vault, "papers/y").expect("legacy sidecar readable");
        assert_eq!(loaded.path, "papers/y");
        assert_eq!(loaded.tags.len(), 1);
        assert_eq!(loaded.tags[0].name, "nlp");
        let _ = fs::remove_dir_all(&vault);
    }
}
