# Agentero TODO

仅列**未完成**项。当前发布 **`0.5.0`**。版本切片见 [`roadmap.md`](roadmap.md)；已实现能力见 [`../frontend/`](../frontend/index.md) · [`../backend/`](../backend/index.md)。

## 0.3 — 入库与 Agent 补强

- [x] Markdown 目录：标题数量阈值、中性色高亮与稳定 hover 布局（[#155](https://github.com/poco-ai/Agentero/issues/155)）
- [x] Agent `AskUserQuestion` 工具调用转为可提交的选项回答（[#203](https://github.com/poco-ai/Agentero/issues/203)）
- [x] 快捷安装 Agent CLI（静默 `agent_run_tool_lifecycle`，[#225](https://github.com/poco-ai/Agentero/issues/225)）；已移除本机终端确认安装，并在 Agent 卡片内展示安装进度（[#250](https://github.com/poco-ai/Agentero/issues/250)）
- [x] Library 拖入 PDF 入库：仅 PDF overlay + 与文件树相同的确认框（[#309](https://github.com/poco-ai/Agentero/issues/309)）
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
- [x] `agentero open <PATH>` / `agentero <PATH>` 打开本地 Vault；设置内安装 PATH shim（[#165](https://github.com/poco-ai/Agentero/issues/165)，设计：[../backend/cli.md](../backend/cli.md)）
- [x] 桌面安装包不内嵌 CLI；About 从 GitHub Release 下载同版本 CLI（[#285](https://github.com/poco-ai/Agentero/issues/285)）
- [x] CLI `paper move`：目标目录自动创建、Catalog 同步、冲突与越界集成测试（[#166](https://github.com/poco-ai/Agentero/issues/166)，设计：[../backend/cli.md](../backend/cli.md)）
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
- [x] 引用图谱 MVP：`paper_refs_graph` + Graph 面板改用引用边（非双链）；邻近含 stub / 全图库内边（[#260](https://github.com/poco-ai/Agentero/issues/260)）
- [ ] cites/cited_by 持久缓存 + Connected Papers 式布局 / 多跳聚类
- [ ] Agent：Explore citations / Map related work / Ingest neighborhood
- [ ] PDF 正文层检索；搜索历史/过滤；命令注册表 + MRU

## 0.7+ — 体验与平台

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
