use crate::core::error::AppError;
use crate::core::frontmatter::{frontmatter_block, scalar_field};
use crate::features::agent::models::{AgentSkill, AgentTemplate};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_SKILL_BYTES: u64 = 64 * 1024;
const MAX_SELECTED_SKILLS: usize = 5;

/// How a given Agent CLI expects skills to be activated in the **user-visible prompt**.
///
/// Agentero always *also* injects the full `SKILL.md` body (size-limited) so agents without
/// a native skill system still receive instructions. The mention style is for agents that
/// natively parse skill triggers (e.g. Codex `$skill-id`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillMentionStyle {
    /// Codex (and similar): `$paper-reader`
    Dollar,
    /// Claude Code style slash skills / commands: `/paper-reader`
    Slash,
    /// No native trigger — Agentero injects body only; do not pretend `$`/`/` activate anything.
    InjectedOnly,
}

/// Map Agentero agent template → native skill mention style.
pub fn skill_mention_style(template: &AgentTemplate) -> SkillMentionStyle {
    match template {
        AgentTemplate::CodexAcp => SkillMentionStyle::Dollar,
        // pi-acp exposes skills as `/skill:<name>`, so a bare `/<name>` would name a
        // command that does not exist — rely on body injection instead.
        AgentTemplate::Pi => SkillMentionStyle::InjectedOnly,
        // All other agents use slash-style skill mentions.
        AgentTemplate::ClaudeAcp
        | AgentTemplate::Opencode
        | AgentTemplate::OpenClaw
        | AgentTemplate::Gemini
        | AgentTemplate::Hermes
        | AgentTemplate::QoderCli
        | AgentTemplate::GrokBuild
        | AgentTemplate::Dsh
        | AgentTemplate::KimiCode
        | AgentTemplate::Custom => SkillMentionStyle::Slash,
    }
}

/// Format a single skill id the way this agent expects (or a neutral label).
pub fn format_skill_mention(skill_id: &str, style: SkillMentionStyle) -> String {
    match style {
        SkillMentionStyle::Dollar => format!("${skill_id}"),
        SkillMentionStyle::Slash => format!("/{skill_id}"),
        SkillMentionStyle::InjectedOnly => format!("skill:{skill_id}"),
    }
}

/// Leading user-prompt line(s) that activate native skills when applicable.
/// Empty for InjectedOnly (body injection carries the instructions).
pub fn skill_activation_prefix(skill_ids: &[String], style: SkillMentionStyle) -> String {
    if skill_ids.is_empty() {
        return String::new();
    }
    match style {
        SkillMentionStyle::Dollar | SkillMentionStyle::Slash => {
            let mentions: Vec<String> = skill_ids
                .iter()
                .map(|id| format_skill_mention(id, style))
                .collect();
            format!("{}\n\n", mentions.join(" "))
        }
        SkillMentionStyle::InjectedOnly => String::new(),
    }
}

fn skill_roots(vault_path: Option<&str>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    // Vault-local skills first (highest priority when same id exists later roots are skipped).
    if let Some(vault) = vault_path.map(Path::new).filter(|path| path.is_dir()) {
        roots.push(vault.join(".agents/skills"));
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".agents/skills"));
        roots.push(
            std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
                .join("skills"),
        );
        // Claude Code / Claude Desktop user skills (e.g. paper-reader).
        roots.push(home.join(".claude/skills"));
    }
    roots
}

fn parse_skill_metadata(content: &str, fallback_name: &str) -> (String, String) {
    let Some(front_matter) = frontmatter_block(content) else {
        return (fallback_name.to_string(), String::new());
    };
    let name = scalar_field(front_matter, "name").unwrap_or_else(|| fallback_name.to_string());
    let description = scalar_field(front_matter, "description").unwrap_or_default();
    (name, description)
}

fn skill_candidates(vault_path: Option<&str>) -> Vec<(String, PathBuf)> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for root in skill_roots(vault_path) {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            let path = entry.path().join("SKILL.md");
            if path.is_file() {
                candidates.push((id, path));
            }
        }
    }
    candidates
}

pub fn list_agent_skills(vault_path: Option<&str>) -> Vec<AgentSkill> {
    skill_candidates(vault_path)
        .into_iter()
        .filter_map(|(id, path)| {
            let content = fs::read_to_string(path).ok()?;
            let (name, description) = parse_skill_metadata(&content, &id);
            Some(AgentSkill {
                id,
                name,
                description,
            })
        })
        .collect()
}

fn skill_block_heading(skill_id: &str, style: SkillMentionStyle) -> String {
    match style {
        SkillMentionStyle::Dollar => format!("### ${skill_id}"),
        SkillMentionStyle::Slash => format!("### /{skill_id}"),
        SkillMentionStyle::InjectedOnly => format!("### skill:{skill_id}"),
    }
}

fn skill_section_preamble(style: SkillMentionStyle, skill_ids: &[String]) -> String {
    let mentions: Vec<String> = skill_ids
        .iter()
        .map(|id| format_skill_mention(id, style))
        .collect();
    let list = mentions.join(", ");
    match style {
        SkillMentionStyle::Dollar => format!(
            "\n\n## Active local skills\n\
             This agent activates skills with the **$skill-id** syntax (e.g. {list}).\n\
             Prefer following the agent's native skill if it resolves the same id; \
             otherwise follow the full SKILL.md text Agentero injects below.\n\n"
        ),
        SkillMentionStyle::Slash => format!(
            "\n\n## Active local skills\n\
             This agent typically activates skills/commands with the **/skill-id** syntax (e.g. {list}).\n\
             Prefer the native skill when available; otherwise follow the full SKILL.md text Agentero injects below.\n\n"
        ),
        SkillMentionStyle::InjectedOnly => format!(
            "\n\n## Active local skills (Agentero-injected)\n\
             This agent does **not** use Agentero Composer `$` as a runtime skill trigger. \
             Follow the SKILL.md instructions Agentero injects below for: {list}.\n\
             Do not wait for a separate $ or / command — the instructions are already in this prompt.\n\n"
        ),
    }
}

/// Load SKILL.md bodies and format them for the given agent skill-mention style.
pub fn load_skill_instructions(
    skill_ids: &[String],
    vault_path: Option<&str>,
    style: SkillMentionStyle,
) -> Result<String, AppError> {
    if skill_ids.len() > MAX_SELECTED_SKILLS {
        return Err(AppError::message(format!(
            "at most {MAX_SELECTED_SKILLS} skills can be used in one prompt"
        )));
    }
    let candidates = skill_candidates(vault_path);
    let mut blocks = Vec::new();
    for skill_id in skill_ids {
        let Some((_, path)) = candidates.iter().find(|(id, _)| id == skill_id) else {
            return Err(AppError::message(format!(
                "local skill `{skill_id}` was not found"
            )));
        };
        let metadata = fs::metadata(path).map_err(AppError::Io)?;
        if metadata.len() > MAX_SKILL_BYTES {
            return Err(AppError::message(format!(
                "local skill `{skill_id}` exceeds {MAX_SKILL_BYTES} bytes"
            )));
        }
        let content = fs::read_to_string(path).map_err(AppError::Io)?;
        blocks.push(format!(
            "{}\n{content}",
            skill_block_heading(skill_id, style)
        ));
    }
    if blocks.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!(
            "{}{}",
            skill_section_preamble(style, skill_ids),
            blocks.join("\n\n")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::agent::models::AgentTemplate;

    #[test]
    fn parses_skill_front_matter() {
        let (name, description) = parse_skill_metadata(
            "---\nname: example\ndescription: Useful instructions\n---\n# Body",
            "fallback",
        );
        assert_eq!(name, "example");
        assert_eq!(description, "Useful instructions");
    }

    #[test]
    fn parses_bundled_folded_description() {
        let bundled =
            include_str!("../../../../../templates/vault/.agents/skills/paper-reader/SKILL.md");
        let (name, description) = parse_skill_metadata(bundled, "paper-reader");
        assert_eq!(name, "paper-reader");
        assert!(description.starts_with("Read and explain a research paper"));
    }

    #[test]
    fn codex_uses_dollar_mentions() {
        assert_eq!(
            skill_mention_style(&AgentTemplate::CodexAcp),
            SkillMentionStyle::Dollar
        );
        assert_eq!(
            format_skill_mention("paper-reader", SkillMentionStyle::Dollar),
            "$paper-reader"
        );
    }

    #[test]
    fn claude_uses_slash_mentions() {
        assert_eq!(
            skill_mention_style(&AgentTemplate::ClaudeAcp),
            SkillMentionStyle::Slash
        );
        assert_eq!(
            format_skill_mention("paper-reader", SkillMentionStyle::Slash),
            "/paper-reader"
        );
    }

    #[test]
    fn generic_agents_use_slash_mentions() {
        assert_eq!(
            skill_mention_style(&AgentTemplate::Opencode),
            SkillMentionStyle::Slash
        );
        assert!(
            skill_activation_prefix(&["paper-reader".into()], SkillMentionStyle::Slash)
                .contains("/paper-reader")
        );
    }
}
