//! Target-venue inference from an arXiv e-print's LaTeX source, projected onto
//! catalog tags.
//!
//! Two confidence tiers live in separate tag namespaces:
//! - `#submitted:<VENUE> <YEAR>` — inferred from the LaTeX template
//!   (`\documentclass` / `\usepackage` / bundled `.sty`/`.cls` names), i.e. the
//!   venue the paper was formatted for.
//! - `#venue:<PUBLICATION>` — the authoritative venue from catalog metadata
//!   (`publication`, filled by Crossref/OpenAlex/etc.). When present it replaces
//!   any `#submitted:` guess.
//!
//! Rules:
//! - Authoritative venue present → write `#venue:`, drop `#submitted:`.
//! - Otherwise → add `#submitted:` only when no venue/submitted tag exists yet
//!   (and no user tag already names that venue).

use crate::error::AppError;
use crate::features::paper::catalog::papers::{self, PaperRecord, PaperTag};
use std::fs;
use std::io::Read;
use std::path::Path;
use walkdir::WalkDir;

/// Tag namespace for the authoritative published venue.
pub const VENUE_TAG_PREFIX: &str = "#venue:";
/// Tag namespace for the template-inferred submission target.
pub const SUBMITTED_TAG_PREFIX: &str = "#submitted:";

/// Upper bounds keeping detection cheap on e-prints with hundreds of files.
const MAX_TEX_FILES: usize = 200;
const MAX_TEX_HEAD_BYTES: u64 = 256 * 1024;

/// Whether `name` is an authoritative venue tag.
pub fn is_venue_tag_name(name: &str) -> bool {
    name.trim()
        .to_ascii_lowercase()
        .starts_with(VENUE_TAG_PREFIX)
}

/// Whether `name` is a template-inferred submission tag.
pub fn is_submitted_tag_name(name: &str) -> bool {
    name.trim()
        .to_ascii_lowercase()
        .starts_with(SUBMITTED_TAG_PREFIX)
}

/// One template token mapped to its venue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedVenue {
    /// Abbreviated venue, e.g. `AAAI`.
    pub venue: &'static str,
    /// Four-digit year when the template token carries one.
    pub year: Option<u16>,
    /// The source token that matched (for logs / tests).
    pub evidence: String,
}

impl DetectedVenue {
    /// `#submitted:AAAI 2027` (or without the year when unknown).
    pub fn submitted_tag_name(&self) -> String {
        match self.year {
            Some(year) => format!("{SUBMITTED_TAG_PREFIX}{} {year}", self.venue),
            None => format!("{SUBMITTED_TAG_PREFIX}{}", self.venue),
        }
    }
}

/// Curated template-token prefixes → venue abbreviation. Kept short and
/// conservative: only tokens that unambiguously name a venue belong here, so a
/// generic `article`/`elsarticle`/`IEEEtran` never produces a tag.
const VENUE_TABLE: &[(&str, &str)] = &[
    ("aaai", "AAAI"),
    ("ijcai", "IJCAI"),
    ("iclr", "ICLR"),
    ("icml", "ICML"),
    ("neurips", "NeurIPS"),
    ("nips", "NeurIPS"),
    ("cvpr", "CVPR"),
    ("iccv", "ICCV"),
    ("eccv", "ECCV"),
    ("wacv", "WACV"),
    ("emnlp", "EMNLP"),
    ("naacl", "NAACL"),
    ("coling", "COLING"),
    ("colm", "COLM"),
    ("acl", "ACL"),
    ("tacl", "TACL"),
    ("sigkdd", "KDD"),
    ("kdd", "KDD"),
    ("sigir", "SIGIR"),
    ("www", "WWW"),
    ("miccai", "MICCAI"),
    ("ijcv", "IJCV"),
    ("tpami", "TPAMI"),
    ("tkde", "TKDE"),
    ("jmlr", "JMLR"),
    ("aistats", "AISTATS"),
    ("uai", "UAI"),
    ("icra", "ICRA"),
    ("iros", "IROS"),
    ("corl", "CoRL"),
    ("osdi", "OSDI"),
    ("sosp", "SOSP"),
    ("nsdi", "NSDI"),
    ("ndss", "NDSS"),
];

/// Map one lowercased template token (file stem or package/class name) to a
/// venue. Trailing digits are read as a year (`aaai26` → 2026,
/// `iclr2027_conference` → 2027, `acl_natbib` → no year).
fn match_token(token: &str) -> Option<DetectedVenue> {
    let token = token.trim().trim_start_matches('*');
    if token.is_empty() {
        return None;
    }
    for (prefix, venue) in VENUE_TABLE {
        if let Some(rest) = token.strip_prefix(prefix) {
            return Some(DetectedVenue {
                venue,
                year: extract_year(rest),
                evidence: token.to_string(),
            });
        }
    }
    None
}

/// First 2- or 4-digit run in `rest`, interpreted as a year. 2-digit values are
/// 20xx (conference templates never carry a 19xx two-digit year).
fn extract_year(rest: &str) -> Option<u16> {
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            let run = &rest[start..i];
            match run.len() {
                2 => return Some(2000 + run.parse::<u16>().ok()?),
                4 => {
                    let year = run.parse::<u16>().ok()?;
                    if (1980..=2099).contains(&year) {
                        return Some(year);
                    }
                }
                _ => {}
            }
        } else {
            i += 1;
        }
    }
    None
}

/// Infer the target venue from a paper's `source/` tree. `None` when the source
/// is absent/PDF-only or no known template token matches.
pub fn detect_venue(source_dir: &Path) -> Option<DetectedVenue> {
    if !source_dir.is_dir() {
        return None;
    }
    let mut doc_tokens: Vec<String> = Vec::new();
    let mut file_tokens: Vec<String> = Vec::new();
    let mut pkg_tokens: Vec<String> = Vec::new();
    let mut tex_read = 0usize;

    for entry in WalkDir::new(source_dir)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match ext.as_str() {
            "sty" | "cls" | "bst" => {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    file_tokens.push(stem.to_ascii_lowercase());
                }
            }
            "tex" => {
                if tex_read >= MAX_TEX_FILES {
                    continue;
                }
                tex_read += 1;
                if let Some(head) = read_head(path, MAX_TEX_HEAD_BYTES) {
                    collect_cmd_args(&head, "\\documentclass", &mut doc_tokens);
                    collect_cmd_args(&head, "\\usepackage", &mut pkg_tokens);
                }
            }
            _ => {}
        }
    }

    // Priority: explicit document class, then bundled template files, then
    // packages.
    doc_tokens
        .iter()
        .chain(file_tokens.iter())
        .chain(pkg_tokens.iter())
        .find_map(|token| match_token(token))
}

/// Read at most `limit` bytes as lossy UTF-8 (LaTeX preambles are ASCII-ish).
fn read_head(path: &Path, limit: u64) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; limit as usize];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Append the comma-split braced arguments of every `cmd` occurrence in
/// `content` (e.g. `\usepackage[opt]{a,b}` → `a`, `b`).
fn collect_cmd_args(content: &str, cmd: &str, out: &mut Vec<String>) {
    let mut from = 0;
    while let Some(pos) = content[from..].find(cmd) {
        let at = from + pos;
        let after_cmd = &content[at + cmd.len()..];
        // Guard against a longer command sharing the prefix (`\documentclassx`).
        if after_cmd
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        {
            from = at + cmd.len();
            continue;
        }
        if let Some(group) = group_after(after_cmd) {
            for name in group.split(',') {
                let name = name.trim().trim_start_matches('*').trim();
                if !name.is_empty() {
                    out.push(name.to_ascii_lowercase());
                }
            }
        }
        from = at + cmd.len();
    }
}

/// First `{...}` group in `s` (skips a preceding `[...]` naturally).
fn group_after(s: &str) -> Option<&str> {
    let open = s.find('{')?;
    let rest = &s[open + 1..];
    let close = rest.find('}')?;
    Some(&rest[..close])
}

/// Whether a user tag already names `venue` (bare `ICLR`, or namespaced
/// `#venue:ICLR 2027`).
fn tag_names_venue(name: &str, venue: &str) -> bool {
    let mut normalized = name.trim().to_ascii_lowercase();
    for prefix in [VENUE_TAG_PREFIX, SUBMITTED_TAG_PREFIX] {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            normalized = rest.to_string();
            break;
        }
    }
    let venue = venue.to_ascii_lowercase();
    normalized == venue || normalized.starts_with(&format!("{venue} "))
}

/// Pure decision over the current tags + metadata + detection result.
#[derive(Debug, PartialEq, Eq)]
pub enum VenueTagUpdate {
    /// Nothing to write.
    None,
    /// Full replacement tag list (caller persists it).
    Set(Vec<PaperTag>),
}

/// Decide the next tag set for a paper.
pub fn plan_venue_tags(
    existing: &[PaperTag],
    publication: Option<&str>,
    detected: Option<&DetectedVenue>,
) -> VenueTagUpdate {
    // Authoritative published venue wins and replaces any submission guess.
    if let Some(publication) = publication.map(str::trim).filter(|s| !s.is_empty()) {
        let target = PaperTag::new(format!("{VENUE_TAG_PREFIX}{publication}"));
        let has_submitted = existing.iter().any(|t| is_submitted_tag_name(&t.name));
        let venue_tags: Vec<&PaperTag> = existing
            .iter()
            .filter(|t| is_venue_tag_name(&t.name))
            .collect();
        if !has_submitted
            && venue_tags.len() == 1
            && venue_tags[0]
                .name
                .trim()
                .eq_ignore_ascii_case(target.name.trim())
        {
            return VenueTagUpdate::None;
        }
        let mut next: Vec<PaperTag> = existing
            .iter()
            .filter(|t| !is_venue_tag_name(&t.name) && !is_submitted_tag_name(&t.name))
            .cloned()
            .collect();
        next.push(target);
        return VenueTagUpdate::Set(next);
    }

    // Template path: once any venue/submitted tag exists, leave it alone.
    if existing
        .iter()
        .any(|t| is_venue_tag_name(&t.name) || is_submitted_tag_name(&t.name))
    {
        return VenueTagUpdate::None;
    }
    let Some(detected) = detected else {
        return VenueTagUpdate::None;
    };
    if existing
        .iter()
        .any(|t| tag_names_venue(&t.name, detected.venue))
    {
        return VenueTagUpdate::None;
    }
    let mut next = existing.to_vec();
    next.push(PaperTag::new(detected.submitted_tag_name()));
    VenueTagUpdate::Set(next)
}

/// Recompute the venue tags for one paper. Returns the tag written, or `None`
/// when nothing changed.
pub fn refresh_venue_tag(
    vault_root: &Path,
    paper_path: &str,
) -> Result<Option<PaperTag>, AppError> {
    let Some(record) = papers::get_by_path(vault_root, paper_path)? else {
        return Ok(None);
    };
    let source_dir = vault_root.join(paper_path).join("source");
    let detected = detect_venue(&source_dir);
    match plan_venue_tags(
        &record.tags,
        record.publication.as_deref(),
        detected.as_ref(),
    ) {
        VenueTagUpdate::None => Ok(None),
        VenueTagUpdate::Set(tags) => {
            let written = tags.last().cloned();
            papers::set_tags(vault_root, paper_path, &tags)?;
            Ok(written)
        }
    }
}

/// Recompute venue tags for many papers (manual backfill). Returns the current
/// catalog rows for every path that still exists; a single failure is logged
/// and skipped so one bad paper cannot abort the batch.
pub fn refresh_venue_tags(
    vault_root: &Path,
    paper_paths: &[String],
) -> Result<Vec<PaperRecord>, AppError> {
    let mut out = Vec::with_capacity(paper_paths.len());
    for raw in paper_paths {
        let path = raw.trim().trim_matches('/').replace('\\', "/");
        if path.is_empty() {
            continue;
        }
        if let Err(e) = refresh_venue_tag(vault_root, &path) {
            log::warn!(target: "agentero::paper", "venue tag refresh failed for {path}: {e}");
        }
        if let Some(row) = papers::get_by_path(vault_root, &path)? {
            out.push(row);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tag(name: &str) -> PaperTag {
        PaperTag::new(name)
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn source_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir_all(&source).unwrap();
        (dir, source)
    }

    #[test]
    fn match_token_reads_venue_and_year() {
        assert_eq!(match_token("aaai26").unwrap().venue, "AAAI");
        assert_eq!(match_token("aaai26").unwrap().year, Some(2026));
        assert_eq!(match_token("iclr2027_conference").unwrap().year, Some(2027));
        assert_eq!(match_token("neurips_2026").unwrap().venue, "NeurIPS");
        assert_eq!(match_token("neurips_2026").unwrap().year, Some(2026));
        assert_eq!(match_token("nips2017").unwrap().venue, "NeurIPS");
        assert_eq!(match_token("acl_natbib").unwrap().venue, "ACL");
        assert_eq!(match_token("acl_natbib").unwrap().year, None);
        assert!(match_token("article").is_none());
        assert!(match_token("elsarticle").is_none());
    }

    #[test]
    fn detect_venue_prefers_documentclass_then_sty() {
        let (_dir, source) = source_dir();
        write(
            &source.join("main.tex"),
            "\\documentclass[11pt]{aaai26}\n\\usepackage{times}\n",
        );
        let detected = detect_venue(&source).expect("detected");
        assert_eq!(detected.venue, "AAAI");
        assert_eq!(detected.year, Some(2026));

        let (_dir2, source2) = source_dir();
        write(&source2.join("main.tex"), "\\documentclass{article}\n");
        write(&source2.join("iclr2027.sty"), "% template\n");
        let detected2 = detect_venue(&source2).expect("detected from sty");
        assert_eq!(detected2.venue, "ICLR");
        assert_eq!(detected2.year, Some(2027));
    }

    #[test]
    fn detect_venue_uses_usepackage_fallback() {
        let (_dir, source) = source_dir();
        write(
            &source.join("paper.tex"),
            "\\documentclass{article}\n\\usepackage[final]{neurips_2026}\n",
        );
        let detected = detect_venue(&source).expect("detected");
        assert_eq!(detected.venue, "NeurIPS");
        assert_eq!(detected.year, Some(2026));
    }

    #[test]
    fn plan_skips_when_a_tag_already_exists() {
        let detected = DetectedVenue {
            venue: "ICLR",
            year: Some(2027),
            evidence: "iclr2027".into(),
        };
        // Already `#submitted:` → no change.
        assert_eq!(
            plan_venue_tags(&[tag("#submitted:AAAI 2026")], None, Some(&detected)),
            VenueTagUpdate::None
        );
        // Already `#venue:` → no change.
        assert_eq!(
            plan_venue_tags(&[tag("#venue:ICLR")], None, Some(&detected)),
            VenueTagUpdate::None
        );
        // A bare user tag naming the venue → no change.
        assert_eq!(
            plan_venue_tags(&[tag("ICLR")], None, Some(&detected)),
            VenueTagUpdate::None
        );
    }

    #[test]
    fn plan_adds_submitted_tag_when_untagged() {
        let detected = DetectedVenue {
            venue: "AAAI",
            year: Some(2027),
            evidence: "aaai27".into(),
        };
        assert_eq!(
            plan_venue_tags(&[tag("nlp")], None, Some(&detected)),
            VenueTagUpdate::Set(vec![tag("nlp"), tag("#submitted:AAAI 2027")])
        );
    }

    #[test]
    fn plan_overwrites_submitted_with_authoritative_venue() {
        let existing = vec![tag("nlp"), tag("#submitted:AAAI 2027")];
        assert_eq!(
            plan_venue_tags(&existing, Some("ICLR"), None),
            VenueTagUpdate::Set(vec![tag("nlp"), tag("#venue:ICLR")])
        );
    }

    #[test]
    fn plan_is_noop_when_authoritative_tag_matches() {
        let existing = vec![tag("#venue:ICLR")];
        assert_eq!(
            plan_venue_tags(&existing, Some("ICLR"), None),
            VenueTagUpdate::None
        );
    }
}
