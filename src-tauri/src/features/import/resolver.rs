//! Identifier resolver table: one [`PaperResolver`] per import source.
//!
//! Adding a source = implement the trait + register it in [`TABLE`]. The
//! table drives detection order ([`PaperResolver::priority`]), the machine
//! kind tag and catalog dedup column ([`ResolvedIdentifier`]), Translator
//! request shaping ([`PaperResolver::translator_target`]) and the
//! direct-connect fallback after Translator failures
//! ([`PaperResolver::fetch_fallback`]).
//!
//! Skill imports are deliberately **not** table-driven; they keep the
//! front-dispatch through `parse::extract_skill_source`.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use crate::core::error::AppError;
use crate::features::import::map::{self, PaperMeta};
use crate::features::import::parse;

/// A recognized identifier: machine kind tag (e.g. `SkippedImport.kind`),
/// normalized value, and the catalog column used for batch dedup
/// (`None` → no column lookup).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedIdentifier {
    pub kind: &'static str,
    pub value: String,
    pub catalog_column: Option<&'static str>,
}

type FallbackFuture<'a> = Pin<Box<dyn Future<Output = Result<PaperMeta, AppError>> + Send + 'a>>;

pub(crate) trait PaperResolver: Send + Sync {
    /// Detection order when probing a text; lower runs first. The table is
    /// listed in this order (enforced by `table_is_priority_ordered`).
    #[cfg_attr(not(test), allow(dead_code))]
    fn priority(&self) -> u8;
    /// Machine kind tag surfaced to `SkippedImport` and the frontend.
    fn kind(&self) -> &'static str;
    /// Catalog column for batch dedup; `None` skips the lookup.
    fn catalog_column(&self) -> Option<&'static str>;
    /// Recognize the identifier in `text` (already trimmed, non-empty).
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier>;
    /// Translator Runtime request for a resolved value. Default:
    /// `{base}/search` + value.
    fn translator_target(&self, value: &str, base: &str) -> (String, String) {
        (format!("{base}/search"), value.to_string())
    }
    /// Direct-connect fallback after a Translator failure (arXiv → Atom,
    /// DOI → Crossref). `None` → no fallback for this source.
    fn fetch_fallback<'a>(
        &'a self,
        value: &'a str,
        task_id: Option<&'a str>,
    ) -> Option<FallbackFuture<'a>> {
        let _ = (value, task_id);
        None
    }
}

pub(crate) const ARXIV_KIND: &str = "arxiv";

struct UrlResolver;
impl PaperResolver for UrlResolver {
    fn priority(&self) -> u8 {
        10
    }
    fn kind(&self) -> &'static str {
        "url"
    }
    fn catalog_column(&self) -> Option<&'static str> {
        None
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        (text.starts_with("http://") || text.starts_with("https://")).then(|| ResolvedIdentifier {
            kind: self.kind(),
            value: text.to_string(),
            catalog_column: self.catalog_column(),
        })
    }
    fn translator_target(&self, value: &str, base: &str) -> (String, String) {
        (format!("{base}/web"), value.to_string())
    }
}

struct DoiResolver;
impl PaperResolver for DoiResolver {
    fn priority(&self) -> u8 {
        20
    }
    fn kind(&self) -> &'static str {
        "doi"
    }
    fn catalog_column(&self) -> Option<&'static str> {
        Some("doi")
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        clean_doi(text).map(|value| ResolvedIdentifier {
            kind: self.kind(),
            value,
            catalog_column: self.catalog_column(),
        })
    }
    fn fetch_fallback<'a>(
        &'a self,
        value: &'a str,
        _task_id: Option<&'a str>,
    ) -> Option<FallbackFuture<'a>> {
        Some(Box::pin(fetch_crossref_metadata(value)))
    }
}

struct ArxivResolver;
impl PaperResolver for ArxivResolver {
    fn priority(&self) -> u8 {
        30
    }
    fn kind(&self) -> &'static str {
        ARXIV_KIND
    }
    fn catalog_column(&self) -> Option<&'static str> {
        Some("arxiv_id")
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        parse::extract_arxiv_id(text).map(|value| ResolvedIdentifier {
            kind: self.kind(),
            value,
            catalog_column: self.catalog_column(),
        })
    }
    /// arXiv PDF endpoints are binary resources the Runtime cannot parse as
    /// web pages; every recognized form is canonicalized to its abstract
    /// page (direct IDs and URLs get the same metadata path).
    fn translator_target(&self, value: &str, base: &str) -> (String, String) {
        (
            format!("{base}/web"),
            format!("https://arxiv.org/abs/{value}"),
        )
    }
    fn fetch_fallback<'a>(
        &'a self,
        value: &'a str,
        task_id: Option<&'a str>,
    ) -> Option<FallbackFuture<'a>> {
        Some(Box::pin(fetch_arxiv_metadata(value, task_id)))
    }
}

struct IsbnResolver;
impl PaperResolver for IsbnResolver {
    fn priority(&self) -> u8 {
        40
    }
    fn kind(&self) -> &'static str {
        "isbn"
    }
    fn catalog_column(&self) -> Option<&'static str> {
        Some("isbn")
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        clean_isbn(text).map(|value| ResolvedIdentifier {
            kind: self.kind(),
            value,
            catalog_column: self.catalog_column(),
        })
    }
}

struct PmidResolver;
impl PaperResolver for PmidResolver {
    fn priority(&self) -> u8 {
        50
    }
    fn kind(&self) -> &'static str {
        "pmid"
    }
    fn catalog_column(&self) -> Option<&'static str> {
        Some("pmid")
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        // PMID: 1–9 digits
        regex_pmid(text).map(|value| ResolvedIdentifier {
            kind: self.kind(),
            value,
            catalog_column: self.catalog_column(),
        })
    }
}

struct AdsResolver;
impl PaperResolver for AdsResolver {
    fn priority(&self) -> u8 {
        60
    }
    fn kind(&self) -> &'static str {
        "ads"
    }
    /// ADS bibcodes are folder ids; dedup happens on the primary `id` column.
    fn catalog_column(&self) -> Option<&'static str> {
        Some("id")
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        regex_ads(text).map(|value| ResolvedIdentifier {
            kind: self.kind(),
            value,
            catalog_column: self.catalog_column(),
        })
    }
}

/// Compile-time static table, listed in [`PaperResolver::priority`] order
/// (guarded by `table_is_priority_ordered`).
const TABLE: &[&dyn PaperResolver] = &[
    &UrlResolver,
    &DoiResolver,
    &ArxivResolver,
    &IsbnResolver,
    &PmidResolver,
    &AdsResolver,
];

pub(crate) fn resolvers() -> &'static [&'static dyn PaperResolver] {
    TABLE
}

/// Look a resolver up by its machine kind tag (e.g. for the arXiv
/// canonicalization that runs ahead of the generic probe).
pub(crate) fn find(kind: &str) -> Option<&'static dyn PaperResolver> {
    resolvers().iter().copied().find(|r| r.kind() == kind)
}

/// Probe `text` against the table in priority order; first hit wins.
pub(crate) fn extract(text: &str) -> Option<ResolvedIdentifier> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    resolvers().iter().find_map(|r| r.extract(t))
}

/// First direct-connect fallback whose resolver matches `text`, probing the
/// table independently of the primary identifier: a `doi.org` URL resolves
/// as `url` first, yet its DOI still gets the Crossref fallback.
pub(crate) async fn fetch_direct_fallback(
    text: &str,
    task_id: Option<&str>,
) -> Option<Result<PaperMeta, AppError>> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    for resolver in resolvers() {
        let Some(ident) = resolver.extract(t) else {
            continue;
        };
        let fallback = resolver.fetch_fallback(&ident.value, task_id);
        if let Some(fut) = fallback {
            return Some(fut.await);
        }
    }
    None
}

// --- Normalization helpers (moved verbatim from parse.rs) ---

fn clean_doi(s: &str) -> Option<String> {
    let mut x = s.trim().to_string();
    if x.starts_with("https://doi.org/") {
        x = x["https://doi.org/".len()..].to_string();
    } else if x.starts_with("http://doi.org/") {
        x = x["http://doi.org/".len()..].to_string();
    } else if x.starts_with("doi:") {
        x = x["doi:".len()..].trim().to_string();
    }
    // 10.xxxx/...
    if let Some(start) = x.find("10.") {
        let cand = &x[start..];
        let end = cand
            .find(|c: char| c.is_whitespace() || c == ',' || c == ';')
            .unwrap_or(cand.len());
        let doi = cand[..end].trim_end_matches(['.', ',', ')']).to_string();
        if doi.contains('/') {
            return Some(doi);
        }
    }
    None
}

fn clean_isbn(s: &str) -> Option<String> {
    let digits: String = s
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == 'X' || *c == 'x')
        .collect();
    let upper = digits.to_uppercase();
    if upper.len() == 13 && (upper.starts_with("978") || upper.starts_with("979")) {
        return Some(upper);
    }
    if upper.len() == 10 {
        return Some(upper);
    }
    None
}

fn regex_pmid(s: &str) -> Option<String> {
    let t = s
        .trim()
        .trim_start_matches("PMID:")
        .trim_start_matches("pmid:");
    let t = t.trim();
    if !t.is_empty() && t.len() <= 9 && t.chars().all(|c| c.is_ascii_digit()) {
        return Some(t.to_string());
    }
    None
}

fn regex_ads(s: &str) -> Option<String> {
    // 2015ApJ...810...89S — 19 chars-ish
    let t = s.trim();
    if t.len() == 19
        && t.as_bytes()[0].is_ascii_digit()
        && t.as_bytes()[1].is_ascii_digit()
        && t.as_bytes()[2].is_ascii_digit()
        && t.as_bytes()[3].is_ascii_digit()
    {
        return Some(t.to_string());
    }
    None
}

// --- Direct-connect clients (fallbacks behind the trait) ---

/// `GET https://export.arxiv.org/api/query?id_list=…` (Atom) → `PaperMeta`.
pub(crate) async fn fetch_arxiv_metadata(
    arxiv_id: &str,
    task_id: Option<&str>,
) -> Result<PaperMeta, AppError> {
    let bare = parse::strip_arxiv_version(arxiv_id);
    let api = format!(
        "https://export.arxiv.org/api/query?id_list={}",
        urlencoding_encode(&bare)
    );
    let client = crate::core::http::client_builder()
        .timeout(Duration::from_secs(30))
        .user_agent("agentero-lookup/0.1")
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;
    let xml = client
        .get(&api)
        .send()
        .await
        .map_err(|e| AppError::message(format!("arXiv API: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::message(format!("arXiv body: {e}")))?;
    super::check_task_not_cancelled(task_id)?;

    map::map_arxiv_atom(&xml, &bare).await
}

fn urlencoding_encode(s: &str) -> String {
    // minimal encode for arxiv ids
    s.replace('/', "%2F")
}

/// `GET https://api.crossref.org/works/{doi}` → `PaperMeta`.
pub(crate) async fn fetch_crossref_metadata(doi: &str) -> Result<PaperMeta, AppError> {
    let url = format!(
        "https://api.crossref.org/works/{}",
        urlencoding::encode(doi.trim())
    );
    let client = crate::core::http::client_builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!(
            "Agentero/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/poco-ai/agentero)"
        ))
        .build()
        .map_err(|e| AppError::message(format!("crossref http client: {e}")))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::message(format!("crossref request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::message(format!(
            "crossref HTTP {} for {doi}",
            response.status()
        )));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::message(format!("crossref body: {e}")))?;
    map::map_crossref_work(
        value
            .pointer("/message")
            .unwrap_or(&serde_json::Value::Null),
        doi,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_priority_ordered_with_unique_kinds() {
        let priorities: Vec<u8> = TABLE.iter().map(|r| r.priority()).collect();
        let mut sorted = priorities.clone();
        sorted.sort_unstable();
        assert_eq!(priorities, sorted, "TABLE must be listed by priority");
        let mut kinds: Vec<_> = TABLE.iter().map(|r| r.kind()).collect();
        let count = kinds.len();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(kinds.len(), count, "kind tags must be unique");
    }

    #[test]
    fn catalog_columns_match_kinds() {
        // ADS bibcode reuses the primary `id` column; URL has no column.
        let cols: Vec<(&str, Option<&'static str>)> = TABLE
            .iter()
            .map(|r| (r.kind(), r.catalog_column()))
            .collect();
        assert_eq!(
            cols,
            vec![
                ("url", None),
                ("doi", Some("doi")),
                ("arxiv", Some("arxiv_id")),
                ("isbn", Some("isbn")),
                ("pmid", Some("pmid")),
                ("ads", Some("id")),
            ]
        );
    }

    #[test]
    fn translator_targets_per_kind() {
        let base = "https://t.example";
        assert_eq!(
            find("url")
                .unwrap()
                .translator_target("https://a.com/p", base),
            (
                "https://t.example/web".to_string(),
                "https://a.com/p".to_string(),
            )
        );
        // Default target: /search + value.
        assert_eq!(
            find("doi").unwrap().translator_target("10.1038/x", base),
            (
                "https://t.example/search".to_string(),
                "10.1038/x".to_string(),
            )
        );
        assert_eq!(
            find("pmid").unwrap().translator_target("24297125", base),
            (
                "https://t.example/search".to_string(),
                "24297125".to_string(),
            )
        );
        // arXiv canonicalizes every form to the abstract page.
        assert_eq!(
            find("arxiv").unwrap().translator_target("1706.03762", base),
            (
                "https://t.example/web".to_string(),
                "https://arxiv.org/abs/1706.03762".to_string(),
            )
        );
    }

    #[test]
    fn only_arxiv_and_doi_have_direct_fallbacks() {
        let has_fallback = |kind: &str| {
            let resolver = find(kind).unwrap();
            resolver
                .fetch_fallback("", None)
                .map(|_| true)
                .unwrap_or(false)
        };
        assert!(has_fallback("arxiv"));
        assert!(has_fallback("doi"));
        for kind in ["url", "isbn", "pmid", "ads"] {
            assert!(!has_fallback(kind), "{kind} should have no fallback");
        }
    }

    #[test]
    fn doi_clean() {
        assert_eq!(
            clean_doi("https://doi.org/10.1038/nature12373").as_deref(),
            Some("10.1038/nature12373")
        );
    }
}
