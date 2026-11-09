use serde::Serialize;
use std::time::Duration;
use tauri::{Manager, ResourceId, Runtime, Webview};
use tauri_plugin_updater::{Error, UpdaterExt};

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    rid: ResourceId,
    current_version: String,
    version: String,
    body: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn app_update_check<R: Runtime>(
    webview: Webview<R>,
    proxy: Option<String>,
    retry_on_timeout: bool,
) -> Result<Option<AppUpdate>, String> {
    let mut builder = webview.updater_builder().timeout(CHECK_TIMEOUT);
    if let Some(proxy) = proxy {
        builder = builder.proxy(tauri::Url::parse(&proxy).map_err(|error| error.to_string())?);
    }
    let updater = builder.build().map_err(|error| error.to_string())?;

    // The plugin's IPC error string loses reqwest's timeout cause.
    let mut result = updater.check().await;
    if retry_on_timeout && matches!(&result, Err(Error::Reqwest(error)) if error.is_timeout()) {
        log::info!("updater_check timed out; retrying once");
        result = updater.check().await;
    }

    Ok(result.map_err(|error| error.to_string())?.map(|update| {
        let current_version = update.current_version.clone();
        let version = update.version.clone();
        let body = update.body.clone();
        // Register the same native resource consumed by the updater plugin's download and install.
        let rid = webview.resources_table().add(update);
        AppUpdate {
            rid,
            current_version,
            version,
            body,
        }
    }))
}
