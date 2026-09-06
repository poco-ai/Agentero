//! Import-side identifier orchestration.
//!
//! Skill sources are diverted up front (front-dispatch outside the resolver
//! table); everything else is probed through
//! [`scholar_api::identifiers`](crate::features::scholar_api::identifiers) in
//! priority order.

use crate::features::scholar_api::identifiers::{skill_identifier, ResolvedIdentifier};

/// Returns the first recognized identifier in `text`.
pub fn extract_primary_identifier(text: &str) -> Option<ResolvedIdentifier> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    if let Some(ident) = skill_identifier(t) {
        return Some(ident);
    }
    crate::features::scholar_api::identifiers::extract(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::scholar_api::identifiers::{extract_skill_source, SKILL_KIND};

    #[test]
    fn extract_primary_identifier_priority_order() {
        // Locks the detection order: Skill → URL → DOI → arXiv → ISBN →
        // PMID → ADS. Same input hitting multiple sources must resolve to
        // the higher-priority kind.
        let cases: &[(&str, &'static str, &str)] = &[
            // Skill wins over the URL branch (GitHub repo URL is not a paper URL).
            (
                "https://github.com/openai/skills",
                SKILL_KIND,
                "https://github.com/openai/skills",
            ),
            // URL wins over the DOI embedded in it.
            (
                "https://doi.org/10.1038/nature12373",
                "url",
                "https://doi.org/10.1038/nature12373",
            ),
            // DOI wins over the arXiv id embedded in it.
            (
                "10.48550/arXiv.1706.03762",
                "doi",
                "10.48550/arXiv.1706.03762",
            ),
            ("1706.03762", "arxiv", "1706.03762"),
            ("978-0-262-03384-8", "isbn", "9780262033848"),
            ("PMID:24297125", "pmid", "24297125"),
            ("2015ApJ...810...89S", "ads", "2015ApJ...810...89S"),
        ];
        for (input, want_kind, want_value) in cases {
            let ident =
                extract_primary_identifier(input).unwrap_or_else(|| panic!("no match: {input}"));
            assert_eq!(ident.kind, *want_kind, "kind for {input}");
            assert_eq!(ident.value, *want_value, "value for {input}");
        }
    }

    #[test]
    fn extract_primary_identifier_does_not_swallow_titles() {
        // Titles containing an identifier-looking fragment stay unrecognized
        // (multi-token input must go through batch classification instead).
        assert_eq!(
            extract_primary_identifier("Attention is all you need"),
            None
        );
        assert_eq!(
            extract_primary_identifier("Revisiting 1706.03762 and friends"),
            None
        );
    }

    #[test]
    fn parses_requested_skill_import_examples() {
        for input in [
            "https://github.com/mattpocock/skills",
            "https://github.com/alchaincyf/nuwa-skill",
        ] {
            let ident = extract_primary_identifier(input).unwrap();
            assert_eq!(ident.kind, SKILL_KIND);
            assert_eq!(ident.value, input);
        }

        let input = "npx skills add https://github.com/anthropics/skills --skill pptx";
        let ident = extract_primary_identifier(input).unwrap();
        assert_eq!(ident.kind, SKILL_KIND);
        assert_eq!(ident.value, input);
        let source = extract_skill_source(input).unwrap();
        assert_eq!(source.owner, "anthropics");
        assert_eq!(source.repo, "skills");
        assert_eq!(source.skill_names, vec!["pptx"]);
    }
}
