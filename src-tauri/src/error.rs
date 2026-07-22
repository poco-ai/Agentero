//! Application error type shared by the Tauri host and the headless CLI.
//!
//! Contract (`docs/backend/api.md` §2.2): commands return `Result<T, AppError>`;
//! failures reach the webview as a rejected promise carrying `{ code, message }`.
//! Legacy commands still return the `ApiResult` envelope during the migration.

use serde::ser::SerializeStruct;
use serde::Serialize;

/// Stable machine-readable error codes (wire format: `snake_case`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidInput,
    VaultNotFound,
    PaperNotFound,
    SessionNotFound,
    AgentNotFound,
    AgentUnavailable,
    PermissionDenied,
    ImportFailed,
    ExportFailed,
    Io,
    Json,
    Sqlite,
    Acp,
    Internal,
}

impl ErrorCode {
    /// Wire string (matches the serde `snake_case` representation).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::VaultNotFound => "vault_not_found",
            Self::PaperNotFound => "paper_not_found",
            Self::SessionNotFound => "session_not_found",
            Self::AgentNotFound => "agent_not_found",
            Self::AgentUnavailable => "agent_unavailable",
            Self::PermissionDenied => "permission_denied",
            Self::ImportFailed => "import_failed",
            Self::ExportFailed => "export_failed",
            Self::Io => "io",
            Self::Json => "json",
            Self::Sqlite => "sqlite",
            Self::Acp => "acp",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Legacy free-form error. Migration target: replace call sites with a
    /// structured variant below, then delete.
    #[error("{0}")]
    Message(String),

    /// Caller passed a missing/malformed argument (400-class).
    #[error("{0}")]
    InvalidInput(String),

    #[error("{0}")]
    VaultNotFound(String),

    #[error("{0}")]
    PaperNotFound(String),

    /// Remote / agent session id is unknown or expired.
    #[error("{0}")]
    SessionNotFound(String),

    #[error("agent not found: {0}")]
    AgentNotFound(String),

    #[error("agent unavailable: {0}")]
    AgentUnavailable(String),

    #[error("{0}")]
    PermissionDenied(String),

    #[error("{0}")]
    ImportFailed(String),

    #[error("{0}")]
    ExportFailed(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("acp: {0}")]
    Acp(String),

    #[error("sqlite: {0}")]
    Sqlite(String),

    /// Host-side invariant broke (lock poisoned, subprocess failure, …).
    #[error("{0}")]
    Internal(String),
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value.to_string())
    }
}

impl AppError {
    pub fn message(msg: impl Into<String>) -> Self {
        Self::Message(msg.into())
    }

    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::InvalidInput(msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }

    pub fn code(&self) -> ErrorCode {
        match self {
            // Legacy free-form messages historically covered validation and
            // internal failures alike; `internal` is the conservative bucket.
            Self::Message(_) | Self::Internal(_) => ErrorCode::Internal,
            Self::InvalidInput(_) => ErrorCode::InvalidInput,
            Self::VaultNotFound(_) => ErrorCode::VaultNotFound,
            Self::PaperNotFound(_) => ErrorCode::PaperNotFound,
            Self::SessionNotFound(_) => ErrorCode::SessionNotFound,
            Self::AgentNotFound(_) => ErrorCode::AgentNotFound,
            Self::AgentUnavailable(_) => ErrorCode::AgentUnavailable,
            Self::PermissionDenied(_) => ErrorCode::PermissionDenied,
            Self::ImportFailed(_) => ErrorCode::ImportFailed,
            Self::ExportFailed(_) => ErrorCode::ExportFailed,
            Self::Io(_) => ErrorCode::Io,
            Self::Json(_) => ErrorCode::Json,
            Self::Sqlite(_) => ErrorCode::Sqlite,
            Self::Acp(_) => ErrorCode::Acp,
        }
    }
}

/// Wire shape for the Tauri error channel: `{ code, message }`.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut st = serializer.serialize_struct("AppError", 2)?;
        st.serialize_field("code", &self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

/// Legacy response envelope (errors folded into the resolve path).
/// Migration target: commands return `Result<T, AppError>` instead; delete
/// once no command references this.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResult<T: Serialize> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl<T: Serialize> ApiResult<T> {
    pub fn ok(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(err: AppError) -> ApiResult<T> {
        ApiResult {
            ok: false,
            data: None,
            error: Some(ErrorBody {
                code: err.code().as_str().to_string(),
                message: err.to_string(),
            }),
        }
    }
}

pub fn map_err<T: Serialize>(err: AppError) -> ApiResult<T> {
    ApiResult::err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_error_serializes_as_code_message() {
        let err = AppError::PaperNotFound("no paper for ref 'x'".into());
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "code": "paper_not_found", "message": "no paper for ref 'x'" })
        );
    }

    #[test]
    fn error_code_as_str_matches_serde() {
        for code in [
            ErrorCode::InvalidInput,
            ErrorCode::VaultNotFound,
            ErrorCode::PaperNotFound,
            ErrorCode::SessionNotFound,
            ErrorCode::AgentNotFound,
            ErrorCode::AgentUnavailable,
            ErrorCode::PermissionDenied,
            ErrorCode::ImportFailed,
            ErrorCode::ExportFailed,
            ErrorCode::Io,
            ErrorCode::Json,
            ErrorCode::Sqlite,
            ErrorCode::Acp,
            ErrorCode::Internal,
        ] {
            let json = serde_json::to_value(code).unwrap();
            assert_eq!(json, serde_json::json!(code.as_str()));
        }
    }

    #[test]
    fn legacy_envelope_uses_wire_codes() {
        let out: ApiResult<()> = map_err(AppError::message("boom"));
        assert!(!out.ok);
        assert_eq!(out.error.as_ref().unwrap().code, "internal");
    }
}
