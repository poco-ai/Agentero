use crate::features::agent::models::{AgentTemplate, AgentTemplateInfo};

/// Preset command templates only — binaries are never bundled with Agentero.
///
/// `detect_command` is used for "installed on PATH" status when the ACP entrypoint
/// differs (e.g. Claude/Codex via npx adapters still want to show the host CLI).
/// Official Claude Code ACP adapter install command.
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

/// Community `pi-acp` adapter — pi itself has no native ACP mode, the adapter
/// spawns `pi --mode rpc`. Same prefix reasoning as the Claude adapter above.
pub const PI_ACP_INSTALL_COMMAND: &str = if cfg!(windows) {
    "npm i -g pi-acp@latest"
} else {
    "npm i -g pi-acp@latest --prefix \"$HOME/.local\""
};

/// Host pi CLI. The official `pi.dev/install.sh` is an interactive TUI installer,
/// so the silent lifecycle uses npm (what that script ultimately runs) everywhere.
pub const PI_HOST_INSTALL_COMMAND: &str = "npm i -g @earendil-works/pi-coding-agent@latest";

/// Managed launcher directory for the dsh ACP demo server. The server resolves
/// its cordis.yml, plugin modules, `.env` and session persistence relative to
/// this directory, and ACP stdio spawns have no cwd field — so both the install
/// lifecycle and the launch command `cd` here first.
pub fn dsh_launcher_dir() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("USERPROFILE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("C:\\"));
        base.join(".agentero").join("dsh-acp")
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default();
        home.join(".agentero").join("dsh-acp")
    }
}

/// Default install directory of the official Kimi Code installer (single
/// binary, written into the shell rc). Used for uninstall cleanup.
pub fn kimi_launcher_dir() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("USERPROFILE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("C:\\"));
        base.join(".kimi-code")
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default();
        home.join(".kimi-code")
    }
}

/// Home-level npm root shim: if the user has `~/package.json`, npm walks up
/// from the launcher dir and lands packages in `~/node_modules` (off PATH).
pub fn dsh_home_entrypoint() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let home = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)?;
        for name in ["dsh-acp-demo.cmd", "dsh-acp-demo"] {
            let shim = home.join("node_modules").join(".bin").join(name);
            if shim.exists() {
                return Some(shim);
            }
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
        let shim = home.join("node_modules").join(".bin").join("dsh-acp-demo");
        shim.exists().then_some(shim)
    }
}

/// "dsh installed" check: npm shims live in the launcher's `node_modules/.bin`
/// (Unix symlink, Windows `.cmd` batch next to the bash shim) or in the
/// home-level npm root. PATH-based installs are checked separately via
/// `resolve_command("dsh-acp-demo")`.
pub fn dsh_entrypoint_exists() -> bool {
    let bin = dsh_launcher_dir().join("node_modules").join(".bin");
    bin.join("dsh-acp-demo").exists()
        || bin.join("dsh-acp-demo.cmd").exists()
        || dsh_home_entrypoint().is_some()
}

pub fn builtin_templates() -> Vec<AgentTemplateInfo> {
    vec![
        AgentTemplateInfo {
            id: AgentTemplate::Pi.as_str().to_string(),
            name: "Pi".to_string(),
            description:
                "Pi coding agent via the community ACP adapter (`pi-acp` spawns `pi --mode rpc`)."
                    .to_string(),
            // ACP entrypoint is the adapter; "installed" badge uses the host pi CLI.
            command: "pi-acp".to_string(),
            args: vec![],
            detect_command: Some("pi".to_string()),
            install_hint: format!(
                "{PI_HOST_INSTALL_COMMAND} + {PI_ACP_INSTALL_COMMAND}  ·  needs Node 22+  ·  https://pi.dev"
            ),
            install_command: Some(PI_ACP_INSTALL_COMMAND.to_string()),
        },
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
            install_hint: "npm i -g @agentclientprotocol/codex-acp  ·  needs Codex CLI auth"
                .to_string(),
            install_command: Some("npm i -g @agentclientprotocol/codex-acp".to_string()),
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
            description: "xAI Grok Build with native ACP (`grok agent stdio`).".to_string(),
            // Detect the real `grok` CLI, not `npx`: a bare `npx` probe is true on
            // any machine with Node, which hid the Install button and let the
            // Settings auto-probe spawn (and silently npm-download) the agent.
            command: "grok".to_string(),
            args: vec!["agent".to_string(), "stdio".to_string()],
            detect_command: Some("grok".to_string()),
            install_hint:
                "Official installer (https://x.ai/cli/install.sh) or npm: \
                 `npm i -g @xai-official/grok`  ·  https://zed.dev/acp/agent/grok-build"
                    .to_string(),
            install_command: None,
        },
        AgentTemplateInfo {
            id: AgentTemplate::Dsh.as_str().to_string(),
            name: "Dsh".to_string(),
            description:
                "DeepSeek Harness automation ACP demo (`@deepseek-ai/dsh-acp-demo`), npm-installed into ~/.agentero/dsh-acp."
                    .to_string(),
            // The server resolves cordis.yml / plugins / .env from its own dir;
            // ACP stdio spawns have no cwd, so launch through a shell cd. Prefer
            // the app-managed local install, then a home-level npm root (when
            // `~/package.json` walks npm up), then a global install on PATH.
            command: if cfg!(windows) { "cmd" } else { "bash" }.to_string(),
            args: if cfg!(windows) {
                vec![
                    "/D".to_string(),
                    "/C".to_string(),
                    "cd /d \"%USERPROFILE%\\.agentero\\dsh-acp\" && if exist node_modules\\.bin\\dsh-acp-demo.cmd (node_modules\\.bin\\dsh-acp-demo.cmd --config cordis.yml) else (if exist \"%USERPROFILE%\\node_modules\\.bin\\dsh-acp-demo.cmd\" (\"%USERPROFILE%\\node_modules\\.bin\\dsh-acp-demo.cmd\" --config cordis.yml) else (dsh-acp-demo --config cordis.yml))".to_string(),
                ]
            } else {
                vec![
                    "-c".to_string(),
                    "cd \"$HOME/.agentero/dsh-acp\" && if [ -x ./node_modules/.bin/dsh-acp-demo ]; then exec ./node_modules/.bin/dsh-acp-demo --config cordis.yml; elif [ -x \"$HOME/node_modules/.bin/dsh-acp-demo\" ]; then exec \"$HOME/node_modules/.bin/dsh-acp-demo\" --config cordis.yml; else exec dsh-acp-demo --config cordis.yml; fi".to_string(),
                ]
            },
            detect_command: Some("node".to_string()),
            install_hint: format!(
                "Install button runs `npm i` of the dsh-acp-demo stack into ~/.agentero/dsh-acp. \
                 `npm i -g @deepseek-ai/dsh` is the umbrella CLI without ACP — install \
                 @deepseek-ai/dsh-acp-demo instead. Needs Node 22.19+ and DEEPSEEK_API_KEY \
                 in {}/.env  ·  https://github.com/deepseek-ai/deepseek-harness",
                dsh_launcher_dir().display()
            ),
            install_command: None,
        },
        AgentTemplateInfo {
            id: AgentTemplate::KimiCode.as_str().to_string(),
            name: "Kimi Code".to_string(),
            description:
                "Moonshot Kimi Code CLI with native ACP (`kimi acp`). Log in once with `kimi` + `/login` (OAuth or Moonshot API key)."
                    .to_string(),
            command: "kimi".to_string(),
            args: vec!["acp".to_string()],
            detect_command: Some("kimi".to_string()),
            install_hint:
                "Official script (no Node required) or npm: `npm i -g @moonshot-ai/kimi-code` \
                 (needs Node 22.19+). First launch: `kimi` → `/login`  ·  \
                 https://moonshotai.github.io/kimi-code/en/"
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
        "pi" => AgentTemplate::Pi,
        "dsh" => AgentTemplate::Dsh,
        "kimi-code" => AgentTemplate::KimiCode,
        _ => AgentTemplate::Custom,
    }
}

pub fn template_info(id: &str) -> Option<AgentTemplateInfo> {
    builtin_templates().into_iter().find(|t| t.id == id)
}
