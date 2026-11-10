//! Serialized read/merge/atomic-write for the translation sidecar across windows.

use crate::core::error::{map_err, ApiResult, AppError};
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

static CACHE_WRITE: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LayoutTranslateCacheWriteArgs {
    pub paper_abs_path: String,
    #[specta(type = crate::core::json::Json)]
    pub sidecar: Value,
    pub preserve_existing: bool,
}

fn same_key(a: &Value, b: &Value) -> bool {
    a["schemaVersion"] == b["schemaVersion"]
        && ["providerId", "sourceLang", "targetLang", "serviceKey"]
            .iter()
            .all(|key| a["source"][key] == b["source"][key])
}

fn write_cache(path: &Path, mut sidecar: Value, preserve: bool) -> Result<(), AppError> {
    let _guard = CACHE_WRITE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let mut items = std::collections::BTreeMap::<String, Value>::new();
    if preserve {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(existing) = serde_json::from_slice::<Value>(&bytes) {
                if same_key(&existing, &sidecar) {
                    for item in existing["items"].as_array().into_iter().flatten() {
                        if let Some(id) = item["id"].as_str() {
                            items.insert(id.to_string(), item.clone());
                        }
                    }
                }
            }
        }
    }
    for item in sidecar["items"].as_array().into_iter().flatten() {
        if let Some(id) = item["id"].as_str() {
            items.insert(id.to_string(), item.clone());
        }
    }
    let mut items: Vec<_> = items.into_values().collect();
    items.sort_by(|a, b| {
        for key in ["pageIndex", "readingOrder"] {
            let order = a[key]
                .as_f64()
                .unwrap_or(0.0)
                .total_cmp(&b[key].as_f64().unwrap_or(0.0));
            if !order.is_eq() {
                return order;
            }
        }
        for key in ["y", "x"] {
            let order = a["bbox"][key]
                .as_f64()
                .unwrap_or(0.0)
                .total_cmp(&b["bbox"][key].as_f64().unwrap_or(0.0));
            if !order.is_eq() {
                return order;
            }
        }
        std::cmp::Ordering::Equal
    });
    sidecar["items"] = Value::Array(items);
    let parent = path.parent().expect("sidecar parent");
    std::fs::create_dir_all(parent).map_err(|e| AppError::message(e.to_string()))?;
    crate::core::fs::json_store(path, &sidecar).map_err(|e| AppError::message(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn layout_translate_cache_write(args: LayoutTranslateCacheWriteArgs) -> ApiResult<()> {
    let paper = match crate::core::fs::resolve_vault(&args.paper_abs_path) {
        Ok(paper) => paper,
        Err(error) => return map_err(error),
    };
    match tokio::task::spawn_blocking(move || {
        write_cache(
            &paper.join("source/layout-translate.json"),
            args.sidecar,
            args.preserve_existing,
        )
    })
    .await
    {
        Ok(Ok(())) => ApiResult::ok(()),
        Ok(Err(error)) => map_err(error),
        Err(error) => map_err(AppError::message(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cache(id: &str, service: &str) -> Value {
        json!({"schemaVersion": 2, "source": {"providerId": "test", "sourceLang": "en", "targetLang": "zh", "serviceKey": service},
            "items": [{"id": id, "pageIndex": 0, "readingOrder": 0}]})
    }

    #[test]
    fn concurrent_page_and_document_writes_keep_both_results() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source/layout-translate.json");
        std::thread::scope(|scope| {
            for id in ["page", "document"] {
                let path = &path;
                scope.spawn(move || write_cache(path, cache(id, "a"), true).unwrap());
            }
        });
        let result: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 2);
        write_cache(&path, cache("new-key", "b"), true).unwrap();
        let result: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["items"][0]["id"], "new-key");
    }
}
