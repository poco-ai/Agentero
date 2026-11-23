use std::collections::BTreeMap;

use serde::Serialize;
use uuid::Uuid;

use super::{Highlight, HighlightAnchor, PaperNotes, PdfAnchor};
use crate::error::AppError;
use crate::features::paper::scholar_api::identifiers::{
    extract_arxiv_request, strip_arxiv_version,
};
use crate::features::paper::source::version_from_text;
use crate::features::pdf_locate::annotations::{highlight_hex, now_iso, text_markup_item};
use crate::features::pdf_locate::{
    first_page_text, locate_in_pdf, map_pdf_user_rects, LocateMatch, LocateRequest, PdfUserRects,
};
use crate::json::JsonValue;

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportedReadingRecord {
    pub source_id: String,
    pub annotations: Vec<JsonValue>,
    pub markdown: Option<String>,
    pub excerpt: bool,
}

pub fn prepare_import(
    notes: PaperNotes,
    group: Uuid,
    arxiv_id: &str,
    pdf: Option<&[u8]>,
) -> Vec<ImportedReadingRecord> {
    let mut records = Vec::new();
    if !notes.body.trim().is_empty() {
        records.push(ImportedReadingRecord {
            source_id: format!("alphaxiv-note-{group}"),
            annotations: Vec::new(),
            markdown: Some(quote_markdown(notes.body.trim())),
            excerpt: false,
        });
    }
    let local_version = pdf
        .filter(|_| {
            notes
                .highlights
                .iter()
                .any(|item| matches!(item.anchor, HighlightAnchor::Pdf { .. }))
        })
        .and_then(|pdf| first_page_text(pdf).ok())
        .and_then(|text| version_from_text(&text, &arxiv_id.to_ascii_lowercase()));

    for highlight in notes.highlights {
        let source_id = format!("alphaxiv-{}", highlight.id);
        let (annotations, target, quote) = match &highlight.anchor {
            HighlightAnchor::Pdf { annotation } => {
                let geometry = pdf
                    .and_then(|pdf| {
                        geometry(pdf, &highlight, annotation, local_version.as_deref()).ok()
                    })
                    .unwrap_or_default();
                let (stroke, palette, opacity) = paint(annotation.highlight_color.as_deref());
                let date = chrono::DateTime::parse_from_rfc3339(&highlight.date)
                    .map(|date| date.to_rfc3339())
                    .unwrap_or_else(|_| now_iso());
                let items = geometry
                    .into_iter()
                    .map(|hit| {
                        let page = hit.page - 1;
                        let mut item = text_markup_item(
                            &format!("{source_id}-{page}"),
                            page,
                            &hit.rects,
                            hit.page_width,
                            hit.page_height,
                            false,
                            &annotation.selected_text,
                            &stroke,
                            palette,
                            Some(&highlight.body),
                            &date,
                        );
                        item["annotation"]["opacity"] = opacity.into();
                        JsonValue(item)
                    })
                    .collect::<Vec<_>>();
                let pages = annotation
                    .highlight_rects
                    .iter()
                    .map(|item| (i64::from(item.page_index) + 1).to_string())
                    .collect::<Vec<_>>();
                let target = if pages.is_empty() {
                    "PDF".into()
                } else {
                    format!("PDF p. {}", pages.join(", "))
                };
                (items, target, annotation.selected_text.as_str())
            }
            HighlightAnchor::Prose { target, annotation } => {
                let target = target.split_whitespace().collect::<Vec<_>>().join(" ");
                (Vec::new(), target, annotation.exact.as_str())
            }
        };
        let excerpt = annotations.is_empty();
        let markdown = excerpt.then(|| {
            let quote = quote_markdown(quote);
            let version = extract_arxiv_request(&highlight.canonical_id)
                .unwrap_or_else(|| arxiv_id.to_string());
            format!(
                "**{target} · {version}**\n\n{quote}\n\n{}",
                quote_markdown(highlight.body.trim())
            )
        });
        records.push(ImportedReadingRecord {
            source_id,
            annotations,
            markdown,
            excerpt,
        });
    }
    records
}

fn quote_markdown(text: &str) -> String {
    text.lines()
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn geometry(
    pdf: &[u8],
    highlight: &Highlight,
    anchor: &PdfAnchor,
    local_version: Option<&str>,
) -> Result<Vec<LocateMatch>, AppError> {
    let version = extract_arxiv_request(&highlight.canonical_id).and_then(|id| {
        let bare = strip_arxiv_version(&id);
        if id != bare {
            Some(id)
        } else {
            extract_arxiv_request(&format!("{id}{}", highlight.version_label))
                .filter(|version| version != &bare)
        }
    });
    if local_version
        .zip(version.as_deref())
        .is_some_and(|(local, remote)| local.eq_ignore_ascii_case(remote))
        && !anchor.highlight_rects.is_empty()
    {
        let mut pages = BTreeMap::<i32, Vec<[f32; 4]>>::new();
        for page in &anchor.highlight_rects {
            pages.entry(page.page_index).or_default().extend(
                page.rects
                    .iter()
                    .map(|rect| [rect.x1, rect.y1, rect.x2, rect.y2]),
            );
        }
        let groups = pages
            .into_iter()
            .map(|(page_index, rects)| PdfUserRects { page_index, rects })
            .collect::<Vec<_>>();
        let mapped = map_pdf_user_rects(pdf, &groups)?;
        if mapped
            .iter()
            .zip(&groups)
            .all(|(hit, page)| !hit.rects.is_empty() && hit.rects.len() == page.rects.len())
        {
            return Ok(mapped
                .into_iter()
                .zip(groups)
                .map(|(hit, page)| LocateMatch {
                    page: page.page_index as u32 + 1,
                    char_index: 0,
                    char_count: 0,
                    rects: hit.rects,
                    page_width: hit.page_width,
                    page_height: hit.page_height,
                })
                .collect());
        }
    }

    if anchor
        .selected_text
        .chars()
        .filter(|character| !character.is_whitespace())
        .count()
        < 4
    {
        return Ok(Vec::new());
    }
    let mut request = LocateRequest::new(&anchor.selected_text);
    request.max_matches = 2;
    let result = locate_in_pdf(pdf, &request)?;
    if result.matches.len() == 1 && !result.matches[0].rects.is_empty() {
        return Ok(result.matches);
    }
    Ok(Vec::new())
}

fn paint(raw: Option<&str>) -> (String, &'static str, f64) {
    let parse = |raw: &str| -> Option<(u32, f64)> {
        let hex = raw.strip_prefix('#')?;
        let value = u32::from_str_radix(hex, 16).ok()?;
        match hex.len() {
            6 => Some((value, 0.4)),
            8 => Some((value >> 8, f64::from(value & 255) / 255.0)),
            _ => None,
        }
    };
    let (color, opacity) = raw.and_then(parse).unwrap_or((0xfcd34d, 0.4));
    let palette = ["yellow", "green", "blue", "pink", "purple"]
        .into_iter()
        .min_by_key(|palette| {
            let (swatch, _) = highlight_hex(palette)
                .and_then(parse)
                .unwrap_or((0xfcd34d, 0.4));
            [16, 8, 0]
                .into_iter()
                .map(|shift| {
                    let delta = ((color >> shift) & 255) as i32 - ((swatch >> shift) & 255) as i32;
                    delta * delta
                })
                .sum::<i32>()
        })
        .unwrap_or("yellow");
    (format!("#{color:06x}"), palette, opacity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> PaperNotes {
        serde_json::from_value(json!({
            "body": "A paper note", "sourceIds": [], "highlights": [
                {"id": "a134cafe-1111-4111-8111-111111111111", "canonicalId": "2601.01416v1",
                 "versionLabel": "v1", "date": "2026-01-01T00:00:00Z", "body": "An attached note", "kind": "pdf",
                 "annotation": {"selectedText": "A distinctive sentence", "highlightColor": "#FFD70040",
                    "highlightRects": [{"pageIndex": 0, "rects": [{"x1": 20, "y1": 58, "x2": 100, "y2": 71}]}]}},
                {"id": "a134cafe-2222-4222-8222-222222222222", "canonicalId": "2601.01416v1",
                 "versionLabel": "v1", "date": "2026-01-01T00:00:00Z", "body": "", "kind": "prose",
                 "target": "abstract", "annotation": {"exact": "A prose excerpt"}}
            ]
        })).unwrap()
    }

    #[test]
    fn notes_geometry_and_fallback() {
        let exact = crate::features::pdf::tiny_pdf("arXiv:2601.01416v1");
        let records = prepare_import(fixture(), Uuid::nil(), "2601.01416", Some(&exact));
        assert_eq!(records.len(), 3);
        assert!(records[0]
            .markdown
            .as_deref()
            .unwrap()
            .contains("A paper note"));
        assert!(records[2].excerpt);
        assert!(records[2].markdown.as_deref().unwrap().contains("abstract"));
        let annotation = &records[1].annotations[0].0["annotation"];
        assert_eq!(annotation["pageIndex"], 0);
        assert_eq!(annotation["contents"], "An attached note");
        assert_eq!(annotation["strokeColor"], "#ffd700");
        assert!((annotation["opacity"].as_f64().unwrap() - 64.0 / 255.0).abs() < 1e-9);
        let unique = crate::features::pdf::tiny_pdf("A distinctive sentence");
        assert_eq!(
            prepare_import(fixture(), Uuid::nil(), "2601.01416", Some(&unique))[1]
                .annotations
                .len(),
            1
        );
        let ambiguous =
            crate::features::pdf::tiny_pdf("A distinctive sentence. A distinctive sentence.");
        assert!(prepare_import(fixture(), Uuid::nil(), "2601.01416", Some(&ambiguous))[1].excerpt);
        assert!(
            prepare_import(fixture(), Uuid::nil(), "2601.01416", Some(b"not a PDF"))[1].excerpt
        );
    }
}
