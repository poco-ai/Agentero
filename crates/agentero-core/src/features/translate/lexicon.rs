//! Read-only, indexed lookup in the dictionary shipped with the desktop app.
use crate::error::AppError;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryEntry {
    pub word: String,
    pub phonetic: String,
    pub translation: String,
    pub definition: String,
    pub source: String,
    pub source_url: String,
}

pub fn lookup(path: &Path, query: &str, target: &str) -> Result<Vec<DictionaryEntry>, AppError> {
    let query = query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if query.is_empty() || query.chars().count() > 80 || !matches!(target, "en" | "zh-CN") {
        return Ok(vec![]);
    }
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut stmt = db.prepare("SELECT word, phonetic, translation, definition, source, source_url FROM entries WHERE lookup = ?1 OR (NOT EXISTS(SELECT 1 FROM entries WHERE lookup = ?1) AND lookup IN (SELECT canonical FROM aliases WHERE lookup = ?1 LIMIT 2)) ORDER BY priority DESC LIMIT 4")?;
    let entries = stmt
        .query_map([&query], |row| {
            Ok(DictionaryEntry {
                word: row.get(0)?,
                phonetic: row.get(1)?,
                translation: row.get(2)?,
                definition: row.get(3)?,
                source: row.get(4)?,
                source_url: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(entries
        .into_iter()
        .filter(|e| {
            if target == "en" {
                !e.definition.is_empty()
            } else {
                !e.translation.is_empty()
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indexed_lookup_is_case_insensitive_and_never_executes_query_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dictionary.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE entries(lookup TEXT, word TEXT, phonetic TEXT, translation TEXT, definition TEXT, source TEXT, source_url TEXT, priority INTEGER); CREATE INDEX lookup_index ON entries(lookup); CREATE TABLE aliases(lookup TEXT, canonical TEXT); INSERT INTO aliases VALUES('examples','example'); INSERT INTO entries VALUES('example','example','','示例','an illustration','test','https://example.org',0);").unwrap();
        drop(db);
        assert_eq!(
            lookup(&path, " Example ", "zh-CN").unwrap()[0].word,
            "example"
        );
        assert!(lookup(&path, "' OR 1=1 --", "zh-CN").unwrap().is_empty());
        assert!(lookup(&path, "example", "fr").unwrap().is_empty());
        assert_eq!(
            lookup(&path, "examples", "zh-CN").unwrap()[0].word,
            "example"
        );
    }
}
