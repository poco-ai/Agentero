//! Sanitized PostHog projection of local activity events.
//!
//! The out-bound shape is an allowlist: only registered kinds are projected,
//! and a projection carries nothing but the fields [`normalize`] already
//! stripped of user content (`facet` bucketed/truncated, `status`, `qty`) plus
//! a coarse duration bucket. Never `vault`, `path`, or raw `extra`.

use super::record::{normalize, UsageRecord};

#[derive(Debug, Clone)]
pub struct ActivityProjection {
    pub name: &'static str,
    pub facet: Option<String>,
    pub status: Option<String>,
    pub qty: Option<i64>,
    pub dur_bucket: Option<&'static str>,
}

/// Map a local activity record to its PostHog projection, or `None` when the
/// kind is not on the out-bound allowlist (the safe default — nothing leaks).
pub fn telemetry_projection(raw: &UsageRecord) -> Option<ActivityProjection> {
    let normalized = normalize(raw).ok()?;
    let name = match normalized.kind.as_str() {
        "paper.open" => "paper_opened",
        "note.open" => "note_opened",
        "paper.session" => "paper_session",
        "asset.download" => "asset_downloaded",
        "paper.import" => "paper_imported",
        "search.query" => "search_performed",
        "agent.run" => "agent_run",
        "skill.install" => "skill_installed",
        "paper.tag" => "paper_tagged",
        "paper.read" => "paper_read_set",
        "vault.open" => "vault_opened",
        "onboarding.complete" => "onboarding_completed",
        _ => return None,
    };
    let dur_bucket = (normalized.kind == "paper.session")
        .then(|| normalized.dur_ms.map(bucket_duration))
        .flatten();
    Some(ActivityProjection {
        name,
        facet: normalized.facet,
        status: normalized.status,
        qty: normalized.qty,
        dur_bucket,
    })
}

fn bucket_duration(ms: i64) -> &'static str {
    match ms {
        _ if ms < 10_000 => "<10s",
        _ if ms < 60_000 => "10-60s",
        _ if ms < 300_000 => "1-5m",
        _ if ms < 1_800_000 => "5-30m",
        _ => "30m+",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proj_rec(kind: &str, extra: serde_json::Value) -> UsageRecord {
        UsageRecord {
            ts: None,
            vault: Some("/vaults/demo".into()),
            kind: kind.into(),
            path: Some("papers/secret-title".into()),
            mode: None,
            dur_ms: None,
            extra: Some(extra),
        }
    }

    #[test]
    fn projection_drops_search_query_text() {
        let p = telemetry_projection(&proj_rec(
            "search.query",
            serde_json::json!({ "q": "secret query", "hits": 3 }),
        ))
        .expect("search.query projects");
        assert_eq!(p.name, "search_performed");
        assert_eq!(p.qty, Some(3));
        assert_eq!(p.facet, None);
    }

    #[test]
    fn projection_drops_skill_names() {
        let p = telemetry_projection(&proj_rec(
            "skill.install",
            serde_json::json!({ "sourceKind": "github", "installed": ["pptx", "frontend"] }),
        ))
        .expect("skill.install projects");
        assert_eq!(p.name, "skill_installed");
        assert_eq!(p.facet.as_deref(), Some("github"));
        assert_eq!(p.qty, Some(2));
    }

    #[test]
    fn projection_maps_and_filters_kinds() {
        let open = telemetry_projection(&UsageRecord {
            mode: Some("pdf".into()),
            ..proj_rec("paper.open", serde_json::Value::Null)
        })
        .expect("paper.open projects");
        assert_eq!(open.name, "paper_opened");
        assert_eq!(open.facet.as_deref(), Some("pdf"));

        // Not on the out-bound allowlist.
        assert!(telemetry_projection(&proj_rec("paper.focus", serde_json::Value::Null)).is_none());
        assert!(
            telemetry_projection(&proj_rec("paper.edit-meta", serde_json::Value::Null)).is_none()
        );
    }

    #[test]
    fn projection_buckets_session_duration() {
        let p = telemetry_projection(&UsageRecord {
            dur_ms: Some(45_000),
            ..proj_rec("paper.session", serde_json::Value::Null)
        })
        .expect("paper.session projects");
        assert_eq!(p.name, "paper_session");
        assert_eq!(p.dur_bucket, Some("10-60s"));
    }
}
