use crate::error::AppError;
use crate::http;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub async fn translate_deeplx(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
) -> Result<String, AppError> {
    let client = http::client(timeout)?;
    let id = deeplx_request_id();
    let i_count = text.matches('i').count() as u128 + text.matches('I').count() as u128 + 1;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let timestamp = now_ms - (now_ms % i_count) + i_count;
    let mut body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "LMT_handle_texts",
        "id": id,
        "params": {
            "texts": [
                {
                    "text": text,
                    "requestAlternatives": 3,
                }
            ],
            "splitting": "newlines",
            "lang": {
                "source_lang_user_selected": deeplx_lang(source, true),
                "target_lang": deeplx_lang(target, false),
            },
            "timestamp": timestamp,
            "commonJobParams": {
                "wasSpoken": false,
                "transcribe_as": "",
            },
        },
    })
    .to_string();
    if (id + 5).is_multiple_of(29) || (id + 3).is_multiple_of(13) {
        body = body.replace("\"method\":\"", "\"method\" : \"");
    } else {
        body = body.replace("\"method\":\"", "\"method\": \"");
    }

    let resp = client
        .post("https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0&method=LMT_handle_jobs")
        .header("Accept", "*/*")
        .header("Authorization", "None")
        .header("Cache-Control", "no-cache")
        .header("Content-Type", "application/json")
        .header("DNT", "1")
        .header("Origin", "chrome-extension://cofdbpoegempjloogbagkncekinflcnj")
        .header("Pragma", "no-cache")
        .header("Referer", "https://www.deepl.com/")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "none")
        .header("Sec-GPC", "1")
        .header("User-Agent", "DeepLBrowserExtension/1.28.0 Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36")
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::message(format!("DeepLX request failed: {e}")))?;
    let (status, body) = super::read_body(resp).await?;
    if !status.is_success() {
        return Err(super::http_err(status, &body, "DeepLX"));
    }
    parse_translation_response(&body)
}

fn parse_translation_response(body: &str) -> Result<String, AppError> {
    let v: Value =
        serde_json::from_str(body).map_err(|e| AppError::message(format!("DeepLX parse: {e}")))?;
    if let Some(error) = v.get("error") {
        return Err(AppError::message(format!("DeepLX service error: {error}")));
    }
    let text = v
        .get("result")
        .and_then(|x| x.get("texts"))
        .and_then(|x| x.get(0))
        .and_then(|x| x.get("text"))
        .and_then(|x| x.as_str())
        .ok_or_else(|| AppError::message("Unexpected DeepLX translation response"))?;

    // Reject the known multilingual client-upgrade notice even in a success
    // payload, so it cannot win the abstract-translation race and be persisted
    // into NOTES.md.
    const UPGRADE_NOTICE: &str = "You're using an older version of DeepL. To continue using the app, please update to the latest version.";
    if text.trim_start().starts_with(UPGRADE_NOTICE) {
        return Err(AppError::message(
            "DeepLX returned an unsupported-client upgrade notice; use another translation provider",
        ));
    }

    Ok(text.to_string())
}

fn deeplx_request_id() -> u64 {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    8_300_000_001 + (now_ms % 99_999) * 1_000
}

fn deeplx_lang(code: &str, allow_auto: bool) -> String {
    if allow_auto && code == "auto" {
        return "AUTO".to_string();
    }
    let lower = code.to_ascii_lowercase();
    match lower.as_str() {
        "zh" | "zh-cn" | "zh-hans" | "zh-hk" | "zh-mo" | "zh-sg" | "zh-tw" => "ZH".to_string(),
        "pt-br" => "PT-BR".to_string(),
        "pt-pt" => "PT-PT".to_string(),
        _ => super::lang_base(code).to_ascii_uppercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_upgrade_notice_in_success_response() {
        let notice = "You're using an older version of DeepL. To continue using the app, please update to the latest version.\n\nSie verwenden eine ältere Version von DeepL. Bitte aktualisieren Sie die App, um sie weiterhin nutzen zu können.\n\n您正在使用旧版本的 DeepL。 如需继续使用该应用程序，请更新至最新版本。";
        for text in [notice.to_string(), format!("\n {notice}")] {
            let body = json!({
                "jsonrpc": "2.0",
                "result": { "texts": [{ "text": text }] }
            });
            let error = parse_translation_response(&body.to_string()).unwrap_err();
            assert!(error
                .to_string()
                .contains("unsupported-client upgrade notice"));
        }
    }

    #[test]
    fn accepts_translations_including_deepl_and_update_instructions() {
        for text in [
            "本文提出了一种机器人控制方法。",
            "Please update DeepL to the latest version.",
            "DeepL's older version translated this paragraph correctly.",
        ] {
            let body = json!({ "result": { "texts": [{ "text": text }] } });
            assert_eq!(parse_translation_response(&body.to_string()).unwrap(), text);
        }
    }

    #[test]
    fn rejects_json_rpc_errors_and_missing_translation() {
        let body = json!({ "error": { "code": 1042901, "message": "Too many requests" } });
        assert!(parse_translation_response(&body.to_string())
            .unwrap_err()
            .to_string()
            .contains("DeepLX service error"));
        assert!(parse_translation_response(r#"{"result":{"texts":[]}}"#).is_err());
    }

    #[tokio::test]
    async fn upgrade_notice_does_not_reach_imported_notes() {
        use crate::features::catalog::papers::PaperRecord;
        use crate::features::paper::import::{write_paper_shell_with_translation, NoteShellMode};
        use crate::features::translate::{free_mt_to_zh_with, TranslateTextResult};
        use std::fs;
        use tokio::sync::Notify;

        let vault = std::env::temp_dir().join(format!(
            "agentero-deeplx-notice-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&vault).unwrap();
        let mut meta = PaperRecord::local_pdf("test-paper".into(), "Test paper".into());
        meta.abstract_text = Some("We propose a robot control method.".into());
        // Reconstructed response using the notice observed in imported notes;
        // this fixture is not a captured response from a live DeepL request.
        let response = json!({ "result": { "texts": [{ "text":
            "You're using an older version of DeepL. To continue using the app, please update to the latest version.\n\n您正在使用旧版本的 DeepL。 如需继续使用该应用程序，请更新至最新版本。"
        }] } }).to_string();

        for fallback_succeeds in [true, false] {
            let deepl_finished = Notify::new();
            let write = write_paper_shell_with_translation(
                &vault,
                &vault,
                &meta,
                NoteShellMode::Standard,
                true,
                |text| {
                    free_mt_to_zh_with(text, |args| {
                        let response = &response;
                        let deepl_finished = &deepl_finished;
                        async move {
                            assert_eq!(args.text, "We propose a robot control method.");
                            let text = match args.provider.as_str() {
                                "deeplx" => {
                                    let result = parse_translation_response(response);
                                    deepl_finished.notify_one();
                                    result?
                                }
                                "tencenttransmart" => {
                                    // The fallback must finish after DeepLX, even on
                                    // fast machines; no wall-clock sleeps or network.
                                    deepl_finished.notified().await;
                                    if !fallback_succeeds {
                                        return Err(AppError::message("provider unavailable"));
                                    }
                                    "本文提出了一种机器人控制方法。".into()
                                }
                                "huoshanweb" => {
                                    return Err(AppError::message("provider unavailable"))
                                }
                                other => panic!("unexpected provider: {other}"),
                            };
                            Ok(TranslateTextResult {
                                text,
                                provider: args.provider,
                            })
                        }
                    })
                },
            );
            tokio::time::timeout(Duration::from_secs(5), write)
                .await
                .expect("translation race should finish after the fallback responds")
                .unwrap();

            let notes = fs::read_to_string(vault.join("NOTES.md")).unwrap();
            assert!(notes.contains("# Test paper\n"));
            assert!(!notes.contains("older version of DeepL"));
            assert!(!notes.contains("We propose a robot control method."));
            if fallback_succeeds {
                assert!(notes.contains("> 本文提出了一种机器人控制方法。"));
            } else {
                assert!(
                    !notes.contains("> "),
                    "omit the abstract when all providers fail"
                );
            }
        }
        fs::remove_dir_all(vault).unwrap();
    }
}
