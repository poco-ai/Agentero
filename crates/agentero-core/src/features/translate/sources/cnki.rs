//! CNKI translation assistant (dict.cnki.net), reverse-engineered from the
//! web frontend the same way zotero-pdf-translate drives it. Unofficial /
//! best-effort: Chinese↔English only, mainland-CN networks, captcha risk.

use crate::error::AppError;
use crate::http;
use aes::cipher::{BlockEncrypt, KeyInit};
use aes::Aes128;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::Value;
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use super::{http_err, lang_base, map_request_error, read_body};

/// Soft cap per CNKI request (characters); longer input is sentence-chunked.
const CNKI_MAX_CHARS: usize = 800;

/// Pause between chunks to stay under the rate-limit / captcha radar.
const CNKI_CHUNK_PAUSE: Duration = Duration::from_secs(2);

/// Extra attempts for a request the WAF dropped on the floor. CNKI's edge
/// silently RSTs requests that arrive without the `SF_cookie_97` clearance
/// cookie it hands out on the first reply (no HTTP status, just an empty
/// reply), so one transport failure means nothing — see [`cnki_client`].
const CNKI_SEND_RETRIES: u32 = 4;

/// Base backoff between send retries (linear: 0.5s, 1s, …).
const CNKI_RETRY_DELAY: Duration = Duration::from_millis(500);

/// Token TTL: the endpoint issues 5-minute tokens; refresh with margin.
const CNKI_TOKEN_TTL: Duration = Duration::from_secs(4 * 60);

struct CnkiTokenCache {
    token: String,
    exp: Instant,
}

static CNKI_TOKEN: Mutex<Option<CnkiTokenCache>> = Mutex::new(None);

/// Browser-UA client with a persistent cookie jar, cached process-wide.
///
/// dict.cnki.net's edge sets an `SF_cookie_97` clearance cookie on its first
/// successful reply and then RSTs roughly half of the requests that arrive
/// without it (no HTTP status — reqwest reports `error sending request for
/// url`). The reference zotero-pdf-translate plugin gets this for free because
/// Firefox carries cookies; a bare reqwest client does not, which is why even
/// a green probe was followed by flaky translations. A shared jar means only
/// the very first request of the process can be dropped — every later one
/// already carries the cookie. Keyed by proxy so a runtime proxy change
/// rebuilds it (cookies are then re-established on the next reply).
static CNKI_CLIENT: OnceLock<RwLock<Option<CachedCnkiClient>>> = OnceLock::new();

struct CachedCnkiClient {
    proxy: Option<String>,
    client: reqwest::Client,
}

/// Per-request timeout is applied on each `RequestBuilder` (not the client), so
/// the cached client can serve both the snappy Settings probe (5s) and normal
/// translations (up to 30s).
fn cnki_client() -> Result<reqwest::Client, AppError> {
    let proxy = http::effective_proxy_url();
    let slot = CNKI_CLIENT.get_or_init(|| RwLock::new(None));
    {
        let guard = slot
            .read()
            .map_err(|_| AppError::message("CNKI client lock poisoned"))?;
        if let Some(cached) = guard.as_ref() {
            if cached.proxy == proxy {
                return Ok(cached.client.clone());
            }
        }
    }
    let client = http::client_builder()
        .user_agent(http::BROWSER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(
            http::DEFAULT_REDIRECT_LIMIT,
        ))
        .cookie_store(true)
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;
    if let Ok(mut guard) = slot.write() {
        *guard = Some(CachedCnkiClient {
            proxy,
            client: client.clone(),
        });
    }
    Ok(client)
}

/// One sentence-bounded slice of the input, with the boundary kind needed to
/// join translated chunks back together (CJK punctuation joins with "",
/// Latin with a space).
struct CnkiChunk {
    text: String,
    cjk_boundary: bool,
}

/// Distinguish "the server rejected our token" (refetch + retry the chunk)
/// from every other failure.
enum CnkiError {
    StaleToken,
    Http(AppError),
}

impl From<AppError> for CnkiError {
    fn from(e: AppError) -> Self {
        CnkiError::Http(e)
    }
}

pub async fn translate_cnki(
    text: &str,
    _source: &str,
    target: &str,
    timeout: Duration,
) -> Result<String, AppError> {
    match lang_base(target).to_ascii_lowercase().as_str() {
        "zh" | "en" => {}
        _ => {
            return Err(AppError::message(
                "CNKI translates between Chinese and English only",
            ))
        }
    }

    let chunks = split_cnki_chunks(text);
    let client = cnki_client()?;
    let mut token = cnki_token(&client, timeout).await?;
    let mut parts: Vec<(String, bool)> = Vec::with_capacity(chunks.len());
    for (i, chunk) in chunks.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(CNKI_CHUNK_PAUSE).await;
        }
        // A 401 means the token died server-side; refetch once and retry the
        // same chunk instead of failing the whole translation.
        let mut refreshed_token = false;
        let translated = loop {
            match cnki_translate_chunk(&client, &chunk.text, &token, timeout).await {
                Ok(translated) => break translated,
                Err(CnkiError::StaleToken) if !refreshed_token => {
                    refreshed_token = true;
                    if let Ok(mut guard) = CNKI_TOKEN.lock() {
                        *guard = None;
                    }
                    tokio::time::sleep(CNKI_RETRY_DELAY).await;
                    token = cnki_token(&client, timeout).await?;
                }
                Err(CnkiError::StaleToken) => {
                    return Err(AppError::message("CNKI rejected a fresh token (code 401)"))
                }
                Err(CnkiError::Http(e)) => {
                    // Drop the cached token so a retry starts fresh.
                    if let Ok(mut guard) = CNKI_TOKEN.lock() {
                        *guard = None;
                    }
                    return Err(e);
                }
            }
        };
        parts.push((translated, chunk.cjk_boundary));
    }
    let mut out = String::new();
    for (part, cjk_boundary) in parts {
        out.push_str(&part);
        if !cjk_boundary {
            out.push(' ');
        }
    }
    Ok(out.trim_end().to_string())
}

/// Send with linear-backoff retries: the WAF drops a share of requests with
/// an empty reply (no HTTP status) once an IP heats up, so transport failures
/// are expected noise, not verdicts.
async fn cnki_send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, AppError> {
    let mut last_err = String::new();
    for attempt in 0..=CNKI_SEND_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(CNKI_RETRY_DELAY * attempt).await;
        }
        let Some(call) = request.try_clone() else {
            return Err(AppError::message("CNKI request body is not retryable"));
        };
        match call.send().await {
            Ok(resp) => return Ok(resp),
            Err(e) if e.is_timeout() => return Err(map_request_error("CNKI", e)),
            Err(e) => last_err = describe_reqwest_error(&e),
        }
    }
    Err(AppError::message(format!(
        "CNKI request failed after {CNKI_SEND_RETRIES} retries: {last_err}"
    )))
}

/// Render a reqwest error with its full source chain. reqwest's own `Display`
/// ends at "error sending request for url (...)", hiding the actual cause
/// (DNS failure, connection reset by the WAF, TLS error, timeout). Without
/// the chain every transport failure looks identical and undiagnosable.
fn describe_reqwest_error(err: &reqwest::Error) -> String {
    let mut out = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        let text = cause.to_string();
        if !text.is_empty() && !out.contains(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        source = cause.source();
    }
    out
}

async fn cnki_translate_chunk(
    client: &reqwest::Client,
    chunk: &str,
    token: &str,
    timeout: Duration,
) -> Result<String, CnkiError> {
    let words = cnki_encrypt_words(chunk)?;
    let resp = cnki_send(
        client
            .post("https://dict.cnki.net/fyzs-front-api/translate/literaltranslation")
            .timeout(timeout)
            .header("Content-Type", "application/json;charset=UTF-8")
            .header("Token", token)
            .json(&serde_json::json!({ "words": words, "translateType": null })),
    )
    .await
    .map_err(CnkiError::Http)?;
    let (status, body) = read_body(resp).await.map_err(CnkiError::Http)?;
    if !status.is_success() {
        let mut err = http_err(status, &body, "CNKI");
        if status.as_u16() == 404 {
            err = AppError::message(format!(
                "{err} — CNKI is reachable from mainland-China networks; overseas IPs are often rejected"
            ));
        }
        return Err(CnkiError::Http(err));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("CNKI parse: {e}")))
        .map_err(CnkiError::Http)?;
    let code = v.get("code").and_then(Value::as_i64);
    if code == Some(401) {
        return Err(CnkiError::StaleToken);
    }
    // The captcha wall shows up two ways: an explicit `isInputVerificationCode`
    // on an otherwise-normal reply, or a `code:1004` ("检索过于频繁，需输入验证码")
    // that carries the captcha image.
    let needs_captcha = v
        .pointer("/data/isInputVerificationCode")
        .and_then(Value::as_bool)
        == Some(true)
        || code == Some(1004);
    if needs_captcha {
        return Err(CnkiError::Http(AppError::message(
            "CNKI requires human verification (temporarily banned). Open https://dict.cnki.net/ and pass the captcha, then retry.",
        )));
    }
    v.pointer("/data/mResult")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::message("Unexpected CNKI translation response"))
        .map_err(CnkiError::Http)
}

async fn cnki_token(client: &reqwest::Client, timeout: Duration) -> Result<String, AppError> {
    {
        let guard = CNKI_TOKEN.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = guard.as_ref() {
            if Instant::now() < c.exp {
                return Ok(c.token.clone());
            }
        }
    }
    let resp = cnki_send(
        client
            .get("https://dict.cnki.net/fyzs-front-api/getToken")
            .timeout(timeout),
    )
    .await?;
    let (status, body) = read_body(resp).await?;
    if !status.is_success() {
        return Err(http_err(status, &body, "CNKI token"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("CNKI token parse: {e}")))?;
    // The endpoint answers {data} while older mirrors answer {token}.
    let token = v
        .get("data")
        .and_then(Value::as_str)
        .or_else(|| v.get("token").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    if token.is_empty() {
        return Err(AppError::message("CNKI token empty"));
    }
    // Concurrent first calls may each fetch once (no lock held across await);
    // harmless — last write wins.
    if let Ok(mut guard) = CNKI_TOKEN.lock() {
        *guard = Some(CnkiTokenCache {
            exp: Instant::now() + CNKI_TOKEN_TTL,
            token: token.clone(),
        });
    }
    Ok(token)
}

/// AES-128-ECB PKCS7, base64 with URL-safe-ish replacements (CNKI scheme).
fn cnki_encrypt_words(text: &str) -> Result<String, AppError> {
    const KEY: &[u8; 16] = b"4e87183cfd3a45fe";
    let cipher =
        Aes128::new_from_slice(KEY).map_err(|e| AppError::message(format!("CNKI AES key: {e}")))?;
    let mut buf = text.as_bytes().to_vec();
    let pad = 16 - (buf.len() % 16);
    buf.extend(std::iter::repeat_n(pad as u8, pad));
    for chunk in buf.as_chunks_mut::<16>().0 {
        let block = aes::Block::from_mut_slice(&mut chunk[..]);
        cipher.encrypt_block(block);
    }
    let b64 = B64.encode(&buf);
    Ok(b64.replace('/', "_").replace('+', "-"))
}

/// Is `c` a CJK sentence-final punctuation (always a split point)?
fn is_cjk_punct(c: char) -> bool {
    matches!(c, '。' | '！' | '？' | '；' | '…')
}

/// Split into sentence-bounded chunks of at most [`CNKI_MAX_CHARS`] chars.
///
/// CJK punctuation always ends a sentence; ASCII `.!?;` only when followed by
/// whitespace or end-of-input (keeps `3.14` and `Fig. 1` intact). A single
/// punctuation-free sentence longer than the cap is hard-split. Whitespace
/// after a split point belongs to the next sentence.
fn split_cnki_chunks(text: &str) -> Vec<CnkiChunk> {
    let chars: Vec<char> = text.chars().collect();
    let mut sentences: Vec<String> = Vec::new();
    let mut current = String::new();
    for (i, &c) in chars.iter().enumerate() {
        current.push(c);
        let boundary = if is_cjk_punct(c) {
            true
        } else if matches!(c, '.' | '!' | '?' | ';') {
            chars.get(i + 1).is_none_or(|w| w.is_whitespace())
        } else {
            false
        };
        if boundary {
            sentences.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        sentences.push(current);
    }

    let mut chunks: Vec<CnkiChunk> = Vec::new();
    let mut pending = String::new();
    for sentence in sentences {
        let s_len = sentence.chars().count();
        if s_len > CNKI_MAX_CHARS {
            // Punctuation-free run (URLs, hashes…): hard-split, no loss.
            if !pending.is_empty() {
                chunks.push(finish_chunk(std::mem::take(&mut pending)));
            }
            for piece in sentence.chars().collect::<Vec<_>>().chunks(CNKI_MAX_CHARS) {
                chunks.push(finish_chunk(piece.iter().collect()));
            }
            continue;
        }
        if !pending.is_empty() && pending.chars().count() + s_len > CNKI_MAX_CHARS {
            chunks.push(finish_chunk(std::mem::take(&mut pending)));
        }
        pending.push_str(&sentence);
    }
    if !pending.is_empty() {
        chunks.push(finish_chunk(pending));
    }
    chunks
}

fn finish_chunk(text: String) -> CnkiChunk {
    let cjk_boundary = text.chars().next_back().is_some_and(is_cjk_punct);
    CnkiChunk { text, cjk_boundary }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockDecrypt;

    /// Pinned vector generated independently with
    /// `echo -n "agentero" | openssl enc -aes-128-ecb -K <key-hex> | base64` —
    /// guards the key, PKCS7 padding, and base64 alphabet all at once.
    #[test]
    fn encrypt_known_vector() {
        let out = cnki_encrypt_words("agentero").unwrap();
        assert_eq!(out, "6Y2hoeHwsh4XN47UPPzBMg==");
        assert!(!out.contains('/') && !out.contains('+'));
    }

    #[test]
    fn encrypt_roundtrip() {
        fn decrypt(words: &str) -> String {
            let b64 = words.replace('_', "/").replace('-', "+");
            let mut buf = B64.decode(b64).unwrap();
            let cipher = Aes128::new_from_slice(b"4e87183cfd3a45fe").unwrap();
            for chunk in buf.as_chunks_mut::<16>().0 {
                cipher.decrypt_block(aes::Block::from_mut_slice(&mut chunk[..]));
            }
            let pad = *buf.last().unwrap() as usize;
            buf.truncate(buf.len() - pad);
            String::from_utf8(buf).unwrap()
        }
        // Multi-byte CJK + an exact 16-byte input (full PKCS7 block padding).
        let cjk = "知识网络翻译助手。";
        let exact = "0123456789abcdef";
        for input in [cjk, exact, "mixed 中英 text with punctuation!"] {
            assert_eq!(decrypt(&cnki_encrypt_words(input).unwrap()), input);
        }
    }

    #[test]
    fn split_short_passthrough() {
        let chunks = split_cnki_chunks("Hello world. 你好世界。");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "Hello world. 你好世界。");
        assert!(chunks[0].cjk_boundary);
    }

    #[test]
    fn split_english_sentences() {
        let sentence = "The quick brown fox jumps over the lazy dog. ";
        let text = sentence.repeat(30).trim_end().to_string(); // ~1350 chars → 2 chunks
        let chunks = split_cnki_chunks(&text);
        assert!(chunks.len() >= 2);
        for c in &chunks {
            assert!(c.text.chars().count() <= CNKI_MAX_CHARS);
            assert!(!c.cjk_boundary);
            assert!(c.text.ends_with("."));
        }
        assert_eq!(
            chunks.iter().map(|c| c.text.clone()).collect::<String>(),
            text
        );
    }

    #[test]
    fn split_chinese_sentences() {
        let text = "这是第一个句子。这是第二个句子！".repeat(60);
        let chunks = split_cnki_chunks(&text);
        assert!(chunks.len() >= 2);
        for c in &chunks {
            assert!(c.text.chars().count() <= CNKI_MAX_CHARS);
            assert!(c.cjk_boundary);
        }
    }

    #[test]
    fn split_decimal_not_cut() {
        let chunks = split_cnki_chunks("Pi is 3.14 and see Fig. 1 for details.");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "Pi is 3.14 and see Fig. 1 for details.");
    }

    #[test]
    fn split_overlong_sentence() {
        let text = "x".repeat(2 * CNKI_MAX_CHARS + 5); // no punctuation at all
        let chunks = split_cnki_chunks(&text);
        assert_eq!(chunks.len(), 3);
        assert_eq!(
            chunks.iter().map(|c| c.text.clone()).collect::<String>(),
            text
        );
    }
}
