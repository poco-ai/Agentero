//! Local body-parse engine: the existing killable liteparse worker.

use super::{BodyParseCtx, BodyParseEngine, BodyParseOutcome};
use crate::core::error::AppError;
use async_trait::async_trait;

pub(crate) struct LocalBodyEngine;

#[async_trait]
impl BodyParseEngine for LocalBodyEngine {
    fn id(&self) -> &'static str {
        "local"
    }

    async fn parse(&self, ctx: &BodyParseCtx<'_>) -> Result<BodyParseOutcome, AppError> {
        let (markdown, body_source, body_quality) =
            super::super::run_liteparse_markdown(ctx.pdf_path, ctx.task_id).await?;
        Ok(BodyParseOutcome {
            markdown,
            body_source,
            body_quality,
        })
    }
}
