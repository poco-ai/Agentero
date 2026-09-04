//! Paper ref resolution and list/get shaping for MCP tools.

use crate::core::error::AppError;
use crate::features::catalog::papers::{self, PaperRecord, PaperTag};
use serde::Serialize;
use std::path::Path;

const TAG_COLORS: &[&str] = &[
    "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple",
];

pub fn looks_like_path(ref_: &str) -> bool {
    let t = ref_.trim();
    t.contains('/') || t.contains('\\') || t.starts_with("papers")
}

pub fn resolve_paper(vault: &Path, ref_: &str) -> Result<PaperRecord, AppError> {
    let ref_ = ref_.trim();
    if ref_.is_empty() {
        return Err(AppError::message("paper ref is required"));
    }
    if looks_like_path(ref_) {
        let path = ref_.replace('\\', "/").trim_matches('/').to_string();
        return papers::get_by_path(vault, &path)?
            .ok_or_else(|| AppError::message(format!("paper not found: {ref_}")));
    }
    let matches = papers::list_by_id(vault, ref_)?;
    match matches.len() {
        0 => Err(AppError::message(format!("paper not found: {ref_}"))),
        1 => Ok(matches.into_iter().next().expect("len 1")),
        n => {
            let paths: Vec<&str> = matches.iter().map(|p| p.path.as_str()).collect();
            Err(AppError::message(format!(
                "paper id '{ref_}' is ambiguous ({n} matches): {}",
                paths.join(", ")
            )))
        }
    }
}

pub fn parse_tag_spec(raw: &str) -> Result<PaperTag, AppError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::message("tag name must not be empty"));
    }
    let Some((name, color)) = value.rsplit_once(':') else {
        return Ok(PaperTag::new(value));
    };
    if name.trim().is_empty() {
        return Err(AppError::message("tag name must not be empty"));
    }
    if TAG_COLORS
        .iter()
        .any(|id| id.eq_ignore_ascii_case(color.trim()))
    {
        return Ok(PaperTag {
            name: name.trim().to_string(),
            color: Some(color.trim().to_ascii_lowercase()),
        });
    }
    Ok(PaperTag::new(value))
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
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<String>,
    pub status: String,
    pub is_read: bool,
}

impl PaperListItem {
    fn from_record(row: &PaperRecord) -> Self {
        Self {
            id: row.id.clone(),
            path: row.path.clone(),
            title: row.title.clone(),
            authors: row.authors.clone(),
            year: row.year,
            tags: row.tags.iter().map(|t| t.name.clone()).collect(),
            doi: row.doi.clone(),
            arxiv_id: row.arxiv_id.clone(),
            publication: row.publication.clone(),
            status: row.status.clone(),
            is_read: row.is_read,
        }
    }
}

pub fn list_papers(
    vault: &Path,
    query: Option<&str>,
    filter_tags: &[String],
    unread: bool,
    limit: usize,
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
    Ok(rows.iter().map(PaperListItem::from_record).collect())
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
