use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::File;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LayoutInputReadiness {
    Ready,
    NeedsContentRepair { pages: Vec<usize> },
    NeedsAudit,
    Incomplete,
}

impl LayoutInputReadiness {
    pub(crate) fn needs_layout_analysis(&self) -> bool {
        !matches!(self, Self::Ready)
    }

    pub(crate) fn force_layout_analysis(&self) -> bool {
        matches!(self, Self::NeedsContentRepair { .. })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutSidecar {
    schema_version: u64,
    source: LayoutSource,
    regions: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutSource {
    #[serde(default)]
    completeness: Option<LayoutCompleteness>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutCompleteness {
    page_count: usize,
    processed_pages: Vec<usize>,
    text_layer_complete: bool,
    page_stats: Vec<LayoutPageStats>,
    #[serde(default)]
    warnings: Vec<LayoutCompletenessWarning>,
    #[serde(default)]
    content_repair_attempted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutPageStats {
    page_index: usize,
}

#[derive(Debug, Deserialize)]
struct LayoutCompletenessWarning {
    code: String,
    pages: Vec<usize>,
}

fn complete_page_indexes(page_count: usize) -> HashSet<usize> {
    (0..page_count).collect()
}

fn readiness_from_sidecar(sidecar: LayoutSidecar) -> LayoutInputReadiness {
    if sidecar.schema_version != 3 || sidecar.regions.iter().any(Value::is_null) {
        return LayoutInputReadiness::Incomplete;
    }
    let Some(completeness) = sidecar.source.completeness else {
        return LayoutInputReadiness::NeedsAudit;
    };
    if completeness.page_count == 0 || !completeness.text_layer_complete {
        return LayoutInputReadiness::Incomplete;
    }
    let expected = complete_page_indexes(completeness.page_count);
    if completeness.processed_pages.len() != expected.len()
        || completeness
            .processed_pages
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            != expected
        || completeness.page_stats.len() != expected.len()
        || completeness
            .page_stats
            .iter()
            .map(|page| page.page_index)
            .collect::<HashSet<_>>()
            != expected
    {
        return LayoutInputReadiness::Incomplete;
    }
    let mut warning_pages = Vec::new();
    for warning in completeness.warnings {
        if warning.code != "content-gap" {
            return LayoutInputReadiness::Incomplete;
        }
        warning_pages.extend(warning.pages);
    }
    warning_pages.sort_unstable();
    warning_pages.dedup();
    if warning_pages.is_empty() || completeness.content_repair_attempted {
        LayoutInputReadiness::Ready
    } else {
        LayoutInputReadiness::NeedsContentRepair {
            pages: warning_pages,
        }
    }
}

pub(crate) fn read_layout_input_readiness(paper_dir: &Path) -> LayoutInputReadiness {
    let path = paper_dir.join("source/layout.json");
    let Ok(file) = File::open(path) else {
        return LayoutInputReadiness::NeedsAudit;
    };
    let Ok(sidecar) = serde_json::from_reader::<_, LayoutSidecar>(file) else {
        return LayoutInputReadiness::Incomplete;
    };
    readiness_from_sidecar(sidecar)
}

#[cfg(test)]
mod tests {
    use super::{readiness_from_sidecar, LayoutInputReadiness, LayoutSidecar};
    use serde_json::{json, Value};

    fn completeness(warnings: Value, attempted: bool) -> Value {
        json!({
            "pageCount": 3,
            "processedPages": [0, 1, 2],
            "textLayerComplete": true,
            "pageStats": [
                {"pageIndex": 0, "regionCount": 2, "textChars": 400, "translatableRegionCount": 2},
                {"pageIndex": 1, "regionCount": 0, "textChars": 0, "translatableRegionCount": 0},
                {"pageIndex": 2, "regionCount": 1, "textChars": 200, "translatableRegionCount": 0}
            ],
            "warnings": warnings,
            "contentRepairAttempted": attempted
        })
    }

    fn sidecar(completeness: Value) -> LayoutSidecar {
        serde_json::from_value(json!({
            "schemaVersion": 3,
            "source": {"mode": "embedpdf-layout", "generatedAt": "now", "completeness": completeness},
            "regions": [{"id": "body"}]
        }))
        .unwrap()
    }

    #[test]
    fn complete_sidecar_is_ready() {
        assert_eq!(
            readiness_from_sidecar(sidecar(completeness(json!([]), false))),
            LayoutInputReadiness::Ready
        );
    }

    #[test]
    fn content_warning_requests_one_repair_then_becomes_ready() {
        let warning = json!([{"code": "content-gap", "pages": [2]}]);
        assert_eq!(
            readiness_from_sidecar(sidecar(completeness(warning.clone(), false))),
            LayoutInputReadiness::NeedsContentRepair { pages: vec![2] }
        );
        assert_eq!(
            readiness_from_sidecar(sidecar(completeness(warning, true))),
            LayoutInputReadiness::Ready
        );
    }

    #[test]
    fn missing_completeness_is_audited_without_a_forced_model_run() {
        let sidecar: LayoutSidecar = serde_json::from_value(json!({
            "schemaVersion": 3,
            "source": {"mode": "embedpdf-layout", "generatedAt": "now"},
            "regions": [{"id": "body"}]
        }))
        .unwrap();
        let readiness = readiness_from_sidecar(sidecar);
        assert_eq!(readiness, LayoutInputReadiness::NeedsAudit);
        assert!(readiness.needs_layout_analysis());
        assert!(!readiness.force_layout_analysis());
    }

    #[test]
    fn failed_text_layer_or_missing_page_is_incomplete() {
        let mut failed = completeness(json!([]), false);
        failed["textLayerComplete"] = json!(false);
        assert_eq!(
            readiness_from_sidecar(sidecar(failed)),
            LayoutInputReadiness::Incomplete
        );

        let mut missing = completeness(json!([]), false);
        missing["processedPages"] = json!([0, 1]);
        assert_eq!(
            readiness_from_sidecar(sidecar(missing)),
            LayoutInputReadiness::Incomplete
        );
    }
}
