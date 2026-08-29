use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),

    #[error("{message}")]
    Domain { code: &'static str, message: String },

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("sqlite: {0}")]
    Sqlite(String),
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

    /// Feature-domain error with a stable wire code, keeping core free of business variants.
    pub fn domain(code: &'static str, message: impl Into<String>) -> Self {
        Self::Domain {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Message(_) => "message",
            Self::Domain { code, .. } => code,
            Self::Io(_) => "io",
            Self::Json(_) => "json",
            Self::Sqlite(_) => "sqlite",
        }
    }
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[specta(skip)]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiResult<T> {
    pub ok: bool,
    pub data: Option<T>,
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
                code: err.code().to_string(),
                message: err.to_string(),
                details: None,
            }),
        }
    }

    pub fn err_with_details(err: AppError, details: serde_json::Value) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(ErrorBody {
                code: err.code().to_string(),
                message: err.to_string(),
                details: Some(details),
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
    fn preserves_structured_recovery_details_in_api_errors() {
        let result: ApiResult<()> = ApiResult::err_with_details(
            AppError::message("external repair failed"),
            serde_json::json!({
                "code": "writeFailed",
                "rollback": "manual-recovery-required",
            }),
        );

        let value = serde_json::to_value(result).expect("error response serializes");
        assert_eq!(value["error"]["details"]["code"], "writeFailed");
        assert_eq!(
            value["error"]["details"]["rollback"],
            "manual-recovery-required"
        );
    }

    #[test]
    fn domain_error_preserves_code_and_display() {
        let err = AppError::domain("x_y", "msg");
        assert_eq!(err.code(), "x_y");
        assert_eq!(err.to_string(), "msg");
    }
}
