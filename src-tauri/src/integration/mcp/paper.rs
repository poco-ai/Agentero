//! Paper ref resolution and list/get shaping for MCP tools.

use crate::core::error::AppError;
use crate::features::paper::catalog::papers::{self, PaperRecord, PaperRefLookup};
use serde::Serialize;
use std::path::Path;

/// MCP / camelCase field names allowed on `paper_list` (beyond id/path/title).
const PAPER_LIST_EXTRA_FIELDS: &[&str] = &[
    "authors",
    "year",
    "date",
    "tags",
    "doi",
    "arxivId",
    "publication",
    "status",
    "isRead",
    // snake_case aliases (CLI parity)
    "arxiv_id",
    "is_read",
];

/// Resolve a paper reference with MCP-flavoured error text.
pub fn resolve_paper(vault: &Path, ref_: &str) -> Result<PaperRecord, AppError> {
    let reference = ref_.trim();
    match papers::lookup_paper_ref(vault, reference)? {
        PaperRefLookup::Found(record) => Ok(*record),
        PaperRefLookup::NotFound => Err(AppError::message(format!("paper not found: {reference}"))),
        PaperRefLookup::Ambiguous(paths) => Err(AppError::message(format!(
            "paper id '{reference}' is ambiguous ({} matches): {}",
            paths.len(),
            paths.join(", ")
        ))),
    }
}

fn strip_internal_tags(row: &mut PaperRecord) {
    row.tags.retain(|t| !papers::is_internal_tag_name(&t.name));
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PaperListItem {
    pub id: String,
    pub path: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    /// Publication date, `YYYY` / `YYYY-MM` / `YYYY-MM-DD` by precision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_read: Option<bool>,
}

impl PaperListItem {
    fn slim(row: &PaperRecord) -> Self {
        Self {
            id: row.id.clone(),
            path: row.path.clone(),
            title: row.title.clone(),
            authors: None,
            year: None,
            date: None,
            tags: None,
            doi: None,
            arxiv_id: None,
            publication: None,
            status: None,
            is_read: None,
        }
    }

    fn full(row: &PaperRecord) -> Self {
        Self {
            id: row.id.clone(),
            path: row.path.clone(),
            title: row.title.clone(),
            authors: Some(row.authors.clone()),
            year: row.year,
            date: row.date.clone(),
            tags: Some(row.tags.iter().map(|t| t.name.clone()).collect()),
            doi: row.doi.clone(),
            arxiv_id: row.arxiv_id.clone(),
            publication: row.publication.clone(),
            status: Some(row.status.clone()),
            is_read: Some(row.is_read),
        }
    }

    fn with_fields(row: &PaperRecord, fields: &[String]) -> Result<Self, AppError> {
        let mut item = Self::slim(row);
        for raw in fields {
            let f = raw.trim();
            if f.is_empty() || matches!(f, "id" | "path" | "title") {
                continue;
            }
            if !PAPER_LIST_EXTRA_FIELDS.contains(&f) {
                return Err(AppError::domain(
                    "usage",
                    format!(
                        "unknown field '{f}' (valid: id, path, title, {})",
                        PAPER_LIST_EXTRA_FIELDS.join(", ")
                    ),
                ));
            }
            match f {
                "authors" => item.authors = Some(row.authors.clone()),
                "year" => item.year = row.year,
                "date" => item.date = row.date.clone(),
                "tags" => {
                    item.tags = Some(row.tags.iter().map(|t| t.name.clone()).collect());
                }
                "doi" => item.doi = row.doi.clone(),
                "arxivId" | "arxiv_id" => item.arxiv_id = row.arxiv_id.clone(),
                "publication" => item.publication = row.publication.clone(),
                "status" => item.status = Some(row.status.clone()),
                "isRead" | "is_read" => item.is_read = Some(row.is_read),
                _ => {}
            }
        }
        Ok(item)
    }
}

pub fn list_papers(
    vault: &Path,
    query: Option<&str>,
    filter_tags: &[String],
    unread: bool,
    limit: usize,
    fields: &[String],
    full: bool,
) -> Result<Vec<PaperListItem>, AppError> {
    let mut rows = papers::list_all_unique_by_id(vault)?;
    if unread {
        rows.retain(|r| !r.is_read);
    }
    for row in &mut rows {
        strip_internal_tags(row);
    }
    let required: Vec<String> = filter_tags
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if !required.is_empty() {
        rows.retain(|r| papers::paper_has_all_tags(r, &required));
    }
    if let Some(q) = query.map(str::trim).filter(|s| !s.is_empty()) {
        let q = q.to_ascii_lowercase();
        rows.retain(|r| {
            r.title.to_ascii_lowercase().contains(&q)
                || r.id.to_ascii_lowercase().contains(&q)
                || r.path.to_ascii_lowercase().contains(&q)
                || r.authors
                    .iter()
                    .any(|a| a.to_ascii_lowercase().contains(&q))
                || r.tags
                    .iter()
                    .any(|t| t.name.to_ascii_lowercase().contains(&q))
        });
    }
    rows.truncate(limit);
    if full {
        return Ok(rows.iter().map(PaperListItem::full).collect());
    }
    rows.iter()
        .map(|r| PaperListItem::with_fields(r, fields))
        .collect()
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PaperListOut {
    pub items: Vec<PaperListItem>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PaperGetOut {
    pub id: String,
    pub path: String,
    pub title: String,
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "abstract")]
    pub abstract_text: Option<String>,
    pub status: String,
    pub is_read: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bibtex_key: Option<String>,
    pub added_at: String,
    pub updated_at: String,
}

impl PaperGetOut {
    pub fn from_record(row: &PaperRecord) -> Self {
        Self {
            id: row.id.clone(),
            path: row.path.clone(),
            title: row.title.clone(),
            authors: row.authors.clone(),
            year: row.year,
            date: row.date.clone(),
            tags: row.tags.iter().map(|t| t.name.clone()).collect(),
            doi: row.doi.clone(),
            arxiv_id: row.arxiv_id.clone(),
            publication: row.publication.clone(),
            abstract_text: row.abstract_text.clone(),
            status: row.status.clone(),
            is_read: row.is_read,
            bibtex_key: row.bibtex_key.clone(),
            added_at: row.added_at.clone(),
            updated_at: row.updated_at.clone(),
        }
    }
}

pub fn get_paper(vault: &Path, ref_: &str) -> Result<PaperGetOut, AppError> {
    let mut paper = resolve_paper(vault, ref_)?;
    strip_internal_tags(&mut paper);
    Ok(PaperGetOut::from_record(&paper))
}

pub fn set_read(vault: &Path, ref_: &str, is_read: bool) -> Result<PaperGetOut, AppError> {
    let paper = resolve_paper(vault, ref_)?;
    let mut row = papers::set_is_read(vault, &paper.path, is_read)?;
    strip_internal_tags(&mut row);
    Ok(PaperGetOut::from_record(&row))
}

/// One page's text for `paper_text_get`.
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PaperTextPage {
    /// 1-based page number.
    pub page: u32,
    /// PDFium char count before truncation.
    pub char_count: usize,
    /// Page text, truncated to the per-page budget.
    pub text: String,
}

/// Full-text extraction result for `paper_text_get` (#676).
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PaperTextOut {
    /// Vault-relative paper path (same resolution as other paper tools).
    pub path: String,
    /// Total page count of the PDF.
    pub page_count: u32,
    /// Per-page extracted text.
    pub pages: Vec<PaperTextPage>,
}

/// Extract page text for a paper's main PDF. `pages` selects 1-based pages
/// (None = all); each page is truncated to `max_chars` characters.
pub fn text(
    vault: &Path,
    ref_: &str,
    pages: Option<Vec<u32>>,
    max_chars: usize,
) -> Result<PaperTextOut, AppError> {
    let record = resolve_paper(vault, ref_)?;
    let folder_id = record
        .path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_string();
    let paper_dir = vault.join(&record.path);
    // paper_commit convention: `{folder-id}.pdf` beside NOTES.md.
    let mut pdf_path = paper_dir.join(format!("{folder_id}.pdf"));
    if !pdf_path.is_file() {
        // Fallback: first .pdf in the paper directory.
        pdf_path = std::fs::read_dir(&paper_dir)
            .map_err(|e| AppError::message(format!("read paper dir: {e}")))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|p| {
                p.extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
                    && p.is_file()
            })
            .ok_or_else(|| AppError::message("no PDF in paper folder"))?;
    }
    let bytes =
        std::fs::read(&pdf_path).map_err(|e| AppError::message(format!("read pdf: {e}")))?;
    let out = crate::features::pdf::text::extract_text(&bytes, pages.as_deref(), max_chars)?;
    Ok(PaperTextOut {
        path: record.path,
        page_count: out.page_count,
        pages: out
            .pages
            .into_iter()
            .map(|p| PaperTextPage {
                page: p.page,
                char_count: p.char_count,
                text: p.text,
            })
            .collect(),
    })
}
