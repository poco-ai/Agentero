use super::snapshot::SyncScope;
use crate::features::paper::identity::is_paper_marker_file;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Category {
    Pdf,
    Source,
    Attachments,
}

impl Category {
    pub(super) fn enabled(self, scope: &SyncScope) -> bool {
        match self {
            Self::Pdf => scope.pdf,
            Self::Source => scope.source,
            Self::Attachments => scope.attachments,
        }
    }

    pub(super) fn is_directory(self) -> bool {
        matches!(self, Self::Source | Self::Attachments)
    }
}

pub(super) fn paper_roots<'a>(paths: impl IntoIterator<Item = &'a str>) -> HashSet<String> {
    paths
        .into_iter()
        .filter(|path| path.starts_with("papers/"))
        .filter_map(|path| {
            let (parent, name) = path.rsplit_once('/')?;
            is_paper_marker_file(name).then(|| parent.to_owned())
        })
        .collect()
}

/// Classify a vault-relative path and return the file or asset directory that
/// controls its scope. The first paper-internal directory owns its subtree.
pub(super) fn classify<'a>(path: &'a str, roots: &HashSet<String>) -> Option<(Category, &'a str)> {
    let rest = path.strip_prefix("papers/")?;
    let (first_dir, tail) = rest.split_once('/')?;
    let mut end = "papers/".len() + first_dir.len();
    for component in tail.split('/') {
        end += 1 + component.len();
        let category = match component {
            "source" => Category::Source,
            "attachments" => Category::Attachments,
            "assets" | "marks" => return None,
            _ => continue,
        };
        return Some((category, &path[..end]));
    }
    let (parent, file) = path.rsplit_once('/')?;
    let (stem, ext) = file.rsplit_once('.')?;
    let (groups, folder) = parent.rsplit_once('/')?;
    if ext.eq_ignore_ascii_case("pdf")
        && (groups == "papers" || stem.eq_ignore_ascii_case(folder) || roots.contains(parent))
    {
        return Some((Category::Pdf, path));
    }
    None
}

pub(super) fn excluded(scope: &SyncScope, path: &str, roots: &HashSet<String>) -> bool {
    !scope.is_all() && classify(path, roots).is_some_and(|(category, _)| !category.enabled(scope))
}
