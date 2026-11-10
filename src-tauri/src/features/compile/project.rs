use super::{
    diagnostics::read_fls,
    root,
    types::{artifacts, LatexBuildOptions},
};
use crate::core::{
    blocking::run_blocking,
    error::{ApiResult, AppError},
};
use serde::Serialize;
use std::{
    collections::{BTreeSet, VecDeque},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LatexProjectInfo {
    pub root_path: String,
    pub candidates: Vec<String>,
    pub tex_files: Vec<String>,
    pub bib_files: Vec<String>,
    pub dependencies: Vec<String>,
}

/// Small literal-argument scanner, intentionally excluding TeX expansion.
/// Escaped percent signs and comments are handled by the shared root parser.
fn command_arguments(content: &str, command: &str, count: usize) -> Vec<Vec<String>> {
    let needle = format!("\\{command}");
    let mut results = Vec::new();
    let mut remaining = content;
    while let Some(index) = remaining.find(&needle) {
        remaining = &remaining[index + needle.len()..];
        if remaining.starts_with(|c: char| c.is_ascii_alphabetic()) {
            continue;
        }
        let mut args = Vec::new();
        let mut rest = remaining.trim_start_matches('*').trim_start();
        if rest.starts_with('[') {
            if let Some(end) = rest.find(']') {
                rest = rest[end + 1..].trim_start();
            }
        }
        for _ in 0..count {
            let Some(after) = rest.strip_prefix('{') else {
                break;
            };
            let Some(end) = after.find('}') else { break };
            args.push(after[..end].trim().into());
            rest = after[end + 1..].trim_start();
        }
        if args.len() == count {
            results.push(args);
        }
    }
    results
}

pub(super) fn subfile_parent(tex: &Path, content: &str) -> Option<PathBuf> {
    let after = content.split_once("\\documentclass")?.1.trim_start();
    let after = after.strip_prefix('[')?;
    let (parent, after) = after.split_once(']')?;
    if !after.trim_start().starts_with("{subfiles}") {
        return None;
    }
    root::resolve_input(tex.parent()?, parent).map(|p| root::normalize_lexical(&p))
}

fn project_files(root_file: &Path, project_dir: &Path) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut tex = BTreeSet::new();
    let mut bib = BTreeSet::new();
    let mut queue = VecDeque::from([root_file.to_path_buf()]);
    while let Some(path) = queue.pop_front() {
        let path = root::normalize_lexical(&path);
        if tex.len() >= 5000 || !tex.insert(path.to_string_lossy().into_owned()) {
            continue;
        }
        let Some(content) = root::read_lossy(&path) else {
            continue;
        };
        let content = root::strip_comments(&content);
        let declaring = path.parent().unwrap_or(project_dir);
        for arg in root::parse_input_refs(&content) {
            if let Some(child) = root::resolve_input(project_dir, &arg)
                .or_else(|| root::resolve_input(declaring, &arg))
            {
                queue.push_back(child);
            }
        }
        for name in ["import", "subimport", "inputfrom", "includefrom"] {
            for args in command_arguments(&content, name, 2) {
                let base = if name == "subimport" {
                    declaring
                } else {
                    project_dir
                };
                if let Some(child) = root::resolve_input(&base.join(&args[0]), &args[1]) {
                    queue.push_back(child);
                }
            }
        }
        for name in ["bibliography", "addbibresource"] {
            for args in command_arguments(&content, name, 1) {
                for value in args[0].split(',') {
                    let value = value.trim();
                    let value = if Path::new(value).extension().is_some() {
                        value.to_string()
                    } else {
                        format!("{value}.bib")
                    };
                    let path = project_dir.join(&value);
                    let path = if path.is_file() {
                        path
                    } else {
                        declaring.join(value)
                    };
                    if path.is_file() {
                        bib.insert(
                            root::normalize_lexical(&path)
                                .to_string_lossy()
                                .into_owned(),
                        );
                    }
                }
            }
        }
    }
    (tex, bib)
}

#[tauri::command]
#[specta::specta]
pub async fn latex_project_inspect(
    tex_path: String,
    vault_path: String,
    root_path: Option<String>,
    build: Option<LatexBuildOptions>,
) -> ApiResult<LatexProjectInfo> {
    run_blocking(move || {
        let tex = PathBuf::from(&tex_path);
        let vault = PathBuf::from(&vault_path);
        let root_file = root_path.map(PathBuf::from).unwrap_or_else(|| {
            PathBuf::from(
                root::resolve_root(&tex, (!vault_path.is_empty()).then_some(vault.as_path()))
                    .root_path,
            )
        });
        if !root_file.is_file() {
            return ApiResult::err(AppError::message("LaTeX root file does not exist"));
        }
        let declared = crate::features::writing::project_directory_for_main(&vault, &root_file);
        let scan_dir = declared.unwrap_or_else(|| root_file.parent().unwrap_or(Path::new(".")));
        let (mut tex_files, mut bib_files) = project_files(&root_file, scan_dir);
        let mut candidates = BTreeSet::from([root_file.to_string_lossy().into_owned()]);
        let mut scanned = Vec::new();
        if declared.is_none() {
            root::collect_tex_files(scan_dir, 0, &mut scanned);
        }
        for path in scanned {
            if root::read_lossy(&path)
                .is_some_and(|text| root::has_indicator(&root::strip_comments(&text)))
            {
                let (files, _) = project_files(&path, path.parent().unwrap_or(scan_dir));
                if files.contains(&root::normalize_lexical(&tex).to_string_lossy().into_owned()) {
                    candidates.insert(path.to_string_lossy().into_owned());
                }
            }
        }
        let artifact = match artifacts(&root_file, &build.unwrap_or_default()) {
            Ok(v) => v,
            Err(e) => return ApiResult::err(AppError::message(e)),
        };
        let dependencies = read_fls(Path::new(&artifact.fls_path), scan_dir);
        for dependency in &dependencies {
            match Path::new(dependency).extension().and_then(|e| e.to_str()) {
                Some("tex") if Path::new(dependency).starts_with(scan_dir) => {
                    tex_files.insert(dependency.clone());
                }
                Some("bib") => {
                    bib_files.insert(dependency.clone());
                }
                _ => {}
            }
        }
        ApiResult::ok(LatexProjectInfo {
            root_path: root_file.to_string_lossy().into_owned(),
            candidates: candidates.into_iter().collect(),
            tex_files: tex_files.into_iter().collect(),
            bib_files: bib_files.into_iter().collect(),
            dependencies,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_walks_chapters_imports_and_multiple_bibliographies() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("chapters")).unwrap();
        std::fs::write(dir.path().join("main.tex"), "\\documentclass{article}\n\\input{chapters/one}\n\\import{chapters/}{two}\n\\bibliography{refs,other}").unwrap();
        for name in ["one.tex", "two.tex"] {
            std::fs::write(dir.path().join("chapters").join(name), "chapter").unwrap();
        }
        for name in ["refs.bib", "other.bib"] {
            std::fs::write(dir.path().join(name), "@article{key}").unwrap();
        }
        let (tex, bib) = project_files(&dir.path().join("main.tex"), dir.path());
        assert_eq!(tex.len(), 3);
        assert_eq!(bib.len(), 2);
    }
    #[test]
    fn finds_subfiles_declared_parent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("chapters")).unwrap();
        std::fs::write(dir.path().join("main.tex"), "main").unwrap();
        assert_eq!(
            subfile_parent(
                &dir.path().join("chapters/one.tex"),
                "\\documentclass[../main.tex]{subfiles}"
            ),
            Some(dir.path().join("main.tex"))
        );
    }
    #[tokio::test]
    async fn inspection_loads_dependencies_from_selected_output_and_jobname() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("main.tex");
        std::fs::write(&root, "\\documentclass{article}").unwrap();
        let aux = dir.path().join("cache");
        std::fs::create_dir(&aux).unwrap();
        std::fs::write(dir.path().join("figure.pdf"), "image").unwrap();
        std::fs::write(
            aux.join("draft.fls"),
            format!("PWD {}\nINPUT figure.pdf\n", dir.path().display()),
        )
        .unwrap();
        let result = latex_project_inspect(
            root.to_string_lossy().into_owned(),
            dir.path().to_string_lossy().into_owned(),
            None,
            Some(LatexBuildOptions {
                aux_dir: Some("cache".into()),
                jobname: Some("draft".into()),
                ..Default::default()
            }),
        )
        .await;
        assert!(result.ok);
        assert_eq!(
            result.data.unwrap().dependencies,
            vec![dir.path().join("figure.pdf").to_string_lossy().into_owned()]
        );
    }
}
