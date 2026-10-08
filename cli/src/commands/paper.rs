//! `agentero paper *`

use crate::error::CliError;
use crate::output::to_value;
use crate::resolve::{looks_like_vault, paper_dir, resolve_paper, resolve_vault, GlobalOpts};
use crate::style::{format_table, truncate_chars};
use agentero_core::features::catalog;
use agentero_core::features::catalog::papers::{self, PaperRecord, PaperTag};
use agentero_core::features::import::pdf_parse::{self, PaperParseBodyArgs};
use agentero_core::features::import::{self, PaperDownloadAssetsArgs};
use clap::{Subcommand, ValueHint};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Subcommand)]
pub enum PaperCmd {
    /// List papers from catalog (L1 index).
    List {
        /// Substring filter on title / authors / id / path / tags.
        #[arg(long = "query")]
        query: Option<String>,
        /// Filter: paper must have this tag (repeatable, AND; case-insensitive exact).
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
        /// Only unread (`is_read = false`).
        #[arg(long = "unread")]
        unread: bool,
        /// Filter by status field.
        #[arg(long = "status")]
        status: Option<String>,
        /// Include internal `@zotero:` / `@arxiv:` tags in filtering and output.
        #[arg(long = "all")]
        all: bool,
        /// JSON: emit full PaperRecord rows (default: only id/path/title).
        #[arg(long = "full")]
        full: bool,
        /// JSON: extra fields on top of id/path/title (comma-separated, repeatable).
        #[arg(long = "fields", value_name = "FIELDS", value_delimiter = ',')]
        fields: Vec<String>,
    },
    /// Tag inventory and per-paper tag edits.
    Tag {
        #[command(subcommand)]
        cmd: TagCmd,
    },
    /// Meta + asset flags + suggestedReads (no body dump).
    Get {
        /// Vault-relative path or paper id.
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Include internal `@zotero:` / `@arxiv:` tags in output.
        #[arg(long = "all")]
        all: bool,
    },
    /// Print related file paths only.
    Paths {
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
    },
    /// Move a paper or papers organization directory to the recycle bin.
    ///
    /// With `--files`, permanently remove the catalog rows and files instead
    /// (requires `-y`, retained for explicit destructive automation).
    Delete {
        /// Vault-relative path (paper or org folder under papers/).
        #[arg(value_hint = ValueHint::DirPath)]
        path: String,
        /// Also delete files on disk.
        #[arg(long = "files")]
        files: bool,
    },
    /// Set catalog `is_read` (does not run paper-reader).
    SetRead {
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Set is_read to false.
        #[arg(long = "false")]
        set_false: bool,
    },
    /// Download PDF / arXiv TeX for an existing paper.
    Download {
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
    },
    /// liteparse PDF → PAPER.md when no TeX.
    Parse {
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        #[arg(long = "force")]
        force: bool,
    },
    /// Move a paper or papers organization directory under another papers/ directory.
    ///
    /// Paths are normally vault-relative (e.g. `papers/topic/foo`). If a path
    /// starts with or resolves to a Vault root, that Vault is used explicitly,
    /// enabling cross-vault migration (e.g.
    /// `/path/to/src-vault/papers/topic/foo /path/to/dst-vault/papers/`).
    Move {
        /// Source path: vault-relative or vault-prefixed.
        #[arg(value_hint = ValueHint::DirPath)]
        from: String,
        /// Destination parent: vault-relative or vault-prefixed.
        #[arg(value_hint = ValueHint::DirPath)]
        dest_parent: String,
    },
    /// Open a paper in the running desktop App.
    ///
    /// Resolves the vault-relative paper folder, then wakes the App via a
    /// request file + `agentero://paper` deep link (spawning it when needed).
    Open {
        /// Vault-relative path or paper id.
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum TagCmd {
    /// List unique tags in the catalog with counts (and colors when set).
    List {
        /// Include internal `@zotero:` / `@arxiv:` tags.
        #[arg(long = "all")]
        all: bool,
    },
    /// Replace the full tag list for a paper.
    ///
    /// Pass tag names as arguments, or use `--clear` to remove all tags.
    Set {
        /// Vault-relative path or paper id.
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Tag names (replace entire list).
        tags: Vec<String>,
        /// Clear all tags (do not pass tag names with this flag).
        #[arg(long = "clear")]
        clear: bool,
    },
    /// Append tags to a paper (case-insensitive dedupe).
    Add {
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Tag names to append (at least one).
        #[arg(required = true)]
        tags: Vec<String>,
    },
    /// Remove tags from a paper (case-insensitive).
    Rm {
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Tag names to remove (at least one).
        #[arg(required = true)]
        tags: Vec<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Assets {
    pdf: bool,
    tex: bool,
    paper_md: bool,
    notes_md: bool,
    /// Reader annotations dir: `{paper}/marks/*.json`.
    marks_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaperGetData {
    paper: PaperRecord,
    assets: Assets,
    suggested_reads: Vec<String>,
}

#[derive(Debug, Serialize)]
struct TagCountOut {
    tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    count: usize,
}

pub async fn run(cmd: PaperCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        PaperCmd::List {
            query,
            tags,
            unread,
            status,
            all,
            full,
            fields,
        } => list(
            globals,
            query.as_deref(),
            &tags,
            unread,
            status.as_deref(),
            all,
            ListOutput {
                full,
                fields: &fields,
            },
        ),
        PaperCmd::Tag { cmd } => run_tag(cmd, globals),
        PaperCmd::Get { r#ref, all } => get(globals, &r#ref, all),
        PaperCmd::Paths { r#ref } => paths(globals, &r#ref),
        PaperCmd::Delete { path, files } => delete(globals, &path, files),
        PaperCmd::SetRead { r#ref, set_false } => set_read(globals, &r#ref, !set_false),
        PaperCmd::Download { r#ref } => download(globals, &r#ref).await,
        PaperCmd::Parse { r#ref, force } => parse(globals, &r#ref, force).await,
        PaperCmd::Move { from, dest_parent } => move_paper(globals, &from, &dest_parent),
        PaperCmd::Open { r#ref } => open_in_app(globals, &r#ref),
    }
}

/// Resolve the paper folder, then hand off to the desktop open pipeline.
fn open_in_app(globals: &GlobalOpts, ref_: &str) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    crate::commands::open::open_paper_in_app(&vault, &paper.path, globals)
}

fn run_tag(cmd: TagCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        TagCmd::List { all } => list_tags(globals, all),
        TagCmd::Set { r#ref, tags, clear } => {
            if clear && !tags.is_empty() {
                return Err(CliError::usage("--clear cannot be combined with tag names"));
            }
            if clear {
                set_tags(globals, &r#ref, &[], TagMode::Replace)
            } else if tags.is_empty() {
                Err(CliError::usage(
                    "pass tag names to replace, or use --clear to remove all tags",
                ))
            } else {
                set_tags(globals, &r#ref, &tags, TagMode::Replace)
            }
        }
        TagCmd::Add { r#ref, tags } => set_tags(globals, &r#ref, &tags, TagMode::Add),
        TagCmd::Rm { r#ref, tags } => set_tags(globals, &r#ref, &tags, TagMode::Remove),
    }
}

#[derive(Debug, Clone, Copy)]
enum TagMode {
    Replace,
    Add,
    Remove,
}

/// JSON payload shape for `paper list` (see [`list_items`]).
struct ListOutput<'a> {
    full: bool,
    fields: &'a [String],
}

fn list(
    globals: &GlobalOpts,
    query: Option<&str>,
    filter_tags: &[String],
    unread: bool,
    status: Option<&str>,
    include_all: bool,
    out: ListOutput<'_>,
) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let mut rows = papers::list_all_unique_by_id(&vault)?;
    if unread {
        rows.retain(|r| !r.is_read);
    }
    if !include_all {
        for row in &mut rows {
            row.tags.retain(|t| !papers::is_internal_tag_name(&t.name));
        }
    }
    if let Some(st) = status.map(str::trim).filter(|s| !s.is_empty()) {
        rows.retain(|r| r.status.eq_ignore_ascii_case(st));
    }
    let required_tags: Vec<String> = filter_tags
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if !required_tags.is_empty() {
        rows.retain(|r| papers::paper_has_all_tags(r, &required_tags));
    }
    if let Some(q) = query.map(str::trim).filter(|s| !s.is_empty()) {
        let q = q.to_ascii_lowercase();
        rows.retain(|r| {
            r.title.to_ascii_lowercase().contains(&q)
                || r.id.to_ascii_lowercase().contains(&q)
                || r.path.to_ascii_lowercase().contains(&q)
                || r.authors
                    .iter()
                    .any(|a| a.to_ascii_lowercase().contains(&q))
                || r.tags
                    .iter()
                    .any(|t| t.name.to_ascii_lowercase().contains(&q))
        });
    }

    let style = globals.style;
    let table_rows: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            let date = r
                .date
                .clone()
                .or_else(|| r.year.map(|y| y.to_string()))
                .unwrap_or_else(|| "-".into());
            let tags =
                style.tags_join(r.tags.iter().map(|t| (t.name.as_str(), t.color.as_deref())));
            vec![
                style.path(&truncate_chars(&r.path, 40)),
                style.id(&truncate_chars(&r.id, 16)),
                style.title(&truncate_chars(&r.title, 48)),
                style.dim(&date),
                tags,
                style.read_status(r.is_read),
            ]
        })
        .collect();
    let lines = if rows.is_empty() {
        vec![style.dim("(no papers)")]
    } else {
        format_table(
            style,
            &["PATH", "ID", "TITLE", "DATE", "TAGS", "STATUS"],
            &table_rows,
        )
    };

    let items = list_items(&rows, out.full, out.fields)?;

    Ok(json!({
        "items": items,
        "lines": lines,
        "__paper_list": true,
    }))
}

/// JSON field names of `PaperRecord` valid for `paper list --fields`.
const PAPER_LIST_FIELDS: [&str; 40] = [
    "path",
    "id",
    "type",
    "title",
    "authors",
    "creators",
    "year",
    "date",
    "abstract",
    "tags",
    "arxiv_id",
    "doi",
    "isbn",
    "issn",
    "pmid",
    "publication",
    "volume",
    "issue",
    "pages",
    "publisher",
    "place",
    "series",
    "language",
    "pdf_url",
    "html_url",
    "source_url",
    "body_source",
    "body_quality",
    "bibtex_key",
    "citation_count",
    "zotero_item_type",
    "meta_source",
    "extra",
    "summary",
    "status",
    "is_read",
    "zotero_item_id",
    "zotero_last_synced",
    "added_at",
    "updated_at",
];

/// JSON items for `paper list`: full rows with `--full`, otherwise only
/// id/path/title plus `--fields` extras (token-cheap default for agents).
fn list_items(rows: &[PaperRecord], full: bool, fields: &[String]) -> Result<Vec<Value>, CliError> {
    if full {
        return rows
            .iter()
            .map(|r| serde_json::to_value(r).map_err(CliError::from))
            .collect();
    }
    let mut keep: Vec<&str> = vec!["id", "path", "title"];
    for f in fields {
        let f = f.trim();
        if f.is_empty() {
            continue;
        }
        if !PAPER_LIST_FIELDS.contains(&f) {
            return Err(CliError::usage(format!(
                "unknown field '{f}' (valid: {})",
                PAPER_LIST_FIELDS.join(", ")
            )));
        }
        if !keep.contains(&f) {
            keep.push(f);
        }
    }
    rows.iter()
        .map(|r| {
            let v = serde_json::to_value(r)?;
            let obj = v.as_object().expect("PaperRecord serializes to object");
            let slim = keep
                .iter()
                .filter_map(|k| obj.get(*k).map(|val| ((*k).to_string(), val.clone())))
                .collect::<serde_json::Map<String, Value>>();
            Ok(Value::Object(slim))
        })
        .collect()
}

fn list_tags(globals: &GlobalOpts, include_all: bool) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let pairs = papers::list_all_tags(&vault)?
        .into_iter()
        .filter(|t| include_all || !papers::is_internal_tag_name(&t.name))
        .collect::<Vec<_>>();
    let items: Vec<TagCountOut> = pairs
        .into_iter()
        .map(|t| TagCountOut {
            tag: t.name,
            color: t.color,
            count: t.count,
        })
        .collect();
    let style = globals.style;
    let table_rows: Vec<Vec<String>> = items
        .iter()
        .map(|t| {
            vec![
                style.tag(&t.tag, t.color.as_deref()),
                style.dim(&t.count.to_string()),
            ]
        })
        .collect();
    let lines = if items.is_empty() {
        vec![style.dim("(no tags)")]
    } else {
        format_table(style, &["TAG", "COUNT"], &table_rows)
    };
    Ok(json!({
        "items": items,
        "lines": lines,
    }))
}

fn get(globals: &GlobalOpts, ref_: &str, include_all: bool) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let dir = paper_dir(&vault, &paper.path);
    let assets = probe_assets(&dir);
    let suggested_reads = suggested_reads(&paper.path, &assets);

    let mut display_paper = paper.clone();
    if !include_all {
        display_paper
            .tags
            .retain(|t| !papers::is_internal_tag_name(&t.name));
    }
    let data = PaperGetData {
        paper: display_paper,
        assets,
        suggested_reads: suggested_reads.clone(),
    };
    let style = globals.style;
    let tags = style.tags_join(
        paper
            .tags
            .iter()
            .map(|t| (t.name.as_str(), t.color.as_deref())),
    );
    let date = paper
        .date
        .clone()
        .or_else(|| paper.year.map(|y| y.to_string()))
        .unwrap_or_else(|| "-".into());
    let asset_bits = [
        ("pdf", data.assets.pdf),
        ("tex", data.assets.tex),
        ("paperMd", data.assets.paper_md),
        ("notesMd", data.assets.notes_md),
        ("marksDir", data.assets.marks_dir),
    ]
    .into_iter()
    .map(|(k, on)| {
        if on {
            style.bright_green(k)
        } else {
            style.dim(k)
        }
    })
    .collect::<Vec<_>>()
    .join(" ");

    let mut lines = vec![
        format!("{}  {}", style.path(&paper.path), style.title(&paper.title)),
        format!(
            "{} {}  {} {}  {} {}  {} {}",
            style.key("id"),
            style.id(&paper.id),
            style.key("date"),
            style.dim(&date),
            style.key("status"),
            style.read_status(paper.is_read),
            style.key("tags"),
            tags
        ),
        format!("{} {}", style.key("assets"), asset_bits),
    ];
    if suggested_reads.is_empty() {
        lines.push(format!("{} {}", style.key("reads"), style.dim("(none)")));
    } else {
        lines.push(format!(
            "{} {}",
            style.key("reads"),
            suggested_reads
                .iter()
                .map(|p| style.path(p))
                .collect::<Vec<_>>()
                .join(&style.dim(", "))
        ));
    }

    let mut v = to_value(&data)?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert("lines".into(), json!(lines));
    }
    Ok(v)
}

fn paths(globals: &GlobalOpts, ref_: &str) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let dir = paper_dir(&vault, &paper.path);
    let assets = probe_assets(&dir);

    let mut paths = Vec::new();
    paths.push(paper.path.clone());
    for name in ["NOTES.md", "PAPER.md"] {
        let rel = format!("{}/{}", paper.path, name);
        if vault.join(&rel).is_file() {
            paths.push(rel);
        }
    }
    if assets.marks_dir {
        paths.push(format!("{}/marks", paper.path));
    }
    if let Some(pdf) = catalog::find_local_pdf(&dir) {
        if let Ok(rel) = pdf.strip_prefix(&vault) {
            paths.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    if assets.tex {
        let src = format!("{}/source", paper.path);
        if vault.join(&src).is_dir() {
            paths.push(src);
        }
    }

    // Text mode: colorize paths when painting lines wrapper would be skipped for
    // pure string arrays — emit via lines when color is on so path tint applies.
    let style = globals.style;
    if style.enabled() {
        let lines: Vec<String> = paths.iter().map(|p| style.path(p)).collect();
        return Ok(json!({ "items": paths, "lines": lines, "__path_list": true }));
    }
    Ok(json!(paths))
}

fn delete(globals: &GlobalOpts, path: &str, files: bool) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let path = path.trim().trim_matches('/').replace('\\', "/");
    if path.is_empty() {
        return Err(CliError::usage("path is required"));
    }
    if files {
        let msg = format!("Delete paper files on disk for '{path}'? This cannot be undone.");
        let ok = crate::prompt::confirm(globals, &msg, false)?;
        if !ok {
            return Err(CliError::needs_confirmation("deletion cancelled"));
        }
    }

    if files {
        let removed = papers::delete_under_path(&vault, &path)?;
        let dir = paper_dir(&vault, &path);
        if dir.is_dir() {
            fs::remove_dir_all(&dir)?;
        }
        let style = globals.style;
        return Ok(json!({
            "removed": removed,
            "path": path,
            "deletedFiles": true,
            "lines": [format!(
                "{} removed {} catalog row(s) for {}",
                style.ok("✓"),
                removed,
                style.path(&path)
            )]
        }));
    }

    let result = agentero_core::features::trash::trash_paths(&vault, std::slice::from_ref(&path))?;
    Ok(json!({
        "batchId": result.batch_id,
        "count": result.count,
        "path": path,
        "lines": [format!(
            "{} moved {} to recycle bin",
            globals.style.ok("✓"),
            globals.style.path(&path)
        )]
    }))
}

fn set_read(globals: &GlobalOpts, ref_: &str, is_read: bool) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let row = papers::set_is_read(&vault, &paper.path, is_read)?;
    let style = globals.style;
    let mut v = to_value(&row)?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "lines".into(),
            json!([format!(
                "{} {}  {} {}",
                style.key("is_read"),
                style.read_status(row.is_read),
                style.key("path"),
                style.path(&row.path)
            )]),
        );
    }
    Ok(v)
}

fn set_tags(
    globals: &GlobalOpts,
    ref_: &str,
    tags: &[String],
    mode: TagMode,
) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let parsed_tags: Vec<PaperTag> = tags
        .iter()
        .map(|tag| parse_tag_spec(tag))
        .collect::<Result<_, _>>()?;
    let tag_objs = if matches!(mode, TagMode::Replace) {
        paper
            .tags
            .iter()
            .filter(|tag| papers::is_internal_tag_name(&tag.name))
            .cloned()
            .chain(parsed_tags)
            .collect()
    } else {
        parsed_tags
    };
    let row = match mode {
        TagMode::Add => {
            if tags.is_empty() {
                return Err(CliError::usage("tag add requires at least one tag"));
            }
            papers::add_tags(&vault, &paper.path, &tag_objs)?
        }
        TagMode::Remove => {
            if tags.is_empty() {
                return Err(CliError::usage("tag rm requires at least one tag"));
            }
            let names = tag_objs.iter().map(|t| t.name.clone()).collect::<Vec<_>>();
            papers::remove_tags(&vault, &paper.path, &names)?
        }
        TagMode::Replace => papers::set_tags(&vault, &paper.path, &tag_objs)?,
    };
    let style = globals.style;
    let tags_disp = style.tags_join(
        row.tags
            .iter()
            .map(|t| (t.name.as_str(), t.color.as_deref())),
    );
    let mut v = to_value(&row)?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "lines".into(),
            json!([format!(
                "{} {}  {} {}",
                style.key("tags"),
                tags_disp,
                style.key("path"),
                style.path(&row.path)
            )]),
        );
    }
    Ok(v)
}

#[derive(Debug)]
struct MoveTarget {
    vault: PathBuf,
    rel: String,
}

fn resolve_move_target(arg: &str, globals: &GlobalOpts) -> Result<MoveTarget, CliError> {
    let normalized = arg.replace('\\', "/");

    // Vault-relative paper path: use current vault.
    if normalized.starts_with("papers/") || normalized == "papers" {
        let vault = resolve_vault(globals)?;
        return Ok(MoveTarget {
            vault,
            rel: normalized,
        });
    }

    // Otherwise try to find a Vault root in the path.
    let path = Path::new(arg);
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let abs = agentero_core::fs::canonicalize_best_effort(&abs);

    let mut cur = abs.clone();
    loop {
        if looks_like_vault(&cur) {
            let rel = abs
                .strip_prefix(&cur)
                .map_err(|_| CliError::message("path not under vault"))?
                .to_string_lossy()
                .to_string()
                .replace('\\', "/")
                .trim_start_matches('/')
                .to_string();
            if rel.is_empty() {
                return Err(CliError::usage("cannot move vault root"));
            }
            return Ok(MoveTarget { vault: cur, rel });
        }
        if !cur.pop() {
            break;
        }
    }

    // Fallback: treat as relative to current vault.
    let vault = resolve_vault(globals)?;
    Ok(MoveTarget {
        vault,
        rel: normalized,
    })
}

fn move_paper(globals: &GlobalOpts, from: &str, dest_parent: &str) -> Result<Value, CliError> {
    let from = resolve_move_target(from, globals)?;
    let to = resolve_move_target(dest_parent, globals)?;

    if from.vault == to.vault {
        // The shared headless entry builds its Wiki snapshot; this process has
        // no unsaved editors to protect. Cross-vault migration stays separate.
        let new_rel = catalog::move_paper_under(&from.vault, &from.rel, &to.rel)?;
        Ok(json!({
            "from": from.rel,
            "newRel": new_rel,
            "vault": from.vault.to_string_lossy().to_string(),
            "lines": [format!("moved {} → {}", globals.style.path(&from.rel), globals.style.path(&new_rel))],
        }))
    } else {
        let new_rel =
            catalog::migrate_paper_between_vaults(&from.vault, &from.rel, &to.vault, &to.rel)?;
        Ok(json!({
            "from": from.rel,
            "fromVault": from.vault.to_string_lossy().to_string(),
            "newRel": new_rel,
            "toVault": to.vault.to_string_lossy().to_string(),
            "lines": [format!(
                "migrated {} → {} ({} → {})",
                globals.style.path(&from.rel),
                globals.style.path(&new_rel),
                globals.style.path(&from.vault.to_string_lossy()),
                globals.style.path(&to.vault.to_string_lossy())
            )],
        }))
    }
}

fn parse_tag_spec(raw: &str) -> Result<PaperTag, CliError> {
    papers::parse_tag_spec(raw).map_err(|err| CliError::usage(err.to_string()))
}

async fn download(globals: &GlobalOpts, ref_: &str) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let result = import::download_paper_assets(PaperDownloadAssetsArgs {
        vault_path: vault.to_string_lossy().to_string(),
        path: paper.path.clone(),
        task_id: None,
    })
    .await?;
    let style = globals.style;
    let mut v = to_value(&result)?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "lines".into(),
            json!([format!(
                "{} {}  pdf={} tex={} paperMd={}",
                style.ok("download"),
                style.path(&paper.path),
                result.pdf,
                result.tex,
                result.paper_md
            )]),
        );
        obj.insert("path".into(), json!(paper.path));
    }
    Ok(v)
}

async fn parse(globals: &GlobalOpts, ref_: &str, force: bool) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let dir = paper_dir(&vault, &paper.path);
    if import::has_local_tex(&dir) {
        return Err(CliError::message(
            "paper has TeX source; PAPER.md is optional — not forcing liteparse",
        ));
    }
    if !import::has_local_pdf(&dir) {
        return Err(CliError::asset_missing(
            "no local PDF to parse; run paper download first",
        ));
    }
    let result = pdf_parse::parse_paper_body(
        PaperParseBodyArgs {
            vault_path: vault.to_string_lossy().to_string(),
            path: paper.path.clone(),
            force,
            task_id: None,
        },
        None,
    )
    .await?;
    if let Some(message) = result.error {
        return Err(CliError::message(message));
    }
    let style = globals.style;
    let mut v = to_value(&result)?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "lines".into(),
            json!([format!(
                "{} {}  paperMd={}",
                style.ok("parse"),
                style.path(&paper.path),
                result.paper_md
            )]),
        );
        obj.insert("path".into(), json!(paper.path));
    }
    Ok(v)
}

fn probe_assets(dir: &std::path::Path) -> Assets {
    Assets {
        pdf: import::has_local_pdf(dir),
        tex: import::has_local_tex(dir),
        paper_md: catalog::has_paper_md(dir),
        notes_md: dir.join("NOTES.md").is_file(),
        marks_dir: dir.join("marks").is_dir(),
    }
}

fn suggested_reads(path: &str, assets: &Assets) -> Vec<String> {
    let mut out = Vec::new();
    if assets.notes_md {
        out.push(format!("{path}/NOTES.md"));
    }
    if assets.marks_dir {
        out.push(format!("{path}/marks"));
    }
    if assets.paper_md {
        out.push(format!("{path}/PAPER.md"));
    }
    out
}
