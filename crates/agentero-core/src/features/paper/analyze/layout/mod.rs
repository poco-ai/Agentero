//! PDF layout analysis providers and their headless entry points.
//!
//! [`hosted`] holds the remote provider engines (Paddle PP-StructureV3,
//! MinerU), shared by the desktop Host commands and the CLI. The pipeline that
//! turns provider boxes into `source/layout.json` + `source/layout-index.json`
//! lives in `features::pdf::layout_analyze`.

pub mod hosted;
