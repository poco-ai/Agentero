//! ACP session list / load and history ReplayBuilder.

use crate::core::error::AppError;
use crate::features::agent::acp::client::{
    client_initialize_request, simplified_agent_cwd, timed_acp_initialize, timed_acp_request,
    to_acp_agent,
};
use crate::features::agent::acp::interaction::permission_response;
use crate::features::agent::acp::terminal::{AcpTerminalHandler, AcpTerminalManager};
use crate::features::agent::acp::updates::{
    plan_priority_str, plan_status_str, text_from_content_block, tool_kind_str, tool_status_str,
};
use crate::features::agent::models::{
    AcpHistoryLine, AcpHistoryPart, AcpHistoryTool, AcpListSessionsResult, AcpLoadSessionResult,
    AcpSessionInfo, AgentDescriptor, AgentPlanEntry,
};
use crate::features::agent::prompt::envelope::extract_sources;
use agent_client_protocol::schema::v1::{
    ListSessionsRequest, LoadSessionRequest, RequestPermissionRequest, SessionId,
    SessionNotification, SessionUpdate,
};
use agent_client_protocol::{Agent, ConnectionTo};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Caps for `session/list` cursor walking.
pub const LIST_SESSIONS_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);
pub const LIST_SESSIONS_MAX_PAGES: usize = 200;
pub const LIST_SESSIONS_MAX: usize = 500;

/// Stop paging `session/list`. An empty page is *not* a stop condition: codex-acp
/// pages over a global time window and filters by cwd inside each page, so pages
/// for one vault are often empty while more sessions remain behind the cursor.
pub fn list_sessions_page_done(
    next: Option<&str>,
    prev: Option<&str>,
    collected: usize,
    pages: usize,
    elapsed: std::time::Duration,
) -> bool {
    match next {
        None => true,
        // Agent stopped advancing; keep walking and we would loop forever.
        Some(next) => {
            next == prev.unwrap_or_default()
                || collected >= LIST_SESSIONS_MAX
                || pages >= LIST_SESSIONS_MAX_PAGES
                || elapsed >= LIST_SESSIONS_BUDGET
        }
    }
}

/// List sessions from an ACP agent via `session/list`.
/// Returns `supported: false` if the agent does not advertise session.list capability.
pub async fn list_acp_sessions(
    desc: &AgentDescriptor,
    mut cwd: PathBuf,
    cursor: Option<String>,
    remote: Option<&dyn crate::features::agent::remote_host::RemoteAgentLaunch>,
) -> Result<AcpListSessionsResult, AppError> {
    if remote.is_none() {
        cwd = simplified_agent_cwd(&cwd);
    }
    let acp = to_acp_agent(desc, Some(&cwd), remote)?;
    let terminals = Arc::new(tokio::sync::Mutex::new(AcpTerminalManager::with_cwd(
        cwd.clone(),
    )));

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .with_handler(AcpTerminalHandler::new(terminals))
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = responder.respond(permission_response(&request, false));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            move |connection: ConnectionTo<Agent>| async move {
                let init = timed_acp_initialize(
                    connection
                        .send_request(client_initialize_request())
                        .block_task(),
                )
                .await?;

                let supports_list = init.agent_capabilities.session_capabilities.list.is_some();

                if !supports_list {
                    return Ok(AcpListSessionsResult {
                        sessions: vec![],
                        next_cursor: None,
                        supported: false,
                    });
                }

                let started = std::time::Instant::now();
                let mut sessions: Vec<AcpSessionInfo> = Vec::new();
                let mut seen: HashSet<String> = HashSet::new();
                let mut cursor = cursor;
                let mut pages = 0usize;

                loop {
                    let mut req = ListSessionsRequest::new().cwd(cwd.clone());
                    if let Some(ref c) = cursor {
                        req = req.cursor(c.clone());
                    }

                    let resp = timed_acp_request(
                        "session/list",
                        connection.send_request(req).block_task(),
                    )
                    .await?;
                    pages += 1;

                    for s in resp.sessions {
                        let session_id = s.session_id.to_string();
                        if !seen.insert(session_id.clone()) {
                            continue;
                        }
                        sessions.push(AcpSessionInfo {
                            session_id,
                            cwd: s.cwd.to_string_lossy().to_string(),
                            title: s.title,
                            updated_at: s.updated_at,
                        });
                    }

                    let next = resp.next_cursor;
                    let stalled = next.is_some() && next.as_deref() == cursor.as_deref();
                    if list_sessions_page_done(
                        next.as_deref(),
                        cursor.as_deref(),
                        sessions.len(),
                        pages,
                        started.elapsed(),
                    ) {
                        // Never hand back a cursor that did not advance.
                        cursor = if stalled { None } else { next };
                        break;
                    }
                    cursor = next;
                }

                Ok(AcpListSessionsResult {
                    sessions,
                    next_cursor: cursor,
                    supported: true,
                })
            }
        })
        .await;

    match result {
        Ok(r) => Ok(r),
        Err(e) => Err(AppError::domain("acp", format!("acp: list sessions: {e}"))),
    }
}

/// Load a session's history from an ACP agent via `session/load`.
/// The agent replays history as SessionNotification events which we accumulate.
/// `messageId` boundaries split consecutive same-kind chunks into separate parts.
#[derive(Default)]
struct ReplayBuilder {
    lines: Vec<ReplayLine>,
    title: Option<String>,
}

struct ReplayLine {
    is_user: bool,
    parts: Vec<AcpHistoryPart>,
    trailing_msg_id: Option<String>,
}

impl ReplayLine {
    fn agent() -> Self {
        Self {
            is_user: false,
            parts: Vec::new(),
            trailing_msg_id: None,
        }
    }
}

fn msg_id_changed(prev: &Option<String>, next: &Option<String>) -> bool {
    matches!((prev, next), (Some(a), Some(b)) if a != b)
}

/// Claude Code splices synthetic assistant messages into transcripts when a
/// turn ends without a reply (e.g. an interrupted turn), and adapters like
/// `claude-agent-acp` replay them verbatim on `session/load`. They are not
/// real answers, so drop them instead of showing them as the agent's reply
/// (#411).
fn is_synthetic_replay_placeholder(text: &str) -> bool {
    matches!(
        text.trim(),
        "No response requested."
            | "[Request interrupted by user]"
            | "[Request interrupted by user for tool use]"
    )
}

fn chunk_msg_id(chunk: &agent_client_protocol::schema::v1::ContentChunk) -> Option<String> {
    chunk.message_id.as_ref().map(|m| m.0.to_string())
}

impl ReplayBuilder {
    fn push_user_chunk(&mut self, text: String, msg_id: Option<String>) {
        let start_new = match self.lines.last() {
            Some(l) if l.is_user => msg_id_changed(&l.trailing_msg_id, &msg_id),
            _ => true,
        };
        if start_new {
            self.lines.push(ReplayLine {
                is_user: true,
                parts: vec![AcpHistoryPart::Text { text }],
                trailing_msg_id: msg_id,
            });
            return;
        }
        let line = self.lines.last_mut().expect("checked non-empty");
        if let Some(AcpHistoryPart::Text { text: t }) = line.parts.last_mut() {
            t.push_str(&text);
        } else {
            line.parts.push(AcpHistoryPart::Text { text });
        }
        if msg_id.is_some() {
            line.trailing_msg_id = msg_id;
        }
    }

    fn current_agent_line(&mut self) -> &mut ReplayLine {
        if !matches!(self.lines.last(), Some(l) if !l.is_user) {
            self.lines.push(ReplayLine::agent());
        }
        self.lines.last_mut().expect("checked non-empty")
    }

    fn push_agent_chunk(&mut self, reasoning: bool, text: String, msg_id: Option<String>) {
        let line = self.current_agent_line();
        let same_kind_tail = match line.parts.last() {
            Some(AcpHistoryPart::Reasoning { .. }) => reasoning,
            Some(AcpHistoryPart::Text { .. }) => !reasoning,
            _ => false,
        };
        if same_kind_tail && !msg_id_changed(&line.trailing_msg_id, &msg_id) {
            if let Some(AcpHistoryPart::Reasoning { text: t } | AcpHistoryPart::Text { text: t }) =
                line.parts.last_mut()
            {
                t.push_str(&text);
            }
        } else if reasoning {
            line.parts.push(AcpHistoryPart::Reasoning { text });
        } else {
            line.parts.push(AcpHistoryPart::Text { text });
        }
        if msg_id.is_some() {
            line.trailing_msg_id = msg_id;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_tool(
        &mut self,
        id: String,
        title: Option<String>,
        kind: Option<String>,
        status: Option<String>,
        input: Option<serde_json::Value>,
        output: Option<serde_json::Value>,
    ) {
        for line in self.lines.iter_mut().rev() {
            for part in line.parts.iter_mut().rev() {
                if let AcpHistoryPart::Tool { tool } = part {
                    if tool.id == id {
                        if let Some(t) = title {
                            tool.title = t;
                        }
                        if let Some(k) = kind {
                            tool.kind = k;
                        }
                        if let Some(s) = status {
                            tool.status = s;
                        }
                        if input.is_some() {
                            tool.input = input;
                        }
                        if output.is_some() {
                            tool.output = output;
                        }
                        return;
                    }
                }
            }
        }
        self.current_agent_line().parts.push(AcpHistoryPart::Tool {
            tool: Box::new(AcpHistoryTool {
                id,
                title: title.unwrap_or_default(),
                kind: kind.unwrap_or_else(|| "other".to_string()),
                status: status.unwrap_or_else(|| "pending".to_string()),
                input,
                output,
            }),
        });
    }

    fn apply_plan(&mut self, entries: Vec<AgentPlanEntry>) {
        let line = self.current_agent_line();
        if let Some(AcpHistoryPart::Plan { entries: e }) = line
            .parts
            .iter_mut()
            .find(|p| matches!(p, AcpHistoryPart::Plan { .. }))
        {
            *e = entries;
        } else {
            line.parts.push(AcpHistoryPart::Plan { entries });
        }
    }

    fn finish(self) -> (Vec<AcpHistoryLine>, Option<String>) {
        let mut out = Vec::new();
        for mut line in self.lines {
            if !line.is_user {
                line.parts.retain(|part| {
                    !matches!(part, AcpHistoryPart::Text { text } if is_synthetic_replay_placeholder(text))
                });
            }
            let text: String = line
                .parts
                .iter()
                .filter_map(|p| match p {
                    AcpHistoryPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            let reasoning = line
                .parts
                .iter()
                .filter_map(|p| match p {
                    AcpHistoryPart::Reasoning { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let has_rich_parts = line
                .parts
                .iter()
                .any(|p| matches!(p, AcpHistoryPart::Tool { .. } | AcpHistoryPart::Plan { .. }));
            if text.trim().is_empty() && reasoning.trim().is_empty() && !has_rich_parts {
                continue;
            }
            let id = format!("line-{}", out.len() + 1);
            if line.is_user {
                out.push(AcpHistoryLine {
                    id,
                    kind: "user".to_string(),
                    text,
                    reasoning: None,
                    parts: Vec::new(),
                    sources: Vec::new(),
                });
            } else {
                out.push(AcpHistoryLine {
                    id,
                    kind: "agent".to_string(),
                    sources: extract_sources(&text),
                    text,
                    reasoning: (!reasoning.is_empty()).then_some(reasoning),
                    parts: line.parts,
                });
            }
        }
        (out, self.title)
    }
}

/// Settle limits for `session/load` history replay. Agents push replayed turns
/// as `session/update` notifications without a completion marker, so wait until
/// they quiet down (`REPLAY_SETTLE_QUIET`) instead of always sleeping a fixed
/// 800 ms; `REPLAY_SETTLE_CAP` keeps the previous worst-case capture window.
const REPLAY_SETTLE_CAP: std::time::Duration = std::time::Duration::from_millis(800);
const REPLAY_SETTLE_QUIET: std::time::Duration = std::time::Duration::from_millis(200);
const REPLAY_SETTLE_POLL: std::time::Duration = std::time::Duration::from_millis(50);

pub async fn load_acp_session(
    desc: &AgentDescriptor,
    session_id: String,
    mut cwd: PathBuf,
    remote: Option<&dyn crate::features::agent::remote_host::RemoteAgentLaunch>,
) -> Result<AcpLoadSessionResult, AppError> {
    if remote.is_none() {
        cwd = simplified_agent_cwd(&cwd);
    }
    let acp = to_acp_agent(desc, Some(&cwd), remote)?;

    let builder: Arc<Mutex<ReplayBuilder>> = Arc::new(Mutex::new(ReplayBuilder::default()));
    let builder_for_notif = builder.clone();
    // Last time a replay notification arrived; lets the settle loop below wait
    // on actual replay activity instead of a fixed sleep.
    let last_replay: Arc<Mutex<std::time::Instant>> =
        Arc::new(Mutex::new(std::time::Instant::now()));
    let last_replay_for_notif = last_replay.clone();
    let terminals = Arc::new(tokio::sync::Mutex::new(AcpTerminalManager::with_cwd(
        cwd.clone(),
    )));

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .with_handler(AcpTerminalHandler::new(terminals))
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                if let Ok(mut at) = last_replay_for_notif.lock() {
                    *at = std::time::Instant::now();
                }
                let Ok(mut b) = builder_for_notif.lock() else {
                    return Ok(());
                };
                match &notification.update {
                    SessionUpdate::UserMessageChunk(chunk) => {
                        if let Some(text) = text_from_content_block(&chunk.content) {
                            b.push_user_chunk(text, chunk_msg_id(chunk));
                        }
                    }
                    SessionUpdate::AgentMessageChunk(chunk) => {
                        if let Some(text) = text_from_content_block(&chunk.content) {
                            b.push_agent_chunk(false, text, chunk_msg_id(chunk));
                        }
                    }
                    SessionUpdate::AgentThoughtChunk(chunk) => {
                        if let Some(text) = text_from_content_block(&chunk.content) {
                            b.push_agent_chunk(true, text, chunk_msg_id(chunk));
                        }
                    }
                    SessionUpdate::ToolCall(tc) => {
                        b.apply_tool(
                            tc.tool_call_id.to_string(),
                            Some(tc.title.clone()),
                            Some(tool_kind_str(tc.kind).to_string()),
                            Some(tool_status_str(tc.status).to_string()),
                            tc.raw_input.clone(),
                            tc.raw_output.clone(),
                        );
                    }
                    SessionUpdate::ToolCallUpdate(upd) => {
                        let f = &upd.fields;
                        b.apply_tool(
                            upd.tool_call_id.to_string(),
                            f.title.clone(),
                            f.kind.map(tool_kind_str).map(str::to_string),
                            f.status.map(tool_status_str).map(str::to_string),
                            f.raw_input.clone(),
                            f.raw_output.clone(),
                        );
                    }
                    SessionUpdate::Plan(plan) => {
                        b.apply_plan(
                            plan.entries
                                .iter()
                                .map(|e| AgentPlanEntry {
                                    content: e.content.clone(),
                                    status: plan_status_str(&e.status).to_string(),
                                    priority: plan_priority_str(&e.priority).to_string(),
                                })
                                .collect(),
                        );
                    }
                    SessionUpdate::SessionInfoUpdate(info) => {
                        if let agent_client_protocol::schema::MaybeUndefined::Value(t) = &info.title
                        {
                            b.title = Some(t.clone());
                        }
                    }
                    _ => {}
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = responder.respond(permission_response(&request, false));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            let sid = session_id.clone();
            let last_replay = last_replay.clone();
            move |connection: ConnectionTo<Agent>| async move {
                timed_acp_initialize(
                    connection
                        .send_request(client_initialize_request())
                        .block_task(),
                )
                .await?;

                timed_acp_request(
                    "session/load",
                    connection
                        .send_request(
                            LoadSessionRequest::new(SessionId::new(sid.as_str()), cwd)
                                .mcp_servers(vec![]),
                        )
                        .block_task(),
                )
                .await?;

                // Settle until replayed notifications quiet down instead of always
                // sleeping 800 ms; the capture window stays capped at 800 ms.
                let settle_start = std::time::Instant::now();
                loop {
                    tokio::time::sleep(REPLAY_SETTLE_POLL).await;
                    let last = last_replay
                        .lock()
                        .map(|at| *at)
                        .unwrap_or_else(|_| std::time::Instant::now());
                    if last.elapsed() >= REPLAY_SETTLE_QUIET
                        || settle_start.elapsed() >= REPLAY_SETTLE_CAP
                    {
                        break;
                    }
                }
                Ok(())
            }
        })
        .await;

    match result {
        Ok(()) => {
            let taken = builder
                .lock()
                .map(|mut g| std::mem::take(&mut *g))
                .unwrap_or_default();
            let (lines, title) = taken.finish();
            Ok(AcpLoadSessionResult {
                session_id,
                title,
                lines,
            })
        }
        Err(e) => Err(AppError::domain("acp", format!("acp: load session: {e}"))),
    }
}

#[cfg(test)]
mod replay_builder_tests {
    use super::ReplayBuilder;
    use crate::features::agent::models::{AcpHistoryPart, AgentPlanEntry};

    fn plan(content: &str, status: &str) -> AgentPlanEntry {
        AgentPlanEntry {
            content: content.to_string(),
            status: status.to_string(),
            priority: "medium".to_string(),
        }
    }

    fn id(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn keeps_user_turns_and_alternates_speakers() {
        let mut b = ReplayBuilder::default();
        b.push_user_chunk("first question".into(), id("u1"));
        b.push_agent_chunk(false, "first answer".into(), id("m1"));
        b.push_user_chunk("second question".into(), id("u2"));
        b.push_agent_chunk(false, "second answer".into(), id("m2"));

        let (lines, _) = b.finish();
        let shape: Vec<(&str, &str)> = lines
            .iter()
            .map(|l| (l.kind.as_str(), l.text.as_str()))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("user", "first question"),
                ("agent", "first answer"),
                ("user", "second question"),
                ("agent", "second answer"),
            ]
        );
    }

    #[test]
    fn merges_chunks_sharing_a_message_id() {
        let mut b = ReplayBuilder::default();
        b.push_agent_chunk(false, "he".into(), id("m1"));
        b.push_agent_chunk(false, "llo".into(), id("m1"));

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "hello");
        assert_eq!(lines[0].parts.len(), 1);
    }

    #[test]
    fn a_new_message_id_starts_a_new_part() {
        let mut b = ReplayBuilder::default();
        b.push_agent_chunk(false, "a".into(), id("m1"));
        b.push_agent_chunk(false, "b".into(), id("m2"));

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].parts.len(), 2);
        assert_eq!(lines[0].text, "ab");
    }

    #[test]
    fn preserves_interleaved_reasoning_and_answer_order() {
        let mut b = ReplayBuilder::default();
        b.push_agent_chunk(true, "think".into(), id("r1"));
        b.push_agent_chunk(false, "answer".into(), id("m1"));
        b.push_agent_chunk(true, "rethink".into(), id("r2"));

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        let kinds: Vec<&str> = lines[0]
            .parts
            .iter()
            .map(|p| match p {
                AcpHistoryPart::Reasoning { .. } => "reasoning",
                AcpHistoryPart::Text { .. } => "text",
                AcpHistoryPart::Tool { .. } => "tool",
                AcpHistoryPart::Plan { .. } => "plan",
            })
            .collect();
        assert_eq!(kinds, vec!["reasoning", "text", "reasoning"]);
        assert_eq!(lines[0].reasoning.as_deref(), Some("think\n\nrethink"));
    }

    #[test]
    fn agent_turns_recover_sources_from_replayed_text() {
        let mut b = ReplayBuilder::default();
        b.push_agent_chunk(
            false,
            "Answer.\n\n## Sources\n- papers/a/NOTES.md\n".into(),
            id("m1"),
        );

        let (lines, _) = b.finish();
        assert_eq!(lines[0].sources, vec!["papers/a/NOTES.md".to_string()]);
    }

    #[test]
    fn tool_updates_patch_the_existing_part_by_id() {
        let mut b = ReplayBuilder::default();
        b.apply_tool(
            "t1".into(),
            Some("Read file".into()),
            Some("read".into()),
            Some("pending".into()),
            None,
            None,
        );
        b.apply_tool(
            "t1".into(),
            None,
            None,
            Some("completed".into()),
            None,
            None,
        );

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].parts.len(), 1);
        let AcpHistoryPart::Tool { tool } = &lines[0].parts[0] else {
            panic!("expected a tool part");
        };
        assert_eq!(tool.title, "Read file");
        assert_eq!(tool.status, "completed");
    }

    #[test]
    fn plan_snapshots_replace_the_single_plan_part() {
        let mut b = ReplayBuilder::default();
        b.apply_plan(vec![plan("step one", "pending")]);
        b.apply_plan(vec![
            plan("step one", "completed"),
            plan("step two", "pending"),
        ]);

        let (lines, _) = b.finish();
        assert_eq!(lines[0].parts.len(), 1);
        let AcpHistoryPart::Plan { entries } = &lines[0].parts[0] else {
            panic!("expected a plan part");
        };
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].status, "completed");
    }

    #[test]
    fn drops_turns_without_any_content() {
        let mut b = ReplayBuilder::default();
        b.push_user_chunk("   ".into(), id("u1"));
        b.push_agent_chunk(false, "  ".into(), id("m1"));

        let (lines, _) = b.finish();
        assert!(lines.is_empty());
    }

    #[test]
    fn a_tool_only_turn_survives_the_empty_text_filter() {
        let mut b = ReplayBuilder::default();
        b.apply_tool("t1".into(), None, None, None, None, None);

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].text.is_empty());
        assert_eq!(lines[0].parts.len(), 1);
    }

    #[test]
    fn drops_synthetic_placeholder_agent_turns() {
        let mut b = ReplayBuilder::default();
        b.push_user_chunk("question".into(), id("u1"));
        b.push_agent_chunk(false, "No response requested.".into(), id("m1"));

        let (lines, _) = b.finish();
        let shape: Vec<(&str, &str)> = lines
            .iter()
            .map(|l| (l.kind.as_str(), l.text.as_str()))
            .collect();
        assert_eq!(shape, vec![("user", "question")]);
    }

    #[test]
    fn keeps_real_parts_in_turns_mixed_with_a_placeholder() {
        let mut b = ReplayBuilder::default();
        b.push_agent_chunk(true, "thinking".into(), id("r1"));
        b.apply_tool(
            "t1".into(),
            Some("Read file".into()),
            None,
            None,
            None,
            None,
        );
        b.push_agent_chunk(false, "No response requested.".into(), id("m1"));

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].parts.len(), 2);
        assert!(matches!(
            lines[0].parts[0],
            AcpHistoryPart::Reasoning { .. }
        ));
        assert!(matches!(lines[0].parts[1], AcpHistoryPart::Tool { .. }));
        assert!(lines[0].text.is_empty());
    }
}
