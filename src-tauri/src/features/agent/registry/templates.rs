use crate::features::agent::models::{AgentTemplate, AgentTemplateInfo};
use std::path::PathBuf;

/// Directory owned by Agentero for the official Antigravity ACP package.
pub fn antigravity_install_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Agentero")
        .join("agents")
        .join("antigravity-acp")
}

/// File name of the ACP server inside the managed directory (the Windows
/// archive ships an `.exe`, the other platforms a `.par`).
pub fn antigravity_server_name() -> &'static str {
    if cfg!(windows) {
        "agy_acp_server.exe"
    } else {
        "agy_acp_server.par"
    }
}

pub fn antigravity_command() -> String {
    let name = antigravity_server_name();
    let managed = antigravity_install_dir().join(name);
    if managed.is_file() {
        managed.display().to_string()
    } else {
        name.to_string()
    }
}

/// Preset command templates only — host binaries are never bundled with
/// Agentero. The Claude/Codex ACP adapters are the one exception to "nothing
/// bundled": their JS-only trees ship as app resources as an offline fallback
/// (see `registry::bundled`; a PATH-installed adapter always wins).
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

/// Codex ACP adapter — same Unix user-prefix reasoning as the Claude adapter.
/// Was the last adapter still installed into the (often root-owned) global
/// npm prefix on Unix, where `npm i -g` fails with EPERM unless run via sudo.
pub const CODEX_ACP_INSTALL_COMMAND: &str = if cfg!(windows) {
    "npm i -g @agentclientprotocol/codex-acp@latest"
} else {
    "npm i -g @agentclientprotocol/codex-acp@latest --prefix \"$HOME/.local\""
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

/// Host dsh CLI (DeepSeek Harness). ACP ships as a built-in profile
/// (`dsh --profile acp`, 0.1.2+); the standalone `@deepseek-ai/dsh-acp-demo`
/// package stopped at 0.1.1-rc.2. Same user-prefix reasoning as the Claude
/// adapter above.
pub const DSH_INSTALL_COMMAND: &str = if cfg!(windows) {
    "npm i -g @deepseek-ai/dsh@latest"
} else {
    "npm i -g @deepseek-ai/dsh@latest --prefix \"$HOME/.local\""
};

/// MiniMax Code native ACP CLI (`mcode acp`). The package ships native SQLite
/// dependencies, so npm must run install scripts and include optional deps.
pub const MINIMAX_CODE_INSTALL_COMMAND: &str = "npm install --global @minimax-ai/code@latest --ignore-scripts=false --include=optional --allow-scripts=@minimax-ai/code,better-sqlite3 --registry https://registry.npmjs.org/ --foreground-scripts";

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

/// Community `zcode-acp-server` adapter — bridges the headless `zcode
/// app-server --stdio` and reuses the ZCode desktop app login. Same prefix
/// reasoning as the Claude adapter above.
pub const ZCODE_ACP_INSTALL_COMMAND: &str = if cfg!(windows) {
    "npm i -g zcode-acp-server@latest"
} else {
    "npm i -g zcode-acp-server@latest --prefix \"$HOME/.local\""
};

/// Newest `zcode.cjs` under the given dir, deepest-glob `*/*/glm/*/[arch]`.
/// Returns candidates newest-mtime first; the cjs is platform-agnostic JS.
fn zcode_cached_cli_candidates(releases_root: std::path::PathBuf) -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    let Ok(releases) = std::fs::read_dir(&releases_root) else {
        return candidates;
    };
    for ver in releases.flatten() {
        let Ok(plats) = std::fs::read_dir(ver.path()) else {
            continue;
        };
        for plat in plats.flatten() {
            let Ok(contents) = std::fs::read_dir(plat.path().join("glm-content")) else {
                continue;
            };
            for hash in contents.flatten() {
                let Ok(arches) = std::fs::read_dir(hash.path().join("glm")) else {
                    continue;
                };
                for arch in arches.flatten() {
                    let cjs = arch.path().join("zcode.cjs");
                    if cjs.is_file() {
                        candidates.push(cjs);
                    }
                }
            }
        }
    }
    candidates.sort_by_key(|path| {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .unwrap_or(std::time::UNIX_EPOCH)
    });
    candidates.reverse();
    candidates
}

/// Env the ZCode adapter needs to drive the desktop app's embedded CLI.
///
/// The bundled `zcode.cjs` only boots its provider layer when
/// `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` points at the app's runtime builtin
/// table; without it the backend process dies ("backend dead") and every ACP
/// call fails. Turns additionally require a backend that implements
/// `workspace/updateProviderRegistry` (adapter 0.42 pushes it to register the
/// user's config.json providers; desktop 3.12.3's bundle dropped the method,
/// so turns fail `provider_not_configured`). The desktop app keeps
/// per-release CLI bundles in its remote-assets cache — prefer the newest
/// bundle that still supports the registry push over the app's built-in copy.
/// User-set env in the registered agent always wins.
pub fn zcode_runtime_env() -> Vec<(String, String)> {
    // Windows has no guaranteed `HOME`; the desktop app uses USERPROFILE there.
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from);
    let Some(home) = home else {
        return Vec::new();
    };
    let mut env = Vec::new();

    // Newest runtime builtin provider table written by the desktop app.
    let runtime_root = home.join(".zcode/v2/runtime/provider");
    let mut builtin_candidates = Vec::new();
    if let Ok(plats) = std::fs::read_dir(&runtime_root) {
        for plat in plats.flatten() {
            if let Ok(versions) = std::fs::read_dir(plat.path()) {
                for version in versions.flatten() {
                    if let Ok(endpoints) = std::fs::read_dir(version.path()) {
                        for endpoint in endpoints.flatten() {
                            let candidate = endpoint.path().join("zcode-builtin.json");
                            if candidate.is_file() {
                                builtin_candidates.push(candidate);
                            }
                        }
                    }
                }
            }
        }
    }
    builtin_candidates.sort_by_key(|path| {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .unwrap_or(std::time::UNIX_EPOCH)
    });
    if let Some(builtin) = builtin_candidates.last() {
        env.push((
            "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE".to_string(),
            builtin.display().to_string(),
        ));
        // Both vars together make the CLI use the injected builtin table
        // verbatim. With the builtin var alone, the CLI re-syncs it into a
        // version-keyed runtime copy, rewires configRevision there and
        // silently voids the adapter's account-config push — every account
        // model then fails "Provider Registry 中不存在 Model" (zcode-acp
        // #202, fixed in 0.42.4 whose own injection mirrors this pair).
        let personal = home.join(".zcode/v2/provider_config.json");
        if personal.is_file() {
            env.push((
                "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE".to_string(),
                personal.display().to_string(),
            ));
        }
    }

    // Newest CLI bundle whose backend still supports the registry push.
    let mut candidates = Vec::new();
    if cfg!(target_os = "macos") {
        candidates.extend(zcode_cached_cli_candidates(
            home.join("Library/Application Support/ZCode/remote-assets-cache/releases"),
        ));
        // Machine-wide and per-user install locations (adapter discovers both).
        candidates.push(std::path::PathBuf::from(
            "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
        ));
        candidates.push(home.join("Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"));
    }
    if cfg!(target_os = "linux") {
        candidates.extend(zcode_cached_cli_candidates(
            home.join(".config/ZCode/remote-assets-cache/releases"),
        ));
        candidates.push(std::path::PathBuf::from(
            "/opt/ZCode/resources/glm/zcode.cjs",
        ));
        candidates.push(std::path::PathBuf::from(
            "/usr/share/zcode/resources/glm/zcode.cjs",
        ));
    }
    if cfg!(target_os = "windows") {
        candidates.extend(zcode_cached_cli_candidates(
            home.join("AppData/Roaming/ZCode/remote-assets-cache/releases"),
        ));
        if let Some(app_dir) = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from) {
            candidates.push(app_dir.join("Programs/ZCode/resources/glm/zcode.cjs"));
        }
    }
    if let Some(cli) = candidates.into_iter().find(|cjs| {
        std::fs::read_to_string(cjs)
            .map(|src| src.contains("workspace/updateProviderRegistry"))
            .unwrap_or(false)
    }) {
        env.push(("ZCODE_BIN".to_string(), cli.display().to_string()));
        // The adapter's Node resolution relies on Unix `which` and falls back
        // to executing the `.cjs` directly — not a valid Windows entrypoint.
        // Hand it an explicit runtime when we can resolve one.
        if cfg!(target_os = "windows") {
            if let Some(node) = crate::core::process::discover::resolve_command("node") {
                env.push(("ZCODE_NODE".to_string(), node.display().to_string()));
            }
        }
    }
    env
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
            login_command: None,
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
                "npm i -g @opencode/cli  ·  https://opencode.ai/v2"
            } else {
                "brew install anomalyco/tap/opencode-v2  ·  https://opencode.ai/v2"
            })
            .to_string(),
            install_command: None,
            login_command: None,
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
            login_command: None,
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
            login_command: Some("claude auth login".to_string()),
        },
        AgentTemplateInfo {
            id: AgentTemplate::CodexAcp.as_str().to_string(),
            name: "Codex".to_string(),
            description: "OpenAI Codex via ACP adapter (`codex-acp`).".to_string(),
            command: "codex-acp".to_string(),
            args: vec![],
            detect_command: Some("codex".to_string()),
            install_hint: format!(
                "{CODEX_ACP_INSTALL_COMMAND}  ·  needs Codex CLI auth"
            ),
            install_command: Some(CODEX_ACP_INSTALL_COMMAND.to_string()),
            login_command: Some("codex login".to_string()),
        },
        // The official registry has no macOS Intel build.
        #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
        AgentTemplateInfo {
            id: AgentTemplate::AntigravityAcp.as_str().to_string(),
            name: "Antigravity".to_string(),
            description: "Google Antigravity via its official ACP server.".to_string(),
            command: antigravity_command(),
            // Match the launch arguments published in the official ACP registry.
            args: if cfg!(target_os = "linux") {
                vec!["--uid=".to_string()]
            } else {
                vec![]
            },
            detect_command: None,
            install_hint: "Download the official ACP server into Agentero's managed directory; \
                localharness_external is kept beside it. \
                https://antigravity.google/docs/ide/extensions/zed"
                .to_string(),
            // Antigravity is installed by the local Registry-aware lifecycle
            // path. There is no equivalent shell command for remote hosts.
            install_command: None,
            login_command: None,
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
            login_command: None,
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
            login_command: None,
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
            login_command: None,
        },
        AgentTemplateInfo {
            id: AgentTemplate::Dsh.as_str().to_string(),
            name: "Dsh".to_string(),
            description:
                "DeepSeek Harness with native ACP (`dsh --profile acp`, built-in profile)."
                    .to_string(),
            // ACP is a built-in profile of the umbrella CLI (0.1.2+); the
            // profile auto-initializes on first boot and reads credentials
            // through the official CLI's layered env (~/.dsh/.env).
            command: "dsh".to_string(),
            args: vec!["--profile".to_string(), "acp".to_string()],
            detect_command: Some("dsh".to_string()),
            install_hint: format!(
                "{DSH_INSTALL_COMMAND}  ·  needs Node 22.19+ and DEEPSEEK_API_KEY in ~/.dsh/.env \
                 (or the launch environment)  ·  https://github.com/deepseek-ai/deepseek-harness"
            ),
            install_command: Some(DSH_INSTALL_COMMAND.to_string()),
            login_command: None,
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
            login_command: None,
        },
        AgentTemplateInfo {
            id: AgentTemplate::Zcode.as_str().to_string(),
            name: "ZCode".to_string(),
            description:
                "ZCode (GLM) via the zcode-acp-server adapter bridging `zcode app-server --stdio`. \
                 Reuses the ZCode desktop app login in ~/.zcode; the adapter auto-discovers the \
                 app-bundled CLI (or set ZCODE_BIN)."
                    .to_string(),
            // ACP entrypoint is the adapter; it discovers the desktop app's
            // zcode.cjs itself, so the "installed" badge tracks the adapter.
            command: "zcode-acp-server".to_string(),
            args: vec![],
            detect_command: Some("zcode-acp-server".to_string()),
            install_hint: format!(
                "{ZCODE_ACP_INSTALL_COMMAND}  (needs Node 22+ and a logged-in ZCode App)  ·  \
                 https://github.com/william0wang/zcode-acp"
            ),
            install_command: Some(ZCODE_ACP_INSTALL_COMMAND.to_string()),
            login_command: None,
        },
        AgentTemplateInfo {
            id: AgentTemplate::MinimaxCode.as_str().to_string(),
            name: "MiniMax Code".to_string(),
            description:
                "MiniMax Code CLI with native ACP (`mcode acp`). Log in once with `mcode login`."
                    .to_string(),
            command: "mcode".to_string(),
            args: vec!["acp".to_string()],
            detect_command: Some("mcode".to_string()),
            install_hint: format!(
                "{MINIMAX_CODE_INSTALL_COMMAND}  ·  needs Node 22.19+ (or 24+)  ·  \
                 https://agent.minimax.io/docs/cli/quick-start"
            ),
            install_command: Some(MINIMAX_CODE_INSTALL_COMMAND.to_string()),
            login_command: Some("mcode login".to_string()),
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
            login_command: None,
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
        "hermes" => AgentTemplate::Hermes,
        "claude-acp" => AgentTemplate::ClaudeAcp,
        "codex-acp" => AgentTemplate::CodexAcp,
        "antigravity-acp" => AgentTemplate::AntigravityAcp,
        "qodercli" => AgentTemplate::QoderCli,
        "grok-build" => AgentTemplate::GrokBuild,
        "pi" => AgentTemplate::Pi,
        "dsh" => AgentTemplate::Dsh,
        "kimi-code" => AgentTemplate::KimiCode,
        "zcode" => AgentTemplate::Zcode,
        "minimax-code" => AgentTemplate::MinimaxCode,
        _ => AgentTemplate::Custom,
    }
}

pub fn template_info(id: &str) -> Option<AgentTemplateInfo> {
    builtin_templates().into_iter().find(|t| t.id == id)
}
