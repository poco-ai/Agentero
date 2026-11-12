//! Pure URL rewrites for the supported gateway shapes. No network or state.

/// AES-128-CTR encrypt `host` with the public wengine key/IV and hex-encode
/// with the IV prefixed in plaintext, matching the gateway's URL form
/// (`/https/{hex(wrdvpnisthebest!)}{hex(ct)}/`). Verified against a live ZJU
/// WebVPN deployment (sample: www.cnki.net).
pub(crate) fn wengine_host(host: &str) -> String {
    use aes::cipher::{BlockEncrypt, KeyInit};
    const KEY_IV: &[u8; 16] = b"wrdvpnisthebest!";
    let cipher = aes::Aes128::new_from_slice(KEY_IV).expect("fixed 16-byte key");
    let mut counter = *KEY_IV;
    let mut block = aes::Block::default();
    let mut out = Vec::with_capacity(host.len());
    for chunk in host.as_bytes().chunks(16) {
        block.copy_from_slice(&counter);
        cipher.encrypt_block(&mut block);
        for (i, byte) in chunk.iter().enumerate() {
            out.push(byte ^ block[i]);
        }
        // big-endian increment of the full 128-bit counter
        for b in counter.iter_mut().rev() {
            *b = b.wrapping_add(1);
            if *b != 0 {
                break;
            }
        }
    }
    let mut hexed = String::with_capacity(32 + out.len() * 2);
    for b in KEY_IV.iter().chain(out.iter()) {
        hexed.push_str(&format!("{b:02x}"));
    }
    hexed
}

/// Rewrite `target` into a wengine path-style proxy URL:
/// `{origin}/{scheme}/{encoded-host}{path}`.
pub(crate) fn wengine_rewrite(origin: &str, target: &str) -> Option<String> {
    let (scheme, rest) = target.split_once("://")?;
    let (host, path) = match rest.split_once('/') {
        Some((h, p)) => (h, format!("/{p}")),
        None => (rest, "/".to_string()),
    };
    // strip port: the gateway encodes the bare host
    let host = host.split(':').next().unwrap_or(host);
    let path = path.trim_start_matches('/').trim_end_matches('/');
    if path.is_empty() {
        Some(format!("{origin}/{scheme}/{}", wengine_host(host)))
    } else {
        Some(format!("{origin}/{scheme}/{}/{path}", wengine_host(host)))
    }
}

/// Rewrite `target` into an EZProxy-style prefixed URL
/// (`{prefix}{percent-encoded target}`). The prefix is expected to already end
/// with the query part, e.g. `https://webvpn.example.edu/login?url=`.
pub(crate) fn ezproxy_rewrite(prefix: &str, target: &str) -> String {
    format!("{prefix}{}", urlencoding::encode(target))
}

/// Rewrite `target` into an Astraeus-style subdomain-mapped URL:
/// `{gateway}://{host-with-dashes}-{port}.{gateway-host}{path}?{query}`.
///
/// Unlike wengine this preserves the query and the original path verbatim;
/// authentication lives in a per-subdomain token minted through the gateway,
/// not in the rewritten path.
pub(crate) fn subdomain_rewrite(origin: &str, target: &str) -> Option<String> {
    let mut gateway = reqwest::Url::parse(origin).ok()?;
    let gateway_host = gateway.host_str()?.to_ascii_lowercase();
    let target = reqwest::Url::parse(target).ok()?;
    let host = target.host_str()?.to_ascii_lowercase();
    let port = target.port_or_known_default()?;
    let mapped = format!("{}-{port}.{gateway_host}", host.replace('.', "-"));
    gateway.set_host(Some(&mapped)).ok()?;
    gateway.set_path(target.path());
    gateway.set_query(target.query());
    gateway.set_fragment(target.fragment());
    Some(gateway.to_string())
}

/// True when `target` already points at the gateway or one of its mapped
/// subdomains, so a second rewrite would nest the host.
pub(crate) fn is_subdomain_mapped(target: &str, gateway_origin: &str) -> bool {
    let (Ok(target), Ok(gateway)) = (
        reqwest::Url::parse(target),
        reqwest::Url::parse(gateway_origin),
    ) else {
        return false;
    };
    let (Some(target_host), Some(gateway_host)) = (target.host_str(), gateway.host_str()) else {
        return false;
    };
    let target_host = target_host.to_ascii_lowercase();
    let gateway_host = gateway_host.to_ascii_lowercase();
    target_host == gateway_host || target_host.ends_with(&format!(".{gateway_host}"))
}

/// True when the prefix itself spells out the EZProxy convention, so no
/// network probe is needed.
pub(crate) fn looks_like_ezproxy_prefix(prefix: &str) -> bool {
    (prefix.contains('?') && prefix.contains("url="))
        || reqwest::Url::parse(prefix)
            .is_ok_and(|url| url.path().trim_end_matches('/').ends_with("/login"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ezproxy_rewrite_percent_encodes_target() {
        assert_eq!(
            ezproxy_rewrite(
                "https://webvpn.example.edu/login?url=",
                "https://doi.org/10.1038/nature12373"
            ),
            "https://webvpn.example.edu/login?url=https%3A%2F%2Fdoi.org%2F10.1038%2Fnature12373"
        );
    }

    #[test]
    fn wengine_host_matches_live_samples() {
        // Captured from a live ZJU WebVPN deployment (2026-10): the gateway
        // URL for www.cnki.net.
        assert_eq!(
            wengine_host("www.cnki.net"),
            "77726476706e69737468656265737421e7e056d2243e635930068cb8"
        );
    }

    #[test]
    fn wengine_rewrite_builds_path_form() {
        assert_eq!(
            wengine_rewrite(
                "https://webvpn.zju.edu.cn",
                "https://www.nature.com/articles/s43018-026-01220-4.pdf"
            )
            .as_deref(),
            Some(
                "https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421e7e056d229317c456c0dc7af9758/articles/s43018-026-01220-4.pdf"
            )
        );
    }

    #[test]
    fn subdomain_rewrite_maps_host_and_keeps_path_and_query() {
        assert_eq!(
            subdomain_rewrite(
                "https://webvpn.bjmu.edu.cn",
                "https://www.nature.com/articles/nature12373.pdf?proof=true"
            )
            .as_deref(),
            Some(
                "https://www-nature-com-443.webvpn.bjmu.edu.cn/articles/nature12373.pdf?proof=true"
            )
        );
        // Plain HTTP targets keep their effective port in the mapped host.
        assert_eq!(
            subdomain_rewrite("https://webvpn.example.edu", "http://example.org/a/b").as_deref(),
            Some("https://example-org-80.webvpn.example.edu/a/b")
        );
    }

    #[test]
    fn subdomain_mapping_detects_gateway_hosts() {
        assert!(is_subdomain_mapped(
            "https://www-nature-com-443.webvpn.bjmu.edu.cn/x.pdf",
            "https://webvpn.bjmu.edu.cn"
        ));
        assert!(is_subdomain_mapped(
            "https://webvpn.bjmu.edu.cn/vpn_key/update",
            "https://webvpn.bjmu.edu.cn"
        ));
        assert!(!is_subdomain_mapped(
            "https://www.nature.com/x.pdf",
            "https://webvpn.bjmu.edu.cn"
        ));
        assert!(!is_subdomain_mapped(
            "https://evilwebvpn.bjmu.edu.cn/x.pdf",
            "https://webvpn.bjmu.edu.cn"
        ));
    }

    #[test]
    fn ezproxy_prefix_rules_classify_known_shapes() {
        assert!(looks_like_ezproxy_prefix(
            "https://ezproxy.example.edu/login?url="
        ));
        assert!(looks_like_ezproxy_prefix(
            "https://ezproxy.example.edu/login"
        ));
        assert!(!looks_like_ezproxy_prefix("https://webvpn.zju.edu.cn"));
        assert!(!looks_like_ezproxy_prefix("https://webvpn.bjmu.edu.cn"));
    }
}
