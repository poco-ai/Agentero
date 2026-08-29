//! Remote vault over SSH/SFTP and remote BYOA helpers.
//! See `docs/development/remote-vault.md`.

pub mod agent_exec;
pub mod blob_cache;
pub mod catalog_mirror;
pub mod import_bridge;
pub mod launch;
pub(crate) mod paper_commit;
pub mod session;
#[cfg(unix)]
pub mod sftp_fs;
pub mod ssh_config;
pub mod trash_bridge;

pub use launch::{
    ensure_remote_vault_skills, materialize_skills_to_work, resolve_remote_target,
    RemoteAgentTarget,
};
pub use session::{
    parse_remote_handle, RemoteRegistry, RemoteSession, RemoteSessionInfo, LOCAL_SIM_HOST,
};

pub mod commands;
