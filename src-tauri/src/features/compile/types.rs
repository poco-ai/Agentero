use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LatexTool {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub env: Option<BTreeMap<String, String>>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LatexRecipe {
    pub name: String,
    pub tools: Vec<LatexTool>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LatexBuildOptions {
    pub recipe: Option<LatexRecipe>,
    pub out_dir: Option<String>,
    pub aux_dir: Option<String>,
    pub jobname: Option<String>,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub clean: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LatexArtifacts {
    pub pdf_path: String,
    pub log_path: String,
    pub synctex_path: String,
    pub fls_path: String,
    pub out_dir: String,
    pub aux_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LatexDiagnostic {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub severity: String,
    pub message: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "compile:finished")]
pub struct LatexCompileResult {
    pub job_id: String,
    pub root_path: String,
    pub success: bool,
    pub pdf_path: String,
    pub log_path: String,
    pub synctex_path: String,
    pub dependencies: Vec<String>,
    pub diagnostics: Vec<LatexDiagnostic>,
}

/// Expand recipe placeholders once, preserving each argument as one argv item.
pub(super) fn expand(value: &str, root: &std::path::Path, artifacts: &LatexArtifacts) -> String {
    value
        .replace("%DOC%", &root.to_string_lossy())
        .replace(
            "%DOCFILE%",
            &root.file_name().unwrap_or_default().to_string_lossy(),
        )
        .replace(
            "%DIR%",
            &root
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .to_string_lossy(),
        )
        .replace("%OUTDIR%", &artifacts.out_dir)
        .replace("%AUXDIR%", &artifacts.aux_dir)
        .replace(
            "%JOBNAME%",
            &std::path::Path::new(&artifacts.pdf_path)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy(),
        )
}

pub(super) fn tool_directory(
    tool: &LatexTool,
    root: &std::path::Path,
    artifacts: &LatexArtifacts,
) -> std::path::PathBuf {
    let base = root.parent().unwrap_or(std::path::Path::new("."));
    let value = tool
        .cwd
        .as_deref()
        .map(|value| std::path::PathBuf::from(expand(value, root, artifacts)))
        .unwrap_or_else(|| base.to_path_buf());
    super::root::normalize_lexical(&if value.is_absolute() {
        value
    } else {
        base.join(value)
    })
}

/// Match both `-option=value` and `-option value`, including double dashes.
pub(super) fn tool_option<'a>(tool: &'a LatexTool, names: &[&str]) -> Option<&'a str> {
    let mut result = None;
    for (index, arg) in tool.args.iter().enumerate() {
        let (flag, value) = arg
            .split_once('=')
            .map(|(a, b)| (a, Some(b)))
            .unwrap_or((arg.as_str(), tool.args.get(index + 1).map(String::as_str)));
        if names.contains(&flag.trim_start_matches('-')) {
            result = value;
        }
    }
    result
}

pub(super) fn is_latexmk(command: &str) -> bool {
    compiler_kind(command) == Some(CompilerKind::Latexmk)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CompilerKind {
    Latexmk,
    Tex,
    Tectonic,
}

pub(super) fn compiler_kind(command: &str) -> Option<CompilerKind> {
    let name = command.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    match name {
        "latexmk" => Some(CompilerKind::Latexmk),
        "pdflatex" | "xelatex" | "lualatex" | "latex" | "pdftex" | "luatex" => {
            Some(CompilerKind::Tex)
        }
        "tectonic" => Some(CompilerKind::Tectonic),
        _ => None,
    }
}

pub fn artifacts(
    root: &std::path::Path,
    options: &LatexBuildOptions,
) -> Result<LatexArtifacts, String> {
    use std::path::{Path, PathBuf};
    let dir = root.parent().ok_or("cannot determine project directory")?;
    let resolve = |value: &str, base: &Path| {
        let p = PathBuf::from(value);
        super::root::normalize_lexical(&if p.is_absolute() { p } else { base.join(p) })
    };
    let default_name = root
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let mut out = options
        .out_dir
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .map(|v| resolve(&v.replace("%DIR%", &dir.to_string_lossy()), dir))
        .unwrap_or_else(|| dir.to_path_buf());
    let mut aux = options
        .aux_dir
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .map(|v| {
            resolve(
                &v.replace("%DIR%", &dir.to_string_lossy())
                    .replace("%OUTDIR%", &out.to_string_lossy()),
                dir,
            )
        })
        .unwrap_or_else(|| out.clone());
    let seed = LatexArtifacts {
        pdf_path: out
            .join(format!("{default_name}.pdf"))
            .to_string_lossy()
            .into_owned(),
        log_path: String::new(),
        synctex_path: String::new(),
        fls_path: String::new(),
        out_dir: out.to_string_lossy().into_owned(),
        aux_dir: aux.to_string_lossy().into_owned(),
    };
    let primary = options.recipe.as_ref().and_then(|recipe| {
        recipe
            .tools
            .iter()
            .rev()
            .find(|tool| compiler_kind(&tool.command).is_some())
            .or_else(|| {
                recipe.tools.iter().rev().find(|tool| {
                    tool_option(
                        tool,
                        &[
                            "outdir",
                            "output-directory",
                            "auxdir",
                            "aux-directory",
                            "jobname",
                        ],
                    )
                    .is_some()
                })
            })
    });
    if let Some(tool) = primary {
        let cwd = tool_directory(tool, root, &seed);
        if options.out_dir.as_deref().unwrap_or("").trim().is_empty() {
            out = tool_option(tool, &["outdir", "output-directory"])
                .map(|v| resolve(&expand(v, root, &seed), &cwd))
                .unwrap_or_else(|| cwd.clone());
        }
        if options.aux_dir.as_deref().unwrap_or("").trim().is_empty() {
            aux = tool_option(tool, &["auxdir", "aux-directory"])
                .map(|v| resolve(&expand(v, root, &seed), &cwd))
                .unwrap_or_else(|| out.clone());
        }
        if aux != out
            && matches!(
                compiler_kind(&tool.command),
                Some(CompilerKind::Tex | CompilerKind::Tectonic)
            )
            && tool_option(tool, &["auxdir", "aux-directory"]).is_none()
        {
            return Err("Separate auxiliary directories require a latexmk recipe".into());
        }
        if compiler_kind(&tool.command) == Some(CompilerKind::Tectonic)
            && options
                .jobname
                .as_deref()
                .is_some_and(|value| !value.is_empty())
        {
            return Err("A custom jobname requires a latexmk or TeX engine recipe".into());
        }
    }
    let name = options
        .jobname
        .as_deref()
        .filter(|v| !v.is_empty())
        .or_else(|| primary.and_then(|tool| tool_option(tool, &["jobname"])))
        .map(|v| expand(v, root, &seed))
        .unwrap_or_else(|| default_name.into());
    if name.contains(['/', '\\']) || name == "." || name == ".." || name.contains('\0') {
        return Err("jobname must be a file name without directory separators".into());
    }
    Ok(LatexArtifacts {
        pdf_path: out
            .join(format!("{name}.pdf"))
            .to_string_lossy()
            .into_owned(),
        log_path: aux
            .join(format!("{name}.agentero.log"))
            .to_string_lossy()
            .into_owned(),
        synctex_path: out
            .join(format!("{name}.synctex.gz"))
            .to_string_lossy()
            .into_owned(),
        fls_path: aux
            .join(format!("{name}.fls"))
            .to_string_lossy()
            .into_owned(),
        out_dir: out.to_string_lossy().into_owned(),
        aux_dir: aux.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn latex_build_artifacts(
    root_path: String,
    build: Option<LatexBuildOptions>,
) -> crate::core::error::ApiResult<LatexArtifacts> {
    match artifacts(std::path::Path::new(&root_path), &build.unwrap_or_default()) {
        Ok(value) => crate::core::error::ApiResult::ok(value),
        Err(message) => {
            crate::core::error::ApiResult::err(crate::core::error::AppError::message(message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn portable(value: &str) -> String {
        value.replace('\\', "/")
    }

    #[test]
    fn custom_artifacts_keep_output_and_aux_separate() {
        let options = LatexBuildOptions {
            out_dir: Some("build".into()),
            aux_dir: Some("aux".into()),
            jobname: Some("draft".into()),
            ..Default::default()
        };
        let paths = artifacts(std::path::Path::new("/project/main.tex"), &options).unwrap();
        assert_eq!(portable(&paths.pdf_path), "/project/build/draft.pdf");
        assert_eq!(portable(&paths.fls_path), "/project/aux/draft.fls");
        assert!(artifacts(
            std::path::Path::new("/project/main.tex"),
            &LatexBuildOptions {
                jobname: Some("../escape".into()),
                ..Default::default()
            }
        )
        .is_err());
    }
    #[test]
    fn compiler_output_wins_over_helpers_intermediate_directories() {
        let options = LatexBuildOptions {
            recipe: Some(LatexRecipe {
                name: "with helper".into(),
                tools: vec![
                    LatexTool {
                        command: "image-converter".into(),
                        args: vec!["-outdir=images".into()],
                        env: None,
                        cwd: None,
                    },
                    LatexTool {
                        command: "latexmk".into(),
                        args: vec!["-outdir=final".into()],
                        env: None,
                        cwd: None,
                    },
                ],
            }),
            ..Default::default()
        };
        assert_eq!(
            portable(
                &artifacts(std::path::Path::new("/project/main.tex"), &options)
                    .unwrap()
                    .pdf_path,
            ),
            "/project/final/main.pdf"
        );
    }
}
