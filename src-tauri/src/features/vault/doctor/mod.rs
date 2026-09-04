//! Read-only Vault diagnostics and conservative paper-alias / wikilink repair.

#[cfg(feature = "desktop")]
pub mod commands;
pub mod visual_marks_repair;
pub mod wikilink_repair;

pub use visual_marks_repair::{
    apply_visual_mark_repairs, scan_visual_marks, VisualMarkCandidate, VisualMarkRepairChange,
    VisualMarkRepairResult, VisualMarksDoctorSection,
};
pub use wikilink_repair::{
    apply_wikilink_repairs, plan_wikilink_repairs, WikilinkRepairChange, WikilinkRepairPlan,
    WikilinkRepairResidual, WikilinkRepairResult, WikilinkRepairSuggestion,
};

use crate::core::error::AppError;
use crate::features::catalog::papers::{self, DuplicateRepairResult, DuplicateReport};
use crate::features::catalog::{self, papers::PaperRecord};
use crate::features::wiki::frontmatter::{inspect_aliases, patch_aliases, AliasEdit};
use crate::features::wiki::index::WikiIndex;
use crate::features::wiki::models::{WikiCheckCounts, WikiCheckResult};
use crate::features::wiki::rename::content_hash;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DoctorSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorIssue {
    pub code: String,
    pub message: String,
    pub severity: DoctorSeverity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorSection {
    pub ok: bool,
    pub issues: Vec<DoctorIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDoctorSection {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<i32>,
    pub expected_schema_version: i32,
    pub issues: Vec<DoctorIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_report: Option<DuplicateReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRepairCandidate {
    pub path: String,
    pub paper_title: String,
    pub current_aliases: Vec<String>,
    pub title_alias: String,
    pub short_alias: String,
    pub expected_hash: String,
    pub fixable: bool,
    pub selected_by_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasDoctorSection {
    pub ok: bool,
    pub checked_papers: u32,
    pub complete_papers: u32,
    pub candidates: Vec<AliasRepairCandidate>,
    /// Incomplete paper NOTES paths the user chose to ignore (persisted).
    #[serde(default)]
    pub ignored_paths: Vec<String>,
    pub issues: Vec<DoctorIssue>,
}

/// Vault-local Doctor preferences (`.agentero/doctor.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorVaultState {
    /// Relative `papers/**/NOTES.md` paths skipped by paper-alias checks.
    #[serde(default)]
    pub ignored_alias_paths: Vec<String>,
}

const DOCTOR_STATE_REL: &str = ".agentero/doctor.json";

fn normalize_rel_path(raw: &str) -> String {
    raw.replace('\\', "/").trim_matches('/').to_string()
}

fn doctor_state_path(vault: &Path) -> PathBuf {
    vault.join(DOCTOR_STATE_REL)
}

/// Load vault-local Doctor state. Missing or invalid file → empty defaults.
pub fn load_doctor_state(vault: &Path) -> DoctorVaultState {
    let path = doctor_state_path(vault);
    let Ok(raw) = fs::read_to_string(&path) else {
        return DoctorVaultState::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Persist vault-local Doctor state (creates `.agentero/` if needed).
pub fn save_doctor_state(vault: &Path, state: &DoctorVaultState) -> Result<(), AppError> {
    let path = doctor_state_path(vault);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppError::message(format!("create .agentero for doctor state: {error}"))
        })?;
    }
    let mut normalized = state
        .ignored_alias_paths
        .iter()
        .map(|path| normalize_rel_path(path))
        .filter(|path| !path.is_empty() && safe_relative_path(path))
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    let cleaned = DoctorVaultState {
        ignored_alias_paths: normalized,
    };
    let body = serde_json::to_string_pretty(&cleaned)
        .map_err(|error| AppError::message(format!("serialize doctor state: {error}")))?;
    fs::write(&path, format!("{body}\n"))
        .map_err(|error| AppError::message(format!("write doctor state: {error}")))?;
    Ok(())
}

/// Add or remove paper NOTES paths from the persisted alias-ignore list.
pub fn set_ignored_alias_paths(
    vault: &Path,
    paths: &[String],
    ignore: bool,
) -> Result<DoctorVaultState, AppError> {
    crate::core::fs::ensure_vault_dir(vault)?;
    let mut state = load_doctor_state(vault);
    let mut set = state
        .ignored_alias_paths
        .into_iter()
        .map(|path| normalize_rel_path(&path))
        .filter(|path| !path.is_empty())
        .collect::<HashSet<_>>();
    for raw in paths {
        let path = normalize_rel_path(raw);
        if path.is_empty() || !safe_relative_path(&path) {
            return Err(AppError::message(format!("invalid ignore path: {raw}")));
        }
        if ignore {
            set.insert(path);
        } else {
            set.remove(&path);
        }
    }
    state.ignored_alias_paths = set.into_iter().collect();
    save_doctor_state(vault, &state)?;
    Ok(load_doctor_state(vault))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub ok: bool,
    pub vault: DoctorSection,
    pub catalog: CatalogDoctorSection,
    pub wikilinks: WikiCheckResult,
    pub aliases: AliasDoctorSection,
    #[serde(default)]
    pub visual_marks: VisualMarksDoctorSection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRepairChange {
    pub path: String,
    pub title_alias: String,
    pub short_alias: String,
    pub expected_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRepairResult {
    pub updated_paths: Vec<String>,
}

#[derive(Default)]
pub struct DoctorDirtyPathsState {
    inner: Mutex<HashMap<String, HashSet<String>>>,
}

impl DoctorDirtyPathsState {
    pub fn set(&self, vault_path: &str, paths: &[String]) -> Result<(), String> {
        let normalized = paths
            .iter()
            .map(|path| path.replace('\\', "/").trim_matches('/').to_string())
            .collect();
        self.inner
            .lock()
            .map_err(|error| error.to_string())?
            .insert(vault_path.to_string(), normalized);
        Ok(())
    }

    pub fn get(&self, vault_path: &str) -> Result<Vec<String>, String> {
        Ok(self
            .inner
            .lock()
            .map_err(|error| error.to_string())?
            .get(vault_path)
            .map(|paths| paths.iter().cloned().collect())
            .unwrap_or_default())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorRepairError {
    pub code: String,
    pub message: String,
    pub rollback: String,
    pub paths: Vec<String>,
}

impl DoctorRepairError {
    fn new(code: &str, message: impl Into<String>, paths: Vec<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            rollback: "notNeeded".into(),
            paths,
        }
    }
}

impl fmt::Display for DoctorRepairError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

fn issue(
    code: &str,
    message: impl Into<String>,
    severity: DoctorSeverity,
    path: Option<String>,
) -> DoctorIssue {
    DoctorIssue {
        code: code.into(),
        message: message.into(),
        severity,
        path,
    }
}

/// Match the Wiki resolver's alias semantics.
pub fn normalize_alias(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn distinct_aliases(aliases: &[String]) -> usize {
    aliases
        .iter()
        .map(|alias| normalize_alias(alias))
        .filter(|alias| !alias.is_empty())
        .collect::<HashSet<_>>()
        .len()
}

fn contains_cjk(value: &str) -> bool {
    value.chars().any(|ch| {
        matches!(
            ch as u32,
            0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
        )
    })
}

fn first_author_label(authors: &[String]) -> Option<String> {
    let author = authors.first()?.trim();
    if author.is_empty() {
        return None;
    }
    if contains_cjk(author) {
        return Some(author.to_string());
    }
    author
        .split_whitespace()
        .last()
        .map(|value| value.trim_matches([',', ';']).to_string())
        .filter(|value| !value.is_empty())
}

fn concise_prefix(title: &str) -> Option<String> {
    for separator in [":", "：", " — ", " – ", " - "] {
        let Some((prefix, rest)) = title.split_once(separator) else {
            continue;
        };
        let prefix = prefix.trim();
        if !prefix.is_empty()
            && !rest.trim().is_empty()
            && prefix.chars().count() >= 3
            && prefix.chars().count() <= 48
            && prefix != title.trim()
        {
            return Some(prefix.to_string());
        }
    }
    None
}

/// Deterministic short alias used by new imports and Doctor proposals.
pub fn suggest_short_alias(title: &str, authors: &[String], year: Option<i32>) -> Option<String> {
    let title = title.trim();
    if let Some(prefix) = concise_prefix(title) {
        return Some(prefix);
    }
    if contains_cjk(title) {
        return match (first_author_label(authors), year) {
            (Some(author), Some(year)) => Some(format!("{author} {year}")),
            _ => None,
        };
    }

    let stopwords = [
        "a", "an", "the", "and", "or", "but", "for", "nor", "of", "on", "at", "to", "from", "by",
        "with", "in", "into", "over", "under",
    ];
    let initials = title
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .filter(|word| !stopwords.contains(&word.to_ascii_lowercase().as_str()))
        .filter_map(|word| word.chars().next())
        .map(|ch| ch.to_ascii_uppercase())
        .collect::<String>();
    if (2..=12).contains(&initials.len()) && normalize_alias(&initials) != normalize_alias(title) {
        return Some(initials);
    }
    match (first_author_label(authors), year) {
        (Some(author), Some(year)) => Some(format!("{author} {year}")),
        _ => None,
    }
}

fn read_only_catalog(vault: &Path) -> Result<(Connection, i32), AppError> {
    let db = catalog::catalog_db_path(vault);
    let connection = Connection::open_with_flags(
        &db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|error| AppError::message(format!("open catalog {}: {error}", db.display())))?;
    let version = catalog::schema_version(&connection)?;
    Ok((connection, version))
}

fn vault_section(vault: &Path) -> DoctorSection {
    let mut issues = Vec::new();
    if !vault.is_dir() {
        issues.push(issue(
            "vault_not_directory",
            "vault path is not a directory",
            DoctorSeverity::Error,
            None,
        ));
    } else {
        for directory in ["papers", "notes", ".agentero"] {
            if !vault.join(directory).is_dir() {
                issues.push(issue(
                    "missing_directory",
                    format!("missing directory: {directory}/"),
                    DoctorSeverity::Error,
                    Some(directory.into()),
                ));
            }
        }
    }
    DoctorSection {
        ok: issues.is_empty(),
        issues,
    }
}

fn empty_wikilinks() -> WikiCheckResult {
    WikiCheckResult {
        scope: None,
        checked_files: 0,
        counts: WikiCheckCounts::default(),
        issues: Vec::new(),
    }
}

fn alias_owners(index: &WikiIndex) -> HashMap<String, HashSet<String>> {
    let mut owners: HashMap<String, HashSet<String>> = HashMap::new();
    for document in index.documents() {
        for alias in &document.aliases {
            owners
                .entry(normalize_alias(alias))
                .or_default()
                .insert(document.path.clone());
        }
    }
    owners
}

fn occupied_by_other(
    owners: &HashMap<String, HashSet<String>>,
    alias: &str,
    current_path: &str,
) -> bool {
    owners
        .get(&normalize_alias(alias))
        .is_some_and(|paths| paths.iter().any(|path| path != current_path))
}

fn disambiguate_short(
    base: Option<String>,
    paper: &PaperRecord,
    path: &str,
    owners: &HashMap<String, HashSet<String>>,
    reserved: &HashSet<String>,
) -> Option<String> {
    let base = base?;
    let available = |candidate: &str| {
        !occupied_by_other(owners, candidate, path)
            && !reserved.contains(&normalize_alias(candidate))
            && normalize_alias(candidate) != normalize_alias(&paper.title)
    };
    if available(&base) {
        return Some(base);
    }
    if let Some(year) = paper.year {
        let candidate = format!("{base} {year}");
        if available(&candidate) {
            return Some(candidate);
        }
    }
    if let Some(author) = first_author_label(&paper.authors) {
        let candidate = format!("{base} {author}");
        if available(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn alias_section(vault: &Path, papers: &[PaperRecord], index: &WikiIndex) -> AliasDoctorSection {
    let owners = alias_owners(index);
    let ignored = load_doctor_state(vault)
        .ignored_alias_paths
        .into_iter()
        .map(|path| normalize_rel_path(&path))
        .collect::<HashSet<_>>();
    let mut report = AliasDoctorSection {
        ok: true,
        ..AliasDoctorSection::default()
    };
    let mut reserved = HashSet::new();
    let mut sorted = papers.to_vec();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));
    let mut live_ignored = Vec::new();

    for (alias, paths) in &owners {
        if !alias.is_empty() && paths.len() > 1 {
            report.issues.push(issue(
                "alias_collision",
                format!("alias resolves to multiple notes: {alias}"),
                DoctorSeverity::Warning,
                None,
            ));
        }
    }

    for paper in sorted {
        report.checked_papers += 1;
        let path = format!("{}/NOTES.md", paper.path.trim_end_matches('/'));
        let absolute = vault.join(&path);
        let content = match fs::read_to_string(&absolute) {
            Ok(content) => content,
            Err(error) => {
                report.ok = false;
                report.issues.push(issue(
                    "notes_unreadable",
                    format!("could not read paper notes: {error}"),
                    DoctorSeverity::Error,
                    Some(path),
                ));
                continue;
            }
        };
        let inspection = inspect_aliases(&content);
        if distinct_aliases(&inspection.aliases) >= 2 {
            report.complete_papers += 1;
            continue;
        }

        // User-ignored incomplete notes: still counted as checked, but not
        // reported as errors and not offered as repair candidates.
        if ignored.contains(&path) {
            live_ignored.push(path);
            continue;
        }

        let mut reason = match &inspection.edit {
            AliasEdit::Unsupported { reason } => Some(reason.clone()),
            _ => None,
        };
        let short = disambiguate_short(
            suggest_short_alias(&paper.title, &paper.authors, paper.year),
            &paper,
            &path,
            &owners,
            &reserved,
        );
        if short.is_none() && reason.is_none() {
            reason = Some("no collision-free deterministic short alias is available".into());
        }
        let short_alias = short.unwrap_or_default();
        let fixable = reason.is_none()
            && !paper.title.trim().is_empty()
            && !short_alias.is_empty()
            && normalize_alias(&paper.title) != normalize_alias(&short_alias);
        if fixable {
            reserved.insert(normalize_alias(&short_alias));
        }
        report.candidates.push(AliasRepairCandidate {
            path: path.clone(),
            paper_title: paper.title.clone(),
            current_aliases: inspection.aliases,
            title_alias: paper.title,
            short_alias,
            expected_hash: content_hash(&content),
            fixable,
            selected_by_default: fixable,
            reason,
        });
        report.issues.push(issue(
            if fixable {
                "aliases_incomplete"
            } else {
                "aliases_manual_review"
            },
            if fixable {
                "paper note has fewer than two distinct aliases"
            } else {
                "paper aliases require manual review"
            },
            DoctorSeverity::Error,
            Some(path),
        ));
        report.ok = false;
    }
    live_ignored.sort();
    report.ignored_paths = live_ignored;
    report
}

/// Run all Doctor checks without modifying the Vault or Catalog.
pub fn diagnose(vault: &Path) -> Result<DoctorReport, AppError> {
    let vault_report = vault_section(vault);
    if !vault.is_dir() {
        return Ok(DoctorReport {
            ok: false,
            vault: vault_report,
            catalog: CatalogDoctorSection {
                ok: false,
                schema_version: None,
                expected_schema_version: catalog::SCHEMA_VERSION,
                issues: vec![issue(
                    "catalog_unavailable",
                    "catalog cannot be checked without a local Vault",
                    DoctorSeverity::Error,
                    None,
                )],
                duplicate_report: None,
            },
            wikilinks: empty_wikilinks(),
            aliases: AliasDoctorSection::default(),
            visual_marks: VisualMarksDoctorSection::default(),
        });
    }

    let mut index = WikiIndex::default();
    index
        .rebuild_read_only(&vault.to_string_lossy())
        .map_err(|error| AppError::message(format!("build Wiki index: {error}")))?;
    let mut report = diagnose_with_index(vault, &index)?;
    report.vault = vault_report;
    report.ok = report.vault.ok
        && report.catalog.ok
        && report.wikilinks.issues.is_empty()
        && report.aliases.ok
        && report.visual_marks.ok;
    Ok(report)
}

pub fn diagnose_with_index(vault: &Path, index: &WikiIndex) -> Result<DoctorReport, AppError> {
    let vault_report = vault_section(vault);
    let mut catalog_report = CatalogDoctorSection {
        ok: true,
        schema_version: None,
        expected_schema_version: catalog::SCHEMA_VERSION,
        issues: Vec::new(),
        duplicate_report: None,
    };
    let papers = match read_only_catalog(vault) {
        Ok((connection, version)) => {
            catalog_report.schema_version = Some(version);
            if version != catalog::SCHEMA_VERSION {
                catalog_report.ok = false;
                catalog_report.issues.push(issue(
                    "catalog_schema_mismatch",
                    format!(
                        "catalog schema version {version}; expected {}",
                        catalog::SCHEMA_VERSION
                    ),
                    DoctorSeverity::Error,
                    Some(".agentero/catalog.sqlite".into()),
                ));
                Vec::new()
            } else {
                match catalog::papers::list_all_conn(&connection) {
                    Ok(papers) => {
                        match catalog::papers::find_duplicates_conn(vault, &connection) {
                            Ok(dup_report) => {
                                if !dup_report.duplicate_ids.is_empty()
                                    || !dup_report.duplicate_paths.is_empty()
                                {
                                    catalog_report.ok = false;
                                    catalog_report.duplicate_report = Some(dup_report.clone());
                                    for group in &dup_report.duplicate_ids {
                                        let paths: Vec<String> =
                                            group.rows.iter().map(|r| r.path.clone()).collect();
                                        catalog_report.issues.push(issue(
                                            "catalog_duplicate_id",
                                            format!(
                                                "paper id '{}' appears {} times",
                                                group.key,
                                                group.rows.len()
                                            ),
                                            DoctorSeverity::Warning,
                                            Some(paths.join(", ")),
                                        ));
                                    }
                                    for group in &dup_report.duplicate_paths {
                                        let ids: Vec<String> =
                                            group.rows.iter().map(|r| r.id.clone()).collect();
                                        catalog_report.issues.push(issue(
                                            "catalog_duplicate_path",
                                            format!(
                                                "paper path '{}' appears {} times",
                                                group.key,
                                                group.rows.len()
                                            ),
                                            DoctorSeverity::Warning,
                                            Some(ids.join(", ")),
                                        ));
                                    }
                                }
                            }
                            Err(error) => {
                                catalog_report.issues.push(issue(
                                    "catalog_duplicate_check_failed",
                                    error.to_string(),
                                    DoctorSeverity::Error,
                                    Some(".agentero/catalog.sqlite".into()),
                                ));
                            }
                        }
                        papers
                    }
                    Err(error) => {
                        catalog_report.ok = false;
                        catalog_report.issues.push(issue(
                            "catalog_query_failed",
                            error.to_string(),
                            DoctorSeverity::Error,
                            Some(".agentero/catalog.sqlite".into()),
                        ));
                        Vec::new()
                    }
                }
            }
        }
        Err(error) => {
            catalog_report.ok = false;
            catalog_report.issues.push(issue(
                "catalog_open_failed",
                error.to_string(),
                DoctorSeverity::Error,
                Some(".agentero/catalog.sqlite".into()),
            ));
            Vec::new()
        }
    };
    let wikilinks = index.check_links(&vault.to_string_lossy(), None);
    let aliases = if catalog_report.ok {
        alias_section(vault, &papers, index)
    } else {
        AliasDoctorSection {
            ok: false,
            issues: vec![issue(
                "aliases_skipped",
                "paper aliases were not checked because Catalog is unavailable",
                DoctorSeverity::Error,
                None,
            )],
            ..AliasDoctorSection::default()
        }
    };
    let visual_marks = scan_visual_marks(vault);
    let ok = vault_report.ok
        && catalog_report.ok
        && wikilinks.issues.is_empty()
        && aliases.ok
        && visual_marks.ok;
    Ok(DoctorReport {
        ok,
        vault: vault_report,
        catalog: catalog_report,
        wikilinks,
        aliases,
        visual_marks,
    })
}

fn safe_relative_path(raw: &str) -> bool {
    let path = Path::new(raw);
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

struct PlannedAliasWrite {
    path: String,
    absolute: PathBuf,
    original: String,
    rewritten: String,
}

/// Apply selected alias edits as one preflighted, rollback-capable transaction.
pub fn apply_alias_repairs(
    vault: &Path,
    changes: &[AliasRepairChange],
    dirty_paths: &[String],
) -> Result<AliasRepairResult, DoctorRepairError> {
    if let Err(e) = crate::core::fs::ensure_vault_dir(vault) {
        return Err(DoctorRepairError::new(
            "invalidVault",
            e.to_string(),
            Vec::new(),
        ));
    }
    if changes.is_empty() {
        return Ok(AliasRepairResult {
            updated_paths: Vec::new(),
        });
    }

    let (connection, version) = read_only_catalog(vault).map_err(|error| {
        DoctorRepairError::new("catalogUnavailable", error.to_string(), Vec::new())
    })?;
    if version != catalog::SCHEMA_VERSION {
        return Err(DoctorRepairError::new(
            "catalogSchemaMismatch",
            "Catalog schema is not current",
            Vec::new(),
        ));
    }
    let papers = catalog::papers::list_all_conn(&connection).map_err(|error| {
        DoctorRepairError::new("catalogUnavailable", error.to_string(), Vec::new())
    })?;
    let allowed = papers
        .iter()
        .map(|paper| format!("{}/NOTES.md", paper.path.trim_end_matches('/')))
        .collect::<HashSet<_>>();
    let dirty = dirty_paths
        .iter()
        .map(|path| path.replace('\\', "/").trim_matches('/').to_string())
        .collect::<HashSet<_>>();

    let mut index = WikiIndex::default();
    index
        .rebuild_read_only(&vault.to_string_lossy())
        .map_err(|error| DoctorRepairError::new("wikiIndexFailed", error, Vec::new()))?;
    let owners = alias_owners(&index);
    let mut planned = Vec::new();
    let mut selected_paths = HashSet::new();
    let mut selected_shorts = HashSet::new();

    for change in changes {
        let path = change.path.replace('\\', "/").trim_matches('/').to_string();
        if !safe_relative_path(&path)
            || !allowed.contains(&path)
            || !selected_paths.insert(path.clone())
        {
            return Err(DoctorRepairError::new(
                "invalidPath",
                format!("not a Catalog paper NOTES path: {path}"),
                vec![path],
            ));
        }
        if dirty.contains(&path) {
            return Err(DoctorRepairError::new(
                "dirtyPath",
                format!("paper note has unsaved edits: {path}"),
                vec![path],
            ));
        }
        let title_alias = change.title_alias.trim();
        let short_alias = change.short_alias.trim();
        if title_alias.is_empty()
            || short_alias.is_empty()
            || normalize_alias(title_alias) == normalize_alias(short_alias)
        {
            return Err(DoctorRepairError::new(
                "invalidAliases",
                "title and short aliases must be non-empty and distinct",
                vec![path],
            ));
        }
        if occupied_by_other(&owners, short_alias, &path)
            || !selected_shorts.insert(normalize_alias(short_alias))
        {
            return Err(DoctorRepairError::new(
                "shortAliasCollision",
                format!("short alias is already used: {short_alias}"),
                vec![path],
            ));
        }

        let absolute = vault.join(&path);
        let original = fs::read_to_string(&absolute).map_err(|error| {
            DoctorRepairError::new(
                "readFailed",
                format!("could not read {path}: {error}"),
                vec![path.clone()],
            )
        })?;
        if content_hash(&original) != change.expected_hash {
            return Err(DoctorRepairError::new(
                "sourceChanged",
                format!("paper note changed after diagnosis: {path}"),
                vec![path],
            ));
        }
        let inspection = inspect_aliases(&original);
        let mut aliases = inspection.aliases;
        aliases.push(title_alias.to_string());
        aliases.push(short_alias.to_string());
        let rewritten = patch_aliases(&original, &aliases).map_err(|reason| {
            DoctorRepairError::new(
                "unsafeFrontmatter",
                format!("{path}: {reason}"),
                vec![path.clone()],
            )
        })?;
        planned.push(PlannedAliasWrite {
            path,
            absolute,
            original,
            rewritten,
        });
    }

    // Re-check every source immediately before the first write.
    for write in &planned {
        let current = fs::read_to_string(&write.absolute).map_err(|error| {
            DoctorRepairError::new(
                "readFailed",
                format!("could not re-read {}: {error}", write.path),
                vec![write.path.clone()],
            )
        })?;
        if current != write.original {
            return Err(DoctorRepairError::new(
                "sourceChanged",
                format!("paper note changed after preflight: {}", write.path),
                vec![write.path.clone()],
            ));
        }
    }

    let mut written: Vec<&PlannedAliasWrite> = Vec::new();
    for write in &planned {
        if let Err(error) = write_note_bytes(&write.absolute, write.rewritten.as_bytes()) {
            let mut rollback_complete = true;
            for previous in written.iter().rev() {
                if write_note_bytes(&previous.absolute, previous.original.as_bytes()).is_err() {
                    rollback_complete = false;
                }
            }
            let mut failure = DoctorRepairError::new(
                "writeFailed",
                format!("could not write {}: {error}", write.path),
                planned.iter().map(|item| item.path.clone()).collect(),
            );
            failure.rollback = if rollback_complete {
                "completed"
            } else {
                "manualRecoveryRequired"
            }
            .into();
            return Err(failure);
        }
        written.push(write);
    }

    Ok(AliasRepairResult {
        updated_paths: planned.into_iter().map(|write| write.path).collect(),
    })
}

/// Remove duplicate catalog rows, keeping one canonical row per paper `id`.
///
/// This is the write-side counterpart to the duplicate detection in
/// `diagnose_with_index`. It delegates the canonical-row selection and
/// deletion to `catalog::papers::repair_duplicates`, which keeps the row
/// whose path exists on disk (preferred), has the newest `updated_at`, and
/// is shortest/lexicographically smallest as a final tie-breaker.
pub fn apply_catalog_duplicate_repairs(vault: &Path) -> Result<DuplicateRepairResult, AppError> {
    crate::core::fs::ensure_vault_dir(vault)?;
    papers::repair_duplicates(vault)
}

/// In-place content write for alias repair (path/name never change).
///
/// Do **not** use tmp+rename here: Host `atomic_write` is reported by FSEvents
/// as an incomplete rename. The main window then toasts
/// `vault.externalRename.unverified` even though no wiki target moved and path-
/// based `[[...]]` links need no repair. Same trade-off as cite sidecars in
/// `features/refs` — preflight + in-memory rollback cover batch safety.
fn write_note_bytes(path: &Path, contents: &[u8]) -> Result<(), String> {
    fs::write(path, contents).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_vault(name: &str) -> PathBuf {
        let vault = std::env::temp_dir().join(format!("agentero-doctor-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(vault.join("papers/demo")).unwrap();
        fs::create_dir_all(vault.join("notes")).unwrap();
        vault
    }

    fn seed_paper(vault: &Path, title: &str, notes: &str) {
        let connection = catalog::ensure_catalog(vault).unwrap();
        connection
            .execute(
                "INSERT INTO papers(path, id, type, title, added_at, updated_at)
                 VALUES('papers/demo', 'demo', 'paper', ?1, 'now', 'now')",
                [title],
            )
            .unwrap();
        fs::write(vault.join("papers/demo/NOTES.md"), notes).unwrap();
    }

    #[test]
    fn ignored_alias_paths_persist_and_skip_candidates() {
        let vault = temp_vault("ignore");
        seed_paper(
            &vault,
            "Attention Is All You Need",
            "# Notes without aliases\n",
        );
        let path = "papers/demo/NOTES.md".to_string();

        let before = diagnose(&vault).unwrap();
        assert!(!before.aliases.ok);
        assert_eq!(before.aliases.candidates.len(), 1);
        assert!(before.aliases.ignored_paths.is_empty());

        let state = set_ignored_alias_paths(&vault, std::slice::from_ref(&path), true).unwrap();
        assert_eq!(state.ignored_alias_paths, vec![path.clone()]);
        assert!(doctor_state_path(&vault).is_file());

        let after = diagnose(&vault).unwrap();
        assert!(after.aliases.ok);
        assert!(after.aliases.candidates.is_empty());
        assert_eq!(after.aliases.ignored_paths, vec![path.clone()]);
        assert_eq!(after.aliases.checked_papers, 1);
        assert_eq!(after.aliases.complete_papers, 0);

        let restored = set_ignored_alias_paths(&vault, &[path], false).unwrap();
        assert!(restored.ignored_alias_paths.is_empty());
        let again = diagnose(&vault).unwrap();
        assert!(!again.aliases.ok);
        assert_eq!(again.aliases.candidates.len(), 1);

        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn diagnose_reports_catalog_duplicate_ids() {
        let vault = temp_vault("dup-id");
        let conn = catalog::ensure_catalog(&vault).unwrap();
        conn.execute(
            "INSERT INTO papers(path, id, type, title, added_at, updated_at)
             VALUES('papers/demo', 'demo', 'paper', 'Demo', 'now', 'now')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO papers(path, id, type, title, added_at, updated_at)
             VALUES('papers/clone', 'demo', 'paper', 'Clone', 'now', 'now')",
            [],
        )
        .unwrap();

        let report = diagnose(&vault).unwrap();
        assert!(!report.catalog.ok);
        assert!(report.catalog.duplicate_report.is_some());
        let dup = report.catalog.duplicate_report.unwrap();
        assert_eq!(dup.duplicate_ids.len(), 1);
        assert_eq!(dup.duplicate_ids[0].key, "demo");
        assert_eq!(dup.duplicate_ids[0].rows.len(), 2);
        assert!(report
            .catalog
            .issues
            .iter()
            .any(|i| i.code == "catalog_duplicate_id"));

        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn apply_catalog_duplicate_repairs_keeps_existing_path() {
        let vault = temp_vault("dup-repair");
        // temp_vault creates papers/demo on disk; papers/ghost does not exist.
        let conn = catalog::ensure_catalog(&vault).unwrap();
        conn.execute(
            "INSERT INTO papers(path, id, type, title, added_at, updated_at)
             VALUES('papers/demo', 'demo', 'paper', 'Demo', 'now', '2024-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO papers(path, id, type, title, added_at, updated_at)
             VALUES('papers/ghost', 'demo', 'paper', 'Ghost', 'now', '2024-01-02T00:00:00Z')",
            [],
        )
        .unwrap();

        let result = apply_catalog_duplicate_repairs(&vault).unwrap();
        assert_eq!(result.removed_rows, 1);
        assert!(result.removed_paths.contains(&"papers/ghost".to_string()));
        assert!(result.kept_paths.contains(&"papers/demo".to_string()));

        let rows =
            catalog::papers::list_all_conn(&catalog::ensure_catalog(&vault).unwrap()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "papers/demo");

        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn suggests_expected_short_aliases() {
        assert_eq!(
            suggest_short_alias("Attention Is All You Need", &[], None).as_deref(),
            Some("AIAYN")
        );
        assert_eq!(
            suggest_short_alias(
                "BERT: Pre-training of Deep Bidirectional Transformers",
                &[],
                None
            )
            .as_deref(),
            Some("BERT")
        );
        assert_eq!(
            suggest_short_alias("一种新的研究方法", &["张三".into()], Some(2024)).as_deref(),
            Some("张三 2024")
        );
        assert_eq!(suggest_short_alias("一种新的研究方法", &[], None), None);
    }

    #[test]
    fn alias_repair_preserves_existing_aliases_and_rejects_dirty_sources() {
        let vault = std::env::temp_dir().join(format!("agentero-doctor-{}", Uuid::new_v4()));
        fs::create_dir_all(vault.join("papers/demo")).unwrap();
        fs::create_dir_all(vault.join("notes")).unwrap();
        let connection = catalog::ensure_catalog(&vault).unwrap();
        connection
            .execute(
                "INSERT INTO papers(path, id, type, title, added_at, updated_at)
                 VALUES('papers/demo', 'demo', 'paper', 'Attention Is All You Need', 'now', 'now')",
                [],
            )
            .unwrap();
        let path = "papers/demo/NOTES.md";
        let original = "---\naliases: [Transformer]\ntags: [keep]\n---\n# Notes\n";
        fs::write(vault.join(path), original).unwrap();
        let change = AliasRepairChange {
            path: path.into(),
            title_alias: "Attention Is All You Need".into(),
            short_alias: "AIAYN".into(),
            expected_hash: content_hash(original),
        };

        let dirty =
            apply_alias_repairs(&vault, std::slice::from_ref(&change), &[path.into()]).unwrap_err();
        assert_eq!(dirty.code, "dirtyPath");
        assert_eq!(fs::read_to_string(vault.join(path)).unwrap(), original);

        let result = apply_alias_repairs(&vault, &[change], &[]).unwrap();
        assert_eq!(result.updated_paths, vec![path]);
        let rewritten = fs::read_to_string(vault.join(path)).unwrap();
        assert!(rewritten.contains("  - \"Transformer\""));
        assert!(rewritten.contains("  - \"Attention Is All You Need\""));
        assert!(rewritten.contains("  - \"AIAYN\""));
        assert!(rewritten.contains("tags: [keep]"));
        let _ = fs::remove_dir_all(vault);
    }
}
