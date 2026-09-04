//! Read-only Markdown projections for resolved `![[...]]` references.
//!
//! Resolution remains owned by `resolve.rs`; this module only maps the exact
//! resolved anchor to a source slice suitable for a nested read-only renderer.

use crate::features::wiki::models::{LinkFragment, WikiDocument};
use crate::features::wiki::resolve::{fragment_anchors, FragmentAnchor};

fn line_starts(markdown: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (index, byte) in markdown.bytes().enumerate() {
        if byte == b'\n' {
            starts.push(index + 1);
        }
    }
    starts
}

fn line_start(starts: &[usize], line: u32, fallback: usize) -> usize {
    line.checked_sub(1)
        .and_then(|index| starts.get(index as usize))
        .copied()
        .unwrap_or(fallback)
}

/// Select a whole Markdown document, one heading section, or one indexed block.
///
/// Heading projections include the matched heading and continue until the next
/// heading at the same or a higher level. Block projections use the exact line
/// currently indexed for the block ID.
pub fn project_markdown(
    markdown: &str,
    document: &WikiDocument,
    fragment: Option<&LinkFragment>,
) -> Option<String> {
    let Some(fragment) = fragment else {
        return Some(markdown.to_string());
    };
    let anchors = fragment_anchors(document, fragment);
    if anchors.len() != 1 {
        return None;
    }

    let starts = line_starts(markdown);
    match anchors[0] {
        FragmentAnchor::Heading(anchor) => {
            let start = line_start(&starts, anchor.line, markdown.len());
            let end_line = document
                .headings
                .iter()
                .find(|heading| heading.line > anchor.line && heading.level <= anchor.level)
                .map(|heading| heading.line);
            let end = end_line
                .map(|line| line_start(&starts, line, markdown.len()))
                .unwrap_or(markdown.len());
            Some(markdown[start..end].to_string())
        }
        FragmentAnchor::Block(anchor) => {
            let start = line_start(&starts, anchor.line, markdown.len());
            let end = line_start(&starts, anchor.line + 1, markdown.len());
            Some(markdown[start..end].to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::wiki::extract::extract_document;
    use crate::features::wiki::models::LinkFragment;

    const SOURCE: &str = "---\naliases: [Target]\n---\n# Root\nintro\n## Child\nchild text\n### Nested\nnested text\n## Sibling\nsibling text\nBlock text ^验收块\n# End\nend text\n";

    #[test]
    fn projects_the_whole_document_without_rewriting_source() {
        let (document, _) = extract_document("notes/Target.md", SOURCE);
        assert_eq!(
            project_markdown(SOURCE, &document, None).as_deref(),
            Some(SOURCE)
        );
    }

    #[test]
    fn projects_one_heading_section_through_its_nested_headings() {
        let (document, _) = extract_document("notes/Target.md", SOURCE);
        let projected = project_markdown(
            SOURCE,
            &document,
            Some(&LinkFragment::Heading {
                path: vec!["Root".into(), "Child".into()],
            }),
        )
        .expect("heading projection");

        assert_eq!(projected, "## Child\nchild text\n### Nested\nnested text\n");
    }

    #[test]
    fn projects_only_the_indexed_block_line() {
        let (document, _) = extract_document("notes/Target.md", SOURCE);
        let projected = project_markdown(
            SOURCE,
            &document,
            Some(&LinkFragment::Block {
                id: "验收块".into(),
            }),
        )
        .expect("block projection");

        assert_eq!(projected, "Block text ^验收块\n");
    }
}
