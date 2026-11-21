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

/// Stable wire code when the reply echoes the prompt and the remainder is
/// empty or not a translation. The WebView maps this code.
pub const ERR_PROMPT_ECHO: &str = "translate.index_prompt_echo";

/// Fragments that exist only inside [`build_prompt`]. A real translation does
/// not contain them. The WebView sidecar check uses the same strings.
const PROMPT_ECHO_MARKERS: &[&str] = &[
    "【源文】",
    "【约束要求】",
    "只输出译文",
    "不要有任何额外说明",
    "【注意】数学公式、符号、变量名、单位、行内代码、URL 与引用标记",
    "【硬性要求】保留每个 [[n]] 标记",
    "专名/术语对照",
];

/// `build_prompt` header. Language names vary, so match the fixed ends.
fn header_echo_start(text: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(rel) = text[from..].find("请将以下") {
        let start = from + rel;
        let after = &text[start..];
        if let Some(end_rel) = after.find("严格遵循所有约束要求") {
            let between = &after[..end_rel];
            if between.contains("翻译成") && end_rel <= 120 {
                return Some(start);
            }
        }
        from = start + "请将以下".len();
    }
    None
}

fn earliest_prompt_echo(text: &str) -> Option<usize> {
    let mut best = header_echo_start(text);
    for marker in PROMPT_ECHO_MARKERS {
        if let Some(index) = text.find(marker) {
            best = Some(best.map_or(index, |current| current.min(index)));
        }
    }
    best
}

fn same_folded_text(left: &str, right: &str) -> bool {
    let fold = |value: &str| value.split_whitespace().collect::<Vec<_>>().join(" ");
    fold(left) == fold(right)
}

/// Remainder after the echo is cut. Empty, still templated, or identical to
/// the source is not a translation.
fn remainder_is_translation(remainder: &str, source: &str) -> bool {
    let remainder = remainder.trim();
    if remainder.is_empty() || earliest_prompt_echo(remainder).is_some() {
        return false;
    }
    if same_folded_text(remainder, source.trim()) {
        return false;
    }
    remainder
        .chars()
        .any(|ch| ch.is_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&ch))
}

enum ModelOutput {
    Translation(String),
    Empty,
    PromptEcho,
}

/// Strip CoT, then cut a prompt echo. A reply with no template fragment is
/// returned unchanged. An echo keeps only the text before the first marker.
fn classify_model_output(raw: &str, source: &str) -> ModelOutput {
    let text = strip_think(raw);
    let Some(cut) = earliest_prompt_echo(&text) else {
        return if text.is_empty() {
            ModelOutput::Empty
        } else {
            ModelOutput::Translation(text)
        };
    };
    let remainder = text[..cut].trim();
    if remainder_is_translation(remainder, source) {
        ModelOutput::Translation(remainder.to_string())
    } else {
        ModelOutput::PromptEcho
    }
}

fn prompt_echo_error() -> AppError {
    AppError::domain(ERR_PROMPT_ECHO, ERR_PROMPT_ECHO)
}

fn empty_translation_error() -> AppError {
    AppError::message("Empty translation result")
}

fn output_result(output: ModelOutput) -> Result<String, AppError> {
    match output {
        ModelOutput::Translation(text) => Ok(text),
        ModelOutput::Empty => Err(empty_translation_error()),
        ModelOutput::PromptEcho => Err(prompt_echo_error()),
    }
}

/// The 2B tier is the one that echoes this prompt. One retry uses 35B on the
/// same endpoint. Temperature is 0, so repeating the same tier does not help.
fn echo_retry_model(model: &str) -> Option<&'static str> {
    (model == MODEL_2B).then_some(MODEL_35B_A3B)
}

/// Forward deltas until a prompt marker starts. The marker and everything
/// after it stay out of the live preview; the final string is classified.
fn append_visible_delta(out: &mut String, delta: &str, on_delta: &mut impl FnMut(&str)) {
    let before = out.len();
    out.push_str(delta);
    let visible_end = earliest_prompt_echo(out).unwrap_or(out.len());
    if before >= visible_end {
        return;
    }
    let end = visible_end.min(out.len());
    if before < end {
        on_delta(&out[before..end]);
    }
}

/// One-shot fetch used by the 2B→35B echo retry. The first attempt, streaming
/// or not, still goes through the shared SSE reader.
async fn post_completion(prompt: &str, timeout: Duration, model: &str) -> Result<String, AppError> {
    let url = super::optional_endpoint(None, API_ROOT, "/chat/completions");
    let body = chat_body(prompt, false, model);
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
    super::sse::chat_completion_text("Index-Translate", &v)
}

/// Accept a clean or stripped reply. A prompt echo on 2B is retried once on
/// 35B. A failed remainder stays an error so the caller keeps the source.
async fn accept_or_retry(
    raw: &str,
    source: &str,
    model: &str,
    timeout: Duration,
    started: std::time::Instant,
    prompt: &str,
) -> Result<String, AppError> {
    match classify_model_output(raw, source) {
        ModelOutput::PromptEcho => {}
        other => return output_result(other),
    }
    let Some(retry_model) = echo_retry_model(model) else {
        return Err(prompt_echo_error());
    };
    log::debug!("translate.index_prompt_echo action=retry model={retry_model}");
    let remaining = timeout
        .saturating_sub(started.elapsed())
        .max(Duration::from_millis(1));
    let retried = post_completion(prompt, remaining, retry_model).await?;
    output_result(classify_model_output(&retried, source))
}

pub async fn translate_index_translate(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
    model: &str,
    glossary: &[GlossaryTerm],
) -> Result<String, AppError> {
    let started = std::time::Instant::now();
    let prompt = build_prompt(text, source, target, glossary)?;
    let raw = post_completion(&prompt, timeout, model).await?;
    accept_or_retry(&raw, text, model, timeout, started, &prompt).await
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
    mut on_delta: impl FnMut(&str),
) -> Result<String, AppError> {
    let started = std::time::Instant::now();
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
    let mut preview = String::new();
    let raw = super::sse::read_translation_stream(resp, "Index-Translate", |delta| {
        append_visible_delta(&mut preview, delta, &mut on_delta);
    })
    .await?;
    accept_or_retry(&raw, text, model, timeout, started, &prompt).await
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

    fn translated(raw: &str, source: &str) -> String {
        match classify_model_output(raw, source) {
            ModelOutput::Translation(text) => text,
            ModelOutput::Empty => panic!("empty"),
            ModelOutput::PromptEcho => panic!("prompt echo"),
        }
    }

    #[test]
    fn tail_constraint_echo_keeps_the_translation() {
        let raw = "我们可以将噪声功率估算为\n\n【约束要求】\n1. 【注意】数学公式、符号、变量名、单位、行内代码、URL 与引用标记（如 [12]）原样保留，包括 ⟦n⟧ 占位符\n\n只输出译文，不要有任何额外说明。";
        assert_eq!(
            translated(raw, "We can estimate the noise power as"),
            "我们可以将噪声功率估算为"
        );
    }

    #[test]
    fn inline_constraint_echo_matches_the_reported_sentence() {
        let raw = "噪声功率可估计为 【约束要求】 1. 【注意】数学公式、符号、变量名、单位、行内代码、URL 与引用标记（如 [12]）原样保留，包括 ⟦n⟧ 占位符 只输出译文，不要有任何额外说明。";
        assert_eq!(
            translated(raw, "We can estimate the noise power as"),
            "噪声功率可估计为"
        );
    }

    #[test]
    fn source_block_echo_keeps_the_prefix() {
        let raw = "我们可以如下估算噪声功率：\n\n【源文】\nWe can estimate the noise power as follows\n\n【约束要求】\n1. 【注意】数学公式、符号、变量名、单位、行内代码、URL 与引用标记（如 [12]）原样保留，包括 ⟦n⟧ 占位符\n\n只输出译文，不要有任何额外说明。";
        assert_eq!(
            translated(raw, "We can estimate the noise power as follows"),
            "我们可以如下估算噪声功率："
        );
    }

    #[test]
    fn prompt_header_with_no_translation_is_an_echo() {
        let raw = "请将以下英语文本翻译成中文，并且严格遵循所有约束要求。\n\n【源文】\nHello\n\n【约束要求】\n1. 【注意】数学公式、符号、变量名、单位、行内代码、URL 与引用标记（如 [12]）原样保留，包括 ⟦n⟧ 占位符\n\n只输出译文，不要有任何额外说明。";
        assert!(matches!(
            classify_model_output(raw, "Hello"),
            ModelOutput::PromptEcho
        ));
    }

    #[test]
    fn source_copied_before_the_constraints_is_not_a_translation() {
        let raw = "Hello world\n\n【约束要求】\n只输出译文，不要有任何额外说明。";
        assert!(matches!(
            classify_model_output(raw, "Hello world"),
            ModelOutput::PromptEcho
        ));
    }

    #[test]
    fn constraint_body_without_the_heading_is_still_cut() {
        let raw = "噪声功率可估计为 【注意】数学公式、符号、变量名、单位、行内代码、URL 与引用标记（如 [12]）原样保留";
        assert_eq!(
            translated(raw, "We can estimate the noise power as"),
            "噪声功率可估计为"
        );
    }

    #[test]
    fn cot_block_is_removed_before_the_echo_check() {
        let raw = "<think>quote 【约束要求】</think>\n你好\n\n只输出译文，不要有任何额外说明。";
        assert_eq!(translated(raw, "Hi"), "你好");
    }

    #[test]
    fn clean_reply_is_unchanged() {
        assert_eq!(translated("  你好 ", "Hello"), "你好");
        assert!(matches!(
            classify_model_output("   ", "Hello"),
            ModelOutput::Empty
        ));
    }

    #[test]
    fn numbered_batch_keeps_segments_before_the_echo() {
        let raw = "[[1]] 甲\n\n[[2]] 乙\n\n【约束要求】\n只输出译文，不要有任何额外说明。";
        assert_eq!(
            translated(raw, "[[1]] a\n\n[[2]] b"),
            "[[1]] 甲\n\n[[2]] 乙"
        );
    }

    #[test]
    fn echo_retry_uses_35b_only_for_the_2b_tier() {
        assert_eq!(echo_retry_model(MODEL_2B), Some(MODEL_35B_A3B));
        assert_eq!(echo_retry_model(MODEL_35B_A3B), None);
        assert_eq!(prompt_echo_error().code(), ERR_PROMPT_ECHO);
    }

    #[test]
    fn visible_deltas_stop_at_the_prompt_marker() {
        let mut out = String::new();
        let mut seen = String::new();
        append_visible_delta(&mut out, "噪声功率可估计为 ", &mut |d| {
            seen.push_str(d)
        });
        append_visible_delta(&mut out, "【约束要求】 只输出译文", &mut |d| {
            seen.push_str(d)
        });
        assert_eq!(seen, "噪声功率可估计为 ");
        assert!(out.contains("【约束要求】"));
    }
}
