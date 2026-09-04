//! Translator Runtime source (Zotero translation-server).

use async_trait::async_trait;
use serde_json::Value;

use crate::scholar_api::traits::{AcademicApi, BibliographySource};
use crate::scholar_api::{ApiCapability, ApiError, ApiPaper, ApiQuery};

/// Translator Runtime source.
#[derive(Debug, Clone)]
pub struct TranslatorApi {
    pub base_url: String,
}

impl Default for TranslatorApi {
    fn default() -> Self {
        Self {
            base_url: "https://translator.philfan.cn".to_string(),
        }
    }
}

#[async_trait]
impl AcademicApi for TranslatorApi {
    fn name(&self) -> &'static str {
        "translator"
    }

    fn capabilities(&self) -> ApiCapability {
        ApiCapability::SEARCH_BY_TITLE
            | ApiCapability::FETCH_BY_DOI
            | ApiCapability::FETCH_BY_ARXIV
            | ApiCapability::FETCH_BY_ISBN
            | ApiCapability::FETCH_BY_PMID
            | ApiCapability::FETCH_BY_URL
            | ApiCapability::PROVIDE_ABSTRACT
            | ApiCapability::PROVIDE_VENUE
    }

    async fn fetch(&self, _query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError> {
        // TODO: migrate from features/import/mod.rs::translator_fetch
        Ok(Vec::new())
    }
}

#[async_trait]
impl BibliographySource for TranslatorApi {
    fn name(&self) -> &'static str {
        "translator"
    }

    async fn import_items(&self, _content: &str) -> Result<Vec<Value>, ApiError> {
        // TODO: migrate from features/import/mod.rs::translator_import
        Ok(Vec::new())
    }

    async fn export_items(&self, _items: &[Value], _format: &str) -> Result<String, ApiError> {
        // TODO
        Ok(String::new())
    }
}
