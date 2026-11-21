//! 内置「知乎」Agent：Host 内建适配器。
//!
//! 不 spawn 外部 ACP 进程，而是直连知乎开放平台，把结果转成前端既有的
//! `agent:*` 事件（stream / completed / failed / models / commands），因此
//! 右侧栏 Agent 面板无需任何特殊分支即可渲染。凭证来自 App settings。
//!
//! 能力：知乎直答（流式）。论文相关内容检索改由 `zhihu_search` 命令驱动，
//! 供知乎 Agent 空态的推荐卡片使用，不再走聊天斜杠命令。

pub mod commands;

use std::sync::{Arc, Mutex};

use agentero_core::features::zhihu::{ZhihuClient, DEFAULT_MODEL};

use crate::features::agent::models::{
    AgentCommand, AgentCommandsEvent, AgentFailedEvent, AgentModelChoice, AgentModelsEvent,
    AgentResultPayload, AgentStreamEvent, AgentStreamKind,
};
use crate::features::agent::AgentEventEmitter;

/// 内置 Agent 的模型（展示名对齐开放平台）。
pub const ZHIHU_MODEL_ID: &str = DEFAULT_MODEL;
const ZHIHU_MODEL_NAME: &str = "知乎直答";

/// 引擎侧对话模型选择器的 config id。
const MODEL_CONFIG_ID: &str = "model";

/// 一次直答 / 检索运行所需的一切（已从 `agent_run_once` 解构）。
pub struct ZhihuRunOnce {
    pub app: AgentEventEmitter,
    pub session_id: String,
    pub message_id: String,
    pub agent_id: String,
    pub prompt: String,
    pub sources: Vec<String>,
    pub prompt_only: bool,
    /// 续聊时前端回传的 provider session id；用于保持同一历史项。
    pub resume_session_id: Option<String>,
    pub model_id: Option<String>,
    pub secret: Option<String>,
    pub cancellation: tokio::sync::watch::Receiver<bool>,
}

/// 模型目录事件（warm 与首次运行都会广播，供配置条展示）。
pub fn models_event(agent_id: &str, session_id: &str, current: &str) -> AgentModelsEvent {
    AgentModelsEvent {
        session_id: session_id.to_string(),
        agent_id: agent_id.to_string(),
        config_id: MODEL_CONFIG_ID.to_string(),
        current_id: current.to_string(),
        models: vec![AgentModelChoice {
            id: ZHIHU_MODEL_ID.to_string(),
            name: ZHIHU_MODEL_NAME.to_string(),
            group: None,
        }],
    }
}

/// 斜杠命令清单（供 composer `/` 菜单）。知乎没有斜杠命令：内容检索走
/// `zhihu_search` 命令 + 空态推荐卡片。
pub fn builtin_commands() -> Vec<AgentCommand> {
    Vec::new()
}

/// 广播模型目录 + 斜杠命令（面板打开 / 切换 Agent 时 warm 调用）。
pub fn emit_warm_events(app: &AgentEventEmitter, agent_id: &str, model_id: Option<&str>) {
    let current = model_id
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(ZHIHU_MODEL_ID);
    let _ = app.emit("agent:models", models_event(agent_id, "warm", current));
    let _ = app.emit(
        "agent:commands",
        AgentCommandsEvent {
            session_id: "warm".to_string(),
            agent_id: agent_id.to_string(),
            commands: builtin_commands(),
        },
    );
}

/// 运行一轮：按 prompt 前缀分流到检索或直答；错误统一走 `agent:failed`。
pub async fn run_once(params: ZhihuRunOnce) {
    let provider_session_id = params
        .resume_session_id
        .clone()
        .unwrap_or_else(|| params.session_id.clone());
    match execute(&params, &provider_session_id).await {
        Ok(()) => {}
        Err(error) => {
            let _ = params.app.emit(
                "agent:failed",
                AgentFailedEvent {
                    session_id: params.session_id.clone(),
                    error: error.to_string(),
                },
            );
        }
    }
}

async fn execute(
    params: &ZhihuRunOnce,
    provider_session_id: &str,
) -> Result<(), agentero_core::error::AppError> {
    let Some(secret) = params
        .secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Err(agentero_core::error::AppError::domain(
            "zhihuNoSecret",
            "尚未配置知乎 Access Secret。请在 设置 → Agent → 知乎 中填入。",
        ));
    };
    let client = ZhihuClient::new(secret);
    let model = params
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(ZHIHU_MODEL_ID);

    run_chat(
        params,
        &client,
        provider_session_id,
        model,
        params.prompt.trim(),
    )
    .await
}

async fn run_chat(
    params: &ZhihuRunOnce,
    client: &ZhihuClient,
    provider_session_id: &str,
    model: &str,
    prompt: &str,
) -> Result<(), agentero_core::error::AppError> {
    if prompt.trim().is_empty() {
        return Err(agentero_core::error::AppError::message(
            "请输入要提问的内容",
        ));
    }

    let content = Arc::new(Mutex::new(String::new()));
    let content_cb = Arc::clone(&content);
    let emitter = params.app.clone();
    let session_cb = params.session_id.clone();
    let stream = client.chat_stream(model, prompt, move |delta| {
        if let Ok(mut buf) = content_cb.lock() {
            buf.push_str(delta);
        }
        let _ = emitter.emit(
            "agent:stream",
            AgentStreamEvent {
                session_id: session_cb.clone(),
                chunk: delta.to_string(),
                kind: AgentStreamKind::Message,
            },
        );
    });

    let mut cancel = params.cancellation.clone();
    tokio::select! {
        result = stream => result.map(|_| ())?,
        () = wait_cancel(&mut cancel) => {
            emit_completed(params, provider_session_id, take(&content), Some("cancelled"));
            return Ok(());
        }
    }

    emit_completed(params, provider_session_id, take(&content), None);
    Ok(())
}

fn emit_completed(
    params: &ZhihuRunOnce,
    provider_session_id: &str,
    content: String,
    stop_reason: Option<&str>,
) {
    let _ = params.app.emit(
        "agent:completed",
        AgentResultPayload {
            session_id: params.session_id.clone(),
            message_id: params.message_id.clone(),
            content,
            reasoning: None,
            sources: params.sources.clone(),
            prompt_only: params.prompt_only,
            artifacts: Vec::new(),
            stop_reason: stop_reason.map(str::to_string),
            provider_session_id: Some(provider_session_id.to_string()),
        },
    );
}

fn take(content: &Arc<Mutex<String>>) -> String {
    content.lock().map(|g| g.clone()).unwrap_or_default()
}

async fn wait_cancel(cancel: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Content search moved out of chat: the Zhihu agent exposes no slash
    /// commands, only 直答.
    #[test]
    fn builtin_commands_are_empty() {
        assert!(builtin_commands().is_empty());
    }
}
