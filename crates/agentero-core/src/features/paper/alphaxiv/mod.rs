//! Authenticated alphaXiv library client.
//!
//! v1 talks to `https://api.alphaxiv.org` with `GET /folders/v3` only.
//! That call both checks a pasted API key and lists folders (each already
//! carrying its `papers` array). An empty list is still a successful check.
//! `GET /users/v3` rejects a valid API key with HTTP 403, so it is not used.
//! Write routes (`add-papers`, `remove-papers`) are intentionally absent.
//!
//! The API key is sent only as `Authorization: Bearer <key>` and is never
//! copied into errors, logs, or these parsed structs.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::error::AppError;
use crate::features::paper::scholar_api::identifiers::extract_arxiv_id;

const API_BASE: &str = "https://api.alphaxiv.org";
const PDF_ASSET_BASE: &str = "https://pdfs.assets.alphaxiv.org";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_API_KEY_CHARS: usize = 512;

/// Stable skip code for a folder paper that has no public arXiv id.
pub const SKIP_REASON_PRIVATE: &str = "private";

/// Account fields safe to show in Settings. No credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AlphaXivAccount {
    pub username: String,
    pub email: String,
    pub real_name: String,
    /// `realName`, else `username`, else `email`, else `"AlphaXiv"`.
    pub label: String,
}

/// One paper inside a folder payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AlphaXivFolderPaper {
    pub paper_group_id: String,
    pub universal_paper_id: String,
    pub canonical_id: String,
    pub paper_version_id: String,
    pub title: String,
    pub paper_abstract: String,
    pub topics: Vec<String>,
    pub authors: Vec<String>,
    /// Original `addedAt` string, or the decimal timestamp when that is all
    /// the payload has. Empty when absent.
    pub added_at: String,
    /// Bare public arXiv id (`1706.03762`). Empty for private uploads.
    pub arxiv_id: String,
    pub importable: bool,
    /// [`SKIP_REASON_PRIVATE`] when `importable` is false, otherwise empty.
    pub skip_reason: String,
    /// `https://pdfs.assets.alphaxiv.org/{canonical}.pdf` for a public paper.
    pub pdf_url: String,
}

/// One library folder. `papers` is the list the folder payload already included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AlphaXivFolder {
    pub id: String,
    pub name: String,
    pub folder_type: String,
    pub order: i64,
    pub parent_id: String,
    pub sharing_status: String,
    /// Lucide icon name from the folder appearance (`cpu`). Empty when AlphaXiv
    /// leaves the mark to the client and sends `icon: null`.
    pub icon: String,
    /// Appearance palette name (`red`, `orange`, …). Empty when unset.
    pub color: String,
    pub papers: Vec<AlphaXivFolderPaper>,
    pub paper_count: u32,
}

/// Trim a pasted key. Accepts a raw key or a single `Bearer ` prefix.
/// Rejects masks, whitespace, control characters, and oversized values so the
/// key cannot be folded into another header.
pub fn normalize_api_key(raw: &str) -> Result<String, AppError> {
    let mut key = raw.trim();
    if key.len() >= 7 && key[..7].eq_ignore_ascii_case("bearer ") {
        key = key[7..].trim();
    }
    if key.is_empty() || is_secret_mask(key) {
        return Err(AppError::domain(
            "alphaxiv_key_missing",
            "AlphaXiv API key is not set",
        ));
    }
    if key.chars().count() > MAX_API_KEY_CHARS
        || key.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(AppError::domain(
            "alphaxiv_key_invalid",
            "AlphaXiv API key is not valid",
        ));
    }
    Ok(key.to_string())
}

fn is_secret_mask(key: &str) -> bool {
    let trimmed = key.trim();
    !trimmed.is_empty() && trimmed.chars().all(|c| c == '*')
}

fn authorization_value(api_key: &str) -> Result<String, AppError> {
    Ok(format!("Bearer {}", normalize_api_key(api_key)?))
}

/// Prove a pasted API key with `GET /folders/v3`.
///
/// A valid API key is rejected by `GET /users/v3` with HTTP 403
/// (`API keys cannot access this endpoint`). An invalid key on the folder
/// route is HTTP 401. The folder payload has no account fields, so the
/// returned profile is empty. An empty folder list still counts as success.
pub async fn fetch_account(api_key: &str) -> Result<AlphaXivAccount, AppError> {
    let value = get_json("/folders/v3", api_key).await?;
    if !value.is_array() {
        return Err(AppError::domain(
            "alphaxiv_parse",
            "AlphaXiv folders response was not a list",
        ));
    }
    Ok(AlphaXivAccount {
        username: String::new(),
        email: String::new(),
        real_name: String::new(),
        label: String::new(),
    })
}

/// `GET /folders/v3`. The body must be a JSON array.
pub async fn fetch_folders(api_key: &str) -> Result<Vec<AlphaXivFolder>, AppError> {
    let value = get_json("/folders/v3", api_key).await?;
    parse_folders(&value)
}

async fn get_json(path: &str, api_key: &str) -> Result<Value, AppError> {
    let authorization = authorization_value(api_key)?;
    let url = format!("{API_BASE}{path}");
    let client = crate::http::client(REQUEST_TIMEOUT)?;
    let response = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, authorization)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|err| network_error(&err))?;
    let status = response.status();
    if !status.is_success() {
        // Drop the body. Error pages can echo the credential.
        let _ = response.text().await;
        return Err(status_error(status.as_u16()));
    }
    let text = response.text().await.map_err(|err| network_error(&err))?;
    serde_json::from_str(&text)
        .map_err(|_| AppError::domain("alphaxiv_parse", "AlphaXiv response was not valid JSON"))
}

fn network_error(err: &reqwest::Error) -> AppError {
    let message = if err.is_timeout() {
        "AlphaXiv request timed out"
    } else if err.is_connect() {
        "Could not reach AlphaXiv"
    } else {
        "AlphaXiv request failed"
    };
    AppError::domain("alphaxiv_network", message)
}

fn status_error(status: u16) -> AppError {
    // 401 is an invalid or missing key. 403 on a profile route means the key
    // is accepted but that route refuses API keys, so it must not use the
    // same message.
    if status == 401 {
        AppError::domain("alphaxiv_auth_failed", "AlphaXiv rejected the API key")
    } else if status == 403 {
        AppError::domain(
            "alphaxiv_auth_failed",
            "AlphaXiv refused access to this endpoint",
        )
    } else {
        AppError::domain(
            "alphaxiv_http",
            format!("AlphaXiv request failed (HTTP {status})"),
        )
    }
}

/// Pull username / email / real name out of a `/users/v3` object.
/// Field names follow the aliases alphaxiv-py already accepts, plus a nested
/// `user` / `profile` object. An empty object still counts as authenticated.
pub fn parse_account(value: &Value) -> Option<AlphaXivAccount> {
    let source = identity_source(value)?;
    let username = string_field(source, &["username", "userName", "handle", "slug"]);
    let email = string_field(source, &["email", "userEmail", "user_email"]);
    let real_name = string_field(
        source,
        &[
            "realName",
            "real_name",
            "fullName",
            "full_name",
            "displayName",
            "display_name",
            "name",
        ],
    );
    let label = account_label(&real_name, &username, &email);
    Some(AlphaXivAccount {
        username,
        email,
        real_name,
        label,
    })
}

fn identity_source(value: &Value) -> Option<&Value> {
    if !value.is_object() {
        return None;
    }
    if has_identity(value) {
        return Some(value);
    }
    for key in ["user", "profile", "data", "account"] {
        if let Some(nested) = value.get(key) {
            if nested.is_object() && has_identity(nested) {
                return Some(nested);
            }
        }
    }
    Some(value)
}

fn has_identity(value: &Value) -> bool {
    [
        "username",
        "userName",
        "handle",
        "email",
        "userEmail",
        "user_email",
        "realName",
        "real_name",
        "fullName",
        "full_name",
        "name",
        "id",
        "userId",
        "user_id",
    ]
    .iter()
    .any(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
    })
}

fn account_label(real_name: &str, username: &str, email: &str) -> String {
    if !real_name.is_empty() {
        real_name.to_string()
    } else if !username.is_empty() {
        username.to_string()
    } else if !email.is_empty() {
        email.to_string()
    } else {
        "AlphaXiv".to_string()
    }
}

pub fn parse_folders(value: &Value) -> Result<Vec<AlphaXivFolder>, AppError> {
    let items = value.as_array().ok_or_else(|| {
        AppError::domain("alphaxiv_parse", "AlphaXiv folders response was not a list")
    })?;
    Ok(items.iter().filter_map(parse_folder).collect())
}

fn parse_folder(value: &Value) -> Option<AlphaXivFolder> {
    if !value.is_object() {
        return None;
    }
    let id = string_field(value, &["id", "folderId", "folder_id"]);
    if id.is_empty() {
        return None;
    }
    let papers: Vec<AlphaXivFolderPaper> = value
        .get("papers")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(parse_paper).collect())
        .unwrap_or_default();
    let paper_count = u32::try_from(papers.len()).unwrap_or(u32::MAX);
    Some(AlphaXivFolder {
        id,
        name: string_field(value, &["name", "title"]),
        folder_type: string_field(value, &["type", "folderType", "folder_type"]),
        order: json_i64(value, &["order"]),
        parent_id: string_field(value, &["parentId", "parent_id", "parentFolderId"]),
        sharing_status: string_field(value, &["sharingStatus", "sharing_status"]),
        icon: string_field(value, &["icon"]),
        color: string_field(value, &["color", "colour"]),
        papers,
        paper_count,
    })
}

fn parse_paper(value: &Value) -> Option<AlphaXivFolderPaper> {
    if !value.is_object() {
        return None;
    }
    let paper_group_id = string_field(value, &["paperGroupId", "paper_group_id"]);
    let universal_paper_id = string_field(value, &["universalPaperId", "universal_paper_id"]);
    let canonical_id = string_field(value, &["canonicalId", "canonical_id"]);
    let paper_version_id = string_field(
        value,
        &[
            "paperVersionId",
            "paper_version_id",
            "versionId",
            "version_id",
        ],
    );
    let title = string_field(value, &["title"]);
    if paper_group_id.is_empty()
        && universal_paper_id.is_empty()
        && canonical_id.is_empty()
        && title.is_empty()
    {
        return None;
    }
    let arxiv_id = public_arxiv_id(&canonical_id, &universal_paper_id);
    let importable = arxiv_id.is_some();
    let pdf_url = if importable {
        pdf_asset_url(&canonical_id).or_else(|| pdf_asset_url(&universal_paper_id))
    } else {
        None
    }
    .unwrap_or_default();
    Some(AlphaXivFolderPaper {
        paper_group_id,
        universal_paper_id,
        canonical_id,
        paper_version_id,
        title,
        paper_abstract: string_field(value, &["abstract", "paperAbstract"]),
        topics: string_list(value, "topics"),
        authors: author_names(value),
        added_at: added_at(value),
        arxiv_id: arxiv_id.unwrap_or_default(),
        importable,
        skip_reason: if importable {
            String::new()
        } else {
            SKIP_REASON_PRIVATE.to_string()
        },
        pdf_url,
    })
}

/// Bare arXiv id from `canonicalId`, then `universalPaperId`.
pub fn public_arxiv_id(canonical_id: &str, universal_paper_id: &str) -> Option<String> {
    extract_arxiv_id(canonical_id).or_else(|| extract_arxiv_id(universal_paper_id))
}

/// Product PDF URL. Keeps a trailing `vN` when the input is exactly that id.
pub fn pdf_asset_url(raw: &str) -> Option<String> {
    let compact = raw
        .trim()
        .trim_start_matches("arXiv:")
        .trim_start_matches("arxiv:")
        .trim();
    let bare = extract_arxiv_id(compact)?;
    let asset_id = if compact == bare
        || compact.strip_prefix(&bare).is_some_and(|rest| {
            let version = rest.strip_prefix('v').unwrap_or("");
            !version.is_empty() && version.chars().all(|c| c.is_ascii_digit())
        }) {
        compact
    } else {
        bare.as_str()
    };
    if asset_id.contains(['?', '#', ' ', '\\']) {
        return None;
    }
    Some(format!("{PDF_ASSET_BASE}/{asset_id}.pdf"))
}

fn author_names(value: &Value) -> Vec<String> {
    let Some(items) = value.get("authors").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let name = if let Some(text) = item.as_str() {
                text.trim().to_string()
            } else if item.is_object() {
                string_field(
                    item,
                    &[
                        "full_name",
                        "fullName",
                        "name",
                        "realName",
                        "real_name",
                        "username",
                    ],
                )
            } else {
                String::new()
            };
            (!name.is_empty()).then_some(name)
        })
        .collect()
}

fn string_list(value: &Value, key: &str) -> Vec<String> {
    let Some(items) = value.get(key).and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let text = if let Some(text) = item.as_str() {
                text.trim().to_string()
            } else if item.is_object() {
                string_field(item, &["name", "topic", "slug"])
            } else {
                String::new()
            };
            (!text.is_empty()).then_some(text)
        })
        .collect()
}

fn added_at(value: &Value) -> String {
    let Some(raw) = value.get("addedAt").or_else(|| value.get("added_at")) else {
        return String::new();
    };
    match raw {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.as_i64().map(|n| n.to_string()).unwrap_or_default(),
        _ => String::new(),
    }
}

fn string_field(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn json_i64(value: &Value, keys: &[&str]) -> i64 {
    for key in keys {
        match value.get(*key) {
            Some(Value::Number(number)) => {
                if let Some(integer) = number.as_i64() {
                    return integer;
                }
            }
            Some(Value::String(text)) => {
                if let Ok(integer) = text.trim().parse::<i64>() {
                    return integer;
                }
            }
            _ => {}
        }
    }
    0
}
