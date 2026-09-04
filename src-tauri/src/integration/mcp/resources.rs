//! MCP resource `agentero://vault` — Markdown vault overview.

use super::McpController;
use crate::features::catalog::{self, papers};

pub const VAULT_URI: &str = "agentero://vault";
pub const VAULT_NAME: &str = "vault";

pub fn vault_markdown(ctrl: &McpController) -> String {
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
                 Use `paper_list` / `paper_get` next. `ref` is a paper id or vault-relative path.\n",
                vault.display()
            )
        }
        Err(_) => {
            "# Agentero vault\n\nNo local vault is open. Open a vault in Agentero, then read this resource again.\n"
                .into()
        }
    }
}
