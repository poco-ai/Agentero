//! EasyScholar journal/venue metrics source.

use async_trait::async_trait;
use serde_json::Value;

use crate::scholar_api::client;
use crate::scholar_api::traits::VenueMetricsSource;
use crate::scholar_api::{ApiError, VenueIdentifiers, VenueMetrics, VenueRank};

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
        _identifiers: &VenueIdentifiers,
    ) -> Result<VenueMetrics, ApiError> {
        let url = format!(
            "{}?secretKey={}&publicationName={}",
            Self::ENDPOINT,
            urlencoding::encode(&self.secret_key),
            urlencoding::encode(venue.trim())
        );
        let value = client::get_json_with_timeout(&url, client::DEFAULT_TIMEOUT).await?;
        parse_response(venue, &value)
    }
}

fn parse_response(venue: &str, value: &Value) -> Result<VenueMetrics, ApiError> {
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
