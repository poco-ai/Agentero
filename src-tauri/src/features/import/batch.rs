use std::collections::HashMap;
use std::path::Path;

use crate::features::catalog::papers;

use super::parse::{self, extract_primary_identifier, SkillSource};
use super::resolver::ResolvedIdentifier;
use super::SkippedImport;

pub(crate) enum SkillBatchMode {
    Collect,
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    RejectRemote,
}

pub(crate) struct PendingIdentifierImport {
    pub raw: String,
}

pub(crate) struct PendingSkillImport {
    pub raw: String,
    pub source: SkillSource,
}

pub(crate) struct IdentifierBatchPreflight {
    pub papers: Vec<PendingIdentifierImport>,
    pub skills: Vec<PendingSkillImport>,
    /// Free text with no recognizable identifier → title/keyword search.
    pub queries: Vec<String>,
    pub skipped: Vec<SkippedImport>,
    pub errors: Vec<String>,
}

pub(crate) fn preflight_identifier_batch(
    texts: &[String],
    catalog_root: &Path,
    skill_mode: SkillBatchMode,
    remote_catalog: bool,
) -> IdentifierBatchPreflight {
    let mut papers = Vec::new();
    let mut skills = Vec::new();
    let mut queries = Vec::new();
    let mut skipped = Vec::new();
    let mut errors = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();

    for input in texts {
        let input = input.trim();
        if input.is_empty() {
            continue;
        }
        let units = match classify_segment(input) {
            Segment::Identifiers(units) => units,
            Segment::Query(query) => {
                queries.push(query);
                continue;
            }
        };

        for (raw, ident) in units {
            let raw = raw.as_str();
            // Skill 分流不在 resolver 表内：由 extract_skill_source 判定。
            let skill = parse::extract_skill_source(raw);
            if skill.is_some() && matches!(skill_mode, SkillBatchMode::RejectRemote) {
                errors.push(format!(
                    "{raw}: skill import is not supported for remote vaults"
                ));
                continue;
            }

            let kind_str = ident.kind.to_string();
            let dedup_key = format!("{kind_str}:{}", ident.value);
            if seen.contains_key(&dedup_key) {
                skipped.push(SkippedImport {
                    raw: raw.to_string(),
                    kind: kind_str,
                    value: ident.value.clone(),
                    reason: "duplicate_in_batch".to_string(),
                });
                continue;
            }
            seen.insert(dedup_key, raw.to_string());

            if let Some(source) = skill {
                skills.push(PendingSkillImport {
                    raw: raw.to_string(),
                    source,
                });
                continue;
            }

            if let Some(column) = ident.catalog_column {
                match papers::find_by_identifier(catalog_root, column, &ident.value) {
                    Ok(Some(_record)) => {
                        skipped.push(SkippedImport {
                            raw: raw.to_string(),
                            kind: kind_str.clone(),
                            value: ident.value.clone(),
                            reason: "already_in_library".to_string(),
                        });
                        continue;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        if remote_catalog {
                            log::warn!("remote catalog lookup failed for {}: {e}", ident.value);
                        } else {
                            log::warn!("catalog lookup failed for {}: {e}", ident.value);
                        }
                    }
                }
            }

            papers.push(PendingIdentifierImport {
                raw: raw.to_string(),
            });
        }
    }

    IdentifierBatchPreflight {
        papers,
        skills,
        queries,
        skipped,
        errors,
    }
}

enum Segment {
    Identifiers(Vec<(String, ResolvedIdentifier)>),
    Query(String),
}

/// Classify one input segment. Space-separated identifier lists still expand
/// (`"1706.03762 10.1038/…"`); anything else with no identifier is free text.
///
/// Only single tokens are matched as a whole: the DOI / ISBN resolvers scan
/// the entire string, so a whole-segment match on multi-word input would
/// swallow the rest of a list or a title.
fn classify_segment(input: &str) -> Segment {
    let tokens: Vec<&str> = input.split_whitespace().collect();
    if tokens.len() <= 1 {
        return match extract_primary_identifier(input) {
            Some(ident) => Segment::Identifiers(vec![(input.to_string(), ident)]),
            None => Segment::Query(input.to_string()),
        };
    }

    // Skill sources (`npx skills add …`) are the only identifiers with spaces.
    if let Some(ident) = parse::skill_identifier(input) {
        return Segment::Identifiers(vec![(input.to_string(), ident)]);
    }

    let mut units = Vec::with_capacity(tokens.len());
    for token in &tokens {
        let Some(ident) = extract_primary_identifier(token) else {
            return Segment::Query(input.to_string());
        };
        units.push((token.to_string(), ident));
    }
    Segment::Identifiers(units)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(input: &str) -> Option<Vec<&'static str>> {
        match classify_segment(input) {
            Segment::Identifiers(units) => Some(units.into_iter().map(|(_, i)| i.kind).collect()),
            Segment::Query(_) => None,
        }
    }

    #[test]
    fn keeps_multi_word_skill_command_intact() {
        assert_eq!(
            kinds("npx skills add anthropics/skills --skill pptx"),
            Some(vec!["skill"])
        );
    }

    #[test]
    fn expands_space_separated_identifiers() {
        assert_eq!(
            kinds("1706.03762 10.1038/nature12373"),
            Some(vec!["arxiv", "doi"])
        );
    }

    #[test]
    fn treats_free_text_as_query() {
        assert!(matches!(
            classify_segment("Attention is all you need"),
            Segment::Query(q) if q == "Attention is all you need"
        ));
        assert!(matches!(classify_segment("AlphaFold"), Segment::Query(_)));
    }

    #[test]
    fn does_not_swallow_a_title_containing_a_doi_fragment() {
        assert!(matches!(
            classify_segment("Revisiting 10.1038/nature12373 and friends"),
            Segment::Query(_)
        ));
    }
}
