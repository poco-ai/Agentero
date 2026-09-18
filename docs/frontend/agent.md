# Agent 面板

BYOA：连接本机（或远程）ACP Agent。Host 协议见 [../backend/agent.md](../backend/agent.md)。

## UI 分层

```text
AI Elements (Conversation / Message / PromptInput / InlineCitation / Reasoning)
  → AgentPanel 状态机
  → invoke agent_* + 订阅 agent:* 事件
```

流式：`agent:stream`（message | thought）→ 完成 / 失败事件。写 NOTES 后统一 Diff（Keep / Revert）。

**行内 citation pill / 统一跳转**：Agent 按格式输出 `[label](papers/…/<id>.pdf#section|figure|page=…)` 或 `[[papers/…/NOTES]]`。`prepareAgentMessageMarkdown` 会给 vault 相对 href 加 `./` 前缀——Streamdown 内置 rehype-harden 只把 `/` `./` `../` 当相对路径，裸 `papers/…` 会被标成 Blocked；点击时再剥掉 `./`。`MessageResponse` / `ReasoningContent` 把 `<a>` 渲成同一 citation pill：`http(s)` 开系统浏览器，vault 路径走 `openCitation`。裸 `papers/…#page|section|figure=…` 也会补成链接。`.tex` href 回退到同论文 `{id}.pdf`。残留 status tag / `blocked` 标签有显示兜底。约定不加外层 `([…])`，不用文末 `## Sources`。Host 解析：`#figure=N` 在 caption 任意位置匹配 `Fig./Figure N`（避免 OCR 把标签挤到标题中间）；`#section=N` 同时认阿拉伯与 IEEE 罗马章节号（如 `3` ↔ `III.`），并抬高短数字的相似度门槛以免误命中页眉噪声。解析失败 Toast 按 fragment 类型短提示（如「找不到 Figure：…#figure=7」）并带上 source。跳转成功后用黄色半透明高亮块闪一下目标区域（约 1.6s 淡出消失），目的是引起注意；细条 section 标题会扩成标题下一段预览块，并按 bbox 滚进视口。Figures 侧栏选中仍用 kind 色描边（常驻）。

## 面板行为

- 空态建议 chips → workflow：`summary` / `qa` / `related_work`。
- **Agent 切换器列表**：App 启动即 `scanCatalog` + soft-probe（`prefetchAgentCatalog`，不依赖侧栏挂载）；面板挂载与 vault 变化时再 `listAgents + scanCatalog` 刷新。Settings 探测 / 安装 / 卸载 / 改默认会改 registry，Host 广播 `agent:registry-changed`（已纳入 lifecycle typed bus，见 [lifecycle-events](../development/lifecycle-events.md)），面板经 `lifecycle.on` 防抖刷新——面板常驻不卸载，否则探测成功后切换器仍是旧列表。catalog 项仅 `acpStatus === "ready"`（ACP 握手成功）才显示，不可用项直接隐藏而非置灰。
- **当前论文默认 context**（可 X 移除）；`@` 提及或文件树拖入 → 在输入正文光标处插入行内 mention chip（见下）。
- **选区上下文**：划词本身**不会**进入对话。划词工具栏顺序为 **翻译 → 快速对话（`⌘K`）→ 加入对话（`⌘L`）**。**加入对话** / 有选区时的全局 `⌘L` / `⇧⌘A`（额外聚焦输入框）固定选区并打开 Agent；**快速对话** / `⌘K` 打开页内 Ask 浮层，不写入 composer。无选区时 `⌘L` 仍开关侧栏。聚焦走 `src/lib/agent/composer-focus.ts`。发送时选区以 `Selected text from {path} (page N):`（PDF）或 `Selected text from {path} (lines A-B):`（CodeMirror 划词，chip 标签 `文件名 A-B行`）+ `> 引用` 追加进 prompt，随该轮消费清空；不落 localStorage，超长截断 4000 字符。Store：`src/lib/agent/selection-store.ts`（`active` 仅作 ⌘L / ⇧⌘A 暂存，不展示、不发送）。
- **选区就地批注**：PDF、Markdown 正文、纯文本编辑器与聊天消息中的文字，点击 **Add to chat / 加入对话** 后在选区附近的紧凑输入框填写可选批注，原文保持高亮，浮层不重复展示引文。输入框随内容增高，确认按钮与输入同行。Enter 确认，Shift+Enter 换行；点击外部暂存有内容的未完成批注，再点原句或重新选择同一处文字可继续；新批注为空或仅空白时，点击外部直接丢弃并清除其原文选区高亮。Escape / 取消明确丢弃当前未确认修改；中文输入法确认候选不会提交。确认只加入聊天草稿，不直接调用 Agent。每段原文保留自己的批注与来源（PDF 页码和几何、文本编辑器行号、聊天会话和消息标识），通过 inline selection token 一起进入下一轮 prompt；空批注只添加原文。浮层独立保存选区快照，输入框获得焦点后仍可确认。⌘L / ⇧⌘A 保留原有直接添加行为。
- **批注汇总与角标**：选区批注在 Composer 中显示为一枚计数汇总；悬停或点击可查看原文、批注，并编辑、删除单条或移除全部。删除同步清除该条批注的原文临时高亮、浏览器选区和临时锚点，不影响其他选区。批注仍保存在所属对话的 selection token 草稿中，汇总和原文角标只是同一草稿的视图，不另存永久注释。已打开的 Markdown / 聊天原文和 PDF 页面显示编号角标，悬停预览、点击编辑；发送、删除或切换到其他对话后跟随当前草稿更新。DOM Range / PDF 页面几何仅作为窗口内临时锚点，不写入提示词。Markdown / 聊天引用另存原文和前后邻近文字，来源视图重建后只有唯一匹配才恢复角标；点击来源路径可打开并定位原文。原文改变或匹配含糊时提示定位失败，仍保留原始引用。聊天同时保留 provider 会话标识和消息 ID，PDF 按页码、归一化区域复用已有引用跳转。
- **发送后保留引用**：本地 `ChatLine.selections` 保存本轮引用快照，用户消息可展开查看原文、批注及来源定位；复制、编辑后重发、非 resume 模型的本地上下文回放均带上对应引用。提示词使用逐条编号，并明确引文是参考资料、批注只针对其对应原文。此验证覆盖数据与提示词，不等于保证模型逐条回答。
- **批注恢复边界**：未确认的输入仅在本次应用运行中按对话暂存，切换 Vault 清空。已发送的结构化引用跟随本地聊天记录；应用重启或 ACP 远端 `session/load` 不保证恢复这些本地字段，尚未引入永久批注存储。PDF 文件被替换后的几何有效性仍需重新确认。
- **PDF 选区 → 对话卡片**：来自 PDF 且带页内几何（`rects` + `paperAbsPath`）的选区，在 **Agent 发送该轮** 时写入 `kind: ask` 对话线程（`anchor.quote` = 选中原文，`messages[]` = 用户问题 + Agent 回复）。页边针与浮层为**提问对话卡**（MessageSquare），**不是**视觉批注 `agent-trace`。Markdown 选区或缺少几何时仍只作对话引用，不落盘。
- **图片附件**：Composer 支持粘贴 / 点选 / 从 Finder、预览或其它 App 窗口拖入图片（`image/*` 与 macOS image UTI，最多 8 张、单张 ≤ 10 MiB）。拖入图片且指针在 Agent 面板/输入框上时显示虚线 overlay；能判定为非图片（`.md` / PDF）或**文件树内部拖拽**则不显示、不抢落点。窗口 `dragDropEnabled: false`，走 HTML5（Windows 上 Tauri 原生拖放会吞掉 HTML5）；`FileList` 有数据时直接附加，否则按路径读盘。不抢成 `@` 路径 chip。提交时转为 ACP `ContentBlock::Image`（与 PDF 视觉批注同一 `runOnce.images` 通路）；会话气泡以缩略 chip 展示，纯图消息无文字气泡。图片仅会话本地保留，不随 `session/load` 历史回放。工具：`src/lib/agent/prompt-image.ts`。
- `@`：空时优先最近路径与浅层目录；› 进入子目录；论文标签与 `paperTreeLabelMode` 一致。输入标题关键词还可命中**广场条目**（arXiv Daily 当日推荐 + Feeds 最近 60 条，虚拟路径 `agentero:plaza/…`，图标与广场来源一致）；空 `@` 不罗列广场条目，仅以最近使用出现，文件夹钻取也不含。选中后同为行内 mention chip（显示截断标题）。发送时广场条目不进"读取知识库文件"路径列表，而是把标题 / 来源 / URL / 摘要直接展开进 prompt（未入库即可讨论；条目已过期时降级为不可用提示行，不静默丢弃）。工具：`src/lib/agent/plaza-mention.ts`（虚拟路径 + 注册表 + prompt 展开）、`hooks/use-plaza-mention-source.ts`（数据加载，静默失败）。`@`、`$` 与 `/` 候选菜单由 viewport 碰撞处理定位，空间不足时翻转并在可用高度内滚动。
- ACP `plan` 事件使用 AI Elements `Plan` / `PlanStep` 展示，可折叠查看步骤；步骤状态由图标、完成态和无障碍文案表达。
- ACP tool 更新按 `toolCallId` 回写所属 Agent 消息，即使 completion 晚于回合结束也能修正原卡片；回合完成、失败或取消时，仍为 pending / in-progress 的卡片先收敛为 failed，避免永久 spinner。迟到的内容和 completed / failed 状态仍可更新原卡片，pending / in-progress 不会让已结束回合重新转圈。
- ACP 结构化提问工具会解析为 AI Elements `Tool` 内的可选回答；完成选择后以正常的下一用户轮提交，并继续同一 ACP 会话。支持多 harness 的 rawInput 形状（见下表）。
- 运行中可继续输入 → Queue waitlist（「等待发送」）；标题保持简洁，条目等宽并可单独移除；Esc / 停止中止。队列排在输入壳**上方**的正常文档流里（不绝对定位遮挡输入框）；可调高度只作用在输入壳本身，队列另占一行高度。紧凑模式下队列自身也会收紧 padding。
- **会话配置条**（Header 下方）：模型选择、协作模式（有上报时）、Fast（有上报时）；推理强度收在模型选择弹层顶部，与当前模型名称同行。从 Composer 工具栏上移，压低输入区时也不再被隐藏；窄侧栏中保持单行，过长的模型 / 模式名称以省略号截断。
- 引用上下文：`@` 提及、`$skill`、`/command` 选中后在输入正文里**行内插入**小 pill（contenteditable；行高贴近正文、`max-w` 较短；点击或 Backspace 整颗删除）。Skill pill **只显示图标 + 名称**（去掉 `$` / `skill :` 前缀）；`@` 仍带 `@`，`/` 仍带 `/`；选区显示为输入框上方的批注计数汇总。草稿 marker：`{{m:path}}` / `{{s:skillId}}` / `{{c:name}}` / `{{sel:…}}`；发送时剥离 m/s/sel（路径、skillIds、选区走原通路），c 展开为 `/name` 进 ACP 正文。当前文件、视觉批注仍为输入框上方的块级 chip：默认图标；hover / 聚焦时**宽度动画展开**短标签与 ×（不用 tooltip 浮层）。图片附件仍在边框内。紧凑一行模式**按内容撑开**（不写死壳高，避免输入行下留白）；触发条件：composer 高度 ≤ 160px（拖拽分隔条可随时进出）。应用窗口高度 < 600px 时**默认压到紧凑高度**（打开侧栏或窗口由高变矮时），但不锁死，用户仍可拖高退出紧凑。块级 chip 与图片收成图标圆片；隐藏底部工具栏，圆形向上箭头发送按钮与输入框同一行并垂直居中（无内容时置灰）；单行用 `px-3 py-2.5`，与非紧凑 footer 的 `px-3 pb-2.5` 对齐，切换紧凑时发送按钮底边 inset 不跳。外层左右 padding（`px-3`）与底边距（`pb-3`）与非紧凑一致，避免输入框宽度或与下边框距离跳动。右侧栏 composer 顶部有竖向拖拽分隔条，可压低输入区高度。
- 会话空闲时 hover 用户消息可 **Edit** 后重发。
- **长会话虚拟化**：transcript 行数 ≥ 80（`use-transcript-virtualizer` 的 `VIRTUALIZE_MIN_LINES`）时切换 `@tanstack/react-virtual` 窗口化渲染，复用 use-stick-to-bottom 的 scrollRef（贴底与滚动按钮行为不变）；Reasoning / Tool / Plan 折叠态提升到 `ChatTranscript` 统一管理，行卸载不丢。
- **新建对话 / 历史恢复**：新建草稿不会清空刚离开的本地 transcript；历史项同时存在 Agentero runtime id 与 ACP provider id 时，`session/load` / 后续续聊只使用 `providerSessionId`；连续续聊产生的新 runtime 行会按 provider id 合并回同一个历史项；远端历史项会先激活空 transcript 并显示 Shimmer/骨架占位，加载结果再通过一次原子 store 更新替换为真实内容，避免列表刷新后出现空白会话。详见 [Codex 历史恢复误用 runtime id](../bug_fix/codex-history-runtime-session-id.md) 与 [Agent 历史会话恢复加载反馈](../bug_fix/agent-history-session-shimmer.md)。会话标题优先用 ACP `session/list` / `session/load` 返回的 title，缺失时回退首条用户消息（本地已有 transcript 时立即从首条 user turn 推导；外部会话无 title 时先留空并由后台 `session/load` **预加载**补全——切 Agent / 打开历史弹层时对无标题项并发 hydrate，结果写入 `localStorage` 标题缓存，下次列表可秒开；**不再**用 session id 前缀占位以免挡住回退，见 #484）。历史列表元信息只显示 `Agent · 状态`，**不**再常驻 `ses_…` id；id 仅在标题完全缺失时作为最后兜底。运行中 Agent 经 `session_info_update` 推送的新标题由 `agent:session-info` 事件实时写回历史项（按 runtime id 或 providerSessionId 匹配；视觉批注会话标题不被覆盖）。
- Slash 命令完全来自当前 ACP session 的 `available_commands_update`；Agentero 不再注册本地 action/template。映射时剥离名称前导 `/` 与 `$`（部分 Agent 把 skill 以 `$name` 形式广播），再以 `/name` 填入 Composer，并在当前 provider session 中原样发送。
- **模型选择（含第三方）**：列表来自 ACP `agent:models`；若 Agent 当前模型或用户偏好不在固定目录中（如 Codex + 中转 / cc-switch DeepSeek），仍会并入可选列表，并支持在搜索框输入任意 model id 作为自定义模型（`warm` / `run_once` 会尝试 `SetSessionConfigOption`，即使 id 未出现在上报目录中）。偏好按 agent 持久化。弹层顶部固定「当前选择」，模型名称与推理强度下拉按基线保持一行；搜索与模型目录在下方独立滚动。点击当前模型名称即清空搜索并滚动到完整目录中的当前模型、短暂高亮（不跳到收藏副本），无常驻定位按钮；打开时聚焦搜索。选择模型后弹层保持打开，可继续调整强度，点击外部或 Esc 关闭；协商期间暂停再次选择模型。
- **会话模式（capability-driven）**：Codex `collaboration_mode`（Default / Plan 等）。Plan 下才开放 `request_user_input`。事件 `agent:collaboration`；`warm` / `run_once` 携带 `collaborationModeId`。Header 下配置条有上报时显示「模式」下拉（仅模式名，不展示 description）；偏好按 agent 持久化。不暴露 ACP `category: mode` 沙箱档（Read-only / Agent 等）。
- **推理强度**：紧跟顶部当前模型名称，无分隔点、无常驻标签、无独立配置行；点击档位名称打开单选菜单。ACP 提供的档位名称与顺序原样展示（不翻译 Low / High / Max 等 Agent 数据），标签仅用于 Tooltip / 无障碍名称。没有已存选择时，默认当前模型支持的最高可识别档位（none/off → minimal → low → medium → high → xhigh → max → ultra）；ACP 不定义强度排序，自定义档位无法排序时采用 Agent 当前值。手动选择按 Agent 持久化，重新打开、切换 Agent 或模型后仍支持该档位时继续使用；不支持时采用 Agent 当前值，保留原偏好供切回时恢复。发送前 Host 按最终模型能力校验；未手动选择时传 `preferHighestReasoningEffort`，保证在 warm 尚未完成时首轮也应用最高档策略。快捷工作流切换 Agent 时采用目标 Agent 的偏好。

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
用户提示会按当前 App 语言（设置里的 `en` / `zh-CN` / 跟随系统解析后）注入一句输出语言说明：正文跟 App 语言，skill 固定的中文 `##` 结构标题保持不变。

`NOTES.md` 须带 YAML frontmatter：

- `aliases`（至少：**论文全称** + **一个短标题**），以便双链 `[[…]]` 按标题提示到该 NOTES
- `created: YYYY-MM-DD`（语言中性键；ISO 日期，Properties 按值识别为日期；已有创建日期则不覆盖）

保留用户已有 frontmatter 键与自定义 alias，不重命名 `NOTES.md` 文件名。约定见 vault 内 `paper-reader` skill。
作者联系方式、外链、OpenReview 与详细人物档案等联网检索规则拆到 `paper-reader/author-lookup.md`，主 `SKILL.md` 只负责精读入口与路由。

## 个人偏好

`agentPersonalPrompt`：非空时经 Host `build_prompt` 注入 envelope。

## 消息 Markdown 渲染

`MessageResponse` / `ReasoningContent` 用 Streamdown；表格与代码块走自研轻量壳，交互对齐：

| 块 | 组件 | 悬停操作 |
|---|---|---|
| 表格 | `PlainTable` | 复制（Markdown / CSV / TSV）、下载（CSV / Markdown）、全屏 |
| 代码块 | `PlainCodeBlock` | 左上角语言小标签；悬停复制/下载（按语言后缀）；无外侧卡片、无全屏；`mermaid` 仍走 Streamdown 图渲染 |

落盘：`src/components/ai-elements/plain-table.tsx`、`plain-code-block.tsx`。

Streamdown 的 `mode` 由 `isAnimating` 派生：流式中 `"streaming"`（跑 remend 补全未闭合标签），消息落定后 `"static"` 跳过 remend——否则公式里 `x_{<n}` 的 `<n…` 会被当成未闭合 HTML 标签截掉，KaTeX 报 `Expected '}', got 'EOF'`（#584，复盘见 [bug_fix/agent-message-math-less-than](../bug_fix/agent-message-math-less-than.md)）。

## 代码

- UI：`src/components/agent/`（`agent-panel.tsx` / `agent-composer.tsx` / `agent-config-bar.tsx` 外壳、`hooks/` 面板与 composer 状态、`composer/` 输入区子件：附件 / 队列 / context chip / @ 与 $ 与 / 菜单 / 模型选择 / 工具条）
- 状态：`src/lib/agent/`（chat-state、composer-state、stream-parse、mention）
- 精读编排：`src/lib/paper/reader.ts`

- **选区的最小上下文**：Markdown / 聊天截取选句所在文本块的前后各最多 240 字符、最近标题最多 120 字符；聊天回答额外携带前一条用户问题最多 200 字符。PDF 仅复用当前页已有布局解析中唯一匹配的文本块，不触发额外解析；无法可靠匹配时标记辅助上下文不可用。上下文与原文、批注分别序列化为 reference material，提示 Agent 按路径 / 页码 / 会话消息标识按需查阅来源；这些标识不保证所有 Agent 都具备读取能力。不会自动附上整篇论文或整段聊天历史。

- **含公式的聊天角标**：原文定位按保存时的 DOM 文本锚点校验，不将浏览器的可见选区文本与 KaTeX 的 DOM 文本直接比较；避免行内公式的辅助标记使有效批注角标消失。
