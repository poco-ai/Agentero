//! Keep host-generated evidence and file receipts alongside provider-owned history.
//! The turn ID is carried in the user envelope; provider replay IDs may be synthetic.
use super::super::models::AcpHistoryLine;
use agentero_core::error::AppError;
use agentero_core::features::context::PresentedFile;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(crate) const MARKER: &str = "Agentero receipt ID: ";

#[derive(Serialize, Deserialize)]
struct Receipt {
    turn: Uuid,
    answer_hash: String,
    sources: Vec<String>,
    files: Vec<(String, Option<String>)>,
}

fn hash(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn directory(vault: &Path, agent: &str, session: &str) -> Result<PathBuf, AppError> {
    let vault = vault.canonicalize()?;
    let key = serde_json::to_string(&(vault.to_string_lossy(), agent, session))?;
    Ok(agentero_core::paths::agentero_config_dir()
        .join("agent-receipts")
        .join(hash(&key)))
}

pub(crate) struct ReceiptFile {
    dir: PathBuf,
    turn: Uuid,
}

impl ReceiptFile {
    pub(crate) fn new(
        vault: &Path,
        agent: &str,
        session: &str,
        message: &str,
    ) -> Result<Self, AppError> {
        let turn = Uuid::parse_str(message).map_err(|e| AppError::message(e.to_string()))?;
        Ok(Self {
            dir: directory(vault, agent, session)?,
            turn,
        })
    }
    pub(crate) fn write(
        &self,
        answer: &str,
        sources: &[String],
        artifacts: &[PresentedFile],
    ) -> Result<(), AppError> {
        if artifacts.is_empty() && sources.is_empty() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)?;
        let receipt = Receipt {
            turn: self.turn,
            answer_hash: hash(answer.trim()),
            sources: sources.to_vec(),
            files: artifacts
                .iter()
                .map(|f| (f.path.clone(), f.title.clone()))
                .collect(),
        };
        agentero_core::fs::json_store_with(
            &self.dir.join(format!("{}.json", self.turn)),
            &receipt,
            &agentero_core::fs::AtomicOpts::OWNER_ONLY,
        )
    }
}

fn replay_turn(line: &AcpHistoryLine) -> Option<Uuid> {
    if line.kind != "user" {
        return None;
    }
    let envelope = line
        .text
        .split_once(super::super::prompt::envelope::USER_REQUEST_MARKER)
        .map_or(line.text.as_str(), |(before, _)| before);
    envelope
        .lines()
        .find_map(|line| Uuid::parse_str(line.strip_prefix(MARKER)?.trim()).ok())
}

pub(crate) fn restore(
    vault: &Path,
    agent: &str,
    session: &str,
    lines: &mut Vec<AcpHistoryLine>,
) -> Result<(), AppError> {
    let dir = directory(vault, agent, session)?;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let mut by_turn = HashMap::new();
    let mut by_answer = HashMap::new();
    for entry in entries {
        let entry = entry?;
        if entry.path().extension().is_none_or(|e| e != "json") || !entry.file_type()?.is_file() {
            continue;
        }
        let receipt: Receipt = serde_json::from_reader(std::fs::File::open(entry.path())?)?;
        // A fallback is safe only when both transcript and receipt are unambiguous.
        by_answer
            .entry(receipt.answer_hash.clone())
            .and_modify(|id| *id = None)
            .or_insert(Some(receipt.turn));
        by_turn.insert(receipt.turn, receipt);
    }
    let marked: HashSet<_> = lines.iter().filter_map(replay_turn).collect();
    let mut answer_counts = HashMap::<String, usize>::new();
    for line in lines
        .iter()
        .filter(|l| l.kind == "agent" && !l.text.trim().is_empty())
    {
        *answer_counts.entry(hash(line.text.trim())).or_default() += 1;
    }
    // Some providers omit an empty assistant response after a tool succeeds.
    // Recreate its delivery card only when that exact user turn is identifiable.
    for i in (0..lines.len()).rev() {
        if let Some(id) = replay_turn(&lines[i]).filter(|id| by_turn.contains_key(id)) {
            if lines.get(i + 1).is_none_or(|l| l.kind == "user") {
                lines.insert(
                    i + 1,
                    AcpHistoryLine {
                        id: format!("receipt-{id}"),
                        kind: "agent".into(),
                        text: String::new(),
                        reasoning: None,
                        parts: vec![],
                        sources: vec![],
                        artifacts: vec![],
                    },
                );
            }
        }
    }
    let mut turn = None;
    for line in lines {
        if line.kind == "user" {
            turn = replay_turn(line);
        } else if line.kind == "agent" {
            let id = turn.take().or_else(|| {
                let key = hash(line.text.trim());
                if answer_counts.get(&key) != Some(&1) {
                    return None;
                }
                by_answer
                    .get(&key)
                    .copied()
                    .flatten()
                    .filter(|id| !marked.contains(id))
            });
            if let Some(receipt) = id.and_then(|id| by_turn.remove(&id)) {
                for source in receipt.sources {
                    if !line.sources.contains(&source) {
                        line.sources.push(source);
                    }
                }
                line.artifacts = receipt
                    .files
                    .into_iter()
                    .map(|(path, title)| PresentedFile {
                        vault: vault.to_string_lossy().into_owned(),
                        path,
                        title,
                    })
                    .collect();
            }
        }
    }
    Ok(())
}

pub(crate) fn forget(vault: &Path, agent: &str, session: &str) -> Result<(), AppError> {
    match std::fs::remove_dir_all(directory(vault, agent, session)?) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => Ok(result?),
    }
}
