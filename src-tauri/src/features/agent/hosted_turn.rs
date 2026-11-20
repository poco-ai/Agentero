//! Short-lived CLI authority and actual evidence/outputs owned by one desktop turn.
use super::session::receipts::ReceiptFile;
use agentero_core::{
    error::AppError,
    features::context::{present_files, ContextGrant, PresentedFile},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex, RwLock, Weak,
    },
};
use tokio::sync::watch;

static TURNS: LazyLock<Mutex<HashMap<String, Weak<HostedTurn>>>> = LazyLock::new(Mutex::default);

fn denied() -> AppError {
    AppError::domain("scope_denied", "unknown, expired or revoked desktop turn")
}

#[derive(Default)]
struct Usage {
    history: Option<ReceiptFile>,
    spent: usize,
    sources: Vec<String>,
    artifacts: Vec<PresentedFile>,
}

pub(crate) struct HostedTurn {
    pub token: String,
    vault: PathBuf,
    window: Arc<RwLock<String>>,
    cancelled: watch::Receiver<bool>,
    revoked: AtomicBool,
    pub grant: Option<ContextGrant>,
    usage: Mutex<Usage>,
}

/// Only the running task owns the lease. In-flight requests cannot extend it.
pub(crate) struct TurnLease(pub Arc<HostedTurn>);
impl Drop for TurnLease {
    fn drop(&mut self) {
        self.0.revoked.store(true, Ordering::Release);
        TURNS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0.token);
    }
}

impl HostedTurn {
    pub fn begin(
        vault: &Path,
        window: Arc<RwLock<String>>,
        cancelled: watch::Receiver<bool>,
        grant: Option<ContextGrant>,
    ) -> Arc<TurnLease> {
        let turn = Arc::new(Self {
            token: uuid::Uuid::new_v4().to_string(),
            vault: crate::core::fs::canonicalize_best_effort(vault),
            window,
            cancelled,
            grant,
            revoked: AtomicBool::new(false),
            usage: Mutex::default(),
        });
        TURNS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(turn.token.clone(), Arc::downgrade(&turn));
        Arc::new(TurnLease(turn))
    }
    pub fn lookup(token: &str) -> Result<Arc<Self>, AppError> {
        let turn = TURNS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .and_then(Weak::upgrade)
            .ok_or_else(denied)?;
        turn.ensure_active()?;
        Ok(turn)
    }
    fn ensure_active(&self) -> Result<(), AppError> {
        if self.revoked.load(Ordering::Acquire) || *self.cancelled.borrow() {
            Err(denied())
        } else {
            Ok(())
        }
    }
    pub fn window_label(&self) -> String {
        self.window
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn read(&self, name: &str, args: Value) -> Result<Value, AppError> {
        let grant = self.grant.as_ref().ok_or_else(denied)?;
        let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_active()?;
        let (result, spent, sources) =
            agentero_core::features::evidence::execute_scoped(grant, name, args, usage.spent)?;
        self.ensure_active()?;
        usage.spent += spent;
        for source in sources {
            if !usage.sources.contains(&source) {
                usage.sources.push(source);
            }
        }
        Ok(result)
    }
    pub fn bind_history(&self, agent: &str, session: &str, message: &str) -> Result<(), AppError> {
        let history = ReceiptFile::new(&self.vault, agent, session, message)?;
        self.usage.lock().unwrap_or_else(|e| e.into_inner()).history = Some(history);
        Ok(())
    }
    pub fn present(&self, args: &Value) -> Result<Value, AppError> {
        let paths: Vec<String> = serde_json::from_value(args["paths"].clone())?;
        let files = present_files(&self.vault, &paths, args["title"].as_str())?;
        let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_active()?;
        let mut items = Vec::new();
        let mut artifacts = usage.artifacts.clone();
        for file in files {
            let preview = file.preview_kind();
            items.push(json!({"path":file.path,"open_ref":file.path,"preview_kind":preview}));
            if !artifacts.iter().any(|f| f.path == file.path) {
                artifacts.push(file);
            }
        }
        let history = usage.history.as_ref().ok_or_else(|| {
            AppError::domain("turn_unavailable", "the provider session has not started")
        })?;
        history.write("", &usage.sources, &artifacts)?;
        usage.artifacts = artifacts;
        Ok(json!({"items":items}))
    }
    pub fn receipt(&self, answer: &str) -> (Vec<String>, Vec<PresentedFile>) {
        let usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(file) = &usage.history {
            if let Err(error) = file.write(answer, &usage.sources, &usage.artifacts) {
                log::warn!(target:"agentero::agent","save turn receipt: {error}");
            }
        }
        (usage.sources.clone(), usage.artifacts.clone())
    }
}

pub(crate) fn revoke_window(label: &str, vault: Option<&Path>) {
    for turn in TURNS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .filter_map(Weak::upgrade)
    {
        if turn.window_label() == label && vault.is_none_or(|v| v == turn.vault) {
            turn.revoked.store(true, Ordering::Release);
        }
    }
}
