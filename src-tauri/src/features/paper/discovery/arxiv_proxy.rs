//! Sandboxed arXiv HTML proxy used by the desktop reader.

use tauri::http::{header, Response, StatusCode};

const ARXIV_ORIGIN: &str = "https://arxiv.org";
const READER_STYLE: &str =
    "<style>.desktop_header, nav.ltx_TOC, .btn.btn-primary.hover-rp-button, #footer, .ltx_page_footer { display: none !important; }</style>";

fn response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(body)
        .expect("valid arXiv proxy response")
}

pub fn handle(request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let path = request.uri().path().to_string();
    if !path.starts_with('/') || path.contains("..") {
        responder.respond(response(
            StatusCode::BAD_REQUEST,
            "text/plain",
            b"invalid arXiv path".to_vec(),
        ));
        return;
    }
    let query = request
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = format!("{ARXIV_ORIGIN}{path}{query}");

    tauri::async_runtime::spawn(async move {
        let result = async {
            let client = crate::core::http::client_builder()
                .user_agent(crate::core::http::USER_AGENT)
                .redirect(reqwest::redirect::Policy::limited(
                    crate::core::http::DEFAULT_REDIRECT_LIMIT,
                ))
                .build()?;
            let remote = client.get(url).send().await?;
            let status =
                StatusCode::from_u16(remote.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let content_type = remote
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            let bytes = remote.bytes().await?;
            let body = if path.starts_with("/html/") && content_type.starts_with("text/html") {
                String::from_utf8(bytes.to_vec())
                    .map(|html| {
                        html.replacen("</head>", &format!("{READER_STYLE}</head>"), 1)
                            .into_bytes()
                    })
                    .unwrap_or_else(|_| bytes.to_vec())
            } else {
                bytes.to_vec()
            };
            Ok::<_, reqwest::Error>((status, content_type, body))
        }
        .await;

        match result {
            Ok((status, content_type, body)) => {
                responder.respond(response(status, &content_type, body))
            }
            Err(error) => {
                log::warn!(target: "agentero::arxiv", "arXiv proxy request failed: {error}");
                responder.respond(response(
                    StatusCode::BAD_GATEWAY,
                    "text/plain",
                    b"arXiv unavailable".to_vec(),
                ));
            }
        }
    });
}
