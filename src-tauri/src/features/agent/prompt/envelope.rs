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

    // Translation is a closed transform: the caller's prompt already names the
    // target language and demands "only the translation". Every envelope piece
    // fights that — `## Sources` adds commentary, the CLI policy is irrelevant,
    // and `language_directive` would override the requested target language.
    if workflow == "translate" {
        return format!("{target_line}{USER_REQUEST_MARKER}{user_prompt}");
    }

    let skill_hint = skill_follow_hint(skill_style, skill_ids);

    let system = match workflow {
        "summary" => {
            format!(
                "You are helping with a research vault. Summarize the target paper using \
                 progressive disclosure: AGENTS.md → papers/<id>/NOTES.md → marks/ → \
                 PAPER.md → source/ (there is usually no root PAPERS.md; paper list lives in the app catalog). \
                 Keep [[wikilinks]]. End with a `## Sources` list of Vault-relative paths you read.{skill_hint}"
            )
        }
        "paper_reader" => {
            let skill_line = paper_reader_skill_line(skill_style, skill_ids);
            format!(
                "You are running the Agentero paper-reader workflow. {skill_line} \
                 Target is a paper folder under papers/. Prefer TeX under source/, else PAPER.md, \
                 else local PDF. Write structured lecture notes into that paper's NOTES.md. Keep [[wikilinks]]. \
                 End with `## Sources` of Vault-relative paths you read."
            )
        }
        "qa" => {
            format!(
                "You are answering questions about a local research vault. Read only what you need \
                 (AGENTS.md → papers/*/NOTES.md → …; root PAPERS.md is optional export only). \
                 Cite local paths. End with `## Sources`.{skill_hint}"
            )
        }
        "related_work" => {
            format!(
                "Draft a Related Work section from local papers in this Vault. Prefer each paper's NOTES.md \
                 under papers/; open PAPER.md/source only when needed. Keep [[wikilinks]] and end with `## Sources`.{skill_hint}"
            )
        }
        _ => {
            format!(
                "You are an assistant working inside a Agentero research Vault (cwd is the vault root). \
                 Prefer progressive disclosure of local Markdown. End substantial answers with `## Sources`.{skill_hint}"
            )
        }
    };

    let system = format!(
        "{system}{}{}{}",
        agentero_cli_directive(),
        language_directive(response_language),
        personal_preference_directive(personal_prompt)
    );

    format!("{system}\n\n{target_line}User request:\n{user_prompt}")
}

/// Keep structured Vault mutations on the public CLI, even when the optional
/// `agentero-cli` skill was not explicitly selected in the Composer.
fn agentero_cli_directive() -> &'static str {
    "\n\nAgentero CLI policy: for Vault/catalog operations, prefer the `agentero` CLI \
     with `--json` instead of manually creating paper folders or editing catalog data. \
     When asked to add/import a paper, run `agentero import id <arxiv|doi|url> --json`; \
     when asked to download a paper's assets, run `agentero paper download <path|id> --json`; \
     when asked to produce PAPER.md, run `agentero paper parse <path|id> --json`; \
     use `agentero paper list|get|paths --json` to discover catalog records and \
     `agentero paper tag ...` or `agentero paper set-read ...` for those catalog updates. \
     Read and edit the Markdown/source paths returned by the CLI directly when doing \
     research or notes. If `agentero` is unavailable, say so and fall back to the \
     Vault files; never invent catalog records."
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

fn skill_follow_hint(style: SkillMentionStyle, skill_ids: &[String]) -> String {
    if skill_ids.is_empty() {
        return String::new();
    }
    let list = skill_ids
        .iter()
        .map(|id| format_skill_mention(id, style))
        .collect::<Vec<_>>()
        .join(", ");
    match style {
        SkillMentionStyle::Dollar => format!(
            " Active skills use the $ trigger on this agent ({list}); also honor any Agentero-injected SKILL.md body."
        ),
        SkillMentionStyle::Slash => format!(
            " Active skills use the / trigger on this agent ({list}); also honor any Agentero-injected SKILL.md body."
        ),
        SkillMentionStyle::InjectedOnly => format!(
            " Agentero injects skill instructions for ({list}) into this prompt — follow them; do not expect a separate $ or / activation."
        ),
    }
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

/// True when `s` looks like a vault-relative file path (not prose).
fn looks_like_source_path(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() || t.contains(' ') && !t.contains('/') {
        return false;
    }
    // Reject pure prose / parenthetical notes.
    if t.starts_with('（') || t.starts_with('(') {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    if lower.ends_with(".md")
        || lower.ends_with(".tex")
        || lower.ends_with(".pdf")
        || lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".webp")
        || lower.ends_with(".gif")
        || lower.ends_with(".svg")
        || lower.ends_with(".json")
        || lower.ends_with(".bib")
        || lower.ends_with(".csv")
    {
        return t.contains('/') || !t.contains(' ');
    }
    // Directory-ish vault paths without extension.
    t.contains('/') && !t.contains('（') && !t.contains('(')
}

/// Pull the jump target out of a Sources bullet.
///
/// Agents often write:
/// - `` `papers/foo/PAPER.md`（§2.3，Figure 4）``
/// - `用户批注截图：`assets/image-….png``
/// - `- 'papers/a/NOTES.md'`
fn extract_path_from_source_line(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches(['-', '*', '•']).trim();
    if trimmed.is_empty() {
        return None;
    }

    // 1) First `...` segment that looks like a path (most common agent style).
    let mut rest = trimmed;
    while let Some(start) = rest.find('`') {
        let after = &rest[start + 1..];
        if let Some(end) = after.find('`') {
            let inner = after[..end].trim();
            if looks_like_source_path(inner) {
                return Some(inner.to_string());
            }
            rest = &after[end + 1..];
        } else {
            break;
        }
    }

    // 2) Wikilink [[path]] or [[path|alias]].
    if let Some(start) = trimmed.find("[[") {
        if let Some(rel) = trimmed[start + 2..].find("]]") {
            let inner = &trimmed[start + 2..start + 2 + rel];
            let path = inner.split('|').next().unwrap_or(inner).trim();
            if looks_like_source_path(path) {
                return Some(path.to_string());
            }
        }
    }

    // 3) Whole-line paired quotes.
    let mut cleaned = trimmed.to_string();
    if cleaned.len() >= 2 {
        let bytes = cleaned.as_bytes();
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if matches!((first, last), (b'\'', b'\'') | (b'"', b'"') | (b'`', b'`')) {
            cleaned = cleaned[1..cleaned.len() - 1].trim().to_string();
        }
    }
    cleaned = cleaned
        .trim_matches(|c: char| c == '\'' || c == '"' || c == '`')
        .trim()
        .to_string();

    // 4) Path token before Chinese/ASCII parenthetical note:
    //    papers/foo/PAPER.md（§2.3…）  or  papers/foo/NOTES.md (Experiments)
    if let Some(idx) = cleaned.find('（').or_else(|| cleaned.find(" (")) {
        let head = cleaned[..idx].trim();
        let head = head
            .trim_matches(|c: char| c == '\'' || c == '"' || c == '`')
            .trim();
        if looks_like_source_path(head) {
            return Some(head.to_string());
        }
    }

    // 5) Label prefix: "用户批注截图：assets/…" or "截图: path"
    for sep in ['：', ':'] {
        if let Some(idx) = cleaned.find(sep) {
            let tail = cleaned[idx + sep.len_utf8()..].trim();
            let tail = tail
                .trim_matches(|c: char| c == '\'' || c == '"' || c == '`')
                .trim();
            if looks_like_source_path(tail) {
                return Some(tail.to_string());
            }
        }
    }

    // 6) Trim trailing bracket tags like [blocked], [read], [failed], etc.
    if cleaned.ends_with(']') {
        if let Some(start) = cleaned.rfind('[') {
            let prefix = cleaned[..start].trim();
            if looks_like_source_path(prefix) {
                return Some(prefix.to_string());
            }
        }
    }

    if looks_like_source_path(&cleaned) {
        return Some(cleaned);
    }
    None
}

/// Recognize section headers that introduce agent source lists.
fn is_sources_section_header(line: &str) -> bool {
    let trimmed = line.trim();
    let lower = trimmed.to_lowercase();

    // Markdown headers of any depth that start a Sources section: # Sources,
    // ## Sources, ### Sources, ## Sources (3), ## Sources: etc.
    if lower.starts_with('#') {
        let rest = lower.trim_start_matches('#').trim();
        return rest == "sources"
            || rest.starts_with("sources ")
            || rest.starts_with("sources:")
            || rest.starts_with("sources(")
            || rest == "source"
            || rest.starts_with("source ")
            || rest.starts_with("source:")
            || rest.starts_with("source(")
            || rest == "来源"
            || rest.starts_with("来源 ")
            || rest.starts_with("来源(")
            || rest == "引用"
            || rest.starts_with("引用 ")
            || rest.starts_with("引用(")
            || rest.starts_with("读取文件");
    }

    // Plain "Sources" / "Source" / "来源" / "引用" line (no leading #).
    lower == "sources"
        || lower == "source"
        || lower == "来源"
        || lower == "引用"
        || trimmed.eq_ignore_ascii_case("sources:")
        || trimmed.eq_ignore_ascii_case("source:")
}

/// Best-effort extraction of local paths from agent text (Sources section or bare paths).
pub fn extract_sources(content: &str) -> Vec<String> {
    let mut sources = Vec::new();
    let mut in_sources = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if is_sources_section_header(trimmed) {
            in_sources = true;
            continue;
        }
        if in_sources {
            if trimmed.starts_with('#') {
                break;
            }
            if trimmed.is_empty() {
                continue;
            }
            if let Some(path) = extract_path_from_source_line(trimmed) {
                if !sources.iter().any(|s| s == &path) {
                    sources.push(path);
                }
            } else {
                // Non-source content ends the section.
                break;
            }
        }
    }
    sources
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::agent::prompt::skills::SkillMentionStyle;

    #[test]
    fn extracts_sources_section() {
        let text = "Answer here.\n\n## Sources\n- papers/a/NOTES.md\n- PAPERS.md\n";
        let s = extract_sources(text);
        assert!(s.iter().any(|p| p.contains("NOTES.md")));
        assert!(s.iter().any(|p| p == "PAPERS.md"));
    }

    #[test]
    fn extracts_sources_strips_quotes_and_wikilinks() {
        let text = "Answer.\n\n## Sources\n- 'papers/a/NOTES.md'\n- \"papers/b/PAPER.md\"\n- `papers/c/source/main.tex`\n- [[papers/d/NOTES.md|title]]\n- papers/e/NOTES.md'\n";
        let s = extract_sources(text);
        assert_eq!(
            s,
            vec![
                "papers/a/NOTES.md".to_string(),
                "papers/b/PAPER.md".to_string(),
                "papers/c/source/main.tex".to_string(),
                "papers/d/NOTES.md".to_string(),
                "papers/e/NOTES.md".to_string(),
            ]
        );
    }

    #[test]
    fn extracts_sources_with_inline_backticks_and_notes() {
        // Real agent style: path in backticks + Chinese parenthetical, or label：`path`.
        let text = "Answer.\n\n## Sources\n\
- `papers/Towards-Long-Horizon-Agent/PAPER.md`（§2.3，Eq. 2 与 Figure 4 上下文）\n\
- `papers/Towards-Long-Horizon-Agent/NOTES.md`（Experiments / Figure 4 解读）\n\
- 用户批注截图：`assets/image-38fac94f-4577-46b6-af56-bb4465f2bc13.png`\n";
        let s = extract_sources(text);
        assert_eq!(
            s,
            vec![
                "papers/Towards-Long-Horizon-Agent/PAPER.md".to_string(),
                "papers/Towards-Long-Horizon-Agent/NOTES.md".to_string(),
                "assets/image-38fac94f-4577-46b6-af56-bb4465f2bc13.png".to_string(),
            ]
        );
    }

    #[test]
    fn extracts_sources_from_plain_sources_block_with_blocked_tag() {
        let text = "Answer.\n\nSources\npapers/Dflash/2608.02438/NOTES.md [blocked]\npapers/Dflash/2608.02438/source/main.tex [blocked]\npapers/Dflash/2608.02438/metadata.json [blocked]\n";
        let s = extract_sources(text);
        assert_eq!(
            s,
            vec![
                "papers/Dflash/2608.02438/NOTES.md".to_string(),
                "papers/Dflash/2608.02438/source/main.tex".to_string(),
                "papers/Dflash/2608.02438/metadata.json".to_string(),
            ]
        );
    }

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
    fn build_prompt_prefers_cli_for_paper_mutations_without_selected_skill() {
        let p = build_prompt(
            Some("free"),
            "Add this paper and download its PDF",
            None,
            SkillMentionStyle::InjectedOnly,
            &[],
            None,
            None,
        );
        assert!(p.contains("agentero import id <arxiv|doi|url> --json"));
        assert!(p.contains("agentero paper download <path|id> --json"));
        assert!(p.contains("agentero paper parse <path|id> --json"));
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
        assert!(!p.contains("## Sources"));
        assert!(!p.contains("Agentero CLI policy"));
        assert!(!p.contains("Simplified Chinese"));
        assert!(!p.contains("User preference instructions"));
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
