//! `agentero feed *` — Plaza feed subscriptions (RSS / Atom / JSON Feed).
//!
//! Headless access to the same store the desktop app uses
//! (`$XDG_DATA_HOME/agentero/feeds.sqlite`, see
//! `agentero_core::features::paper::discovery::feeds`). Vault-free:
//! subscriptions are user-global and never touch the catalog or Vault.
//!
//! Typical scheduled pipeline: `feed add <url>` once, then on a timer
//! `feed refresh --stale` + `feed item list --state unread --json`.

use crate::error::{CliError, ExitCode};
use crate::output::to_value;
use crate::resolve::GlobalOpts;

use agentero_core::error::AppError;
use agentero_core::features::paper::discovery::feeds as feeds_core;
use agentero_core::features::paper::discovery::feeds::{FeedItem, FeedSub};

use serde_json::{json, Value};

/// Core reports feed failures as i18n keys (`feeds.duplicate`, `feeds.http:404`,
/// …); map them to stable CLI error codes with self-describing messages.
fn map_err(err: AppError) -> CliError {
    let msg = err.to_string();
    match msg.as_str() {
        "feeds.duplicate" => CliError::new(
            "feed_duplicate",
            "a subscription with this URL already exists",
            ExitCode::Business,
        ),
        "feeds.not_found" => CliError::new(
            "feed_not_found",
            "no feed subscription or item with that id",
            ExitCode::Business,
        ),
        "feeds.empty" => CliError::new("feed_empty", "feed returned no items", ExitCode::Business),
        "feeds.empty_title" => CliError::usage("title must not be empty"),
        "feeds.too_large" => CliError::new(
            "feed_too_large",
            "feed body exceeds the 2 MiB limit",
            ExitCode::Business,
        ),
        "feeds.no_feed" => CliError::new(
            "feed_not_found_in_page",
            "no RSS/Atom/JSON feed link found on the page",
            ExitCode::Business,
        ),
        "feeds.invalid_url" => CliError::usage("feed URL must be a valid http(s) URL"),
        "feeds.body" => CliError::new(
            "feed_body_unavailable",
            "article body could not be extracted",
            ExitCode::Business,
        ),
        _ if msg.starts_with("feeds.http:") => {
            let status = msg
                .strip_prefix("feeds.http:")
                .map(str::to_string)
                .unwrap_or_default();
            CliError::new(
                "feed_http_error",
                format!("HTTP {status} fetching feed"),
                ExitCode::Business,
            )
        }
        _ if msg.starts_with("feeds.parse:") => CliError::new(
            "feed_parse_error",
            "feed body is not valid RSS / Atom / JSON",
            ExitCode::Business,
        ),
        _ if msg.starts_with("feeds.fetch:")
            || msg.starts_with("feeds.body:")
            || msg.starts_with("http client:") =>
        {
            CliError::new("feed_fetch_failed", msg, ExitCode::Business)
        }
        // Preserve core's io/json/sqlite codes instead of flattening them to
        // `message`; feed-specific keys are all mapped above.
        _ => CliError::new(err.code(), msg, ExitCode::Business),
    }
}

async fn run_add(globals: &GlobalOpts, url: &str, title: Option<&str>) -> Result<Value, CliError> {
    let sub: FeedSub = feeds_core::add_and_fetch(url.to_string(), title.map(str::to_string))
        .await
        .map_err(map_err)?;
    let lines = vec![globals.style.ok(&format!(
        "subscribed {} — {} items",
        sub.title, sub.item_count
    ))];
    let mut out = to_value(&sub)?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("lines".into(), json!(lines));
    }
    Ok(out)
}

fn run_remove(globals: &GlobalOpts, id: &str) -> Result<Value, CliError> {
    let msg = format!("Remove feed subscription '{id}' and its cached items?");
    let ok = crate::prompt::confirm(globals, &msg, false)?;
    if !ok {
        return Err(CliError::needs_confirmation("removal cancelled"));
    }
    feeds_core::remove(id).map_err(map_err)?;
    let lines = vec![globals.style.dim(&format!("removed {id}"))];
    Ok(json!({ "id": id, "removed": true, "lines": lines }))
}

async fn run_refresh(
    globals: &GlobalOpts,
    id: Option<&str>,
    stale: bool,
) -> Result<Value, CliError> {
    if let Some(id) = id {
        let data = feeds_core::list().map_err(map_err)?;
        if !data.subscriptions.iter().any(|sub| sub.id == id) {
            return Err(CliError::new(
                "feed_not_found",
                "no feed subscription with that id",
                ExitCode::Business,
            ));
        }
    }
    let result = feeds_core::refresh(id.map(str::to_string), stale)
        .await
        .map_err(map_err)?;
    let mut lines = vec![globals.style.ok(&format!(
        "fetched {} · failed {}",
        result.fetched, result.failed
    ))];
    for sub in &result.subscriptions {
        if let Some(err) = &sub.last_error {
            lines.push(globals.style.dim(&format!("✗ {}: {err}", sub.title)));
        }
    }
    let mut out = to_value(&result)?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("lines".into(), json!(lines));
    }
    Ok(out)
}

fn run_read(globals: &GlobalOpts, id: &str, read: bool) -> Result<Value, CliError> {
    let item: FeedItem = feeds_core::set_read(id, read).map_err(map_err)?;
    let verb = if read { "read" } else { "unread" };
    let lines = vec![globals.style.ok(&format!("marked {verb}: {}", item.title))];
    let mut out = slim_item_value(&item, false)?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("lines".into(), json!(lines));
    }
    Ok(out)
}

/// Item payload without the heavy HTML fields (kept with `--full`).
fn slim_item_value(item: &FeedItem, full: bool) -> Result<Value, CliError> {
    let mut v = to_value(item)?;
    if !full {
        if let Some(obj) = v.as_object_mut() {
            obj.remove("contentHtml");
            obj.remove("bodyMarkdown");
        }
    }
    Ok(v)
}

pub async fn dispatch(route: &str, a: &Value, g: &GlobalOpts) -> Result<Value, CliError> {
    use crate::dispatch::{required, string};
    let receipt = |id: &str, outcome: &str| json!({"changed":true,"preview":false,"items":[{"id":id,"outcome":outcome}]});
    match route {
        "feed add" => {
            let r = run_add(g, required(a, "url")?, string(a, "title")).await?;
            Ok(json!({"id":r["id"],"title":r["title"],"url":r["url"]}))
        }
        "feed remove" => {
            let id = required(a, "id")?;
            run_remove(g, id)?;
            Ok(receipt(id, "removed"))
        }
        "feed item mark" => {
            let id = required(a, "id")?;
            run_read(g, id, required(a, "state")? == "read")?;
            Ok(receipt(id, "updated"))
        }
        "feed refresh" => {
            let r = run_refresh(g, string(a, "feed"), a["stale"] == true).await?;
            let items=r["subscriptions"].as_array().into_iter().flatten()
                .filter(|s|string(a,"feed").is_none_or(|id|s["id"]==id))
                .map(|s|json!({"id":s["id"],"outcome":if s["lastError"].is_string(){"failed"}else{"updated"},"message":s["lastError"].as_str().unwrap_or("")})).collect::<Vec<_>>();
            Ok(json!({"items":items}))
        }
        "feed list" => {
            let r = feeds_core::list().map_err(map_err)?;
            let items = r
                .subscriptions
                .into_iter()
                .map(|s| json!({"id":s.id,"title":s.title,"url":s.url}))
                .collect::<Vec<_>>();
            paginate(items, a)
        }
        "feed item list" => {
            let mut items = Vec::new();
            let mut before = None;
            let mut id = None;
            loop {
                let page = feeds_core::items(
                    string(a, "feed"),
                    string(a, "kind").unwrap_or("all"),
                    200,
                    before.as_deref(),
                    id.as_deref(),
                )
                .map_err(map_err)?;
                let count = page.items.len();
                for entry in page.items {
                    before = entry.published_at.clone();
                    id = Some(entry.id.clone());
                    let state = if entry.read_at.is_some() {
                        "read"
                    } else {
                        "unread"
                    };
                    if string(a, "state").is_some_and(|s| s != state) {
                        continue;
                    }
                    let mut row = json!({"id":entry.id,"feed":entry.subscription_id,"title":entry.title,"url":entry.url.unwrap_or_default(),"state":state,"kind":if entry.paper_url.is_some(){"paper"}else{"other"}});
                    if a["full"] == true {
                        row["body"] = json!(entry
                            .body_markdown
                            .or(entry.content_html)
                            .unwrap_or_default());
                    }
                    items.push(row)
                }
                if count == 200 && before.is_none() {
                    before = id
                        .as_deref()
                        .map(feeds_core::item_sort_time)
                        .transpose()
                        .map_err(map_err)?
                        .flatten();
                }
                if count < 200 || before.is_none() {
                    break;
                }
            }
            paginate(items, a)
        }
        _ => Err(CliError::usage("unknown feed operation")),
    }
}

fn paginate(items: Vec<Value>, a: &Value) -> Result<Value, CliError> {
    use agentero_core::features::evidence::content_revision;
    let mut query = a.clone();
    query.as_object_mut().unwrap().remove("cursor");
    let revision = content_revision(&serde_json::to_vec(&(query, &items))?);
    let offset = match a["cursor"].as_str() {
        None => 0,
        Some(c) => c
            .strip_prefix(&format!("{revision}:"))
            .and_then(|n| n.parse::<usize>().ok())
            .filter(|n| *n <= items.len())
            .ok_or_else(|| {
                CliError::new(
                    "stale_cursor",
                    "feed results changed; start again",
                    ExitCode::Conflict,
                )
            })?,
    };
    let end = (offset + a["limit"].as_u64().unwrap_or(50) as usize).min(items.len());
    Ok(
        json!({"items":&items[offset..end],"next_cursor":(end<items.len()).then(||format!("{revision}:{end}"))}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_feed_error_keys() {
        let e = map_err(AppError::message("feeds.duplicate"));
        assert_eq!(e.code, "feed_duplicate");
        let e = map_err(AppError::message("feeds.not_found"));
        assert_eq!(e.code, "feed_not_found");
        let e = map_err(AppError::message("feeds.http:404"));
        assert_eq!(e.code, "feed_http_error");
        assert!(e.message.contains("404"));
        let e = map_err(AppError::message("feeds.empty"));
        assert_eq!(e.code, "feed_empty");
        let e = map_err(AppError::message("feeds.parse:no root element"));
        assert_eq!(e.code, "feed_parse_error");
        assert!(!e.message.contains("feeds.parse"));
        let e = map_err(AppError::message("feeds.invalid_url"));
        assert_eq!(e.code, "usage");
        assert_eq!(e.exit_code(), ExitCode::Usage);
        let e = map_err(AppError::Sqlite("database is locked".into()));
        assert_eq!(e.code, "sqlite");
        let e = map_err(AppError::message("some.other.error"));
        assert_eq!(e.code, "message");
    }

    #[test]
    fn slim_item_drops_html_fields() {
        let item = FeedItem {
            id: "i".into(),
            subscription_id: "s".into(),
            subscription_title: "S".into(),
            title: "T".into(),
            url: Some("https://example.com/a".into()),
            published_at: None,
            summary_text: "sum".into(),
            content_html: Some("<p>x</p>".into()),
            paper_url: None,
            imported_at: None,
            read_at: None,
            body_markdown: Some("# body".into()),
        };
        let slim = slim_item_value(&item, false).unwrap();
        assert!(slim.get("contentHtml").is_none());
        assert!(slim.get("bodyMarkdown").is_none());
        assert_eq!(slim["summaryText"], "sum");
        let full = slim_item_value(&item, true).unwrap();
        assert_eq!(full["contentHtml"], "<p>x</p>");
    }
}
