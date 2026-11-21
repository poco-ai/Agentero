//! PubMed Central open-access PDF source.
//!
//! PMC article pages (`pmc.ncbi.nlm.nih.gov/articles/<PMCID>/pdf/`) answer
//! scripted clients with a JavaScript proof-of-work page, so the PDF link that
//! PubMed metadata carries no longer downloads. NCBI publishes the same
//! open-access PDFs in the PMC Article Datasets bucket on AWS Open Data, which
//! serves plain HTTPS without a browser check. This source maps a DOI, PMID or
//! PMC link to a PMCID through the NCBI ID Converter and returns the bucket URL
//! of the newest article version's PDF.

use async_trait::async_trait;

use crate::features::scholar_api::client;
use crate::features::scholar_api::traits::PdfUrlSource;
use crate::features::scholar_api::{ApiError, ApiQuery};

const IDCONV: &str = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/";
const BUCKET: &str = "https://pmc-oa-opendata.s3.amazonaws.com";
const EMAIL: &str = "agentero@users.noreply.github.com";
const TOOL: &str = "agentero";

/// PMC open-access PDF resolver.
#[derive(Debug, Clone, Default)]
pub struct PmcOaApi;

#[async_trait]
impl PdfUrlSource for PmcOaApi {
    fn name(&self) -> &'static str {
        "pmc"
    }

    async fn pdf_url(&self, query: &ApiQuery) -> Result<Option<String>, ApiError> {
        let pmcid = match query {
            ApiQuery::Url(url) => pmcid_from_url(url),
            ApiQuery::Doi(id) | ApiQuery::Pmid(id) => lookup_pmcid(id).await?,
            _ => return Err(ApiError::UnsupportedQuery(query.clone())),
        };
        let Some(pmcid) = pmcid else {
            return Ok(None);
        };
        // The trailing dot keeps PMC123 from matching PMC1234's objects.
        let listing = client::get_text(&format!("{BUCKET}/?list-type=2&prefix={pmcid}.")).await?;
        Ok(newest_pdf_key(&listing, &pmcid).map(|key| format!("{BUCKET}/{key}")))
    }
}

async fn lookup_pmcid(id: &str) -> Result<Option<String>, ApiError> {
    let url = format!(
        "{IDCONV}?ids={}&format=json&tool={TOOL}&email={}",
        urlencoding::encode(id.trim()),
        urlencoding::encode(EMAIL)
    );
    let value = client::get_json(&url).await?;
    Ok(value
        .pointer("/records/0/pmcid")
        .and_then(|v| v.as_str())
        .and_then(pmcid_from_url))
}

/// First `PMC<digits>` token in a PMC / Europe PMC link or a bare PMCID.
fn pmcid_from_url(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let is_pmc_host = lower.contains("ncbi.nlm.nih.gov") || lower.contains("europepmc.org");
    if lower.contains("://") && !is_pmc_host {
        return None;
    }
    lower.match_indices("pmc").find_map(|(at, _)| {
        let digits: String = lower[at + 3..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let boundary = lower[..at]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_ascii_alphanumeric());
        (boundary && !digits.is_empty()).then(|| format!("PMC{digits}"))
    })
}

/// Key of the highest-version `<PMCID>.<v>/<PMCID>.<v>.pdf` in an S3
/// ListObjectsV2 response. Author manuscripts often carry no PDF.
fn newest_pdf_key(listing: &str, pmcid: &str) -> Option<String> {
    listing
        .split("<Key>")
        .skip(1)
        .filter_map(|rest| rest.split("</Key>").next())
        .filter_map(|key| {
            let (dir, file) = key.split_once('/')?;
            let version: u32 = dir.strip_prefix(pmcid)?.strip_prefix('.')?.parse().ok()?;
            (file == format!("{dir}.pdf")).then(|| (version, key.to_string()))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, key)| key)
}
