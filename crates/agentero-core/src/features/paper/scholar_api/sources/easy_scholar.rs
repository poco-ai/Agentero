//! EasyScholar journal/venue metrics source.

use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;

use crate::features::paper::catalog::papers::PaperTag;
use crate::features::scholar_api::client;
use crate::features::scholar_api::traits::VenueMetricsSource;
use crate::features::scholar_api::{ApiError, VenueIdentifiers, VenueMetrics, VenueRank};

/// Namespace for EasyScholar-derived metrics. Host-owned: the renderer never
/// writes these tags.
pub const EASY_SCHOLAR_TAG_PREFIX: &str = "#easyscholar:";
const EASY_SCHOLAR_JOURNAL_PREFIX: &str = "#easyscholar:journal=";
const EASY_SCHOLAR_IF_COLOR: &str = "green";
const EASY_SCHOLAR_OTHER_COLOR: &str = "blue";

/// EasyScholar metrics source.
#[derive(Debug, Clone)]
pub struct EasyScholarApi {
    pub secret_key: String,
}

impl EasyScholarApi {
    pub const ENDPOINT: &str = "https://easyscholar.cc/open/getPublicationRank";

    pub fn new(secret_key: impl Into<String>) -> Self {
        Self {
            secret_key: secret_key.into(),
        }
    }

    /// Fetch the raw EasyScholar response for a publication name.
    /// This is exposed so the frontend can keep consuming the original
    /// `officialRank.all` JSON shape while the parsing logic lives here.
    pub async fn fetch_raw(&self, venue: &str) -> Result<Value, ApiError> {
        let url = format!(
            "{}?secretKey={}&publicationName={}",
            Self::ENDPOINT,
            urlencoding::encode(&self.secret_key),
            urlencoding::encode(venue.trim())
        );
        client::get_json_with_timeout(&url, client::DEFAULT_TIMEOUT).await
    }
}

#[async_trait]
impl VenueMetricsSource for EasyScholarApi {
    fn name(&self) -> &'static str {
        "easyscholar"
    }

    fn supports(&self, venue: &str, _identifiers: &VenueIdentifiers) -> bool {
        !venue.trim().is_empty() && !self.secret_key.trim().is_empty()
    }

    async fn fetch_metrics(
        &self,
        venue: &str,
        identifiers: &VenueIdentifiers,
    ) -> Result<VenueMetrics, ApiError> {
        let value = self.fetch_raw(venue).await?;
        parse_response(venue, identifiers, &value)
    }
}

fn parse_response(
    venue: &str,
    _identifiers: &VenueIdentifiers,
    value: &Value,
) -> Result<VenueMetrics, ApiError> {
    let code = value.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
    if code != 200 {
        return Err(ApiError::Other(format!(
            "easyscholar API returned code {code}"
        )));
    }

    let all = value
        .pointer("/data/officialRank/all")
        .and_then(|v| v.as_object())
        .ok_or_else(|| ApiError::Parse("missing officialRank.all".to_string()))?;

    let mut ranks = Vec::new();
    for (system, value) in all {
        let value_str = match value {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => continue,
        };
        // Numeric metrics live in the same object; skip them here.
        if matches!(system.as_str(), "sciif" | "sciif5" | "jci") {
            continue;
        }
        ranks.push(VenueRank {
            system: system.clone(),
            value: value_str,
            category: None,
        });
    }

    Ok(VenueMetrics {
        venue_name: venue.to_string(),
        identifiers: VenueIdentifiers::default(),
        impact_factor: all.get("sciif").and_then(parse_f64),
        impact_factor_5yr: all.get("sciif5").and_then(parse_f64),
        jci: all.get("jci").and_then(parse_f64),
        h_index: None,
        i10_index: None,
        two_year_mean_citedness: None,
        total_works: None,
        total_citations: None,
        ranks,
        source: "easyscholar",
        source_detail: None,
    })
}

fn parse_f64(value: &Value) -> Option<f64> {
    match value {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

pub fn is_easyscholar_tag(name: &str) -> bool {
    name.trim()
        .to_ascii_lowercase()
        .starts_with(EASY_SCHOLAR_TAG_PREFIX)
}

fn is_easyscholar_journal_tag(name: &str) -> bool {
    name.trim()
        .to_ascii_lowercase()
        .starts_with(EASY_SCHOLAR_JOURNAL_PREFIX)
}

/// Drop the retired `journal=` projection; `publication` carries the name now.
pub fn strip_easyscholar_journal_tags(tags: &[PaperTag]) -> Vec<PaperTag> {
    tags.iter()
        .filter(|tag| !is_easyscholar_journal_tag(&tag.name))
        .cloned()
        .collect()
}

/// Drop all EasyScholar metrics (used when a paper no longer has a real venue).
pub fn strip_easyscholar_tags(tags: &[PaperTag]) -> Vec<PaperTag> {
    tags.iter()
        .filter(|tag| !is_easyscholar_tag(&tag.name))
        .cloned()
        .collect()
}

fn rank_label(system: &str) -> Option<&'static str> {
    match system {
        "sci" => Some("SCI"),
        "ssci" => Some("SSCI"),
        "eii" => Some("EI检索"),
        "cssci" => Some("CSSCI"),
        "pku" => Some("北大中文核心"),
        "ccf" => Some("CCF"),
        "fms" => Some("FMS"),
        "utd24" => Some("UTD24"),
        _ => None,
    }
}

fn number_text(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn push_tag(tags: &mut Vec<PaperTag>, name: String, color: &str) {
    if tags.iter().any(|tag| tag.name.eq_ignore_ascii_case(&name)) {
        return;
    }
    tags.push(PaperTag {
        name,
        color: Some(color.to_string()),
    });
}

/// Build the metrics tag projection from parsed EasyScholar data.
/// The venue name is intentionally not emitted: `publication` is authoritative.
pub fn tags_from_metrics(metrics: &VenueMetrics) -> Vec<PaperTag> {
    let mut tags = Vec::new();
    if let Some(value) = metrics.impact_factor {
        push_tag(
            &mut tags,
            format!("{EASY_SCHOLAR_TAG_PREFIX}if={}", number_text(value)),
            EASY_SCHOLAR_IF_COLOR,
        );
    }
    if let Some(value) = metrics.impact_factor_5yr {
        push_tag(
            &mut tags,
            format!("{EASY_SCHOLAR_TAG_PREFIX}if5={}", number_text(value)),
            EASY_SCHOLAR_IF_COLOR,
        );
    }
    if let Some(value) = metrics.jci {
        push_tag(
            &mut tags,
            format!("{EASY_SCHOLAR_TAG_PREFIX}jci={}", number_text(value)),
            EASY_SCHOLAR_OTHER_COLOR,
        );
    }
    for rank in &metrics.ranks {
        let Some(label) = rank_label(&rank.system) else {
            continue;
        };
        let value = rank.value.trim();
        let name = if value.is_empty() || value.eq_ignore_ascii_case(label) {
            format!("{EASY_SCHOLAR_TAG_PREFIX}rank={label}")
        } else {
            format!("{EASY_SCHOLAR_TAG_PREFIX}rank={label}={value}")
        };
        push_tag(&mut tags, name, EASY_SCHOLAR_OTHER_COLOR);
    }
    tags
}

/// Replace the EasyScholar namespace, preserving colors the user gave to
/// same-named tags (including an explicit no-color state).
pub fn merge_easyscholar_tags(existing: &[PaperTag], generated: &[PaperTag]) -> Vec<PaperTag> {
    let mut colors: HashMap<String, Option<String>> = HashMap::new();
    for tag in existing.iter().filter(|tag| is_easyscholar_tag(&tag.name)) {
        colors
            .entry(tag.name.to_ascii_lowercase())
            .or_insert_with(|| tag.color.clone());
    }
    let mut out = strip_easyscholar_tags(existing);
    for tag in generated {
        let mut tag = tag.clone();
        if let Some(color) = colors.get(&tag.name.to_ascii_lowercase()) {
            tag.color = color.clone();
        }
        out.push(tag);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::scholar_api::VenueRank;

    fn metrics() -> VenueMetrics {
        VenueMetrics {
            venue_name: "CVPR".into(),
            identifiers: VenueIdentifiers::default(),
            impact_factor: Some(25.6),
            impact_factor_5yr: Some(30.0),
            jci: None,
            h_index: None,
            i10_index: None,
            two_year_mean_citedness: None,
            total_works: None,
            total_citations: None,
            ranks: vec![VenueRank {
                system: "ccf".into(),
                value: "A".into(),
                category: None,
            }],
            source: "easyscholar",
            source_detail: None,
        }
    }

    #[test]
    fn metrics_tags_drop_journal_and_use_semantic_colors() {
        let tags = tags_from_metrics(&metrics());
        assert_eq!(
            tags,
            vec![
                PaperTag {
                    name: "#easyscholar:if=25.6".into(),
                    color: Some("green".into()),
                },
                PaperTag {
                    name: "#easyscholar:if5=30".into(),
                    color: Some("green".into()),
                },
                PaperTag {
                    name: "#easyscholar:rank=CCF=A".into(),
                    color: Some("blue".into()),
                },
            ]
        );
        assert!(tags.iter().all(|tag| !tag.name.contains("journal=")));
    }

    #[test]
    fn business_rankings_survive_response_to_tag_projection() {
        let response = serde_json::json!({
            "code": 200,
            "data": { "officialRank": { "all": {
                "fms": "A(T1)",
                "utd24": "UTD24",
                "sciif": "4.2",
                "ccf": "A",
                "unrecognized": "A"
            } } }
        });
        let metrics = parse_response(
            "Management Science",
            &VenueIdentifiers::default(),
            &response,
        )
        .unwrap();
        let tags = tags_from_metrics(&metrics);
        assert_eq!(
            tags.iter().map(|tag| tag.name.as_str()).collect::<Vec<_>>(),
            vec![
                "#easyscholar:if=4.2",
                "#easyscholar:rank=CCF=A",
                "#easyscholar:rank=FMS=A(T1)",
                "#easyscholar:rank=UTD24",
            ]
        );
        assert!(tags[1..]
            .iter()
            .all(|tag| tag.color.as_deref() == Some("blue")));
    }

    #[test]
    fn merge_replaces_namespace_and_keeps_same_name_color() {
        let existing = vec![
            PaperTag::new("nlp"),
            PaperTag {
                name: "#easyscholar:if=25.6".into(),
                color: Some("red".into()),
            },
            PaperTag::new("#easyscholar:journal=CVPR"),
            PaperTag::new("#easyscholar:rank=CCF=B"),
        ];
        let merged = merge_easyscholar_tags(&existing, &tags_from_metrics(&metrics()));
        assert!(merged.iter().any(|tag| tag.name == "nlp"));
        assert!(merged
            .iter()
            .all(|tag| !tag.name.starts_with("#easyscholar:journal=")));
        assert!(merged
            .iter()
            .any(|tag| tag.name == "#easyscholar:if=25.6" && tag.color.as_deref() == Some("red")));
        // Old rank data is replaced, not merged.
        assert!(!merged
            .iter()
            .any(|tag| tag.name == "#easyscholar:rank=CCF=B"));
    }

    #[test]
    fn journal_cleanup_preserves_metric_tags() {
        let tags = vec![
            PaperTag::new("#easyscholar:journal=CVPR"),
            PaperTag::new("#easyscholar:if=25.6"),
            PaperTag::new("nlp"),
        ];
        assert_eq!(
            strip_easyscholar_journal_tags(&tags),
            vec![PaperTag::new("#easyscholar:if=25.6"), PaperTag::new("nlp")]
        );
    }
}
