# Agentero TODO

可执行 backlog（GitHub Flavored Markdown checklist：`- [x]` 已完成 / `- [ ]` 未完成）。版本级状态与验收以 [`roadmap.md`](roadmap.md) 为准；魔棒设计见 [`../backend/identifier-lookup.md`](../backend/identifier-lookup.md)；Zotero Connector 兼容见 [`../backend/connector.md`](../backend/connector.md)；多入口入库统一见 [`../backend/paper-import-pipeline.md`](../backend/paper-import-pipeline.md)。

## P0 — 近期闭环

### 1. Create Vault 初始化

- [x] **Create Vault 初始化**（整项）
- [x] 创建标准目录：`papers/`、`notes/`、`plans/`、`.agentero/`、`.agents/`、`.agents/skills/`
- [x] 生成 Vault 内 `AGENTS.md` 模板；种子 `.agents/README.md`（`templates/vault/.agents/`）
- [x] 初始化 `.agentero/catalog.sqlite`（schema 当前版本，`path` 主键）
- [x] **不**默认生成 `PAPERS.md` / `library.bib`（导出能力另做）
- [x] 初始化后打开 `AGENTS.md`

### 1b. 多窗口与欢迎页

- [x] **多窗口与欢迎页**（整项）
- [x] `⌘N` / File → New Window → Host `window_new`（`?fresh=1`）
- [x] 无 Vault 欢迎页：最近路径 MRU + 打开 / 创建 / **从 Zotero 迁移**（同一行；迁移前先创建 Vault；无常驻说明文案）
- [x] 当前窗口 Vault 用 `sessionStorage`；最近列表 / 上次路径用 `localStorage`
- [x] **应用设置**迁出 `localStorage` → XDG `$XDG_CONFIG_HOME/agentero/settings.json`（`settings_get` / `settings_set`；旧键一次性迁移）

### 2. 精确标识符入库（arXiv / DOI 等）— 魔棒路径

- [x] **精确标识符入库（魔棒路径）**（整项核心）
- [x] 支持输入 arXiv ID / URL 等（侧栏魔棒）
- [x] Translator → `PaperMetadata` → catalog `papers` 表
- [x] 写入默认 `NOTES.md` 壳（标注用 `marks/`）
- [x] **始终下载 PDF**；**arXiv 解压 e-print LaTeX** 到 `source/`
- [x] 入库后刷新文件树并打开 paper；**左侧树展开祖先并滚到新论文行**（`openPaper` → `setTreeSelectedPath` + FileTree reveal）
- [x] 入库后刷新 Backlinks/Graph 索引
- [ ] 关键词/描述 Agent 候选列表确认

### 2b. 魔棒 / Identifier Lookup（Translator）v0

- [x] **魔棒 / Identifier Lookup（Translator）v0**（整项）
- [x] UI：侧栏魔棒 → 粘贴链接或编号 → 加入 Papers
- [x] 目标：`papers/` 或文件树当前选中的 Papers 子文件夹
- [x] Host：`lookup_import` / `lookup_translator_config` / `paper_download_assets` / `paper_parse_body`
- [x] 设置：`translatorBaseUrl`（默认 `https://translator.philfan.cn`）；**无**「是否本地下载」开关
- [x] 文件树：paper 行缺 PDF，或既无 TeX 也无 `PAPER.md` → Download（hover 原因）
- [x] 无 TeX + 有 PDF：下载后 liteparse 生成 `PAPER.md`（Download 路径内）
- [x] 精读：设置 `autoPaperReader`（默认关）+ 魔棒/单篇 Download 自动；资源齐全且未读时 Zap 可手动 → `is_read`
- [x] Library 行：库内任一篇仍缺资源 → 批量 Download
- [x] 快捷键 `⇧⌘I`（打开魔棒）
- [ ] 本机 Translator sidecar 捆绑

### 2c. 论文库表格 UI

- [x] **论文库表格 UI**（整项）
- [x] 虚拟节点 `agentero:library`；中间栏 catalog 表（`paper_list`）
- [x] 表头排序；横向/纵向滚动
- [x] 仅具体论文时显示 Paper Info / Notes（Library 隐藏）
- [x] Library 行批量补资源（与 2b 联动）
- [x] **Tags**：Paper Info 增删 → `paper_set_tags`；Library 列展示 + chip 筛选
- [x] **Tags CLI**：`paper tag list|set|add|rm` / `list --tag`（与 Host 共用 `papers::set_tags`）
- [x] **Tags 颜色**：Apple 风格 8 色 id；`tags_json` 字符串或 `{name,color}`；Paper Info 色盘；Library 染色 chip（`src/lib/tag-colors.ts`）

### 2c-2. 论文库默认页 + 文件夹作用域库

- [x] **论文库默认页 + 文件夹作用域库**（整项）
- [x] **默认页**：有 Vault 时默认全库；关空 tab → `ensureFullLibraryTab()`；仅剩全库且无弹层时 `⌘W`/X 关窗
- [x] **文件夹作用域**：非 paper 目录 → 展开树 + **同一** Library tab 上 `libraryScopePath` 前缀过滤（**不**为文件夹开新 tab）
- [x] 单测 + latency：`test/library-scope.test.ts`

### 2d. 文件树与侧栏 UX

- [x] **文件树与侧栏 UX**（整项）
- [x] **回收站虚拟节点**：Library 下方 `agentero:trash`（不在侧栏 Header）；`RecycleBinView` 自持 `PaneHeader`（与侧栏同高）；中间栏不重复 title/关闭行
- [x] **选中同步 / 定位**：激活文档与入库完成后树展开祖先并 `scrollToIndex`
- [x] 在 Finder 中显示：右键 / `⌥⌘R`（`revealItemInDir`；无双击）
- [x] 在终端中打开：右键 / `⌥⌘T`（文件夹 = 自身；文件 = 父目录；Host `path_open_in_terminal`）
- [x] **回收站删除**：右键 / `⌘⌫` / 批量 → `path_trash`（无确认、无 Undo toast）；文件树虚拟节点 `agentero:trash` → 中间栏 `RecycleBinView` 恢复 / 永久删除 / 清空
- [x] 多选（⌘/Shift 行高亮）+ 拖拽移动到 `papers/` 组织夹 + 批量移动对话框
- [x] 左右侧栏 collapsible 常驻 + `preserve-pixel-size`（交替 `⌥⌘S` / `⌘L` 不重叠）
- [x] 后台任务条（下载 / 入库 / 导入导出 / paper-reader；hover 实色不透明）
- [x] 精读触发图标 **Zap**（非 Eye）；tooltip 单行
- [x] **Paper 行标签预设**：默认标题 · 作者；设置 → 通用 `paperTreeLabelMode`（标题 / 作者(年)·标题 / 文件夹名）；展示用、不改磁盘名（`formatPaperTreeLabel`）
- [x] **文件树论文排序预设**：默认文件夹名 A–Z；设置 → 通用 `paperTreeSortMode`（标题 / 作者 / 年份新→旧 / 年份旧→新 / 添加时间新→旧）；展示用、不移动磁盘（`sortFileTreeNodes`）

### 2e. PDF 阅读增强

- [x] **PDF 阅读增强**（整项）
- [x] 缩放：+/- / 适应宽度 / **适应整页**；`⌘/Ctrl`+滚轮（0.5×–3×，100%=适应栏宽）；真实 scale 重渲染 + 放大后双向平移
- [x] 页码导航：底部 pill + 跳转输入；`PageDown/PageUp` / `Home/End`
- [x] 大纲（书签）左侧浮层；文档内查找 `⌘/Ctrl+F` + 命中高亮（`pdf-find.ts`）
- [x] 平滑划词覆盖层（Zotero 风格；隐藏原生 `::selection` 行间缝隙）
- [x] 划词操作菜单 MVP：高亮 / 批注 / 提问 / 翻译（见 P2「PDF 划词提问」）
- [x] 本地 PDF 直接预览（优先本地 → 无本地时 `paper_download_assets` → 失败再远程 `pdf_url`）

### 2f. Markdown 内嵌图片

- [x] **Markdown 内嵌图片**（整项）
- [x] 粘贴 / 工具栏插入 → `{mdDir}/assets/` + `![](./assets/…)`（`src/lib/markdown-image.ts`）
- [x] 选中图片节点显示 Markdown 源码；未选中 `blob:` 预览
- [x] 删除节点且引用计数归零时 GC managed assets 文件并刷新文件树
- [x] 单测 + 文档（data-model / ui / technical-plan / test 冒烟表）

### 2g. Library Rescan

- [x] **Library Rescan**（整项）
- [x] Host `paper_rescan`：扫 `papers/` + `metadata.json` 补齐 catalog（盘上有、库内无）
- [x] Library 空态 / 工具栏 Rescan 入口 + i18n

### 3. Agent 工作流入口

- [x] **paper-reader 精读**：设置 `autoPaperReader`（默认关）开启时入库/单篇 Download 自动；文件树 Zap 手动（资源齐全 + `is_read=false`）→ skill → `NOTES.md` → `paper_set_is_read`；左下角任务进度；**`hideFromChatHistory`**
- [x] skill 运行时语法按 Agent 模板分流（Host `SkillMentionStyle`）
- [x] **全局权限模式**：设置 → Agent（`restricted` / `ask` / `auto`），替代 per-provider YOLO
- [x] 在 Agent 面板增加“Summarize paper / Ask library / Draft Related Work”（建议按钮接通后端 `summary`/`qa`/`related_work` workflow）
- [ ] workflow prompt 自动注入 Vault 内 `AGENTS.md`
- [x] 输出必须包含 Sources（workflow prompt 已要求 `## Sources`）
- [x] 写后审阅：`agent:notes-review` → **统一 Diff**（`NotesReviewDiff`）Keep / Revert（BYOA 写盘后对照；写前草稿拦截仍待）
- [x] 权限「每次询问」档（`agentPermissionMode: ask` → `agent:permission-request` 对话框 + `agent_respond_permission`）

### 4. 文件与索引同步

- [ ] 将最近 Vault、UI 偏好迁到 Tauri Store
- [x] 文件监听（`notify` → `vault:file-changed`）：外部编辑器 / Agent 修改后自动重载当前打开的 `.md`/`NOTES.md` 与文件树；有未存改动时提示重载（不静默覆盖）
- [x] 文件变更后防抖重建 wiki 双链 / Backlinks / Graph 索引（`scheduleWikiRebuild`，仅 `.md`，~900ms 防抖）
- [x] 保存冲突检测：写盘前比对上次落盘内容，被外部修改则中止写入 + `notifyWarning`（`diskConflict.saveBlocked`），不静默覆盖本地未存改动

### 4b. Vault 采纳 / 现有文件夹发现（编程优先）

- [ ] **Vault 采纳 / 现有文件夹发现**（整项）
- [ ] 场景：用户 **打开已有文件夹**（非 Create Vault），自动 **发现** 是否已是 Agentero Vault、缺什么、盘上有哪些 paper/PDF 候选
- [ ] 设计：`docs/development/vault-adopt.md`（发现报告 JSON、安全级/确认级动作、与 `vault_create` 边界）
- [ ] Host：`vault_inspect`（只读报告）——结构、catalog、paper 单元、散落 PDF、与 catalog 漂移
- [ ] Host：安全自动整理——缺 `papers|notes|plans|.agentero` 则补空目录；`ensure_catalog` + schema migrate；缺失则种子 `AGENTS.md` / bundled skills（**不覆盖**）
- [ ] 打开文件夹 UX：就绪则静默；半结构/未知则横幅或对话框「可整理」，进度进后台任务条
- [ ] 幂等：已就绪 Vault 重复打开不反复打扰
- [ ] 路径：**以编程为主**；不确定命名/归类留给 P1 skill 或确认面板

### 5. CLI（headless Vault 接口）— MVP

设计见 [`cli.md`](cli.md)。

- [x] **CLI MVP**（整项）
- [x] 边界：**无 BYOA / 无 Agent / 无 paper-reader**；只做 Vault 管理、发现、暴露 + 文献基础能力
- [x] 布局：仓库根 **`cli/`**（package `agentero-cli`，bin `agentero`）；根 Cargo workspace `members = ["src-tauri", "cli"]`
- [x] 复用：**不迁 core**；path 依赖 `agentero_lib`，调用 `services::{vault,catalog,lookup,pdf_parse,wiki}`；禁止 `use …::agent`
- [x] Workspace + scaffold `cli/`（clap、`--vault` / env / 上溯、`--json`、退出码）
- [x] `vault create|which|info|check|use`（对齐 `vault_create` / catalog 初始化）
- [x] `tree`；`paper list|get|paths|delete|set-read|tag list|set|add|rm|download|parse`（`get`：`assets` + `suggestedReads`；`list --tag` AND）
- [x] `import id|bib`、`export bib`（对齐 Host；**不**自动精读）
- [x] 稳定 `error.code`；集成测试（临时 Vault + `--json` 契约，`cli/tests/cli_mvp.rs`）
- [x] 按需放宽 service `pub`（`lib.rs` 导出 `services` / `error`；`list_by_id`）
- [x] README / 本仓库开发说明：`cargo build -p agentero-cli`
- [x] Vault skill 模板：`templates/vault/.agents/skills/agentero-cli/SKILL.md`；Create Vault 种子；README Quick Start 已写协议
- [x] 预制 skills 扩展：`idea-evaluator` + `deep-research`（vendored [Supervisor-Skills](https://github.com/HKUSTDial/Supervisor-Skills)，CC BY-NC-SA 4.0；`skills/README.md` + LICENSE 说明）

### 6. 运行日志（Logging）— P0

设计见 [`logging.md`](logging.md)。

- [x] **运行日志 P0**（整项）
- [x] 分层：log（诊断）≠ `ApiResult` / CLI envelope ≠ `notifyError` / 任务条 / Agent error 行
- [x] 栈：`tauri-plugin-log` + `log` + `@tauri-apps/plugin-log`；CLI `env_logger` / `RUST_LOG`；默认无远程遥测
- [x] Host：插件注册、capabilities `log:default`、dev/release level 与 LogDir
- [x] 前端：`src/lib/logger.ts` + `logOp`；ErrorBoundary 打 error
- [x] **关键操作成对** `op start` / `op end`（`ok`、`duration_ms`）；`runBackgroundTask` 横切自动埋点
- [x] Host 写/长耗时 command（vault、lookup、agent_run、trash、zotero、parse…）与 CLI 每命令 op 对
- [x] 隐私：不写 Vault；不记 NOTES/PDF/prompt 全文（仅 path/id/len）
- [ ] P1：设置「打开/导出日志文件夹」

## P1 — 中期增强

### 1. Catalog 导出与检索

- [x] Library UI：Translator `/export` BibTeX + `/import` Bib/RIS（`paper_export` / `paper_import`）
- [ ] `catalog:export_papers_md`（Markdown 表）等其它形态
- [x] **全库搜索 + 快速打开**：命令面板 `⌘K`/`⌘P`（论文 quick-open + `vault_search` walk 全文；`SearchHit` 带片段/行号）；FTS5 可后续替换
- [ ] Agent 工作流临时导出 L1 列表；PDF 正文层检索；搜索历史 / 过滤

### 2. 本地 PDF importer

- [x] 文件选择 / 批量导入（魔棒弹层 `FileUp` → `paper_import_local_pdf`，多选）
- [x] 窗口拖入文件：非 PDF 无反应（仅防导航）；PDF 拖到 `papers/` 组织夹 → metadata 确认对话框 → `paper_import_local_pdf`（可改 title/authors/year/id/目标路径）
- [ ] DOI / arXiv ID 识别，元数据确认面板
- [x] 生成 citekey slug（重复 `-2`/`-3`）、liteparse `PAPER.md`、`NOTES.md`；metadata 写入 catalog（type `pdf`）
- [ ] 默认本地解析，MinerU BYOK 后可选云端解析
- [x] 与 **Vault 采纳** 边界约定：importer = 用户显式导入源；采纳 = 整夹扫描改造

### 2b. Vault 采纳 / 整理（确认迁移 + Skill 可选）— 接 P0-4b

- [ ] 确认后改造：散落 PDF → `papers/<id|citekey>/` + NOTES 壳 + catalog upsert（复用 lookup/import 写盘纪律）
- [ ] catalog ↔ 磁盘漂移修复（有盘无行 / 有行无盘的报告与可选清理索引）
- [x] 历史 `metadata.json` → catalog 导入（`paper_rescan` / `rebuild_from_disk`；论文库空态「重新扫描」重建行）
- [ ] **Skill 路径**：模板 `vault-organize`（或同名）——读 inspect 报告、提议移动/命名、经用户确认后落盘；触发 `$vault-organize` / `/vault-organize`
- [ ] **组合**：编程产报告与执行机械步骤；Agent 只处理模糊归类；无 Agent 时确认面板仍可用
- [ ] CLI（若 MVP 已有）：`vault inspect|adopt` 对齐 Host（命名实现时定）
- [ ] 纪律：dry-run / 计划清单；禁止静默覆盖 NOTES、禁止无确认大删

### 3. 双链与图谱增强

- [ ] 源码编辑 `[[` 补全
- [ ] Plate 内联 wikilink 节点，序列化仍保持 `[[...]]`
- [ ] Graph 增加全屏/聚焦模式、邻居高亮、节点搜索
- [ ] 双链边可写入 catalog 可重建表并支持增量重建

### 4. 工作区标签页与分屏（roadmap V0.6）

- [x] 中间栏文档 **标签栏**：paper / MD / PDF / HTML / 图片 / Library 以 tab 打开，可关闭、切换、拖拽重排
- [x] 每 tab 常驻挂载，保留滚动位置、PDF 缩放、视图模式；MD/NOTES 自动保存，关闭不丢内容
- [x] **默认页全库 + 文件夹作用域库**（2c-2）
- [ ] **分屏**：水平或垂直 2 格；每格独立内容（典型：PDF | NOTES，或两篇 paper 并排）
- [x] 快捷键：关 tab `⌘W`（有弹层先关顶层；仅剩全库时关窗；File → Close 同源）/ 切 tab `⌥⌘→·⌥⌘←`；分屏随 split 补
- [x] 文件树 / Library / Graph / Backlinks / wiki 跳转统一 `openTab`；同路径已开则聚焦
- [x] 与 `⌘N` 多窗口隔离：每窗口独立 tab 集（`agentero-open-tabs`）；关窗/换 Vault 可恢复布局
- [x] 全局操作错误 Toast（`notifyError`，右上角；替代侧栏 header 错误条）
- [x] 说明：Agent 面板内的 **会话标签** 已存在，与本项「文档标签」分开

### 5. 引用关系 / Connected Papers（roadmap V0.7）

- [ ] **P0：本地 PDF citation/figure analysis**：按 [`../backend/pdf-analysis.md`](../backend/pdf-analysis.md) 实现 Host `paper_analyze_pdf`、sidecar、TeX/PDF 双解析和 PNG 派生。
- [ ] **P0：Paper Content 侧栏**：展示 citations/figures，支持 PDF hover 高亮、reference/figure 跳转。
- [ ] **P0：Agent context**：Composer `@` 与拖拽支持 citation/figure structured refs；继续使用 path context chip，不使用二进制 Attachments。
- [ ] **文内引用 hover → 右侧 Paper Info**：PDF/HTML/`PAPER.md` 中识别 `[n]` / Author-year / DOI·arXiv 链接；hover 时侧栏展示目标论文 Info（库内 path / 远程缓存 metadata、入库或打开）
- [ ] **引用图数据**：cites / cited_by 可重建缓存（catalog 扩展表或 `.agentero/`）；外部 API 可插拔（Semantic Scholar / OpenAlex 等），失败可降级 TeX/参考文献解析
- [ ] **Connected Papers 式邻域 UI**：以当前 paper 为中心展示引用/被引列表 + 简易图；节点可打开 / 入库 / 进阅读队列
- [ ] 与 V0.4 **双链 Graph** 区分：双链 = `[[wikilinks]]`；本项 = bibliographic 引用边

### 6. Agent 引用与综述工作流（衔接 V0.3 面板入口 + V0.7）

- [ ] 面板 workflow：**Explore citations**（沿引用/被引解释相关性、建议精读顺序）
- [ ] 面板 workflow：**Map related work**（本地 NOTES + 引用图 → Related Work 骨架，含本地 path）
- [ ] 面板 workflow：**Ingest citation neighborhood**（确认后批量魔棒入库邻居）
- [ ] 与「Summarize / Ask library / Draft Related Work」共用 prompt 注入与草稿确认路径

### 7. CLI 增强（MVP 见 P0-5）

- [ ] `graph backlinks|export|rebuild`（复用 wiki service；CLI 自管索引生命周期）
- [ ] `doctor`（Translator / catalog schema / 路径；**不** probe Agent）
- [ ] shell completions（bash / zsh / fish）
- [ ] `export papers-md`（Host 落地 `catalog:export_papers_md` 后对齐）
- [x] Release 附带 `agentero` 二进制（独立 **cli** job，与 **installers** 并行上传同草稿；见 `release.yml`）

### 8. Release 完善

- [x] tag 构建已完成（`v*` → 三平台桌面安装包草稿 Release）
- [ ] 签名、公证、自动 changelog
- [ ] 同步 `package.json`、`src-tauri/tauri.conf.json` 和 tag 版本号
- [ ] Release artifact 命名规范化，区分 macOS arch / Windows / Linux

## 重构 — 工程质量（Google 级代码审查，`refactor` 分支）

面向 Tauri 最佳实践与可审查性的分阶段重构。已落地部分均通过 `cargo clippy -D warnings`、`cargo test`、`tsc`、`biome`、`vitest`。

### 安全加固（已完成）

- [x] 启用结构化 CSP（`tauri.conf.json`，含 `devCsp`；pdfium `wasm-unsafe-eval` + blob/https 白名单）
- [x] `fs:scope` 收窄至 `$HOME/.agentero/**`；Vault 目录运行时授权（`vault_authorize` / `vault_ensure`）+ `tauri-plugin-persisted-scope` 持久化
- [x] 引导安装命令白名单校验（包管理器 argv0 + shell 元字符黑名单，`services/terminal.rs`）+ 单测
- [x] `commands/paper.rs` 复用 `services::fs::normalize_rel` / `path_escapes_root`

### IPC 错误契约（已完成）

- [x] 结构化 `AppError` + `ErrorCode`（`{code,message}` 走 Tauri 原生 reject 通道）
- [x] 92 个 command 全部迁移为 `Result<T, AppError>`，删除 `ApiResult` 信封
- [x] 前端 `src/lib/ipc.ts`（`IpcError` + `ipc<T>()`）；~10 个 lib 模块去信封
- [x] CLI 错误映射改为 `match ErrorCode`（外部 JSON/exit code 契约不变）
- [x] `docs/backend/api.md` §2.1/§2.2 契约重写

### 异步 IO + god-file 拆分（已完成）

- [x] rusqlite 经 `services::catalog::blocking`（`spawn_blocking`）离开 async 运行时；`paper_*` 命令改 async
- [x] 移除 `connector` 启动的 `block_on`（std bind + `from_std`）
- [x] `acp.rs`（1596 行）→ `acp/{convert,config,permission,run,probe,sessions}`
- [x] `connector/state.rs`（918 行）→ `state` + `sessions`
- [x] `remote/session.rs` 的 ~870 行 env-gated 测试 → `session/tests.rs`
- [x] 清理 `#[allow(dead_code)]` 死代码

### 前端解耦（部分完成）

- [x] 抽纯逻辑到可测 lib：`agent-parts` / `agent-options`（agent-panel）、`settings-probe`（settings-window）+ 单测
- [x] `sidecar-store` 统一 pdf-highlight/ask/translate 的 IO 回退；`reveal` 复用 `getPlatformOS`
- [ ] 引入 zustand + 迁移 App.tsx 的 vault/tabs/UI 状态（消除 prop drilling / ref 镜像）
- [ ] god-component JSX 拆分：`App.tsx`、`agent-panel`、`settings-window`、`file-tree`、`pdf-viewer`
  - 备注：状态归属迁移与大组件拆分改动交互行为，需在浏览器中人工验证（当前 headless 环境无法驱动 UI），暂缓以避免不可验证的回归。

## P2 — 长期方向

### 1. Zotero/BibTeX 迁移工具

- [x] 一键从本地 Zotero 迁移：直读 `zotero.sqlite` + `storage/` → catalog，可选拷本地 PDF（`zotero_scan` / `zotero_migrate`；见 [`../backend/identifier-lookup.md`](../backend/identifier-lookup.md) §16）
- [ ] 解析 Zotero export / 独立 BibTeX 文件路径（Library 导入已覆盖 Bib/RIS 文本）
- [x] 按 Zotero collection 还原文件夹层级（可选；collection 名写入 tags）
- [x] 选择性导入指定 collection + 迁移前自愈 catalog 孤儿行（`prune_missing`）
- [x] 迁移 Zotero 笔记（子笔记 HTML→Markdown 追加进 NOTES.md；`htmd`）
- [x] 迁移 PDF 批注文本（高亮+评论→NOTES.md）+ 逐条选择/搜索 + 迁移进度 + 记住选项
- [x] 批注原位高亮渲染（`marks/` + 页边针 + 右侧批注面板）

### 1b. Zotero Connector 兼容服务（方案一）

设计见 [`../backend/connector.md`](../backend/connector.md) **§4.5 覆盖总表**。

- [x] C0：设计文档（本机 `23119`、互斥 Zotero 桌面、默认关、MVP endpoints、映射与分期）
- [x] C1：Host `services/connector` — `ping` / `saveItems` / `sessionProgress` + loopback 安全策略；复用 `map_zotero_item` 落盘
- [x] C2：设置开关 `connectorEnabled` + `connector_get_status` / `connector_set_enabled` / `set_vault`；端口冲突 / 无 Vault UX；i18n
- [x] C3：前端 `connector:item-saved` 刷新树/Library + **`openPaper` 打开论文 tab**；退出释放端口；`api.md` 命令表
- [x] C4a：catalog id 去重；URL 附件后台 `ensure_paper_assets`；防插件 15s 超时（NOTES 无实时 MT）
- [x] C4a2：`getSelectedCollection.targets` 列出 `papers/` 组织子文件夹；`updateSession` 移动 paper；`connector_set_parent_dir` + Library 作用域同步
- [x] C4b：`saveAttachment` 二进制上传协议（浏览器登录墙 PDF；`parentItemID`→paper；`%PDF` 校验；触发 PAPER.md）
- [x] C4c（P0）：`saveSnapshot` / `saveSingleFile`，写入 paper `snapshot.html`
- [x] C5a（P0）：`detailedCookies` 注入后台 PDF 下载（不持久化 Cookie）
- [x] C5b（P1）：`detect` / `savePage` / `selectItems`；`attachmentProgress`（安全降级）
- [x] C5c（可选）：`getTranslators` / proxies 降级；可配置端口；`updateSession.tags` 写入 catalog

### 2. 用户友好的 Skills / Workflows

- [x] 精读论文（paper-reader：文件树 Zap + catalog `is_read`）
- [ ] 多篇对比（可与分屏 + 引用邻域联动）
- [x] Related Work 草稿（面板入口 → `related_work` workflow；与 V0.7 Map related work 可合并增强）
- [ ] Explore citations / Ingest neighborhood（见 P1-6；完成后勾到此处）
- [ ] Idea 批判性评估
- [ ] 实验复现清单

### 3. PDF 划词提问（Selection Ask）

设计见 [`pdf-ask.md`](pdf-ask.md)。

- [x] M1：划词弹出迷你问答卡
- [x] M2：`papers/<id>/marks/<id>.json` 读写 + 页边针（归一化坐标）
- [x] M3：接入 ACP `agent_run_once` 流式多轮；结束会话落盘
- [x] M4：双击 / 悬停停留触发 + 防误触（阈值暂固定 700ms）
- [ ] M5（可选）：无文本层降级；本地 PDF TextLayer
- [x] M6：划词操作菜单（高亮 / 批注 / 提问 / 翻译）；统一落盘 `papers/<id>/marks/<id>.json` + 覆盖层 + 点击删除；翻译复用问答卡走 Agent；去掉默认琥珀高亮，仅原生选区
- [x] M7：Zotero 式批注 —「批注」= 建高亮 + 内联编辑器（`annotation-editor.tsx`）写可选 `comment`；页边针（`selection-gutter.tsx`）；右侧「批注」面板（`annotations-panel.tsx`）；落盘 `marks/`（`kind: highlight`）；**不写 `NOTES.md`**

### 3b. 翻译服务（Translate Service）

设计见 [`translate.md`](translate.md)（应用级能力，非仅划词）。

- [x] T0：设计文档（可插拔 `TranslateService`；首版 free + agent；设置 → 翻译页；消费方模型）
- [x] T1：`src/lib/translate/` 注册表 + `agent` adapter；设置页 **Translate**（`provider` / `targetLang` / 自动译 / freeBaseUrl）；PDF 划词接服务层
- [x] T2：Host `translate_text` + `free` adapter（内置 Google gtx 或 LibreTranslate URL）；默认 `provider=free`
- [x] T3：PDF free 单次结果 / agent 流式；`autoTranslateSelection`；与 `translatorBaseUrl` 命名隔离
- [x] T3.5 设计：翻译用 **Agent 座 + 模型** 最小选择（跟随默认 / 渐进披露；见 [`translate.md`](translate.md) §5.4 · §7.6）
- [x] T3.6：实现 `translate.agentId` / `modelId` + Translate 页两行 Select + PDF `runOnce` 传参
- [ ] T4+（可选）：更多 adapter（DeepL 等）/ 更多消费方（标题·摘要等）；`type: word` 词典

### 4. PDF / HTML 标注系统

- [ ] 参考 Hypothesis 风格的边注、评论、锚点（完整体系）
- [x] PDF 就地批注已落地（高亮 + `comment` + 页边针 + 右侧面板）；标注落 `marks/`（`kind: highlight`）
- [x] 标注正文落盘 `marks/*.json`（坐标归一化可重建）；导出 Markdown / `NOTES.md` 互导暂不做
- [ ] PDF.js / HTML iframe 统一标注模型（HTML iframe 标注仍待）
- [ ] 与划词提问（asks JSON）边界清晰，可互导

### 5. 更大范围导入

- [ ] DOI / 网页 importer 深化（魔棒已部分覆盖 DOI）
- [ ] 浏览器插件一键收集
- [ ] 远程 PDF 链接入库

### 6. 引用图增强

- [ ] prior / derivative 布局、相似度聚类、跨库联合图（更深 Connected Papers 体验）
- [ ] 作者、机构、会议关系图谱

### 7. 工作区增强

- [ ] 超过 2 格的网格分屏；tab 固定（pin）、按 paper 分组
- [ ] 命名工作区会话（保存/恢复一整套 tab + 分屏布局）

### 8. 多端与协作

- [ ] iPadOS 触控布局
- [ ] Git 版本管理集成
- [ ] 可选云同步与多设备阅读

### 9. CLI domain 抽离（可选）

- [ ] 仅当 CLI 体积 / 依赖边界成为问题时：从 `agentero_lib` 抽出无 Agent 的 `services` 到独立 crate
- [x] **当前不做**；默认保持 `cli/` → path → `agentero_lib`（已定为默认策略）

---

## 已完成能力速览（对照现状）

便于对照「还没做的新项」。细节与验收以 [`roadmap.md`](roadmap.md) 为准。

### Vault / 工作台壳

- [x] 打开·创建 Vault、catalog 初始化
- [x] 多窗口 ⌘N、欢迎页 MRU
- [x] 文件树新建/Finder/**回收站删除**（中间栏浏览恢复，无 Undo toast）
- [x] 多选拖拽、`notify` 文件监听
- [x] **保存冲突检测**（`diskConflict.saveBlocked`）
- [x] 左右侧栏 collapsible、后台任务条、**全局错误 Toast**
- [x] **统一运行日志**
- [ ] 最近 Vault 迁 Tauri Store
- [ ] **打开已有夹自动发现/整理**（P0-4b / P1-2b）
- [ ] 设置「打开/导出日志文件夹」

### 中间内容

- [x] **文档标签页**（常驻挂载；`⌘W` / `⌥⌘←→`）
- [x] Library 表 + **tags** + **Rescan** + **文件夹作用域**
- [x] PDF / HTML / 图片 / Markdown WYSIWYG（内嵌图 → `./assets/`）
- [x] Notes 仅具体论文时显示
- [ ] **分屏**（V0.6 余量）

### 查找

- [x] **快速打开 `⌘P`/`⌘K`**：论文 quick-open + `vault_search` 全文正文匹配（命中论文 → 打开论文）
- [x] **命令面板 `⇧⌘P`**：内置应用命令（设置 / 视图 / Vault / 标签…）；`>` 前缀可从快速打开切入
- [ ] 命令注册表抽离 + MRU；FTS5 索引、PDF 正文层检索、搜索历史 / 过滤

### 入库

- [x] 魔棒精确 ID/URL、Translator、默认 PDF+arXiv TeX、补下、无 TeX→PAPER.md
- [x] **本地 PDF 导入**、**非 arXiv 下载（浏览器 UA + Crossref 兜底）**
- [x] Library 导入导出 Bib、`paper_set_tags`、`paper_rescan`
- [x] **Zotero Connector MVP**（含 `saveAttachment`）+ **保存后 `openPaper`**
- [x] **入库流水线统一设计**（[`paper-import-pipeline.md`](../backend/paper-import-pipeline.md)）
- [ ] **P0** Host `paper_commit` + 魔棒 / Connector / 本地 PDF 迁入
- [ ] **P1** 前端 `afterPaperImport` 策略表
- [ ] **P2** Bib / CLI 走 commit；**P3** Zotero 迁移；**P4** `paper:imported` 事件
- [ ] 关键词/Agent 候选
- [ ] 本地 PDF 拖拽 / DOI 识别与元数据确认
- [ ] MinerU 云端解析
- [ ] Connector 快照/cookies

### Agent

- [x] BYOA ACP Client、Codex 原生 thread、Sources
- [x] **paper-reader**（Zap + 可选自动默认关；**不进对话历史**）
- [x] **权限三档**（受限 / 每次询问 / 自动批准）
- [x] **面板 workflow**（summary / qa / related_work）
- [x] **笔记写后审阅** Keep/Revert
- [x] 模型收藏、Skill 提及分流、**禅模式左侧历史栏**
- [ ] `AGENTS.md` 自动注入
- [ ] 写前草稿拦截
- [ ] **引用类 workflow**（V0.7）

### 双链 / Graph

- [x] `[[wikilink]]` 跳转、反链、缺失创建、Backlinks 下 Graph
- [x] **`.md` 变更防抖重建索引**
- [ ] `[[` 补全、Plate 内联节点、Graph 全屏/邻居高亮
- [ ] 边级增量索引

### 文献引用图

- [ ] **hover 引用→Info、Connected Papers 邻域、引用边缓存**（V0.7）

### PDF / 媒体

- [x] 任意路径预览；导航 / 适应宽·整页 / 大纲 / ⌘F
- [x] 真实 scale + 平滑划词；操作菜单（统一 `marks/*.json`）
- [x] 划词标注系统（`marks/`；CLI `marksDir`）
- [ ] M5：无文本层降级

### CLI

- [x] **MVP**（[`cli.md`](cli.md)：`cli/`、workspace、`paper tag list|set|add|rm`、无 BYOA）
- [x] Release 附带 `agentero` 二进制
- [ ] graph / doctor / completions（P1-7）

### 远程 Vault（SSH/SFTP）+ 远端 BYOA

设计见 [`remote-vault.md`](remote-vault.md)。**MVP 已完成**。

- [x] **M0** `VaultFs` / `LocalFs` + path 安全；单测（`services/fs/`）
- [x] **M1** SSH/SFTP + `__local_sim__`；`remote_*`；欢迎页；树 / md / mkdir / remove / bytes
- [x] **M2** catalog work mirror；list/get/delete/rescan/tags/is_read + PUT
- [x] **M3** ACP over SSH；skill materialize；notes-review；Codex-SSH 明确拒绝
- [x] PDF cache + 预览；最近远程 reopen；侧栏远程徽章；禁 Finder/终端
- [x] 切换 Vault 时 disconnect 远程会话
- [x] 侧栏「切换知识库」菜单：**打开远程…** + 最近远程 MRU（共用 `RemoteVaultDialog`）
- [x] `remote:<sessionId>` 不写入本地 recent / restore-last（避免同一远端目录多条伪路径）
- [x] i18n；[`api.md`](../backend/api.md) 远程 command 表
- [x] **M4** 远端 recycle bin（`.agentero/.trash/` via SFTP，与本地语义对齐）
- [x] **M4** 魔棒入库写远端（staging → SFTP → catalog PUT；见 `import_bridge`）
- [x] **M4** blob LRU（2 GiB/库）+ 设置页「清除远程缓存」
- [x] **M4** Zotero Connector 绑定远程会话（saveItems / saveAttachment / targets）
- [ ] **M4** Codex-SSH、更完整远程偏好

### 发布

- [x] tag → 三平台草稿 Release
- [ ] 签名/公证/changelog
- [ ] 可选 artifact 命名规范化
