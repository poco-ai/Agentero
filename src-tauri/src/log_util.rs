//! Operation start/end logging helpers (see `docs/development/logging.md`).

use crate::error::AppError;
use std::time::Instant;

const TARGET: &str = "agentero::op";

/// Timed operation: always pair `start` with `finish_*`.
pub struct OpTimer {
    name: &'static str,
    fields: String,
    start: Instant,
}

impl OpTimer {
    pub fn start(name: &'static str) -> Self {
        Self::start_with(name, "")
    }

    pub fn start_with(name: &'static str, fields: impl AsRef<str>) -> Self {
        let fields = fields.as_ref().trim().to_string();
        if fields.is_empty() {
            log::info!(target: TARGET, "op start {name}");
        } else {
            log::info!(target: TARGET, "op start {name} {fields}");
        }
        Self {
            name,
            fields,
            start: Instant::now(),
        }
    }

    fn duration_ms(&self) -> u128 {
        self.start.elapsed().as_millis()
    }

    fn fields_suffix(&self) -> String {
        if self.fields.is_empty() {
            String::new()
        } else {
            format!(" {}", self.fields)
        }
    }

    pub fn finish_ok(self) {
        let ms = self.duration_ms();
        let extra = self.fields_suffix();
        log::info!(
            target: TARGET,
            "op end {} ok=true duration_ms={}{}",
            self.name,
            ms,
            extra
        );
    }

    pub fn finish_ok_extra(self, extra_fields: impl AsRef<str>) {
        let ms = self.duration_ms();
        let base = self.fields_suffix();
        let more = extra_fields.as_ref().trim();
        let more = if more.is_empty() {
            String::new()
        } else {
            format!(" {more}")
        };
        log::info!(
            target: TARGET,
            "op end {} ok=true duration_ms={}{}{}",
            self.name,
            ms,
            base,
            more
        );
    }

    pub fn finish_err(self, err: &AppError) {
        let ms = self.duration_ms();
        let extra = self.fields_suffix();
        log::error!(
            target: TARGET,
            "op end {} ok=false duration_ms={}{} error_code={} error={}",
            self.name,
            ms,
            extra,
            err.code().as_str(),
            err
        );
    }

    pub fn finish_err_msg(self, error_code: &str, error: impl std::fmt::Display) {
        let ms = self.duration_ms();
        let extra = self.fields_suffix();
        log::error!(
            target: TARGET,
            "op end {} ok=false duration_ms={}{} error_code={} error={}",
            self.name,
            ms,
            extra,
            error_code,
            error
        );
    }

    /// Emit the matching end log and pass the `Result` through unchanged
    /// (commands return `Result<T, AppError>` on the Tauri error channel).
    pub fn finish<T>(self, result: Result<T, AppError>) -> Result<T, AppError> {
        match result {
            Ok(v) => {
                self.finish_ok();
                Ok(v)
            }
            Err(e) => {
                self.finish_err(&e);
                Err(e)
            }
        }
    }

    /// Like `finish` but append extra fields on success (e.g. `count=3`).
    pub fn finish_extra<T>(
        self,
        result: Result<T, AppError>,
        ok_extra: impl FnOnce(&T) -> String,
    ) -> Result<T, AppError> {
        match result {
            Ok(v) => {
                let extra = ok_extra(&v);
                self.finish_ok_extra(extra);
                Ok(v)
            }
            Err(e) => {
                self.finish_err(&e);
                Err(e)
            }
        }
    }
}

/// Truncate long strings for safe log fields.
pub fn trunc(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let head: String = t.chars().take(max.saturating_sub(1)).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    #[test]
    fn trunc_short_and_long() {
        assert_eq!(trunc("  hi  ", 10), "hi");
        let long = "a".repeat(50);
        let out = trunc(&long, 10);
        assert!(out.ends_with('…'));
        assert!(out.chars().count() <= 10);
    }

    #[test]
    fn op_timer_ok_and_err() {
        let op = OpTimer::start_with("unit_test_ok", "k=v");
        let res = op.finish::<i32>(Ok(42));
        assert_eq!(res.unwrap(), 42);

        let op = OpTimer::start("unit_test_err");
        let res = op.finish::<i32>(Err(AppError::message("boom")));
        let err = res.unwrap_err();
        assert_eq!(err.code(), crate::error::ErrorCode::Internal);
    }
}
