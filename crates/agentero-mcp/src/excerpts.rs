//! Proof that this listener issued a particular bounded citation to this reader.
use agentero_core::error::AppError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{digest, hmac};
use serde_json::Value;

#[derive(Clone)]
pub(crate) struct ExcerptKey(hmac::Key);

impl ExcerptKey {
    pub fn new() -> Self {
        Self(hmac::Key::new(
            hmac::HMAC_SHA256,
            uuid::Uuid::new_v4().as_bytes(),
        ))
    }

    pub fn seal_cards(&self, result: &mut Value) -> Result<(), AppError> {
        for card in result["items"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .filter(|item| item["kind"] == "body")
        {
            let locator = &card["locator"];
            let span = locator["char_from"]
                .as_u64()
                .zip(locator["char_to"].as_u64());
            let len = card["excerpt"].as_str().map(|s| s.chars().count() as u64);
            if !span.is_some_and(|(start, end)| {
                end.checked_sub(start)
                    .is_some_and(|n| n <= 260 && Some(n) == len)
            }) {
                return Err(AppError::domain(
                    "invalid_result",
                    "Body evidence must identify the exact bounded excerpt",
                ));
            }
            let cite = card["cite"]
                .as_str()
                .ok_or_else(|| AppError::domain("invalid_result", "Missing citation"))?;
            let digest = digest::digest(
                &digest::SHA256,
                card["excerpt"].as_str().unwrap().as_bytes(),
            );
            let fingerprint = URL_SAFE_NO_PAD.encode(digest);
            let binding = format!("{cite}#excerpt={fingerprint}");
            let tag = hmac::sign(&self.0, binding.as_bytes());
            card["cite"] = Value::String(format!("{binding}.{}", URL_SAFE_NO_PAD.encode(tag)));
        }
        Ok(())
    }

    pub fn verified(&self, cite: &str) -> Option<Vec<u8>> {
        let (binding, mac) = cite.rsplit_once('.')?;
        let (_, fingerprint) = binding.split_once("#excerpt=")?;
        if mac.len() != 43 || fingerprint.len() != 43 {
            return None;
        }
        let tag = URL_SAFE_NO_PAD.decode(mac).ok()?;
        hmac::verify(&self.0, binding.as_bytes(), &tag).ok()?;
        URL_SAFE_NO_PAD.decode(fingerprint).ok()
    }

    pub fn authorize_read(&self, args: &Value) -> Result<Option<(String, Vec<u8>)>, AppError> {
        let Some((cite, fingerprint)) = args["source"]
            .as_str()
            .and_then(|s| self.verified(s).map(|sum| (s, sum)))
        else {
            return Ok(None);
        };
        if ["pages", "region", "section", "lines", "quote"]
            .iter()
            .any(|k| args.get(k).is_some())
        {
            return Err(AppError::domain(
                "usage",
                "A citation already identifies its location",
            ));
        }
        if !args.as_object().is_some_and(|o| {
            o.keys()
                .all(|k| matches!(k.as_str(), "source" | "max_chars"))
        }) {
            return Err(AppError::domain(
                "full_text_required",
                "An excerpt receipt covers only its issued passage",
            ));
        }
        Ok(Some((cite.to_owned(), fingerprint)))
    }
}
