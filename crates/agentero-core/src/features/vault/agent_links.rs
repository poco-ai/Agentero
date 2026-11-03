//! Vault-side Skill visibility for agent CLIs with their own skill layout.
//!
//! Claude Code only scans `~/.claude/skills/` and the project's `.claude/skills/`
//! (https://code.claude.com/docs/en/skills), so a Vault's `.agents/skills/`
//! packages stay invisible to it. One directory link fixes that without copying.

use crate::process::resolve_command;
use std::fs;
use std::io;
use std::path::Path;

/// Vault-relative skill root every agent layout is fed from.
const VAULT_SKILLS_REL: &str = ".agents/skills";

/// Where Claude Code's project-skill loader looks, relative to the vault root.
const CLAUDE_SKILLS_REL: &str = ".claude/skills";

/// Link target as written when `.claude/skills` sits next to `.agents/skills`.
const CLAUDE_SKILLS_TARGET: &str = "../.agents/skills";

/// Point the Vault's Skills at the layout each installed agent CLI expects.
///
/// Returns the vault-relative link created, or `None` when there was nothing to
/// do or the attempt failed. Best-effort by design: [`super::ensure_vault`]
/// calls this on every open, so a failure must never block vault scaffolding.
pub fn ensure_vault_agent_links(vault: &Path) -> Option<String> {
    ensure_claude_skills_link(vault, resolve_command("claude").is_some())
}

/// Claude Code resolves skills with `readdirSync(…, { withFileTypes: true })`
/// and keeps only `dirent.isDirectory()` entries, which reports `false` for a
/// symlinked skill directory — so `.agents/skills` goes in as one directory
/// link, not one link per skill. An existing entry is never replaced: a real
/// `.claude/skills` the user owns wins over ours.
fn ensure_claude_skills_link(vault: &Path, claude_available: bool) -> Option<String> {
    if !claude_available {
        return None;
    }
    let skills = vault.join(VAULT_SKILLS_REL);
    if !skills.is_dir() {
        return None;
    }
    let link = vault.join(CLAUDE_SKILLS_REL);
    // `symlink_metadata`: a dangling link still occupies the path.
    if link.symlink_metadata().is_ok() {
        return None;
    }
    let created = link
        .parent()
        .ok_or_else(|| io::Error::other("link path has no parent"))
        .and_then(fs::create_dir_all)
        .and_then(|()| create_dir_link(Path::new(CLAUDE_SKILLS_TARGET), &skills, &link));
    match created {
        Ok(()) => {
            log::info!(
                target: "agentero::vault",
                "linked {CLAUDE_SKILLS_REL} -> {CLAUDE_SKILLS_TARGET} for Claude Code"
            );
            Some(CLAUDE_SKILLS_REL.to_string())
        }
        Err(error) => {
            log::warn!(
                target: "agentero::vault",
                "failed to link {CLAUDE_SKILLS_REL} for Claude Code: {error}"
            );
            None
        }
    }
}

/// Relative targets keep the link valid when the Vault is moved or renamed.
#[cfg(unix)]
fn create_dir_link(rel_target: &Path, _abs_target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(rel_target, link)
}

/// A real directory symlink needs Developer Mode or elevation; a junction is a
/// plain reparse point any user can create, at the cost of an absolute target.
///
/// The stored target must use `\`. A link created with `/` can exist and still
/// fail to resolve, so a successful `symlink_dir` is kept only when the target
/// can be read.
#[cfg(windows)]
fn create_dir_link(rel_target: &Path, abs_target: &Path, link: &Path) -> io::Result<()> {
    let windows_target = rel_target.to_string_lossy().replace('/', "\\");
    if std::os::windows::fs::symlink_dir(&windows_target, link).is_ok()
        && fs::metadata(link).is_ok()
    {
        return Ok(());
    }
    if link.symlink_metadata().is_ok() {
        let _ = fs::remove_dir(link);
        let _ = fs::remove_file(link);
    }
    create_junction(abs_target, link)
}

#[cfg(not(any(unix, windows)))]
fn create_dir_link(_rel_target: &Path, _abs_target: &Path, _link: &Path) -> io::Result<()> {
    Err(io::Error::other(
        "directory links are not supported on this platform",
    ))
}

#[cfg(windows)]
fn create_junction(target: &Path, link: &Path) -> io::Result<()> {
    use std::process::Command;

    // `mklink` needs existing absolute paths and rejects the `\\?\` prefix that
    // `canonicalize` returns for drive paths. The link itself does not exist yet,
    // so resolve its parent and keep the file name.
    let link_name = link
        .file_name()
        .ok_or_else(|| io::Error::other("link path has no file name"))?;
    let link_abs = crate::process::windows_shell_path(
        &link
            .parent()
            .ok_or_else(|| io::Error::other("link path has no parent"))?
            .canonicalize()?,
    )
    .join(link_name);
    let target_abs = crate::process::windows_shell_path(&target.canonicalize()?);

    let mut command = Command::new("cmd");
    command
        .arg("/D")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(&link_abs)
        .arg(&target_abs);
    crate::process::hide_console_window(&mut command);
    let output = command.output()?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    Err(io::Error::other(if detail.is_empty() {
        format!("mklink /J exited with {:?}", output.status.code())
    } else {
        format!("mklink /J failed: {detail}")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::path::PathBuf;

    fn temp_vault(case: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "agentero-agent-links-{}-{case}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(VAULT_SKILLS_REL).join("x")).unwrap();
        fs::write(dir.join(VAULT_SKILLS_REL).join("x/SKILL.md"), "# x\n").unwrap();
        dir
    }

    /// The property Claude Code's loader checks: entries read through the link
    /// must be real directories, not directory links.
    fn linked_skill_is_a_real_dir(vault: &Path) -> bool {
        fs::read_dir(vault.join(CLAUDE_SKILLS_REL))
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name() == "x" && entry.file_type().is_ok_and(|t| t.is_dir()))
    }

    #[test]
    fn links_the_vault_skill_root_when_claude_is_available() {
        let vault = temp_vault("claude-present");
        assert_eq!(
            ensure_claude_skills_link(&vault, true).as_deref(),
            Some(CLAUDE_SKILLS_REL)
        );
        assert!(vault.join(".claude/skills/x/SKILL.md").is_file());
        assert!(linked_skill_is_a_real_dir(&vault));
        #[cfg(unix)]
        assert_eq!(
            fs::read_link(vault.join(CLAUDE_SKILLS_REL)).unwrap(),
            PathBuf::from(CLAUDE_SKILLS_TARGET)
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn skips_when_claude_is_unavailable() {
        let vault = temp_vault("claude-absent");
        assert_eq!(ensure_claude_skills_link(&vault, false), None);
        assert!(vault.join(".claude").symlink_metadata().is_err());
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn keeps_a_user_owned_skills_dir() {
        let vault = temp_vault("user-owned");
        fs::create_dir_all(vault.join(CLAUDE_SKILLS_REL)).unwrap();
        fs::write(vault.join(CLAUDE_SKILLS_REL).join("mine.md"), "# mine\n").unwrap();

        assert_eq!(ensure_claude_skills_link(&vault, true), None);
        assert!(vault
            .join(CLAUDE_SKILLS_REL)
            .symlink_metadata()
            .unwrap()
            .is_dir());
        assert!(vault.join(CLAUDE_SKILLS_REL).join("mine.md").is_file());
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn is_idempotent() {
        let vault = temp_vault("idempotent");
        assert!(ensure_claude_skills_link(&vault, true).is_some());
        assert_eq!(ensure_claude_skills_link(&vault, true), None);
        assert!(linked_skill_is_a_real_dir(&vault));
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn skips_without_a_skill_root() {
        let dir =
            env::temp_dir().join(format!("agentero-agent-links-{}-empty", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        assert_eq!(ensure_claude_skills_link(&dir, true), None);
        assert!(dir.join(".claude").symlink_metadata().is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
