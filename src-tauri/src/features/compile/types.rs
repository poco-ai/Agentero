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

/// A path as handed to an external TeX tool. Windows `canonicalize()` returns
/// extended `\\?\D:\…` paths, which latexmk (Perl) treats as a glob and TeX
/// cannot parse, so tools get the plain drive form. UNC and other extended
/// paths are passed through unchanged.
pub(super) fn tool_path(path: &std::path::Path) -> std::path::PathBuf {
    crate::core::process::windows_shell_path(path)
}

/// [`LatexArtifacts`] as handed to external TeX tools (see [`tool_path`]).
pub(super) fn tool_artifacts(artifact: &LatexArtifacts) -> LatexArtifacts {
    let plain = |value: &str| {
        tool_path(std::path::Path::new(value))
            .to_string_lossy()
            .into_owned()
    };
    LatexArtifacts {
        pdf_path: plain(&artifact.pdf_path),
        log_path: plain(&artifact.log_path),
        synctex_path: plain(&artifact.synctex_path),
        fls_path: plain(&artifact.fls_path),
        out_dir: plain(&artifact.out_dir),
        aux_dir: plain(&artifact.aux_dir),
    }
}

/// A path a TeX tool reported, spelled the way the caller spelled `request`:
/// when the request used an extended `\\?\D:\…` path, plain drive paths get
/// the prefix back (backslashes, and the upper-case drive letter
/// `canonicalize()` produces; TeX Live prints `d:/…`). Anything else is
/// returned unchanged.
pub(super) fn caller_path(reported: &str, request: &std::path::Path) -> String {
    let bytes = reported.as_bytes();
    let drive_path = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    if !drive_path || !request.to_string_lossy().starts_with(r"\\?\") {
        return reported.to_string();
    }
    format!(
        r"\\?\{}{}",
        bytes[0].to_ascii_uppercase() as char,
        reported[1..].replace('/', "\\")
    )
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
    use std::path::{Path, PathBuf};

    #[test]
    fn tex_tools_get_plain_paths_and_reports_keep_the_callers_spelling() {
        // `canonicalize()` spelling of a Vault on Windows (#909).
        let root = Path::new(r"\\?\E:\vault\thesis\main.tex");
        assert_eq!(tool_path(root), PathBuf::from(r"E:\vault\thesis\main.tex"));
        let unc = Path::new(r"\\?\UNC\server\share\main.tex");
        assert_eq!(tool_path(unc), unc.to_path_buf());

        let dir = r"\\?\E:\vault\thesis";
        let artifact = LatexArtifacts {
            pdf_path: format!(r"{dir}\main.pdf"),
            log_path: format!(r"{dir}\main.log"),
            synctex_path: format!(r"{dir}\main.synctex.gz"),
            fls_path: format!(r"{dir}\main.fls"),
            out_dir: dir.into(),
            aux_dir: format!(r"{dir}\aux"),
        };
        let tool = tool_artifacts(&artifact);
        assert_eq!(tool.pdf_path, r"E:\vault\thesis\main.pdf");
        assert_eq!(tool.out_dir, r"E:\vault\thesis");
        assert_eq!(tool.aux_dir, r"E:\vault\thesis\aux");

        // TeX Live reports the plain path with a lower-case drive letter.
        assert_eq!(
            caller_path("e:/vault/thesis/chapters/intro.tex", root),
            r"\\?\E:\vault\thesis\chapters\intro.tex"
        );
        assert_eq!(
            caller_path(r"E:\vault\thesis\main.tex", root),
            r"\\?\E:\vault\thesis\main.tex"
        );
        for unchanged in [
            r"\\?\E:\vault\x.tex",
            "chapters/intro.tex",
            "/tex/article.cls",
        ] {
            assert_eq!(caller_path(unchanged, root), unchanged);
        }
        // Plain requests get plain reports, as before.
        assert_eq!(
            caller_path("e:/vault/x.tex", Path::new(r"E:\vault\main.tex")),
            "e:/vault/x.tex"
        );
        assert_eq!(
            caller_path("/project/x.tex", Path::new("/project/main.tex")),
            "/project/x.tex"
        );
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
        assert_eq!(paths.pdf_path, "/project/build/draft.pdf");
        assert_eq!(paths.fls_path, "/project/aux/draft.fls");
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
            artifacts(std::path::Path::new("/project/main.tex"), &options)
                .unwrap()
                .pdf_path,
            "/project/final/main.pdf"
        );
    }
}
