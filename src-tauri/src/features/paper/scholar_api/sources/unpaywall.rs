//! Unpaywall OA PDF URL source.

use async_trait::async_trait;

use crate::features::scholar_api::client;
use crate::features::scholar_api::traits::PdfUrlSource;
use crate::features::scholar_api::{ApiError, ApiQuery};

/// Unpaywall PDF URL resolver.
#[derive(Debug, Clone, Default)]
pub struct UnpaywallApi {
    /// Contact email required by the Unpaywall API Terms of Service.
    pub email: String,
}

impl UnpaywallApi {
    pub fn new(email: impl Into<String>) -> Self {
        Self {
            email: email.into(),
        }
    }
}

#[async_trait]
impl PdfUrlSource for UnpaywallApi {
    fn name(&self) -> &'static str {
        "unpaywall"
    }

    async fn pdf_url(&self, query: &ApiQuery) -> Result<Option<String>, ApiError> {
        let ApiQuery::Doi(doi) = query else {
            return Err(ApiError::UnsupportedQuery(query.clone()));
        };
        let url = format!(
            "https://api.unpaywall.org/v2/{}?email={}",
            urlencoding::encode(doi),
            urlencoding::encode(&self.email)
        );
        let value = client::get_json(&url).await?;
        let pdf_url = value
            .pointer("/best_oa_location/url_for_pdf")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty());
        Ok(pdf_url)
    }
}
