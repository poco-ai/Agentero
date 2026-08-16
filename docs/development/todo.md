# Agentero TODO

仅列**未完成**项。当前发布 **`0.5.0`**。版本切片见 [`roadmap.md`](roadmap.md)；已实现能力见 [`../frontend/`](../frontend/index.md) · [`../backend/`](../backend/index.md)。

## 0.3 — 入库与 Agent 补强

- [x] Markdown 目录：标题数量阈值、中性色高亮与稳定 hover 布局（[#155](https://github.com/poco-ai/Agentero/issues/155)）
- [x] Agent `AskUserQuestion` 工具调用转为可提交的选项回答（[#203](https://github.com/poco-ai/Agentero/issues/203)）
- [x] 快捷安装 Agent CLI（静默 `agent_run_tool_lifecycle`，[#225](https://github.com/poco-ai/Agentero/issues/225)）；已移除本机终端确认安装
- [ ] 关键词/描述 → Agent 候选列表确认后入库
- [x] 魔棒解析 GitHub / `npx skills` → Skill 装入 `.agents/skills/`（[#118](https://github.com/poco-ai/Agentero/issues/118)，见 [../backend/skill-import.md](../backend/skill-import.md)；首版）
- [x] 论文导入资源阶段增加整篇 3 分钟超时，覆盖魔棒 / Connector / Bib-RIS（[#161](https://github.com/poco-ai/Agentero/issues/161)）
- [ ] 本机 Translator sidecar 捆绑（可选）
- [ ] 前端 `afterPaperImport` 策略表统一各入口后置
- [ ] Zotero 迁移走 `paper_commit`；remote 镜像层收敛；统一 `paper:imported` 事件
- [x] workflow prompt 自动注入 Vault 内 `AGENTS.md`（Host `build_prompt` 已将 `AGENTS.md` 作为 progressive disclosure 系统上下文注入）
- [ ] 最近 Vault / UI 偏好与 XDG settings 完全对齐
- [ ] 设置「打开/导出日志文件夹」
- [ ] `catalog:export_papers_md`（Markdown 表）
- [x] CLI + 设置：聚合 Doctor 与论文 `NOTES.md` aliases 安全修复（[#198](https://github.com/poco-ai/Agentero/issues/198)）
- [ ] CLI：`graph` / shell completions（只读 `wiki check` 与 Doctor 已实现）
- [ ] CLI：`export papers-md`（随 Host 导出）
- [x] 桌面安装包内置同版本 `agentero` CLI；`agentero open <PATH>` / `agentero <PATH>` 打开本地 Vault；设置内安装 PATH shim（[#165](https://github.com/poco-ai/Agentero/issues/165)，设计：[bundled-cli.md](bundled-cli.md)）
- [x] CLI `paper move`：目标目录自动创建、Catalog 同步、冲突与越界集成测试（[#166](https://github.com/poco-ai/Agentero/issues/166)，设计：[bundled-cli.md](bundled-cli.md)）
- [x] CLI：侧栏版面索引 `layout list|get` + `mark add --region`（figure/table/algorithm/formula；`source/layout-index.json`）（[#170](https://github.com/poco-ai/Agentero/issues/170) 区域路径）
- [ ] CLI / Agent：正文句子高亮 / 翻译 mark（pending hydrate）+ Skill 全量（[#170](https://github.com/poco-ai/Agentero/issues/170)，设计：[mark-cli-roadmap.md](mark-cli-roadmap.md)、[mark-locate-lazy.md](mark-locate-lazy.md)、[mark-locate-eager.md](mark-locate-eager.md)）
- [ ] 官方 `Zotero.dotm` → Agentero provider：先做 macOS `:23119` HTTP + Word Automation Go/No-Go，通过后交付 Catalog/CSL/Refresh 闭环；Windows `WM_COPYDATA` + OLE 后置。需完成 AGPL/GPL 与商标审核，不能与 Zotero Desktop 并行（[#167](https://github.com/poco-ai/Agentero/issues/167)，设计：[zotero-word-integration.md](zotero-word-integration.md)）

## 0.4 — Vault 采纳与导入加深

- [x] Zotero 双向同步（映射层）：拉取元数据/笔记/批注 + NOTES.md 标记块推送回 Zotero（离线直写 + 备份 + 事务；`zotero_sync`，见 [../backend/identifier-lookup.md](../backend/identifier-lookup.md) §17）
- [ ] Vault 采纳：`vault_inspect` + 安全补脚手架/catalog（不覆盖用户文件）
- [ ] 确认后：散落 PDF → paper 单元 + catalog
- [ ] catalog ↔ 磁盘漂移报告与可选清理
- [ ] Skill `vault-organize`；CLI `vault inspect|adopt`
- [ ] 从 PDF 识别 DOI/arXiv + 元数据确认增强
- [ ] MinerU BYOK 云端解析（可选）

## 0.5 — 广场 Plaza

设计稿：[`plaza.md`](plaza.md)

- [ ] 侧栏虚拟 `agentero:plaza` + Cool Papers WebView / 推荐 v0 / 播客占位
- [ ] 从发现流解析 URL → 魔棒入库（可后置）

## 0.6 — 引用关系

设计稿与实现：[../backend/citation-parsing.md](../backend/citation-parsing.md)

- [x] 参考文献元数据解析 M1：S2/Crossref 在线 + 本地 bib/bbl → `agentero-cite.json` sidecar + 库内匹配 + `citationOnlineEnabled` 开关（Host `features/refs/`）
- [x] 引用侧栏 References 卡片（右侧栏 tab：编号/标题/作者·年份·venue/DOI·arXiv 徽标/已入库打开/未入库导入/过滤/重解析）
- [x] PDF 文中 citation 交互：Link annotation 覆盖层（点击 GoTo 跳页 / URI 外链）+ hover 引用元数据预览 → References 卡片高亮滚动（`citation-links.tsx` / `pdf-citation-preview.tsx` / `citation-hover-store.ts`）
- [x] PDF 视觉批注 → Agent 会话：工具栏框选裁图 + 批注草稿累加 → 统一多模态发送 → `agent-trace` 页边针回跳 session / answerSnapshot（[#134](https://github.com/poco-ai/Agentero/issues/134)）
- [ ] 反向联动：hover 引用卡片 → PDF 文中 anchor 高亮（需 anchors bbox）
- [ ] 本地 PDF citation/figure sidecar + Paper Content 侧栏
- [ ] Agent `#` 编号提及 + 引用卡片拖拽（citation-parsing M3/M5）
- [ ] cites/cited_by 缓存 + Connected Papers 式邻域 UI
- [ ] Agent：Explore citations / Map related work / Ingest neighborhood
- [ ] PDF 正文层检索；搜索历史/过滤；命令注册表 + MRU

## 0.7+ — 体验与平台

- [x] ChatGPT Web Voice 论文答辩 MVP：单账号内置登录、按需 Sidecar、WebRTC/DataChannel、当前材料注入、字幕、打断与 Vault 转写（[#237](https://github.com/poco-ai/Agentero/issues/237)，设计：[chatgpt-web-voice-defense-mvp.md](chatgpt-web-voice-defense-mvp.md)）
- [x] 修复语音答辩内部 bootstrap 被显示为“你”并写入转写：客户端追踪消息 ID，字幕层过滤内部回显（复盘：[bootstrap-caption.md](../bug_fix/voice-defense/bootstrap-caption.md)）
- [x] 修复 macOS WebKit 启动语音答辩时报 `Invalid SDP line`：Host 统一 answer SDP 为 CRLF、补终止 CRLF 并校验行格式（复盘：[invalid-sdp-line.md](../bug_fix/voice-defense/invalid-sdp-line.md)）
- [x] 修复 macOS 文件保存反复提示“不完整改名”：单边 FSEvents 只静默刷新，不再进入外部改名 Toast，可信 old/new 配对仍保持链接修复（复盘：[watcher-unpaired-rename-toast.md](../bug_fix/watcher-unpaired-rename-toast.md)）
- [x] ChatGPT Web Voice 单用户内置迁移 Phase 1：按需原生 WebView 登录、仅 `chatgpt.com` 同源会话捕获、系统凭证库存储、成功后销毁窗口
- [x] 删除 ChatGPT Web Voice 的旧 Gateway 设置产品面：设置区、连接测试和答辩弹窗“配置 Gateway”入口；开始答辩改为依赖账号连接状态
- [x] ChatGPT Web Voice 单用户内置迁移 Phase 2：无账号池/无管理后台/无数据库的按需 Rust Voice Sidecar，Host 通过 stdin 注入系统凭证，随机 loopback 端口与单次会话密钥
- [x] ChatGPT Web Voice 单用户内置迁移 Phase 3：内置 Sidecar 接管会话，删除底层 Gateway URL/API Key 字段、兼容命令与外部部署步骤
- [x] ChatGPT Web Voice token 失效恢复：上游 401 后删除系统凭证并通知前端重新连接
- [x] ChatGPT Web Voice macOS Phase 4 验收：最新打包版 UI、真实账号完整答辩、Sidecar 崩溃幂等回收、麦克风拒绝与断网处理
- [x] 多材料强制多 Agent 答辩入口：多文件/目录选择、文字要求、不可变快照；每次新答辩创建 preparation run，不提供直接绕过路径
- [x] 语音答辩 UI 精修：通话页以正计时时钟为中心（替换圆球，音量柱可视化）、字幕双行稳定展示、准备页卡片化布局与提纲展开式阅读、结束页统计卡；转写改为总结页手动保存，不再自动写入 Vault
- [x] 语音答辩 UI 二次重构：准备页改双栏工作台（左配置右提纲主阅读区，复用 shadcn/ui Card/Badge/Separator/Skeleton），字幕与提纲切换接入 motion 过渡动效，结束页 Card 化 + 渐次入场
- [x] 语音答辩准备页三次重构：弃用双栏（右栏空态每次会话必现，观感差），改单栏纵向流三状态（配置表单 → 摘要条 + 时间线 + Skeleton → 摘要条 + 提纲文档），时长在提纲态经下拉即改
- [x] 语音答辩定时模式：准备页选择 10/20/30/45 分钟或不限时（localStorage 记忆），通话页倒计时、尾段变色、到时 Toast 提醒并转为超时显示，不自动结束
- [x] 修复语音答辩语境漂移与字幕串台：bootstrap 三明治结构（规则置于材料后 recency 窗口）、显式回声消除采集约束、字幕流式槽抢占保护（复盘：[context-drift.md](../bug_fix/voice-defense/context-drift.md)）
- [x] 多 Agent 答辩准备提速：整理步骤改为本地确定性合成（`local-synthesis.ts`），删除第三次 ACP 调用，产物仍过同一 schema 校验，三阶段 UI 与恢复语义不变
- [x] 答辩间答后复盘：`debrief.ts` 本地确定性匹配（拉丁按词 / CJK 按字符 bigram 的 Dice 相似度）对照准备提纲与委员实际提问，总结页展示覆盖率与未问到清单，保存转写附带完整复盘章节（实际提问/用户回答/应答要点/证据双链）
- [x] 答辩间场景 preset 与时长注入：bootstrap 人设支持毕业答辩/组会预演/审稿质询/面试模拟（localStorage 记忆），计划时长注入 recency 窗口让委员控节奏收尾；命令面板新增「进入答辩间」（挂起式打开请求）；`[viva]` 本地漏斗日志与上游协议漂移告警
- [x] 答辩间通话页时钟改为特大号红色翻页时钟：vendored split-flap 组件（`src/components/ui/flip-clock.tsx`，em 缩放，正计时/倒计时/超时上翻/连接预览共用），取代原细体文本时钟与琥珀尾段配色；移除时钟上方音量柱，压迫感分级（计时常驻红色底晕 → 末分钟光晕增强 + 心跳 + 舞台四周红色渐晕 → 超时最强）；时钟下方只保留呼吸灯与状态字
- [x] 答辩间字幕双锚位重构：废除"上一句/最新句"单列交替（角色互相顶替、popLayout 位移与 text-balance 令流式字幕漂移），改为委员主槽 + 用户次槽双固定锚位（`CaptionSlot`：槽位定高、底部锚定向上溢出、顶部渐隐，token 追加零动画、仅消息更替时交叉淡入，非说话方降透明度），回答时委员问题保持可见
- [x] 修复语音答辩开场噪声字幕与委员重启答辩：委员首句字幕前到达的用户字幕整条丢弃（不上台不进转写）、开麦兜底 8s→15s、字幕剔除 U+FFFD 乱码、bootstrap 新增"答辩开始只宣布一次"规则；时钟红光晕与舞台渐晕同步降档（复盘：[opening-noise-captions.md](../bug_fix/voice-defense/opening-noise-captions.md)）
- [x] 压制答辩委员对注入 prompt 的确认回执（"明白了/收到"先应答再正式开场导致问题重复问两遍）：bootstrap 规则第 8 条禁止确认收到规则/材料与点评材料类型，收口指令强约束第一条回复必须直接以宣布开场语开头（复盘同上"后续"节）
- [x] 答辩间开场改为状态机门控：不再把 bootstrap 回执或 `speaking` 当成开场完成；麦克风与用户字幕要等到真正的第一问说完（listening/idle）才放开，填充回执不上台；20s 兜底不打断正在说的第一轮（复盘：[opening-ack-gate.md](../bug_fix/voice-defense/opening-ack-gate.md)）
- [x] 修复答辩委员把「答辩开始」（无「现在」）误判成回执后再发「请开始答辩」、导致连宣两次开场：开场检测与重启抑制共用宣布句式；已上台的重复开场字幕会撤回（复盘：[opening-ack-gate.md](../bug_fix/voice-defense/opening-ack-gate.md)）
- [x] 修复开场门控打开后噪声 ASR 被当成假回答、委员以「我问第一个问题」重问：丢弃口癖字幕、尚未正经作答时打断重问、开麦延迟 400ms，并增加 `[viva] wire` DataChannel 抓包（复盘：[opening-ack-gate.md](../bug_fix/voice-defense/opening-ack-gate.md)）
- [x] 开场宣布前保持委员远端静音：无「答辩开始」的前奏提问不上台、截断音频，字幕出现宣布后再放声（复盘同上）
- [x] 重写答辩间 bootstrap 会话规则提升提问质量：问题必须点名材料中的章节/公式/结论/例题（内容锚定）、先基础后加深、随回答自适应（答得好升级难度追边界反例，答错先一句话点破再抓薄弱点）、禁评判材料类型/价值/"新意"（考察理解而非审查文档，材料自身有主张则要求辩护）、禁填充语开头，中英双语同步
- [x] 修复答辩总结页长字幕被两行省略，并把通话计时起点从连接前移到委员首次 `speaking`（可见字幕兜底），连接与信令耗时不再计入答辩时长
- [x] 修复开场 20 秒盲兜底泄露上一轮字幕、非规范首句和跨轮声画错配：超时保持 fail-closed 并打断后发送精确恢复指令，只在字幕从首字命中「答辩现在开始」时放声；计时进一步改为远端播放实际启用时起表（复盘：[opening-ack-gate.md](../bug_fix/voice-defense/opening-ack-gate.md)）
- [x] 修复答辩间就绪后点击「入场答辩」无反应：独立 viva 窗口跑过期 bundle；入场改为先连 Voice，确认改后台 force（复盘：[enter-button.md](../bug_fix/voice-defense/enter-button.md)）
- [x] 修复答辩间点击「入场答辩」仍停在准备页：同一拍切到连接中，确认与卡死 lease 不再挡切页（复盘第五轮：[enter-button.md](../bug_fix/voice-defense/enter-button.md)）
- [x] 修复答辩间切到「正在进入答辩间」后一直转圈：先跑 Voice 再后台确认提纲，45 秒无进展进错误页（复盘第六轮：[enter-button.md](../bug_fix/voice-defense/enter-button.md)）
- [x] 修复答辩间入场立刻进错误页：`VoiceStartGate` 把 `crypto.randomUUID` 拆成裸函数调用，WebKit 抛 Illegal invocation（复盘第七轮：[enter-button.md](../bug_fix/voice-defense/enter-button.md)）
- [x] 修复生产包无法断开 ChatGPT：Keychain 条目由另一构建写入时 `SecItemDelete` 报 `errSecInvalidOwnerEdit`，回退系统 `security` 删除（复盘：[chatgpt-disconnect-owner.md](../bug_fix/voice-defense/chatgpt-disconnect-owner.md)）
- [x] 修复答辩间声音和字幕不同步：恢复指令后立刻放声，舞台委员字幕按语速揭示，转写仍保存全文（复盘：[caption-av-sync.md](../bug_fix/voice-defense/caption-av-sync.md)）
- [x] 修复答辩间有声音没字幕：恢复轮放声后开场门控仍把委员字幕当填充丢掉；能听见的一轮改为立刻上台（复盘：[caption-av-sync.md](../bug_fix/voice-defense/caption-av-sync.md)）
- [x] 修复答辩间恢复轮叠说与有声无字：恢复先打断并保持静音，直到新一轮 speaking 或新 caption id 才放声；旧 preamble id 不再锁定开场；`markIdle` 保留未消费的 speaking 起点（复盘第十轮：[caption-av-sync.md](../bug_fix/voice-defense/caption-av-sync.md)）
- [x] 修复答辩间把「好,答辩现在开始」当成长前奏：句首「好」与「好的」一样剥离；20 秒超时不打断未说完的宣布前缀（复盘第十一轮：[caption-av-sync.md](../bug_fix/voice-defense/caption-av-sync.md)）
- [x] 修复第一问之后又说「答辩开始」：门开后不再强制放声，重复开场从首个口癖 token 起关音轨；开麦等第一问字幕停更（复盘第十二轮：[caption-av-sync.md](../bug_fix/voice-defense/caption-av-sync.md)）
- [x] 修复正常问题被拆成新字幕 id 后有声无字：短文本不再一律按重复开场扣留，「为什么」等问题前缀立即上台（复盘第十三轮：[caption-av-sync.md](../bug_fix/voice-defense/caption-av-sync.md)）
- [x] 修复疑似拦截制造二次提问与无声无字：口癖开头的后续轮次不再关音轨/打断/扣字幕，仅完整宣布句（全场生效）或作答前显式重问才干预；字幕携带首包时间，pacer 锚点回溯消除门控放行后的音前字后（复盘第十四轮：[caption-av-sync.md](../bug_fix/voice-defense/caption-av-sync.md)）
- [x] 修复答辩字幕乱序快照回退与 DataChannel 重复 patch：委员/用户分流、未知显式 ID 丢弃、重复 append 去重，跨轮 pacer 不继承旧 idle 标记（复盘：[context-drift.md](../bug_fix/voice-defense/context-drift.md)、[caption-av-sync.md](../bug_fix/voice-defense/caption-av-sync.md)）
- [x] 答辩间配置态去掉论文名大标题和三位委员轨道：总体入口尚未选定材料，生成中才显示标题与轨道
- [x] 修复答辩总结页底栏「打开转写」与「正在生成评价」叠层：评价中改为状态字，胶囊关闭按下缩放并允许换行（复盘：[ended-footer-overlap.md](../bug_fix/voice-defense/ended-footer-overlap.md)）
- [x] 修复答辩总结页保存转写后底栏没有关闭：保留带文案的「关闭」，不只靠标题栏叉号（复盘：[ended-missing-close.md](../bug_fix/voice-defense/ended-missing-close.md)）
- [x] 答辩间改为独立原生单例窗口（`viva`），不再全屏覆盖主工作台；通话中关窗先进入总结页
- [x] 答辩准备页实时思考背景墙：`lib/voice-defense/thought-stream.ts` 按子会话把 `agent:stream` thought 与 `agent:tool` 事件路由到两位委员的滚动行缓冲（节流、封顶、仅内存，快照工作区绝对路径清洗回 Vault 相对路径），`thought-backdrop.tsx` 以双列文字墙渲染在 hero 背后（透明度按行新旧递退、最新行为思考前沿，浅色主题可读；中心径向遮罩留白、静默变暗、reduced-motion 降级），让"模型真的在工作"可被看见且不落盘
- [x] 答辩间产品缺口：材料指纹未变时可确认复用上次提纲；转写 YAML frontmatter 与准备页历史场次；会后隐藏 ACP 评价（不阻塞结束）；答辩语言/难度、会中补资料与拉回主题、委员已问轮次
- [ ] ChatGPT Web Voice 跨平台 smoke test：Windows/Linux 实机登录、系统凭证库、WebRTC 通话与安装包
- [ ] 答辩间备用实时后端：OpenAI Realtime API（BYOK 可选项，不作默认），摆脱对 ChatGPT 网页私有协议与 UA 伪装的单点依赖；协议适配层已具备防腐结构（`protocol.ts`）
- [x] 答辩间编排层重构：`voice-defense-dialog.tsx` 抽 `useVoiceDefense`（对齐 `use-agent-panel` 单编排 hook，不拆成互相抢 lease 的两个 hook），偏好/恢复/`VoiceStartGate` 纯模块补单测；`client.ts` 开场门控仍与协议私有字段耦合，留待备用实时后端时再拆
- [ ] 多 Agent 答辩准备 Phase 3 真实质量评估：固定论文集对比单 Agent artifact 与多 Agent brief 的覆盖率、证据准确率、无依据结论、编辑比例和耗时；据结果决定保留协同、退回单 Agent 或增加证据核查节点（本地评分/汇总工具已实现；设计：[multi-agent-voice-defense-preparation.md](multi-agent-voice-defense-preparation.md) · [评估方法](voice-defense-quality-evaluation.md)）
- [x] 修复 PDF 版面解析把 WebView 压崩后无限重跑的崩溃循环：`localStorage` 崩溃守卫，两次中途崩溃后暂停自动解析，手动重试重置（复盘：[pdf-layout-webview-crash-loop.md](../bug_fix/pdf-layout-webview-crash-loop.md)）
- [x] 版面解析移出主 `WebContent` 进程：隐藏 `layout-worker` 窗口独立进程跑 PDFium/ONNX（事件协议 + 无进度看门狗，浏览器环境回退本进程），大 PDF 解析 OOM 不再拖垮主窗口
- [ ] Graph 全屏/聚焦、邻居高亮、节点搜索；边级增量索引
- [ ] tab pin、命名工作区会话
- [ ] PDF 无文本层降级；HTML 标注统一模型
- [ ] 翻译：更多 adapter / 消费方 / 词典
- [ ] 更多 Skills（多篇对比、Idea 评估、实验复现清单等）
- [ ] 自动 changelog；多 arch artifact 命名
- [x] iOS/iPad 纯远程客户端 M2：Bridge + 二维码/链接配对 + relay E2EE + Library/阅读/NOTES + 远程 Agent（见 [移动端前端与远程架构](../frontend/mobile.md)）
- [ ] iOS/iPad M3：TestFlight 内测推进、多主机切换、iPad 双栏、wiki backlinks、离线体验打磨（M2 已提交 TestFlight）
- [ ] Git 集成 / 可选云同步
- [ ] 引用图 deeper（聚类、作者机构图）
- [ ] CLI domain 抽离独立 crate（仅当边界成为问题时）
