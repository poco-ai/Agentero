//! Host assembly for the shared System One provider.
//!
//! The provider is reused by the smart-highlight stream as its transport. It
//! reads credentials lazily at request time, so settings changes take effect
//! without rebuilding it.

pub mod commands;

use crate::core::decision::SystemOneProvider;
use crate::core::error::AppError;
use crate::features::system::settings::AppSettingsStore;
use std::sync::Arc;
use tauri::Manager;

/// Build the process-wide shared System One provider.
pub fn build_provider(handle: tauri::AppHandle) -> Arc<SystemOneProvider> {
    Arc::new(SystemOneProvider::with_shared_client({
        let handle = handle.clone();
        move || {
            let store = handle.state::<AppSettingsStore>();
            store
                .decision_config()
                .ok_or_else(|| AppError::message("decision provider API key is not configured"))
        }
    }))
}
