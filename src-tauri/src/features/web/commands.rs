//! Web viewer commands: remote-host allowlist and local HTML preview grants.

use crate::app::vault_session::VaultHolders;
use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult};
use crate::core::http::{self, BROWSER_USER_AGENT};
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebProxyAllowHostArgs {
    /// Public DNS host the viewer is about to load through the proxy.
    pub host: String,
}

/// Ensure `host` may be served by the `agentero-web` proxy before its viewer
/// frame loads.
///
/// Idempotent. Non-public hosts (IP literals, intranet names) are refused, so
/// the entry point itself cannot aim the proxy at link-local endpoints; the
/// caller learns that through `false` and can surface it before the frame
/// fails to load.
#[tauri::command]
#[specta::specta]
pub async fn web_proxy_allow_host(args: WebProxyAllowHostArgs) -> Result<ApiResult<bool>, String> {
    let host = super::allowlist::normalize_host(&args.host);
    let accepted = super::allowlist::is_public_dns_host(&host);
    if accepted {
        super::allowlist::allow_host(&host);
    } else {
        log::warn!(target: "agentero::web_proxy", "refused to allow non-public host: {host}");
    }
    Ok(ApiResult::ok(accepted))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebProxyResolveImageArgs {
    /// Permalink whose redirect / Content-Type may name a direct image asset
    /// (e.g. PLOS `/article/file?…&type=supplementary`).
    pub url: String,
}

/// Direct image URL the viewer may load through the proxy after allowlisting.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebProxyResolvedImage {
    pub url: String,
}

/// Path extension helpers shared with the unit tests below.
mod image_target {
    /// Inline `<img>` extensions (not TIFF/PDF).
    const INLINE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];
    const INLINE_TYPES: &[&str] = &[
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/avif",
        "image/bmp",
        "image/svg+xml",
    ];

    fn path_extension(path: &str) -> Option<&str> {
        let name = path.rsplit('/').next().unwrap_or(path);
        let (_, ext) = name.rsplit_once('.')?;
        if ext.is_empty() || name.starts_with('.') {
            return None;
        }
        Some(ext)
    }

    fn content_type_is_inline(content_type: Option<&str>) -> bool {
        let Some(raw) = content_type else {
            return false;
        };
        let mime = raw
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        INLINE_TYPES.iter().any(|t| *t == mime)
    }

    /// Pick a browser-decodable image URL from a HEAD response.
    ///
    /// 3xx → Location path extension must be an inline image (`.jpg`, not
    /// `.tif`/`.pdf`). 200 → Content-Type must be an inline image MIME; then
    /// keep `request_url`.
    pub fn pick_inline_image_target(
        request_url: &str,
        status: u16,
        location: Option<&str>,
        content_type: Option<&str>,
    ) -> Option<String> {
        if (300..400).contains(&status) {
            let loc = location?.trim();
            if loc.is_empty() {
                return None;
            }
            let url = url::Url::parse(loc).ok()?;
            let ext = path_extension(url.path())?.to_ascii_lowercase();
            if INLINE_EXTS.iter().any(|e| *e == ext) {
                return Some(loc.to_string());
            }
            return None;
        }
        if status == 200 && content_type_is_inline(content_type) {
            return Some(request_url.to_string());
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn jpeg_redirect_location_is_accepted() {
            let loc = "https://corpus-prod.example.r2.cloudflarestorage.com/10.1371/journal.pone.0118771/1/pone.0118771.s001.jpg?X-Amz-Signature=1";
            assert_eq!(
                pick_inline_image_target(
                    "https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0118771.s001&type=supplementary",
                    302,
                    Some(loc),
                    None,
                )
                .as_deref(),
                Some(loc)
            );
        }

        #[test]
        fn tiff_and_pdf_redirects_are_rejected() {
            assert!(pick_inline_image_target(
                "https://journals.plos.org/plosone/article/file?id=x.s001&type=supplementary",
                302,
                Some("https://corpus.example/pone.0222160.s001.tif?sig=1"),
                None,
            )
            .is_none());
            assert!(pick_inline_image_target(
                "https://journals.plos.org/plosone/article/file?id=x.s001&type=supplementary",
                302,
                Some("https://corpus.example/pone.0222160.s001.pdf"),
                None,
            )
            .is_none());
        }

        #[test]
        fn direct_200_jpeg_keeps_request_url() {
            let url = "https://cdn.example.org/fig.jpg";
            assert_eq!(
                pick_inline_image_target(url, 200, None, Some("image/jpeg")).as_deref(),
                Some(url)
            );
        }
    }
}

/// HEAD `url` without following redirects. When the response names an
/// inline-decodable image (Location `.jpg`/`.png`/… or Content-Type), allowlist
/// that host and return the direct URL for the proxy `<img>` path. TIFF/PDF
/// and unknown targets return `null` so the card stays on the URL tip.
///
/// Page JS cannot do this: PLOS has no CORS and opaque-redirects hide Location.
/// The proxy also refuses un-allowlisted redirect hops, so the card must point
/// at the corpus URL after this command allowlists it (same idea as eLife's
/// direct CDN rewrite).
#[tauri::command]
#[specta::specta]
pub async fn web_proxy_resolve_image(
    args: WebProxyResolveImageArgs,
) -> Result<ApiResult<Option<WebProxyResolvedImage>>, String> {
    let raw = args.url.trim().to_string();
    let parsed = match url::Url::parse(&raw) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => url,
        _ => {
            return Ok(ApiResult::ok(None));
        }
    };
    let Some(start_host) = parsed.host_str().map(str::to_string) else {
        return Ok(ApiResult::ok(None));
    };
    if !super::allowlist::is_public_dns_host(&start_host) {
        log::warn!(
            target: "agentero::web_proxy",
            "refused image resolve for non-public host: {start_host}"
        );
        return Ok(ApiResult::ok(None));
    }
    super::allowlist::allow_host(&start_host);

    let client = match http::client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(BROWSER_USER_AGENT)
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            log::warn!(target: "agentero::web_proxy", "image resolve client build failed: {err}");
            return Ok(ApiResult::ok(None));
        }
    };

    let response = match client.head(parsed.clone()).send().await {
        Ok(response) => response,
        Err(err) => {
            log::warn!(target: "agentero::web_proxy", "image resolve HEAD failed: {err}");
            return Ok(ApiResult::ok(None));
        }
    };
    let status = response.status().as_u16();
    // Resolve relative Location against the request URL (PLOS uses absolute
    // corpus URLs today; keep the join for other publishers).
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|loc| {
            url::Url::parse(loc)
                .or_else(|_| parsed.join(loc))
                .ok()
                .map(|u| u.to_string())
        });
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let Some(target) = image_target::pick_inline_image_target(
        &raw,
        status,
        location.as_deref(),
        content_type.as_deref(),
    ) else {
        return Ok(ApiResult::ok(None));
    };

    if let Ok(target_url) = url::Url::parse(&target) {
        if let Some(host) = target_url.host_str() {
            if !super::allowlist::is_public_dns_host(host) {
                return Ok(ApiResult::ok(None));
            }
            super::allowlist::allow_host(host);
        }
    }

    Ok(ApiResult::ok(Some(WebProxyResolvedImage { url: target })))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewGrantArgs {
    /// Absolute path of the `.html` / `.htm` file to preview.
    pub path: String,
}

/// Token plus the file name used as the last segment of the preview URL.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewGrant {
    pub token: String,
    pub name: String,
}

/// Mint a preview token for one HTML file inside a vault this window holds.
///
/// The token names that file's directory. The `agentero-html` scheme serves
/// only paths under it. Closing the vault revokes the token.
#[tauri::command]
#[specta::specta]
pub async fn html_preview_grant(
    app: tauri::AppHandle,
    args: HtmlPreviewGrantArgs,
) -> Result<ApiResult<HtmlPreviewGrant>, String> {
    let roots = app.state::<VaultHolders>().vault_keys();
    let path = args.path;
    let prepared = run_blocking(move || match super::html_preview::prepare(&roots, &path) {
        Ok(prepared) => ApiResult::ok(PreparedWire {
            dir: prepared.dir.to_string_lossy().into_owned(),
            name: prepared.name,
        }),
        Err(err) => map_err(err),
    })
    .await;
    if !prepared.ok {
        return Ok(ApiResult {
            ok: false,
            data: None,
            error: prepared.error,
        });
    }
    let Some(wire) = prepared.data else {
        return Ok(map_err(crate::core::error::AppError::message(
            "html preview file is unreadable",
        )));
    };
    let token = app
        .state::<super::html_preview::HtmlPreviewGrants>()
        .insert(std::path::PathBuf::from(wire.dir));
    Ok(ApiResult::ok(HtmlPreviewGrant {
        token,
        name: wire.name,
    }))
}

#[derive(Serialize)]
struct PreparedWire {
    dir: String,
    name: String,
}
