//! Typed event contract (tauri-specta): declares the desktop event surface
//! exported into `src/lib/core/bindings.ts` (`events.*` helpers).
//!
//! Emit sites are untouched: the backend keeps emitting through
//! `app.emit("<literal>", payload)`. Each struct below is either
//! - a transparent newtype over the existing payload type (named payloads), or
//! - an owned mirror of the exact serde shape (private / borrowed-lifetime /
//!   inline `json!` payloads), annotated with
//!   `#[tauri_specta(event_name = "...")]` so the generated TS event name
//!   matches the emitted literal byte-for-byte.
//!
//! Naming: TS type name = struct name. Where the payload type already owns the
//! natural `XEvent` name (agent ACP payloads), the wrapper is named `XEvt` to
//! keep specta type names unique.
//!
//! Coverage: every event emitted on desktop. iOS-only bridge client events
//! (`bridge:status`, `bridge:progress`, `bridge:pair-pending` and the
//! dynamically re-emitted forwarded agent events in
//! `integration::bridge::client`) are intentionally excluded — they exist only
//! in the iOS branch, mirroring the command exclusion in `bindings_test.rs`.
//!
//! `job:progress` is emitted from several sites with structurally compatible
//! payloads (`AssetDownloadProgress`, model-assets `ProgressEvent`,
//! citing-scan `CitingScanProgress`); `AssetDownloadProgress` is the canonical
//! wire shape (superset; the citing-scan variant additionally omits null
//! `totalBytes`/counters, which TS already treats as optional). The wire name
//! lives in `assets::JOB_PROGRESS_EVENT`; Host emitters route through
//! `features::jobs::emit_job_progress`, core emitters use the constant.

// Contract-only types: their fields are consumed by the specta exporter, never
// read by Rust code.
#![allow(dead_code)]

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "job:offer")]
pub struct JobOfferEvent(pub crate::features::jobs::JobOfferPayload);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "job:changed")]
pub struct JobChangedEvent(pub crate::features::jobs::JobChangedPayload);

/// Owned mirror of the private `JobEventPayload` in `features::lifecycle`
/// (shared by `job:completed` / `job:failed`).
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JobTerminalPayload {
    pub job_id: String,
    pub kind: crate::features::jobs::JobKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper_id: Option<String>,
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "job:completed")]
pub struct JobCompletedEvent(pub JobTerminalPayload);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "job:failed")]
pub struct JobFailedEvent(pub JobTerminalPayload);

/// Mirror of the inline `json!({ "action": id })` in `app::mod` menu wiring.
#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "menu:invoked")]
pub struct MenuInvokedEvent {
    pub action: String,
}

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "vault:open-request")]
pub struct VaultOpenRequestEvent(pub agentero_core::features::open_request::VaultOpenPayload);

/// Mirror of the inline `json!({ "message": ... })` in `app::open_request`.
#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "vault:open-error")]
pub struct VaultOpenErrorEvent {
    pub message: String,
}

/// Owned mirror of the private borrowed `WindowClosedPayload` in
/// `app::window::commands`.
#[derive(serde::Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "window:closed")]
pub struct WindowClosedEvent {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
}

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "vault:file-changed")]
pub struct VaultFileChangedEvent(pub crate::features::vault::watcher::FileChangedPayload);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "settings:changed")]
pub struct SettingsChangedEvent(pub crate::features::system::settings::AppSettings);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "job:progress")]
pub struct JobProgressEvent(
    pub agentero_core::features::paper::import::download::AssetDownloadProgress,
);

/// Owned mirror of the private `CloudProgressPayload` in
/// `features::paper::analyze::layout::hosted`.
#[derive(serde::Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "layout-remote:progress")]
pub struct LayoutRemoteProgressEvent {
    pub phase: String,
    pub extracted_pages: Option<u64>,
    pub total_pages: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// Owned mirror of the private `ToolLifecycleProgress` in
/// `features::agent::registry::lifecycle`.
#[derive(serde::Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "agent-lifecycle:progress")]
pub struct AgentLifecycleProgressEvent {
    pub task_id: String,
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub progress: Option<u8>,
}

/// Mirror of the inline `json!({})` payload in `features::agent::service`.
#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:registry-changed")]
pub struct AgentRegistryChangedEvent {}

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:ask-user-request")]
pub struct AskUserRequestEvt(pub crate::features::agent::acp::ask_user::AskUserRequestEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:elicitation-request")]
pub struct ElicitationRequestEvt(
    pub crate::features::agent::acp::interaction::ElicitationRequestEvent,
);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:permission-request")]
pub struct PermissionRequestEvt(
    pub crate::features::agent::acp::interaction::PermissionRequestEvent,
);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:models")]
pub struct AgentModelsEvt(pub crate::features::agent::models::AgentModelsEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:collaboration")]
pub struct AgentCollaborationEvt(pub crate::features::agent::models::AgentCollaborationEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:effort")]
pub struct AgentEffortEvt(pub crate::features::agent::models::AgentEffortEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:fast-mode")]
pub struct AgentFastModeEvt(pub crate::features::agent::models::AgentFastModeEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:commands")]
pub struct AgentCommandsEvt(pub crate::features::agent::models::AgentCommandsEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:tool")]
pub struct AgentToolEvt(pub crate::features::agent::models::AgentToolEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:plan")]
pub struct AgentPlanEvt(pub crate::features::agent::models::AgentPlanEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:usage")]
pub struct AgentUsageEvt(pub crate::features::agent::models::AgentUsageEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:session-info")]
pub struct AgentSessionInfoEvt(pub crate::features::agent::models::AgentSessionInfoEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:failed")]
pub struct AgentFailedEvt(pub crate::features::agent::models::AgentFailedEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:stream")]
pub struct AgentStreamEvt(pub crate::features::agent::models::AgentStreamEvent);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "agent:completed")]
pub struct AgentCompletedEvent(pub crate::features::agent::models::AgentResultPayload);

/// Desktop bridge host online flag (`bridge:host-status`, payload `bool`).
#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "bridge:host-status")]
pub struct BridgeHostStatusEvent(pub bool);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "bridge:pair-request")]
pub struct BridgePairRequestEvent(pub crate::integration::bridge::PairingRequest);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "connector:status")]
pub struct ConnectorStatusEvent(pub crate::integration::connector::ConnectorStatus);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "connector:item-saved")]
pub struct ConnectorItemSavedEvent(pub crate::integration::connector::ConnectorItemSaved);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "connector:progress")]
pub struct ConnectorProgressEvent(pub crate::integration::connector::ConnectorProgress);

/// Mirror of the inline `json!({ "message", "sessionId" })` in
/// `integration::connector::state::emit_error`.
#[derive(serde::Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "connector:error")]
pub struct ConnectorErrorEvent {
    pub message: String,
    pub session_id: Option<String>,
}

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "mcp:status")]
pub struct McpStatusEvent(pub crate::integration::mcp::McpStatus);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "mcp:tunnel-status")]
pub struct McpTunnelStatusEvent(pub crate::integration::mcp::tunnel::McpTunnelStatus);

/// Owned mirror of the private borrowed `SyncStateEvent` in
/// `integration::sync::commands`.
#[derive(serde::Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "sync:state")]
pub struct SyncStateEvent {
    pub vault_path: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Owned mirror of the private borrowed `SyncProgressEvent` in
/// `integration::sync::commands`.
#[derive(serde::Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "sync:progress")]
pub struct SyncProgressEvent {
    pub vault_path: String,
    pub phase: String,
    pub current: usize,
    pub total: usize,
}

/// Owned mirror of the private core `PaperEventPayload` envelope
/// (`paper:imported` / `paper:assets-ready`).
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperFactPayload {
    pub vault_id: String,
    pub paper_id: String,
    pub timestamp: i64,
}

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "paper:imported")]
pub struct PaperImportedEvent(pub PaperFactPayload);

#[derive(specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "paper:assets-ready")]
pub struct PaperAssetsReadyEvent(pub PaperFactPayload);

/// Owned mirror of the private flattened `paper:renamed` envelope in
/// `agentero_core::features::lifecycle` (vaultId + `PaperRenamedEvent` fields
/// + timestamp, all camelCase).
#[derive(serde::Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "paper:renamed")]
pub struct PaperRenamedEventPayload {
    pub vault_id: String,
    pub old_paper_id: String,
    pub new_paper_id: String,
    pub old_path: String,
    pub new_path: String,
    /// `renamed` | `merged`
    pub outcome: String,
    pub updated_sources: Vec<String>,
    pub timestamp: i64,
}

/// Anti-drift: event names registered here must equal the literals/constants
/// used by the emit sites.
#[test]
fn event_names_match_emit_literals() {
    use tauri_specta::Event;
    assert_eq!(JobOfferEvent::NAME, crate::features::jobs::JOB_OFFER_EVENT);
    assert_eq!(
        JobChangedEvent::NAME,
        crate::features::jobs::JOB_CHANGED_EVENT
    );
    assert_eq!(
        JobCompletedEvent::NAME,
        crate::features::lifecycle::JOB_COMPLETED_EVENT
    );
    assert_eq!(
        JobFailedEvent::NAME,
        crate::features::lifecycle::JOB_FAILED_EVENT
    );
    assert_eq!(MenuInvokedEvent::NAME, crate::app::menu::MENU_INVOKED_EVENT);
    assert_eq!(
        VaultOpenRequestEvent::NAME,
        agentero_core::features::open_request::EVENT_VAULT_OPEN_REQUEST
    );
    assert_eq!(
        WindowClosedEvent::NAME,
        crate::app::window::commands::WINDOW_CLOSED_EVENT
    );
    assert_eq!(
        LayoutRemoteProgressEvent::NAME,
        crate::features::paper::analyze::layout::hosted::CLOUD_PROGRESS_EVENT
    );
    assert_eq!(
        PaperImportedEvent::NAME,
        agentero_core::features::lifecycle::PAPER_IMPORTED_EVENT
    );
    assert_eq!(
        PaperAssetsReadyEvent::NAME,
        agentero_core::features::lifecycle::PAPER_ASSETS_READY_EVENT
    );
    assert_eq!(
        PaperRenamedEventPayload::NAME,
        agentero_core::features::lifecycle::PAPER_RENAMED_EVENT
    );
    assert_eq!(
        McpStatusEvent::NAME,
        crate::integration::mcp::MCP_STATUS_EVENT
    );
    assert_eq!(
        McpTunnelStatusEvent::NAME,
        crate::integration::mcp::tunnel::MCP_TUNNEL_STATUS_EVENT
    );
}

// ---------------------------------------------------------------------------
// Anti-drift: whole-corpus event-name scan (T1).
//
// `event_names_match_emit_literals` only covers the 13 events whose names live
// in `const`s reachable from this crate. The scan below walks every `.rs` file
// under `src-tauri/src` and `crates/agentero-core/src`, extracts the event name
// of every Tauri emit call site and asserts the set equals the 43 names
// registered in this file. Scan rules (comments/strings are tokenized first):
//
// - `.emit(<name>, ..)` / `.emit_to(<target>, <name>, ..)`:
//   - `"literal"`                       -> captured verbatim;
//   - `CONST` / `path::to::CONST`       -> resolved through the corpus-wide
//                                           `const NAME: &str = ".."` table;
//   - `event` / `&event`                -> pass-through helper (the name is a
//                                           function parameter). All such
//                                           helpers in this codebase are fed
//                                           by `*EVENT*` consts of their own
//                                           file, so those consts are captured
//                                           as the file's contribution;
//   - anything else                     -> hard panic (no silent misses: new
//                                           emit forms must extend the scan).
// - `.emit_all(` / `.emit_filter(`      -> hard panic (unused Tauri forms).
// - wrapper methods (`.emit_status(`, `.emit_error(`, ...) are skipped: the
//   real Tauri emit happens inside them and is captured at that site.
//
// Excluded files (documented misses, see module header):
// - `integration/bridge/client.rs`: iOS-only bridge client (`bridge:status`,
//   `bridge:progress`, `bridge:pair-pending` + the dynamic `bridge:event:*`
//   re-emits) — not part of the desktop contract;
// - `app/bindings_test.rs` / `app/events_contract.rs`: test-only surfaces.
// ---------------------------------------------------------------------------

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Every event name registered in this file (the desktop contract surface).
fn registered_event_names() -> BTreeSet<String> {
    use tauri_specta::Event as _;
    let names: [&str; 42] = [
        JobOfferEvent::NAME,
        JobChangedEvent::NAME,
        JobCompletedEvent::NAME,
        JobFailedEvent::NAME,
        MenuInvokedEvent::NAME,
        VaultOpenRequestEvent::NAME,
        VaultOpenErrorEvent::NAME,
        WindowClosedEvent::NAME,
        VaultFileChangedEvent::NAME,
        SettingsChangedEvent::NAME,
        JobProgressEvent::NAME,
        LayoutRemoteProgressEvent::NAME,
        AgentLifecycleProgressEvent::NAME,
        AgentRegistryChangedEvent::NAME,
        AskUserRequestEvt::NAME,
        ElicitationRequestEvt::NAME,
        PermissionRequestEvt::NAME,
        AgentModelsEvt::NAME,
        AgentCollaborationEvt::NAME,
        AgentEffortEvt::NAME,
        AgentFastModeEvt::NAME,
        AgentCommandsEvt::NAME,
        AgentToolEvt::NAME,
        AgentPlanEvt::NAME,
        AgentUsageEvt::NAME,
        AgentSessionInfoEvt::NAME,
        AgentFailedEvt::NAME,
        AgentStreamEvt::NAME,
        AgentCompletedEvent::NAME,
        BridgeHostStatusEvent::NAME,
        BridgePairRequestEvent::NAME,
        ConnectorStatusEvent::NAME,
        ConnectorItemSavedEvent::NAME,
        ConnectorProgressEvent::NAME,
        ConnectorErrorEvent::NAME,
        McpStatusEvent::NAME,
        McpTunnelStatusEvent::NAME,
        SyncStateEvent::NAME,
        SyncProgressEvent::NAME,
        PaperImportedEvent::NAME,
        PaperAssetsReadyEvent::NAME,
        PaperRenamedEventPayload::NAME,
    ];
    let set: BTreeSet<String> = names.iter().map(|n| n.to_string()).collect();
    assert_eq!(set.len(), names.len(), "duplicate NAME in registered list");
    set
}

fn find_all(chars: &[char], needle: &str) -> Vec<usize> {
    let n: Vec<char> = needle.chars().collect();
    assert!(!n.is_empty());
    if chars.len() < n.len() {
        return Vec::new();
    }
    chars
        .windows(n.len())
        .enumerate()
        .filter(|(_, w)| *w == n.as_slice())
        .map(|(i, _)| i)
        .collect()
}

fn line_of(chars: &[char], idx: usize) -> usize {
    chars[..idx].iter().filter(|&&c| c == '\n').count() + 1
}

fn is_char_literal(chars: &[char], i: usize) -> bool {
    // `chars[i] == '\''`: char literal (`'a'`, `'\n'`, `'\''`) vs lifetime (`'a`).
    debug_assert_eq!(chars[i], '\'');
    matches!(
        (chars.get(i + 1), chars.get(i + 2), chars.get(i + 3)),
        (Some('\\'), Some(_), Some('\'')) | (Some(_), Some('\''), _)
    )
}

/// Length of the char literal starting at `i` (`chars[i] == '\''`), closing
/// quote included.
fn char_literal_len(chars: &[char], i: usize) -> usize {
    if chars.get(i + 1) == Some(&'\\') {
        4
    } else {
        3
    }
}

/// Read a `"..."` string starting at `start` (must point at the opening
/// quote); returns (unescaped content, index just past the closing quote).
fn read_string(chars: &[char], start: usize) -> (String, usize) {
    debug_assert_eq!(chars[start], '"');
    let mut i = start + 1;
    let mut s = String::new();
    while i < chars.len() {
        match chars[i] {
            '\\' => {
                if let Some(&n) = chars.get(i + 1) {
                    s.push(n);
                }
                i += 2;
            }
            '"' => return (s, i + 1),
            c => {
                s.push(c);
                i += 1;
            }
        }
    }
    panic!("unterminated string literal");
}

/// Strip `//` and (nested) `/* */` comments, keeping newlines (so panic
/// messages report usable line numbers) and every string / raw-string /
/// char-literal verbatim, so the emit scanner never sees commented-out code.
fn strip_comments(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let get = |i: usize| chars.get(i).copied();
    let mut out = String::with_capacity(src.len());
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '/' && get(i + 1) == Some('/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && get(i + 1) == Some('*') {
            let mut depth = 1usize;
            i += 2;
            while i < chars.len() && depth > 0 {
                if chars[i] == '/' && get(i + 1) == Some('*') {
                    depth += 1;
                    i += 2;
                } else if chars[i] == '*' && get(i + 1) == Some('/') {
                    depth -= 1;
                    i += 2;
                } else {
                    if chars[i] == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
            }
            continue;
        }
        // Raw strings: r"..." / r#"..."# / br#"..."# (verbatim copy).
        let raw_body = if c == 'r' {
            Some(i + 1)
        } else if c == 'b' && get(i + 1) == Some('r') {
            Some(i + 2)
        } else {
            None
        };
        if let Some(mut j) = raw_body {
            let mut hashes = 0usize;
            while get(j) == Some('#') {
                hashes += 1;
                j += 1;
            }
            if get(j) == Some('"') {
                let mut k = j + 1;
                let mut end = chars.len();
                while k < chars.len() {
                    if chars[k] == '"' {
                        let mut h = 0usize;
                        while h < hashes && get(k + 1 + h) == Some('#') {
                            h += 1;
                        }
                        if h == hashes {
                            end = k + 1 + hashes;
                            break;
                        }
                    }
                    k += 1;
                }
                out.extend(&chars[i..end]);
                i = end;
                continue;
            }
        }
        // Plain / byte strings.
        if c == '"' || (c == 'b' && get(i + 1) == Some('"')) {
            let open = if c == '"' { i } else { i + 1 };
            let (_, next) = read_string(&chars, open);
            out.extend(&chars[i..next]);
            i = next;
            continue;
        }
        // Char literals (`'/'` would otherwise confuse the comment states).
        let char_start = if c == '\'' && is_char_literal(&chars, i) {
            Some(i)
        } else if c == 'b' && get(i + 1) == Some('\'') && is_char_literal(&chars, i + 1) {
            Some(i + 1)
        } else {
            None
        };
        if let Some(q) = char_start {
            let end = q + char_literal_len(&chars, q);
            out.extend(&chars[i..end.min(chars.len())]);
            i = end.min(chars.len());
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// All `const NAME: &str = "value";` definitions (name -> value).
fn scan_str_consts(chars: &[char]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for pos in find_all(chars, "const ") {
        if pos > 0 && (chars[pos - 1].is_alphanumeric() || chars[pos - 1] == '_') {
            continue;
        }
        let mut i = pos + "const ".len();
        let ident_start = i;
        while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
            i += 1;
        }
        if i == ident_start {
            continue;
        }
        let ident: String = chars[ident_start..i].iter().collect();
        fn skip_ws(chars: &[char], i: &mut usize) {
            while *i < chars.len() && chars[*i].is_whitespace() {
                *i += 1;
            }
        }
        skip_ws(chars, &mut i);
        if chars.get(i) != Some(&':') {
            continue;
        }
        i += 1;
        skip_ws(chars, &mut i);
        let ty_start = i;
        while i < chars.len() && chars[i] != '=' && chars[i] != ';' {
            i += 1;
        }
        let ty: String = chars[ty_start..i].iter().collect();
        if !matches!(ty.trim(), "&str" | "&'static str") {
            continue;
        }
        if chars.get(i) != Some(&'=') {
            continue;
        }
        i += 1;
        skip_ws(chars, &mut i);
        if chars.get(i) != Some(&'"') {
            continue;
        }
        let (value, next) = read_string(chars, i);
        i = next;
        skip_ws(chars, &mut i);
        if chars.get(i) != Some(&';') {
            continue;
        }
        out.insert(ident, value);
    }
    out
}

/// Split a call argument list starting just past the opening `(`. Strings and
/// char literals are copied verbatim; `()[]{}` nest. Returns (args, index just
/// past the closing `)`).
fn split_call_args(chars: &[char], start: usize) -> (Vec<String>, usize) {
    let mut args: Vec<String> = Vec::new();
    let mut cur: Vec<char> = Vec::new();
    let mut depth = 0usize;
    let mut i = start;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' => {
                let (_, next) = read_string(chars, i);
                cur.extend_from_slice(&chars[i..next]);
                i = next;
            }
            '\'' if is_char_literal(chars, i) => {
                let end = (i + char_literal_len(chars, i)).min(chars.len());
                cur.extend_from_slice(&chars[i..end]);
                i = end;
            }
            '(' | '[' | '{' => {
                depth += 1;
                cur.push(c);
                i += 1;
            }
            ')' | ']' | '}' => {
                if depth == 0 {
                    assert_eq!(c, ')', "unbalanced `{c}` while parsing emit args");
                    args.push(cur.into_iter().collect());
                    return (args, i + 1);
                }
                depth -= 1;
                cur.push(c);
                i += 1;
            }
            ',' if depth == 0 => {
                args.push(std::mem::take(&mut cur).into_iter().collect());
                i += 1;
            }
            _ => {
                cur.push(c);
                i += 1;
            }
        }
    }
    panic!("unterminated emit call args");
}

#[derive(Default)]
struct FileEmitScan {
    /// Literals captured at emit sites.
    literals: BTreeSet<String>,
    /// Const references used at emit sites (full argument text, possibly
    /// path-qualified; resolved corpus-wide in pass 2).
    const_refs: BTreeSet<String>,
    /// An emit site passes a dynamic `event` parameter (pass-through helper).
    dynamic: bool,
    /// `&str` consts of this file whose ident contains `EVENT` (the names a
    /// pass-through helper in this file can carry).
    event_consts: BTreeMap<String, String>,
}

fn scan_file_emits(
    display: &str,
    chars: &[char],
    consts: &BTreeMap<String, String>,
) -> FileEmitScan {
    let mut out = FileEmitScan {
        event_consts: consts
            .iter()
            .filter(|(k, _)| k.contains("EVENT"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        ..Default::default()
    };
    for pos in find_all(chars, ".emit") {
        let mut j = pos + ".emit".len();
        while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
            j += 1;
        }
        let suffix: String = chars[pos + ".emit".len()..j].iter().collect();
        let mut k = j;
        while k < chars.len() && chars[k].is_whitespace() {
            k += 1;
        }
        if chars.get(k) != Some(&'(') {
            continue;
        }
        // Name-argument index: `.emit(name, ..)` vs `.emit_to(target, name, ..)`.
        let name_idx = match suffix.as_str() {
            "" => 0,
            "_to" => 1,
            "_all" | "_filter" => panic!(
                "unsupported tauri emit form `.emit{suffix}(` at {display}:{} — extend the scanner",
                line_of(chars, pos)
            ),
            // Wrapper helpers (`emit_status`, `emit_error`, ...): the real
            // Tauri emit happens inside them and is captured at that site.
            _ => continue,
        };
        let (args, _) = split_call_args(chars, k + 1);
        let Some(arg) = args.get(name_idx) else {
            panic!(
                "`.emit{suffix}(` at {display}:{} has < {} args",
                line_of(chars, pos),
                name_idx + 1
            );
        };
        let t = arg.trim();
        if let Some(rest) = t.strip_prefix('"') {
            let Some(inner) = rest.strip_suffix('"') else {
                panic!(
                    "malformed emit name literal at {display}:{}",
                    line_of(chars, pos)
                );
            };
            assert!(
                !inner.contains('"') && !inner.contains('\\'),
                "unexpected escapes in emit name literal `{t}` at {display}:{}",
                line_of(chars, pos)
            );
            out.literals.insert(inner.to_string());
        } else if t == "event" || t == "&event" {
            out.dynamic = true;
        } else if !t.is_empty()
            && !t.starts_with(|c: char| c.is_ascii_digit())
            && t.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':')
        {
            out.const_refs.insert(t.to_string());
        } else {
            panic!(
                "cannot classify emit name argument `{t}` at {display}:{} — extend the scanner or exclude the file explicitly",
                line_of(chars, pos)
            );
        }
    }
    out
}

/// Scan every Rust source of the desktop Host + shared core crate and return
/// the set of event names reaching the frontend through Tauri emits.
fn scan_emit_event_names() -> BTreeSet<String> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let host_root = manifest_dir.join("src");
    let core_root = manifest_dir
        .join("..")
        .join("crates")
        .join("agentero-core")
        .join("src");
    // Relative to `src-tauri/src` (the core root has no exclusions).
    let excluded = [
        "integration/bridge/client.rs",
        "app/bindings_test.rs",
        "app/events_contract.rs",
    ];
    let mut files: Vec<PathBuf> = Vec::new();
    for root in [&host_root, &core_root] {
        for entry in walkdir::WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if !path.is_file() || path.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            if *root == host_root {
                let rel = path
                    .strip_prefix(root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                if excluded.contains(&rel.as_str()) {
                    continue;
                }
            }
            files.push(path.to_path_buf());
        }
    }
    files.sort();
    assert!(files.len() > 50, "source walk found too few files");

    // Pass 1: corpus-wide `&str` const table + per-file emit scan. The table
    // is ident -> all (value, defining file) pairs: unrelated consts may share
    // an ident (e.g. `SIDECAR_FILE`); only ambiguity at an emit-site reference
    // is an error (pass 2).
    let mut global_consts: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut scans: Vec<(String, FileEmitScan)> = Vec::new();
    for path in &files {
        let display = path.display().to_string();
        let src = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {display}: {e}"));
        let stripped = strip_comments(&src);
        let chars: Vec<char> = stripped.chars().collect();
        let consts = scan_str_consts(&chars);
        for (ident, value) in &consts {
            global_consts
                .entry(ident.clone())
                .or_default()
                .push((value.clone(), display.clone()));
        }
        let scan = scan_file_emits(&display, &chars, &consts);
        scans.push((display, scan));
    }

    // Pass 2: resolve const refs, apply the pass-through fallback.
    let mut names = BTreeSet::new();
    for (display, scan) in &scans {
        names.extend(scan.literals.iter().cloned());
        for qualified in &scan.const_refs {
            let ident = qualified.rsplit("::").next().unwrap_or(qualified);
            let defs = global_consts.get(ident).unwrap_or_else(|| {
                panic!("emit site in {display} references const `{qualified}` with no `&str` definition in the scanned corpus")
            });
            let mut values: BTreeSet<&str> = defs.iter().map(|(v, _)| v.as_str()).collect();
            if values.len() > 1 && qualified.contains("::") {
                // Path-qualified reference: keep the definitions whose module
                // path is compatible with the qualification tail.
                let tail: Vec<&str> = qualified
                    .split("::")
                    .filter(|s| !s.is_empty() && *s != "crate")
                    .collect();
                let matched: BTreeSet<&str> = defs
                    .iter()
                    .filter(|(_, def)| {
                        let mod_path = def.replace('\\', "/");
                        tail.iter().all(|seg| {
                            mod_path.contains(&format!("/{seg}.rs"))
                                || mod_path.contains(&format!("/{seg}/"))
                        })
                    })
                    .map(|(v, _)| v.as_str())
                    .collect();
                if matched.len() == 1 {
                    values = matched;
                }
            }
            assert_eq!(
                values.len(),
                1,
                "emit site in {display} references const `{qualified}` with ambiguous values {values:?} (defined in {:?})",
                defs.iter().map(|(_, f)| f).collect::<Vec<_>>()
            );
            names.insert(values.into_iter().next().unwrap().to_string());
        }
        if scan.dynamic {
            names.extend(scan.event_consts.values().cloned());
        }
    }
    names
}

#[test]
fn scanned_emit_event_names_match_registered_contract() {
    let scanned = scan_emit_event_names();
    let registered = registered_event_names();
    let emitted_not_registered: Vec<&String> = scanned.difference(&registered).collect();
    let registered_not_emitted: Vec<&String> = registered.difference(&scanned).collect();
    assert!(
        emitted_not_registered.is_empty() && registered_not_emitted.is_empty(),
        "event contract drift:\n  emitted but not registered: {emitted_not_registered:?}\n  registered but no emit site found: {registered_not_emitted:?}"
    );
}

// ---------------------------------------------------------------------------
// Anti-drift: mirror shape bindings (T2).
//
// The owned mirrors below exist because the real payloads are private /
// borrowed / inline `json!` values. Each mirror is bound to its real emit
// payload by one of:
// - serde shape equality tests in the *owning* module (private structs are
//   only reachable there): `features::lifecycle` (JobTerminalPayload),
//   `integration::sync::commands` (SyncState/SyncProgress),
//   `features::paper::analyze::layout::{model_assets, hosted}`
//   (LayoutModelTask/LayoutRemoteProgress), `features::agent::registry::
//   lifecycle` (AgentLifecycleProgress), `app::window::commands`
//   (WindowClosed);
// - `HostHooks` emit capture for the private agentero-core payloads
//   (PaperFact / PaperRenamed) — see the tests below;
// - source-level extraction of the inline `json!` keys for the four mirrors
//   of `json!` payloads (MenuInvoked / VaultOpenError / ConnectorError /
//   AgentRegistryChanged) — see the tests below.
// ---------------------------------------------------------------------------

/// Recursively collected JSON key paths (`a`, `a.b`, `a[].b`) of a serialized
/// value; scalars contribute nothing beyond their own key.
fn key_paths(value: &serde_json::Value) -> BTreeSet<String> {
    fn collect(value: &serde_json::Value, prefix: &str, out: &mut BTreeSet<String>) {
        match value {
            serde_json::Value::Object(map) => {
                for (k, v) in map {
                    let path = if prefix.is_empty() {
                        k.clone()
                    } else {
                        format!("{prefix}.{k}")
                    };
                    out.insert(path.clone());
                    collect(v, &path, out);
                }
            }
            serde_json::Value::Array(items) => {
                for v in items {
                    collect(v, &format!("{prefix}[]"), out);
                }
            }
            _ => {}
        }
    }
    let mut out = BTreeSet::new();
    collect(value, "", &mut out);
    out
}

/// Named-field keys of a mirror's specta type — used for the mirrors of
/// inline `json!` payloads, which intentionally do not derive `Serialize`.
fn specta_field_keys<T: specta::Type>() -> BTreeSet<String> {
    use specta::datatype::{DataType, Fields};
    let mut types = specta::Types::default();
    let dt = <T as specta::Type>::definition(&mut types);
    // Named structs are registered into `types` and returned as a reference;
    // anonymous ones come back inline. Unwrap either form to the struct.
    let struct_ty = match dt {
        DataType::Struct(s) => s,
        DataType::Reference(_) => {
            let mut found = None;
            for entry in types.into_unsorted_iter() {
                if let Some(DataType::Struct(s)) = &entry.ty {
                    assert!(
                        found.is_none(),
                        "multiple structs registered for one mirror"
                    );
                    found = Some(s.clone());
                }
            }
            found.unwrap_or_else(|| {
                panic!("mirror {} registered no struct", std::any::type_name::<T>())
            })
        }
        other => panic!(
            "mirror {} must be a struct, got {other:?}",
            std::any::type_name::<T>()
        ),
    };
    match struct_ty.fields {
        Fields::Named(named) => named
            .fields
            .iter()
            .map(|(name, _)| name.to_string())
            .collect(),
        Fields::Unit => BTreeSet::new(),
        _ => panic!(
            "mirror {} must have named fields",
            std::any::type_name::<T>()
        ),
    }
}

/// Top-level keys of every inline `json!` payload that follows an occurrence
/// of `anchor` (event literal including quotes, or const ident) in `rel_file`
/// (relative to the src-tauri manifest dir). Comments are stripped first.
fn inline_json_keys(rel_file: &str, anchor: &str) -> Vec<BTreeSet<String>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let src = std::fs::read_to_string(manifest_dir.join(rel_file))
        .unwrap_or_else(|e| panic!("read {rel_file}: {e}"));
    let chars: Vec<char> = strip_comments(&src).chars().collect();
    let needle_len = anchor.chars().count();
    let mut out = Vec::new();
    for pos in find_all(&chars, anchor) {
        let rest = &chars[pos + needle_len..];
        let Some(&jp) = find_all(rest, "json!").first() else {
            panic!(
                "no `json!` after `{anchor}` at {rel_file}:{}",
                line_of(&chars, pos)
            );
        };
        out.push(json_object_keys(rest, jp + "json!".len()));
    }
    assert!(!out.is_empty(), "anchor `{anchor}` not found in {rel_file}");
    out
}

/// Top-level keys of the object inside a `json!( { .. } )` body; `start` must
/// point at (or just before) the opening `(` of the macro call.
fn json_object_keys(chars: &[char], start: usize) -> BTreeSet<String> {
    let mut i = start;
    while chars[i].is_whitespace() {
        i += 1;
    }
    assert_eq!(chars[i], '(', "expected `json!(`");
    i += 1;
    let mut keys = BTreeSet::new();
    let mut paren = 1i32;
    let mut brace = 0i32;
    while i < chars.len() && paren > 0 {
        match chars[i] {
            '"' => {
                let (s, next) = read_string(chars, i);
                i = next;
                if brace == 1 {
                    let mut j = i;
                    while j < chars.len() && chars[j].is_whitespace() {
                        j += 1;
                    }
                    if chars.get(j) == Some(&':') {
                        keys.insert(s);
                    }
                }
            }
            '(' => {
                paren += 1;
                i += 1;
            }
            ')' => {
                paren -= 1;
                i += 1;
            }
            '{' => {
                brace += 1;
                i += 1;
            }
            '}' => {
                brace -= 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    keys
}

#[test]
fn menu_invoked_mirror_matches_inline_json_shape() {
    let sites = inline_json_keys("src/app/mod.rs", "MENU_INVOKED_EVENT");
    assert_eq!(
        sites.len(),
        1,
        "expected exactly one menu:invoked emit site"
    );
    assert_eq!(
        sites[0],
        specta_field_keys::<MenuInvokedEvent>(),
        "MenuInvokedEvent mirror drifted from the inline json! payload"
    );
}

#[test]
fn vault_open_error_mirror_matches_inline_json_shape() {
    let sites = inline_json_keys("src/app/open_request/mod.rs", "\"vault:open-error\"");
    assert_eq!(
        sites.len(),
        3,
        "expected the three vault:open-error emit sites"
    );
    let mirror = specta_field_keys::<VaultOpenErrorEvent>();
    for site in &sites {
        assert_eq!(
            site, &mirror,
            "VaultOpenErrorEvent mirror drifted from the inline json! payload"
        );
    }
}

#[test]
fn connector_error_mirror_matches_inline_json_shape() {
    let sites = inline_json_keys("src/integration/connector/state.rs", "\"connector:error\"");
    assert_eq!(sites.len(), 1, "expected one connector:error emit site");
    let mirror = key_paths(
        &serde_json::to_value(&ConnectorErrorEvent {
            message: "boom".to_string(),
            session_id: Some("session-1".to_string()),
        })
        .unwrap(),
    );
    assert_eq!(
        sites[0], mirror,
        "ConnectorErrorEvent mirror drifted from the inline json! payload"
    );
}

#[test]
fn agent_registry_changed_mirror_matches_inline_json_shape() {
    let sites = inline_json_keys(
        "src/features/agent/service.rs",
        "\"agent:registry-changed\"",
    );
    assert_eq!(
        sites.len(),
        1,
        "expected one agent:registry-changed emit site"
    );
    assert!(
        sites[0].is_empty(),
        "agent:registry-changed payload must stay empty, got {:?}",
        sites[0]
    );
    assert_eq!(
        sites[0],
        specta_field_keys::<AgentRegistryChangedEvent>(),
        "AgentRegistryChangedEvent mirror drifted from the inline json! payload"
    );
}

/// Captures `HostHooks::emit` payloads so the private agentero-core payload
/// structs (`PaperEventPayload`, the flattened `paper:renamed` envelope) can
/// be shape-compared against their owned mirrors in this file.
#[derive(Default)]
struct CaptureHooks {
    captured: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
}

impl agentero_core::app_handle::HostHooks for CaptureHooks {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.captured
            .lock()
            .expect("hooks lock")
            .push((event.to_string(), payload));
    }
}

#[test]
fn paper_fact_mirror_matches_core_emit_shape() {
    use agentero_core::features::lifecycle::{emit_paper_assets_ready, emit_paper_imported};
    use tauri_specta::Event as _;
    let hooks = std::sync::Arc::new(CaptureHooks::default());
    let app = agentero_core::app_handle::AppHandle::with_hooks(hooks.clone());
    emit_paper_imported(Some(&app), Path::new("/tmp/vault"), "paper-1");
    emit_paper_assets_ready(Some(&app), Path::new("/tmp/vault"), "paper-1");
    let captured = hooks.captured.lock().expect("hooks lock");
    let events: Vec<&str> = captured.iter().map(|(e, _)| e.as_str()).collect();
    assert_eq!(
        events,
        [PaperImportedEvent::NAME, PaperAssetsReadyEvent::NAME],
        "core paper fact events drifted from the registered names"
    );
    let mirror = key_paths(
        &serde_json::to_value(&PaperFactPayload {
            vault_id: "/tmp/vault".to_string(),
            paper_id: "paper-1".to_string(),
            timestamp: 0,
        })
        .unwrap(),
    );
    for (_, value) in captured.iter() {
        assert_eq!(
            &key_paths(value),
            &mirror,
            "PaperFactPayload mirror drifted from the core PaperEventPayload emit shape"
        );
    }
}

#[test]
fn paper_renamed_mirror_matches_core_emit_shape() {
    use agentero_core::features::lifecycle::{emit_paper_renamed, PaperRenamedEvent};
    use tauri_specta::Event as _;
    let hooks = std::sync::Arc::new(CaptureHooks::default());
    let app = agentero_core::app_handle::AppHandle::with_hooks(hooks.clone());
    emit_paper_renamed(
        Some(&app),
        Path::new("/tmp/vault"),
        PaperRenamedEvent {
            old_paper_id: "old-slug".to_string(),
            new_paper_id: "canonical-id".to_string(),
            old_path: "papers/old-slug".to_string(),
            new_path: "papers/canonical-id".to_string(),
            outcome: "renamed".to_string(),
            updated_sources: vec!["papers/canonical-id/NOTES.md".to_string()],
        },
    );
    let captured = hooks.captured.lock().expect("hooks lock");
    assert_eq!(captured.len(), 1);
    assert_eq!(
        captured[0].0,
        PaperRenamedEventPayload::NAME,
        "core paper:renamed event name drifted from the registered name"
    );
    let mirror = key_paths(
        &serde_json::to_value(&PaperRenamedEventPayload {
            vault_id: "/tmp/vault".to_string(),
            old_paper_id: "old-slug".to_string(),
            new_paper_id: "canonical-id".to_string(),
            old_path: "papers/old-slug".to_string(),
            new_path: "papers/canonical-id".to_string(),
            outcome: "renamed".to_string(),
            updated_sources: vec!["papers/canonical-id/NOTES.md".to_string()],
            timestamp: 0,
        })
        .unwrap(),
    );
    assert_eq!(
        &key_paths(&captured[0].1),
        &mirror,
        "PaperRenamedEventPayload mirror drifted from the flattened core envelope \
         (vaultId + PaperRenamedEvent + timestamp, camelCase)"
    );
}
