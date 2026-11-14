//! Default terminology is derived from the licensed AI/LLM glossary, not user setup.
use super::{matching_glossary, GlossaryTerm};
use crate::error::AppError;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const PROTECTION_RETRY_AFTER: Duration = Duration::from_secs(600);
static REJECTED_PROTECTION: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

pub fn protection_allowed(key: &str) -> bool {
    REJECTED_PROTECTION
        .get_or_init(Default::default)
        .lock()
        .map(|cache| {
            cache
                .get(key)
                .is_none_or(|failed_at| failed_at.elapsed() >= PROTECTION_RETRY_AFTER)
        })
        .unwrap_or(false)
}

pub fn remember_rejected_protection(key: String) {
    if let Ok(mut cache) = REJECTED_PROTECTION.get_or_init(Default::default).lock() {
        cache.retain(|_, failed_at| failed_at.elapsed() < PROTECTION_RETRY_AFTER);
        if cache.len() >= 64 {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(key, Instant::now());
    }
}

pub struct TranslationAttempt {
    pub text: String,
    pub rejected_protection: bool,
}

/// A glossary enhancement must never turn a valid MT response into a failed job.
/// Retry the untouched source on the same provider; never return damaged markers.
pub async fn translate_with_fallback<F, Fut>(
    text: &str,
    terms: &[GlossaryTerm],
    protect_terms: bool,
    mut translate: F,
) -> Result<TranslationAttempt, AppError>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, AppError>>,
{
    let (request, replacements) = if protect_terms {
        protect(text, terms)
    } else {
        (text.to_owned(), vec![])
    };
    let translated = translate(request).await?;
    match restore(translated, &replacements) {
        Ok(text) => Ok(TranslationAttempt {
            text,
            rejected_protection: false,
        }),
        Err(_) => Ok(TranslationAttempt {
            text: translate(text.to_owned()).await?,
            rejected_protection: true,
        }),
    }
}

#[derive(Deserialize)]
struct Term {
    aliases: Vec<String>,
    translation: String,
}
fn terms() -> &'static Vec<Term> {
    static TERMS: OnceLock<Vec<Term>> = OnceLock::new();
    TERMS.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../src/lib/translate/data/ai-terms.json"
        )))
        .expect("validated bundled terminology")
    })
}
pub fn is_known_term(text: &str) -> bool {
    terms().iter().any(|term| {
        term.aliases
            .iter()
            .any(|alias| alias.eq_ignore_ascii_case(text.trim()))
    })
}
fn technical_context(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    if [
        "master of laws",
        "law degree",
        "law school",
        "voltage",
        "electrical transformer",
        "power transformer",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        return false;
    }
    [
        "model",
        "neural",
        "attention",
        "token",
        "inference",
        "learning",
        "embedding",
        "gpu",
        "transformer",
        "llm",
        "kv cache",
        "rag",
        "lora",
    ]
    .iter()
    .any(|s| text.contains(s))
}
pub fn effective_glossary(
    user: &str,
    text: &str,
    target: &str,
) -> Result<Vec<GlossaryTerm>, AppError> {
    let mut result = BTreeMap::new();
    if target == "zh-CN" && technical_context(text) {
        let defaults: BTreeMap<_, _> = terms()
            .iter()
            .flat_map(|t| t.aliases.iter().map(|a| (a.clone(), t.translation.clone())))
            .collect();
        result.extend(matching_glossary(&serde_json::to_string(&defaults)?, text)?);
    }
    result.extend(matching_glossary(user, text)?);
    Ok(result.into_iter().collect())
}

/** Protect matched terms for MT services that have no glossary parameter. */
pub fn protect(text: &str, terms: &[GlossaryTerm]) -> (String, Vec<(String, String)>) {
    let mut terms: Vec<_> = terms.iter().filter(|(s, _)| s.is_ascii()).collect();
    terms.sort_by_key(|(s, _)| std::cmp::Reverse(s.len()));
    let mut prefix = "AGTX".to_string();
    while text.to_ascii_uppercase().contains(&prefix) {
        prefix.push('X');
    }
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut result = String::new();
    let mut replacements = Vec::new();
    let mut pos = 0;
    while pos < text.len() {
        let matched = terms.iter().find(|(source, _)| {
            text.get(pos..pos + source.len())
                .is_some_and(|s| s.eq_ignore_ascii_case(source))
                && text[..pos].chars().next_back().is_none_or(|c| !word(c))
                && text[pos + source.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| !word(c))
        });
        if let Some((source, target)) = matched {
            let marker = format!("{prefix}{}XZ", replacements.len());
            result.push_str(&marker);
            replacements.push((marker, target.clone()));
            pos += source.len();
        } else {
            let c = text[pos..].chars().next().expect("valid character offset");
            result.push(c);
            pos += c.len_utf8();
        }
    }
    (result, replacements)
}
pub fn restore(mut text: String, replacements: &[(String, String)]) -> Result<String, AppError> {
    for (marker, target) in replacements {
        let lower = text.to_ascii_lowercase();
        let key = marker.to_ascii_lowercase();
        let Some(start) = lower.find(&key) else {
            return Err(AppError::domain(
                "translate.terminology_not_preserved",
                "Translation service did not preserve terminology markers.",
            ));
        };
        if lower.matches(&key).count() != 1 {
            return Err(AppError::domain(
                "translate.terminology_not_preserved",
                "Translation service duplicated a terminology marker.",
            ));
        }
        text.replace_range(start..start + marker.len(), target);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn damaged_or_duplicated_markers_retry_the_untouched_source_once() {
        for damaged in ["AGTX 0 XZ", "AGTX0XZ and AGTX0XZ", "a translated acronym"] {
            let mut requests = Vec::new();
            let result = translate_with_fallback(
                "The LLM generates text.",
                &[("LLM".into(), "大模型".into())],
                true,
                |request| {
                    requests.push(request);
                    std::future::ready(Ok(if requests.len() == 1 {
                        damaged.into()
                    } else {
                        "这是普通译文。".into()
                    }))
                },
            )
            .await
            .unwrap();
            assert_eq!(
                requests,
                ["The AGTX0XZ generates text.", "The LLM generates text."]
            );
            assert_eq!(result.text, "这是普通译文。");
            assert!(result.rejected_protection);
            assert!(!result.text.contains("AGTX"));
        }
    }

    #[tokio::test]
    async fn supported_markers_restore_without_an_extra_request() {
        let mut calls = 0;
        let result = translate_with_fallback(
            "The LLM generates text.",
            &[("LLM".into(), "大模型".into())],
            true,
            |_| {
                calls += 1;
                std::future::ready(Ok("agtx0xz 生成文本。".into()))
            },
        )
        .await
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(result.text, "大模型 生成文本。");
        assert!(!result.rejected_protection);
    }

    #[tokio::test]
    async fn bypass_and_transport_failures_never_trigger_unrelated_retries() {
        let mut requests = Vec::new();
        let result = translate_with_fallback(
            "The LLM generates text.",
            &[("LLM".into(), "大模型".into())],
            false,
            |request| {
                requests.push(request);
                std::future::ready(Ok("普通译文".into()))
            },
        )
        .await
        .unwrap();
        assert_eq!(requests, ["The LLM generates text."]);
        assert!(!result.rejected_protection);
        let mut calls = 0;
        let result = translate_with_fallback(
            "The LLM generates text.",
            &[("LLM".into(), "大模型".into())],
            true,
            |_| {
                calls += 1;
                std::future::ready(Err(AppError::message("network unavailable")))
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }

    #[test]
    fn failed_protection_is_cached_per_service_configuration() {
        let failed = "test:tencent:en:zh";
        let other = "test:tencent:en:en";
        remember_rejected_protection(failed.into());
        assert!(!protection_allowed(failed));
        assert!(protection_allowed(other));
    }

    #[test]
    fn defaults_need_no_configuration_and_user_overrides_are_optional() {
        let terms = effective_glossary(
            "",
            "The LLM uses a KV cache and Transformer model.",
            "zh-CN",
        )
        .unwrap();
        assert!(terms.contains(&("LLM".into(), "大模型".into())));
        assert!(terms.contains(&("KV Cache".into(), "键值缓存".into())));
        assert!(
            effective_glossary("", "An LLM is a Master of Laws degree.", "zh-CN")
                .unwrap()
                .is_empty()
        );
        assert!(
            effective_glossary("", "A power transformer changes voltage.", "zh-CN")
                .unwrap()
                .is_empty()
        );
        let (masked, replacements) = protect("LLM and KV cache, LLMs and myLLM.", &terms);
        assert!(masked.contains("LLMs and myLLM"));
        assert_eq!(
            restore(masked, &replacements).unwrap(),
            "大模型 and 键值缓存, LLMs and myLLM."
        );
        assert!(restore("broken output".into(), &replacements).is_err());
        assert!(
            effective_glossary("LLM→大语言模型", "The LLM model", "zh-CN")
                .unwrap()
                .contains(&("LLM".into(), "大语言模型".into()))
        );
    }
}
