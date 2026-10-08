use crate::core::error::AppError;
use crate::features::agent::acp::client::{
    build_child_env, effective_local_agent_env, resolve_command_in_agent_env,
};
use crate::features::agent::models::{
    default_agent_proxy_url, merge_no_proxy, AgentDescriptor, AgentRegistryState,
    AgentTelemetrySummary, AgentTemplate, CatalogAcpStatus, CatalogEntry, CatalogScanResponse,
    ProbeResult, UpsertAgentRequest,
};
use crate::features::agent::registry::bundled;
use crate::features::agent::registry::discovery::probe_command;
use crate::features::agent::registry::lifecycle;
use crate::features::agent::registry::templates::{
    catalog_templates, interactive_cli, template_from_id, template_info,
};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

pub struct AgentRegistry {
    inner: Mutex<AgentRegistryState>,
    path: PathBuf,
}

impl AgentRegistry {
    pub fn load() -> Self {
        let path = config_path();
        let (mut state, removed_templates) =
            read_state(&path).unwrap_or_else(|_| (AgentRegistryState::default(), false));
        let migrated_codex = migrate_legacy_codex_agents(&mut state);
        let migrated_grok = migrate_legacy_grok_agents(&mut state);
        let migrated_env = migrate_catalog_env_defaults(&mut state);
        state.enabled = true;
        if migrated_codex || migrated_grok || removed_templates || migrated_env {
            if let Err(error) = persist(&path, &state) {
                log::error!(
                    target: "agentero::agent",
                    "failed to persist agent registration migration: {error}"
                );
            }
        }
        Self {
            inner: Mutex::new(state),
            path,
        }
    }

    pub fn snapshot(&self) -> Result<AgentRegistryState, AppError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| AppError::message("agent registry lock poisoned"))?
            .clone();
        refresh_availability(&mut state);
        apply_proxy_settings(&mut state);
        apply_user_agent_settings(&mut state);
        Ok(state)
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<AgentRegistryState, AppError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::message("agent registry lock poisoned"))?;
        guard.enabled = enabled;
        persist(&self.path, &guard)?;
        Ok(guard.clone())
    }

    pub fn set_proxy(
        &self,
        proxy_enabled: bool,
        proxy_url: String,
    ) -> Result<AgentRegistryState, AppError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::message("agent registry lock poisoned"))?;
        let proxy_url = normalize_proxy_url(&proxy_url);
        let changed = guard.proxy_enabled != proxy_enabled || guard.proxy_url != proxy_url;
        guard.proxy_enabled = proxy_enabled;
        guard.proxy_url = proxy_url;
        if changed {
            for agent in &mut guard.agents {
                if !matches!(agent.template, AgentTemplate::Custom) {
                    agent.last_probe_ok = None;
                    agent.last_probe_agent_name = None;
                    agent.last_probe_error = None;
                    agent.last_probed_at = None;
                }
            }
        }
        persist(&self.path, &guard)?;
        Ok(guard.clone())
    }

    pub fn proxy_settings(&self) -> Result<(bool, String), AppError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AppError::message("agent registry lock poisoned"))?;
        Ok((guard.proxy_enabled, normalize_proxy_url(&guard.proxy_url)))
    }

    /// Persist optional ACP / Codex HTTP User-Agent override (empty = off).
    pub fn set_user_agent(
        &self,
        user_agent: String,
        user_agent_provider_ids: String,
    ) -> Result<AgentRegistryState, AppError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::message("agent registry lock poisoned"))?;
        guard.user_agent = user_agent.trim().to_string();
        guard.user_agent_provider_ids = user_agent_provider_ids
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(",");
        persist(&self.path, &guard)?;
        Ok(guard.clone())
    }

    pub fn set_default(&self, id: Option<String>) -> Result<AgentRegistryState, AppError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::message("agent registry lock poisoned"))?;
        if let Some(ref agent_id) = id {
            if !guard.agents.iter().any(|a| a.id == *agent_id) {
                return Err(AppError::domain(
                    "agent_not_found",
                    format!("agent not found: {agent_id}"),
                ));
            }
        }
        guard.default_id = id;
        persist(&self.path, &guard)?;
        Ok(guard.clone())
    }

    pub fn upsert(&self, req: UpsertAgentRequest) -> Result<AgentDescriptor, AppError> {
        if req.command.trim().is_empty() {
            return Err(AppError::message("command is required"));
        }
        if req.name.trim().is_empty() {
            return Err(AppError::message("name is required"));
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::message("agent registry lock poisoned"))?;

        let template = req.template.unwrap_or_else(|| template_from_id("custom"));
        let id = req
            .id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| stable_id_for(&template, req.command.trim(), &req.args));

        let (available, last_error) = match probe_command(req.command.trim()) {
            Ok(_) => (true, None),
            Err(e) => (false, Some(e)),
        };

        // Preserve probe history when re-saving the same id.
        let prev = guard.agents.iter().find(|a| a.id == id).cloned();
        let preserve_probe = prev.as_ref().is_some_and(|p| {
            p.command == req.command.trim() && p.args == req.args && p.env == req.env
        });

        let descriptor = AgentDescriptor {
            id: id.clone(),
            name: req.name.trim().to_string(),
            template,
            command: req.command.trim().to_string(),
            args: req.args,
            env: req.env,
            available,
            last_error,
            last_probe_ok: preserve_probe
                .then(|| prev.as_ref().and_then(|p| p.last_probe_ok))
                .flatten(),
            last_probe_agent_name: preserve_probe
                .then(|| prev.as_ref().and_then(|p| p.last_probe_agent_name.clone()))
                .flatten(),
            last_probe_error: preserve_probe
                .then(|| prev.as_ref().and_then(|p| p.last_probe_error.clone()))
                .flatten(),
            last_probed_at: preserve_probe
                .then(|| prev.as_ref().and_then(|p| p.last_probed_at.clone()))
                .flatten(),
        };

        if let Some(existing) = guard.agents.iter_mut().find(|a| a.id == id) {
            *existing = descriptor.clone();
        } else {
            guard.agents.push(descriptor.clone());
        }

        if req.set_default || guard.default_id.is_none() {
            guard.default_id = Some(id);
        }
        if !guard.agents.is_empty() {
            guard.enabled = true;
        }

        persist(&self.path, &guard)?;
        Ok(descriptor)
    }

    /// Ensure a catalog template is registered; return its descriptor.
    pub fn ensure_catalog_agent(
        &self,
        template_id: &str,
        set_default: bool,
    ) -> Result<AgentDescriptor, AppError> {
        let info = template_info(template_id)
            .filter(|t| t.id != "custom")
            .ok_or_else(|| AppError::message(format!("unknown catalog template: {template_id}")))?;

        let env = catalog_env(&info);

        // Prefer existing registration for this template. Built-in descriptors are owned by the
        // catalog, so refresh their command when a release changes the launcher.
        {
            let state = self.snapshot()?;
            if let Some(existing) = state.agents.iter().find(|a| {
                a.template.as_str() == template_id
                    || (a.command == info.command && a.args == info.args)
            }) {
                let needs_refresh = existing.command != info.command || existing.args != info.args;
                // Fill missing catalog env keys (e.g. OPENCODE_ENABLE_QUESTION_TOOL)
                // without overwriting user values.
                let mut merged_env = existing.env.clone();
                let mut env_changed = false;
                for (key, value) in &env {
                    if !merged_env.contains_key(key) {
                        merged_env.insert(key.clone(), value.clone());
                        env_changed = true;
                    }
                }
                if !needs_refresh && !env_changed {
                    if set_default {
                        self.set_default(Some(existing.id.clone()))?;
                        return self.get(&existing.id);
                    }
                    return Ok(existing.clone());
                }

                let agent = self.upsert(UpsertAgentRequest {
                    id: Some(existing.id.clone()),
                    name: info.name,
                    template: Some(template_from_id(template_id)),
                    command: info.command,
                    args: info.args,
                    env: merged_env,
                    set_default,
                })?;
                return self.get(&agent.id);
            }
        }

        let agent = self.upsert(UpsertAgentRequest {
            id: Some(format!("catalog-{template_id}")),
            name: info.name,
            template: Some(template_from_id(template_id)),
            command: info.command,
            args: info.args,
            env,
            set_default,
        })?;
        self.get(&agent.id)
    }

    pub fn remove(&self, id: &str) -> Result<(), AppError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::message("agent registry lock poisoned"))?;
        let before = guard.agents.len();
        guard.agents.retain(|a| a.id != id);
        if guard.agents.len() == before {
            return Err(AppError::domain(
                "agent_not_found",
                format!("agent not found: {id}"),
            ));
        }
        if guard.default_id.as_deref() == Some(id) {
            guard.default_id = guard.agents.first().map(|a| a.id.clone());
        }
        persist(&self.path, &guard)?;
        Ok(())
    }

    /// Remove the registry entry for a catalog template, matched by the same
    /// predicate as `scan_catalog` (template id, or command+args for entries
    /// created before canonical ids). Returns whether anything was removed.
    pub fn remove_catalog_template(&self, template_id: &str) -> Result<bool, AppError> {
        let Some(info) = template_info(template_id) else {
            return Ok(false);
        };
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::message("agent registry lock poisoned"))?;
        let before = guard.agents.len();
        guard.agents.retain(|a| {
            !(a.template.as_str() == template_id
                || (a.command == info.command && a.args == info.args))
        });
        if guard.agents.len() == before {
            return Ok(false);
        }
        if guard
            .default_id
            .as_deref()
            .is_some_and(|d| !guard.agents.iter().any(|a| a.id == d))
        {
            guard.default_id = guard.agents.first().map(|a| a.id.clone());
        }
        persist(&self.path, &guard)?;
        Ok(true)
    }

    pub fn discover(&self, id: Option<&str>) -> Result<Vec<AgentDescriptor>, AppError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::message("agent registry lock poisoned"))?;

        for agent in guard.agents.iter_mut() {
            if id.is_some_and(|want| want != agent.id) {
                continue;
            }
            probe_or_bundled(agent);
        }
        persist(&self.path, &guard)?;
        Ok(if let Some(want) = id {
            guard
                .agents
                .iter()
                .filter(|a| a.id == want)
                .cloned()
                .collect()
        } else {
            guard.agents.clone()
        })
    }

    pub fn get(&self, id: &str) -> Result<AgentDescriptor, AppError> {
        let state = self.snapshot()?;
        state
            .agents
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| AppError::domain("agent_not_found", format!("agent not found: {id}")))
    }

    pub fn apply_probe_result(&self, id: &str, result: &ProbeResult) -> Result<(), AppError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::message("agent registry lock poisoned"))?;
        let agent = guard
            .agents
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or_else(|| AppError::domain("agent_not_found", format!("agent not found: {id}")))?;
        let now = chrono_like_now();
        agent.last_probe_ok = Some(result.available);
        agent.last_probe_agent_name = result.agent_name.clone();
        agent.last_probe_error = result.error.clone();
        agent.last_probed_at = Some(now);
        if result.available {
            agent.available = true;
            agent.last_error = None;
        }
        persist(&self.path, &guard)?;
        Ok(())
    }

    pub fn scan_catalog(&self) -> Result<CatalogScanResponse, AppError> {
        // Catalog agents that are present on PATH but not yet persisted in the
        // registry are auto-registered here, so panels like the sidebar chat
        // switcher can list them without requiring a visit to Settings first.
        // The ACP probe still happens lazily (Settings or first use). If any
        // registration happened we re-scan once so default/registered ids are
        // consistent.
        loop {
            let state = self.snapshot()?;
            let default_id = state.default_id.clone();

            let mut entries = Vec::new();
            let mut registered_new = false;
            for info in catalog_templates() {
                let registered = state.agents.iter().find(|a| {
                    a.template.as_str() == info.id
                        || (a.command == info.command && a.args == info.args)
                });
                // Antigravity switches between a PATH command and the
                // Agentero-managed absolute path as its managed copy appears
                // or disappears. Refresh stale descriptors before probing.
                if info.id == "antigravity-acp"
                    && registered.is_some_and(|agent| {
                        agent.command != info.command || agent.args != info.args
                    })
                    && self.ensure_catalog_agent(&info.id, false).is_ok()
                {
                    registered_new = true;
                    continue;
                }
                let descriptor_env = registered
                    .map(|agent| agent.env.clone())
                    .unwrap_or_else(|| catalog_env(&info));
                let environment = build_child_env(
                    std::env::vars(),
                    crate::features::agent::registry::discovery::login_shell_env(),
                    &descriptor_env,
                );
                let detect = info
                    .detect_command
                    .as_deref()
                    .unwrap_or(info.command.as_str());
                let path_acp_available =
                    resolve_command_in_agent_env(&info.command, &environment).is_some();
                let bundled = bundled::bundled_adapter(&info.id);
                let detect_path = if !path_acp_available && bundled.is_some() {
                    bundled::host_path(&info.id, &environment)
                } else {
                    resolve_command_in_agent_env(detect, &environment)
                };
                let binary_available = detect_path.is_some();
                let availability =
                    local_command_availability(&info.command, &info.id, &environment, || {
                        bundled::bundled_spawn(&info.id, &environment).is_some()
                    });
                let acp_command_available = availability.is_ok();

                let (acp_status, acp_agent_name, last_probe_error, last_probed_at) =
                    if !acp_command_available {
                        let error = if binary_available {
                            bundled::node_blocker_message(&info.id).or_else(|| availability.err())
                        } else {
                            availability.err()
                        };
                        (CatalogAcpStatus::Missing, None, error, None)
                    } else if let Some(reg) = registered {
                        match reg.last_probe_ok {
                            Some(true) => (
                                CatalogAcpStatus::Ready,
                                reg.last_probe_agent_name.clone(),
                                None,
                                reg.last_probed_at.clone(),
                            ),
                            Some(false) => (
                                CatalogAcpStatus::Failed,
                                reg.last_probe_agent_name.clone(),
                                reg.last_probe_error.clone(),
                                reg.last_probed_at.clone(),
                            ),
                            None => (CatalogAcpStatus::NotProbed, None, None, None),
                        }
                    } else {
                        (CatalogAcpStatus::NotProbed, None, None, None)
                    };

                let mut registered_id = registered.map(|a| a.id.clone());
                if acp_command_available && registered.is_none() {
                    if let Ok(agent) = self.ensure_catalog_agent(&info.id, false) {
                        registered_new = true;
                        registered_id = Some(agent.id.clone());
                    }
                }

                let is_default = registered_id
                    .as_ref()
                    .zip(default_id.as_ref())
                    .is_some_and(|(a, d)| a == d);

                // Two install layers: Agent (detect binary) vs ACP entrypoint.
                let adapter_distinct = info
                    .detect_command
                    .as_ref()
                    .is_some_and(|d| d != &info.command);
                let can_install = lifecycle::supports_lifecycle(&info.id);
                // Resolve the interactive CLI's leading binary so the row only
                // offers the terminal action when it is actually available
                // (e.g. Antigravity's separate `agy`), keeping any launch args.
                let cli_command = interactive_cli(&info).and_then(|command| {
                    let binary = command.split_whitespace().next()?.to_string();
                    resolve_command_in_agent_env(&binary, &environment).map(|_| command)
                });
                // Offer ACP install when host is present but ACP entry is missing.
                let offer_install = binary_available
                    && !acp_command_available
                    && (can_install
                        || info
                            .install_command
                            .as_ref()
                            .is_some_and(|c| !c.trim().is_empty()));

                entries.push(CatalogEntry {
                    template_id: info.id,
                    name: info.name,
                    description: info.description,
                    command: info.command,
                    args: info.args,
                    install_hint: info.install_hint,
                    install_command: info.install_command,
                    login_command: info.login_command,
                    cli_command,
                    offer_install,
                    can_install,
                    adapter_distinct,
                    binary_available,
                    resolved_path: detect_path.map(|p| p.display().to_string()),
                    acp_command_available,
                    acp_bundled: bundled.is_some(),
                    acp_bundled_version: bundled.map(|b| b.version),
                    acp_status,
                    registered_id,
                    is_default,
                    acp_agent_name,
                    last_probe_error,
                    last_probed_at,
                    installed_version: None,
                    latest_version: None,
                    update_available: None,
                });
            }

            if registered_new {
                continue;
            }

            let custom_agents = state
                .agents
                .into_iter()
                .filter(|a| matches!(a.template, AgentTemplate::Custom))
                .collect();

            return Ok(CatalogScanResponse {
                entries,
                custom_agents,
                default_id,
                enabled: state.enabled,
                proxy_enabled: state.proxy_enabled,
                proxy_url: state.proxy_url,
                user_agent: state.user_agent,
                user_agent_provider_ids: state.user_agent_provider_ids,
            });
        }
    }

    /// Anonymous summary of registered agents for telemetry (template ids +
    /// custom count). Reads state without probing commands, so it is safe to
    /// call during startup.
    pub fn telemetry_summary(&self) -> AgentTelemetrySummary {
        let Ok(guard) = self.inner.lock() else {
            return AgentTelemetrySummary::default();
        };
        let mut templates: Vec<String> = guard
            .agents
            .iter()
            .filter(|a| !matches!(a.template, AgentTemplate::Custom))
            .map(|a| a.template.as_str().to_string())
            .collect();
        templates.sort();
        templates.dedup();
        let custom_count = guard
            .agents
            .iter()
            .filter(|a| matches!(a.template, AgentTemplate::Custom))
            .count();
        AgentTelemetrySummary {
            templates,
            custom_count,
        }
    }

    pub fn resolve_default(&self, preferred: Option<&str>) -> Result<AgentDescriptor, AppError> {
        let state = self.snapshot()?;
        if !state.enabled {
            return Err(AppError::message(
                "Agent is disabled. Enable it in Settings → Agent.",
            ));
        }
        let id = preferred
            .map(str::to_string)
            .or(state.default_id.clone())
            .ok_or_else(|| {
                AppError::message("No agent configured. Add one in Settings → Agent.")
            })?;
        let agent = state
            .agents
            .into_iter()
            .find(|a| a.id == id)
            .ok_or(AppError::domain(
                "agent_not_found",
                format!("agent not found: {id}"),
            ))?;
        if !agent.available {
            return Err(AppError::domain(
                "agent_unavailable",
                format!(
                    "agent unavailable: {}",
                    agent
                        .last_error
                        .unwrap_or_else(|| format!("command `{}` not available", agent.command))
                ),
            ));
        }
        Ok(agent)
    }
}

/// Default env injected when registering a catalog template (or refreshing it).
fn catalog_env(
    info: &crate::features::agent::models::AgentTemplateInfo,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    // OpenCode ACP disables the built-in `question` tool unless this is set
    // (`OPENCODE_CLIENT=acp` + enableQuestionTool gate in OpenCode itself).
    if info.id == AgentTemplate::Opencode.as_str() {
        env.insert("OPENCODE_ENABLE_QUESTION_TOOL".to_string(), "1".to_string());
    }
    env
}

/// Merge missing catalog env keys into existing registrations (never overwrite).
fn migrate_catalog_env_defaults(state: &mut AgentRegistryState) -> bool {
    let mut changed = false;
    for agent in &mut state.agents {
        let template_id = agent.template.as_str();
        let Some(info) = template_info(template_id) else {
            continue;
        };
        for (key, value) in catalog_env(&info) {
            if let std::collections::hash_map::Entry::Vacant(e) = agent.env.entry(key) {
                e.insert(value);
                changed = true;
            }
        }
    }
    changed
}

/// Grok Build used to launch as `npx @xai-official/grok@<pinned> agent stdio`,
/// which downloaded the agent on first spawn. Repoint stale rows at the real CLI.
fn migrate_legacy_grok_agents(state: &mut AgentRegistryState) -> bool {
    let mut migrated = false;
    for agent in &mut state.agents {
        if agent.template != AgentTemplate::GrokBuild || agent.command != "npx" {
            continue;
        }
        agent.command = "grok".to_string();
        agent.args = vec!["agent".to_string(), "stdio".to_string()];
        agent.last_probe_ok = None;
        agent.last_probe_agent_name = None;
        agent.last_probe_error = None;
        agent.last_probed_at = None;
        migrated = true;
    }
    migrated
}

fn migrate_legacy_codex_agents(state: &mut AgentRegistryState) -> bool {
    let mut migrated = false;
    for agent in &mut state.agents {
        if agent.template != AgentTemplate::CodexAcp {
            continue;
        }
        // Migrate from native app-server to ACP adapter
        if agent.command == "codex" && agent.args == vec!["app-server".to_string()] {
            agent.command = "codex-acp".to_string();
            agent.args = vec![];
            agent.env.remove("CODEX_PATH");
            agent.last_probe_ok = None;
            agent.last_probe_agent_name = None;
            agent.last_probe_error = None;
            agent.last_probed_at = None;
            migrated = true;
        }
    }
    migrated
}

/// The community `agy-acp` adapter and legacy Gemini CLI template were removed.
/// The official Antigravity server uses the separate `antigravity-acp` template.
/// Old registrations may still be on disk; an unknown template fails the whole parse
/// (`read_state` would fall back to an empty registry, dropping every other
/// agent), so stale rows are stripped from the raw JSON before deserialization.
const REMOVED_TEMPLATE_IDS: &[&str] = &["antigravity", "gemini"];

fn is_removed_template(agent: &serde_json::Value) -> bool {
    agent
        .get("template")
        .and_then(|value| value.as_str())
        .is_some_and(|template| REMOVED_TEMPLATE_IDS.contains(&template))
}

fn strip_removed_templates(value: &mut serde_json::Value) -> bool {
    let default_id = value
        .get("default_id")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let Some(object) = value.as_object_mut() else {
        return false;
    };
    let Some(agents) = object
        .get_mut("agents")
        .and_then(|value| value.as_array_mut())
    else {
        return false;
    };
    let before = agents.len();
    let mut removed_default = false;
    agents.retain(|agent| {
        if !is_removed_template(agent) {
            return true;
        }
        if let (Some(default), Some(id)) = (
            default_id.as_deref(),
            agent.get("id").and_then(|value| value.as_str()),
        ) {
            removed_default |= default == id;
        }
        false
    });
    let changed = agents.len() != before;
    if changed && removed_default {
        object.insert("default_id".to_string(), serde_json::Value::Null);
    }
    changed
}

fn stable_id_for(template: &AgentTemplate, command: &str, args: &[String]) -> String {
    match template {
        AgentTemplate::Custom => Uuid::new_v4().to_string(),
        other => {
            let _ = (command, args);
            format!("catalog-{}", other.as_str())
        }
    }
}

pub(crate) fn chrono_like_now() -> String {
    // RFC3339-ish without extra deps: unix secs is enough for UI ordering.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn config_path() -> PathBuf {
    let path = crate::core::paths::agents_path();
    crate::core::paths::migrate_legacy_file("agents.json", &path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    path
}

/// Read + migrate the on-disk registry. Returns `(state, removed_stale_templates)`
/// so `load` can persist the cleaned file.
fn read_state(path: &PathBuf) -> Result<(AgentRegistryState, bool), AppError> {
    if !path.exists() {
        return Ok((AgentRegistryState::default(), false));
    }
    let raw = fs::read_to_string(path)?;
    let mut value: serde_json::Value = serde_json::from_str(&raw)?;
    let removed = strip_removed_templates(&mut value);
    Ok((serde_json::from_value(value)?, removed))
}

fn persist(path: &Path, state: &AgentRegistryState) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Atomic temp+rename: a crash mid-write must never truncate agents.json —
    // `load()` falls back to an empty registry on any parse failure.
    crate::core::fs::json_store(path, state)
}

fn normalize_proxy_url(proxy_url: &str) -> String {
    let trimmed = proxy_url.trim();
    if trimmed.is_empty() {
        default_agent_proxy_url()
    } else {
        trimmed.to_string()
    }
}

fn apply_proxy_settings(state: &mut AgentRegistryState) {
    state.proxy_url = normalize_proxy_url(&state.proxy_url);
    let proxy_enabled = state.proxy_enabled;
    let proxy_url = state.proxy_url.clone();
    for agent in &mut state.agents {
        apply_proxy_to_agent(agent, proxy_enabled, &proxy_url);
    }
}

/// Loopback bypass for the injected proxy env lives in `models::merge_no_proxy`
/// (shared with the remote and lifecycle injection sites).
fn apply_proxy_to_agent(agent: &mut AgentDescriptor, proxy_enabled: bool, proxy_url: &str) {
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
        agent.env.remove(key);
    }
    if proxy_enabled {
        let proxy_url = proxy_url.trim();
        if !proxy_url.is_empty() {
            for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
                agent.env.insert(key.to_string(), proxy_url.to_string());
            }
            agent.env.insert(
                "NO_PROXY".to_string(),
                merge_no_proxy(agent.env.get("NO_PROXY")),
            );
        }
    }
}

/// Env key set on every ACP child when a custom User-Agent is configured.
pub const AGENTERO_USER_AGENT_ENV: &str = "AGENTERO_USER_AGENT";
/// Claude Code / Claude ACP recognizes this multi-line header map (cindy/cc pattern).
pub const ANTHROPIC_CUSTOM_HEADERS_ENV: &str = "ANTHROPIC_CUSTOM_HEADERS";

fn apply_user_agent_settings(state: &mut AgentRegistryState) {
    let ua = state.user_agent.trim().to_string();
    let provider_ids = state.user_agent_provider_ids.clone();
    for agent in &mut state.agents {
        apply_user_agent_to_agent(agent, &ua, &provider_ids);
    }
}

fn apply_user_agent_to_agent(agent: &mut AgentDescriptor, user_agent: &str, provider_ids: &str) {
    // Snapshot always starts from persisted env (no prior injection). Only clear
    // our env key here so empty UA is a no-op for CODEX_CONFIG on disk.
    agent.env.remove(AGENTERO_USER_AGENT_ENV);

    let ua = user_agent.trim();
    if ua.is_empty() {
        return;
    }
    agent
        .env
        .insert(AGENTERO_USER_AGENT_ENV.to_string(), ua.to_string());

    match agent.template {
        // Codex ACP merges CODEX_CONFIG into session config; model_providers.*.http_headers
        // is the supported place for custom User-Agent (new-api affinity: codex-cli/*).
        AgentTemplate::CodexAcp | AgentTemplate::Custom => {
            merge_codex_config_user_agent(&mut agent.env, ua, provider_ids);
        }
        // Claude Code ACP / adapter often honors ANTHROPIC_CUSTOM_HEADERS (newline-separated
        // `Name: value` lines). Inject User-Agent there when present.
        AgentTemplate::ClaudeAcp => {
            merge_anthropic_custom_headers_user_agent(&mut agent.env, ua);
        }
        // Other ACP templates: only AGENTERO_USER_AGENT today (agent may ignore it).
        AgentTemplate::Opencode
        | AgentTemplate::AntigravityAcp
        | AgentTemplate::QoderCli
        | AgentTemplate::GrokBuild
        | AgentTemplate::Pi
        | AgentTemplate::Hermes
        | AgentTemplate::Dsh
        | AgentTemplate::KimiCode
        | AgentTemplate::Zcode
        | AgentTemplate::MinimaxCode
        | AgentTemplate::MimoCode => {}
    }
}

/// Upsert `User-Agent: …` into `ANTHROPIC_CUSTOM_HEADERS` (newline-separated headers).
pub fn merge_anthropic_custom_headers_user_agent(
    env: &mut HashMap<String, String>,
    user_agent: &str,
) {
    let ua = user_agent.trim();
    if ua.is_empty() {
        return;
    }
    let existing = env
        .get(ANTHROPIC_CUSTOM_HEADERS_ENV)
        .map(|s| s.as_str())
        .unwrap_or("");
    let mut lines: Vec<String> = existing
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| {
            let name = l.split_once(':').map(|(n, _)| n.trim()).unwrap_or("");
            !name.eq_ignore_ascii_case("user-agent")
        })
        .map(str::to_string)
        .collect();
    lines.push(format!("User-Agent: {ua}"));
    env.insert(ANTHROPIC_CUSTOM_HEADERS_ENV.to_string(), lines.join("\n"));
}

/// Merge User-Agent into `CODEX_CONFIG.model_providers.<id>.http_headers`.
pub fn merge_codex_config_user_agent(
    env: &mut HashMap<String, String>,
    user_agent: &str,
    provider_ids: &str,
) {
    let ua = user_agent.trim();
    if ua.is_empty() {
        return;
    }

    let mut root: serde_json::Value = env
        .get("CODEX_CONFIG")
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let obj = root.as_object_mut().expect("object");

    let providers = obj
        .entry("model_providers")
        .or_insert_with(|| serde_json::json!({}));
    let providers = if let Some(map) = providers.as_object_mut() {
        map
    } else {
        *providers = serde_json::json!({});
        providers.as_object_mut().expect("object")
    };

    let mut targets: Vec<String> = provider_ids
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    if targets.is_empty() {
        // Auto: existing CODEX_CONFIG providers + MODEL_PROVIDER + openai fallback.
        targets.extend(providers.keys().cloned());
        if let Some(mp) = env.get("MODEL_PROVIDER") {
            let t = mp.trim();
            if !t.is_empty() && !targets.iter().any(|x| x == t) {
                targets.push(t.to_string());
            }
        }
        if targets.is_empty() {
            targets.push("openai".to_string());
        }
    }

    targets.sort();
    targets.dedup();

    for id in targets {
        let entry = providers.entry(id).or_insert_with(|| serde_json::json!({}));
        let Some(p) = entry.as_object_mut() else {
            continue;
        };
        let headers = p
            .entry("http_headers")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(h) = headers.as_object_mut() {
            h.insert(
                "User-Agent".to_string(),
                serde_json::Value::String(ua.to_string()),
            );
        }
    }

    if let Ok(s) = serde_json::to_string(&root) {
        env.insert("CODEX_CONFIG".to_string(), s);
    }
}

fn refresh_availability(state: &mut AgentRegistryState) {
    for agent in &mut state.agents {
        probe_or_bundled(agent);
    }
}

fn local_command_availability(
    command: &str,
    template_id: &str,
    environment: &HashMap<String, String>,
    bundled_spawnable: impl FnOnce() -> bool,
) -> Result<(), String> {
    if resolve_command_in_agent_env(command, environment).is_some() {
        return Ok(());
    }
    if bundled_spawnable() {
        if bundled::host_path(template_id, environment).is_some() {
            return Ok(());
        }
        if let Some((host, key)) = bundled::host_requirement(template_id) {
            return Err(format!(
                "host command `{host}` not found (check its installation or `{key}`)"
            ));
        }
    }
    Err(format!("ACP command `{command}` not found"))
}

fn probe_or_bundled(agent: &mut AgentDescriptor) {
    let environment = effective_local_agent_env(agent);
    let availability = local_command_availability(
        &agent.command,
        agent.template.as_str(),
        &environment,
        || bundled::bundled_spawn(agent.template.as_str(), &environment).is_some(),
    );
    agent.available = availability.is_ok();
    agent.last_error = availability.err();
}

#[cfg(test)]
mod tests {
    use super::{
        apply_proxy_to_agent, apply_user_agent_to_agent, merge_anthropic_custom_headers_user_agent,
        merge_codex_config_user_agent, migrate_legacy_codex_agents, migrate_legacy_grok_agents,
        strip_removed_templates, AGENTERO_USER_AGENT_ENV, ANTHROPIC_CUSTOM_HEADERS_ENV,
    };
    use crate::features::agent::models::{
        merge_no_proxy, AgentDescriptor, AgentRegistryState, AgentTemplate,
    };
    use std::collections::HashMap;

    fn legacy_codex_app_server() -> AgentDescriptor {
        let mut env = HashMap::new();
        env.insert("CODEX_PATH".to_string(), "/usr/local/bin/codex".to_string());
        AgentDescriptor {
            id: "catalog-codex-acp".to_string(),
            name: "Codex".to_string(),
            template: AgentTemplate::CodexAcp,
            command: "codex".to_string(),
            args: vec!["app-server".to_string()],
            env,
            available: false,
            last_error: None,
            last_probe_ok: Some(true),
            last_probe_agent_name: Some("legacy".to_string()),
            last_probe_error: None,
            last_probed_at: Some("1".to_string()),
        }
    }

    #[test]
    fn migrates_legacy_codex_app_server_to_acp_adapter() {
        let mut state = AgentRegistryState {
            agents: vec![legacy_codex_app_server()],
            ..AgentRegistryState::default()
        };

        assert!(migrate_legacy_codex_agents(&mut state));
        let agent = &state.agents[0];
        assert_eq!(agent.command, "codex-acp");
        assert_eq!(agent.args, Vec::<String>::new());
        assert!(!agent.env.contains_key("CODEX_PATH"));
        assert_eq!(agent.last_probe_ok, None);
    }

    #[test]
    fn migrates_legacy_grok_npx_launcher_to_native_cli() {
        let mut state = AgentRegistryState {
            agents: vec![AgentDescriptor {
                id: "catalog-grok-build".to_string(),
                name: "Grok Build".to_string(),
                template: AgentTemplate::GrokBuild,
                command: "npx".to_string(),
                args: vec![
                    "@xai-official/grok@0.2.100".to_string(),
                    "agent".to_string(),
                    "stdio".to_string(),
                ],
                env: HashMap::new(),
                available: true,
                last_error: None,
                last_probe_ok: Some(true),
                last_probe_agent_name: Some("grok".to_string()),
                last_probe_error: None,
                last_probed_at: Some("1".to_string()),
            }],
            ..AgentRegistryState::default()
        };

        assert!(migrate_legacy_grok_agents(&mut state));
        let agent = &state.agents[0];
        assert_eq!(agent.command, "grok");
        assert_eq!(agent.args, vec!["agent".to_string(), "stdio".to_string()]);
        assert_eq!(agent.last_probe_ok, None);
        assert_eq!(agent.last_probed_at, None);

        // Already native: nothing left to migrate.
        assert!(!migrate_legacy_grok_agents(&mut state));
    }

    #[test]
    fn strips_removed_templates_without_dropping_other_agents() {
        let mut value = serde_json::json!({
            "enabled": true,
            "default_id": "catalog-antigravity",
            "agents": [
                {
                    "id": "catalog-antigravity",
                    "name": "Antigravity",
                    "template": "antigravity",
                    "command": "agy-acp",
                    "args": [],
                    "env": {},
                    "available": true
                },
                {
                    "id": "catalog-gemini",
                    "name": "Gemini",
                    "template": "gemini",
                    "command": "gemini",
                    "args": ["--experimental-acp"],
                    "env": {},
                    "available": true
                },
                {
                    "id": "catalog-pi",
                    "name": "Pi",
                    "template": "pi",
                    "command": "pi-acp",
                    "args": [],
                    "env": {},
                    "available": true
                },
                {
                    "id": "catalog-antigravity-acp",
                    "name": "Antigravity",
                    "template": "antigravity-acp",
                    "command": "agy_acp_server.par",
                    "args": [],
                    "env": {},
                    "available": true
                }
            ]
        });

        assert!(strip_removed_templates(&mut value));
        let agents = value["agents"].as_array().expect("agents");
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0]["template"], "pi");
        assert_eq!(agents[1]["template"], "antigravity-acp");
        assert!(value["default_id"].is_null());
        // Registry still deserializes after the strip.
        let state: AgentRegistryState =
            serde_json::from_value(value.clone()).expect("parse cleaned state");
        assert_eq!(state.agents.len(), 2);
        assert_eq!(state.agents[0].template, AgentTemplate::Pi);
        assert_eq!(state.agents[1].template, AgentTemplate::AntigravityAcp);

        // Idempotent when nothing else references a removed template.
        value["default_id"] = serde_json::json!("catalog-pi");
        assert!(!strip_removed_templates(&mut value));
    }

    #[test]
    fn merge_codex_config_sets_user_agent_on_target_providers() {
        let mut env = HashMap::new();
        env.insert(
            "CODEX_CONFIG".to_string(),
            r#"{"model_providers":{"my_proxy":{"base_url":"https://relay.example/v1"}}}"#
                .to_string(),
        );
        merge_codex_config_user_agent(&mut env, "codex-cli/0.50.0", "my_proxy");
        let raw = env.get("CODEX_CONFIG").expect("CODEX_CONFIG");
        let v: serde_json::Value = serde_json::from_str(raw).expect("json");
        assert_eq!(
            v["model_providers"]["my_proxy"]["http_headers"]["User-Agent"],
            "codex-cli/0.50.0"
        );
        assert_eq!(
            v["model_providers"]["my_proxy"]["base_url"],
            "https://relay.example/v1"
        );
    }

    #[test]
    fn merge_codex_config_auto_targets_openai_when_empty() {
        let mut env = HashMap::new();
        merge_codex_config_user_agent(&mut env, "codex-cli/0.1.0", "");
        let raw = env.get("CODEX_CONFIG").expect("CODEX_CONFIG");
        let v: serde_json::Value = serde_json::from_str(raw).expect("json");
        assert_eq!(
            v["model_providers"]["openai"]["http_headers"]["User-Agent"],
            "codex-cli/0.1.0"
        );
    }

    #[test]
    fn apply_user_agent_sets_env_for_codex() {
        let mut agent = AgentDescriptor {
            id: "c".into(),
            name: "Codex".into(),
            template: AgentTemplate::CodexAcp,
            command: "codex-acp".into(),
            args: vec![],
            env: HashMap::new(),
            available: true,
            last_error: None,
            last_probe_ok: None,
            last_probe_agent_name: None,
            last_probe_error: None,
            last_probed_at: None,
        };
        apply_user_agent_to_agent(&mut agent, "codex-cli/1.2.3", "custom");
        assert_eq!(
            agent.env.get(AGENTERO_USER_AGENT_ENV).map(String::as_str),
            Some("codex-cli/1.2.3")
        );
        let raw = agent.env.get("CODEX_CONFIG").expect("CODEX_CONFIG");
        let v: serde_json::Value = serde_json::from_str(raw).expect("json");
        assert_eq!(
            v["model_providers"]["custom"]["http_headers"]["User-Agent"],
            "codex-cli/1.2.3"
        );
        // Empty UA only clears our env key; snapshot always restarts from disk.
        apply_user_agent_to_agent(&mut agent, "", "");
        assert!(!agent.env.contains_key(AGENTERO_USER_AGENT_ENV));
    }

    #[test]
    fn proxy_injection_adds_loopback_no_proxy() {
        let mut agent = AgentDescriptor {
            id: "oc".into(),
            name: "OpenCode".into(),
            template: AgentTemplate::Opencode,
            command: "opencode".into(),
            args: vec!["acp".into()],
            env: HashMap::new(),
            available: true,
            last_error: None,
            last_probe_ok: None,
            last_probe_agent_name: None,
            last_probe_error: None,
            last_probed_at: None,
        };
        apply_proxy_to_agent(&mut agent, true, "http://127.0.0.1:7890");
        assert_eq!(
            agent.env.get("HTTP_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );
        // OpenCode's ACP CLI talks to its own serve child over 127.0.0.1;
        // without the bypass the local proxy 502s that loopback traffic and
        // session/new fails with ClientError (empty model list).
        assert_eq!(
            agent.env.get("NO_PROXY").map(String::as_str),
            Some("127.0.0.1,localhost,::1")
        );
    }

    #[test]
    fn proxy_no_proxy_merge_keeps_user_entries() {
        assert_eq!(merge_no_proxy(None), "127.0.0.1,localhost,::1");
        // User entries stay first; loopback hosts are deduped case-insensitively.
        assert_eq!(
            merge_no_proxy(Some(&"internal.corp,LOCALHOST,127.0.0.1".to_string())),
            "internal.corp,LOCALHOST,127.0.0.1,::1"
        );
    }

    #[test]
    fn proxy_disabled_clears_injected_vars_but_keeps_user_no_proxy() {
        let mut agent = AgentDescriptor {
            id: "oc2".into(),
            name: "OpenCode".into(),
            template: AgentTemplate::Opencode,
            command: "opencode".into(),
            args: vec!["acp".into()],
            env: HashMap::from([("NO_PROXY".to_string(), "internal.corp".to_string())]),
            available: true,
            last_error: None,
            last_probe_ok: None,
            last_probe_agent_name: None,
            last_probe_error: None,
            last_probed_at: None,
        };
        apply_proxy_to_agent(&mut agent, false, "http://127.0.0.1:7890");
        assert!(!agent.env.contains_key("HTTP_PROXY"));
        assert!(!agent.env.contains_key("HTTPS_PROXY"));
        assert!(!agent.env.contains_key("ALL_PROXY"));
        assert_eq!(
            agent.env.get("NO_PROXY").map(String::as_str),
            Some("internal.corp")
        );
    }

    #[test]
    fn merge_anthropic_headers_upserts_user_agent_line() {
        let mut env = HashMap::new();
        env.insert(
            ANTHROPIC_CUSTOM_HEADERS_ENV.to_string(),
            "X-Tenant: acme\nUser-Agent: old-cli/0.1".to_string(),
        );
        merge_anthropic_custom_headers_user_agent(&mut env, "claude-cli/2.1.161");
        let raw = env.get(ANTHROPIC_CUSTOM_HEADERS_ENV).expect("headers");
        assert!(raw.contains("X-Tenant: acme"));
        assert!(raw.contains("User-Agent: claude-cli/2.1.161"));
        assert!(!raw.contains("old-cli/0.1"));
    }

    #[test]
    fn bundled_availability_requires_host_but_path_adapters_do_not() {
        use super::local_command_availability;

        let tmp = tempfile::tempdir().unwrap();
        let mut environment =
            HashMap::from([("PATH".to_string(), tmp.path().display().to_string())]);
        for (id, command) in [
            ("claude-acp", "claude-agent-acp"),
            ("codex-acp", "codex-acp"),
        ] {
            let (host, key) = super::bundled::host_requirement(id).unwrap();
            let error = local_command_availability(command, id, &environment, || true).unwrap_err();
            assert!(error.contains(host));
            assert!(error.contains(key));

            let executable = tmp.path().join(if cfg!(windows) {
                format!("{command}.cmd")
            } else {
                command.to_string()
            });
            std::fs::write(&executable, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
            assert!(local_command_availability(command, id, &environment, || {
                panic!("PATH adapter must bypass the bundled tier")
            })
            .is_ok());

            environment.insert(key.to_string(), executable.display().to_string());
            assert!(
                local_command_availability("missing-adapter", id, &environment, || true).is_ok()
            );
            assert!(
                local_command_availability("missing-adapter", id, &environment, || false).is_err()
            );
        }
    }

    #[test]
    fn telemetry_summary_dedups_templates_and_counts_custom() {
        use super::AgentRegistry;
        use std::path::PathBuf;
        use std::sync::Mutex;

        fn desc(name: &str, template: AgentTemplate) -> AgentDescriptor {
            AgentDescriptor {
                id: name.to_string(),
                name: name.to_string(),
                template,
                command: name.to_string(),
                args: vec![],
                env: HashMap::new(),
                available: true,
                last_error: None,
                last_probe_ok: None,
                last_probe_agent_name: None,
                last_probe_error: None,
                last_probed_at: None,
            }
        }

        let registry = AgentRegistry {
            inner: Mutex::new(AgentRegistryState {
                agents: vec![
                    desc("claude", AgentTemplate::ClaudeAcp),
                    desc("claude-2", AgentTemplate::ClaudeAcp),
                    desc("pi", AgentTemplate::Pi),
                    desc("my-agent", AgentTemplate::Custom),
                ],
                ..AgentRegistryState::default()
            }),
            path: PathBuf::new(),
        };

        let summary = registry.telemetry_summary();
        assert_eq!(summary.templates, vec!["claude-acp", "pi"]);
        assert_eq!(summary.custom_count, 1);
    }

    #[test]
    fn apply_user_agent_sets_anthropic_headers_for_claude() {
        let mut agent = AgentDescriptor {
            id: "cc".into(),
            name: "Claude".into(),
            template: AgentTemplate::ClaudeAcp,
            command: "claude-agent-acp".into(),
            args: vec![],
            env: HashMap::new(),
            available: true,
            last_error: None,
            last_probe_ok: None,
            last_probe_agent_name: None,
            last_probe_error: None,
            last_probed_at: None,
        };
        apply_user_agent_to_agent(&mut agent, "claude-code/1.0.0", "");
        assert_eq!(
            agent.env.get(AGENTERO_USER_AGENT_ENV).map(String::as_str),
            Some("claude-code/1.0.0")
        );
        assert_eq!(
            agent
                .env
                .get(ANTHROPIC_CUSTOM_HEADERS_ENV)
                .map(String::as_str),
            Some("User-Agent: claude-code/1.0.0")
        );
    }
}
