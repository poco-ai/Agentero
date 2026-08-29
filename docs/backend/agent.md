# Agent（ACP Host）

Agentero 作为 **ACP Client**，stdio JSON-RPC 连接用户本机或远端 Agent（BYOA，不托管模型 Key）。

## 协议与运行时

- Crate：`agent-client-protocol`（及 Codex 的 npm ACP 适配器进程）。
- 会话 `cwd` = 当前 Vault 根（远程则为远端 Vault 根）。
- 统一接口：OpenCode、OpenClaw、Hermes、Gemini、Claude ACP、Codex ACP、Qoder、Grok、Pi、Dsh（DeepSeek Harness）、Kimi Code、自定义 `command`/`args`/`env`。
- Dsh：ACP 服务端是 `@deepseek-ai/dsh-acp-demo`（npm 包），与依赖插件一起固定
  `0.1.1-rc.2`。安装/启动三处入口，检测按序回退：
  1. App 管理目录 `~/.agentero/dsh-acp/node_modules/.bin/dsh-acp-demo`（设置页「安装」按钮，
     Rust 写入默认 `cordis.yml` + 最小 `package.json` 后执行 `npm i`；`package.json`
     防止 npm 沿目录树向上找到用户 `~/package.json` 把包装进 `~/node_modules`）；
  2. 用户 home npm 根 `~/node_modules/.bin/dsh-acp-demo`（手动 `npm i` 且 home 有
     `package.json` 时）；
  3. PATH 上的全局 `dsh-acp-demo`（`npm i -g`）。注意：`npm i -g @deepseek-ai/dsh`
     是 umbrella CLI，**不带** ACP 服务端，不作为检测目标。
  - 启动走 shell 包装（`bash -c` / `cmd /C`）`cd` 进 launcher 目录后 exec——ACP stdio
    spawn 无 cwd 字段，而 `cordis.yml`、`.env`、session 持久化都相对该目录解析。
  - 会话在进程内，进程退出即失效，且不声明 `session/resume` / `session/load`：
    多轮续聊降级为**每轮新会话**（单发式），Host 不再报「不支持继续会话」。
  - API Key：在 launcher 目录 `.env` 写 `DEEPSEEK_API_KEY`，或在注册项 env 中
    export。缺少时 prompt 报 `no API key for provider route "deepseek-official"`。
    `dsh-acp-demo` 只读启动 cwd 的 `.env` + 启动环境：它**不读** `~/.dsh` 的
    凭据存储（`.credentials.yaml` 需在 `cordis.yml` 挂载 credentials provider，
    `~/.dsh/.env` 的 user-env 层只有官方 `dsh` CLI 的 `loadLayeredEnv` 加载），
    所以官方 CLI/Web UI 里配过的 key 对 ACP 服务不可见，须复制到 launcher `.env`。
- Kimi Code：原生 ACP（`kimi acp`）。官方 installer（`code.kimi.com/kimi-code/install.sh`）
  是单二进制、默认装入 `~/.kimi-code` 并写 PATH 进 shell rc；npm 包
  `@moonshot-ai/kimi-code`（需 Node 22.19+）作回退。`kimi upgrade` 是交互式的，静默
  `update` 重跑幂等的官方 installer。登录在终端完成（`kimi` → `/login`，OAuth 或
  Moonshot API key），skill 走 slash mention。
- Pi：无原生 ACP，走社区适配器 `pi-acp`（内部 spawn `pi --mode rpc`）；detect 用 host `pi`、
  ACP 入口用 `pi-acp`。pi 的 skill 以 `/skill:<name>` 暴露，故 Agentero 不发 `/<name>`
  mention，只注入 `SKILL.md` 正文。
- Pi 启动横幅：`pi-acp` 在 `session/new` 后把 pi 的启动信息（`pi vX.Y.Z` +
  `## Context` / `## Skills` / `## Extensions` 清单）当作普通 agent message 推送。Host
  在本轮首个 message chunk 上识别该横幅并丢弃，不写入内容缓冲、不发 `agent:stream`，
  避免它出现在回答之前。
- Gemini：spawn 时注入 `NO_BROWSER=true`（用户显式配置则不覆盖），避免未登录时
  `new_session` 反复拉起浏览器 OAuth；登录须在终端完成（BYOA）。
- 设置页会将 ACP 探测中的认证错误（如 `invalid_grant` / `failed to authenticate` /
  `authentication required` / `not logged in`）
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

流式 chunk 合并（`stream_coalesce.rs`）：agent 通常每秒推 20–100 个小 chunk，
逐条 emit 会让 webview 每 token 重渲染一次（Windows 卡顿主因）。Host 用
~40ms 窗口合并连续同 kind 的文本 chunk 再发 `agent:stream`；kind 切换
（message ↔ thought）、tool/plan 等有序事件、`agent:completed` / `agent:failed`
之前都会先 flush，保证顺序与文本无损。`agent:tool` 的 `input`/`output` 超过
32KB 时截断为「头部 + truncated 标记」（前端只做预览渲染）。

ACP `terminal` 能力：Host 在 initialize 时声明 `terminal: true`，并本地实现
`terminal/create`、`terminal/output`、`terminal/release`、`terminal/wait_for_exit`、
`terminal/kill`。每个 ACP 连接持有独立的 `AcpTerminalManager`，按 `TerminalId`
管理子进程；输出按 `outputByteLimit` 从头部截断并保证 UTF-8 字符边界。该能力
让 Kimi Code 等需要执行 shell 命令的 Agent 可以在 Vault 工作目录下运行命令并
读取结果。

Kimi Code ACP 会把 `Bash`/`Glob`/`Grep` 等工具实现为 `terminal/create`：它发送
`/bin/bash -c "cd '<cwd>' && <cmd>"`，Host 按收到的 `cwd` 直接 spawn 该 bash
进程即可。若 Host 没有声明 `terminal` 能力，或 Kimi Code 版本过旧，这些工具会
直接失败并报 `ACP runtime only supports interactive Bash tool processes`。
此外 Kimi Code 的权限请求目前只返回通用 `"bash"` 字符串（[MoonshotAI/kimi-code#800](https://github.com/MoonshotAI/kimi-code/issues/800)），不会给出具体命令，因此 Agentero 默认的 Restricted 策略会拒绝、Ask 模式也只能看到 `bash`，需要用户在 Kimi 侧或 Agentero 侧开启自动批准（YOLO）才能静默执行。

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

回放聚合（`ReplayBuilder`）会丢弃 Agent 侧的合成占位文本：Claude Code 在
turn 未产生回复（如被中断）时会往 transcript 里拼接合成 assistant 消息
（"No response requested."、"[Request interrupted by user]" 等），
`claude-agent-acp` 等适配器在 `session/load` 回放时原样转发。这些占位不是
真实回答，Host 在聚合历史行时按整段精确匹配过滤，避免被当作 Agent 回复渲染
（#411）。

`agent_list_sessions` 必须**跟随 `nextCursor` 翻页**。codex-acp 按全局时间窗口分
页、再在每页内部按 `cwd` 过滤，因此属于当前 Vault 的会话会散落在多页里，中间
夹着大量「空页但仍有 nextCursor」的页。只取第一页会让 Codex 历史只剩少数几条、
甚至完全为空（#338）。Host 在单条 ACP 连接内走完 cursor，按 `sessionId` 去重，
并受三重封顶保护：5s 预算、200 页、500 条；因未走完而中断时把 cursor 一并返回。
cursor 不再推进（`next == prev`）时视为走完，避免死循环。

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
| `agent_run_tool_lifecycle` | 静默安装/升级/卸载 catalog CLI（及 Claude/Codex ACP 适配器）；本机 lifecycle 串行执行，设置页在对应 Agent 行内展示安装 / 扫描 / 探测进度（#250），Windows 使用唯一临时 `.bat` 并按 UTF-8/GBK 解码错误输出；`uninstall` 做 best-effort npm 卸载 + 受管目录删除（不改 shell rc），成功后联动删除 catalog 注册项；见 [api.md](api.md) 与 [#225](https://github.com/poco-ai/Agentero/issues/225) |
| `agent_tool_lifecycle_supported` / `agent_tool_install_commands` / `agent_tool_uninstall_info` | 是否支持静默安装；平台手动安装文案；卸载清理项清单（确认对话框展示） |

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
- `translate`：**不套 envelope**（无 `## Sources`、无 CLI 政策、不注入回答语言与个人偏好）。翻译 prompt 自己已指定目标语言并要求「只返回译文」，envelope 会与之冲突。
- Skill：Claude 倾向 `/id`；其它注入 `SKILL.md` 文本（`SkillMentionStyle`）。激活语法**只由 Host 判定**（`skill_mention_style` + `paper_reader_skill_line`）；前端不得重复推断，否则同一条 prompt 的两半会互相矛盾。
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

远程 Vault 时在 **SSH 远端** 启动 Agent。见 [remote.md](remote.md)。远程 agent catalog 的扫描/探测/安装命令属 agent 域（`remote_catalog.rs` + `remote_catalog_commands.rs`），复用 `agent::models` / `probe_agent` / `templates`，通过 remote 域的 `RemoteRegistry` / `agent_exec` 走 SSH。

## 代码

`src-tauri/src/features/agent/`  
前端：[../frontend/agent.md](../frontend/agent.md)
