# Agent（ACP Host）

Agentero 作为 **ACP Client**，stdio JSON-RPC 连接用户本机或远端 Agent（BYOA，不托管模型 Key）。

## 协议与运行时

- Crate：`agent-client-protocol`（及 Codex 的 npm ACP 适配器进程）。
- 会话 `cwd` = 当前 Vault 根（远程则为远端 Vault 根）。
- 统一接口：OpenCode、OpenClaw、Hermes、Gemini、Claude ACP、Codex ACP、Qoder、Grok、自定义 `command`/`args`/`env`。
- Gemini：spawn 时注入 `NO_BROWSER=true`（用户显式配置则不覆盖），避免未登录时
  `new_session` 反复拉起浏览器 OAuth；登录须在终端完成（BYOA）。
- 设置页会将 ACP 探测中的认证错误（如 `invalid_grant` / `failed to authenticate`）
  显示为「未登录」，其他握手或进程错误仍显示为「ACP 失败」。
- 后台熔断（`AgentWarmGate`）：`agent_warm` / `agent_list_sessions` 失败后进入
  120s 冷却，冷却期内直接返回上次错误、不再 spawn；成功或用户消息
  （`agent_run_once`）成功后清除。详见
  [bug_fix/gemini-login-browser-loop.md](../bug_fix/gemini-login-browser-loop.md)。

```text
spawn 用户配置的 agent
  → ACP initialize（读 loadSession / sessionCapabilities.resume）
  → session/new  或  继续：resume 优先，否则 session/load（Grok 仅 load）
  → available_commands_update → `agent:commands`
  → build_prompt（workflow + 可选 agentPersonalPrompt）
  → session/prompt → 流式 agent:stream
  → 权限请求 → 前端（ask 模式）
  → 完成（含 providerSessionId）/ 失败
```

多轮续聊必须传 **provider session id**（不是 Agentero runtime id）。Grok Build ACP
声明 `loadSession: true`、**不**声明 `resume`；对 Grok 调用 `session/resume` 会
`Method not found`，Host 应改走 `session/load`。

生成中取消时，只要 provider session 已创建或本轮正在恢复，取消结果仍携带 `providerSessionId`。前端保留该 ID，并写回视觉批注 mark，使下一条消息和重启后的 pin 续聊继续同一会话；在 `session/new` 返回前取消时尚无可恢复的 provider session。

`session/load` 会把历史以 `SessionNotification` 回放。Host 在
`session/prompt` 之前 **suppress** 回放中的 stream/tool/plan（不 `agent:stream`、
不写入本轮 content buffer），避免第二轮气泡开头重复上一轮回答；usage /
commands / config 仍可在 load 期间转发。

`agent_load_session` 在 `session/load` 返回后等待回放通知**静默**（200ms 无新
通知即返回，最长仍封顶 800ms），替代此前的固定 800ms sleep；回放通常在
response 前/后很快推完，空会话与短会话因此显著更快（#271）。

## 命令（摘要）

| Command | 说明 |
|---|---|
| `agent_probe` / `agent_warm` | 探测与预热 |
| `agent_run_once` | 发起一轮；`sessionId` 时按能力 resume 或 load；可选 `images[]`（base64 + mime）→ ACP `ContentBlock::Image` |
| `agent_list_sessions` / `agent_load_session` | 会话历史 |
| `agent_list_skills` | Vault skill 列表 |
| `agent_respond_permission` | 回答权限请求 |
| `agent_respond_elicitation` | 回答 form elicitation（Codex `request_user_input`） |
| `agent_respond_ask_user` | 回答 Grok `_x.ai/ask_user_question` |
| `agent_run_tool_lifecycle` | 静默安装/升级 catalog CLI（及 Claude/Codex ACP 适配器）；本机 lifecycle 串行执行，Windows 使用唯一临时 `.bat` 并按 UTF-8/GBK 解码错误输出；见 [api.md](api.md) 与 [#225](https://github.com/poco-ai/Agentero/issues/225) |
| `agent_tool_lifecycle_supported` / `agent_tool_install_commands` | 是否支持静默安装；平台手动安装文案 |

ACP slash command 不是独立的 `session/compact` RPC。Host 转发 Agent 广播的
`available_commands_update`；前端提交命令时设置 `isAcpCommand`，Host 跳过
Agentero prompt envelope、skill/context 注入，并将原始 `/command` 作为
`session/prompt` 发送到当前 provider session。

## 权限

全局 `agentPermissionMode`：

| 模式 | 行为 |
|---|---|
| `restricted` | 默认；收紧写/敏感操作 |
| `ask` | `agent:permission-request` → 用户选择 → `agent_respond_permission` |
| `auto` | 自动批准策略项 |

## Elicitation（不稳定协议）

- Host 依赖 `agent-client-protocol` feature `unstable_elicitation`。
- `initialize` 声明 `elicitation.form`，否则 codex-acp 对 `request_user_input` 直接返回空 answers。
- 收到 `elicitation/create` → 事件 `agent:elicitation-request` → 前端表单 → `agent_respond_elicitation`。

## 结构化提问（多 harness）

ACP **没有**统一的 ask-user tool 规范：各 harness 的字段名、挂载点（tool / elicitation / ext method）都不一样。Agentero 作为 ACP Client 做三件事：

1. **打开交互能力**：`initialize` 声明 `elicitation.form`（依赖 crate feature `unstable_elicitation`）；否则 Codex 等对 `request_user_input` 会直接空答。
2. **Client adapter 归一**：把不同 rawInput / 事件解析成同一套 `AskUserQuestion` 页（`parseAskUserQuestions` 等），前端只渲染一张表。
3. **Harness 特例**：OpenCode spawn 时注入 `OPENCODE_ENABLE_QUESTION_TOOL=1`；Grok 的 `_x.ai/ask_user_question` 由 Host JSON-RPC 处理（`ask_user.rs`），再经 `agent:ask-user-request` / `agent_respond_ask_user` 与前端对齐；tool 镜像与 ext 去重。

| Harness | 形态 | 回答通路 |
|---|---|---|
| Codex | tool `variant: AskUserQuestion` 或 elicitation form | tool → 提升到 **底部问卷** → 下一用户轮；elicitation → `agent_respond_elicitation` |
| Claude | tool `questions[]`（含 Other 伴生页合并） | 同 tool 提升 → 下一用户轮 |
| OpenCode | tool `question` → `questions[]` | 同 tool 提升；spawn **默认 env** `OPENCODE_ENABLE_QUESTION_TOOL=1`；turn 阻塞时 cancel+drain 立刻送出答案 |
| Grok | ext method `_x.ai/ask_user_question` | Host → `agent:ask-user-request` → `agent_respond_ask_user`；与 tool 镜像去重 |

**UI 约定**：可交互表单只在 **`AgentAskUserSurface`（底部问卷）**；与 free-text composer **互斥**；transcript tool 卡不嵌选项。优先级 elicitation > Grok ext > tool 提升。

详见 [frontend/agent.md](../frontend/agent.md)。

## 工作流与 Skill

- workflow：`summary` / `qa` / `related_work` 等（面板 chips 映射）。
- Skill：Claude 倾向 `/id`；其它注入 `SKILL.md` 文本（`SkillMentionStyle`）。
- paper-reader：写 NOTES + `paper_set_is_read`；前端任务条编排。
- 输出约定：工作流要求 `## Sources`（相对 Vault 路径）；双链保留 `[[...]]`。
- `AGENTS.md` 已作为 progressive disclosure 系统上下文注入所有工作流 prompt（优先级：Vault 根 `AGENTS.md` → 当前 paper `NOTES.md` → marks）。
- 自由模型选择：`preferred_model_id` 可指向 ACP catalog 外的任意模型 id；Warm / Run 时始终尝试 `session/set_config_option`，失败不阻断会话。

## 模型协商

- `session/new`（及 config 更新）中的 `SessionConfigOption`（category=Model 或 name 回退）解析为 `agent:models`。
- 若 `current_value` 不在 selector 选项中（第三方网关 / cc-switch 等只改默认 model、目录仍是官方列表），Host **注入**该 current id，避免 UI 丢失。
- `preferred_model_id`（warm / run_once）在与 current 不同时 **始终尝试** `session/set_config_option`，不要求 id 已在上报列表中；失败仅 debug 日志，不阻断会话。
- Codex `collaboration_mode`（Default / Plan 等）解析为 `agent:collaboration`；`collaboration_mode_id` 在选项内且与 current 不同时尝试 `session/set_config_option`。UI 称「模式」。Plan 才能用 `request_user_input`。不解析 / 不暴露 ACP `category: mode` 沙箱档。
- Fast 开关（`fast-mode` model_config 选项）与上述一致：仅当会话当前值与请求值不同时才发 `session/set_config_option`，未变化的配置不再每轮重复下发（#271）。

## User-Agent（中转站亲和）

部分中转站用 `User-Agent` 做客户端亲和（new-api Codex 通道常见 `codex-cli/<version>`；Claude 侧常见 `claude-cli/*` / `claude-code/*`）。

Agentero 是 ACP **Client**：模型 HTTP **不**经 Host 转发，因此只能在 **spawn ACP 子进程时** 注入 env/config（与 bb 等 Host 一致），不能像 cc-switch 本地代理那样中途改头。

- 设置 → Agent → **User-Agent**（预设下拉 + 可手填）+ **Codex Provider id**（可选）。
- Host 在 registry snapshot 时按模板注入：
  - 所有模板：`AGENTERO_USER_AGENT=<value>`
  - `codex-acp` / `custom`：`CODEX_CONFIG.model_providers.<id>.http_headers.User-Agent`
  - `claude-acp`：`ANTHROPIC_CUSTOM_HEADERS` 中 upsert `User-Agent: …` 行
- Codex Provider 目标：显式列表；否则 `CODEX_CONFIG` 已有 keys、`MODEL_PROVIDER`、或回退 `openai`。
- 远程 SSH 转发：`AGENTERO_USER_AGENT` / `CODEX_CONFIG` / `MODEL_PROVIDER` / `ANTHROPIC_CUSTOM_HEADERS`。
- 命令：`agent_set_user_agent`；`agent_scan_catalog` 回传当前值。

说明：是否生效取决于底层 Agent 是否认上述 env/config；OpenCode/Gemini/Grok 目前仅带 `AGENTERO_USER_AGENT`（多数忽略）。

**new-api 侧（源码）在做什么：**

- 读的是 **客户端请求** 的 `User-Agent`（`c.Request.UserAgent()`），不是 model id。
- 通道亲和规则可选 `user_agent_include`：子串匹配（大小写不敏感）；**默认规则该项为 nil = 不按 UA 过滤**。
- Codex 默认亲和规则还匹配路径 `/v1/responses`、模型 `^gpt-.*$`，并把客户端的 `User-Agent`、`Originator`、`Session_id` 等 **透传** 到上游。
- new-api **自己** 调上游 Codex 模型列表时会设 `User-Agent: codex-cli/<version>`（`service/codex_models.go`）——那是网关出站，不是你的客户端。

因此：若限制来自「亲和规则要求 UA 含 `codex-cli`」或上游看透传 UA，我们的 spawn 注入 **有机会** 解决；若还校验其它 Codex 专有头/路径/鉴权形态，仅改 UA **不够**。

## 注册表（非模型 BYOK）

配置「如何启动本机 Agent」：id、name、template、command、args、env、默认 id、可选 User-Agent。  
持久化在应用配置目录；**不**要求填写模型 API Key。

## 远程

远程 Vault 时在 **SSH 远端** 启动 Agent。见 [remote.md](remote.md)。

## 代码

`src-tauri/src/features/agent/`  
前端：[../frontend/agent.md](../frontend/agent.md)
