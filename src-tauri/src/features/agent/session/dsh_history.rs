//! Read-only compatibility for Dsh's resume-only ACP bridge. Never migrate,
//! truncate, or otherwise modify the provider's durable session artifacts.
use super::ReplayBuilder;
use crate::features::agent::models::AcpLoadSessionResult;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;

pub(super) fn home(env: &HashMap<String, String>, cwd: &Path) -> Result<PathBuf, String> {
    let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let user_home = env
        .get(home_key)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or("Dsh history: cannot locate the user home")?;
    let root = match env.get("DSH_HOME").filter(|s| !s.trim().is_empty()) {
        Some(value) if value == "~" => user_home,
        Some(value) if value.starts_with("~/") || value.starts_with("~\\") => {
            user_home.join(&value[2..])
        }
        Some(value) => PathBuf::from(value),
        None => user_home.join(".dsh"),
    };
    Ok(if root.is_absolute() {
        root
    } else {
        cwd.join(root)
    })
}

/// The provider's released layout is sessions/<project>/<uuid>/session[.vN].jsonl[.zstd].
/// Scan only the project level; cwd and UUID are checked against the log header.
pub(super) fn load(home: &Path, sid: &str, cwd: &Path) -> Result<AcpLoadSessionResult, String> {
    uuid::Uuid::parse_str(sid).map_err(|_| "Dsh history: invalid session id")?;
    // A UUID is a single component even on Windows (no alternate data streams).
    if sid.len() != 36 {
        return Err("Dsh history: invalid session id".into());
    }
    let projects = fs::read_dir(home.join("sessions"))
        .map_err(|e| format!("Dsh history: cannot read session storage: {e}"))?;
    for project in projects {
        let project = project.map_err(|e| format!("Dsh history: {e}"))?;
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let dir = project.path().join(sid);
        if !dir.is_dir() {
            continue;
        }
        let mut logs = Vec::new();
        for entry in fs::read_dir(dir).map_err(|e| format!("Dsh history: {e}"))? {
            let entry = entry.map_err(|e| format!("Dsh history: {e}"))?;
            if let Some(version) = log_version(&entry.file_name().to_string_lossy()) {
                logs.push((version, entry.path()));
            }
        }
        logs.sort_by_key(|(version, _)| *version);
        let Some((version, path)) = logs.pop() else {
            return Err("Dsh history: no committed session log found".into());
        };
        if !(2..=4).contains(&version) || logs.last().is_some_and(|(other, _)| *other == version) {
            return Err("Dsh history: unsupported or ambiguous session format".into());
        }
        return read_log(&path, version, sid, cwd);
    }
    Err("Dsh history: session log not found under DSH_HOME/sessions; check the agent's DSH_HOME and custom persistence configuration".into())
}

fn log_version(name: &str) -> Option<u64> {
    let name = name.strip_suffix(".zstd").unwrap_or(name);
    if name == "session.jsonl" {
        return Some(0);
    }
    let number = name.strip_prefix("session.v")?.strip_suffix(".jsonl")?;
    let version = number.parse::<u64>().ok()?;
    (version > 0 && number == version.to_string()).then_some(version)
}

fn same_cwd(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        crate::core::process::windows_shell_path(path)
            .to_string_lossy()
            .trim_end_matches(['/', '\\'])
            .to_string()
    };
    let left = normalize(left);
    let right = normalize(right);
    if cfg!(windows) {
        left.replace('/', "\\")
            .eq_ignore_ascii_case(&right.replace('/', "\\"))
    } else {
        left == right
    }
}

fn read_log(
    path: &Path,
    version: u64,
    sid: &str,
    cwd: &Path,
) -> Result<AcpLoadSessionResult, String> {
    let file = File::open(path).map_err(|e| format!("Dsh history: {e}"))?;
    let reader: Box<dyn Read> = if path.extension().is_some_and(|ext| ext == "zstd") {
        Box::new(zstd::stream::read::Decoder::new(file).map_err(|e| format!("Dsh history: {e}"))?)
    } else {
        Box::new(file)
    };
    let mut bytes = Vec::new();
    reader
        .take(MAX_LOG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Dsh history: cannot decode session log: {e}"))?;
    if bytes.len() as u64 > MAX_LOG_BYTES {
        return Err("Dsh history: session log exceeds the 64 MiB replay limit".into());
    }
    let raw = std::str::from_utf8(&bytes).map_err(|e| format!("Dsh history: {e}"))?;
    let mut rows = raw.lines();
    let header: Value = serde_json::from_str(rows.next().unwrap_or_default())
        .map_err(|e| format!("Dsh history: invalid session header: {e}"))?;
    if header["type"] != "session"
        || header["id"] != sid
        || header["version"].as_u64() != Some(version)
        || !header["cwd"]
            .as_str()
            .is_some_and(|path| same_cwd(Path::new(path), cwd))
        || header["origin"] == "subagent"
        || header["parentSession"].is_string()
    {
        return Err(
            "Dsh history: session header does not match the requested session and workspace".into(),
        );
    }
    let mut replay = ReplayBuilder::default();
    for (seq, row) in rows.enumerate() {
        let event: Value = serde_json::from_str(row)
            .map_err(|e| format!("Dsh history: invalid session event {seq}: {e}"))?;
        if event["seq"].as_u64() != Some(seq as u64) || !event["type"].is_string() {
            return Err("Dsh history: unsupported or non-contiguous session events".into());
        }
        apply_event(&mut replay, &event);
    }
    let (lines, title) = replay.finish();
    Ok(AcpLoadSessionResult {
        session_id: sid.to_string(),
        title,
        lines,
    })
}

fn apply_event(replay: &mut ReplayBuilder, event: &Value) {
    let data = &event["data"];
    let message = data.get("message").unwrap_or(data);
    let id = message["id"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| Some(format!("dsh-{}", event["seq"])));
    match event["type"].as_str() {
        Some("user/message") if message["source"]["kind"] == "user" => {
            if let Some(blocks) = message["content"].as_array() {
                for block in blocks {
                    if block["type"] == "text" {
                        if let Some(text) = block["text"].as_str() {
                            replay.push_user_chunk(text.to_string(), id.clone());
                        }
                    }
                }
            }
        }
        Some("assistant/message") => {
            if let Some(blocks) = message["content"].as_array() {
                for block in blocks {
                    if matches!(block["type"].as_str(), Some("text" | "reasoning")) {
                        if let Some(text) = block["text"].as_str() {
                            replay.push_agent_chunk(
                                block["type"] == "reasoning",
                                text.to_string(),
                                id.clone(),
                            );
                        }
                    }
                }
            }
        }
        Some("tool/call") => {
            if let (Some(id), Some(name)) = (data["callId"].as_str(), data["name"].as_str()) {
                let input = data["arguments"]
                    .as_str()
                    .map(|s| serde_json::from_str(s).unwrap_or(Value::String(s.to_string())))
                    .or_else(|| data.get("arguments").cloned());
                replay.apply_tool(
                    id.to_string(),
                    Some(name.to_string()),
                    Some("other".into()),
                    Some("in_progress".into()),
                    input,
                    None,
                );
            }
        }
        Some("tool/result") => {
            if let Some(id) = message["toolCallId"].as_str() {
                replay.apply_tool(
                    id.to_string(),
                    None,
                    None,
                    Some(
                        if message["isError"] == true {
                            "failed"
                        } else {
                            "completed"
                        }
                        .into(),
                    ),
                    None,
                    message.get("content").cloned(),
                );
            }
        }
        Some("session/title") => replay.title = data["title"].as_str().map(str::to_owned),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SID: &str = "455181d7-12ab-4567-8901-0123456789ab";

    fn fixture(dir: &Path, version: u64, compressed: bool) -> PathBuf {
        let folder = dir.join("sessions/project").join(SID);
        fs::create_dir_all(&folder).unwrap();
        let events = [
            json!({"type":"session","version":version,"id":SID,"cwd":dir.to_string_lossy()}),
            json!({"seq":0,"type":"user/message","data":{"id":"u1","source":{"kind":"user"},"content":[{"type":"text","text":"first question"}]}}),
            json!({"seq":1,"type":"user/message","data":{"id":"ctx","source":{"kind":"plugin"},"content":[{"type":"text","text":"hidden context"}]}}),
            json!({"seq":2,"type":"assistant/message","data":{"message":{"id":"a1","content":[{"type":"reasoning","text":"thinking"},{"type":"text","text":"first answer"}]}}}),
            json!({"seq":3,"type":"tool/call","data":{"callId":"t1","name":"read","arguments":"{\"path\":\"note.md\"}"}}),
            json!({"seq":4,"type":"tool/result","data":{"message":{"toolCallId":"t1","content":[{"type":"text","text":"note"}]}}}),
            json!({"seq":5,"type":"user/message","data":{"id":"u2","source":{"kind":"user"},"content":[{"type":"text","text":"second question"}]}}),
            json!({"seq":6,"type":"assistant/message","data":{"message":{"id":"a2","content":[{"type":"text","text":"second answer"}]}}}),
            json!({"seq":7,"type":"session/title","data":{"title":"my conversation"}}),
        ];
        let raw = events
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let name = if version == 0 {
            "session.jsonl".into()
        } else {
            format!("session.v{version}.jsonl")
        };
        let path = folder.join(if compressed {
            format!("{name}.zstd")
        } else {
            name
        });
        let bytes = if compressed {
            zstd::stream::encode_all(raw.as_bytes(), 0).unwrap()
        } else {
            raw.into_bytes()
        };
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn restores_compressed_multi_turn_history_and_uses_latest_generation() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path(), 0, false);
        fixture(dir.path(), 4, true);
        let history = load(dir.path(), SID, dir.path()).unwrap();
        assert_eq!(history.title.as_deref(), Some("my conversation"));
        assert_eq!(
            history
                .lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            [
                "first question",
                "first answer",
                "second question",
                "second answer"
            ]
        );
        assert_eq!(history.lines[1].reasoning.as_deref(), Some("thinking"));
        assert!(history.lines[1].parts.iter().any(|part| matches!(part,
            crate::features::agent::models::AcpHistoryPart::Tool { tool } if tool.status == "completed")));
    }

    #[test]
    fn refuses_wrong_workspace_unsafe_ids_and_newer_or_corrupt_logs() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture(dir.path(), 4, false);
        assert!(load(dir.path(), SID, &dir.path().join("other")).is_err());
        assert!(load(dir.path(), "../outside", dir.path()).is_err());
        assert!(load(dir.path(), "455181d7:stream", dir.path()).is_err());
        let newer = fixture(dir.path(), 5, false);
        assert!(load(dir.path(), SID, dir.path())
            .unwrap_err()
            .contains("unsupported"));
        fs::remove_file(newer).unwrap();
        fs::write(&path, "corrupt").unwrap();
        assert!(load(dir.path(), SID, dir.path()).is_err());
    }

    #[test]
    fn home_respects_agent_override_and_node_tilde_and_relative_rules() {
        let dir = tempfile::tempdir().unwrap();
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let mut env = HashMap::from([(key.to_string(), dir.path().display().to_string())]);
        assert_eq!(home(&env, dir.path()).unwrap(), dir.path().join(".dsh"));
        env.insert("DSH_HOME".into(), "~/other".into());
        assert_eq!(home(&env, dir.path()).unwrap(), dir.path().join("other"));
        env.insert("DSH_HOME".into(), "relative".into());
        assert_eq!(home(&env, dir.path()).unwrap(), dir.path().join("relative"));
    }

    /// Supply an isolated DSH_HOME with a prepared ACP profile and a transcript
    /// produced by the official Dsh encoder. No model prompt or API key is used.
    #[tokio::test]
    #[ignore = "requires AGENTERO_DSH_HISTORY_{NODE,ENTRY,HOME,CWD} and the official Dsh npm package"]
    async fn official_dsh_history_survives_fresh_processes() {
        use crate::features::agent::models::AgentDescriptor;
        let required = |name| std::env::var(format!("AGENTERO_DSH_HISTORY_{name}")).unwrap();
        let cwd = PathBuf::from(required("CWD"));
        let desc: AgentDescriptor = serde_json::from_value(json!({
            "id":"dsh-history-test", "name":"Dsh", "template":"dsh",
            "command":required("NODE"),
            "args":[required("ENTRY"),"--profile","acp"],
            "env":{"DSH_HOME":required("HOME")}
        }))
        .unwrap();
        let listed = super::super::list_acp_sessions(&desc, cwd.clone(), None, None)
            .await
            .unwrap();
        assert!(listed.supported);
        assert!(listed.sessions.iter().any(|item| item.session_id == SID));
        for _ in 0..2 {
            // Each call creates and then tears down a fresh official ACP process.
            let restored = super::super::load_acp_session(&desc, SID.into(), cwd.clone(), None)
                .await
                .unwrap();
            assert_eq!(
                restored
                    .lines
                    .iter()
                    .map(|line| line.text.as_str())
                    .collect::<Vec<_>>(),
                [
                    "first question",
                    "first answer",
                    "second question",
                    "second answer"
                ]
            );
            assert_eq!(restored.title.as_deref(), Some("my conversation"));
        }
    }
}
