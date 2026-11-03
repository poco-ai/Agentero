//! Installed immutable source snapshots; grants are explicit and per local Vault.
use super::*;
use crate::core::json::JsonValue;
use agentero_core::plugins::{load_plugins, store_plugins, PluginsDocument};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tauri::Emitter;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub enabled: bool,
    pub grants: Vec<String>,
    pub settings: BTreeMap<String, Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub id: String,
    pub manifest: manifest::Manifest,
    pub source: String,
    #[serde(default)]
    pub scopes: BTreeMap<String, Scope>,
}

fn read() -> Result<Value, String> {
    load_plugins(&agentero_core::paths::plugins_path())
        .map(|doc| doc.as_value().clone())
        .map_err(|e| e.to_string())
}
fn write(value: Value) -> Result<(), String> {
    let doc = PluginsDocument::from_value(value).map_err(|e| e.to_string())?;
    store_plugins(&agentero_core::paths::plugins_path(), &doc).map_err(|e| e.to_string())
}
pub fn packages() -> Result<Vec<Package>, String> {
    let value = read()?;
    value["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry.get("manifest").is_some())
        .map(|entry| {
            serde_json::from_value(entry.clone())
                .map_err(|e| format!("plugin_invalid_package: {e}"))
        })
        .collect()
}
fn key(vault: &str) -> Result<String, String> {
    if vault.starts_with("remote:") {
        return Err("plugin_local_only".into());
    }
    PathBuf::from(vault)
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}
fn changed(app: &tauri::AppHandle, id: &str) {
    let manager = app.state::<PluginManager>();
    let mut loaded = manager.0.lock().unwrap_or_else(|e| e.into_inner());
    loaded.retain(|_, entry| {
        if entry.plugin.manifest.id != id {
            return true;
        }
        entry.cancel.cancel();
        false
    });
    drop(loaded);
    let _ = app.emit("plugins:changed", ());
}

#[tauri::command]
#[specta::specta]
pub fn plugin_list(app: tauri::AppHandle, vault_path: String) -> Result<JsonValue, String> {
    let manager = app.state::<PluginManager>();
    let _lock = manager.1.lock().unwrap_or_else(|e| e.into_inner());
    let vault = key(&vault_path)?;
    Ok(JsonValue(Value::Array(
        packages()?
            .into_iter()
            .map(|p| json!({"manifest":p.manifest,"scope":p.scopes.get(&vault)}))
            .collect(),
    )))
}

#[tauri::command]
#[specta::specta]
pub fn plugin_inspect(directory: String) -> Result<JsonValue, String> {
    let plugin = manifest::load(std::path::Path::new(&directory))?;
    serde_json::to_value(plugin.manifest)
        .map(JsonValue)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn plugin_install(app: tauri::AppHandle, directory: String) -> Result<(), String> {
    let plugin = manifest::load(std::path::Path::new(&directory))?;
    let manager = app.state::<PluginManager>();
    let _lock = manager.1.lock().unwrap_or_else(|e| e.into_inner());
    let mut document = read()?;
    let id = install_snapshot(&mut document, plugin)?;
    write(document)?;
    changed(&app, &id);
    Ok(())
}

fn install_snapshot(
    document: &mut Value,
    plugin: manifest::DevelopmentPlugin,
) -> Result<String, String> {
    let entries = document["plugins"].as_array_mut().unwrap();
    let id = plugin.manifest.id.clone();
    let package = Package {
        id: id.clone(),
        manifest: plugin.manifest,
        source: plugin.source,
        scopes: BTreeMap::new(),
    };
    let value = serde_json::to_value(package).map_err(|e| e.to_string())?;
    if let Some(entry) = entries
        .iter_mut()
        .find(|entry| entry["id"].as_str() == Some(&id))
    {
        // An update always revokes previous grants, including unchanged permissions.
        // Preserve forward-compatible fields without trusting old executable code.
        let old = entry.as_object_mut().ok_or("plugin_invalid_package")?;
        old.extend(value.as_object().unwrap().clone());
    } else {
        if entries.len() >= 32 {
            return Err("plugin_install_limit".into());
        }
        entries.push(value);
    }
    Ok(id)
}

#[tauri::command]
#[specta::specta]
pub fn plugin_configure(
    app: tauri::AppHandle,
    id: String,
    vault_path: String,
    enabled: bool,
    grants: Vec<String>,
    settings: JsonValue,
) -> Result<(), String> {
    let vault = key(&vault_path)?;
    let manager = app.state::<PluginManager>();
    let _lock = manager.1.lock().unwrap_or_else(|e| e.into_inner());
    let mut document = read()?;
    let entry = document["plugins"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["id"].as_str() == Some(&id))
        .ok_or("plugin_not_installed")?;
    let package: Package = serde_json::from_value(entry.clone()).map_err(|e| e.to_string())?;
    let scope = resolve_scope(&package.manifest, enabled, grants, &settings.0)?;
    if entry.get("scopes").is_none() {
        entry["scopes"] = json!({});
    }
    entry["scopes"][vault] = json!(scope);
    write(document)?;
    changed(&app, &id);
    Ok(())
}

fn resolve_scope(
    manifest: &manifest::Manifest,
    enabled: bool,
    grants: Vec<String>,
    settings: &Value,
) -> Result<Scope, String> {
    manifest::validate(manifest)?;
    if grants.iter().any(|g| !manifest.permissions.contains(g)) {
        return Err("plugin_invalid_grant".into());
    }
    let values = settings.as_object().ok_or("plugin_invalid_settings")?;
    if values.len() > manifest.settings.len() {
        return Err("plugin_invalid_settings".into());
    }
    let mut resolved = BTreeMap::new();
    for setting in &manifest.settings {
        let value = values.get(&setting.key).unwrap_or(&setting.default);
        if !manifest::valid_setting(setting, value) {
            return Err("plugin_invalid_settings".into());
        }
        resolved.insert(setting.key.clone(), value.clone());
    }
    if values.keys().any(|k| !resolved.contains_key(k)) {
        return Err("plugin_invalid_settings".into());
    }
    Ok(Scope {
        enabled,
        grants,
        settings: resolved,
    })
}

#[tauri::command]
#[specta::specta]
pub fn plugin_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<PluginManager>();
    let _lock = manager.1.lock().unwrap_or_else(|e| e.into_inner());
    let mut document = read()?;
    document["plugins"]
        .as_array_mut()
        .unwrap()
        .retain(|e| e["id"].as_str() != Some(&id));
    write(document)?;
    changed(&app, &id);
    // Private data is kept so reinstalling does not destroy user-owned state.
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn plugin_activate(
    window: tauri::WebviewWindow,
    vault_path: String,
) -> Result<Vec<DevelopmentPluginInfo>, String> {
    let vault = PathBuf::from(key(&vault_path)?);
    let manager = window.state::<PluginManager>();
    let _lock = manager.1.lock().unwrap_or_else(|e| e.into_inner());
    let mut prepared = Vec::new();
    for package in packages()? {
        let Some(scope) = package
            .scopes
            .get(vault.to_string_lossy().as_ref())
            .filter(|s| s.enabled)
        else {
            continue;
        };
        let scope = resolve_scope(
            &package.manifest,
            true,
            scope.grants.clone(),
            &json!(scope.settings),
        )?;
        if package.id != package.manifest.id {
            return Err("plugin_invalid_package".into());
        }
        if package.source.len() > 128 * 1024 {
            return Err("plugin_asset_too_large".into());
        }
        let plugin = manifest::DevelopmentPlugin {
            manifest: package.manifest,
            source: package.source,
        };
        prepared.push((plugin, scope));
    }
    let mut result = Vec::new();
    for (plugin, scope) in prepared {
        match register(
            &window,
            plugin,
            vault.clone(),
            scope.grants,
            json!(scope.settings),
        ) {
            Ok(info) => result.push(info),
            Err(error) => {
                for info in &result {
                    manager.unload(window.label(), Some(&info.instance_id), None);
                }
                return Err(error);
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn example() -> manifest::DevelopmentPlugin {
        let mut name = BTreeMap::new();
        name.insert("en".into(), "Reading tools".into());
        name.insert("zh-CN".into(), "阅读工具".into());
        let mut command_title = BTreeMap::new();
        command_title.insert("en".into(), "Mark paper as read".into());
        command_title.insert("zh-CN".into(), "标记论文为已读".into());
        let mut setting_title = BTreeMap::new();
        setting_title.insert("en".into(), "Notes heading".into());
        setting_title.insert("zh-CN".into(), "笔记标题".into());
        let manifest = manifest::Manifest {
            api_version: 1,
            id: "agentero.reading-tools".into(),
            permissions: vec![
                "vault:read".into(),
                "catalog:write".into(),
                "vault:notes:write".into(),
            ],
            commands: vec![manifest::Command {
                id: "mark-read".into(),
                title: command_title,
            }],
            version: "1.0.0".into(),
            name,
            menus: vec![],
            events: vec![],
            settings: vec![manifest::Setting {
                key: "heading".into(),
                title: setting_title,
                kind: "string".into(),
                default: json!("Highlights"),
            }],
        };
        manifest::validate(&manifest).unwrap();
        manifest::DevelopmentPlugin {
            manifest,
            source: "export async function onEvent() {}".into(),
        }
    }
    #[test]
    fn package_update_revokes_grants_and_keeps_unknown_fields() {
        let mut doc = json!({"schemaVersion":1,"plugins":[],"future":true});
        let id = install_snapshot(&mut doc, example()).unwrap();
        doc["plugins"][0]["future"] = json!(42);
        doc["plugins"][0]["scopes"] =
            json!({"/vault":{"enabled":true,"grants":["vault:read"],"settings":{}}});
        install_snapshot(&mut doc, example()).unwrap();
        assert_eq!(doc["plugins"].as_array().unwrap().len(), 1);
        assert_eq!(doc["plugins"][0]["id"], id);
        assert_eq!(doc["plugins"][0]["scopes"], json!({}));
        assert_eq!(doc["plugins"][0]["future"], 42);
        assert_eq!(doc["future"], true);
        assert!(doc["plugins"][0]["source"]
            .as_str()
            .unwrap()
            .contains("onEvent"));
    }
    #[test]
    fn grants_and_setting_values_are_validated() {
        let manifest = example().manifest;
        assert!(resolve_scope(&manifest, true, vec!["vault:write".into()], &json!({})).is_err());
        assert!(resolve_scope(&manifest, true, vec![], &json!({"heading":false})).is_err());
        assert!(resolve_scope(&manifest, true, vec![], &json!({"unknown":"x"})).is_err());
        let scope = resolve_scope(&manifest, true, vec!["vault:read".into()], &json!({})).unwrap();
        assert_eq!(scope.settings["heading"], "Highlights");
    }
}
