//! Index-Translate free public API (bilibili). OpenAI-compatible, no API key.
//! The prompt mirrors `build_prompt` in Index-Translate `inference/llm/call_api.py`.

use crate::error::AppError;
use crate::http;
use serde_json::{json, Value};
use std::time::Duration;

const API_ROOT: &str = "https://index-translate.bilibili.com/v1";
/// 35B total / 3B active MoE (preview). Best instruction following of the
/// text tiers; the free endpoint's default.
pub const MODEL_35B_A3B: &str = "Index-Translate-35B-A3B";
/// Dense 2B tier: lower latency, weaker on instruction following (glossary,
/// marker preservation) and on meme/slang handling.
pub const MODEL_2B: &str = "Index-Translate-2B";
const MAX_TOKENS: u32 = 4096;

/// Provider id → text-model tier. Both ids hit the same endpoint with the same
/// prompt; only `model` differs. `None` for ids this source does not own.
pub fn model_for_provider(provider: &str) -> Option<&'static str> {
    match provider {
        "indextranslate" => Some(MODEL_35B_A3B),
        "indextranslate2b" => Some(MODEL_2B),
        _ => None,
    }
}

/// Language code -> Chinese name, as used by the upstream prompt template.
fn lang_name(code: &str) -> Option<&'static str> {
    match super::lang_base(code.trim()).to_ascii_lowercase().as_str() {
        "zh" => Some("中文"),
        "en" => Some("英语"),
        "ja" => Some("日语"),
        "ko" => Some("韩语"),
        "de" => Some("德语"),
        "fr" => Some("法语"),
        "es" => Some("西班牙语"),
        "ru" => Some("俄语"),
        _ => None,
    }
}

use super::super::GlossaryTerm;
fn glossary_constraint(terms: &[GlossaryTerm]) -> Option<String> {
    (!terms.is_empty()).then(|| {
        format!(
            "【硬性要求】专名/术语对照: {}",
            terms
                .iter()
                .map(|(s, t)| format!("{s}→{t}"))
                .collect::<Vec<_>>()
                .join("、")
        )
    })
}

/// Canonical instTrans prompt: header, source, numbered constraints, output rule.
fn build_prompt(
    text: &str,
    source: &str,
    target: &str,
    glossary: &[GlossaryTerm],
) -> Result<String, AppError> {
    let tgt = lang_name(target).ok_or_else(|| {
        AppError::message(format!(
            "Index-Translate: unsupported target language {target}"
        ))
    })?;
    let source = source.trim();
    let src = if source.is_empty() || source.eq_ignore_ascii_case("auto") {
        None
    } else {
        lang_name(source)
    };
    let text = text.trim();

    let mut constraints: Vec<String> = Vec::new();
    if let Some(line) = glossary_constraint(glossary) {
        constraints.push(line);
    }
    constraints.push(
        "【注意】数学公式、符号、变量名、单位、行内代码、URL 与引用标记（如 [12]）原样保留，包括 ⟦n⟧ 占位符"
            .to_string(),
    );
    if text.contains("[[1]]") {
        constraints.push(
            "【硬性要求】保留每个 [[n]] 标记，编号与顺序不变，不得合并、移动或删除标记".to_string(),
        );
    }

    let header_src = src.map_or_else(|| "文本".to_string(), |s| format!("{s}文本"));
    let reqs: Vec<String> = constraints
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{}. {c}", i + 1))
        .collect();
    Ok(format!(
        "请将以下{header_src}翻译成{tgt}，并且严格遵循所有约束要求。\n\n【源文】\n{text}\n\n【约束要求】\n{}\n\n只输出译文，不要有任何额外说明。",
        reqs.join("\n")
    ))
}

/// Drop a CoT block if the server returns one.
fn strip_think(text: &str) -> String {
    let t = text.split_once("</think>").map_or(text, |(_, rest)| rest);
    t.trim().trim_start_matches("<think>").trim().to_string()
}

pub async fn translate_index_translate(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
    model: &str,
    glossary: &[GlossaryTerm],
) -> Result<String, AppError> {
    let prompt = build_prompt(text, source, target, glossary)?;
    let url = super::optional_endpoint(None, API_ROOT, "/chat/completions");
    let body = chat_body(&prompt, false, model);
    let client = http::client(timeout)?;
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| super::map_request_error("Index-Translate", e))?;
    let (status, body) = super::read_body(resp).await?;
    if !status.is_success() {
        return Err(super::http_err(status, &body, "Index-Translate"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("Index-Translate parse: {e}")))?;
    super::sse::chat_completion_text("Index-Translate", &v).map(|text| strip_think(&text))
}

fn chat_body(prompt: &str, stream: bool, model: &str) -> Value {
    json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens": MAX_TOKENS,
        "stream": stream,
        // Keep reasoning off: CoT text can replace the translation in the response.
        "chat_template_kwargs": {"enable_thinking": false}
    })
}

/// Streaming variant. `timeout` is the silence budget, not a total deadline.
/// `on_delta` receives each content increment; the full translation is returned
/// at the end. A `length` or filter finish is an error, not the partial text.
#[allow(clippy::too_many_arguments)]
pub async fn translate_index_translate_stream(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
    model: &str,
    glossary: &[GlossaryTerm],
    on_delta: impl FnMut(&str),
) -> Result<String, AppError> {
    let prompt = build_prompt(text, source, target, glossary)?;
    let url = super::optional_endpoint(None, API_ROOT, "/chat/completions");
    let client = http::streaming_client(timeout)?;
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&chat_body(&prompt, true, model))
        .send()
        .await
        .map_err(|e| super::map_request_error("Index-Translate", e))?;
    let out = super::sse::read_translation_stream(resp, "Index-Translate", on_delta).await?;
    let out = strip_think(&out);
    if out.is_empty() {
        return Err(AppError::message("Empty translation result"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn glossary_reaches_canonical_prompt() {
        let terms = vec![
            ("LLM".into(), "大模型".into()),
            ("KV cache".into(), "KV 缓存".into()),
        ];
        let prompt = build_prompt("The LLM uses KV cache.", "en", "zh-CN", &terms).unwrap();
        assert!(prompt.contains("【硬性要求】专名/术语对照: LLM→大模型、KV cache→KV 缓存"));
        assert!(glossary_constraint(&[]).is_none());
    }

    #[test]
    fn provider_ids_map_to_model_tiers() {
        assert_eq!(model_for_provider("indextranslate"), Some(MODEL_35B_A3B));
        assert_eq!(model_for_provider("indextranslate2b"), Some(MODEL_2B));
        assert_eq!(model_for_provider("huoshanweb"), None);
        assert_eq!(model_for_provider(""), None);
    }

    #[test]
    fn prompt_has_header_source_and_constraints() {
        let p = build_prompt("Hello world", "auto", "zh-CN", &[]).unwrap();
        assert!(p.starts_with("请将以下文本翻译成中文，并且严格遵循所有约束要求。"));
        assert!(p.contains("【源文】\nHello world"));
        assert!(p.contains("1. 【注意】"));
        assert!(!p.contains("专名/术语对照"));
        assert!(p.ends_with("只输出译文，不要有任何额外说明。"));
    }

    #[test]
    fn numbered_batch_adds_a_hard_marker_constraint() {
        let p = build_prompt("[[1]] a\n\n[[2]] b", "en", "zh-CN", &[]).unwrap();
        assert!(p.contains("请将以下英语文本翻译成中文"));
        assert!(p.contains("2. 【硬性要求】保留每个 [[n]] 标记"));
    }

    #[test]
    fn unknown_target_is_rejected() {
        assert!(build_prompt("x", "auto", "xx", &[]).is_err());
    }

    #[test]
    fn strip_think_drops_cot_block() {
        assert_eq!(strip_think("<think>why</think>\n你好"), "你好");
        assert_eq!(strip_think("  你好 "), "你好");
    }
}
