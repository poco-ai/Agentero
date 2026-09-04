//! Build Zotero-style save targets from Vault `papers/` org folders.

use serde::Serialize;
use std::fs;
use std::path::Path;

/// One row in Connector collection picker (`getSelectedCollection.targets`).
#[derive(Debug, Clone, Serialize)]
pub struct SaveTarget {
    pub id: String,
    pub name: String,
    pub level: u32,
}

/// Resolve a Connector `target` id (`L1` or `Dpapers/…`) to vault-relative parent dir.
pub fn resolve_target_parent(target: &str) -> Option<String> {
    let t = target.trim();
    if t.is_empty() {
        return None;
    }
    if t == "L1" || t.eq_ignore_ascii_case("Lpapers") {
        return Some("papers".into());
    }
    if let Some(rest) = t.strip_prefix('D').or_else(|| t.strip_prefix('d')) {
        let path = rest.trim().trim_matches('/').replace('\\', "/");
        if path.is_empty() || path.contains("..") {
            return None;
        }
        if path == "papers" || path.starts_with("papers/") {
            return Some(path);
        }
    }
    None
}

/// List `papers/` + org subfolders (not paper units) for the save-location picker.
pub fn list_save_targets(vault: &Path) -> Vec<SaveTarget> {
    let mut out = vec![SaveTarget {
        id: "L1".into(),
        name: "papers".into(),
        level: 0,
    }];
    let papers_root = vault.join("papers");
    if !papers_root.is_dir() {
        return out;
    }
    walk_org_folders(&papers_root, "papers", 1, &mut out);
    out
}

fn walk_org_folders(dir: &Path, rel: &str, level: u32, out: &mut Vec<SaveTarget>) {
    if level > 12 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut dirs: Vec<(String, std::path::PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            Some((name, e.path()))
        })
        .collect();
    dirs.sort_by_key(|a| a.0.to_lowercase());

    for (name, path) in dirs {
        // Paper units (NOTES.md / catalog row markers) are not save destinations.
        if is_paper_unit(&path) {
            continue;
        }
        let child_rel = format!("{rel}/{name}");
        out.push(SaveTarget {
            id: format!("D{child_rel}"),
            name,
            level,
        });
        walk_org_folders(&path, &child_rel, level + 1, out);
    }
}

/// Heuristic: folder looks like a paper package, not an org folder.
fn is_paper_unit(dir: &Path) -> bool {
    if dir.join("NOTES.md").is_file() {
        return true;
    }
    if dir.join("metadata.json").is_file() {
        return true;
    }
    // `{id}.pdf` at paper root (Agentero layout)
    if let Some(stem) = dir.file_name().and_then(|s| s.to_str()) {
        if dir.join(format!("{stem}.pdf")).is_file() {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn resolve_l1_and_d_paths() {
        assert_eq!(resolve_target_parent("L1").as_deref(), Some("papers"));
        assert_eq!(
            resolve_target_parent("Dpapers/nlp").as_deref(),
            Some("papers/nlp")
        );
        assert_eq!(
            resolve_target_parent("Dpapers/nlp/pretrain").as_deref(),
            Some("papers/nlp/pretrain")
        );
        assert!(resolve_target_parent("D../etc").is_none());
    }

    #[test]
    fn list_skips_paper_units() {
        let tmp =
            std::env::temp_dir().join(format!("agentero-connector-targets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("papers/nlp")).unwrap();
        fs::create_dir_all(tmp.join("papers/nlp/1706.03762")).unwrap();
        fs::write(tmp.join("papers/nlp/1706.03762/NOTES.md"), "# t\n").unwrap();
        fs::create_dir_all(tmp.join("papers/cv")).unwrap();

        let targets = list_save_targets(&tmp);
        let ids: Vec<_> = targets.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"L1"));
        assert!(ids.contains(&"Dpapers/nlp"));
        assert!(ids.contains(&"Dpapers/cv"));
        assert!(!ids.iter().any(|id| id.contains("1706.03762")));

        let _ = fs::remove_dir_all(&tmp);
    }
}
