use crate::features::agent::prompt::skills::{format_skill_mention, SkillMentionStyle};

/// Build a workflow-oriented prompt. Vault-relative guidance is progressive-disclosure oriented.
///
/// `skill_style` / `skill_ids` shape wording for skill activation — different CLIs use
/// different triggers (Codex `$id`, Claude `/id`, others Agentero-injected body only).
pub fn build_prompt(
    workflow: Option<&str>,
    user_prompt: &str,
    target: Option<&str>,
    skill_style: SkillMentionStyle,
    skill_ids: &[String],
    response_language: Option<&str>,
    personal_prompt: Option<&str>,
) -> String {
    let workflow = workflow.unwrap_or("free");
    let target_line = target
        .map(|t| format!("Target path (Vault-relative): `{t}`\n"))
        .unwrap_or_default();

    // Translation is a closed transform. The caller already puts engine rules
    // first and the source text last. Prefixing "User request:" makes the
    // model treat that as a chat turn and ask what the user wants.
    // `language_directive` and the personal prompt would also override the
    // requested target language.
    if workflow == "translate" {
        return format!("{target_line}{user_prompt}");
    }

    // Vault layout, reading order, citations, and CLI policy live in `AGENTS.md`
    // (cwd = vault root) and selected skills. Envelope only sets the turn role.
    // Skill activation wording is not duplicated here for free/qa/etc. — that lives in
    // `skill_activation_prefix` + injected SKILL.md; paper_reader keeps its activation line.
    let system = match workflow {
        "summary" => {
            "You are helping with a research vault. Summarize the target paper \
             (follow vault AGENTS.md for reading order and citations)."
                .to_string()
        }
        "paper_reader" => {
            let skill_line = paper_reader_skill_line(skill_style, skill_ids);
            format!(
                "You are running the Agentero paper-reader workflow. {skill_line} \
                 Target is a paper folder under papers/; write lecture notes to that paper's NOTES.md."
            )
        }
        "qa" => {
            "You are answering questions about a local research vault \
             (follow vault AGENTS.md; read only what you need)."
                .to_string()
        }
        "related_work" => {
            "Draft a Related Work section from local papers in this Vault \
             (prefer each paper's NOTES.md; follow vault AGENTS.md)."
                .to_string()
        }
        _ => {
            "You are an assistant working inside a Agentero research Vault (cwd is the vault root). \
             Follow vault AGENTS.md."
                .to_string()
        }
    };

    let system = format!(
        "{system}{}{}{}",
        language_directive(response_language),
        personal_preference_directive(personal_prompt),
        ui_blocks_guidance()
    );

    format!("{system}\n\n{target_line}User request:\n{user_prompt}")
}

/// Short pointer to the bundled `openui-blocks` skill. The full catalog lives
/// in `templates/vault/.agents/skills/openui-blocks/SKILL.md` and is generated
/// from the frontend catalog, so it scales without growing every system prompt.
/// The frontend render switch is `AGENT_OPENUI_BLOCKS_ENABLED` in
/// `src/lib/agent/openui/config.ts`; when it is off, fenced blocks still render
/// as ordinary Markdown, so this pointer stays harmless.
const UI_BLOCKS_GUIDANCE: &str = include_str!("openui_guidance.generated.txt");

fn ui_blocks_guidance() -> String {
    format!("\n\n{}", UI_BLOCKS_GUIDANCE.trim())
}

/// Marker Host always inserts before the real user text in `build_prompt`.
pub const USER_REQUEST_MARKER: &str = "User request:\n";

/// Codex injects a separate user turn with only this block; never show it in Chat.
fn strip_environment_context_blocks(text: &str) -> String {
    let mut out = text.to_string();
    // Repeatedly remove <environment_context>…</environment_context> (and self-closing variants).
    loop {
        let lower = out.to_ascii_lowercase();
        let Some(start) = lower.find("<environment_context") else {
            break;
        };
        let after_open = &out[start..];
        let close = after_open
            .to_ascii_lowercase()
            .find("</environment_context>")
            .map(|i| start + i + "</environment_context>".len());
        let end = close.unwrap_or(out.len());
        out = format!("{}{}", &out[..start], &out[end..]);
    }
    out
}

fn looks_like_machine_only_user_turn(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    // Pure Codex environment / permissions / skill dumps.
    if lower.starts_with("<environment_context") && lower.contains("</environment_context>") {
        let without = strip_environment_context_blocks(t);
        if without.trim().is_empty() {
            return true;
        }
    }
    if lower.starts_with("<permissions instructions>")
        || lower.starts_with("<skills_instructions>")
        || lower.starts_with("<multi_agent_mode>")
    {
        return true;
    }
    false
}

/// Recover the human-visible user text from a stored Agentero / Codex turn body.
/// Codex transcripts store environment_context turns and Host `build_prompt` envelopes;
/// the chat UI must show only the human request (or empty → skip the line).
pub fn strip_prompt_envelope_for_display(text: &str) -> String {
    let mut text = strip_environment_context_blocks(text.trim())
        .trim()
        .to_string();
    if text.is_empty() || looks_like_machine_only_user_turn(&text) {
        return String::new();
    }
    if let Some(idx) = text.rfind(USER_REQUEST_MARKER) {
        text = text[idx + USER_REQUEST_MARKER.len()..].trim().to_string();
        // Skill bodies are appended *after* the envelope; cut common injection headers.
        for marker in [
            "\n\n## Skill:",
            "\n\n# Skill:",
            "\n\n### Skill:",
            "\n\n<skill",
            "\n\nActive skills use the $ trigger",
            "\n\nActive skills use the / trigger",
            "\n\nAgentero injects skill instructions",
        ] {
            if let Some(cut) = text.find(marker) {
                text = text[..cut].trim().to_string();
            }
        }
        return text;
    }
    // Older / partial envelopes without the exact marker.
    for prefix in [
        "You are an assistant working inside a Agentero research Vault",
        "You are an assistant working inside a Motif research Vault",
        "You are running the Agentero paper-reader workflow",
        "You are helping with a research vault",
        "You are answering questions about a local research vault",
        "Draft a Related Work section from local papers",
    ] {
        if text.starts_with(prefix) {
            if let Some(rest) = text.rsplit("\n\n").next() {
                let rest = rest.trim();
                if !rest.is_empty() && rest != text && !looks_like_machine_only_user_turn(rest) {
                    return rest.to_string();
                }
            }
            // Preamble only — nothing human to show.
            return String::new();
        }
    }
    if looks_like_machine_only_user_turn(&text) {
        return String::new();
    }
    text
}

/// A trailing system instruction forcing the response/notes language.
/// Empty for unknown / `None` codes so `auto` keeps current behavior.
fn language_directive(code: Option<&str>) -> String {
    let name = match code {
        Some("zh-CN") => "Simplified Chinese (简体中文)",
        Some("en") => "English",
        _ => return String::new(),
    };
    format!(
        " Always write your entire response, including any notes saved to files, in {name}, \
         regardless of the language of the source material or this prompt."
    )
}

/// Optional free-form user preference block (Settings → Agent → personal prompt).
/// Empty / whitespace-only is omitted so the feature stays off by default.
fn personal_preference_directive(personal: Option<&str>) -> String {
    let Some(text) = personal.map(str::trim).filter(|s| !s.is_empty()) else {
        return String::new();
    };
    // Cap length so a hand-edited client cannot bloat every turn unboundedly.
    let text = if text.len() > 8000 {
        &text[..8000]
    } else {
        text
    };
    format!("\n\nUser preference instructions (always honor when relevant):\n{text}")
}

fn paper_reader_skill_line(style: SkillMentionStyle, skill_ids: &[String]) -> String {
    let id = skill_ids
        .first()
        .map(|s| s.as_str())
        .unwrap_or("paper-reader");
    let mention = format_skill_mention(id, style);
    match style {
        SkillMentionStyle::Dollar => format!(
            "Activate the skill with `{mention}` (this agent uses the **$skill-id** syntax). \
             Follow that skill strictly; Agentero also injects the full SKILL.md below if the runtime does not resolve it natively."
        ),
        SkillMentionStyle::Slash => format!(
            "Activate the skill with `{mention}` (this agent uses the **/skill-id** syntax). \
             Follow that skill strictly; Agentero also injects the full SKILL.md below if the runtime does not resolve it natively."
        ),
        SkillMentionStyle::InjectedOnly => format!(
            "Follow the **paper-reader** skill instructions Agentero injects in this prompt (label `{mention}`). \
             This agent does not use Agentero Composer `$` as a runtime skill trigger — do not wait for a separate $ or / command."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::agent::prompt::skills::SkillMentionStyle;

    #[test]
    fn build_prompt_includes_user() {
        let p = build_prompt(
            Some("qa"),
            "What is attention?",
            Some("papers/x/NOTES.md"),
            SkillMentionStyle::InjectedOnly,
            &[],
            None,
            None,
        );
        assert!(p.contains("What is attention?"));
        assert!(p.contains("papers/x/NOTES.md"));
    }

    #[test]
    fn envelope_defers_cli_and_citation_policy_to_agents_md() {
        // CLI / citation / reading-order details belong in vault AGENTS.md (+ skills),
        // not the per-turn Host envelope.
        let p = build_prompt(
            Some("free"),
            "Add this paper and download its PDF",
            None,
            SkillMentionStyle::InjectedOnly,
            &[],
            None,
            None,
        );
        assert!(p.contains("Follow vault AGENTS.md"));
        assert!(p.contains("Add this paper and download its PDF"));
        assert!(!p.contains("Agentero CLI policy"));
        assert!(!p.contains("agentero … --json"));
        assert!(!p.contains("Cite sources inline"));
        assert!(!p.contains("[Section 2.3](papers/<id>/<id>.pdf#section=2.3)"));
        assert!(!p.contains("progressive disclosure: AGENTS.md →"));
    }

    #[test]
    fn free_and_qa_omit_skill_follow_hint_when_skills_selected() {
        let skills = ["paper-reader".into()];
        for workflow in ["free", "qa", "summary", "related_work"] {
            let p = build_prompt(
                Some(workflow),
                "hello",
                None,
                SkillMentionStyle::Dollar,
                &skills,
                None,
                None,
            );
            assert!(
                !p.contains("Active skills use the $ trigger"),
                "{workflow} should not duplicate skill_follow_hint"
            );
            assert!(
                !p.contains("Agentero injects skill instructions for"),
                "{workflow} should not duplicate skill_follow_hint"
            );
        }
    }

    #[test]
    fn translate_workflow_adds_no_conflicting_envelope() {
        let p = build_prompt(
            Some("translate"),
            "Translate the text below into English. Return only the translation, without commentary.",
            None,
            SkillMentionStyle::InjectedOnly,
            &[],
            // A global response language must not override the requested target.
            Some("zh-CN"),
            Some("Prefer concise bullet points."),
        );
        assert!(p.contains("Return only the translation"));
        assert!(!p.contains("User request:"));
        assert!(!p.contains("## Sources"));
        assert!(!p.contains("Agentero CLI policy"));
        assert!(!p.contains("Simplified Chinese"));
        assert!(!p.contains("User preference instructions"));
        assert!(!p.contains("Structured UI blocks"));
        assert!(!p.contains("openui-blocks"));
        assert!(!p.contains("openui-lang"));
    }

    #[test]
    fn paper_reader_prompt_uses_dollar_for_codex_style() {
        let p = build_prompt(
            Some("paper_reader"),
            "Read this paper",
            Some("papers/1706.03762"),
            SkillMentionStyle::Dollar,
            &["paper-reader".into()],
            None,
            None,
        );
        assert!(p.contains("$paper-reader"));
        assert!(p.contains("$skill-id"));
        assert!(!p.contains("/paper-reader"));
    }

    #[test]
    fn paper_reader_prompt_uses_slash_for_claude_style() {
        let p = build_prompt(
            Some("paper_reader"),
            "Read this paper",
            Some("papers/1706.03762"),
            SkillMentionStyle::Slash,
            &["paper-reader".into()],
            None,
            None,
        );
        assert!(p.contains("/paper-reader"));
        assert!(p.contains("**/skill-id**") || p.contains("/skill-id"));
    }

    #[test]
    fn paper_reader_prompt_injected_only_avoids_false_dollar() {
        let p = build_prompt(
            Some("paper_reader"),
            "Read this paper",
            Some("papers/1706.03762"),
            SkillMentionStyle::InjectedOnly,
            &["paper-reader".into()],
            None,
            None,
        );
        assert!(p.contains("Agentero injects") || p.contains("does not use Agentero Composer `$`"));
        // Should not tell the agent to activate with $paper-reader as a runtime command
        assert!(!p.contains("Activate the skill with `$paper-reader`"));
    }

    #[test]
    fn response_language_injects_directive() {
        let p = build_prompt(
            Some("paper_reader"),
            "Read this paper",
            Some("papers/1706.03762"),
            SkillMentionStyle::InjectedOnly,
            &["paper-reader".into()],
            Some("zh-CN"),
            None,
        );
        assert!(p.contains("Simplified Chinese"));
        assert!(p.contains("Always write your entire response"));
    }

    #[test]
    fn response_language_none_adds_no_directive() {
        let p = build_prompt(
            Some("free"),
            "Hello",
            None,
            SkillMentionStyle::InjectedOnly,
            &[],
            None,
            None,
        );
        assert!(!p.contains("Always write your entire response"));
    }

    #[test]
    fn personal_prompt_injects_block() {
        let p = build_prompt(
            Some("free"),
            "Hello",
            None,
            SkillMentionStyle::InjectedOnly,
            &[],
            None,
            Some("Prefer concise bullet points."),
        );
        assert!(p.contains("User preference instructions"));
        assert!(p.contains("Prefer concise bullet points."));
        // Still only human text after the marker for chat display.
        assert_eq!(strip_prompt_envelope_for_display(&p), "Hello");
    }

    #[test]
    fn personal_prompt_empty_adds_nothing() {
        let p = build_prompt(
            Some("free"),
            "Hello",
            None,
            SkillMentionStyle::InjectedOnly,
            &[],
            None,
            Some("   "),
        );
        assert!(!p.contains("User preference instructions"));
    }

    #[test]
    fn strip_prompt_envelope_keeps_user_text_only() {
        let p = build_prompt(
            Some("free"),
            "123 check rendering",
            None,
            SkillMentionStyle::InjectedOnly,
            &[],
            None,
            None,
        );
        assert!(p.contains("You are an assistant"));
        assert_eq!(strip_prompt_envelope_for_display(&p), "123 check rendering");
    }

    #[test]
    fn ui_blocks_guidance_is_injected_for_non_translate_workflows() {
        for workflow in ["free", "qa", "summary", "related_work", "paper_reader"] {
            let p = build_prompt(
                Some(workflow),
                "hello",
                None,
                SkillMentionStyle::InjectedOnly,
                &[],
                None,
                None,
            );
            assert!(
                p.contains(UI_BLOCKS_GUIDANCE.trim()),
                "{workflow} should include the read-only UI guidance"
            );
            assert!(
                p.matches("Structured UI blocks").count() == 1,
                "{workflow} should include the guidance exactly once"
            );
        }
    }

    #[test]
    fn free_prompt_with_ui_guidance_snapshot() {
        let p = build_prompt(
            Some("free"),
            "Hello",
            None,
            SkillMentionStyle::InjectedOnly,
            &[],
            None,
            None,
        );
        let expected = format!(
            "You are an assistant working inside a Agentero research Vault (cwd is the vault root). \
             Follow vault AGENTS.md.\n\n{}\n\nUser request:\nHello",
            UI_BLOCKS_GUIDANCE.trim()
        );
        assert_eq!(p, expected);
    }

    #[test]
    fn ui_blocks_guidance_snapshot_is_compact_and_read_only() {
        assert!(UI_BLOCKS_GUIDANCE.contains(".agents/skills/openui-blocks/SKILL.md"));
        assert!(UI_BLOCKS_GUIDANCE.contains("openui-lang"));
        assert!(UI_BLOCKS_GUIDANCE.contains("prefer Markdown"));
        assert!(UI_BLOCKS_GUIDANCE.contains("Components: Stack, Row, Card"));
        // The per-turn pointer stays flat as the skill grows.
        assert!(UI_BLOCKS_GUIDANCE.len() < 700);
    }

    #[test]
    fn strip_prompt_envelope_passthrough_plain() {
        assert_eq!(
            strip_prompt_envelope_for_display("just a normal message"),
            "just a normal message"
        );
    }

    #[test]
    fn strip_drops_codex_environment_context_only_turn() {
        let env = r#"<environment_context>
  <cwd>/Users/philfan/Downloads/paper</cwd>
  <shell>zsh</shell>
</environment_context>"#;
        assert_eq!(strip_prompt_envelope_for_display(env), "");
    }

    #[test]
    fn strip_removes_env_block_before_user_request() {
        let mixed = r#"<environment_context>
  <cwd>/tmp</cwd>
</environment_context>

You are an assistant working inside a Agentero research Vault.

User request:
hello world"#;
        assert_eq!(strip_prompt_envelope_for_display(mixed), "hello world");
    }
}
