//! OpenAI-style server-sent chat completions.
//! Shared by Index-Translate and OpenAI-compatible streaming.

use crate::error::AppError;
use serde_json::Value;

use super::super::{map_request_error, reject_incomplete_finish};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SseEvent {
    Delta(String),
    Finish(String),
    Upstream(String),
    Done,
}

/// One SSE line. A chunk may carry both content and a finish reason.
pub(crate) fn parse_sse_line(line: &str) -> Vec<SseEvent> {
    let Some(body) = line.trim().strip_prefix("data:") else {
        return Vec::new();
    };
    let body = body.trim();
    if body == "[DONE]" {
        return vec![SseEvent::Done];
    }
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    if let Some(err) = v.get("error") {
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .or_else(|| err.as_str())
            .unwrap_or("upstream error");
        return vec![SseEvent::Upstream(message.to_string())];
    }
    let Some(choice) = v.get("choices").and_then(|choices| choices.get(0)) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    for pointer in ["/delta/content", "/message/content"] {
        if let Some(content) = choice.pointer(pointer).and_then(|c| c.as_str()) {
            if !content.is_empty() {
                events.push(SseEvent::Delta(content.to_string()));
                break;
            }
        }
    }
    if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
        if !reason.is_empty() {
            events.push(SseEvent::Finish(reason.to_string()));
        }
    }
    events
}

/// Non-streaming chat completion. `length` / `filter` is an error, not the
/// truncated text.
pub(crate) fn chat_completion_text(label: &str, value: &Value) -> Result<String, AppError> {
    if let Some(message) = value
        .pointer("/error/message")
        .and_then(|m| m.as_str())
        .filter(|m| !m.is_empty())
    {
        return Err(AppError::message(format!(
            "{label} upstream error: {message}"
        )));
    }
    let choice = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .ok_or_else(|| AppError::message(format!("Unexpected {label} response")))?;
    reject_incomplete_finish(choice.get("finish_reason").and_then(|r| r.as_str()), label)?;
    choice
        .pointer("/message/content")
        .and_then(|c| c.as_str())
        .map(str::to_string)
        .ok_or_else(|| AppError::message(format!("Unexpected {label} response")))
}

/// Read an SSE body. The client's read timeout is the silence budget; this
/// function only classifies what arrived.
pub(crate) async fn read_translation_stream(
    resp: reqwest::Response,
    label: &str,
    mut on_delta: impl FnMut(&str),
) -> Result<String, AppError> {
    use futures_util::StreamExt;

    if !resp.status().is_success() {
        let (status, body) = super::read_body(resp).await?;
        return Err(super::http_err(status, &body, label));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut out = String::new();
    let mut raw = String::new();
    let mut saw_sse = false;

    loop {
        let Some(chunk) = stream.next().await else {
            break;
        };
        let chunk = chunk.map_err(|e| map_request_error(label, e))?;
        if !saw_sse && raw.len() < 65_536 {
            raw.push_str(&String::from_utf8_lossy(&chunk));
        }
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            if line.trim_start().starts_with("data:") {
                saw_sse = true;
            }
            if apply_sse_line(label, &line, &mut out, &mut on_delta)? {
                return finish_stream_text(label, &out);
            }
        }
    }
    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf);
        if line.trim_start().starts_with("data:") {
            saw_sse = true;
        }
        apply_sse_line(label, &line, &mut out, &mut on_delta)?;
    }
    if out.is_empty() && !saw_sse {
        if let Ok(value) = serde_json::from_str::<Value>(raw.trim()) {
            return chat_completion_text(label, &value);
        }
    }
    finish_stream_text(label, &out)
}

fn apply_sse_line(
    label: &str,
    line: &str,
    out: &mut String,
    on_delta: &mut impl FnMut(&str),
) -> Result<bool, AppError> {
    for event in parse_sse_line(line) {
        match event {
            SseEvent::Delta(delta) => {
                out.push_str(&delta);
                on_delta(&delta);
            }
            SseEvent::Finish(reason) => reject_incomplete_finish(Some(&reason), label)?,
            SseEvent::Upstream(message) => {
                return Err(AppError::message(format!(
                    "{label} upstream error: {message}"
                )));
            }
            SseEvent::Done => return Ok(true),
        }
    }
    Ok(false)
}

fn finish_stream_text(label: &str, out: &str) -> Result<String, AppError> {
    let out = out.trim().to_string();
    if out.is_empty() {
        return Err(AppError::message(format!("Unexpected {label} response")));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::translate::ERR_TRANSLATE_INCOMPLETE;

    #[test]
    fn sse_lines_yield_deltas_finish_and_done() {
        let line = r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#;
        assert_eq!(parse_sse_line(line), vec![SseEvent::Delta("你好".into())]);
        assert_eq!(parse_sse_line("data: [DONE]"), vec![SseEvent::Done]);
        assert!(parse_sse_line(r#"data: {"choices":[]}"#).is_empty());
        assert!(parse_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#).is_empty());
        assert!(parse_sse_line(": keep-alive").is_empty());
        assert_eq!(
            parse_sse_line(
                r#"data: {"choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}"#
            ),
            vec![
                SseEvent::Delta("x".into()),
                SseEvent::Finish("length".into())
            ]
        );
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[{"delta":{},"finish_reason":"filter"}]}"#),
            vec![SseEvent::Finish("filter".into())]
        );
        assert_eq!(
            parse_sse_line(r#"data: {"error":{"message":"overloaded"}}"#),
            vec![SseEvent::Upstream("overloaded".into())]
        );
    }

    #[test]
    fn truncated_completion_is_not_success() {
        let partial = serde_json::json!({
            "choices": [{
                "finish_reason": "length",
                "message": {"content": "只译了一半"}
            }]
        });
        let err = chat_completion_text("OpenAI-compatible", &partial).unwrap_err();
        assert_eq!(err.code(), ERR_TRANSLATE_INCOMPLETE);
        assert!(!err.to_string().contains("只译了一半"));

        let filtered = serde_json::json!({
            "choices": [{
                "finish_reason": "content_filter",
                "message": {"content": "blocked"}
            }]
        });
        assert_eq!(
            chat_completion_text("Index-Translate", &filtered)
                .unwrap_err()
                .code(),
            ERR_TRANSLATE_INCOMPLETE
        );

        let done = serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {"content": "完整译文"}
            }]
        });
        assert_eq!(
            chat_completion_text("OpenAI-compatible", &done).unwrap(),
            "完整译文"
        );
    }
}
