//! PDF probe and gateway PDF fetch: the first hop often lands on the proxied
//! publisher page rather than the PDF itself, so an HTML response is mined for
//! direct PDF links and retried (bounded).

use super::detect::resolve_institution_proxy_kind;
use super::kind::{institution_proxy, InstitutionProxyConf, InstitutionProxyKind};
use super::rewrite::{ezproxy_rewrite, is_subdomain_mapped, subdomain_rewrite, wengine_rewrite};
use super::session::{fetch_bytes_checked_with_url, fetch_bytes_checked_with_url_seeded};

/// Result of the paywalled-PDF fallback. The caller owns file persistence.
#[derive(Debug, Default)]
pub struct ProxyPdfOutcome {
    pub bytes: Option<Vec<u8>>,
    /// Rewritten URL that produced the bytes.
    pub source: Option<String>,
    pub messages: Vec<String>,
}

/// Try to fetch a paywalled PDF through the configured gateway (or a direct
/// connection when none is configured). Uses the user's own institution
/// subscription and session cookie.
pub async fn fetch_pdf(doi: &str) -> ProxyPdfOutcome {
    let mut out = ProxyPdfOutcome::default();
    let mut conf = institution_proxy().unwrap_or_else(InstitutionProxyConf::direct);
    if conf.kind == InstitutionProxyKind::Auto {
        let Some(kind) =
            resolve_institution_proxy_kind(conf.kind, &conf.prefix, &conf.cookie).await
        else {
            out.messages
                .push("institution proxy: could not detect the gateway type".into());
            return out;
        };
        conf.kind = kind;
        // `set_institution_proxy` only appends the EZProxy query form for an
        // explicit kind; a detected one needs the same normalization.
        if kind == InstitutionProxyKind::EzProxy && !conf.prefix.contains('?') {
            conf.prefix.push_str("/login?url=");
        }
    }
    let proxy_origin = conf
        .prefix
        .split("/login?url=")
        .next()
        .unwrap_or(&conf.prefix)
        .to_string();
    let mut targets = vec![format!("https://doi.org/{doi}")];

    for _hop in 0..2 {
        let mut next_targets: Vec<String> = Vec::new();
        for target in &targets {
            let rewritten = match conf.kind {
                InstitutionProxyKind::Direct => target.clone(),
                InstitutionProxyKind::Auto => unreachable!("Auto is resolved above"),
                InstitutionProxyKind::EzProxy => ezproxy_rewrite(&conf.prefix, target),
                InstitutionProxyKind::Wengine => {
                    if target.starts_with(&proxy_origin) {
                        // Already a gateway-shaped URL (mined from a landed
                        // page); rewriting it again would re-encode the host.
                        target.clone()
                    } else {
                        match wengine_rewrite(&proxy_origin, target) {
                            Some(url) => url,
                            None => continue,
                        }
                    }
                }
                InstitutionProxyKind::Subdomain => {
                    if is_subdomain_mapped(target, &proxy_origin) {
                        target.clone()
                    } else {
                        match subdomain_rewrite(&proxy_origin, target) {
                            Some(url) => url,
                            None => continue,
                        }
                    }
                }
            };
            let fetch = if conf.kind == InstitutionProxyKind::Subdomain {
                fetch_bytes_checked_with_url_seeded(
                    &rewritten,
                    &conf.cookie,
                    &[proxy_origin.as_str(), rewritten.as_str()],
                )
                .await
            } else {
                fetch_bytes_checked_with_url(&rewritten, &conf.cookie).await
            };
            match fetch {
                Ok((bytes, final_url)) => {
                    if bytes.len() >= 4 && &bytes[..4] == b"%PDF" {
                        out.bytes = Some(bytes);
                        out.source = Some(rewritten);
                        return out;
                    }
                    if let Ok(html) = String::from_utf8(bytes) {
                        // Resolve relative PDF links against the landed page:
                        // for wengine that is /https/{enc-host}/..., not the
                        // bare gateway origin.
                        let link_base = match conf.kind {
                            InstitutionProxyKind::Direct => final_url
                                .split("://")
                                .take(2)
                                .last()
                                .and_then(|rest| rest.split('/').next())
                                .map(|host| {
                                    format!(
                                        "://{}",
                                        if final_url.starts_with("http://") {
                                            format!("http://{host}")
                                        } else {
                                            format!("https://{host}")
                                        }
                                    )
                                })
                                .map(|full| {
                                    full.replacen("://https", "https", 1)
                                        .replacen("://http", "http", 1)
                                })
                                .unwrap_or_else(|| proxy_origin.clone()),
                            InstitutionProxyKind::Wengine | InstitutionProxyKind::Subdomain => {
                                // Path-preserving gateways: relative links
                                // resolve against the landed page directory
                                // (wengine keeps the `/https/{enc-host}/`
                                // prefix, subdomain keeps the mapped host).
                                let mut base = final_url.clone();
                                while base.ends_with('/') {
                                    base.pop();
                                }
                                match base.rfind('/') {
                                    Some(i) => base[..i].to_string(),
                                    None => proxy_origin.clone(),
                                }
                            }
                            InstitutionProxyKind::EzProxy => proxy_origin.clone(),
                            InstitutionProxyKind::Auto => {
                                unreachable!("Auto is resolved before link resolution")
                            }
                        };
                        let mut mined = pdf_links_from_html(&html, &link_base, &proxy_origin);
                        // Prefer article-body PDFs (/articles/{id}.pdf) over
                        // supplementary material (MediaObjects/ESM).
                        mined.sort_by_key(|l| !(l.contains("/articles/") && l.ends_with(".pdf")));
                        for link in mined {
                            if !next_targets.contains(&link) {
                                next_targets.push(link);
                            }
                        }
                    }
                }
                Err(e) => out.messages.push(format!(
                    "institution proxy candidate failed ({rewritten}): {e}"
                )),
            }
        }
        if next_targets.is_empty() {
            break;
        }
        targets = next_targets;
    }
    out.messages
        .push("institution proxy did not yield a PDF (cookie expired or not subscribed?)".into());
    out
}

/// Extract candidate PDF links from a proxied landing page. Absolute links are
/// returned as-is; publisher-relative paths are resolved against the proxy
/// origin so the caller can rewrite them again.
fn pdf_links_from_html(html: &str, proxy_origin: &str, gateway_origin: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for attr in ["href=\"", "src=\""] {
        let mut rest = html;
        while let Some(idx) = rest.find(attr) {
            let after = &rest[idx + attr.len()..];
            let Some(end) = after.find('"') else { break };
            let link = &after[..end];
            rest = &after[end..];
            let lower = link.to_ascii_lowercase();
            let looks_like_pdf = lower.ends_with(".pdf")
                || lower.contains("pdfdirect")
                || lower.contains("getfulltxt")
                || lower.contains("/pdf/")
                || lower.contains("articlepdf");
            if !looks_like_pdf || link.is_empty() {
                continue;
            }
            let resolved = if link.starts_with("http") {
                link.to_string()
            } else if link.starts_with("/https/") || link.starts_with("/http/") {
                // Gateway-absolute wengine path — resolve against the gateway
                // origin, never against the current page's directory.
                format!("{gateway_origin}{link}")
            } else if link.starts_with('/') {
                format!("{proxy_origin}{link}")
            } else {
                continue;
            };
            if !out.contains(&resolved) {
                out.push(resolved);
            }
        }
    }
    out.truncate(5);
    out
}

/// One-shot probe of an institution proxy configuration: fetch a known
/// paywalled DOI through the rewrite and check the response is a PDF.
/// Returns the resolved gateway kind and byte count on success. Backs the
/// settings "test connection" and also classifies `Auto` prefixes.
pub async fn probe_institution_proxy(
    kind: InstitutionProxyKind,
    prefix: &str,
    cookie: &str,
) -> Result<(InstitutionProxyKind, usize), String> {
    const PROBE_DOI: &str = "10.1038/nature12373";
    let prefix = prefix.trim().trim_end_matches('/');
    if prefix.is_empty() {
        return Err("proxy prefix is empty".into());
    }
    let kind = resolve_institution_proxy_kind(kind, prefix, cookie)
        .await
        .ok_or_else(|| {
            "could not detect the gateway type; choose ezproxy / wengine / subdomain".to_string()
        })?;
    let target = "https://www.nature.com/articles/nature12373.pdf";
    let (rewritten, seeds) = match kind {
        InstitutionProxyKind::Direct => {
            return Err("direct mode has no gateway to probe".into());
        }
        InstitutionProxyKind::Auto => unreachable!("Auto is resolved above"),
        InstitutionProxyKind::EzProxy => {
            // The stored prefix may be a bare origin (normalize appends
            // /login?url= only for the runtime config, not for probe args);
            // without the query part the rewrite would concatenate the host
            // and the encoded target into an unparseable URL.
            let mut ez = prefix.to_string();
            if !ez.contains('?') {
                ez.push_str("/login?url=");
            }
            (
                ezproxy_rewrite(&ez, &format!("https://doi.org/{PROBE_DOI}")),
                Vec::new(),
            )
        }
        InstitutionProxyKind::Wengine => (
            wengine_rewrite(prefix, target).ok_or_else(|| "wengine rewrite failed".to_string())?,
            Vec::new(),
        ),
        InstitutionProxyKind::Subdomain => {
            let mapped = subdomain_rewrite(prefix, target)
                .ok_or_else(|| "subdomain rewrite failed".to_string())?;
            // The gateway session cookie must also be present when the mapped
            // host redirects through `/vpn_key/update`.
            (mapped.clone(), vec![prefix.to_string(), mapped])
        }
    };
    let seeds: Vec<&str> = seeds.iter().map(String::as_str).collect();
    let (bytes, final_url) =
        fetch_bytes_checked_with_url_seeded(&rewritten, cookie.trim(), &seeds).await?;
    if bytes.len() >= 4 && &bytes[..4] == b"%PDF" {
        return Ok((kind, bytes.len()));
    }
    let login_redirect = reqwest::Url::parse(&final_url).is_ok_and(|url| {
        let path = url.path().to_ascii_lowercase();
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        [
            "/login",
            "/sign_in",
            "/authserver",
            "/vpn_key",
            "/cas",
            "/sso",
        ]
        .iter()
        .any(|part| path.contains(part))
            || ["login.", "sso.", "cas.", "passport."]
                .iter()
                .any(|part| host.starts_with(part))
    });
    if login_redirect {
        return Err("authentication required: gateway redirected to login".into());
    }
    Err("response was HTML, not a PDF (institution may not subscribe to this journal)".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_links_from_html_keeps_pdf_like_and_resolves_relative() {
        let html = r#"<a href="https://pub.example.org/pdf/10.1/x.pdf">pdf</a>
            <a href="/doi/pdf/10.1/x">alt</a>
            <a href="https://pub.example.org/article">no</a>
            <embed src="/delivery/getFullTxt.cpx">"#;
        let links = pdf_links_from_html(
            html,
            "https://webvpn.example.edu",
            "https://webvpn.example.edu",
        );
        assert!(links.contains(&"https://pub.example.org/pdf/10.1/x.pdf".to_string()));
        assert!(links.contains(&"https://webvpn.example.edu/doi/pdf/10.1/x".to_string()));
        assert!(links.contains(&"https://webvpn.example.edu/delivery/getFullTxt.cpx".to_string()));
        assert!(!links.iter().any(|l| l.ends_with("/article")));
    }
}
