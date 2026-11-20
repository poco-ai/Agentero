use crate::error::CliError;
use serde::Serialize;
use serde_json::Value;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Text,
    Json,
}
pub fn to_value<T: Serialize>(v: &T) -> Result<Value, CliError> {
    Ok(serde_json::to_value(v)?)
}
