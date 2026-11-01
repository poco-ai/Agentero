//! MCP resources: vault overview, agent invariants, bundled CLI skill.

use super::McpController;
use agentero_core::features::paper::catalog::{self, papers};
use agentero_core::features::vault;
use agentero_core::ops;

pub const VAULT_URI: &str = "agentero://vault";
pub const VAULT_NAME: &str = "vault";

pub const INVARIANTS_URI: &str = "agentero://agent-invariants";
pub const INVARIANTS_NAME: &str = "agent-invariants";

pub const SKILL_URI: &str = "agentero://skills/agentero-cli";
pub const SKILL_NAME: &str = "agentero-cli-skill";

pub fn vault_markdown(ctrl: &McpController) -> String {
    let listed = ctrl.vault_list();
    let known = if listed.vaults.is_empty() {
        "- (none)".to_string()
    } else {
        listed
            .vaults
            .iter()
            .map(|v| {
                format!(
                    "- `{}`{}{}",
                    v.path,
                    if v.open { " (open)" } else { "" },
                    if v.exists { "" } else { " (missing)" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    match ctrl.local_vault() {
        Ok(vault) => {
            let (schema_version, papers_n, unread) = match catalog::ensure_catalog(&vault) {
                Ok(conn) => {
                    let ver = catalog::schema_version(&conn).ok();
                    drop(conn);
                    let rows = papers::list_all(&vault).unwrap_or_default();
                    let unread = rows.iter().filter(|r| !r.is_read).count();
                    (ver, rows.len(), unread)
                }
                Err(_) => (None, 0, 0),
            };
            let schema = schema_version
                .map(|v| v.to_string())
                .unwrap_or_else(|| "unknown".into());
            format!(
                "# Agentero vault\n\n\
                 - **path**: `{}`\n\
                 - **schemaVersion**: {schema}\n\
                 - **papers**: {papers_n}\n\
                 - **unread**: {unread}\n\n\
                 ## Known vaults\n\n{known}\n\n\
                 Next: read `{INVARIANTS_URI}`, then `paper_list` (slim by default) / `paper_get`.\n\
                 `ref` is a paper id or vault-relative path. Use `fields` or `full` on `paper_list` only when needed.\n\
                 To target another known vault, pass its path as `vault` (see `vault_list`).\n\
                 Text outside a paper record (for example `drafts/main.tex`): `file_list`, then `file_read` / `file_write`; images and other binary files: `file_write_binary`.\n",
                vault.display()
            )
        }
        Err(_) => format!(
            "# Agentero vault\n\nNo local vault is open. Open a vault in Agentero, or start `agentero mcp serve --vault <PATH>`.\n\n\
             ## Known vaults\n\n{known}\n\n\
             Pass a known path as `vault` to tools that accept it, or open the vault in Agentero.\n"
        ),
    }
}

pub fn invariants_markdown() -> String {
    ops::agent_invariants_markdown().to_string()
}

pub fn skill_markdown() -> String {
    vault::bundled_skill_files()
        .iter()
        .find_map(|(rel, content)| {
            (*rel == ".agents/skills/agentero-cli/SKILL.md").then_some(*content)
        })
        .expect("agentero-cli skill bundled")
        .to_string()
}

pub fn read(uri: &str, ctrl: &McpController) -> Option<(String, &'static str)> {
    match uri {
        VAULT_URI => Some((vault_markdown(ctrl), "text/markdown")),
        INVARIANTS_URI => Some((invariants_markdown(), "text/markdown")),
        SKILL_URI => Some((skill_markdown(), "text/markdown")),
        _ => None,
    }
}
