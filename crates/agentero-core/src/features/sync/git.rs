//! Full-vault sync through a system `git` work tree.
//!
//! Git owns history, transport and merge semantics; unlike the blob stores,
//! the remote is the repository itself. One pass commits local changes,
//! fetches the configured branch, merges it (native Git merge; conflicts
//! abort and surface), and pushes.
//!
//! `.agentero/` stays out of the repository via `.git/info/exclude`. PDF,
//! LaTeX source, and attachment categories follow the shared sync scope: a
//! marked block in `.gitignore` plus `git rm --cached`, so local files stay
//! on disk and later commits leave them out. There is no per-paper partial
//! checkout.

use crate::error::AppError;
use crate::features::sync::config::SyncBackendConfig;
use crate::features::sync::engine::{self, Progress, SyncOutcome};
use crate::features::sync::local::{self, SyncMeta};
use crate::features::sync::snapshot::{self, SyncScope};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;
use tokio::process::Command;

const LOCAL_TIMEOUT: Duration = Duration::from_secs(120);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_PUSH_RETRIES: usize = 3;

const SCRUB_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
];

const EXCLUDE_LINES: &[&str] = &[
    "# agentero sync",
    ".agentero/",
    ".DS_Store",
    "*.tmp",
    "node_modules/",
];

const SYNC_IGNORE_START: &str = "# agentero-sync-start";
const SYNC_IGNORE_END: &str = "# agentero-sync-end";

struct Git {
    exe: PathBuf,
    vault: PathBuf,
    /// Absolute PEM path passed as `http.sslCAInfo` on every command.
    http_ssl_ca_info: Option<String>,
}

#[derive(Debug, Default)]
struct DiffCounts {
    changed: usize,
    deleted: usize,
}

struct RepoInfo {
    branch: String,
}

enum PushOutcome {
    Pushed,
    Rejected,
}

/// Validate the remote/branch and reach the remote without initializing a
/// repository. Used by `sync_configure` (and the CLI `sync test`).
pub async fn test_connection(vault: &Path, cfg: &SyncBackendConfig) -> Result<(), AppError> {
    cfg.validate()?;
    let git = Git::new(vault, cfg)?;
    if let Some(repo) = git.inspect_repo().await? {
        if repo.branch != cfg.git_branch {
            return Err(AppError::domain(
                "git_repo_conflict",
                format!(
                    "the vault is on branch '{}', but sync is configured for '{}'",
                    repo.branch, cfg.git_branch
                ),
            ));
        }
        git.check_origin(cfg).await?;
        git.ensure_agentero_untracked().await?;
    }
    let pattern = format!("refs/heads/{}", cfg.git_branch);
    checked(
        git.run(
            ["ls-remote", cfg.git_remote.trim(), &pattern],
            NETWORK_TIMEOUT,
        )
        .await?,
        "git ls-remote",
    )?;
    Ok(())
}

/// One full pass. The cross-process lock and `lastError` bookkeeping stay in
/// `engine::sync_vault_locked`, shared with the S3/WebDAV backends.
pub async fn sync_vault(
    vault: &Path,
    cfg: &SyncBackendConfig,
    progress: Progress<'_>,
) -> Result<SyncOutcome, AppError> {
    cfg.validate()?;
    let git = Git::new(vault, cfg)?;

    let projection_root = vault.to_path_buf();
    tokio::task::spawn_blocking(move || {
        crate::features::paper::catalog::sidecar::flush_pending(&projection_root)
    })
    .await
    .map_err(|e| AppError::message(format!("sidecar projection task: {e}")))??;
    progress("scan", 0, 0);
    git.ensure_repo(cfg).await?;
    let committed = git.commit_local(&cfg.scope).await?;
    let mut outcome = SyncOutcome::default();
    if let Some(counts) = &committed {
        outcome.uploaded = counts.changed;
        outcome.removed_remote = counts.deleted;
    }

    progress("pull", 0, 0);
    let mut remote_tip = git.ls_remote_branch(cfg).await?;
    let mut local_head = git.head().await?;
    if committed.is_some() && local_head.is_none() {
        return Err(AppError::message(
            "git commit completed but HEAD is unreadable",
        ));
    }

    let tracking = git.remote_tracking(cfg).await?;
    if remote_tip.is_some() && tracking != remote_tip {
        git.fetch(cfg).await?;
    }
    if remote_tip.is_some() {
        git.ensure_remote_agentero_untracked(cfg).await?;
    }

    // Nothing on either side: an empty vault has nothing to push.
    if remote_tip.is_none() && local_head.is_none() {
        return git.finish(vault, outcome).await;
    }

    // An empty local vault adopts the remote tree; there is no local commit
    // to merge (all non-ignored files would have been committed above).
    if local_head.is_none() {
        let adopted = git.adopt_remote(cfg).await?;
        outcome.downloaded = adopted;
        return git.finish(vault, outcome).await;
    }

    // Idle: no local changes and both sides already point at the same commit.
    if committed.is_none() && local_head == remote_tip {
        return git.finish(vault, outcome).await;
    }

    if remote_tip.is_some() {
        let (_ahead, behind) = git.ahead_behind(cfg).await?;
        if behind > 0 {
            let counts = git.merge_remote(cfg).await?;
            outcome.downloaded += counts.changed;
            outcome.deleted_local += counts.deleted;
            local_head = git.head().await?;
        }
    }

    progress("finalize", 0, 0);
    let mut retries = 0;
    loop {
        let need_push = match (&local_head, &remote_tip) {
            (Some(local), Some(remote)) => local != remote,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if !need_push {
            break;
        }
        match git.push(cfg).await? {
            PushOutcome::Pushed => break,
            PushOutcome::Rejected => {
                retries += 1;
                if retries >= MAX_PUSH_RETRIES {
                    return Err(AppError::domain(
                        "git_push_failed",
                        "the remote kept moving during push; try again",
                    ));
                }
                remote_tip = git.ls_remote_branch(cfg).await?;
                if remote_tip.is_none() {
                    // The branch disappeared between our push and now; the
                    // next attempt recreates it.
                    local_head = git.head().await?;
                    continue;
                }
                git.fetch(cfg).await?;
                git.ensure_remote_agentero_untracked(cfg).await?;
                let counts = git.merge_remote(cfg).await?;
                outcome.downloaded += counts.changed;
                outcome.deleted_local += counts.deleted;
                local_head = git.head().await?;
            }
        }
    }

    git.finish(vault, outcome).await
}

impl Git {
    fn new(vault: &Path, cfg: &SyncBackendConfig) -> Result<Self, AppError> {
        let exe = crate::process::resolve_command("git").ok_or_else(|| {
            AppError::domain(
                "git_unavailable",
                "Git is not installed or not on PATH; install Git and retry",
            )
        })?;
        let ca = cfg.git_ssl_ca_info.trim();
        let http_ssl_ca_info = if ca.is_empty() {
            None
        } else {
            Some(
                crate::process::windows_shell_path(Path::new(ca))
                    .to_string_lossy()
                    .into_owned(),
            )
        };
        Ok(Self {
            exe,
            // Git for Windows handles plain drive paths better than the
            // extended-length `\\?\` prefix (#181).
            vault: crate::process::windows_shell_path(vault),
            http_ssl_ca_info,
        })
    }

    async fn run<I, S>(&self, args: I, timeout: Duration) -> Result<Output, AppError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let user_args: Vec<std::ffi::OsString> = args
            .into_iter()
            .map(|arg| arg.as_ref().to_os_string())
            .collect();
        let mut argv = http_ssl_ca_args(self.http_ssl_ca_info.as_deref());
        argv.extend(user_args);
        let label = argv
            .iter()
            .map(|arg| arg.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        let mut command = Command::new(&self.exe);
        command
            .current_dir(&self.vault)
            .args(&argv)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .env("SSH_ASKPASS_REQUIRE", "never")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("LC_ALL", "C");
        for key in SCRUB_ENV {
            command.env_remove(key);
        }
        #[cfg(unix)]
        if std::env::var_os("GIT_SSH_COMMAND").is_none() {
            // GUI apps cannot answer SSH prompts. Users with an agent/key
            // get through; everyone else fails fast with stderr instead of
            // hanging the sync task.
            command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
        crate::process::hide_console_window_tokio(&mut command);
        match tokio::time::timeout(timeout, crate::process::command_output(&mut command)).await {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(error)) => Err(AppError::domain(
                "git_unavailable",
                format!("failed to run git {label}: {error}"),
            )),
            Err(_) => Err(AppError::domain(
                "git_timeout",
                format!("git {label} timed out"),
            )),
        }
    }

    async fn inspect_repo(&self) -> Result<Option<RepoInfo>, AppError> {
        let bare = self
            .run(["rev-parse", "--is-bare-repository"], LOCAL_TIMEOUT)
            .await?;
        if !bare.status.success() {
            let stderr = stderr_text(&bare);
            if stderr.to_ascii_lowercase().contains("not a git repository") {
                return Ok(None);
            }
            return Err(git_error("git rev-parse", &bare));
        }
        if stdout_text(&bare) == "true" {
            return Err(AppError::domain(
                "git_repo_conflict",
                "the vault is a bare Git repository; choose a normal work tree",
            ));
        }
        let top = checked(
            self.run(["rev-parse", "--show-toplevel"], LOCAL_TIMEOUT)
                .await?,
            "git rev-parse",
        )?;
        let root = crate::fs::canonicalize_best_effort(&PathBuf::from(stdout_text(&top)));
        let vault = crate::fs::canonicalize_best_effort(&self.vault);
        if root != vault {
            return Err(AppError::domain(
                "git_repo_conflict",
                format!(
                    "the vault is inside a different Git work tree ({}); open that repository root as the vault",
                    root.display()
                ),
            ));
        }
        let branch = self.current_branch().await?;
        Ok(Some(RepoInfo { branch }))
    }

    async fn current_branch(&self) -> Result<String, AppError> {
        let out = self
            .run(["symbolic-ref", "--short", "-q", "HEAD"], LOCAL_TIMEOUT)
            .await?;
        if !out.status.success() {
            return Err(AppError::domain(
                "git_repo_conflict",
                "the vault is on a detached HEAD; check out a branch before syncing",
            ));
        }
        Ok(stdout_text(&out))
    }

    async fn head(&self) -> Result<Option<String>, AppError> {
        let out = self
            .run(["rev-parse", "--verify", "HEAD"], LOCAL_TIMEOUT)
            .await?;
        if out.status.success() {
            let head = stdout_text(&out);
            Ok((!head.is_empty()).then_some(head))
        } else {
            Ok(None)
        }
    }

    async fn commit_count(&self) -> Result<u64, AppError> {
        let out = self
            .run(["rev-list", "--count", "HEAD"], LOCAL_TIMEOUT)
            .await?;
        if out.status.success() {
            Ok(stdout_text(&out).parse().unwrap_or(0))
        } else {
            Ok(0)
        }
    }

    async fn ensure_repo(&self, cfg: &SyncBackendConfig) -> Result<(), AppError> {
        match self.inspect_repo().await? {
            Some(repo) => {
                if repo.branch != cfg.git_branch {
                    return Err(AppError::domain(
                        "git_repo_conflict",
                        format!(
                            "the vault is on branch '{}', but sync is configured for '{}'; switch branches or update the sync config",
                            repo.branch, cfg.git_branch
                        ),
                    ));
                }
            }
            None => {
                checked(self.run(["init"], LOCAL_TIMEOUT).await?, "git init")?;
                let head_ref = format!("refs/heads/{}", cfg.git_branch);
                checked(
                    self.run(["symbolic-ref", "HEAD", &head_ref], LOCAL_TIMEOUT)
                        .await?,
                    "git symbolic-ref",
                )?;
            }
        }
        self.ensure_no_operation().await?;
        self.ensure_exclude().await?;
        self.ensure_origin(cfg).await?;
        self.ensure_agentero_untracked().await?;
        Ok(())
    }

    /// Refuse to run while the user has an unresolved merge/rebase/cherry-pick
    /// in the repository: `git add -A` would otherwise commit conflict markers
    /// or a half-rebased tree.
    async fn ensure_no_operation(&self) -> Result<(), AppError> {
        for marker in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] {
            let out = self
                .run(["rev-parse", "--verify", "-q", marker], LOCAL_TIMEOUT)
                .await?;
            if out.status.success() {
                return Err(AppError::domain(
                    "git_repo_conflict",
                    "the vault has an in-progress Git merge/cherry-pick; resolve it before syncing",
                ));
            }
        }
        for marker in ["rebase-merge", "rebase-apply", "sequencer"] {
            let out = self
                .run(["rev-parse", "--git-path", marker], LOCAL_TIMEOUT)
                .await?;
            if !out.status.success() {
                continue;
            }
            let raw = PathBuf::from(stdout_text(&out));
            let path = if raw.is_absolute() {
                raw
            } else {
                self.vault.join(raw)
            };
            if path.exists() {
                return Err(AppError::domain(
                    "git_repo_conflict",
                    "the vault has an in-progress Git operation; resolve it before syncing",
                ));
            }
        }
        Ok(())
    }

    async fn ensure_exclude(&self) -> Result<(), AppError> {
        let out = checked(
            self.run(["rev-parse", "--git-path", "info/exclude"], LOCAL_TIMEOUT)
                .await?,
            "git rev-parse",
        )?;
        let raw = PathBuf::from(stdout_text(&out));
        let path = if raw.is_absolute() {
            raw
        } else {
            self.vault.join(raw)
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let missing: Vec<&str> = EXCLUDE_LINES
            .iter()
            .copied()
            .filter(|line| !existing.lines().any(|candidate| candidate.trim() == *line))
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        if !existing.is_empty() && !existing.ends_with('\n') {
            writeln!(file)?;
        }
        for line in missing {
            writeln!(file, "{line}")?;
        }
        Ok(())
    }

    async fn origin_url(&self) -> Result<Option<String>, AppError> {
        let out = self
            .run(["remote", "get-url", "origin"], LOCAL_TIMEOUT)
            .await?;
        if out.status.success() {
            return Ok(Some(stdout_text(&out)));
        }
        let stderr = stderr_text(&out).to_ascii_lowercase();
        if stderr.contains("no such remote") {
            Ok(None)
        } else {
            Err(git_error("git remote get-url", &out))
        }
    }

    async fn check_origin(&self, cfg: &SyncBackendConfig) -> Result<(), AppError> {
        let remote = cfg.git_remote.trim();
        if let Some(current) = self.origin_url().await? {
            if current != remote {
                // Deliberately omit both URLs: an existing origin may carry
                // credentials embedded by another tool, and this message can
                // reach logs / the WebView.
                return Err(AppError::domain(
                    "git_remote_mismatch",
                    "the vault's origin does not match the configured repository; update the remote with git or disconnect sync",
                ));
            }
        }
        Ok(())
    }

    async fn ensure_origin(&self, cfg: &SyncBackendConfig) -> Result<(), AppError> {
        if self.origin_url().await?.is_none() {
            checked(
                self.run(
                    ["remote", "add", "origin", cfg.git_remote.trim()],
                    LOCAL_TIMEOUT,
                )
                .await?,
                "git remote add",
            )?;
        }
        self.check_origin(cfg).await
    }

    async fn ensure_agentero_untracked(&self) -> Result<(), AppError> {
        let out = checked(
            self.run(["ls-files", "--", ".agentero"], LOCAL_TIMEOUT)
                .await?,
            "git ls-files",
        )?;
        if stdout_text(&out).is_empty() {
            Ok(())
        } else {
            Err(AppError::domain(
                "git_agentero_tracked",
                "the vault's Git repository tracks .agentero; run `git rm -r --cached .agentero` and commit before syncing",
            ))
        }
    }

    async fn ensure_remote_agentero_untracked(
        &self,
        cfg: &SyncBackendConfig,
    ) -> Result<(), AppError> {
        let refname = format!("refs/remotes/origin/{}", cfg.git_branch);
        let out = self
            .run(
                ["ls-tree", "-r", "--name-only", &refname, "--", ".agentero"],
                LOCAL_TIMEOUT,
            )
            .await?;
        if out.status.success() && !stdout_text(&out).is_empty() {
            return Err(AppError::domain(
                "git_agentero_tracked",
                "the remote branch tracks .agentero; remove it from Git before syncing",
            ));
        }
        Ok(())
    }

    async fn config_value(&self, key: &str) -> Result<String, AppError> {
        let out = self.run(["config", "--get", key], LOCAL_TIMEOUT).await?;
        if out.status.success() {
            Ok(stdout_text(&out))
        } else {
            Ok(String::new())
        }
    }

    async fn identity_args(&self) -> Result<Vec<String>, AppError> {
        let mut args = Vec::new();
        if self.config_value("user.name").await?.trim().is_empty() {
            args.extend(["-c".to_string(), "user.name=Agentero".to_string()]);
        }
        if self.config_value("user.email").await?.trim().is_empty() {
            args.extend([
                "-c".to_string(),
                "user.email=agentero@localhost".to_string(),
            ]);
        }
        Ok(args)
    }

    async fn commit_local(&self, scope: &SyncScope) -> Result<Option<DiffCounts>, AppError> {
        ensure_sync_gitignore(&self.vault, scope)?;
        self.untrack_excluded(scope).await?;
        let status = checked(
            self.run(
                ["-c", "core.autocrlf=false", "status", "--porcelain", "-z"],
                LOCAL_TIMEOUT,
            )
            .await?,
            "git status",
        )?;
        if status.stdout.is_empty() {
            return Ok(None);
        }
        let before = self.head().await?;
        checked(
            self.run(["-c", "core.autocrlf=false", "add", "-A"], LOCAL_TIMEOUT)
                .await?,
            "git add",
        )?;
        let staged = self
            .run(
                ["-c", "core.autocrlf=false", "diff", "--cached", "--quiet"],
                LOCAL_TIMEOUT,
            )
            .await?;
        match staged.status.code() {
            Some(0) => return Ok(None),
            Some(1) => {}
            _ => return Err(git_error("git diff --cached", &staged)),
        }
        let mut args = self.identity_args().await?;
        args.extend([
            "-c".to_string(),
            "commit.gpgsign=false".to_string(),
            "-c".to_string(),
            "core.autocrlf=false".to_string(),
            "commit".to_string(),
            "-m".to_string(),
            format!("agentero sync: {}", now()),
        ]);
        let out = self.run(args, LOCAL_TIMEOUT).await?;
        if !out.status.success() {
            let stderr = stderr_text(&out).to_ascii_lowercase();
            if stderr.contains("nothing to commit") || stderr.contains("no changes added") {
                return Ok(None);
            }
            return Err(git_error("git commit", &out));
        }
        let after = self.head().await?;
        let counts = self
            .diff_counts(before.as_deref(), after.as_deref())
            .await?;
        Ok(Some(counts))
    }

    /// Drop tracked files the scope excludes. `--cached` leaves the worktree
    /// copy in place; `.gitignore` then keeps `git add -A` from staging it.
    async fn untrack_excluded(&self, scope: &SyncScope) -> Result<(), AppError> {
        if scope.is_all() {
            return Ok(());
        }
        let listed = checked(
            self.run(["ls-files", "-z"], LOCAL_TIMEOUT).await?,
            "git ls-files",
        )?;
        let paths: Vec<String> = listed
            .stdout
            .split(|byte| *byte == 0)
            .filter(|field| !field.is_empty())
            .filter_map(|field| String::from_utf8(field.to_vec()).ok())
            .filter(|rel| snapshot::is_scope_excluded(scope, &rel.replace('\\', "/")))
            .collect();
        for chunk in paths.chunks(200) {
            let mut args: Vec<std::ffi::OsString> = ["rm", "--cached", "--ignore-unmatch", "--"]
                .into_iter()
                .map(std::ffi::OsString::from)
                .collect();
            args.extend(chunk.iter().map(std::ffi::OsString::from));
            checked(self.run(args, LOCAL_TIMEOUT).await?, "git rm")?;
        }
        Ok(())
    }

    async fn diff_counts(
        &self,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Result<DiffCounts, AppError> {
        let Some(to) = to else {
            return Ok(DiffCounts::default());
        };
        let out = match from {
            Some(from) => {
                self.run(
                    [
                        "-c",
                        "core.autocrlf=false",
                        "diff",
                        "--name-status",
                        "-z",
                        from,
                        to,
                    ],
                    LOCAL_TIMEOUT,
                )
                .await?
            }
            None => {
                self.run(
                    [
                        "-c",
                        "core.autocrlf=false",
                        "diff-tree",
                        "--root",
                        "--no-commit-id",
                        "--name-status",
                        "-r",
                        "-z",
                        to,
                    ],
                    LOCAL_TIMEOUT,
                )
                .await?
            }
        };
        let out = checked(out, "git diff")?;
        Ok(parse_name_status(&out.stdout))
    }

    async fn ls_remote_branch(&self, cfg: &SyncBackendConfig) -> Result<Option<String>, AppError> {
        let pattern = format!("refs/heads/{}", cfg.git_branch);
        let out = checked(
            self.run(["ls-remote", "origin", &pattern], NETWORK_TIMEOUT)
                .await?,
            "git ls-remote",
        )?;
        Ok(stdout_text(&out)
            .split_whitespace()
            .next()
            .map(str::to_string))
    }

    async fn remote_tracking(&self, cfg: &SyncBackendConfig) -> Result<Option<String>, AppError> {
        let refname = format!("refs/remotes/origin/{}", cfg.git_branch);
        let out = self
            .run(["rev-parse", "--verify", &refname], LOCAL_TIMEOUT)
            .await?;
        if out.status.success() {
            let sha = stdout_text(&out);
            Ok((!sha.is_empty()).then_some(sha))
        } else {
            Ok(None)
        }
    }

    async fn fetch(&self, cfg: &SyncBackendConfig) -> Result<(), AppError> {
        let refspec = format!("refs/heads/{0}:refs/remotes/origin/{0}", cfg.git_branch);
        let out = self
            .run(
                [
                    "-c",
                    "core.autocrlf=false",
                    "fetch",
                    "--no-tags",
                    "origin",
                    &refspec,
                ],
                NETWORK_TIMEOUT,
            )
            .await?;
        if out.status.success() {
            return Ok(());
        }
        let stderr = stderr_text(&out);
        let lower = stderr.to_ascii_lowercase();
        if lower.contains("non-fast-forward") || lower.contains("rejected") {
            return Err(AppError::domain(
                "git_history_rewritten",
                format!(
                    "remote branch {} was rewritten; resolve it with git manually: {}",
                    cfg.git_branch,
                    truncate(&stderr, 300)
                ),
            ));
        }
        Err(git_error("git fetch", &out))
    }

    async fn merge_remote(&self, cfg: &SyncBackendConfig) -> Result<DiffCounts, AppError> {
        let refname = format!("refs/remotes/origin/{}", cfg.git_branch);
        let before = self.head().await?;
        let mut args = self.identity_args().await?;
        args.extend([
            "-c".to_string(),
            "commit.gpgsign=false".to_string(),
            "-c".to_string(),
            "core.autocrlf=false".to_string(),
            "merge".to_string(),
            "--ff".to_string(),
            "--no-edit".to_string(),
            "--allow-unrelated-histories".to_string(),
            "-m".to_string(),
            format!("agentero sync: merge origin/{}", cfg.git_branch),
            refname,
        ]);
        let out = self.run(args, NETWORK_TIMEOUT).await?;
        if out.status.success() {
            let after = self.head().await?;
            return self.diff_counts(before.as_deref(), after.as_deref()).await;
        }
        let merge_head = self
            .run(["rev-parse", "--verify", "-q", "MERGE_HEAD"], LOCAL_TIMEOUT)
            .await?;
        if merge_head.status.success() {
            let conflicted = self
                .run(
                    ["diff", "--name-only", "-z", "--diff-filter=U"],
                    LOCAL_TIMEOUT,
                )
                .await?;
            let paths = conflicted_paths(&conflicted.stdout);
            let _ = self.run(["merge", "--abort"], LOCAL_TIMEOUT).await;
            let detail = if paths.is_empty() {
                "Git merge conflicts; resolve them with git, then sync again".to_string()
            } else {
                format!(
                    "Git merge conflicts in: {}; resolve them with git, then sync again",
                    paths.join(", ")
                )
            };
            return Err(AppError::domain("sync_conflict", detail));
        }
        Err(git_error("git merge", &out))
    }

    async fn ahead_behind(&self, cfg: &SyncBackendConfig) -> Result<(u64, u64), AppError> {
        let range = format!("HEAD...origin/{}", cfg.git_branch);
        let out = checked(
            self.run(
                ["rev-list", "--left-right", "--count", &range],
                LOCAL_TIMEOUT,
            )
            .await?,
            "git rev-list",
        )?;
        let text = stdout_text(&out);
        let mut parts = text.split_whitespace();
        let ahead = parts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let behind = parts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        Ok((ahead, behind))
    }

    async fn adopt_remote(&self, cfg: &SyncBackendConfig) -> Result<usize, AppError> {
        let refname = format!("refs/remotes/origin/{}", cfg.git_branch);
        checked(
            self.run(
                ["-c", "core.autocrlf=false", "reset", "--hard", &refname],
                LOCAL_TIMEOUT,
            )
            .await?,
            "git reset",
        )?;
        let upstream = format!("origin/{}", cfg.git_branch);
        let _ = self.run(["branch", "-u", &upstream], LOCAL_TIMEOUT).await;
        let out = checked(
            self.run(["ls-tree", "-r", "--name-only", "HEAD"], LOCAL_TIMEOUT)
                .await?,
            "git ls-tree",
        )?;
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|line| !line.is_empty())
            .count())
    }

    async fn push(&self, cfg: &SyncBackendConfig) -> Result<PushOutcome, AppError> {
        let refspec = format!("HEAD:refs/heads/{}", cfg.git_branch);
        let out = self
            .run(
                ["-c", "core.autocrlf=false", "push", "origin", &refspec],
                NETWORK_TIMEOUT,
            )
            .await?;
        if out.status.success() {
            return Ok(PushOutcome::Pushed);
        }
        let combined = format!("{}\n{}", stdout_text(&out), stderr_text(&out));
        if is_push_race(&combined) {
            Ok(PushOutcome::Rejected)
        } else {
            Err(git_error("git push", &out))
        }
    }

    async fn finish(
        &self,
        vault: &Path,
        mut outcome: SyncOutcome,
    ) -> Result<SyncOutcome, AppError> {
        let version = self.commit_count().await?;
        local::write_meta(
            vault,
            &SyncMeta {
                last_sync_at: Some(now()),
                last_version: version,
                last_error: None,
            },
        )?;
        engine::refresh_catalog_if_needed(vault, &outcome).await;
        outcome.version = version;
        Ok(outcome)
    }
}

fn scope_ignore_patterns(scope: &SyncScope) -> Vec<&'static str> {
    let mut lines = Vec::new();
    if !scope.pdf {
        lines.push("papers/*/*.pdf");
    }
    if !scope.source {
        lines.push("papers/*/source/");
    }
    if !scope.attachments {
        lines.push("papers/*/attachments/");
    }
    lines
}

/// Rewrite the managed block in `.gitignore`. User rules outside the markers
/// are kept. An empty scope removes the block; an empty file is deleted.
fn ensure_sync_gitignore(vault: &Path, scope: &SyncScope) -> Result<(), AppError> {
    let path = vault.join(".gitignore");
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let next = sync_gitignore(&existing, scope);
    if next == existing {
        return Ok(());
    }
    if next.is_empty() {
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        return Ok(());
    }
    std::fs::write(&path, next)?;
    Ok(())
}

fn sync_gitignore(existing: &str, scope: &SyncScope) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == SYNC_IGNORE_START {
            skipping = true;
            continue;
        }
        if skipping {
            if trimmed == SYNC_IGNORE_END {
                skipping = false;
            }
            continue;
        }
        kept.push(line.trim_end_matches('\r'));
    }
    while kept.last().is_some_and(|line| line.is_empty()) {
        kept.pop();
    }
    let patterns = scope_ignore_patterns(scope);
    if patterns.is_empty() {
        if kept.is_empty() {
            return String::new();
        }
        let mut body = kept.join("\n");
        body.push('\n');
        return body;
    }
    let mut body = String::new();
    if !kept.is_empty() {
        body.push_str(&kept.join("\n"));
        body.push_str("\n\n");
    }
    body.push_str(SYNC_IGNORE_START);
    body.push('\n');
    for pattern in patterns {
        body.push_str(pattern);
        body.push('\n');
    }
    body.push_str(SYNC_IGNORE_END);
    body.push('\n');
    body
}

fn stdout_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn stderr_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

fn checked(output: Output, op: &str) -> Result<Output, AppError> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(git_error(op, &output))
    }
}

fn git_error(op: &str, output: &Output) -> AppError {
    let stderr = stderr_text(output);
    let detail = if stderr.is_empty() {
        format!("exit {}", output.status)
    } else {
        truncate(&stderr, 500)
    };
    AppError::domain(classify_git_error(&stderr), format!("{op}: {detail}"))
}

fn classify_git_error(stderr: &str) -> &'static str {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("index.lock") {
        "git_index_locked"
    } else if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("permission denied (publickey)")
        || lower.contains("terminal prompts disabled")
        || lower.contains("host key verification failed")
    {
        "git_auth_failed"
    } else if lower.contains("ssl") || lower.contains("certificate") || lower.contains("tls") {
        "git_tls_failed"
    } else {
        "git_failed"
    }
}

/// `git -c http.sslCAInfo=<path>` before the subcommand. Empty means the
/// system trust store. Never passes `http.sslVerify=false`.
fn http_ssl_ca_args(ca: Option<&str>) -> Vec<std::ffi::OsString> {
    let Some(ca) = ca.map(str::trim).filter(|ca| !ca.is_empty()) else {
        return Vec::new();
    };
    let mut setting = std::ffi::OsString::from("http.sslCAInfo=");
    setting.push(ca);
    vec!["-c".into(), setting]
}

fn is_push_race(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("stale info")
        || lower.contains("remote contains work that you do not have")
}

fn parse_name_status(bytes: &[u8]) -> DiffCounts {
    let mut counts = DiffCounts::default();
    let mut fields = bytes
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8_lossy(field).to_string())
        .filter(|field| !field.is_empty());
    while let Some(status) = fields.next() {
        let deleted = status.starts_with('D');
        if status.starts_with('R') || status.starts_with('C') {
            let _ = fields.next();
            let _ = fields.next();
        } else {
            let _ = fields.next();
        }
        if deleted {
            counts.deleted += 1;
        } else {
            counts.changed += 1;
        }
    }
    counts
}

fn conflicted_paths(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8_lossy(field).to_string())
        .filter(|field| !field.is_empty())
        .take(10)
        .collect()
}

fn truncate(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

fn now() -> String {
    crate::time::now_rfc3339_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn classifies_auth_and_tls_failures() {
        assert_eq!(
            classify_git_error("fatal: Authentication failed for 'https://example.com/'"),
            "git_auth_failed"
        );
        assert_eq!(
            classify_git_error(
                "fatal: could not read Username for 'https://example.com': terminal prompts disabled"
            ),
            "git_auth_failed"
        );
        assert_eq!(
            classify_git_error("SSL certificate problem: self-signed certificate"),
            "git_tls_failed"
        );
        assert_eq!(classify_git_error("nothing to commit"), "git_failed");
    }

    #[test]
    fn ssl_ca_args_are_a_single_config_assignment() {
        assert!(http_ssl_ca_args(None).is_empty());
        assert!(http_ssl_ca_args(Some("  ")).is_empty());
        let args = http_ssl_ca_args(Some(r"C:\certs\lan ca.pem"));
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "-c");
        assert_eq!(args[1], r"http.sslCAInfo=C:\certs\lan ca.pem");
    }

    fn git_exe() -> Option<PathBuf> {
        crate::process::resolve_command("git")
    }

    fn run_git(cwd: &Path, args: &[&str]) -> Output {
        let mut command = std::process::Command::new(git_exe().expect("git available"));
        command
            .current_dir(cwd)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C");
        for key in SCRUB_ENV {
            command.env_remove(key);
        }
        crate::process::hide_console_window(&mut command);
        command.output().expect("run git")
    }

    fn run_git_ok(cwd: &Path, args: &[&str]) -> String {
        let out = run_git(cwd, args);
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn init_bare(root: &Path) -> PathBuf {
        let remote = root.join("remote.git");
        let out = std::process::Command::new(git_exe().expect("git available"))
            .args(["init", "--bare"])
            .arg(&remote)
            .output()
            .expect("git init --bare");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        remote
    }

    fn git_cfg(remote: &Path) -> SyncBackendConfig {
        SyncBackendConfig {
            backend: crate::features::sync::config::SyncBackendKind::Git,
            git_remote: url::Url::from_directory_path(remote)
                .expect("file url")
                .to_string(),
            git_branch: "main".into(),
            auto_sync: false,
            ..SyncBackendConfig::default()
        }
        .normalized()
    }

    fn noop_progress() -> &'static (dyn Fn(&str, usize, usize) + Send + Sync) {
        &|_, _, _| {}
    }

    fn remote_count(remote: &Path) -> usize {
        run_git_ok(
            remote.parent().expect("remote parent"),
            &[
                "--git-dir",
                remote.to_str().expect("utf8 remote"),
                "rev-list",
                "--count",
                "main",
            ],
        )
        .parse()
        .expect("commit count")
    }

    fn write_paper(vault: &Path, body: &str) {
        fs::create_dir_all(vault.join("papers/x")).unwrap();
        fs::write(vault.join("papers/x/NOTES.md"), body).unwrap();
        fs::write(vault.join("papers/x/metadata.json"), r#"{"id":"x"}"#).unwrap();
    }

    #[tokio::test]
    async fn git_sync_publishes_and_joins_without_agentero() {
        if git_exe().is_none() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = init_bare(tmp.path());
        let cfg = git_cfg(&remote);
        let a = tmp.path().join("a");
        fs::create_dir_all(a.join(".agentero")).unwrap();
        write_paper(&a, "# x\n");
        crate::features::paper::catalog::ensure_catalog(&a).unwrap();

        let up = sync_vault(&a, &cfg, noop_progress()).await.unwrap();
        assert!(up.uploaded >= 2, "{up:?}");

        let tree = run_git_ok(
            tmp.path(),
            &[
                "--git-dir",
                remote.to_str().expect("utf8 remote"),
                "ls-tree",
                "-r",
                "--name-only",
                "main",
            ],
        );
        assert!(tree.contains("papers/x/NOTES.md"));
        assert!(!tree.contains(".agentero"));

        let b = tmp.path().join("b");
        fs::create_dir_all(&b).unwrap();
        let down = sync_vault(&b, &cfg, noop_progress()).await.unwrap();
        assert!(down.downloaded >= 2, "{down:?}");
        assert_eq!(
            fs::read_to_string(b.join("papers/x/NOTES.md")).unwrap(),
            "# x\n"
        );
    }

    #[tokio::test]
    async fn git_sync_roundtrips_edits_and_idles() {
        if git_exe().is_none() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = init_bare(tmp.path());
        let cfg = git_cfg(&remote);
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        fs::create_dir_all(&a).unwrap();
        write_paper(&a, "# x\n");
        sync_vault(&a, &cfg, noop_progress()).await.unwrap();
        fs::create_dir_all(&b).unwrap();
        sync_vault(&b, &cfg, noop_progress()).await.unwrap();

        fs::write(b.join("papers/x/NOTES.md"), "# x\nedited\n").unwrap();
        sync_vault(&b, &cfg, noop_progress()).await.unwrap();
        sync_vault(&a, &cfg, noop_progress()).await.unwrap();
        assert!(fs::read_to_string(a.join("papers/x/NOTES.md"))
            .unwrap()
            .contains("edited"));

        let head = run_git_ok(&a, &["rev-parse", "HEAD"]);
        let commits = remote_count(&remote);
        let idle = sync_vault(&a, &cfg, noop_progress()).await.unwrap();
        assert_eq!(idle.uploaded, 0);
        assert_eq!(idle.downloaded, 0);
        assert_eq!(run_git_ok(&a, &["rev-parse", "HEAD"]), head);
        assert_eq!(remote_count(&remote), commits, "idle pass published");
    }

    #[test]
    fn sync_gitignore_block_is_idempotent_and_preserves_user_rules() {
        let mut scope = SyncScope::all();
        scope.pdf = false;
        scope.source = false;
        let once = sync_gitignore("*.log\n", &scope);
        assert_eq!(sync_gitignore(&once, &scope), once);
        assert!(once.starts_with("*.log\n\n# agentero-sync-start\n"));
        assert!(once.contains("papers/*/*.pdf\n"));
        assert!(once.contains("papers/*/source/\n"));
        assert!(!once.contains("attachments"));
        assert_eq!(sync_gitignore(&once, &SyncScope::all()), "*.log\n");
        assert_eq!(sync_gitignore("", &SyncScope::all()), "");
    }

    #[tokio::test]
    async fn git_sync_leaves_excluded_pdf_out_of_the_repository() {
        if git_exe().is_none() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = init_bare(tmp.path());
        let mut cfg = git_cfg(&remote);
        cfg.scope.pdf = false;
        let a = tmp.path().join("a");
        fs::create_dir_all(a.join("papers/x/source")).unwrap();
        write_paper(&a, "# x\n");
        fs::write(a.join("papers/x/x.pdf"), b"%PDF-local").unwrap();
        fs::write(a.join("papers/x/source/main.tex"), b"tex").unwrap();

        sync_vault(&a, &cfg, noop_progress()).await.unwrap();

        let tree = run_git_ok(
            tmp.path(),
            &[
                "--git-dir",
                remote.to_str().expect("utf8 remote"),
                "ls-tree",
                "-r",
                "--name-only",
                "main",
            ],
        );
        assert!(tree.contains("papers/x/NOTES.md"), "{tree}");
        assert!(tree.contains("papers/x/source/main.tex"), "{tree}");
        assert!(tree.contains(".gitignore"), "{tree}");
        assert!(!tree.contains("papers/x/x.pdf"), "{tree}");
        assert_eq!(fs::read(a.join("papers/x/x.pdf")).unwrap(), b"%PDF-local");

        fs::write(a.join("papers/x/x.pdf"), b"%PDF-edited").unwrap();
        fs::write(a.join("papers/x/NOTES.md"), "# x\nrevised\n").unwrap();
        sync_vault(&a, &cfg, noop_progress()).await.unwrap();
        let tree = run_git_ok(
            tmp.path(),
            &[
                "--git-dir",
                remote.to_str().expect("utf8 remote"),
                "ls-tree",
                "-r",
                "--name-only",
                "main",
            ],
        );
        assert!(!tree.contains("papers/x/x.pdf"), "{tree}");
        assert_eq!(fs::read(a.join("papers/x/x.pdf")).unwrap(), b"%PDF-edited");

        let b = tmp.path().join("b");
        fs::create_dir_all(&b).unwrap();
        sync_vault(&b, &cfg, noop_progress()).await.unwrap();
        assert!(!b.join("papers/x/x.pdf").exists());
        assert!(fs::read_to_string(b.join("papers/x/NOTES.md"))
            .unwrap()
            .contains("revised"));
    }

    #[tokio::test]
    async fn git_sync_reports_native_merge_conflict_without_losing_local() {
        if git_exe().is_none() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = init_bare(tmp.path());
        let cfg = git_cfg(&remote);
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        fs::create_dir_all(&a).unwrap();
        write_paper(&a, "# x\n");
        sync_vault(&a, &cfg, noop_progress()).await.unwrap();
        fs::create_dir_all(&b).unwrap();
        sync_vault(&b, &cfg, noop_progress()).await.unwrap();

        fs::write(a.join("papers/x/NOTES.md"), "# x\nA version\n").unwrap();
        fs::write(b.join("papers/x/NOTES.md"), "# x\nB version\n").unwrap();
        sync_vault(&a, &cfg, noop_progress()).await.unwrap();
        let err = sync_vault(&b, &cfg, noop_progress()).await.unwrap_err();
        assert_eq!(err.code(), "sync_conflict", "{err}");
        assert!(err.to_string().contains("papers/x/NOTES.md"), "{err}");
        let notes = fs::read_to_string(b.join("papers/x/NOTES.md"))
            .unwrap()
            .replace("\r\n", "\n");
        assert_eq!(notes, "# x\nB version\n");
        assert!(!run_git(&b, &["rev-parse", "--verify", "-q", "MERGE_HEAD"])
            .status
            .success());
    }

    #[tokio::test]
    async fn git_sync_merges_unrelated_histories() {
        if git_exe().is_none() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = init_bare(tmp.path());
        let cfg = git_cfg(&remote);
        let a = tmp.path().join("a");
        fs::create_dir_all(&a).unwrap();
        fs::write(a.join("remote.md"), "remote\n").unwrap();
        sync_vault(&a, &cfg, noop_progress()).await.unwrap();

        let b = tmp.path().join("b");
        fs::create_dir_all(&b).unwrap();
        fs::write(b.join("local.md"), "local\n").unwrap();
        sync_vault(&b, &cfg, noop_progress()).await.unwrap();

        assert_eq!(fs::read_to_string(b.join("remote.md")).unwrap(), "remote\n");
        sync_vault(&a, &cfg, noop_progress()).await.unwrap();
        assert_eq!(fs::read_to_string(a.join("local.md")).unwrap(), "local\n");
    }

    #[tokio::test]
    async fn git_sync_rejects_remote_that_tracks_agentero() {
        if git_exe().is_none() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = init_bare(tmp.path());
        let seed = tmp.path().join("seed");
        fs::create_dir_all(seed.join(".agentero")).unwrap();
        fs::write(seed.join(".agentero/catalog.sqlite"), b"db").unwrap();
        run_git_ok(&seed, &["init"]);
        run_git_ok(&seed, &["checkout", "-b", "main"]);
        run_git_ok(&seed, &["add", "-A"]);
        run_git_ok(
            &seed,
            &[
                "-c",
                "user.name=Seed",
                "-c",
                "user.email=seed@example.com",
                "commit",
                "-m",
                "seed",
            ],
        );
        let remote_url = url::Url::from_directory_path(&remote).unwrap().to_string();
        run_git_ok(&seed, &["remote", "add", "origin", &remote_url]);
        run_git_ok(&seed, &["push", "origin", "main"]);

        let vault = tmp.path().join("vault");
        fs::create_dir_all(&vault).unwrap();
        let err = sync_vault(&vault, &git_cfg(&remote), noop_progress())
            .await
            .unwrap_err();
        assert_eq!(err.code(), "git_agentero_tracked", "{err}");
    }

    #[tokio::test]
    async fn git_test_connection_accepts_empty_local_vault() {
        if git_exe().is_none() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = init_bare(tmp.path());
        let vault = tmp.path().join("vault");
        fs::create_dir_all(&vault).unwrap();
        test_connection(&vault, &git_cfg(&remote)).await.unwrap();
    }
}
