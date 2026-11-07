# 知乎 Agent

内置「知乎」Agent：出现在右侧栏 Agent 面板的切换器里，无需安装任何 CLI。它把**知乎直答**与**按标题检索**两项能力接进对话面板，随论文阅读随时调用。

Host 契约见 [../backend/zhihu.md](../backend/zhihu.md)；完整设计（含未来的 CLI 后端与广场面板）见 [../development/zhihu.md](../development/zhihu.md)。

## 形态

内置 Agent，不是外部 ACP 进程：

- 注册表在启动时注入一条 `template: "zhihu"` 的 descriptor（`built-in-zhihu`），`available: true`，因此在切换器里无需探测/安装即可见。
- 选择后在右栏 Agent 面板正常对话：流式直答、模型配置条、历史项行为都与外部 Agent 一致。知乎**没有斜杠命令**。
- 它是 **chat-only**：不读 Vault、不跑 ACP、不做 `session/list`。因此它不出现在「翻译 / PDF Ask」的 Agent 选择器里。
- 它拿不到 Vault 文件，但仍会收到**当前论文的公开元数据**（标题 / 作者 / 期刊 / 年份 / arXiv / DOI / 摘要，摘要截断 1200 字），由 `assembleTurnPrompt` 的 `paper` 参数注入。本地路径**从不**发送。

## 空态推荐卡片

知乎 Agent 打开且当前对话为空时，不显示通用工作流建议（总结当前论文 / 就我的文献库提问…），而是**直接**用当前论文标题检索知乎，把命中的问题/回答/文章渲染成推荐卡片（`zhihu-discussions.tsx`）：

- 打开即检索（标题变化时重取）；点击卡片在系统浏览器打开知乎原文；「换一批」重新检索。
- 状态：未打开论文 / 未配置 Access Secret / 检索中（骨架）/ 空 / 失败（可重试）。
- 结果由 Host `zhihu_search` 命令返回，已按 `RankingScore ≥ 0.5` 过滤；卡片顶部标注「按论文标题检索，结果可能与本文无关」。
- 独立于聊天：不走 `agent:*` 事件、不产生对话消息。

## 能力

| 输入 | 行为 |
|---|---|
| 纯文本 | 知乎直答（`/v1/chat/completions`，流式），增量渲染为普通 Agent 消息；提示词附带当前论文公开元数据，可直接问「总结当前论文」 |

检索结果取开放平台 `RankingScore` 相关度 ≥ 0.5 的条目，按平台返回顺序展示，含作者与赞同数。

## 论文信息栏入口

左侧栏底部 **Paper Info（信息）面板** 的链接区首行有「知乎」入口（`paper-info-panel.tsx`）：

- 按当前论文生成提问草稿——标题 `如何评价论文《…》？`（≤50 字，配了 Access Secret 时先用直答把英文标题译成中文，失败/未配则回退原标题），正文含论文 / 作者 / 期刊（年份）/ 链接 / 摘要（≤800 字）。
- 点击后把草稿复制到剪贴板并打开 `zhihu.com`，用户粘贴发布。
- 桌面端无法像 Chrome 扩展那样直接驱动知乎的提问弹窗（无 create-question API），所以是「复制 + 打开」而非「自动填入」。

## 凭证

Access Secret 在 **设置 → Agent → 常用 Agent** 列表中「知乎」行配置（位于「自定义」上方）：

- 输入框是 write-only：保存后不再回显明文，只显示可用状态点（未配置 / 检测中 / 可用 / 不可用）。
- 存储走 Host `settings.json`（0600），IPC 上始终是 `*` 掩码；前端从不持有明文。
- 保存后自动用一次最小检索探测连通性（消耗一次开放平台额度）。
- 未配置时发送会返回可读错误并提示到设置页配置。

Secret 获取：登录 <https://developer.zhihu.com> → profile 生成。

## 代码

- UI：`src/components/settings/panes/agent/zhihu-agent-row.tsx`（常用 Agent 列表中的「知乎」行 + 凭证编辑）
- 空态推荐卡片：`src/components/agent/zhihu-discussions.tsx`（`ZhihuDiscussions`）；`chat-transcript.tsx` 在 `isChatOnlyAgentTemplate(agentTemplate)` 时用它替换通用建议
- 前端库：`src/lib/zhihu.ts`（探测 / 检索 `searchZhihuDiscussions` / 提问草稿 / 站点入口）
- 论文上下文：`paperContextBlock` / `AssembleTurnPromptInput.paper`（`src/lib/agent/turn-prompt.ts`）；元数据取自 `useAgentPanelContext` 的 `selectedPaperMeta`，在 `use-agent-send` 里对 chat-only Agent 生效
- Agent 标识：`src/lib/agent/api.ts` 的 `AgentTemplate` / `isChatOnlyAgentTemplate`；`src/components/agent/agent-logo.tsx`

## 限制与后续

- 目前只做「直答 + 标题检索」；论文↔讨论的**精确索引**（预印本/正式版别名、作者 ORCID 绑定、作者参与优先排序）尚未接入，等待知乎侧提供对应服务端接口。
- 直答为单轮；多轮上下文依赖前端本地 transcript 回放（`buildLocalTranscriptPrompt`），非服务端会话。
- 论文上下文仅取当前聚焦的论文；未打开论文时只发用户输入。摘要来自 catalog，缺失时只发标题 / 作者 / 标识符。
