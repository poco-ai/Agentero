use crate::features::agent::models::{AgentTemplate, AgentTemplateInfo};

/// Preset command templates only — binaries are never bundled with Agentero.
///
/// `detect_command` is used for "installed on PATH" status when the ACP entrypoint
/// differs (e.g. Claude/Codex via npx adapters still want to show the host CLI).
/// Official ACP adapter install commands.
///
/// Unix: a user-prefix install (`~/.local/bin`) avoids sudo and keeps the bin on
/// the login PATH — system `npm i -g` often needs sudo and still leaves the bin
/// off login PATH.
/// Windows: `$HOME` does not expand in cmd.exe and `~/.local/bin` is not on
/// PATH, so use a plain global install into npm's prefix (`%APPDATA%\npm`,
/// already on PATH).
pub const CLAUDE_ACP_INSTALL_COMMAND: &str = if cfg!(windows) {
    "npm i -g @agentclientprotocol/claude-agent-acp"
} else {
    "npm i -g @agentclientprotocol/claude-agent-acp --prefix \"$HOME/.local\""
};
pub const CODEX_ACP_INSTALL_COMMAND: &str = if cfg!(windows) {
    "npm i -g @agentclientprotocol/codex-acp"
} else {
    "npm i -g @agentclientprotocol/codex-acp --prefix \"$HOME/.local\""
};

pub fn builtin_templates() -> Vec<AgentTemplateInfo> {
    vec![
        AgentTemplateInfo {
            id: AgentTemplate::Opencode.as_str().to_string(),
            name: "OpenCode".to_string(),
            description: "Multi-provider coding agent with native ACP (`opencode acp`). Enables the question tool via OPENCODE_ENABLE_QUESTION_TOOL."
                .to_string(),
            command: "opencode".to_string(),
            args: vec!["acp".to_string()],
            detect_command: Some("opencode".to_string()),
            install_hint: (if cfg!(windows) {
                "npm i -g opencode  ·  https://opencode.ai"
            } else {
                "brew install opencode  ·  https://opencode.ai"
            })
            .to_string(),
            install_command: None,
        },
        AgentTemplateInfo {
            id: AgentTemplate::OpenClaw.as_str().to_string(),
            name: "OpenClaw".to_string(),
            description: "OpenClaw with native ACP (`openclaw acp`).".to_string(),
            command: "openclaw".to_string(),
            args: vec!["acp".to_string()],
            detect_command: Some("openclaw".to_string()),
            install_hint: "npm i -g openclaw@latest  ·  https://docs.openclaw.ai/cli/acp"
                .to_string(),
            install_command: None,
        },
        AgentTemplateInfo {
            id: AgentTemplate::ClaudeAcp.as_str().to_string(),
            name: "Claude".to_string(),
            description: "Claude Code via official ACP adapter (`claude-agent-acp`).".to_string(),
            // ACP entrypoint is the adapter; "installed" badge uses host Claude Code.
            command: "claude-agent-acp".to_string(),
            args: vec![],
            detect_command: Some("claude".to_string()),
            install_hint: format!(
                "{CLAUDE_ACP_INSTALL_COMMAND}  (needs Claude Code auth)"
            ),
            install_command: Some(CLAUDE_ACP_INSTALL_COMMAND.to_string()),
        },
        AgentTemplateInfo {
            id: AgentTemplate::CodexAcp.as_str().to_string(),
            name: "Codex".to_string(),
            description: "OpenAI Codex via ACP adapter (`codex-acp`).".to_string(),
            command: "codex-acp".to_string(),
            args: vec![],
            detect_command: Some("codex".to_string()),
            install_hint: format!("{CODEX_ACP_INSTALL_COMMAND}  ·  needs Codex CLI auth"),
            install_command: Some(CODEX_ACP_INSTALL_COMMAND.to_string()),
        },
        AgentTemplateInfo {
            id: AgentTemplate::Hermes.as_str().to_string(),
            name: "Hermes Agent".to_string(),
            description: "Hermes Agent with native ACP (`hermes acp`).".to_string(),
            command: "hermes".to_string(),
            args: vec!["acp".to_string()],
            detect_command: Some("hermes".to_string()),
            install_hint:
                "Install Hermes Agent, then run `hermes acp`  ·  https://github.com/NousResearch/hermes-agent"
                    .to_string(),
            install_command: None,
        },
        AgentTemplateInfo {
            id: AgentTemplate::Gemini.as_str().to_string(),
            name: "Gemini CLI".to_string(),
            description: "Google Gemini CLI with experimental ACP mode.".to_string(),
            command: "gemini".to_string(),
            args: vec!["--experimental-acp".to_string()],
            detect_command: Some("gemini".to_string()),
            install_hint: "Install Google Gemini CLI (with ACP support).".to_string(),
            install_command: None,
        },
        AgentTemplateInfo {
            id: AgentTemplate::QoderCli.as_str().to_string(),
            name: "Qoder CLI".to_string(),
            description: "Qoder CLI with native ACP (`qodercli --acp`).".to_string(),
            command: "qodercli".to_string(),
            args: vec!["--acp".to_string()],
            detect_command: Some("qodercli".to_string()),
            install_hint:
                "Install Qoder CLI, then `qodercli login`  ·  https://docs.qoder.com/en/cli/acp"
                    .to_string(),
            install_command: None,
        },
        AgentTemplateInfo {
            id: AgentTemplate::GrokBuild.as_str().to_string(),
            name: "Grok Build".to_string(),
            description:
                "xAI Grok Build via ACP (`npx @xai-official/grok@0.2.100 agent stdio`)."
                    .to_string(),
            command: "npx".to_string(),
            args: vec![
                "@xai-official/grok@0.2.100".to_string(),
                "agent".to_string(),
                "stdio".to_string(),
            ],
            detect_command: Some("npx".to_string()),
            install_hint:
                "Run with `npx @xai-official/grok@0.2.100 agent stdio`  ·  https://zed.dev/acp/agent/grok-build"
                    .to_string(),
            install_command: None,
        },
        AgentTemplateInfo {
            id: AgentTemplate::Custom.as_str().to_string(),
            name: "Custom".to_string(),
            description: "Any ACP-compatible command + args.".to_string(),
            command: String::new(),
            args: vec![],
            detect_command: None,
            install_hint: "Provide command and args for your local ACP agent.".to_string(),
            install_command: None,
        },
    ]
}

/// Built-in catalog shown in Settings (excludes free-form custom).
pub fn catalog_templates() -> Vec<AgentTemplateInfo> {
    builtin_templates()
        .into_iter()
        .filter(|t| t.id != "custom")
        .collect()
}

pub fn template_from_id(id: &str) -> AgentTemplate {
    match id {
        "opencode" => AgentTemplate::Opencode,
        "openclaw" => AgentTemplate::OpenClaw,
        "gemini" => AgentTemplate::Gemini,
        "hermes" => AgentTemplate::Hermes,
        "claude-acp" => AgentTemplate::ClaudeAcp,
        "codex-acp" => AgentTemplate::CodexAcp,
        "qodercli" => AgentTemplate::QoderCli,
        "grok-build" => AgentTemplate::GrokBuild,
        _ => AgentTemplate::Custom,
    }
}

pub fn template_info(id: &str) -> Option<AgentTemplateInfo> {
    builtin_templates().into_iter().find(|t| t.id == id)
}
