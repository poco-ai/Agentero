# Agent 面板

BYOA：连接本机（或远程）ACP Agent。Host 协议见 [../backend/agent.md](../backend/agent.md)。

## UI 分层

```text
AI Elements (Conversation / Message / PromptInput / Sources / Reasoning)
  → AgentPanel 状态机
  → invoke agent_* + 订阅 agent:* 事件
```

流式：`agent:stream`（message | thought）→ 完成 / 失败事件。写 NOTES 后统一 Diff（Keep / Revert）。

## 面板行为

- 空态建议 chips → workflow：`summary` / `qa` / `related_work`。
- **当前论文默认 context**（可 X 移除）；`@` 提及或文件树拖入 → context chip。
- **选区上下文**（Cursor 式）：Markdown / PDF 中选中文字 → composer 出现瞬时选区 chip（虚线，实时跟随最新选区；取消选区即消失）；`⌘L` 或 PDF 划词菜单「加入对话」将其**固定**（实底，最多 4 个）并打开 Agent 面板；无选区时 `⌘L` 仍是开关侧栏。发送时选区以 `Selected text from {path} (page N):` + `> 引用` 追加进 prompt，随该轮消费清空；不落 localStorage，超长截断 4000 字符。Store：`src/lib/agent/selection-store.ts`。
- **PDF 选区 → 对话卡片**：来自 PDF 且带页内几何（`rects` + `paperAbsPath`）的选区，在 **Agent 发送该轮** 时写入 `kind: ask` 对话线程（`anchor.quote` = 选中原文，`messages[]` = 用户问题 + Agent 回复）。页边针与浮层为**提问对话卡**（MessageSquare），**不是**视觉批注 `agent-trace`。Markdown 选区或缺少几何时仍只作 chip、不落盘。
- **图片附件**：Composer 支持粘贴 / 点选 / 从 Finder、预览或其它 App 窗口拖入图片（`image/*` 与 macOS image UTI，最多 8 张、单张 ≤ 10 MiB）。拖入图片且指针在 Agent 面板/输入框上时显示虚线 overlay；能判定为非图片（`.md` / PDF）或**文件树内部拖拽**则不显示、不抢落点。macOS OS 拖入走 Tauri `onDragDropEvent`（`dragDropEnabled: true`）并读盘；HTML5 `FileList` 有数据时仍直接附加。不抢成 `@` 路径 chip。提交时转为 ACP `ContentBlock::Image`（与 PDF 视觉批注同一 `runOnce.images` 通路）；会话气泡以缩略 chip 展示，纯图消息无文字气泡。图片仅会话本地保留，不随 `session/load` 历史回放。工具：`src/lib/agent/prompt-image.ts`。
- `@`：空时优先最近路径与浅层目录；› 进入子目录；论文标签与 `paperTreeLabelMode` 一致。`@`、`$` 与 `/` 候选菜单由 viewport 碰撞处理定位，空间不足时翻转并在可用高度内滚动。
- ACP `plan` 事件使用 AI Elements `Plan` / `PlanStep` 展示，可折叠查看步骤；步骤状态由图标、完成态和无障碍文案表达。
- ACP 结构化提问工具会解析为 AI Elements `Tool` 内的可选回答；完成选择后以正常的下一用户轮提交，并继续同一 ACP 会话。支持多 harness 的 rawInput 形状（见下表）。
- 运行中可继续输入 → Queue waitlist；标题保持简洁，条目等宽并可单独移除；Esc / 停止中止。
- 右侧栏 composer 顶部有竖向拖拽分隔条，可压低输入区高度；低于紧凑阈值后，当前文件 / `@` 提及 / 选区 / 视觉草稿 / skill / 图片附件都变为图标圆片，隐藏建议 prompts 与模型、推理强度、上下文用量、Fast 等常驻工具，只保留输入、图片附件和发送。
- 会话空闲时 hover 用户消息可 **Edit** 后重发。
- **新建对话 / 历史恢复**：新建草稿不会清空刚离开的本地 transcript；历史项同时存在 Agentero runtime id 与 ACP provider id 时，`session/load` / 后续续聊只使用 `providerSessionId`；连续续聊产生的新 runtime 行会按 provider id 合并回同一个历史项；加载结果通过一次原子 store 更新写入并激活，避免列表刷新后出现空白会话。详见 [Codex 历史恢复误用 runtime id](../bug_fix/codex-history-runtime-session-id.md)。
- Slash 命令完全来自当前 ACP session 的 `available_commands_update`；Agentero 不再注册本地 action/template。映射时剥离名称前导 `/` 与 `$`（部分 Agent 把 skill 以 `$name` 形式广播），再以 `/name` 填入 Composer，并在当前 provider session 中原样发送。
- **模型选择（含第三方）**：列表来自 ACP `agent:models`；若 Agent 当前模型或用户偏好不在固定目录中（如 Codex + 中转 / cc-switch DeepSeek），仍会并入可选列表，并支持在搜索框输入任意 model id 作为自定义模型（`warm` / `run_once` 会尝试 `SetSessionConfigOption`，即使 id 未出现在上报目录中）。偏好按 agent 持久化。
- **会话模式（capability-driven）**：Codex `collaboration_mode`（Default / Plan 等）。Plan 下才开放 `request_user_input`。事件 `agent:collaboration`；`warm` / `run_once` 携带 `collaborationModeId`。Composer 有上报时显示「模式」下拉（仅模式名，不展示 description）；偏好按 agent 持久化。不暴露 ACP `category: mode` 沙箱档（Read-only / Agent 等）。

## 权限 UI

全局模式（设置）：`restricted` / `ask` / `auto`。  
`ask` 时弹权限对话框 → `agent_respond_permission`。

## 表单 Elicitation / AskUserQuestion（同一 UI）

「Agent 向用户结构化提问」**共用** `AskUserQuestionForm`（AI Elements `Suggestion` 选项芯片）。

**背景**：ACP 无统一 ask-user tool 格式。Client 先声明交互能力（`elicitation.form`），再用 adapter 解析各 harness 的 tool / elicitation / ext；个别 provider 还需 Host 侧 RPC（Grok）或 spawn env（OpenCode `OPENCODE_ENABLE_QUESTION_TOOL`）。详见 [backend/agent.md](../backend/agent.md)「结构化提问」。

各 harness 经 client adapter 落到同一表单：

| 来源 | 协议 / rawInput | UI 位置 | 备注 |
|---|---|---|---|
| Codex tool / Claude / OpenCode `question` | `agent:tool` + 可解析 questions | **底部问卷**（从 tool 提升） | Transcript 只留 tool 行 +「请在下方问卷中作答」；不嵌表单 |
| Codex `request_user_input` | `elicitation/create` → `agent:elicitation-request` | **底部问卷** | Client 须声明 `elicitation.form` |
| Grok `_x.ai/ask_user_question` | ACP **ext method** → `agent:ask-user-request` | **底部问卷** | 提交 → `agent_respond_ask_user`；若同时有 tool 镜像则**抑制** tool 表单 |

**单一交互面**：优先级 `elicitation` > Grok ext > tool 提升；任意时刻只显示一张表单。表单在 **`AgentAskUserSurface`**（transcript 下方）。问卷与 free-text **composer 互斥**：有可渲染问卷时隐藏 resize 手柄与 `AgentComposer`（草稿状态仍由 session composer state 保留），提交或取消后恢复输入壳。解析：`parseAskUserQuestions` / `questionsFromElicitationFields` / `questionsFromAskUserDtos`。

多题为 **翻页**：一页一题，上一题 / 下一题，末题显示「提交」；单选且无 Other 时选项点击后自动进下一题。多选（`multiSelect` / `multiple`）可点多个芯片，答案以 `, ` 拼接。单题仅「提交」。底部「取消」右对齐。

键盘（焦点在问卷区、非自由文本框）：`↑`/`↓` 移动选项焦点，`Space` 勾选/切换，`Enter` 确认当前焦点并下一题（末题提交），`←`/`→` 切题。

Client 声明 `elicitation.form`；用户提交 elicitation → `agent_respond_elicitation`（accept + content）或 cancel。映射：`elicitationContentFromAnswers`。

Tool 提升的作答：`formatAskUserAnswers` 后作为下一用户轮。若当前 turn 仍 `running`（OpenCode 等阻塞在 question tool），会先入队再 **取消该 turn**，以便队列立刻排空发送——避免卡在「等待发送」还要点停止。Grok ext / elicitation 不走此路径。

## 精读（paper-reader）

| 触发 | 条件 |
|---|---|
| Zap | 有 PDF +（TeX 或 `PAPER.md`）且未读 |
| 自动 | `autoPaperReader`（默认关）；魔棒/单篇 Download 后 |

成功写 `NOTES.md`，`is_read = true`；进度在后台任务条。批量导入不连跑。  
Skill 语法由 Host 按 provider 分流（Claude `/id`，其它注入 `SKILL.md`）。  
用户提示会按当前 App 语言（设置里的 `en` / `zh-CN` / 跟随系统解析后）注入一句输出语言说明：正文跟 App 语言，skill 固定的英文 `##` 结构标题保持不变。

`NOTES.md` 须带 YAML frontmatter：

- `aliases`（至少：**论文全称** + **一个短标题**），以便双链 `[[…]]` 按标题提示到该 NOTES
- `created: YYYY-MM-DD`（语言中性键；ISO 日期，Properties 按值识别为日期；已有创建日期则不覆盖）

保留用户已有 frontmatter 键与自定义 alias，不重命名 `NOTES.md` 文件名。约定见 vault 内 `paper-reader` skill。

## 个人偏好

`agentPersonalPrompt`：非空时经 Host `build_prompt` 注入 envelope。

## 代码

- UI：`src/components/agent/`（`agent-panel.tsx` / `agent-composer.tsx` 外壳、`hooks/` 面板与 composer 状态、`composer/` 输入区子件：附件 / 队列 / context chip / @ 与 $ 与 / 菜单 / 模型选择 / 工具条）
- 状态：`src/lib/agent/`（chat-state、composer-state、stream-parse、mention）
- 精读编排：`src/lib/paper/reader.ts`
