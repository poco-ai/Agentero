//! Remote vault handle parsing and remote-process env mirroring helpers.
//!
//! `remote:<sessionId>` is the pseudo vault path the frontend uses for an
//! active remote session. Parsing it is pure string work, so it lives in
//! core: features (jobs / import / trash / agent) branch on remote vaults
//! without depending on `integration::remote`.

/// Prefix of the pseudo vault handle that points at an active remote session.
pub const REMOTE_HANDLE_PREFIX: &str = "remote:";

/// Resolve vault handle `remote:<id>` → session id.
pub fn parse_remote_handle(vault_handle: &str) -> Option<&str> {
    let h = vault_handle.trim();
    h.strip_prefix(REMOTE_HANDLE_PREFIX)
        .filter(|id| !id.is_empty())
}

/// Env keys mirrored into the remote agent process (proxy + Codex UA / config).
pub const REMOTE_PROXY_ENV_KEYS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    // Loopback bypass travels with the proxy keys: OpenCode on the remote
    // host reaches its own serve child over 127.0.0.1, which must not be
    // routed through the injected proxy.
    "NO_PROXY",
    "no_proxy",
    // Custom User-Agent for Codex/Claude / mid-station affinity (#207).
    "AGENTERO_USER_AGENT",
    "CODEX_CONFIG",
    "MODEL_PROVIDER",
    "ANTHROPIC_CUSTOM_HEADERS",
];

/// Collect proxy / Codex UA env pairs from an env map (after registry apply).
pub fn proxy_env_from_map(
    env: &std::collections::HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for key in REMOTE_PROXY_ENV_KEYS {
        if let Some(v) = env.get(*key) {
            let t = v.trim();
            if !t.is_empty() {
                out.push(((*key).to_string(), t.to_string()));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_handle() {
        assert_eq!(parse_remote_handle("remote:abc"), Some("abc"));
        assert_eq!(parse_remote_handle(" remote:abc "), Some("abc"));
        assert_eq!(parse_remote_handle("remote:"), None);
        assert_eq!(parse_remote_handle("/local/path"), None);
    }

    #[test]
    fn collects_only_known_non_empty_env_keys() {
        let mut env = std::collections::HashMap::new();
        env.insert(
            "HTTP_PROXY".to_string(),
            " http://127.0.0.1:7890 ".to_string(),
        );
        env.insert("ALL_PROXY".to_string(), "   ".to_string());
        env.insert("PATH".to_string(), "/usr/bin".to_string());
        // The loopback bypass must travel with the proxy keys: without it the
        // remote OpenCode's 127.0.0.1 serve traffic goes through the proxy.
        env.insert(
            "NO_PROXY".to_string(),
            "127.0.0.1,localhost,::1".to_string(),
        );
        let pairs = proxy_env_from_map(&env);
        assert_eq!(
            pairs,
            vec![
                (
                    "HTTP_PROXY".to_string(),
                    "http://127.0.0.1:7890".to_string()
                ),
                (
                    "NO_PROXY".to_string(),
                    "127.0.0.1,localhost,::1".to_string()
                ),
            ]
        );
    }
}
