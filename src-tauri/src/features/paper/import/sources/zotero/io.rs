//! Catalog ↔ Zotero API JSON + Translator `/export` `/import`.
//!
//! Export body must be a **JSON array of Zotero items** (`Content-Type: application/json`).
//! Import body is plain text (BibTeX / RIS / …) → returns the same item array shape.

#[cfg(not(feature = "desktop"))]
use crate::core::app_handle::AppHandle;
use crate::core::error::AppError;
use crate::features::catalog::papers::{self, PaperRecord};
use crate::features::import::{
    enrich_remote_urls, map_zotero_item, normalize_parent_dir, translator_import_items,
    PaperImportArgs, PaperImportResult, DEFAULT_TRANSLATOR_BASE_URL,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::AppHandle;

/// Formats accepted by translation-server `?format=` (see zotero/translation-server formats.js).
pub const EXPORT_FORMATS: &[&str] = &[
    "bibtex",
    "biblatex",
    "ris",
    "csljson",
    "csv",
    "mods",
    "refer",
    "wikipedia",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperExportArgs {
    pub vault_path: String,
    /// Translator export format (default `bibtex`).
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub translator_base_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperExportResult {
    pub format: String,
    pub content: String,
    pub count: usize,
    pub filename: String,
}

pub async fn export_catalog(args: PaperExportArgs) -> Result<PaperExportResult, AppError> {
    let vault = crate::core::fs::resolve_vault(&args.vault_path)?;
    let format = normalize_format(args.format.as_deref().unwrap_or("bibtex"))?;
    let base = resolve_base(args.translator_base_url.as_deref());

    let rows = papers::list_all(&vault)?;
    if rows.is_empty() {
        return Err(AppError::message("library is empty — nothing to export"));
    }

    let items: Vec<Value> = rows.iter().map(paper_record_to_zotero_item).collect();
    // Official contract: JSON array of Zotero API items
    let body = serde_json::to_vec(&items)
        .map_err(|e| AppError::message(format!("serialize zotero items: {e}")))?;

    let url = format!("{base}/export?format={format}");
    let client = http_client(Duration::from_secs(60))?;
    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::message(format!("translator export: {e}")))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| AppError::message(format!("export body: {e}")))?;
    if !status.is_success() {
        let short: String = text.chars().take(200).collect();
        return Err(AppError::message(format!(
            "translator export HTTP {status}: {short}"
        )));
    }

    let ext = match format.as_str() {
        "bibtex" | "biblatex" => "bib",
        "ris" | "refer" => "ris",
        "csljson" => "json",
        "csv" => "csv",
        "mods" => "xml",
        "wikipedia" => "txt",
        _ => "txt",
    };

    Ok(PaperExportResult {
        format: format.clone(),
        content: text,
        count: items.len(),
        filename: format!("agentero-library.{ext}"),
    })
}

pub async fn import_catalog(
    args: PaperImportArgs,
    app: Option<&AppHandle>,
) -> Result<PaperImportResult, AppError> {
    // Headless entry (CLI): no settings store wiring, keep the default shell.
    import_catalog_with_mode(args, app, crate::features::import::NoteShellMode::Standard).await
}

/// Same as [`import_catalog`] with an explicit NOTES shell mode (desktop
/// commands resolve it from settings `paperNoteMode`).
pub async fn import_catalog_with_mode(
    args: PaperImportArgs,
    app: Option<&AppHandle>,
    note_mode: crate::features::import::NoteShellMode,
) -> Result<PaperImportResult, AppError> {
    let vault = crate::core::fs::resolve_vault(&args.vault_path)?;
    let content = args.content.trim();
    if content.is_empty() {
        return Err(AppError::message("import content is empty"));
    }
    let parent_rel = normalize_parent_dir(args.parent_dir.as_deref().unwrap_or("papers"))?;

    let items = translator_import_items(content, args.translator_base_url.as_deref()).await?;
    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut paths = Vec::new();
    let mut titles = Vec::new();
    let mut errors = Vec::new();

    for item in items {
        match import_one_item(&vault, &parent_rel, &item, app, note_mode).await {
            Ok(Some((path, title))) => {
                imported += 1;
                paths.push(path);
                titles.push(title);
            }
            Ok(None) => skipped += 1,
            Err(e) => errors.push(e.to_string()),
        }
    }

    Ok(PaperImportResult {
        imported,
        skipped,
        paths,
        titles,
        errors,
    })
}

async fn import_one_item(
    vault: &std::path::Path,
    parent_rel: &str,
    item: &Value,
    app: Option<&AppHandle>,
    note_mode: crate::features::import::NoteShellMode,
) -> Result<Option<(String, String)>, AppError> {
    use crate::features::import::paper_import::{
        paper_commit, AssetsPolicy, CommitStatus, DedupePolicy, PaperCommitOptions,
    };
    use crate::features::import::AssetProgressContext;

    let mut meta = map_zotero_item(item)?;
    enrich_remote_urls(&mut meta);

    let commit = paper_commit(
        meta,
        PaperCommitOptions {
            vault,
            parent_dir: parent_rel,
            dedupe: DedupePolicy::ByPathOrNotes,
            assets: AssetsPolicy::SyncDownload {
                cookies: None,
                progress: AssetProgressContext {
                    app: None,
                    task_id: None,
                },
            },
            translate_abstract: true,
            note_mode,
            fresh_timestamps: false,
            cache: None,
            app,
            defer_parse_jobs: false,
        },
    )
    .await?;

    match commit.status {
        CommitStatus::Created => Ok(Some((commit.path, commit.title))),
        CommitStatus::Skipped | CommitStatus::Deduped => Ok(None),
    }
}

/// Build a Zotero API JSON item from a catalog row (fields expected by `/export`).
pub fn paper_record_to_zotero_item(r: &PaperRecord) -> Value {
    let item_type = r
        .zotero_item_type
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(match r.paper_type.as_str() {
            "arxiv" => "preprint",
            "doi" => "journalArticle",
            "html" => "webpage",
            "pdf" => "journalArticle",
            _ => "journalArticle",
        });

    let creators = if let Some(c) = r.creators.as_ref().filter(|v| v.is_array()) {
        c.clone()
    } else {
        Value::Array(
            r.authors
                .iter()
                .map(|name| split_author_to_creator(name))
                .collect(),
        )
    };

    let mut extra_parts: Vec<String> = Vec::new();
    if let Some(ref e) = r.extra {
        if !e.trim().is_empty() {
            extra_parts.push(e.trim().to_string());
        }
    }
    if let Some(ref aid) = r.arxiv_id {
        let line = format!("arXiv: {aid}");
        if !extra_parts
            .iter()
            .any(|p| p.to_lowercase().contains("arxiv"))
        {
            extra_parts.push(line);
        }
    }
    if let Some(ref pmid) = r.pmid {
        let line = format!("PMID: {pmid}");
        if !extra_parts
            .iter()
            .any(|p| p.to_lowercase().contains("pmid"))
        {
            extra_parts.push(line);
        }
    }

    let mut obj = json!({
        "itemType": item_type,
        "title": r.title,
        "creators": creators,
        "tags": r
            .tags
            .iter()
            .map(|t| json!({ "tag": t.name }))
            .collect::<Vec<_>>(),
    });

    let map = obj.as_object_mut().unwrap();

    if let Some(d) = r.date.as_ref().filter(|s| !s.is_empty()) {
        map.insert("date".into(), json!(d));
    } else if let Some(y) = r.year {
        map.insert("date".into(), json!(y.to_string()));
    }
    if let Some(v) = r.abstract_text.as_ref().filter(|s| !s.is_empty()) {
        map.insert("abstractNote".into(), json!(v));
    }
    if let Some(v) = r.doi.as_ref().filter(|s| !s.is_empty()) {
        map.insert("DOI".into(), json!(v));
    }
    if let Some(v) = r.isbn.as_ref().filter(|s| !s.is_empty()) {
        map.insert("ISBN".into(), json!(v));
    }
    if let Some(v) = r.issn.as_ref().filter(|s| !s.is_empty()) {
        map.insert("ISSN".into(), json!(v));
    }
    if let Some(v) = r.publication.as_ref().filter(|s| !s.is_empty()) {
        map.insert("publicationTitle".into(), json!(v));
    }
    if let Some(v) = r.volume.as_ref().filter(|s| !s.is_empty()) {
        map.insert("volume".into(), json!(v));
    }
    if let Some(v) = r.issue.as_ref().filter(|s| !s.is_empty()) {
        map.insert("issue".into(), json!(v));
    }
    if let Some(v) = r.pages.as_ref().filter(|s| !s.is_empty()) {
        map.insert("pages".into(), json!(v));
    }
    if let Some(v) = r.publisher.as_ref().filter(|s| !s.is_empty()) {
        map.insert("publisher".into(), json!(v));
    }
    if let Some(v) = r.place.as_ref().filter(|s| !s.is_empty()) {
        map.insert("place".into(), json!(v));
    }
    if let Some(v) = r.series.as_ref().filter(|s| !s.is_empty()) {
        map.insert("series".into(), json!(v));
    }
    if let Some(v) = r.language.as_ref().filter(|s| !s.is_empty()) {
        map.insert("language".into(), json!(v));
    }
    if let Some(v) = r
        .source_url
        .as_ref()
        .or(r.html_url.as_ref())
        .or(r.pdf_url.as_ref())
        .filter(|s| !s.is_empty())
    {
        map.insert("url".into(), json!(v));
    }
    if let Some(v) = r.meta_source.as_ref().filter(|s| !s.is_empty()) {
        map.insert("libraryCatalog".into(), json!(v));
    } else {
        map.insert("libraryCatalog".into(), json!("Agentero"));
    }
    if !extra_parts.is_empty() {
        map.insert("extra".into(), json!(extra_parts.join("\n")));
    }
    if let Some(ref aid) = r.arxiv_id {
        map.insert("archive".into(), json!("arXiv"));
        map.insert("archiveID".into(), json!(format!("arXiv:{aid}")));
    }

    // Attachments as remote links (export translators may ignore; still valid Zotero shape)
    let mut attachments = Vec::new();
    if let Some(ref u) = r.pdf_url {
        if !u.is_empty() {
            attachments.push(json!({
                "title": "PDF",
                "mimeType": "application/pdf",
                "url": u,
            }));
        }
    }
    if !attachments.is_empty() {
        map.insert("attachments".into(), Value::Array(attachments));
    }

    obj
}

fn split_author_to_creator(name: &str) -> Value {
    let name = name.trim();
    if name.is_empty() {
        return json!({ "creatorType": "author", "name": "" });
    }
    // "Last, First" form
    if let Some((last, first)) = name.split_once(',') {
        return json!({
            "creatorType": "author",
            "firstName": first.trim(),
            "lastName": last.trim(),
        });
    }
    let parts: Vec<&str> = name.split_whitespace().collect();
    if parts.len() == 1 {
        return json!({
            "creatorType": "author",
            "lastName": parts[0],
            "firstName": "",
        });
    }
    let last = parts[parts.len() - 1];
    let first = parts[..parts.len() - 1].join(" ");
    json!({
        "creatorType": "author",
        "firstName": first,
        "lastName": last,
    })
}

fn normalize_format(raw: &str) -> Result<String, AppError> {
    let f = raw.trim().to_ascii_lowercase();
    if EXPORT_FORMATS.contains(&f.as_str()) {
        Ok(f)
    } else {
        Err(AppError::message(format!(
            "unsupported export format '{raw}'; use one of: {}",
            EXPORT_FORMATS.join(", ")
        )))
    }
}

fn resolve_base(override_url: Option<&str>) -> String {
    override_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_TRANSLATOR_BASE_URL)
        .trim_end_matches('/')
        .to_string()
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, AppError> {
    crate::core::http::client_with(timeout, 10, crate::core::http::USER_AGENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zotero_item_has_required_fields() {
        let r = PaperRecord {
            path: "papers/1706.03762".into(),
            id: "1706.03762".into(),
            paper_type: "arxiv".into(),
            title: "Attention Is All You Need".into(),
            authors: vec!["Ashish Vaswani".into(), "Noam Shazeer".into()],
            creators: None,
            year: Some(2017),
            date: Some("2017".into()),
            abstract_text: Some("We propose…".into()),
            tags: vec!["nlp".into()],
            arxiv_id: Some("1706.03762".into()),
            doi: None,
            isbn: None,
            issn: None,
            pmid: None,
            publication: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            place: None,
            series: None,
            language: None,
            pdf_url: Some("https://arxiv.org/pdf/1706.03762".into()),
            html_url: Some("https://arxiv.org/html/1706.03762".into()),
            source_url: Some("https://arxiv.org/abs/1706.03762".into()),
            body_source: None,
            body_quality: None,
            bibtex_key: Some("1706.03762".into()),
            citation_count: None,
            zotero_item_type: Some("preprint".into()),
            meta_source: Some("arXiv.org".into()),
            extra: None,
            summary: None,
            status: "completed".into(),
            is_read: false,
            zotero_item_id: None,
            zotero_last_synced: None,
            added_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        let item = paper_record_to_zotero_item(&r);
        assert_eq!(item["itemType"], "preprint");
        assert_eq!(item["title"], "Attention Is All You Need");
        assert!(item["creators"].as_array().unwrap().len() >= 2);
        assert_eq!(item["creators"][0]["lastName"], "Vaswani");
        assert_eq!(item["archiveID"], "arXiv:1706.03762");
        // Must serialize as a JSON array element for /export
        let arr = json!([item]);
        assert!(arr.is_array());
    }
}
