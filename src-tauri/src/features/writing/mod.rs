//! Writing-project sync. History snapshots stay in app data on the frontend.

pub mod sync;

use std::path::Path;

/// The declared main file may be nested; TeX resolves inputs from the project root.
pub(crate) fn project_directory_for_main<'a>(vault: &Path, main: &'a Path) -> Option<&'a Path> {
    let shelf = vault.join("thesis");
    main.strip_prefix(&shelf).ok()?;
    let mut project = None;
    for directory in main.ancestors().skip(1).take_while(|dir| *dir != shelf) {
        let marker = directory.join("agentero.project.json");
        let Ok(metadata) = marker.symlink_metadata() else {
            continue;
        };
        if !metadata.is_file() || project.is_some() {
            return None;
        }
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(marker).ok()?).ok()?;
        if config["schemaVersion"] != 1
            || config["mainFile"].as_str()?
                != main
                    .strip_prefix(directory)
                    .ok()?
                    .to_str()?
                    .replace('\\', "/")
        {
            return None;
        }
        project = Some(directory);
    }
    project
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_declared_root_for_a_nested_main() {
        let vault = tempfile::tempdir().unwrap();
        let project = vault.path().join("thesis/2026/投稿/Paper");
        let src = project.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            project.join("agentero.project.json"),
            r#"{"schemaVersion":1,"mainFile":"src/paper.tex"}"#,
        )
        .unwrap();
        let main = src.join("paper.tex");
        assert_eq!(
            project_directory_for_main(vault.path(), &main),
            Some(project.as_path())
        );
        assert_eq!(
            project_directory_for_main(vault.path(), &src.join("chapter.tex")),
            None
        );
    }
}
