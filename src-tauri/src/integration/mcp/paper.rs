//! Paper ref resolution and list/get shaping for MCP tools.

use crate::core::error::AppError;
use crate::features::paper::catalog::papers::{self, PaperRecord};
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

pub use agentero_core::features::paper::reading::{resolve_paper, text, PaperTextOut};

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
