//! Commit one writing project (`thesis/<project>/`) to the GitHub repository
//! bound to it. Older vaults keep `thesis/` itself as the project. Build
//! products are gitignored. Nothing here runs on autosave.

use crate::core::error::{ApiResult, AppError};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

const MARKER: &str = "# agentero-writing";
const RULES: &[&str] = &[
    "*.aux",
    "*.bbl",
    "*.bcf",
    "*.blg",
    "*.fdb_latexmk",
    "*.fls",
    "*.lof",
    "*.log",
    "*.lot",
    "*.nav",
    "*.out",
    "*.pdf",
    "*.run.xml",
    "*.snm",
    "*.synctex",
    "*.synctex.gz",
    "*.toc",
    "*.xdv",
    "aux/",
    "build/",
    "out/",
];

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WritingSyncReport {
    pub committed: bool,
    pub pushed: bool,
    pub remote: bool,
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WritingGitFile {
    pub path: String,
    pub added: u32,
    pub removed: u32,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WritingGitCommit {
    pub id: String,
    pub at: i64,
    pub summary: String,
    pub files: Vec<WritingGitFile>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WritingGitLog {
    pub code: String,
    pub commits: Vec<WritingGitCommit>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WritingGitDiff {
    pub code: String,
    pub patch: String,
    pub truncated: bool,
}

fn report(
    committed: bool,
    pushed: bool,
    remote: bool,
    code: &str,
    detail: impl Into<String>,
) -> WritingSyncReport {
    WritingSyncReport {
        committed,
        pushed,
        remote,
        code: code.to_string(),
        detail: detail.into(),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn writing_sync_project(
    project_dir: String,
    remote: String,
    branch: String,
) -> ApiResult<WritingSyncReport> {
    match sync_project(Path::new(&project_dir), &remote, &branch).await {
        Ok(value) => ApiResult::ok(value),
        Err(err) => ApiResult::err(err),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn writing_git_log(project_dir: String) -> ApiResult<WritingGitLog> {
    match read_git_log(Path::new(&project_dir)).await {
        Ok(value) => ApiResult::ok(value),
        Err(err) => ApiResult::err(err),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn writing_git_diff(project_dir: String, commit: String) -> ApiResult<WritingGitDiff> {
    match read_git_diff(Path::new(&project_dir), &commit).await {
        Ok(value) => ApiResult::ok(value),
        Err(err) => ApiResult::err(err),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn writing_git_restore(
    project_dir: String,
    commit: String,
) -> ApiResult<WritingSyncReport> {
    match restore_tree(Path::new(&project_dir), &commit).await {
        Ok(value) => ApiResult::ok(value),
        Err(err) => ApiResult::err(err),
    }
}

async fn read_git_log(project_dir: &Path) -> Result<WritingGitLog, AppError> {
    if !project_dir.is_dir() {
        return Ok(WritingGitLog {
            code: "no_repo".into(),
            commits: Vec::new(),
        });
    }
    let dir = project_dir
        .canonicalize()
        .map_err(|err| AppError::message(err.to_string()))?;
    if !writing_project_dir_ok(&dir) {
        return Ok(WritingGitLog {
            code: "no_repo".into(),
            commits: Vec::new(),
        });
    }
    let Some(git) = find_git() else {
        return Ok(WritingGitLog {
            code: "git_missing".into(),
            commits: Vec::new(),
        });
    };
    if !dir.join(".git").exists() {
        return Ok(WritingGitLog {
            code: "no_repo".into(),
            commits: Vec::new(),
        });
    }
    let output = git_run(
        &dir,
        &git,
        &[
            "log",
            "-n",
            "40",
            "--pretty=format:%x1e%H%x1f%ct%x1f%s",
            "--numstat",
        ],
        20,
        false,
    )
    .await?;
    if !output.status.success() {
        let detail = clip_output(&output);
        if detail.contains("does not have any commits") {
            let mut commits = Vec::new();
            if let Some(pending) = pending_commit(&dir, &git).await? {
                commits.push(pending);
            }
            return Ok(WritingGitLog {
                code: "ok".into(),
                commits,
            });
        }
        return Err(AppError::message(if detail.is_empty() {
            "git log failed".into()
        } else {
            format!("git log failed: {detail}")
        }));
    }
    let mut commits = parse_git_log(&String::from_utf8_lossy(&output.stdout));
    if let Some(pending) = pending_commit(&dir, &git).await? {
        commits.insert(0, pending);
    }
    Ok(WritingGitLog {
        code: "ok".into(),
        commits,
    })
}

fn parse_git_log(text: &str) -> Vec<WritingGitCommit> {
    text.split('\u{1e}')
        .filter_map(|chunk| {
            let chunk = chunk.trim();
            if chunk.is_empty() {
                return None;
            }
            let mut lines = chunk.lines();
            let header = lines.next()?.trim();
            let mut parts = header.splitn(3, '\u{1f}');
            let id = parts.next()?.trim();
            let at = parts.next()?.trim().parse::<i64>().ok()?;
            let summary = parts.next()?.trim();
            if id.len() < 7 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            let files = lines.filter_map(parse_numstat).collect();
            Some(WritingGitCommit {
                id: id.to_string(),
                at,
                summary: summary.to_string(),
                files,
            })
        })
        .collect()
}

fn parse_numstat(line: &str) -> Option<WritingGitFile> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut cols = line.split('\t');
    let added = cols.next()?.trim();
    let removed = cols.next()?.trim();
    let path = cols.next()?.trim();
    if path.is_empty() {
        return None;
    }
    Some(WritingGitFile {
        path: path.to_string(),
        added: added.parse().unwrap_or(0),
        removed: removed.parse().unwrap_or(0),
    })
}

fn commit_message(names: &[String]) -> String {
    if names.is_empty() {
        return "Update writing".into();
    }
    let shown = names
        .iter()
        .take(3)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > 3 {
        format!("Update {shown} and {} more", names.len() - 3)
    } else {
        format!("Update {shown}")
    }
}

fn valid_commit(commit: &str) -> bool {
    commit == "pending"
        || (commit.len() >= 7
            && commit.len() <= 64
            && commit.chars().all(|c| c.is_ascii_hexdigit()))
}

async fn pending_commit(dir: &Path, git: &Path) -> Result<Option<WritingGitCommit>, AppError> {
    let status = git_run(dir, git, &["status", "--porcelain"], 20, false).await?;
    if !status.status.success() {
        return Ok(None);
    }
    let porcelain = String::from_utf8_lossy(&status.stdout);
    if porcelain.trim().is_empty() {
        return Ok(None);
    }
    let diff = git_run(dir, git, &["diff", "HEAD", "--numstat"], 20, false).await?;
    let mut files = if diff.status.success() {
        String::from_utf8_lossy(&diff.stdout)
            .lines()
            .filter_map(parse_numstat)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    for line in porcelain.lines() {
        let line = line.trim_end();
        if line.len() < 4 {
            continue;
        }
        let path = line[3..].trim();
        let path = path.rsplit(" -> ").next().unwrap_or(path).trim();
        if path.is_empty() || files.iter().any(|file| file.path == path) {
            continue;
        }
        files.push(WritingGitFile {
            path: path.to_string(),
            added: 0,
            removed: 0,
        });
    }
    if files.is_empty() {
        return Ok(None);
    }
    Ok(Some(WritingGitCommit {
        id: "pending".into(),
        at: chrono_now(),
        summary: String::new(),
        files,
    }))
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

async fn read_git_diff(project_dir: &Path, commit: &str) -> Result<WritingGitDiff, AppError> {
    if !valid_commit(commit) {
        return Ok(WritingGitDiff {
            code: "missing".into(),
            patch: String::new(),
            truncated: false,
        });
    }
    if !project_dir.is_dir() {
        return Ok(empty_diff("no_repo"));
    }
    let dir = project_dir
        .canonicalize()
        .map_err(|err| AppError::message(err.to_string()))?;
    if !writing_project_dir_ok(&dir) || !dir.join(".git").exists() {
        return Ok(empty_diff("no_repo"));
    }
    let Some(git) = find_git() else {
        return Ok(empty_diff("git_missing"));
    };
    let output = if commit == "pending" {
        git_run(&dir, &git, &["diff", "HEAD", "--unified=3"], 30, false).await?
    } else {
        git_run(
            &dir,
            &git,
            &["show", "--pretty=format:", "--unified=3", commit],
            30,
            false,
        )
        .await?
    };
    if !output.status.success() {
        return Ok(empty_diff("missing"));
    }
    let (patch, truncated) = clip_patch(&String::from_utf8_lossy(&output.stdout));
    Ok(WritingGitDiff {
        code: "ok".into(),
        patch,
        truncated,
    })
}

/// Put the working tree back at `commit` without moving HEAD, so the next
/// upload records the restore as a new change.
async fn restore_tree(project_dir: &Path, commit: &str) -> Result<WritingSyncReport, AppError> {
    if commit == "pending" || !valid_commit(commit) {
        return Err(AppError::message("invalid commit"));
    }
    if !project_dir.is_dir() {
        return Ok(report(false, false, false, "no_repo", ""));
    }
    let dir = project_dir
        .canonicalize()
        .map_err(|err| AppError::message(err.to_string()))?;
    super::cloud::check_project_git_write(&dir)?;
    if !writing_project_dir_ok(&dir) || !dir.join(".git").exists() {
        return Ok(report(false, false, false, "no_repo", ""));
    }
    let Some(git) = find_git() else {
        return Ok(report(false, false, false, "git_missing", ""));
    };
    let output = git_run(
        &dir,
        &git,
        &["read-tree", "--reset", "-u", commit],
        60,
        false,
    )
    .await?;
    ensure(&output, "restore")?;
    Ok(report(true, false, false, "restored", ""))
}

fn empty_diff(code: &str) -> WritingGitDiff {
    WritingGitDiff {
        code: code.to_string(),
        patch: String::new(),
        truncated: false,
    }
}

fn clip_patch(text: &str) -> (String, bool) {
    const MAX: usize = 60_000;
    let trimmed = text.trim();
    if trimmed.len() <= MAX {
        return (trimmed.to_string(), false);
    }
    let mut end = MAX;
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    (trimmed[..end].to_string(), true)
}

fn find_git() -> Option<PathBuf> {
    if let Ok(path) = which::which("git") {
        return Some(path);
    }
    let mut candidates = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Programs/Git/cmd/git.exe"));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        candidates.push(PathBuf::from(profile).join("scoop/apps/git/current/cmd/git.exe"));
    }
    candidates.push(PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"));
    candidates.push(PathBuf::from(r"C:\Program Files (x86)\Git\cmd\git.exe"));
    candidates.into_iter().find(|path| path.is_file())
}

async fn sync_project(
    project_dir: &Path,
    remote_input: &str,
    branch_input: &str,
) -> Result<WritingSyncReport, AppError> {
    if !project_dir.is_dir() {
        return Ok(report(false, false, false, "missing", ""));
    }
    let dir = project_dir
        .canonicalize()
        .map_err(|err| AppError::message(err.to_string()))?;
    super::cloud::check_project_git_write(&dir)?;
    if !writing_project_dir_ok(&dir) {
        return Ok(report(false, false, false, "invalid_dir", ""));
    }
    let Some(remote) = normalize_github_remote(remote_input) else {
        return Ok(report(false, false, false, "invalid_remote", ""));
    };
    let Some(branch) = normalize_branch(branch_input) else {
        return Ok(report(false, false, false, "invalid_branch", ""));
    };
    let Some(git) = find_git() else {
        return Ok(report(false, false, false, "git_missing", ""));
    };

    if !dir.join(".git").exists() {
        let init = git_run(&dir, &git, &["init", "-b", &branch], 30, false).await?;
        if !init.status.success() {
            ensure(
                &git_run(&dir, &git, &["init"], 30, false).await?,
                "git init",
            )?;
            let head = format!("refs/heads/{branch}");
            ensure(
                &git_run(&dir, &git, &["symbolic-ref", "HEAD", &head], 15, false).await?,
                "git branch",
            )?;
        }
    }
    write_gitignore(&dir).await?;
    ensure_identity(&dir, &git).await?;
    set_origin(&dir, &git, &remote).await?;

    ensure(
        &git_run(&dir, &git, &["add", "-A"], 60, false).await?,
        "git add",
    )?;
    let quiet = git_run(&dir, &git, &["diff", "--cached", "--quiet"], 30, false).await?;
    let clean = match quiet.status.code() {
        Some(0) => true,
        Some(1) => false,
        _ => {
            return Err(AppError::message(format!(
                "git diff failed: {}",
                clip_output(&quiet)
            )));
        }
    };
    if !clean {
        let listed = git_run(&dir, &git, &["diff", "--cached", "--name-only"], 30, false).await?;
        let names = String::from_utf8_lossy(&listed.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        let message = commit_message(&names);
        ensure(
            &git_run(&dir, &git, &["commit", "-m", &message], 60, false).await?,
            "git commit",
        )?;
    }

    let fetch = git_run(&dir, &git, &["fetch", "origin", &branch], 300, true).await?;
    if !fetch.status.success() {
        let detail = clip_output(&fetch);
        if !remote_branch_missing(&detail) {
            return Ok(network_failure(detail));
        }
        if !has_head(&dir, &git).await? {
            return Ok(report(false, false, true, "clean", ""));
        }
    } else if !has_head(&dir, &git).await? {
        let checkout = git_run(
            &dir,
            &git,
            &["checkout", "-B", &branch, "FETCH_HEAD"],
            60,
            false,
        )
        .await?;
        if checkout.status.success() {
            return Ok(report(false, false, true, "pulled", ""));
        }
        return Ok(network_failure(clip_output(&checkout)));
    } else {
        let rebase = git_run(&dir, &git, &["rebase", "FETCH_HEAD"], 180, false).await?;
        if !rebase.status.success() {
            let _ = git_run(&dir, &git, &["rebase", "--abort"], 30, false).await;
            return Ok(network_failure(clip_output(&rebase)));
        }
    }

    let spec = format!("HEAD:{branch}");
    let pushed = git_run(&dir, &git, &["push", "-u", "origin", &spec], 300, true).await?;
    if pushed.status.success() {
        let detail = clip_output(&pushed);
        if !clean {
            return Ok(report(true, true, true, "pushed", ""));
        }
        if detail.to_ascii_lowercase().contains("up-to-date")
            || detail.to_ascii_lowercase().contains("up to date")
        {
            return Ok(report(false, false, true, "clean", ""));
        }
        return Ok(report(false, true, true, "pushed", ""));
    }
    Ok(network_failure(clip_output(&pushed)))
}

/// A declared project can be beneath any classification folder. A Git
/// operation must never absorb a second project through an ancestor path.
fn writing_project_dir_ok(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let is_shelf = |dir: &Path| {
        dir.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("thesis"))
    };
    let parent = path.parent();
    let inside_shelf = path.ancestors().skip(1).any(is_shelf);
    let marker = path.join("agentero.project.json");
    let marker_exists = marker.symlink_metadata().is_ok();
    let declared = marker.symlink_metadata().is_ok_and(|meta| meta.is_file())
        && std::fs::read(&marker)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|value| value["schemaVersion"] == 1 && value["projectId"].is_string());
    let allowed = if marker_exists {
        declared
            && inside_shelf
            && !path
                .ancestors()
                .skip(1)
                .take_while(|dir| !is_shelf(dir))
                .any(|dir| dir.join("agentero.project.json").symlink_metadata().is_ok())
    } else {
        name.eq_ignore_ascii_case("thesis") || parent.is_some_and(is_shelf)
    };
    if !allowed {
        return false;
    }
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries {
            let Ok(entry) = entry else { return false };
            let entry_path = entry.path();
            if entry_path != marker
                && entry
                    .file_name()
                    .eq_ignore_ascii_case("agentero.project.json")
            {
                return false;
            }
            let Ok(kind) = entry.file_type() else {
                return false;
            };
            if kind.is_dir() && entry.file_name() != ".git" {
                pending.push(entry_path);
            }
        }
    }
    true
}

fn normalize_github_remote(input: &str) -> Option<String> {
    let text = input.trim().trim_end_matches('/');
    if text.contains('?') || text.contains('#') || text.contains(' ') {
        return None;
    }
    let rest = text
        .strip_prefix("https://github.com/")
        .or_else(|| text.strip_prefix("git@github.com:"))
        .or_else(|| text.strip_prefix("github.com/"))?;
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next().is_some() || !is_github_name(owner) || !is_github_name(repo) {
        return None;
    }
    Some(format!("https://github.com/{owner}/{repo}.git"))
}

fn is_github_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 100 || name == "." || name == ".." {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn normalize_branch(input: &str) -> Option<String> {
    let text = input.trim();
    if text.is_empty()
        || text.len() > 100
        || text.starts_with('-')
        || text.starts_with('/')
        || text.ends_with('/')
        || text.contains("..")
        || text.contains('@')
    {
        return None;
    }
    if text
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '/' | '-'))
    {
        Some(text.to_string())
    } else {
        None
    }
}

fn remote_branch_missing(detail: &str) -> bool {
    let text = detail.to_ascii_lowercase();
    text.contains("couldn't find remote ref") || text.contains("could not find remote ref")
}

fn network_failure(detail: String) -> WritingSyncReport {
    let code = if is_auth(&detail) {
        "auth"
    } else if is_conflict(&detail) {
        "conflict"
    } else {
        "push_failed"
    };
    report(false, false, true, code, detail)
}

fn is_auth(detail: &str) -> bool {
    let text = detail.to_ascii_lowercase();
    text.contains("authentication")
        || text.contains("terminal prompts disabled")
        || text.contains("could not read username")
        || text.contains("repository not found")
        || text.contains("permission denied")
        || text.contains("403")
        || text.contains("401")
}

fn is_conflict(detail: &str) -> bool {
    let text = detail.to_ascii_lowercase();
    text.contains("conflict")
        || text.contains("could not apply")
        || text.contains("would be overwritten")
        || text.contains("unmerged")
        || text.contains("unrelated")
}

async fn has_head(dir: &Path, git: &Path) -> Result<bool, AppError> {
    let output = git_run(dir, git, &["rev-parse", "--verify", "HEAD"], 15, false).await?;
    Ok(output.status.success())
}

async fn set_origin(dir: &Path, git: &Path, remote: &str) -> Result<(), AppError> {
    let current = git_run(dir, git, &["remote", "get-url", "origin"], 15, false).await?;
    if current.status.success() {
        if String::from_utf8_lossy(&current.stdout).trim() == remote {
            return Ok(());
        }
        return ensure(
            &git_run(
                dir,
                git,
                &["remote", "set-url", "origin", remote],
                15,
                false,
            )
            .await?,
            "git remote",
        );
    }
    ensure(
        &git_run(dir, git, &["remote", "add", "origin", remote], 15, false).await?,
        "git remote",
    )
}

async fn write_gitignore(dir: &Path) -> Result<(), AppError> {
    let path = dir.join(".gitignore");
    let existing = match tokio::fs::read_to_string(&path).await {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(AppError::message(err.to_string())),
    };
    let merged = merge_gitignore(&existing);
    if merged == existing {
        return Ok(());
    }
    tokio::fs::write(path, merged)
        .await
        .map_err(|err| AppError::message(err.to_string()))
}

fn merge_gitignore(existing: &str) -> String {
    let missing: Vec<&str> = RULES
        .iter()
        .copied()
        .filter(|rule| !existing.lines().any(|line| line.trim() == *rule))
        .collect();
    if missing.is_empty() {
        return existing.to_string();
    }
    let mut out = existing.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.lines().any(|line| line.trim() == MARKER) {
        out.push_str(MARKER);
        out.push('\n');
    }
    for rule in missing {
        out.push_str(rule);
        out.push('\n');
    }
    out
}

async fn ensure_identity(dir: &Path, git: &Path) -> Result<(), AppError> {
    if !git_configured(dir, git, "user.name").await? {
        ensure(
            &git_run(dir, git, &["config", "user.name", "Agentero"], 15, false).await?,
            "git config",
        )?;
    }
    if !git_configured(dir, git, "user.email").await? {
        ensure(
            &git_run(
                dir,
                git,
                &["config", "user.email", "agentero@localhost"],
                15,
                false,
            )
            .await?,
            "git config",
        )?;
    }
    Ok(())
}

async fn git_configured(dir: &Path, git: &Path, key: &str) -> Result<bool, AppError> {
    let output = git_run(dir, git, &["config", "--get", key], 15, false).await?;
    Ok(output.status.success() && !String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn clip_output(output: &std::process::Output) -> String {
    let stderr = clip(&output.stderr);
    if stderr.is_empty() {
        clip(&output.stdout)
    } else {
        stderr
    }
}

fn clip(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim()
        .chars()
        .take(400)
        .collect()
}

fn ensure(output: &std::process::Output, action: &str) -> Result<(), AppError> {
    if output.status.success() {
        return Ok(());
    }
    let detail = clip_output(output);
    if detail.is_empty() {
        Err(AppError::message(format!("{action} failed")))
    } else {
        Err(AppError::message(format!("{action} failed: {detail}")))
    }
}

async fn git_run(
    dir: &Path,
    program: &Path,
    args: &[&str],
    secs: u64,
    interactive: bool,
) -> Result<std::process::Output, AppError> {
    let mut command = Command::new(program);
    command
        .arg("-c")
        .arg("safe.directory=*")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", if interactive { "1" } else { "0" });
    if interactive {
        command.env("GCM_INTERACTIVE", "auto");
    }
    match tokio::time::timeout(
        Duration::from_secs(secs),
        crate::core::process::command_output(&mut command),
    )
    .await
    {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(err)) => Err(AppError::message(err.to_string())),
        Err(_) => Err(AppError::message("git timed out")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        commit_message, is_auth, is_conflict, merge_gitignore, normalize_branch,
        normalize_github_remote, parse_git_log, writing_project_dir_ok,
    };

    #[test]
    fn keeps_the_repository_inside_one_project_folder() {
        let root = tempfile::tempdir().unwrap();
        let shelf = root.path().join("thesis");
        let project = shelf.join("paper-a");
        let nested = project.join("sections");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(writing_project_dir_ok(&shelf));
        assert!(writing_project_dir_ok(&project));
        assert!(!writing_project_dir_ok(&nested));
        let outside = root.path().join("notes");
        std::fs::create_dir_all(&outside).unwrap();
        assert!(!writing_project_dir_ok(&outside));
    }

    #[test]
    fn refuses_to_sync_a_classification_containing_a_declared_project() {
        let root = tempfile::tempdir().unwrap();
        let shelf = root.path().join("thesis");
        let collection = shelf.join("2026");
        let project = collection.join("投稿/paper-a");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join("agentero.project.json"),
            r#"{"schemaVersion":1,"projectId":"2a616bc4-cda8-4df4-a466-0e1a886d051b"}"#,
        )
        .unwrap();
        assert!(writing_project_dir_ok(&project));
        assert!(!writing_project_dir_ok(&collection));
        assert!(!writing_project_dir_ok(&shelf));
    }

    #[test]
    fn appends_missing_rules_once() {
        let once = merge_gitignore("notes\n");
        assert!(once.contains("*.aux"));
        assert!(once.contains("# agentero-writing"));
        assert!(once.starts_with("notes\n"));
        assert_eq!(merge_gitignore(&once), once);
    }

    #[test]
    fn keeps_an_existing_rule() {
        let merged = merge_gitignore("*.pdf\n");
        assert_eq!(merged.matches("*.pdf").count(), 1);
    }

    #[test]
    fn accepts_a_github_repository() {
        assert_eq!(
            normalize_github_remote("https://github.com/ada/writing"),
            Some("https://github.com/ada/writing.git".into())
        );
        assert_eq!(
            normalize_github_remote("git@github.com:ada/writing.git"),
            Some("https://github.com/ada/writing.git".into())
        );
        assert_eq!(
            normalize_github_remote("https://gitlab.com/ada/writing"),
            None
        );
        assert_eq!(normalize_branch("main"), Some("main".into()));
        assert_eq!(normalize_branch("../main"), None);
        assert!(is_auth("remote: Repository not found."));
        assert!(is_conflict(
            "CONFLICT (content): Merge conflict in main.tex"
        ));
    }

    #[test]
    fn reads_changed_files_from_a_log() {
        let text = "\u{1e}abcdef1\u{1f}10\u{1f}Update main.tex\n12\t3\tmain.tex\n1\t0\trefs.bib\n";
        let commits = parse_git_log(text);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].files.len(), 2);
        assert_eq!(commits[0].files[0].path, "main.tex");
        assert_eq!(commits[0].files[0].added, 12);
        assert_eq!(commit_message(&["main.tex".into()]), "Update main.tex");
        assert_eq!(
            commit_message(&[
                "a.tex".into(),
                "b.tex".into(),
                "c.tex".into(),
                "d.tex".into()
            ]),
            "Update a.tex, b.tex, c.tex and 1 more"
        );
    }
}
