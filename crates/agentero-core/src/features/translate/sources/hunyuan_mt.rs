//! Built-in Agentero translation via a dedicated MT model (`Hunyuan-MT`).

use crate::error::AppError;
use crate::http;
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize)]
struct HunyuanMtMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct HunyuanMtRequest<'a> {
    model: &'a str,
    messages: [HunyuanMtMessage<'a>; 1],
    temperature: f32,
}

/// Same sampling as the OpenAI-compatible path: 0.0 reads too literally, the
/// technical report specifies no decoding parameters.
const HUNYUAN_MT_TEMPERATURE: f32 = 0.2;

/// Segments of a batched payload translated at once (mirrors `PAGE_CONCURRENCY`
/// in the VLM OCR engine).
const SEGMENT_CONCURRENCY: usize = 3;

/// `Hunyuan-MT` is a dedicated MT model, not an instruct model: it only follows
/// the template it was tuned on, so the `openai_compatible` rule block (and its
/// system message) would be ignored or echoed back.
fn hunyuan_mt_prompt(text: &str, target: &str) -> String {
    format!("Translate the following segment into {target}, without additional explanation.{text}")
}

/// Target slot of the template: the English language name.
///
/// Only the values the UI can actually send are mapped (`en` / `zh-CN`; `"ui"`
/// is resolved frontend-side before the IPC call).
fn hunyuan_target_name(target: &str) -> &'static str {
    match target.trim().to_ascii_lowercase().as_str() {
        "zh" | "zh-cn" | "chinese" => "Chinese",
        "en" | "english" | "ui" => "English",
        other => {
            log::debug!(target: "agentero::translate", "Hunyuan-MT: unmapped target {other:?}, using English");
            "English"
        }
    }
}

/// One piece of a `[[n]]`-batched payload. `marker` is `None` for text that
/// precedes the first marker (never produced by the batch builder, but kept so
/// prose is never swallowed).
#[derive(Debug, PartialEq, Eq)]
struct Segment {
    marker: Option<usize>,
    text: String,
}

/// Parse an ASCII `[[ n ]]` marker at `start`; returns `(n, offset past it)`.
fn parse_marker(bytes: &[u8], start: usize) -> Option<(usize, usize)> {
    if bytes.get(start..start.checked_add(2)?) != Some(b"[[".as_slice()) {
        return None;
    }
    let mut i = start + 2;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    let digits_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == digits_start {
        return None;
    }
    let n = std::str::from_utf8(&bytes[digits_start..i])
        .ok()?
        .parse::<usize>()
        .ok()?;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if bytes.get(i..i.checked_add(2)?) != Some(b"]]".as_slice()) {
        return None;
    }
    Some((n, i + 2))
}

/// Split a batched payload into per-sentence segments.
///
/// The MT model is never shown a `[[n]]` marker: batch alignment depends on
/// instruction-following, which this model does not do. Markers must start at 1
/// and ascend at line starts; the first mid-line or out-of-order marker ends the
/// scan, so prose containing a literal `[[1]]` is translated as one piece.
fn split_numbered_payload(text: &str) -> Vec<Segment> {
    let bytes = text.as_bytes();
    // (marker, marker start, body start)
    let mut cuts: Vec<(usize, usize, usize)> = Vec::new();
    let mut expected = 1usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        let Some((n, body)) = parse_marker(bytes, i) else {
            i += 1;
            continue;
        };
        let at_line_start = i == 0 || bytes[i - 1] == b'\n';
        if !at_line_start || n != expected {
            break;
        }
        cuts.push((n, i, body));
        expected += 1;
        i = body;
    }

    if cuts.is_empty() {
        return segments_from([Segment {
            marker: None,
            text: text.to_string(),
        }]);
    }

    let mut out = Vec::with_capacity(cuts.len() + 1);
    out.push(Segment {
        marker: None,
        text: text[..cuts[0].1].to_string(),
    });
    for (index, &(marker, _, body)) in cuts.iter().enumerate() {
        let end = cuts.get(index + 1).map_or(text.len(), |next| next.1);
        out.push(Segment {
            marker: Some(marker),
            text: text[body..end].to_string(),
        });
    }
    segments_from(out)
}

/// Trim every segment and drop the empty ones: fewer segments than the caller
/// expects makes the frontend fall back to per-paragraph translation instead of
/// mis-aligning paragraphs.
fn segments_from(raw: impl IntoIterator<Item = Segment>) -> Vec<Segment> {
    raw.into_iter()
        .map(|segment| Segment {
            marker: segment.marker,
            text: segment.text.trim().to_string(),
        })
        .filter(|segment| !segment.text.is_empty())
        .collect()
}

/// Byte-identical to the frontend's `buildNumberedPayload` output.
fn join_segments(segments: &[Segment]) -> String {
    segments
        .iter()
        .map(|segment| match segment.marker {
            Some(marker) => format!("[[{marker}]] {}", segment.text),
            None => segment.text.clone(),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub async fn translate_hunyuan_mt(
    text: &str,
    target: &str,
    timeout: Duration,
    api_key: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
) -> Result<String, AppError> {
    let key = super::required_api_key("Agentero built-in", api_key)?;
    let model = model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::message("Agentero built-in translation has no model"))?;
    // The gateway is a build-time Host value; core has no default endpoint.
    let base = base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::message("Agentero built-in translation has no base URL"))?;
    let url = super::optional_endpoint(Some(base), base, "/chat/completions");
    let target = hunyuan_target_name(target);

    // `⟦n⟧` inline placeholders (frontend-masked math/URLs/citations) are passed
    // through untouched; assumed the MT model leaves them alone, unverified
    // without a live key.
    let segments = split_numbered_payload(text);
    if segments.is_empty() {
        return Err(AppError::message("Empty text"));
    }

    let client = http::client(timeout)?;
    let mut requests = Vec::with_capacity(segments.len());
    for segment in &segments {
        requests.push(request_segment(
            &client,
            &url,
            key,
            model,
            hunyuan_mt_prompt(&segment.text, target),
        ));
    }
    // `buffered` keeps the result order, so no index plumbing is needed.
    let results: Vec<Result<String, AppError>> = stream::iter(requests)
        .buffered(SEGMENT_CONCURRENCY)
        .collect()
        .await;

    let mut translated: Vec<Segment> = Vec::with_capacity(segments.len());
    for (segment, result) in segments.iter().zip(results) {
        translated.push(Segment {
            marker: segment.marker,
            text: result?.trim().to_string(),
        });
    }
    Ok(join_segments(&segments_from(translated)))
}

async fn request_segment(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    model: &str,
    prompt: String,
) -> Result<String, AppError> {
    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&HunyuanMtRequest {
            model,
            messages: [HunyuanMtMessage {
                role: "user",
                content: &prompt,
            }],
            temperature: HUNYUAN_MT_TEMPERATURE,
        })
        .send()
        .await
        .map_err(|e| super::map_request_error("Agentero built-in", e))?;
    let (status, body) = super::read_body(resp).await?;
    if !status.is_success() {
        return Err(super::http_err(status, &body, "Agentero built-in"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("Agentero built-in parse: {e}")))?;
    let choice = v
        .get("choices")
        .and_then(|x| x.get(0))
        .ok_or_else(|| AppError::message("Unexpected Agentero built-in response"))?;
    super::reject_incomplete_finish(
        choice.get("finish_reason").and_then(|x| x.as_str()),
        "Agentero built-in",
    )?;
    choice
        .get("message")
        .and_then(|x| x.get("content"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::message("Unexpected Agentero built-in response"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_is_the_literal_mt_template() {
        assert_eq!(
            hunyuan_mt_prompt("Hello world", "Chinese"),
            "Translate the following segment into Chinese, without additional explanation.Hello world"
        );
    }

    #[test]
    fn maps_reachable_targets_and_falls_back_to_english() {
        assert_eq!(hunyuan_target_name("zh-CN"), "Chinese");
        assert_eq!(hunyuan_target_name("zh"), "Chinese");
        assert_eq!(hunyuan_target_name("Chinese"), "Chinese");
        assert_eq!(hunyuan_target_name("en"), "English");
        assert_eq!(hunyuan_target_name("EN"), "English");
        assert_eq!(hunyuan_target_name("ui"), "English");
        assert_eq!(hunyuan_target_name("auto"), "English");
        assert_eq!(hunyuan_target_name("fr"), "English");
        assert_eq!(hunyuan_target_name("  "), "English");
    }

    #[test]
    fn splits_and_rejoins_a_numbered_batch_byte_identically() {
        let payload = "[[1]] First paragraph.\n\n[[2]] Second with ⟦0⟧ and ⟦1⟧.\n\n[[3]] Third.";
        let segments = split_numbered_payload(payload);
        assert_eq!(
            segments,
            vec![
                Segment {
                    marker: Some(1),
                    text: "First paragraph.".into()
                },
                Segment {
                    marker: Some(2),
                    text: "Second with ⟦0⟧ and ⟦1⟧.".into()
                },
                Segment {
                    marker: Some(3),
                    text: "Third.".into()
                },
            ]
        );
        assert_eq!(join_segments(&segments), payload);
    }

    #[test]
    fn unnumbered_text_is_one_segment() {
        let segments = split_numbered_payload("Just prose about [[attention]].");
        assert_eq!(
            segments,
            vec![Segment {
                marker: None,
                text: "Just prose about [[attention]].".into()
            }]
        );
        assert_eq!(join_segments(&segments), "Just prose about [[attention]].");
    }

    #[test]
    fn mid_line_and_out_of_order_markers_end_the_scan() {
        // A mid-line marker would split prose; it must not.
        assert_eq!(
            split_numbered_payload("See [[1]] for details.\n\nMore.").len(),
            1
        );
        // Markers must ascend from 1.
        assert_eq!(split_numbered_payload("[[2]] a\n\n[[1]] b").len(), 1);
        // A repeated marker ends the scan at the first violation; the rest of
        // the text stays inside the current segment.
        let segments = split_numbered_payload("[[1]] a\n\n[[1]] b");
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].marker, Some(1));
        assert_eq!(segments[0].text, "a\n\n[[1]] b");
    }

    #[test]
    fn keeps_leading_text_and_drops_empty_segments() {
        let segments = split_numbered_payload("Preface line.\n[[1]] a\n\n[[2]]   \n\n[[3]] c");
        assert_eq!(
            segments,
            vec![
                Segment {
                    marker: None,
                    text: "Preface line.".into()
                },
                Segment {
                    marker: Some(1),
                    text: "a".into()
                },
                Segment {
                    marker: Some(3),
                    text: "c".into()
                },
            ]
        );
        assert_eq!(
            join_segments(&segments),
            "Preface line.\n\n[[1]] a\n\n[[3]] c"
        );
    }

    #[test]
    fn accepts_padded_markers() {
        let segments = split_numbered_payload("[[ 1 ]] a\n\n[[2 ]] b");
        assert_eq!(segments.len(), 2);
        assert_eq!(join_segments(&segments), "[[1]] a\n\n[[2]] b");
    }
}
