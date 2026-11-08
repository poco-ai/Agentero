//! `agentero feed *` — Plaza feed subscriptions (RSS / Atom / JSON Feed).
//!
//! Headless access to the same store the desktop app uses
//! (`$XDG_DATA_HOME/agentero/feeds.sqlite`, see
//! `agentero_core::features::paper::discovery::feeds`). Vault-free:
//! subscriptions are user-global and never touch the catalog or Vault.
//!
//! Typical scheduled pipeline: `feed add <url>` once, then on a timer
//! `feed refresh --stale` + `feed items --filter unread --json`.

use crate::error::{CliError, ExitCode};
use crate::output::to_value;
use crate::resolve::GlobalOpts;
use crate::style::{format_table, truncate_chars};
use agentero_core::error::AppError;
use agentero_core::features::paper::discovery::feeds as feeds_core;
use agentero_core::features::paper::discovery::feeds::{FeedItem, FeedSub};
use clap::Subcommand;
use serde_json::{json, Value};

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: i64 = 200;

#[derive(Debug, Subcommand)]
pub enum FeedCmd {
    /// List subscribed feeds (pinned first, then oldest first).
    List,

    /// Subscribe to a feed and fetch its first batch.
    Add {
        /// RSS / Atom / JSON Feed URL (an HTML page linking to a feed is followed).
        #[arg(value_hint = clap::ValueHint::Url)]
        url: String,
        /// Subscription title (default: the feed's own title).
        #[arg(long)]
        title: Option<String>,
    },

    /// Remove a subscription and its cached items.
    Remove {
        /// Subscription id (`feed list`).
        id: String,
    },

    /// Fetch feeds now: all, one (`--id`), or only stale (`--stale`).
    Refresh {
        /// Only this subscription id (default: all).
        #[arg(long)]
        id: Option<String>,
        /// Skip subscriptions fetched within the last 15 minutes (default off).
        #[arg(long)]
        stale: bool,
    },

    /// List cached feed items, newest first (all subscriptions by default).
    Items {
        /// Only this subscription id (default: all).
        #[arg(long)]
        subscription: Option<String>,
        /// Item filter: `all` | `unread` | `paper` | `other` (default `all`).
        #[arg(
            long,
            default_value = "all",
            value_parser = ["all", "unread", "paper", "other"]
        )]
        filter: String,
        /// Max items to return (1..=200, default 50).
        #[arg(
            long,
            default_value_t = DEFAULT_LIMIT,
            value_parser = clap::value_parser!(u32).range(1..=MAX_LIMIT)
        )]
        limit: u32,
        /// Include `contentHtml` / `bodyMarkdown` (heavy HTML; off by default).
        #[arg(long)]
        full: bool,
    },

    /// Mark an item read or unread.
    Read {
        /// Item id (`feed items`).
        id: String,
        /// Mark unread instead of read.
        #[arg(long)]
        unread: bool,
    },
}

pub async fn run(cmd: FeedCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        FeedCmd::List => run_list(globals),
        FeedCmd::Add { url, title } => run_add(globals, &url, title.as_deref()).await,
        FeedCmd::Remove { id } => run_remove(globals, &id),
        FeedCmd::Refresh { id, stale } => run_refresh(globals, id.as_deref(), stale).await,
        FeedCmd::Items {
            subscription,
            filter,
            limit,
            full,
        } => run_items(globals, subscription.as_deref(), &filter, limit, full),
        FeedCmd::Read { id, unread } => run_read(globals, &id, !unread),
    }
}

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

fn run_list(globals: &GlobalOpts) -> Result<Value, CliError> {
    let data = feeds_core::list().map_err(map_err)?;
    let lines: Vec<String> = if data.subscriptions.is_empty() {
        vec![globals.style.dim("(no subscriptions)")]
    } else {
        let rows: Vec<Vec<String>> = data
            .subscriptions
            .iter()
            .map(|s| {
                let title = if s.pinned {
                    format!("📌 {}", s.title)
                } else {
                    s.title.clone()
                };
                vec![
                    s.id.clone(),
                    truncate_chars(&title, 32),
                    s.url.clone(),
                    s.item_count.to_string(),
                    s.last_error.clone().unwrap_or_default(),
                ]
            })
            .collect();
        format_table(
            globals.style,
            &["ID", "TITLE", "URL", "ITEMS", "ERROR"],
            &rows,
        )
    };
    let mut out = to_value(&data)?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("lines".into(), json!(lines));
    }
    Ok(out)
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

fn run_items(
    globals: &GlobalOpts,
    subscription: Option<&str>,
    filter: &str,
    limit: u32,
    full: bool,
) -> Result<Value, CliError> {
    if let Some(id) = subscription {
        let data = feeds_core::list().map_err(map_err)?;
        if !data.subscriptions.iter().any(|sub| sub.id == id) {
            return Err(CliError::new(
                "feed_not_found",
                "no feed subscription with that id",
                ExitCode::Business,
            ));
        }
    }
    let page = feeds_core::items(subscription, filter, limit, None, None).map_err(map_err)?;

    let mut items_json: Vec<Value> = Vec::with_capacity(page.items.len());
    let mut unread = 0usize;
    for item in &page.items {
        if item.read_at.is_none() {
            unread += 1;
        }
        items_json.push(slim_item_value(item, full)?);
    }

    let lines: Vec<String> = if page.items.is_empty() {
        vec![globals.style.dim("(no items)")]
    } else {
        let rows: Vec<Vec<String>> = page
            .items
            .iter()
            .map(|i| {
                let title = if i.read_at.is_none() {
                    format!("● {}", i.title)
                } else {
                    i.title.clone()
                };
                vec![
                    i.id.clone(),
                    i.published_at.clone().unwrap_or_default(),
                    truncate_chars(&i.subscription_title, 20),
                    truncate_chars(&title, 56),
                ]
            })
            .collect();
        let mut out = format_table(
            globals.style,
            &["ID", "PUBLISHED", "SOURCE", "TITLE (● = unread)"],
            &rows,
        );
        out.push(
            globals
                .style
                .dim(&format!("{} items · {} unread", page.items.len(), unread)),
        );
        out
    };

    Ok(json!({ "items": items_json, "lines": lines }))
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
