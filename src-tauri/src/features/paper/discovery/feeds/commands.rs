//! Tauri commands for plaza feed subscriptions.

use super::{
    add_and_fetch, items as list_items, list, mark_imported, refresh, remove, rename, resolve_body,
    set_pinned, FeedItem, FeedItemsPage, FeedList, FeedRefreshResult, FeedSub,
};
use crate::core::error::{map_err, ApiResult};
use serde::Deserialize;

#[tauri::command]
pub async fn feeds_list() -> ApiResult<FeedList> {
    match list() {
        Ok(data) => ApiResult::ok(data),
        Err(e) => map_err(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedsAddArgs {
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[tauri::command]
pub async fn feeds_add(args: FeedsAddArgs) -> ApiResult<FeedSub> {
    match add_and_fetch(args.url, args.title).await {
        Ok(data) => ApiResult::ok(data),
        Err(e) => map_err(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedsIdArgs {
    pub id: String,
}

#[tauri::command]
pub async fn feeds_remove(args: FeedsIdArgs) -> ApiResult<()> {
    match remove(&args.id) {
        Ok(()) => ApiResult::ok(()),
        Err(e) => map_err(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedsRenameArgs {
    pub id: String,
    pub title: String,
}

#[tauri::command]
pub async fn feeds_rename(args: FeedsRenameArgs) -> ApiResult<FeedSub> {
    match rename(&args.id, &args.title) {
        Ok(data) => ApiResult::ok(data),
        Err(e) => map_err(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedsRefreshArgs {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub stale_only: bool,
}

#[tauri::command]
pub async fn feeds_refresh(args: FeedsRefreshArgs) -> ApiResult<FeedRefreshResult> {
    match refresh(args.id, args.stale_only).await {
        Ok(data) => ApiResult::ok(data),
        Err(e) => map_err(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedsItemsArgs {
    #[serde(default)]
    pub subscription_id: Option<String>,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub before_published_at: Option<String>,
    #[serde(default)]
    pub before_id: Option<String>,
}

#[tauri::command]
pub async fn feeds_items(args: FeedsItemsArgs) -> ApiResult<FeedItemsPage> {
    let filter = args.filter.as_deref().unwrap_or("all");
    let limit = args.limit.unwrap_or(100).min(200);
    match list_items(
        args.subscription_id.as_deref(),
        filter,
        limit,
        args.before_published_at.as_deref(),
        args.before_id.as_deref(),
    ) {
        Ok(data) => ApiResult::ok(data),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
pub async fn feeds_mark_imported(args: FeedsIdArgs) -> ApiResult<FeedItem> {
    match mark_imported(&args.id) {
        Ok(data) => ApiResult::ok(data),
        Err(e) => map_err(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedsSetPinnedArgs {
    pub id: String,
    pub pinned: bool,
}

#[tauri::command]
pub async fn feeds_set_pinned(args: FeedsSetPinnedArgs) -> ApiResult<FeedSub> {
    match set_pinned(&args.id, args.pinned) {
        Ok(data) => ApiResult::ok(data),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
pub async fn feeds_resolve_body(args: FeedsIdArgs) -> ApiResult<FeedItem> {
    match resolve_body(&args.id).await {
        Ok(data) => ApiResult::ok(data),
        Err(e) => map_err(e),
    }
}
