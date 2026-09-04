//! Best-effort persistent snapshot for the rebuildable Wiki index.
//!
//! Markdown and Vault target files remain the only facts. The cache stores only
//! per-file parse products (document anchors + link occurrences) keyed by their
//! relative path, so a rebuild that touched N files rewrites exactly N files'
//! rows. Link resolution is recomputed at load time against the complete
//! document set, which keeps stored rows valid even when an *unrelated* file
//! changes what a link resolves to.
//!
//! A snapshot is restored only when its schema, parser, vault identity, and
//! per-row integrity hashes match; the caller compares per-file stat
//! fingerprints (size + mtime) to decide between a full restore and an
//! incremental rebuild of changed files.

use crate::core::paths::agentero_cache_dir;
use crate::features::wiki::models::{InternalLinkOccurrence, ResolvedLink, WikiDocument};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const WIKI_CACHE_SCHEMA_VERSION: i64 = 3;
pub(crate) const WIKI_PARSER_VERSION: &str = "wiki-parser-2026-07-29-v2";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct WikiFileFingerprint {
    pub relative_path: String,
    pub size: i64,
    pub modified_time_ns: i64,
}

#[derive(Debug)]
pub(crate) struct WikiCacheSnapshot {
    pub fingerprints: Vec<WikiFileFingerprint>,
    pub documents: Vec<WikiDocument>,
    /// Parsed occurrences ordered by (source, in-file ordinal), which matches
    /// the deterministic edge order of a cold rebuild over sorted files.
    pub occurrences: Vec<InternalLinkOccurrence>,
}

#[derive(Debug)]
pub(crate) enum WikiCacheLoad {
    Hit(WikiCacheSnapshot),
    Miss,
    Stale,
    Invalid(String),
}

/// How much of the snapshot one persist call must rewrite.
#[derive(Debug)]
pub(crate) enum WikiSnapshotWrite {
    /// Rewrite every row (cold builds, fresh rebuilds, unsynced caches).
    Full,
    /// Rewrite only rows for `changed` paths and delete rows for `removed`
    /// paths. Valid only when the on-disk cache already matches the previous
    /// in-memory snapshot for every other path.
    Incremental {
        changed: BTreeSet<String>,
        removed: BTreeSet<String>,
    },
}

fn vault_identity(vault_root: &Path) -> String {
    fs::canonicalize(vault_root)
        .unwrap_or_else(|_| vault_root.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

fn vault_key(vault_root: &Path) -> String {
    hex::encode(Sha256::digest(vault_identity(vault_root).as_bytes()))
}

pub(crate) fn wiki_cache_path(vault_root: &Path) -> PathBuf {
    agentero_cache_dir()
        .join("wiki")
        .join(format!("{}.sqlite", vault_key(vault_root)))
}

fn modified_time_ns(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_nanos()).ok())
        .unwrap_or(0)
}

fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(crate) fn fingerprint_file(
    relative_path: &str,
    absolute_path: &Path,
) -> io::Result<WikiFileFingerprint> {
    let metadata = fs::metadata(absolute_path)?;
    Ok(WikiFileFingerprint {
        relative_path: relative_path.to_string(),
        size: i64::try_from(metadata.len()).unwrap_or(i64::MAX),
        modified_time_ns: modified_time_ns(&metadata),
    })
}

pub(crate) fn fingerprint_files(
    vault_root: &Path,
    files: &[String],
) -> io::Result<Vec<WikiFileFingerprint>> {
    files
        .iter()
        .map(|relative_path| fingerprint_file(relative_path, &vault_root.join(relative_path)))
        .collect()
}

// Row-level integrity hashes replace the previous whole-snapshot JSON hash so
// incremental writes never need to re-serialize the complete index. NUL is a
// safe field separator: it cannot appear in file paths or serde_json output.

fn file_row_hash(fingerprint: &WikiFileFingerprint) -> String {
    hash_bytes(
        format!(
            "{}\0{}\0{}",
            fingerprint.relative_path, fingerprint.size, fingerprint.modified_time_ns
        )
        .as_bytes(),
    )
}

fn document_row_hash(path: &str, aliases: &str, headings: &str, blocks: &str) -> String {
    hash_bytes(format!("{path}\0{aliases}\0{headings}\0{blocks}").as_bytes())
}

fn occurrence_row_hash(source: &str, ordinal: i64, occurrence_json: &str) -> String {
    hash_bytes(format!("{source}\0{ordinal}\0{occurrence_json}").as_bytes())
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open wiki cache {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|error| format!("configure wiki cache timeout: {error}"))?;
    Ok(connection)
}

pub(crate) fn load_snapshot(cache_path: &Path, vault_root: &Path) -> WikiCacheLoad {
    if !cache_path.is_file() {
        return WikiCacheLoad::Miss;
    }
    let result = (|| -> Result<WikiCacheSnapshot, String> {
        let connection = open_read_only(cache_path)?;
        let metadata = connection
            .query_row(
                "SELECT schema_version, parser_version, vault_key, vault_path
                 FROM cache_metadata WHERE id = 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("read wiki cache metadata: {error}"))?
            .ok_or_else(|| "wiki cache metadata is missing".to_string())?;
        let identity = vault_identity(vault_root);
        if metadata.0 != WIKI_CACHE_SCHEMA_VERSION
            || metadata.1 != WIKI_PARSER_VERSION
            || metadata.2 != vault_key(vault_root)
            || metadata.3 != identity
        {
            return Err("wiki cache version or vault identity is stale".to_string());
        }

        let mut file_statement = connection
            .prepare(
                "SELECT relative_path, size, modified_time_ns, row_hash
                 FROM files ORDER BY relative_path",
            )
            .map_err(|error| format!("prepare wiki cache fingerprints: {error}"))?;
        let file_rows = file_statement
            .query_map([], |row| {
                Ok((
                    WikiFileFingerprint {
                        relative_path: row.get(0)?,
                        size: row.get(1)?,
                        modified_time_ns: row.get(2)?,
                    },
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| format!("read wiki cache fingerprints: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("decode wiki cache fingerprints: {error}"))?;
        let mut fingerprints = Vec::with_capacity(file_rows.len());
        for (fingerprint, row_hash) in file_rows {
            if file_row_hash(&fingerprint) != row_hash {
                return Err(format!(
                    "wiki cache fingerprint integrity hash does not match: {}",
                    fingerprint.relative_path
                ));
            }
            fingerprints.push(fingerprint);
        }

        let mut document_statement = connection
            .prepare(
                "SELECT path, aliases_json, headings_json, blocks_json, row_hash
                 FROM documents ORDER BY path",
            )
            .map_err(|error| format!("prepare wiki cache documents: {error}"))?;
        let document_rows = document_statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| format!("read wiki cache documents: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("decode wiki cache document rows: {error}"))?;
        let documents = document_rows
            .into_iter()
            .map(|(path, aliases, headings, blocks, row_hash)| {
                if document_row_hash(&path, &aliases, &headings, &blocks) != row_hash {
                    return Err(format!(
                        "wiki cache document integrity hash does not match: {path}"
                    ));
                }
                Ok(WikiDocument {
                    path,
                    aliases: serde_json::from_str(&aliases)
                        .map_err(|error| format!("decode wiki aliases: {error}"))?,
                    headings: serde_json::from_str(&headings)
                        .map_err(|error| format!("decode wiki headings: {error}"))?,
                    blocks: serde_json::from_str(&blocks)
                        .map_err(|error| format!("decode wiki blocks: {error}"))?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;

        let mut occurrence_statement = connection
            .prepare(
                "SELECT source, ordinal, occurrence_json, row_hash
                 FROM occurrences ORDER BY source, ordinal",
            )
            .map_err(|error| format!("prepare wiki cache occurrences: {error}"))?;
        let occurrence_rows = occurrence_statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| format!("read wiki cache occurrences: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("decode wiki cache occurrence rows: {error}"))?;
        let occurrences = occurrence_rows
            .into_iter()
            .map(|(source, ordinal, occurrence_json, row_hash)| {
                if occurrence_row_hash(&source, ordinal, &occurrence_json) != row_hash {
                    return Err(format!(
                        "wiki cache occurrence integrity hash does not match: {source}"
                    ));
                }
                serde_json::from_str(&occurrence_json)
                    .map_err(|error| format!("decode wiki occurrence: {error}"))
            })
            .collect::<Result<Vec<InternalLinkOccurrence>, String>>()?;

        Ok(WikiCacheSnapshot {
            fingerprints,
            documents,
            occurrences,
        })
    })();

    match result {
        Ok(snapshot) => WikiCacheLoad::Hit(snapshot),
        Err(error) if error == "wiki cache version or vault identity is stale" => {
            WikiCacheLoad::Stale
        }
        Err(error) => WikiCacheLoad::Invalid(error),
    }
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA journal_mode = DELETE;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS cache_metadata (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               schema_version INTEGER NOT NULL,
               parser_version TEXT NOT NULL,
               vault_key TEXT NOT NULL,
               vault_path TEXT NOT NULL,
               built_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS files (
               relative_path TEXT PRIMARY KEY,
               size INTEGER NOT NULL,
               modified_time_ns INTEGER NOT NULL,
               row_hash TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS documents (
               path TEXT PRIMARY KEY,
               aliases_json TEXT NOT NULL,
               headings_json TEXT NOT NULL,
               blocks_json TEXT NOT NULL,
               row_hash TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS occurrences (
               source TEXT NOT NULL,
               ordinal INTEGER NOT NULL,
               occurrence_json TEXT NOT NULL,
               row_hash TEXT NOT NULL,
               PRIMARY KEY (source, ordinal)
             );",
        )
        .map_err(|error| format!("initialize wiki cache schema: {error}"))
}

fn built_at_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or(0)
}

fn insert_fingerprint(
    transaction: &Transaction<'_>,
    fingerprint: &WikiFileFingerprint,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT OR REPLACE INTO files (relative_path, size, modified_time_ns, row_hash)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                fingerprint.relative_path,
                fingerprint.size,
                fingerprint.modified_time_ns,
                file_row_hash(fingerprint)
            ],
        )
        .map_err(|error| format!("write wiki cache fingerprint: {error}"))?;
    Ok(())
}

fn insert_document(transaction: &Transaction<'_>, document: &WikiDocument) -> Result<(), String> {
    let aliases = serde_json::to_string(&document.aliases)
        .map_err(|error| format!("encode wiki aliases: {error}"))?;
    let headings = serde_json::to_string(&document.headings)
        .map_err(|error| format!("encode wiki headings: {error}"))?;
    let blocks = serde_json::to_string(&document.blocks)
        .map_err(|error| format!("encode wiki blocks: {error}"))?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO documents (path, aliases_json, headings_json, blocks_json, row_hash)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                document.path,
                aliases,
                headings,
                blocks,
                document_row_hash(&document.path, &aliases, &headings, &blocks)
            ],
        )
        .map_err(|error| format!("write wiki cache document: {error}"))?;
    Ok(())
}

fn insert_occurrences(
    transaction: &Transaction<'_>,
    source: &str,
    occurrences: &[&InternalLinkOccurrence],
) -> Result<(), String> {
    for (ordinal, occurrence) in occurrences.iter().enumerate() {
        let ordinal = i64::try_from(ordinal).unwrap_or(i64::MAX);
        let occurrence_json = serde_json::to_string(occurrence)
            .map_err(|error| format!("encode wiki occurrence: {error}"))?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO occurrences (source, ordinal, occurrence_json, row_hash)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    source,
                    ordinal,
                    occurrence_json,
                    occurrence_row_hash(source, ordinal, &occurrence_json)
                ],
            )
            .map_err(|error| format!("write wiki cache occurrence: {error}"))?;
    }
    Ok(())
}

fn metadata_matches(transaction: &Transaction<'_>, vault_root: &Path) -> Result<bool, String> {
    let metadata = transaction
        .query_row(
            "SELECT schema_version, parser_version, vault_key, vault_path
             FROM cache_metadata WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read wiki cache metadata: {error}"))?;
    Ok(metadata.is_some_and(|metadata| {
        metadata.0 == WIKI_CACHE_SCHEMA_VERSION
            && metadata.1 == WIKI_PARSER_VERSION
            && metadata.2 == vault_key(vault_root)
            && metadata.3 == vault_identity(vault_root)
    }))
}

/// Persist the current snapshot. `Full` rewrites every row; `Incremental`
/// upserts/deletes only the given paths and silently upgrades itself to a full
/// rewrite when the on-disk metadata does not describe this exact cache
/// generation (missing file, foreign vault, old schema).
pub(crate) fn store_snapshot(
    cache_path: &Path,
    vault_root: &Path,
    fingerprints: &[WikiFileFingerprint],
    documents: &[WikiDocument],
    edges: &[ResolvedLink],
    write: &WikiSnapshotWrite,
) -> Result<(), String> {
    let parent = cache_path
        .parent()
        .ok_or_else(|| "wiki cache path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create wiki cache directory {}: {error}", parent.display()))?;
    let mut connection = Connection::open(cache_path)
        .map_err(|error| format!("open wiki cache {}: {error}", cache_path.display()))?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|error| format!("configure wiki cache timeout: {error}"))?;
    initialize_schema(&connection)?;

    let mut occurrences_by_source: BTreeMap<&str, Vec<&InternalLinkOccurrence>> = BTreeMap::new();
    for edge in edges {
        occurrences_by_source
            .entry(edge.occurrence.source.as_str())
            .or_default()
            .push(&edge.occurrence);
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("begin wiki cache transaction: {error}"))?;
    let incremental = match write {
        WikiSnapshotWrite::Full => None,
        WikiSnapshotWrite::Incremental { changed, removed } => {
            if metadata_matches(&transaction, vault_root)? {
                Some((changed, removed))
            } else {
                None
            }
        }
    };
    match incremental {
        Some((changed, removed)) => {
            let fingerprint_by_path: HashMap<&str, &WikiFileFingerprint> = fingerprints
                .iter()
                .map(|fingerprint| (fingerprint.relative_path.as_str(), fingerprint))
                .collect();
            let document_by_path: HashMap<&str, &WikiDocument> = documents
                .iter()
                .map(|document| (document.path.as_str(), document))
                .collect();
            for path in changed.iter().chain(removed.iter()) {
                transaction
                    .execute("DELETE FROM files WHERE relative_path = ?1", params![path])
                    .map_err(|error| format!("clear wiki cache fingerprint: {error}"))?;
                transaction
                    .execute("DELETE FROM documents WHERE path = ?1", params![path])
                    .map_err(|error| format!("clear wiki cache document: {error}"))?;
                transaction
                    .execute("DELETE FROM occurrences WHERE source = ?1", params![path])
                    .map_err(|error| format!("clear wiki cache occurrences: {error}"))?;
            }
            for path in changed {
                if let Some(fingerprint) = fingerprint_by_path.get(path.as_str()) {
                    insert_fingerprint(&transaction, fingerprint)?;
                }
                if let Some(document) = document_by_path.get(path.as_str()) {
                    insert_document(&transaction, document)?;
                }
                if let Some(occurrences) = occurrences_by_source.get(path.as_str()) {
                    insert_occurrences(&transaction, path, occurrences)?;
                }
            }
            transaction
                .execute(
                    "UPDATE cache_metadata SET built_at = ?1 WHERE id = 1",
                    params![built_at_now()],
                )
                .map_err(|error| format!("update wiki cache metadata: {error}"))?;
        }
        None => {
            transaction
                .execute_batch(
                    "DELETE FROM occurrences;
                     DELETE FROM documents;
                     DELETE FROM files;
                     DELETE FROM cache_metadata;",
                )
                .map_err(|error| format!("clear wiki cache snapshot: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO cache_metadata
                     (id, schema_version, parser_version, vault_key, vault_path, built_at)
                     VALUES (1, ?1, ?2, ?3, ?4, ?5)",
                    params![
                        WIKI_CACHE_SCHEMA_VERSION,
                        WIKI_PARSER_VERSION,
                        vault_key(vault_root),
                        vault_identity(vault_root),
                        built_at_now()
                    ],
                )
                .map_err(|error| format!("write wiki cache metadata: {error}"))?;
            for fingerprint in fingerprints {
                insert_fingerprint(&transaction, fingerprint)?;
            }
            for document in documents {
                insert_document(&transaction, document)?;
            }
            for (source, occurrences) in &occurrences_by_source {
                insert_occurrences(&transaction, source, occurrences)?;
            }
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("commit wiki cache snapshot: {error}"))
}

pub(crate) fn discard_snapshot(cache_path: &Path) -> Result<(), String> {
    for path in [
        cache_path.to_path_buf(),
        PathBuf::from(format!("{}-wal", cache_path.to_string_lossy())),
        PathBuf::from(format!("{}-shm", cache_path.to_string_lossy())),
    ] {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("remove stale wiki cache {}: {error}", path.display()))?;
        }
    }
    Ok(())
}
