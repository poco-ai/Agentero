//! LaTeX compilation: engine detection plus the `LatexCompile` job runner
//! (latexmk orchestration with live log streaming, progress and cancel).

mod diagnostics;
pub mod project;
pub mod root;
mod runner;
pub mod tools;
pub mod types;
use runner::run_latexmk;

use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
#[cfg(not(windows))]
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
#[cfg(not(windows))]
use tokio::io::BufReader;

use crate::core::error::ApiResult;
use crate::core::error::AppError;
use crate::features::jobs::JobCenter;
use crate::features::jobs::JobKind;
use crate::features::jobs::RunOutcome;
use crate::features::jobs::StartedJob;

/// A detected LaTeX rendering engine.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LatexEngine {
    pub id: String,
    pub label: String,
    pub path: Option<String>,
}

/// Directories that ship TeX Live binaries on a default install. Searched in
/// addition to `$PATH` so engines like MacTeX (which install to
/// `/Library/TeX/texbin` but do NOT put that on user `$PATH` by default) still
/// surface to the picker.
fn tex_extra_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    // macOS — MacTeX default symlink (covers the active TeX Live year).
    out.push(PathBuf::from("/Library/TeX/texbin"));
    // macOS — older MacTeX releases expose a year-suffixed tree.
    if let Ok(entries) = std::fs::read_dir("/usr/local/texlive") {
        for entry in entries.flatten() {
            let bin = entry.path().join("bin").join("universal-darwin");
            if bin.is_dir() {
                out.push(bin);
            }
            let bin_arm = entry.path().join("bin").join("arm64-darwin");
            if bin_arm.is_dir() {
                out.push(bin_arm);
            }
            let bin_x86 = entry.path().join("bin").join("x86_64-darwin");
            if bin_x86.is_dir() {
                out.push(bin_x86);
            }
        }
    }
    // Linux / cross-platform fallbacks.
    out.push(PathBuf::from("/usr/bin"));
    out.push(PathBuf::from("/usr/local/bin"));
    // Common Homebrew locations on Apple Silicon / Intel.
    out.push(PathBuf::from("/opt/homebrew/bin"));
    out.push(PathBuf::from("/usr/local/bin"));
    out
}

/// Resolve `command` by combining `$PATH` with platform-specific TeX locations.
pub(crate) fn resolve_engine(command: &str) -> Option<PathBuf> {
    if let Ok(path) = which::which(command) {
        return Some(path);
    }
    for dir in tex_extra_paths() {
        let candidate = dir.join(command);
        #[cfg(windows)]
        let candidate = if candidate.extension().is_none() {
            candidate.with_extension("exe")
        } else {
            candidate
        };
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// The engine picker: latexmk orchestrates every engine (bibtex/biber and the
/// rerun loop run automatically), so the entries are the latexmk flags.
const LATEX_ENGINES: [(&str, &str); 3] = [
    ("pdflatex", "PDFLaTeX"),
    ("xelatex", "XeLaTeX"),
    ("lualatex", "LuaLaTeX"),
];

fn latexmk_engine_flag(engine: &str) -> Option<&'static str> {
    match engine {
        "pdflatex" => Some("-pdf"),
        "xelatex" => Some("-xelatex"),
        "lualatex" => Some("-lualatex"),
        _ => None,
    }
}

/// Detect available LaTeX engines on the system.
/// Returns the engines that can actually compile — latexmk (the orchestrator)
/// and the engine binary must both exist. Engines not present on the host are
/// omitted (not greyed out); without latexmk the list is empty and the compile
/// button stays hidden.
#[tauri::command]
#[specta::specta]
pub async fn detect_latex_engines() -> ApiResult<Vec<LatexEngine>> {
    // latexmk drives the whole build (engine, bibtex, reruns); without it
    // there is nothing to offer.
    let Some(latexmk) = resolve_engine("latexmk") else {
        return ApiResult::ok(Vec::new());
    };

    let engines = LATEX_ENGINES
        .iter()
        .filter(|(engine, _)| resolve_engine(engine).is_some())
        .map(|(engine, label)| LatexEngine {
            id: (*engine).to_string(),
            label: (*label).to_string(),
            path: Some(latexmk.to_string_lossy().to_string()),
        })
        .collect::<Vec<_>>();

    log::debug!("detected LaTeX engines: {:?}", engines);
    ApiResult::ok(engines)
}

/// Clean the regenerable LaTeX intermediates for one source (`latexmk -c`):
/// drops `.aux` / `.log` / `.fls` / `.fdb_latexmk` / … while keeping the PDF.
///
/// This is the escape hatch for latexmk's stuck state after a failed run:
/// its fingerprint database (`*.fdb_latexmk`) records the failure, and with
/// an unchanged source it then refuses to recompile — "Nothing to do …
/// pdflatex gave an error in previous invocation". Clearing the
/// intermediates resets that database so the next compile is a full run.
#[tauri::command]
#[specta::specta]
pub async fn clean_latex_aux_files(tex_path: String) -> ApiResult<()> {
    let tex_path = PathBuf::from(&tex_path);
    if !tex_path.is_file() {
        return ApiResult::err(AppError::message(format!(
            "tex file not found: {}",
            tex_path.display()
        )));
    }
    let Some(cwd) = tex_path.parent().map(Path::to_path_buf) else {
        return ApiResult::err(AppError::message("cannot determine parent directory"));
    };
    let Some(basename) = tex_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
    else {
        return ApiResult::err(AppError::message("invalid tex file name"));
    };
    // GUI apps inherit launchd's minimal PATH — resolve latexmk the same way
    // the compile runner does and spawn the absolute path.
    let Some(latexmk) = resolve_engine("latexmk") else {
        return ApiResult::err(AppError::message("latexmk not found on this system"));
    };

    log::info!(
        "cleaning latex aux files for {} in {}",
        basename,
        cwd.display()
    );

    let mut cmd = tokio::process::Command::new(&latexmk);
    // latexmk gets the plain form of a Windows `\\?\D:\…` path (see
    // `types::tool_path`).
    let tool_cwd = types::tool_path(&cwd);
    cmd.current_dir(&tool_cwd)
        .arg("-c")
        .arg(format!("-outdir={}", tool_cwd.to_string_lossy()))
        .arg(&basename)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    tools::prepare_command(&mut cmd, &latexmk);

    let output = match crate::core::process::command_output(&mut cmd).await {
        Ok(output) => output,
        Err(e) => return ApiResult::err(AppError::message(format!("failed to run latexmk: {e}"))),
    };
    if output.status.success() {
        return ApiResult::ok(());
    }
    // Prefer stderr for the failure message; latexmk -c reports its errors
    // there, falling back to whatever stdout captured.
    let mut tail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if tail.is_empty() {
        tail = String::from_utf8_lossy(&output.stdout).trim().to_string();
    }
    let tail = if tail.chars().count() > 2000 {
        format!(
            "…{}",
            tail.chars()
                .rev()
                .take(2000)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        )
    } else {
        tail
    };
    ApiResult::err(AppError::message(if tail.is_empty() {
        format!("latexmk clean exited with {}", output.status)
    } else {
        tail
    }))
}

/// One chktex finding, mapped to editor coordinates (1-based line/column plus
/// match length). `code` is chktex's warning number — suppress one inline with
/// a `%chktex <n>` comment on the offending line.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LatexLintDiagnostic {
    pub line: u32,
    pub column: u32,
    pub length: u32,
    /// Mapped chktex kind: "error" | "warning" | "info" (its "Message" level).
    pub severity: String,
    pub code: u32,
    pub message: String,
}

/// Parse chktex output produced with `-f"%l:%c:%d:%k:%n:%m\n"` (the format
/// string must carry a real newline — chktex does not interpret `\n`).
/// Unparseable lines (banner, summary, stray output) are skipped.
fn parse_chktex_output(stdout: &str) -> Vec<LatexLintDiagnostic> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(6, ':');
            let line_no = fields.next()?.parse::<u32>().ok()?;
            let column = fields.next()?.parse::<u32>().ok()?;
            let length = fields.next()?.parse::<u32>().ok()?;
            let severity = match fields.next()? {
                "Error" => "error",
                "Warning" => "warning",
                "Message" => "info",
                _ => return None,
            };
            let code = fields.next()?.parse::<u32>().ok()?;
            let message = fields.next()?.trim();
            if message.is_empty() {
                return None;
            }
            Some(LatexLintDiagnostic {
                line: line_no,
                column,
                length,
                severity: severity.to_string(),
                code,
                message: message.to_string(),
            })
        })
        .collect()
}

/// Lint the in-memory TeX buffer with chktex — the rule set Overleaf and VS
/// Code's LaTeX Workshop run. Content goes in via stdin (`-I0`), so findings
/// track the live editor buffer rather than the last autosaved snapshot, and
/// chktex does not follow `\input`s (every open file lints itself). Returns an
/// empty list when chktex is absent: linting degrades to the language pack's
/// built-in checks instead of erroring on every keystroke.
#[tauri::command]
#[specta::specta]
pub async fn chktex_lint(tex_path: String, content: String) -> ApiResult<Vec<LatexLintDiagnostic>> {
    let Some(chktex) = resolve_engine("chktex") else {
        return ApiResult::ok(Vec::new());
    };
    let mut cmd = tokio::process::Command::new(&chktex);
    cmd.args(["-q", "-I0", "-f%l:%c:%d:%k:%n:%m\n"])
        // cwd = the .tex parent so a project-local .chktexrc keeps working.
        .current_dir(types::tool_path(
            Path::new(&tex_path).parent().unwrap_or(Path::new(".")),
        ))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        // The version banner and the run summary go to stderr; drop them.
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    // Same GUI-PATH fix as latexmk: prepend chktex's own bin dir (TeX Live
    // keeps kpsewhich etc. next to it, which chktex uses to find its rc file).
    tools::prepare_command(&mut cmd, &chktex);

    let mut child = match crate::core::process::ProcessTree::spawn(&mut cmd) {
        Ok(child) => child,
        Err(e) => return ApiResult::err(AppError::message(format!("failed to run chktex: {e}"))),
    };
    // Feed the buffer and close stdin (EOF) from a side task so a large
    // document cannot deadlock against stdout being drained.
    if let Some(mut stdin) = child.stdin().take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(content.as_bytes()).await;
        });
    }
    // The exit status is meaningless for linting (2 merely means "warnings
    // found") — parsed stdout is the source of truth.
    let output =
        match tokio::time::timeout(std::time::Duration::from_secs(15), child.wait_with_output())
            .await
        {
            Err(_) => return ApiResult::err(AppError::message("chktex timed out")),
            Ok(Err(e)) => return ApiResult::err(AppError::message(format!("chktex failed: {e}"))),
            Ok(Ok(output)) => output,
        };

    ApiResult::ok(parse_chktex_output(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// `params` payload of a `LatexCompile` job.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatexCompileParams {
    tex_path: String,
    engine: String,
    #[serde(default)]
    build: Option<types::LatexBuildOptions>,
}

/// Register the `LatexCompile` runner with the JobCenter (app assembly).
pub fn register_job_runners(center: &JobCenter) {
    center.register_runner(JobKind::LatexCompile, Arc::new(latex_compile_runner));
}

/// Runner for [`JobKind::LatexCompile`]: run latexmk on the .tex source and
/// stream its output live. Milestone lines (rule / run-number banners) become
/// `job:changed` progress so the background-tasks row advances; every line is
/// also emitted on `compile:log` for a future log view.
fn latex_compile_runner(
    center: JobCenter,
    app: tauri::AppHandle,
    started: StartedJob,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    center.run_job(app, started, |center, app, started| async move {
        let params = started
            .snapshot
            .params
            .clone()
            .and_then(|value| serde_json::from_value::<LatexCompileParams>(value).ok());
        let Some(params) = params else {
            return RunOutcome::Failed(Some("latex compile job is missing its params".into()));
        };
        run_latexmk(&center, &app, &started, params).await
    })
}

/// Monotonic progress filter: milestones only surface when they move the bar
/// or rename the phase, so `job:changed` stays quiet on ordinary log lines.
#[derive(Default)]
struct CompileProgress {
    max: f32,
}

impl CompileProgress {
    fn advance(&mut self, progress: f32, phase: String) -> Option<(f32, String)> {
        if progress <= self.max {
            return None;
        }
        self.max = progress;
        Some((self.max, phase))
    }
}

/// Map a latexmk banner line to a (progress, phase) milestone, if it is one.
/// Engine runs advance 0.35 → 0.85; bibliography rules sit at 0.5; the
/// terminal 100 is set by `run_job` on success.
fn line_milestone(line: &str) -> Option<(f32, String)> {
    if let Some(rest) = line.strip_prefix("Run number ") {
        // "Run number 2 of rule 'pdflatex'"
        let mut parts = rest.splitn(2, " of rule '");
        let runs: u32 = parts.next()?.trim().parse().ok()?;
        let rule = parts.next()?.trim_end_matches('\'');
        let progress = (0.1 + 0.25 * runs as f32).min(0.85);
        return Some((progress, format!("{rule} · run {runs}")));
    }
    if let Some(rest) = line.strip_prefix("Latexmk: applying rule '") {
        let rule = rest.trim_end_matches("'...");
        let progress = match rule {
            "bibtex" | "biber" | "makeindex" => 0.5,
            _ => 0.15,
        };
        return Some((progress, rule.to_string()));
    }
    None
}

/// Last few output lines, kept to build a useful failure message (LaTeX errors
/// start with `! `; those win over the plain tail).
const ERROR_TAIL_LINES: usize = 24;

/// Pump a child pipe into the shared line stream until it ends.
#[cfg(not(windows))]
async fn forward_lines<S>(stream: S, tx: tokio::sync::mpsc::UnboundedSender<String>)
where
    S: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if tx.send(line).is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_run_number_banners_to_monotonic_milestones() {
        let mut progress = CompileProgress::default();
        let first = line_milestone("Run number 1 of rule 'pdflatex'").unwrap();
        assert_eq!(first, (0.35, "pdflatex · run 1".to_string()));
        assert_eq!(
            progress.advance(first.0, first.1.clone()),
            Some(first.clone())
        );

        // Same run again (rerun banner) must not move the bar.
        assert_eq!(progress.advance(first.0, first.1), None);

        let second = line_milestone("Run number 2 of rule 'pdflatex'").unwrap();
        assert_eq!(second.0, 0.6);
        assert_eq!(
            progress.advance(second.0, second.1.clone()),
            Some(second.clone())
        );
        // Bibliography rules sit below engine run 2 — monotonic filter drops them.
        let bib = line_milestone("Latexmk: applying rule 'bibtex'...").unwrap();
        assert_eq!(bib, (0.5, "bibtex".to_string()));
        assert_eq!(progress.advance(bib.0, bib.1), None);
    }

    #[test]
    fn caps_engine_run_progress_below_terminal() {
        let (progress, phase) = line_milestone("Run number 9 of rule 'lualatex'").unwrap();
        assert_eq!(progress, 0.85);
        assert_eq!(phase, "lualatex · run 9");
    }

    #[test]
    fn ordinary_log_lines_are_not_milestones() {
        assert!(line_milestone("This is pdfTeX, Version 3.141592653").is_none());
        assert!(line_milestone("[1] [2] [3]").is_none());
        assert!(line_milestone("Latexmk: All targets () are up-to-date").is_none());
    }

    #[test]
    fn parses_chktex_machine_output() {
        // Real output shape captured from chktex 1.7.9 with
        // `-f'%l:%c:%d:%k:%n:%m\n'` (real newline in the format string).
        let stdout = concat!(
            "1:15:3:Warning:11:You should use \\ldots to achieve an ellipsis.\n",
            "2:16:2:Warning:8:Wrong length of dash may have been used.\n",
            "3:1:1:Warning:2:Non-breaking space (`~') should have been used.\n",
        );
        let found = parse_chktex_output(stdout);
        assert_eq!(found.len(), 3);
        assert_eq!(
            (found[0].line, found[0].column, found[0].length),
            (1, 15, 3)
        );
        assert_eq!(found[0].severity, "warning");
        assert_eq!(found[0].code, 11);
        assert_eq!(found[2].line, 3);
    }

    #[test]
    fn keeps_colons_inside_chktex_messages_and_skips_junk() {
        let stdout = concat!(
            "ChkTeX v1.7.9 - Copyright 1995-96 Jens T. Berger Thielemann.\n",
            "\n",
            "1:1:1:Message:44:note: with: colons\n",
            "3:1:1:Error:1:boom\n",
            "not:enough:fields\n",
        );
        let found = parse_chktex_output(stdout);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].message, "note: with: colons");
        assert_eq!(found[0].severity, "info");
        assert_eq!(found[1].severity, "error");
    }
}
