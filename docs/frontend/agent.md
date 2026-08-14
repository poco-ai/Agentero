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

- **答辩间 Viva（ChatGPT Web Voice）**：主窗口标题栏麦克风按钮打开答辩间（用户界面名「答辩间 / Viva」，代码与文档内部仍沿用 voice-defense 标识）。入口在标题栏、不在 Agent 侧栏会话条；麦克风仅在右侧栏展开时显示，与 Agent / 双链等 tab 同一组。桌面端打开独立单例窗口（`viva`），主工作台保持可继续阅读；浏览器预览仍为全屏弹层。准备页与总结页跟随应用主题（浅色/深色均可），通话页保持沉浸式深色舞台；准备页与总结页的主操作位于底部常规页脚（细分隔线、随文档流，不悬浮遮挡内容；总结页底栏允许换行、胶囊关闭按下缩放，生成评价进行中改为状态字以免与「打开转写」叠层），通话页控制条保持悬浮胶囊。准备页单栏居中，顶部为标题与三位委员节点轨道（精读材料 → 拟定质疑 → 质询提纲，取代通用步骤条 + 进度条 + 状态徽章）；节点连线采用 MagicUI Animated Beam——仅通往正在工作委员的那段有天蓝光束流动，未到达/已完成的连线为静态细线（完成段为翠绿），不闪烁不脉冲；轨道下一行叙事承载全部状态（进行中叙事脉冲、失败原因红色、材料变更/过期收敛为一条琥珀提示）；配置态展示去卡片化表单：材料区为一条恒定高度的胶囊长条（左侧固定圆形 ＋ 按钮打开搜索选择器；空态内嵌占位文字与「使用当前打开的论文」虚线建议椒；选中材料为胶囊、新增淡入并平滑滚至可见，溢出时手动横向滚动配右缘渐隐遮罩，无自动滚动，任何状态高度不变）；时长为圆形进度表盘（MagicUI Animated Circular Progress Bar，环形进度随主题色填充至 120 分钟上限，中心显示分钟数），两侧 ± 按 5 分钟步进，降到 5 以下即不限时显示 ∞，下方为分段控件快捷档 不限时/10/20/30/45，以及独立于 UI 语言的答辩口语（中/英）与提问难度（自适应/基础/高阶，localStorage 记忆）；材料指纹未变时展示「使用上次提纲 / 重新准备」，并列出该材料包在 `voice-defense/` 下带 YAML frontmatter 的历史场次；生成中委员节点依次点亮，表单收拢为「N 项材料 · 时长」摘要；提纲就绪后以元信息行（就绪徽标、材料数、时长可经下拉直接改、编辑切换，材料/要求沿用锁定语义）置顶，提纲以文档形态接管整栏，可切换为全文编辑。用户先勾选一个或多个 Vault 文件/目录并填写答辩要求；当前焦点材料仅作为候选列表置顶建议，不自动选中，该选择不依赖 Agent 输入框的上下文开关。多 Agent 生成的 brief 经用户检查后，前端通过 WebRTC 建立实时音频，以协商式 `oai-events` DataChannel 一次性注入；bootstrap 采用「角色 → 材料 → 会话规则」三明治结构，把回合制规则（每轮一个问题且禁填充语开头、问题必须点名材料中的章节/公式/结论/例题、随回答自适应加深或抓薄弱点追问、不评判材料类型或"新意"只考察内容理解、噪声让用户重复而不是自行展开、开场只宣布一次且不确认收到指令）放在材料之后的 recency 窗口内；人设由场景 preset 决定（毕业答辩/组会预演/审稿质询/面试模拟，localStorage 记忆，提问侧重随场景切换），计划时长也注入 recency 窗口（委员据此控节奏、临近结束收束并一句话简评），配合显式 `echoCancellation`/`noiseSuppression` 采集约束，防止委员开场后语境漂移或把回声当作用户发言；内部 bootstrap 使用可追踪消息 ID，不显示为用户字幕，也不进入转写。bootstrap 的首条响应必须直接宣布开场并提出第一问，提示词显式禁止“明白 / Understood”确认回执及问题前后的确认口癖；只有模型意外退化为纯短回执时，客户端才等待该字幕静置 1 秒后发送内部“请开始答辩”作为恢复触发（同样不上台不进转写），若迟到字幕表明委员已经直接开场则取消触发。启动时关闭麦克风上传音轨；开场门控（`reduceVoiceOpening`）要等到委员发出真正的第一问并且该轮说完（`listening`/`idle`）才开麦——bootstrap 回执（“好的/明白了/了解背景”）既不开麦也不上台，开场期只有宣布或第一问字幕上台；门控关闭期间到达的用户字幕一律丢弃。上游长时间无开场时二十秒后才兜底放开，且委员仍在说话时不会打断该轮。开场出现后，任何重新宣布“答辩开始”的委员消息（`isDefenseRestartCaption`，含无“现在”的“答辩开始”）会被自动 `stop_speaking` 打断并从舞台/转写撤回，防止连宣两次开场（复盘：[voice-defense-opening-ack-gate.md](../bug_fix/voice-defense-opening-ack-gate.md)）。「好的，答辩开始」这类短宣布算作开场而不是回执，避免恢复触发再要委员开一次场。字幕解析统一剔除 U+FFFD 乱码字符；bootstrap 规则明确"答辩开始只宣布一次"，防止杂音打断后委员重启开场（复盘：[voice-defense-opening-noise-captions.md](../bug_fix/voice-defense-opening-noise-captions.md)）。通话页以特大号红色翻页时钟为唯一中心（vendored split-flap 组件 `src/components/ui/flip-clock.tsx`，em 缩放、分钟固定两位；不限时正计时为中性色；预设 10/20/30/45 分钟则全程红色倒计时营造压迫感；时钟下方仅呼吸灯与状态字，不再重复计划时长或已问轮次——计时模式常驻红色底晕，最后一分钟光晕增强、心跳缩放并叠加舞台四周红色渐晕收拢，到时 Toast 提醒并转为更亮的红色超时上翻显示，不自动结束；计时基准是委员首次进入 `speaking`，首条可见字幕作为协议缺失时的兜底，连接与信令等待不计入答辩时长；`prefers-reduced-motion` 下直接换牌不播翻页动画；原时钟上方的音量柱已移除），字幕为双固定锚位（委员最新问题固定主槽、用户最新发言固定次槽，槽位定高、内容底部锚定向上溢出并顶部渐隐，流式追加零动画、仅换消息时交叉淡入，非当前说话方整槽降透明度——回答时问题保持可见），交错的空字幕帧不会抢占流式槽；提供静音、`stop_speaking` 打断、会中补充资料（点击后底栏胶囊展开为输入条，开场门控放开后以内部用户消息注入，不上台不进转写；叉掉或 Esc 收回）、拉回主题和结束操作，完整历史在侧边转写抽屉。会话状态只存在于答辩间窗口内，不进入 Agent Zustand/ACP 会话；结束（含通话中关闭窗口、已有字幕的异常）一律进入答辩总结页，展示时长、委员发言与**预期质疑覆盖率**，转写预览逐条完整展开、不按两行省略——有准备提纲的会话会在本地做复盘（`debrief.ts`：拉丁文按词、CJK 按字符 bigram 的 Dice 相似度，把提纲问题与委员实际提问匹配），总结页列出未被问到的质疑（含应答要点，作复习清单）；转写**仅在用户点击「保存转写」后**写入 Vault `voice-defense/YYYYMMDD-HHmmss.md`（YAML frontmatter 记录 materials / preparationRun / coverage / language / scenario），保存时附带完整复盘章节（每条质疑的实际提问、用户回答、准备的应答要点与证据双链）；结束页可显式「生成评价」，后台隐藏 ACP（`voice_defense_review`，restricted、不进聊天历史）写入同 stem 的 `-review.md` 并回写转写 frontmatter 的 review/weakAreas，评价不阻塞结束；未保存关闭即丢弃。答辩间也可从命令面板「进入答辩间」打开（桌面端打开或聚焦 `viva` 窗口；浏览器预览挂起请求直到 overlay 宿主挂载，`open-request.ts`）；关键漏斗事件（打开/准备/连接/结束/保存）以 `[viva]` 前缀写入本地日志（`metrics.ts`，不上报）；通话中若识别的上游消息占比异常低会记录一次协议漂移告警，便于从用户日志诊断上游协议变更。
- **会前多 Agent 准备**：默认仍走多 Agent 生成 brief；当材料列表、指令与文件指纹（`snapshotSha256`）与某次 `awaiting_review`/`ready`/`completed` run 一致时，准备页提供「使用上次提纲」（用户确认后加载该 brief）和「重新准备」。不提供未准备直接进入 Voice 的旁路。准备任务将材料列表、用户指令、相关选区和文件指纹固化为不可变快照，固定并行运行材料分析与审稿质疑两个 ACP Worker；第三步整理**在本地确定性合成**（`local-synthesis.ts`：把两份 Host 校验过的结构化产物渲染为 brief Markdown，经与磁盘一致的 schema 校验后写入 `voice-defense/preparations/<run-id>/defense-brief.md`），不再发起第三次 ACP 调用——准备耗时缩短约一轮 LLM 往返，且模板不会引入校验产物之外的内容。分析 Worker 使用当前 Agent、模型与 reasoning effort，权限固定为 `restricted`，后台 session 不进入普通历史。答辩间窗口显示分析/质疑/整理三阶段；关闭窗口会结束该窗口内的前端准备任务，磁盘上的 run 可在下次打开时恢复。排队中和运行中的任务都可取消，支持失败步骤重试、重启恢复、partial 与 stale 状态。准备运行期间，两位委员的实时思考流与工具动作以文字墙呈现在准备页背景（`thought-backdrop.tsx` + `lib/voice-defense/thought-stream.ts`：按子会话把 `agent:stream` thought 与 `agent:tool` 事件路由到左右两列，节流合并、行数封顶、仅内存不落盘；透明度按行新旧递退——最新行为清晰的"思考前沿"、越旧越淡，浅色深色主题均可读；工具动作中的快照工作区绝对路径清洗回 Vault 相对路径，思考行渲染时去除 Markdown 加粗符；中心径向遮罩为标题与委员轨道留白，事件静默约 5 秒整层变暗，`prefers-reduced-motion` 下新行不播入场动画）——背景动画完全由真实 token/工具活动驱动，不是循环假动画。最终 brief 可编辑，点击开始后先原子保存并确认。Voice 与准备任务、会后评价任务互斥，连接前同时检查前端队列/child 状态和 Host workflow 屏障（`voice_defense_preparation` 与 `voice_defense_review`），通话中不会调用 ACP、检索或合并。
- **准备材料状态**：一路分析失败时保留另一路并生成带醒目标记的部分材料；两路全失败或整合失败不会显示伪成功。论文源文件 hash 变化后旧材料标为 stale，用户可更新或明确使用上一版。应用不截断 brief；上游长度错误通过 Toast 原样报告。转写的 `Source` 双链指向本次确认的 `defense-brief.md`。
- **单账号内置登录**：答辩间提供“连接 ChatGPT”。点击后由 Host 创建临时原生 `voice-auth` WebView；前端只监听连接状态，不接收 ChatGPT token。成功捕获会话并写入系统凭证库（macOS Keychain、Windows Credential Manager、Linux Secret Service）后登录窗口会被彻底销毁。“开始答辩”只以账号连接、Vault 和上下文状态为前置条件；上游返回 401 时 Host 会删除失效凭证并让答辩间回到重新连接状态。设置页不暴露 Gateway URL、API Key 或连接测试。
- **按需 Voice Sidecar**：创建会话时，Host 才从系统凭证库读取 token，并通过子进程 stdin 注入随应用打包的 `agentero-voice-sidecar`。Sidecar 只监听随机 loopback 端口，Host 与它使用每次启动生成的随机密钥；通话结束、启动失败、父进程退出或空闲超时都会终止。它不包含账号池、数据库、管理后台、Docker 或下游 API Key。旧 `settings.voiceDefense` 在 Host 首次加载时从设置文件迁移删除。
- **故障回收**：麦克风拒绝、缺失或占用会显示本地化提示。WebRTC 短暂 `disconnected` 有五秒恢复窗口；持续断网、WebRTC/DataChannel 失败后立即停止媒体并尽力释放内部会话，已有字幕仍可保存。Sidecar 在信令完成后崩溃不会破坏已建立的点对点媒体，结束释放保持幂等，下一次答辩会启动新进程。
- **Voice 生命周期互斥**：每次启动预留唯一 lease；关闭、异常和异步 `close()` 只能按 lease id 释放自己拥有的会话。旧连接的延迟回调不能清除快速重开后的新会话锁。连接中取消统一走关闭路径；窄或矮窗口固定头尾并让中部材料/字幕区域滚动。
- 空态建议 chips → workflow：`summary` / `qa` / `related_work`。
- **当前论文默认 context**（可 X 移除）；`@` 提及或文件树拖入 → context chip。
- **选区上下文**（Cursor 式）：Markdown / PDF 中选中文字 → composer 出现瞬时选区 chip（虚线，实时跟随最新选区；取消选区即消失）；`⌘L` 或 PDF 划词菜单「加入对话」将其**固定**（实底，最多 4 个）并打开 Agent 面板；无选区时 `⌘L` 仍是开关侧栏。发送时选区以 `Selected text from {path} (page N):` + `> 引用` 追加进 prompt，随该轮消费清空；不落 localStorage，超长截断 4000 字符。Store：`src/lib/agent/selection-store.ts`。
- **PDF 选区 → 对话卡片**：来自 PDF 且带页内几何（`rects` + `paperAbsPath`）的选区，在 **Agent 发送该轮** 时写入 `kind: ask` 对话线程（`anchor.quote` = 选中原文，`messages[]` = 用户问题 + Agent 回复）。页边针与浮层为**提问对话卡**（MessageSquare），**不是**视觉批注 `agent-trace`。Markdown 选区或缺少几何时仍只作 chip、不落盘。
- **图片附件**：Composer 支持粘贴 / 点选 / 拖入图片（`image/*`，最多 8 张、单张 ≤ 10 MiB）。提交时转为 ACP `ContentBlock::Image`（与 PDF 视觉批注同一 `runOnce.images` 通路）；会话气泡以缩略 chip 展示，纯图消息无文字气泡。图片仅会话本地保留，不随 `session/load` 历史回放。工具：`src/lib/agent/prompt-image.ts`。
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

- UI：`src/components/agent/`
- 状态：`src/lib/agent/`（chat-state、composer-state、stream-parse、mention）
- 实时答辩与会前准备：`src/components/agent/voice-defense-dialog.tsx`、`src/lib/voice-defense/`、`src/lib/voice-defense/preparation/`
- 精读编排：`src/lib/paper/reader.ts`
