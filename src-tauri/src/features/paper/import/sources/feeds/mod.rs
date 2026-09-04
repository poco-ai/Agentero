//! Plaza RSS / Atom / JSON Feed subscriptions.
//!
//! Stored in `$XDG_DATA_HOME/agentero/feeds.sqlite`. Does not write catalog or Vault.
//!
//! @see docs/development/plaza-feeds.md

mod body;
pub mod parse;
mod schema;

#[cfg(feature = "desktop")]
pub mod commands;

use crate::core::error::AppError;
use crate::core::http;
use body::{
    ensure_heading, extract_article_html, extract_paper_doi, html_to_markdown,
    is_fetchable_http_url, strip_trailing_ellipsis,
};
use chrono::Utc;
use parse::{
    discover_feed_href, looks_like_html, normalize_feed_url, parse_feed_bytes, resolve_href,
    ParsedFeed, ParsedItem,
};
use rusqlite::{params, Connection, OptionalExtension};
use schema::{ensure_feeds, ITEMS_PER_FEED};
use serde::Serialize;
use std::time::Duration;
use url::Url;
use uuid::Uuid;

const FETCH_TIMEOUT_SECS: u64 = 20;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const STALE_SECS: i64 = 15 * 60;
const REFRESH_CONCURRENCY: usize = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedSub {
    pub id: String,
    pub url: String,
    pub title: String,
    pub added_at: String,
    pub last_fetched_at: Option<String>,
    pub last_error: Option<String>,
    pub item_count: i64,
    pub pinned: bool,
    pub pinned_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub id: String,
    pub subscription_id: String,
    pub subscription_title: String,
    pub title: String,
    pub url: Option<String>,
    pub published_at: Option<String>,
    pub summary_text: String,
    pub content_html: Option<String>,
    pub paper_url: Option<String>,
    pub imported_at: Option<String>,
    pub body_markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedList {
    pub subscriptions: Vec<FeedSub>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedRefreshResult {
    pub subscriptions: Vec<FeedSub>,
    pub fetched: u32,
    pub failed: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItemsPage {
    pub items: Vec<FeedItem>,
}

struct SubRow {
    id: String,
    url: String,
    title: String,
    etag: Option<String>,
    last_modified: Option<String>,
    last_fetched_at: Option<String>,
}

enum FetchOutcome {
    NotModified {
        etag: Option<String>,
        last_modified: Option<String>,
    },
    Body {
        url: String,
        etag: Option<String>,
        last_modified: Option<String>,
        parsed: ParsedFeed,
    },
    Failed(String),
}

fn now_rfc3339() -> String {
    crate::core::time::now_rfc3339_millis()
}

fn http_client() -> Result<reqwest::Client, AppError> {
    http::client(Duration::from_secs(FETCH_TIMEOUT_SECS))
}

/// Browser-impersonating client for article pages that reject bot UAs (403).
/// Keeps a cookie store so JS-challenge sites (403 + Set-Cookie + JS reload,
/// e.g. the WAF in front of spaces.ac.cn) pass on the retried request.
fn http_client_browser() -> Result<reqwest::Client, AppError> {
    http::client_builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent(http::BROWSER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(
            http::DEFAULT_REDIRECT_LIMIT,
        ))
        .cookie_store(true)
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))
}

struct RawFetch {
    url: String,
    status: u16,
    content_type: String,
    etag: Option<String>,
    last_modified: Option<String>,
    body: Vec<u8>,
}

async fn http_get(
    url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> Result<RawFetch, AppError> {
    http_get_accept(url, etag, last_modified, None).await
}

async fn http_get_accept(
    url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
    accept: Option<&str>,
) -> Result<RawFetch, AppError> {
    http_get_accept_with(&http_client()?, url, etag, last_modified, accept).await
}

async fn http_get_accept_with(
    client: &reqwest::Client,
    url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
    accept: Option<&str>,
) -> Result<RawFetch, AppError> {
    let mut req = client.get(url);
    if let Some(tag) = etag.filter(|s| !s.is_empty()) {
        req = req.header(reqwest::header::IF_NONE_MATCH, tag);
    }
    if let Some(lm) = last_modified.filter(|s| !s.is_empty()) {
        req = req.header(reqwest::header::IF_MODIFIED_SINCE, lm);
    }
    if let Some(accept) = accept.filter(|s| !s.is_empty()) {
        req = req.header(reqwest::header::ACCEPT, accept);
    }
    let res = req
        .send()
        .await
        .map_err(|e| AppError::message(format!("feeds.fetch:{e}")))?;
    let final_url = res.url().clone();
    if final_url.scheme() != "http" && final_url.scheme() != "https" {
        return Err(AppError::message("feeds.invalid_url"));
    }
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let out_etag = res
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let out_lm = res
        .headers()
        .get(reqwest::header::LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = res
        .bytes()
        .await
        .map_err(|e| AppError::message(format!("feeds.body:{e}")))?;
    if body.len() > MAX_BODY_BYTES {
        return Err(AppError::message("feeds.too_large"));
    }
    Ok(RawFetch {
        url: final_url.to_string(),
        status,
        content_type,
        etag: out_etag,
        last_modified: out_lm,
        body: body.to_vec(),
    })
}

async fn fetch_and_parse(
    url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
    fallback_title: &str,
) -> FetchOutcome {
    match fetch_and_parse_inner(url, etag, last_modified, fallback_title).await {
        Ok(outcome) => outcome,
        Err(e) => FetchOutcome::Failed(e.to_string()),
    }
}

async fn fetch_and_parse_inner(
    url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
    fallback_title: &str,
) -> Result<FetchOutcome, AppError> {
    let raw = http_get(url, etag, last_modified).await?;
    if raw.status == 304 {
        return Ok(FetchOutcome::NotModified {
            etag: raw.etag,
            last_modified: raw.last_modified,
        });
    }
    if !(200..300).contains(&raw.status) {
        return Err(AppError::message(format!("feeds.http:{}", raw.status)));
    }
    let body_str = String::from_utf8_lossy(&raw.body);
    if looks_like_html(&raw.content_type, &body_str) {
        let href =
            discover_feed_href(&body_str).ok_or_else(|| AppError::message("feeds.no_feed"))?;
        let discovered = resolve_href(&raw.url, &href)?;
        let feed_raw = http_get(&discovered, None, None).await?;
        if !(200..300).contains(&feed_raw.status) {
            return Err(AppError::message(format!("feeds.http:{}", feed_raw.status)));
        }
        let parsed = parse_feed_bytes(&feed_raw.body, fallback_title)?;
        return Ok(FetchOutcome::Body {
            url: discovered,
            etag: feed_raw.etag,
            last_modified: feed_raw.last_modified,
            parsed,
        });
    }
    let parsed = parse_feed_bytes(&raw.body, fallback_title)?;
    Ok(FetchOutcome::Body {
        url: normalize_feed_url(&raw.url).unwrap_or_else(|_| url.to_string()),
        etag: raw.etag,
        last_modified: raw.last_modified,
        parsed,
    })
}

fn list_subs(conn: &Connection) -> Result<Vec<FeedSub>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.url, s.title, s.added_at, s.last_fetched_at, s.last_error,
                (SELECT COUNT(*) FROM items i WHERE i.subscription_id = s.id),
                s.pinned, s.pinned_at
         FROM subscriptions s
         ORDER BY s.pinned DESC, s.pinned_at DESC, s.added_at ASC",
    )?;
    let rows = stmt.query_map([], map_feed_sub)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn map_feed_sub(row: &rusqlite::Row<'_>) -> rusqlite::Result<FeedSub> {
    let pinned_raw: i64 = row.get(7)?;
    Ok(FeedSub {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        added_at: row.get(3)?,
        last_fetched_at: row.get(4)?,
        last_error: row.get(5)?,
        item_count: row.get(6)?,
        pinned: pinned_raw != 0,
        pinned_at: row.get(8)?,
    })
}

fn get_sub(conn: &Connection, id: &str) -> Result<FeedSub, AppError> {
    list_subs(conn)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| AppError::message("feeds.not_found"))
}

fn url_taken(conn: &Connection, url: &str, except_id: Option<&str>) -> Result<bool, AppError> {
    let count: i64 = match except_id {
        Some(id) => conn.query_row(
            "SELECT COUNT(*) FROM subscriptions WHERE url = ?1 AND id != ?2",
            params![url, id],
            |r| r.get(0),
        )?,
        None => conn.query_row(
            "SELECT COUNT(*) FROM subscriptions WHERE url = ?1",
            [url],
            |r| r.get(0),
        )?,
    };
    Ok(count > 0)
}

fn insert_subscription(conn: &Connection, url: &str, title: &str) -> Result<String, AppError> {
    if url_taken(conn, url, None)? {
        return Err(AppError::message("feeds.duplicate"));
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO subscriptions (id, url, title, added_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, url, title, now_rfc3339()],
    )?;
    Ok(id)
}

fn apply_outcome(conn: &Connection, id: &str, outcome: FetchOutcome) -> Result<(), AppError> {
    match outcome {
        FetchOutcome::NotModified {
            etag,
            last_modified,
        } => {
            conn.execute(
                "UPDATE subscriptions
                 SET last_fetched_at = ?1, last_error = NULL,
                     etag = COALESCE(?2, etag), last_modified = COALESCE(?3, last_modified)
                 WHERE id = ?4",
                params![now_rfc3339(), etag, last_modified, id],
            )?;
        }
        FetchOutcome::Body {
            url,
            etag,
            last_modified,
            parsed,
        } => {
            if url_taken(conn, &url, Some(id))? {
                conn.execute(
                    "UPDATE subscriptions SET last_error = ?1, last_fetched_at = ?2 WHERE id = ?3",
                    params!["feeds.duplicate", now_rfc3339(), id],
                )?;
                return Ok(());
            }
            conn.execute(
                "UPDATE subscriptions
                 SET url = ?1, title = CASE WHEN title = '' OR title = url THEN ?2 ELSE title END,
                     last_fetched_at = ?3, last_error = NULL, etag = ?4, last_modified = ?5
                 WHERE id = ?6",
                params![url, parsed.title, now_rfc3339(), etag, last_modified, id],
            )?;
            upsert_items(conn, id, &parsed.items)?;
        }
        FetchOutcome::Failed(err) => {
            conn.execute(
                "UPDATE subscriptions SET last_error = ?1, last_fetched_at = ?2 WHERE id = ?3",
                params![err, now_rfc3339(), id],
            )?;
        }
    }
    Ok(())
}

fn upsert_items(conn: &Connection, sub_id: &str, items: &[ParsedItem]) -> Result<(), AppError> {
    let seen = now_rfc3339();
    for item in items {
        conn.execute(
            "INSERT INTO items (
                id, subscription_id, guid, title, url, published_at,
                summary_text, content_html, paper_url, imported_at, first_seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)
             ON CONFLICT(subscription_id, guid) DO UPDATE SET
                title = excluded.title,
                url = excluded.url,
                published_at = excluded.published_at,
                summary_text = excluded.summary_text,
                content_html = excluded.content_html,
                -- Feeds without DOI fields send NULL here; keep values that
                -- were backfilled from the article page (resolve_body).
                paper_url = COALESCE(NULLIF(items.paper_url, ''), excluded.paper_url),
                body_markdown = CASE
                    WHEN items.url IS excluded.url THEN items.body_markdown
                    ELSE NULL
                END",
            params![
                Uuid::new_v4().to_string(),
                sub_id,
                item.guid,
                item.title,
                item.url,
                item.published_at,
                item.summary_text,
                item.content_html,
                item.paper_url,
                seen,
            ],
        )?;
    }
    conn.execute(
        "DELETE FROM items WHERE subscription_id = ?1 AND id NOT IN (
            SELECT id FROM (
                SELECT id FROM items WHERE subscription_id = ?1
                ORDER BY COALESCE(published_at, first_seen_at) DESC, id DESC
                LIMIT ?2
            )
         )",
        params![sub_id, ITEMS_PER_FEED],
    )?;
    Ok(())
}

fn title_from_url(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

fn is_stale(last_fetched_at: &Option<String>) -> bool {
    let Some(raw) = last_fetched_at else {
        return true;
    };
    let Ok(ts) = chrono::DateTime::parse_from_rfc3339(raw) else {
        return true;
    };
    (Utc::now() - ts.with_timezone(&Utc)).num_seconds() >= STALE_SECS
}

fn load_refresh_targets(
    conn: &Connection,
    id: Option<&str>,
    stale_only: bool,
) -> Result<Vec<SubRow>, AppError> {
    let mut sql = String::from(
        "SELECT id, url, title, etag, last_modified, last_fetched_at FROM subscriptions",
    );
    if id.is_some() {
        sql.push_str(" WHERE id = ?1");
    }
    sql.push_str(" ORDER BY added_at ASC");
    let mut stmt = conn.prepare(&sql)?;
    let mapped = if let Some(id) = id {
        stmt.query_map([id], map_sub_row)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map([], map_sub_row)?
            .collect::<Result<Vec<_>, _>>()?
    };
    if stale_only && id.is_none() {
        Ok(mapped
            .into_iter()
            .filter(|s| is_stale(&s.last_fetched_at))
            .collect())
    } else {
        Ok(mapped)
    }
}

fn map_sub_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubRow> {
    Ok(SubRow {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        etag: row.get(3)?,
        last_modified: row.get(4)?,
        last_fetched_at: row.get(5)?,
    })
}

fn query_items(
    conn: &Connection,
    subscription_id: Option<&str>,
    filter: &str,
    limit: u32,
    before_published_at: Option<&str>,
    before_id: Option<&str>,
) -> Result<Vec<FeedItem>, AppError> {
    let mut sql = String::from(
        "SELECT i.id, i.subscription_id, s.title, i.title, i.url, i.published_at,
                i.summary_text, i.content_html, i.paper_url, i.imported_at, i.body_markdown
         FROM items i
         JOIN subscriptions s ON s.id = i.subscription_id
         WHERE 1=1",
    );
    let mut binds: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(sid) = subscription_id {
        sql.push_str(" AND i.subscription_id = ?");
        binds.push(sid.to_string().into());
    }
    match filter {
        "paper" => sql.push_str(" AND i.paper_url IS NOT NULL AND i.paper_url != ''"),
        "other" => sql.push_str(" AND (i.paper_url IS NULL OR i.paper_url = '')"),
        _ => {}
    }
    if let (Some(ts), Some(bid)) = (before_published_at, before_id) {
        sql.push_str(" AND (COALESCE(i.published_at, i.first_seen_at), i.id) < (?, ?)");
        binds.push(ts.to_string().into());
        binds.push(bid.to_string().into());
    }
    sql.push_str(" ORDER BY COALESCE(i.published_at, i.first_seen_at) DESC, i.id DESC LIMIT ?");
    binds.push(i64::from(limit).into());

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(binds), map_item_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list() -> Result<FeedList, AppError> {
    let conn = ensure_feeds()?;
    Ok(FeedList {
        subscriptions: list_subs(&conn)?,
    })
}

fn apply_add_fetch(id: &str, outcome: FetchOutcome) -> Result<FeedSub, AppError> {
    let conn = ensure_feeds()?;
    apply_outcome(&conn, id, outcome)?;
    get_sub(&conn, id)
}

pub fn remove(id: &str) -> Result<(), AppError> {
    let conn = ensure_feeds()?;
    let n = conn.execute("DELETE FROM subscriptions WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(AppError::message("feeds.not_found"));
    }
    Ok(())
}

pub fn rename(id: &str, title: &str) -> Result<FeedSub, AppError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::message("feeds.empty_title"));
    }
    let conn = ensure_feeds()?;
    let n = conn.execute(
        "UPDATE subscriptions SET title = ?1 WHERE id = ?2",
        params![title, id],
    )?;
    if n == 0 {
        return Err(AppError::message("feeds.not_found"));
    }
    get_sub(&conn, id)
}

pub fn mark_imported(id: &str) -> Result<FeedItem, AppError> {
    let conn = ensure_feeds()?;
    let n = conn.execute(
        "UPDATE items SET imported_at = ?1 WHERE id = ?2",
        params![now_rfc3339(), id],
    )?;
    if n == 0 {
        return Err(AppError::message("feeds.not_found"));
    }
    get_item(&conn, id)
}

fn map_item_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FeedItem> {
    Ok(FeedItem {
        id: row.get(0)?,
        subscription_id: row.get(1)?,
        subscription_title: row.get(2)?,
        title: row.get(3)?,
        url: row.get(4)?,
        published_at: row.get(5)?,
        summary_text: row.get(6)?,
        content_html: row.get(7)?,
        paper_url: row.get(8)?,
        imported_at: row.get(9)?,
        body_markdown: row.get(10)?,
    })
}

fn get_item(conn: &Connection, id: &str) -> Result<FeedItem, AppError> {
    conn.query_row(
        "SELECT i.id, i.subscription_id, s.title, i.title, i.url, i.published_at,
                i.summary_text, i.content_html, i.paper_url, i.imported_at, i.body_markdown
         FROM items i JOIN subscriptions s ON s.id = i.subscription_id
         WHERE i.id = ?1",
        [id],
        map_item_row,
    )
    .optional()?
    .ok_or_else(|| AppError::message("feeds.not_found"))
}

pub fn set_pinned(id: &str, pinned: bool) -> Result<FeedSub, AppError> {
    let conn = ensure_feeds()?;
    let n = if pinned {
        conn.execute(
            "UPDATE subscriptions SET pinned = 1, pinned_at = ?1 WHERE id = ?2",
            params![now_rfc3339(), id],
        )?
    } else {
        conn.execute(
            "UPDATE subscriptions SET pinned = 0, pinned_at = NULL WHERE id = ?1",
            [id],
        )?
    };
    if n == 0 {
        return Err(AppError::message("feeds.not_found"));
    }
    get_sub(&conn, id)
}

fn markdown_from_rss(item: &FeedItem) -> String {
    if let Some(html) = item
        .content_html
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let md = html_to_markdown(html);
        if !md.is_empty() {
            return md;
        }
    }
    item.summary_text.trim().to_string()
}

fn item_with_body(mut item: FeedItem, body: String) -> FeedItem {
    item.body_markdown = Some(body);
    item
}

fn persist_resolved(
    conn: &Connection,
    id: &str,
    body: &str,
    paper_url: Option<&str>,
) -> Result<FeedItem, AppError> {
    conn.execute(
        "UPDATE items SET body_markdown = ?1,
            paper_url = COALESCE(NULLIF(items.paper_url, ''), ?3)
         WHERE id = ?2",
        params![body, id, paper_url],
    )?;
    get_item(conn, id)
}

/// Article page fetched for the detail view: the converted Markdown plus the
/// DOI scraped from publisher `<meta>` tags, when the page has one.
struct FetchedArticle {
    markdown: String,
    paper_url: Option<String>,
}

async fn fetch_article(url: &str, title: &str) -> Result<FetchedArticle, AppError> {
    let accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";
    let client = http_client_browser()?;
    let mut raw = http_get_accept_with(&client, url, None, None, Some(accept)).await?;
    // Some WAFs answer the first visit with 403 + Set-Cookie + a JS reload
    // stub; a browser follows up with the cookie. Replay that exchange.
    if raw.status == 403 && looks_like_js_challenge(&raw.body) {
        raw = http_get_accept_with(&client, url, None, None, Some(accept)).await?;
    }
    if !(200..300).contains(&raw.status) {
        return Err(AppError::message(format!("feeds.http:{}", raw.status)));
    }
    let body = String::from_utf8_lossy(&raw.body);
    if looks_like_html(&raw.content_type, &body) {
        let paper_url = extract_paper_doi(&body).map(|doi| format!("https://doi.org/{doi}"));
        let article = extract_article_html(&body, Some(url));
        let md = html_to_markdown(&article);
        if md.trim().is_empty() {
            return Err(AppError::message("feeds.body"));
        }
        return Ok(FetchedArticle {
            markdown: ensure_heading(&md, title),
            paper_url,
        });
    }
    let text = body.trim();
    if text.is_empty() {
        return Err(AppError::message("feeds.body"));
    }
    Ok(FetchedArticle {
        markdown: ensure_heading(text, title),
        paper_url: None,
    })
}

/// True when a 403 body is a tiny JS-reload challenge stub rather than a real
/// error page (e.g. `<script>window.location.href="/"</script>` plus an empty
/// shell, with the challenge cookie delivered via Set-Cookie).
fn looks_like_js_challenge(body: &[u8]) -> bool {
    if body.len() > 8 * 1024 {
        return false;
    }
    String::from_utf8_lossy(body).contains("window.location")
}

/// Resolve a full article body for the detail page.
///
/// Always attempts to fetch the original article page when `item.url` is a
/// fetchable HTTP URL, regardless of whether the RSS already ships a summary.
/// The fetched HTML is run through Readability (dom_smoothie) and converted
/// to Markdown.  While the page is open anyway, a DOI scraped from the
/// publisher's `<meta>` tags backfills `items.paper_url` so feeds without
/// explicit DOIs (e.g. nature.com subject feeds) still offer the paper import
/// action.  Results are cached in `items.body_markdown`.
pub async fn resolve_body(id: &str) -> Result<FeedItem, AppError> {
    let existing = {
        let conn = ensure_feeds()?;
        get_item(&conn, id)?
    };
    if let Some(md) = existing
        .body_markdown
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
    {
        return Ok(item_with_body(existing, md));
    }
    let rss = markdown_from_rss(&existing);
    let can_fetch = existing.url.as_deref().is_some_and(is_fetchable_http_url);
    if !can_fetch {
        let body = ensure_heading(&strip_trailing_ellipsis(&rss), &existing.title);
        let conn = ensure_feeds()?;
        return persist_resolved(&conn, id, &body, None);
    }
    let url = existing.url.clone().unwrap_or_default();
    match fetch_article(&url, &existing.title).await {
        Ok(article) => {
            let chosen = if article.markdown.chars().count() + 40 >= rss.chars().count() {
                article.markdown
            } else {
                rss
            };
            let conn = ensure_feeds()?;
            persist_resolved(
                &conn,
                id,
                &ensure_heading(&strip_trailing_ellipsis(&chosen), &existing.title),
                article.paper_url.as_deref(),
            )
        }
        Err(e) => {
            log::warn!(target: "agentero::feeds", "article body fetch failed for {url}: {e}");
            let fallback = ensure_heading(&strip_trailing_ellipsis(&rss), &existing.title);
            Ok(item_with_body(existing, fallback))
        }
    }
}

pub fn items(
    subscription_id: Option<&str>,
    filter: &str,
    limit: u32,
    before_published_at: Option<&str>,
    before_id: Option<&str>,
) -> Result<FeedItemsPage, AppError> {
    let conn = ensure_feeds()?;
    Ok(FeedItemsPage {
        items: query_items(
            &conn,
            subscription_id,
            filter,
            limit,
            before_published_at,
            before_id,
        )?,
    })
}

pub async fn refresh(id: Option<String>, stale_only: bool) -> Result<FeedRefreshResult, AppError> {
    let targets = {
        let conn = ensure_feeds()?;
        load_refresh_targets(&conn, id.as_deref(), stale_only)?
    };
    let mut fetched = 0u32;
    let mut failed = 0u32;
    let mut outcomes = Vec::new();
    for chunk in targets.chunks(REFRESH_CONCURRENCY) {
        let futs = chunk.iter().map(|sub| {
            let url = sub.url.clone();
            let title = sub.title.clone();
            let etag = sub.etag.clone();
            let lm = sub.last_modified.clone();
            let sid = sub.id.clone();
            async move {
                let outcome = fetch_and_parse(&url, etag.as_deref(), lm.as_deref(), &title).await;
                (sid, outcome)
            }
        });
        for (sid, outcome) in futures_util::future::join_all(futs).await {
            match &outcome {
                FetchOutcome::Failed(_) => failed += 1,
                _ => fetched += 1,
            }
            outcomes.push((sid, outcome));
        }
    }
    let conn = ensure_feeds()?;
    for (sid, outcome) in outcomes {
        apply_outcome(&conn, &sid, outcome)?;
    }
    Ok(FeedRefreshResult {
        subscriptions: list_subs(&conn)?,
        fetched,
        failed,
    })
}

pub async fn add_and_fetch(url: String, title: Option<String>) -> Result<FeedSub, AppError> {
    let url = normalize_feed_url(&url)?;
    let fallback = title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| title_from_url(&url));
    let outcome = fetch_and_parse(&url, None, None, &fallback).await;
    match outcome {
        FetchOutcome::Failed(err) => Err(AppError::message(err)),
        FetchOutcome::NotModified { .. } => Err(AppError::message("feeds.empty")),
        FetchOutcome::Body {
            url: final_url,
            etag,
            last_modified,
            parsed,
        } => {
            if parsed.items.is_empty() {
                return Err(AppError::message("feeds.empty"));
            }
            let title = if fallback == title_from_url(&url) {
                parsed.title.clone()
            } else {
                fallback
            };
            let id = {
                let conn = ensure_feeds()?;
                insert_subscription(&conn, &final_url, &title)?
            };
            apply_add_fetch(
                &id,
                FetchOutcome::Body {
                    url: final_url,
                    etag,
                    last_modified,
                    parsed,
                },
            )
        }
    }
}

pub fn remove_by_ref(target: &str) -> Result<FeedSub, AppError> {
    let conn = ensure_feeds()?;
    let trimmed = target.trim();
    let sub = list_subs(&conn)?.into_iter().find(|row| {
        row.id == trimmed
            || row.url == trimmed
            || normalize_feed_url(trimmed).ok().as_deref() == Some(row.url.as_str())
    });
    let Some(sub) = sub else {
        return Err(AppError::message("feeds.not_found"));
    };
    conn.execute("DELETE FROM subscriptions WHERE id = ?1", [&sub.id])?;
    Ok(sub)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_list_roundtrip() {
        let dir = std::env::temp_dir().join(format!(
            "agentero-feeds-mod-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("feeds.sqlite");
        let conn = schema::ensure_feeds_at(&db).unwrap();
        let id = insert_subscription(&conn, "https://example.com/feed.xml", "Example").unwrap();
        let err = insert_subscription(&conn, "https://example.com/feed.xml", "dup").unwrap_err();
        assert!(err.to_string().contains("feeds.duplicate"));
        let listed = list_subs(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        assert_eq!(listed[0].title, "Example");
        assert!(!listed[0].pinned);

        let later = insert_subscription(&conn, "https://example.com/later.xml", "Later").unwrap();
        conn.execute(
            "UPDATE subscriptions SET pinned = 1, pinned_at = ?1 WHERE id = ?2",
            params!["2026-08-15T00:00:00Z", later],
        )
        .unwrap();
        let listed = list_subs(&conn).unwrap();
        assert_eq!(listed[0].id, later);
        assert!(listed[0].pinned);
        assert_eq!(listed[1].id, id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn test_item(guid: &str, url: &str, paper_url: Option<&str>) -> ParsedItem {
        ParsedItem {
            guid: guid.to_string(),
            title: format!("Item {guid}"),
            url: Some(url.to_string()),
            published_at: None,
            summary_text: "short".to_string(),
            content_html: None,
            paper_url: paper_url.map(str::to_string),
        }
    }

    /// A feed refresh must not wipe a paper_url that was backfilled from the
    /// article page when the feed itself still provides none.
    #[test]
    fn upsert_keeps_backfilled_paper_url() {
        let dir = std::env::temp_dir().join(format!(
            "agentero-feeds-upsert-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("feeds.sqlite");
        let conn = schema::ensure_feeds_at(&db).unwrap();
        let sub = insert_subscription(&conn, "https://example.com/feed.xml", "Example").unwrap();

        upsert_items(
            &conn,
            &sub,
            &[test_item("g1", "https://example.com/a", None)],
        )
        .unwrap();
        let item_id: String = conn
            .query_row("SELECT id FROM items WHERE guid = 'g1'", [], |r| r.get(0))
            .unwrap();

        // Detail-open backfill writes the DOI scraped from the article page.
        persist_resolved(
            &conn,
            &item_id,
            "# Item g1\n\nbody",
            Some("https://doi.org/10.1038/s41467-026-76837-1"),
        )
        .unwrap();

        // Feed refresh arrives with no paper_url again — the backfill survives.
        upsert_items(
            &conn,
            &sub,
            &[test_item("g1", "https://example.com/a", None)],
        )
        .unwrap();
        let stored: Option<String> = conn
            .query_row("SELECT paper_url FROM items WHERE guid = 'g1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            stored.as_deref(),
            Some("https://doi.org/10.1038/s41467-026-76837-1")
        );

        // A feed that starts providing its own DOI still updates empty rows.
        upsert_items(
            &conn,
            &sub,
            &[test_item(
                "g2",
                "https://example.com/b",
                Some("https://doi.org/10.1/xyz"),
            )],
        )
        .unwrap();
        let g2: Option<String> = conn
            .query_row("SELECT paper_url FROM items WHERE guid = 'g2'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(g2.as_deref(), Some("https://doi.org/10.1/xyz"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Backfill never overwrites a paper_url that already exists.
    #[test]
    fn persist_resolved_keeps_existing_paper_url() {
        let dir = std::env::temp_dir().join(format!(
            "agentero-feeds-persist-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("feeds.sqlite");
        let conn = schema::ensure_feeds_at(&db).unwrap();
        let sub = insert_subscription(&conn, "https://example.com/feed.xml", "Example").unwrap();
        upsert_items(
            &conn,
            &sub,
            &[test_item(
                "g1",
                "https://example.com/a",
                Some("https://arxiv.org/abs/1706.03762"),
            )],
        )
        .unwrap();
        let item_id: String = conn
            .query_row("SELECT id FROM items WHERE guid = 'g1'", [], |r| r.get(0))
            .unwrap();
        let updated =
            persist_resolved(&conn, &item_id, "# body", Some("https://doi.org/10.1038/x")).unwrap();
        assert_eq!(
            updated.paper_url.as_deref(),
            Some("https://arxiv.org/abs/1706.03762")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn js_challenge_detection() {
        let stub =
            b"<html><meta charset=\"utf-8\" /><title></title><div></div></html>\n<script> window.location.href =\"/\"; </script>";
        assert!(looks_like_js_challenge(stub));
        assert!(!looks_like_js_challenge(
            b"<html><body><h1>Forbidden</h1></body></html>"
        ));
        let mut big = vec![b'x'; 9 * 1024];
        big.extend_from_slice(b"window.location.href=\"/\";");
        assert!(!looks_like_js_challenge(&big));
    }
}
