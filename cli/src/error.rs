//! Stable CLI error codes and exit status.

use serde::Serialize;
use serde_json::{json, Value};
use std::fmt;

/// Process exit codes (see docs/development/cli.md).
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCode {
    Business = 1,
    Usage = 2,
    Vault = 3,
    NeedsConfirmation = 4,
}

#[derive(Debug, Clone)]
pub struct CliError {
    pub code: &'static str,
    pub message: String,
    pub details: Value,
    pub exit: ExitCode,
}

impl CliError {
    pub fn new(code: &'static str, message: impl Into<String>, exit: ExitCode) -> Self {
        Self {
            code,
            message: message.into(),
            details: json!({}),
            exit,
        }
    }

    pub fn with_details(
        code: &'static str,
        message: impl Into<String>,
        details: Value,
        exit: ExitCode,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            details,
            exit,
        }
    }

    pub fn exit_code(&self) -> ExitCode {
        self.exit
    }

    pub fn vault_not_found(msg: impl Into<String>) -> Self {
        Self::new("vault_not_found", msg, ExitCode::Vault)
    }

    pub fn paper_not_found(ref_: &str) -> Self {
        Self::new(
            "paper_not_found",
            format!("No paper for ref '{ref_}'"),
            ExitCode::Business,
        )
    }

    pub fn paper_ambiguous(ref_: &str, candidates: &[String]) -> Self {
        Self::with_details(
            "paper_ambiguous",
            format!("Multiple papers match id '{ref_}'"),
            json!({ "candidates": candidates }),
            ExitCode::Business,
        )
    }

    pub fn needs_confirmation(msg: impl Into<String>) -> Self {
        Self::new("needs_confirmation", msg, ExitCode::NeedsConfirmation)
    }

    pub fn import_failed(msg: impl Into<String>) -> Self {
        Self::new("import_failed", msg, ExitCode::Business)
    }

    pub fn export_failed(msg: impl Into<String>) -> Self {
        Self::new("export_failed", msg, ExitCode::Business)
    }

    pub fn asset_missing(msg: impl Into<String>) -> Self {
        Self::new("asset_missing", msg, ExitCode::Business)
    }

    pub fn message(msg: impl Into<String>) -> Self {
        Self::new("message", msg, ExitCode::Business)
    }

    pub fn usage(msg: impl Into<String>) -> Self {
        Self::new("usage", msg, ExitCode::Usage)
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CliError {}

impl From<agentero_lib::error::AppError> for CliError {
    fn from(err: agentero_lib::error::AppError) -> Self {
        use agentero_lib::error::ErrorCode;
        let msg = err.to_string();
        match err.code() {
            ErrorCode::VaultNotFound => Self::vault_not_found(msg),
            ErrorCode::PaperNotFound => Self::new("paper_not_found", msg, ExitCode::Business),
            ErrorCode::InvalidInput => Self::new("message", msg, ExitCode::Business),
            ErrorCode::ImportFailed => Self::import_failed(msg),
            ErrorCode::ExportFailed => Self::export_failed(msg),
            ErrorCode::Sqlite => Self::new("catalog_busy", msg, ExitCode::Business),
            ErrorCode::Io => Self::new("io", msg, ExitCode::Business),
            ErrorCode::Json => Self::new("json", msg, ExitCode::Business),
            // Legacy free-form messages: keep the historical substring mapping
            // until every host call site uses a structured variant.
            _ => {
                let lower = msg.to_ascii_lowercase();
                if lower.contains("not found") {
                    return Self::new("paper_not_found", msg, ExitCode::Business);
                }
                if lower.contains("vault") && lower.contains("not a directory") {
                    return Self::vault_not_found(msg);
                }
                if lower.contains("export") {
                    return Self::export_failed(msg);
                }
                if lower.contains("translator") || lower.contains("import") {
                    return Self::import_failed(msg);
                }
                Self::new("message", msg, ExitCode::Business)
            }
        }
    }
}

impl From<std::io::Error> for CliError {
    fn from(err: std::io::Error) -> Self {
        Self::new("io", err.to_string(), ExitCode::Business)
    }
}

impl From<serde_json::Error> for CliError {
    fn from(err: serde_json::Error) -> Self {
        Self::new("json", err.to_string(), ExitCode::Business)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Value::is_null")]
    pub details: Value,
}

#[derive(Debug, Serialize)]
pub struct JsonFail {
    pub ok: bool,
    pub error: ErrorBody,
}

impl CliError {
    pub fn to_json_fail(&self) -> JsonFail {
        JsonFail {
            ok: false,
            error: ErrorBody {
                code: self.code.to_string(),
                message: self.message.clone(),
                details: self.details.clone(),
            },
        }
    }
}
