pub mod antigravity;
pub mod bundled;
pub mod discovery;
#[cfg(windows)]
pub(crate) mod dsh;
pub mod lifecycle;
pub mod remote;
pub mod store;
pub mod templates;
pub mod version_check;

pub use discovery::{path_entries, probe_command, resolve_command};
pub use lifecycle::{
    run_template_lifecycle, supports_lifecycle, uninstall_info, ToolLifecycleAction, UninstallInfo,
    LIFECYCLE_TEMPLATES,
};
pub use remote::{probe_remote_template, scan_remote_agents, RemoteAgentScanResponse};
pub use store::AgentRegistry;
pub use templates::{
    builtin_templates, catalog_templates, interactive_cli, template_from_id, template_info,
};
