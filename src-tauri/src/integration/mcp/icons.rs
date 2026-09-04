//! MCP server / resource icons (SEP-973).
//!
//! Loopback + ChatGPT Tunnel cannot rely on a public HTTP favicon, so the app
//! PNG is embedded as a data URI in `initialize.serverInfo.icons`.

use base64::Engine;
use rmcp::model::Icon;

const PNG_32: &[u8] = include_bytes!("../../../icons/32x32.png");
const PNG_128: &[u8] = include_bytes!("../../../icons/128x128.png");

fn png_data_uri(bytes: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:image/png;base64,{b64}")
}

pub fn server_icons() -> Vec<Icon> {
    vec![
        Icon::new(png_data_uri(PNG_32))
            .with_mime_type("image/png")
            .with_sizes(vec!["32x32".into()]),
        Icon::new(png_data_uri(PNG_128))
            .with_mime_type("image/png")
            .with_sizes(vec!["128x128".into()]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_uris_are_png() {
        let icons = server_icons();
        assert_eq!(icons.len(), 2);
        for icon in &icons {
            assert!(
                icon.src.starts_with("data:image/png;base64,"),
                "{}",
                &icon.src[..40.min(icon.src.len())]
            );
            assert_eq!(icon.mime_type.as_deref(), Some("image/png"));
        }
        assert_eq!(icons[0].sizes.as_deref(), Some(&["32x32".to_string()][..]));
        assert_eq!(
            icons[1].sizes.as_deref(),
            Some(&["128x128".to_string()][..])
        );
    }
}
