//! Desktop [`agentero_mcp::McpHost`]: settings, import follow-up, live wiki
//! index, and job cancellation. The shared tool surface calls these hooks
//! and does not name Tauri itself.

use agentero_mcp::{ImportContext, McpController, McpHost, McpStatus, MCP_STATUS_EVENT};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

struct DesktopMcpHost {
    app: AppHandle,
}

#[async_trait::async_trait]
impl McpHost for DesktopMcpHost {
    fn permissions(&self) -> agentero_mcp::Permissions {
        self.app
            .try_state::<crate::features::system::settings::AppSettingsStore>()
            .map(|store| store.mcp_permissions())
            .unwrap_or_default()
    }

    fn import_context(&self) -> ImportContext {
        let caps = self
            .app
            .try_state::<crate::features::paper::catalog::CapsCache>()
            .map(|state| state.inner().clone());
        ImportContext {
            app: Some(crate::features::host_hooks::wrap(&self.app)),
            caps,
        }
    }

    fn after_import(
        &self,
        vault: &Path,
        plan: &agentero_core::features::paper::import::PreparationPlan,
    ) {
        crate::features::host_hooks::enqueue_preparation_plan(&self.app, vault, plan);
    }

    fn open_wiki_index(
        &self,
    ) -> Option<Arc<Mutex<agentero_core::features::vault::rename::WikiIndex>>> {
        self.app
            .try_state::<crate::features::markdown::wiki::WikiIndexState>()
            .map(|state| state.handle())
    }

    async fn after_delete(&self, vault: &Path, rels: &[String]) {
        let Some(center) = self.app.try_state::<crate::features::jobs::JobCenter>() else {
            return;
        };
        for rel in rels {
            for snapshot in center.cancel_for_paper(vault, rel).await {
                crate::features::jobs::emit_job_changed(&self.app, snapshot);
            }
        }
        center.drain_and_spawn(&self.app).await;
    }

    fn on_status(&self, status: &McpStatus) {
        let _ = self.app.emit(MCP_STATUS_EVENT, status);
    }
}

pub fn attach_app(ctrl: &McpController, app: AppHandle) {
    ctrl.set_host(Arc::new(DesktopMcpHost { app }));
}
