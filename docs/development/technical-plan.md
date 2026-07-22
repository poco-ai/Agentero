# Agentero / notemd 技术方案

> 本文档基于 `docs/development/prd.md`、`docs/frontend/ui.md`、`docs/development/roadmap.md` 与当前仓库现状编写，用于指导 MVP 及后续演进的技术选型与模块划分。

## 1. 技术定位与目标

- **本地优先（Local-first）**：Vault 以 Markdown + 源文件为事实来源，数据库/索引仅作为缓存。
- **跨平台但 Mac 优先**：MVP 以 macOS 桌面应用为主，技术栈保留向 iPadOS 扩展的能力。
- **Agent-first**：前端为人类提供审阅、编辑、导航界面；后端 Rust 宿主提供文件系统、网络、索引，并以 **ACP Client** 身份连接本机已有 Agent。
- **BYOA（Bring Your Own Agent）**：Agentero **不内置、不捆绑**任何 coding agent 二进制；所有 provider 使用本机 ACP-compatible CLI（OpenCode、Gemini CLI、Claude ACP 适配器、Codex ACP 适配器、自定义 command）。密钥与模型由各 Agent CLI 自行管理。
- **可迁移**：Vault 离开应用后仍能被 Obsidian、VS Code、Cursor 直接打开。

## 2. 整体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (Web)                          │
│  React 19 + TypeScript + Vite + Tailwind CSS + shadcn/ui    │
│  - 三栏工作台                                                │
│  - Markdown 编辑/预览                                        │
│  - PDF / HTML 阅读器                                         │
│  - 双链/反链/图谱                                            │
│  - Agent 面板（会话 / 权限确认 / 读取路径回显）               │
└───────────────────────────┬─────────────────────────────────┘
│                           │ Tauri invoke / event
┌───────────────────────────▼─────────────────────────────────┐
│           Host (Tauri 2 + Rust) = ACP Client                 │
│  - 文件系统操作（读写 Vault、文件树、文件监听）               │
│  - arXiv / HTTP 抓取                                         │
│  - Markdown / 双链 / 图谱索引                                 │
│  - Agent 注册表 / 发现 / 会话 / 权限 UX                       │
│  - 工作流 prompt 模板（总结 / 问答 / Related Work）           │
│  - 本地配置与最近 Vault 存储                                  │
└───────────────────────────┬─────────────────────────────────┘
│                           │ Provider runtime (JSON-RPC 2.0 over stdio)
┌───────────────────────────▼─────────────────────────────────┐
│     用户本机已安装的 Agent（BYOA，Agentero 不打包）               │
│  - ACP: OpenCode / Gemini CLI / Claude ACP / 自定义           │
│  - Native: Codex App Server                                   │
│  - cwd = 当前 Vault；密钥与模型由 Agent CLI 自行管理          │
└─────────────────────────────────────────────────────────────┘
```

> **协议说明**：此处 ACP 指编辑器 ↔ coding agent 的 [Agent Client Protocol](https://agentclientprotocol.com/)（stdio 上的 JSON-RPC 2.0），**不是** Linux Foundation 的 REST 风格 ACP。Agentero 始终作为 **Client**，Agent CLI 作为 **Server**。

### 2.1 为什么选 Tauri 2

- Rust 宿主能直接、安全地操作本地文件系统，符合本地优先定位。
- 前端使用成熟的 Web 技术栈，UI 开发效率高于纯原生。
- Tauri 2 支持 iOS/iPadOS 构建（`tauri ios`），与 MVP 的 Mac-first、后续 iPadOS 策略一致。
- 包体小、内存占用低，适合作为常驻研究工具。

### 2.2 前后端职责边界

| 能力 | Frontend | Host (Rust) |
|---|---|---|
| 文件树展示/交互 | `FileTree` + 可伸缩侧边栏；展开/选中/打开；Finder 显示；终端打开；删除 | `plugin-dialog` 选目录 + `plugin-fs` `readDir`/`readTextFile`/`writeTextFile`/`mkdir`/`remove`；`plugin-opener` `revealItemInDir`；Host `path_open_in_terminal`；`paper_delete` |
| Markdown 编辑 | Plate.js WYSIWYG 编辑器 | 持久化到磁盘 |
| 双链解析与高亮 | 正则 + AST 渲染 | 构建全局索引、反链查询 |
| 图谱 | `react-force-graph-2d`，嵌在 Backlinks 右侧栏下方 | `graph_get_graph` 输出 nodes/edges |
| PDF/HTML 阅读 | PDF viewer 渲染；内联 HTML 经 DOMPurify 消毒；引用/插图 overlay 与 Paper Content 侧栏 | 可插拔解析器提取文本、bbox、图片和本地文件路径/URL |
| 本地 PDF 导入 | 文件选择/拖拽/进度展示 | 归档原始 PDF、解析生成 PAPER.md、混合获取元数据 |
| arXiv 抓取 | 输入/进度展示 | HTTP 下载、LaTeX/HTML/PDF 获取 |
| Agent 调用 | 会话 UI、权限确认、读取路径回显 | ACP Client：spawn 用户配置的 agent、stdio JSON-RPC、会话与权限桥接、工作流 prompt |
| Agent 配置 | 注册表 UI、PATH 探测空状态、模板选择 | 持久化 command/args/env；探测可执行文件；不持有模型 API Key |
| 配置/最近 Vault | 读取与展示 | 使用 Tauri Store 持久化 |

## 3. 前端技术栈

### 3.1 基础框架

| 库/工具 | 版本/说明 | 用途 |
|---|---|---|
| React | ^19.1.0 | UI 组件与状态驱动 |
| TypeScript | ~5.8.3 | 类型安全 |
| Vite | ^7.0.4 | 构建与 HMR |
| Biome | 2.5.2 | Lint + Format（已配置） |

### 3.2 UI 与样式

| 库/工具 | 说明 | 用途 |
|---|---|---|
| Tailwind CSS v4 | 原子化 CSS + CSS variables | 布局、间距、响应式 |
| shadcn/ui | `components.json` → `radix-nova` | 通用控件（`src/components/ui/`） |
| **AI Elements** | [elements.ai-sdk.dev](https://elements.ai-sdk.dev/) | Chat / Prompt / Sources / **FileTree** 等；落盘 `src/components/ai-elements/` |
| streamdown + `@streamdown/*` | Markdown 流式渲染 | `MessageResponse` |
| `use-stick-to-bottom` | 对话贴底 | `Conversation` |
| `ai`（AI SDK 类型） | 可选类型借用 | **不**作 Agentero 默认 HTTP 传输 |
| Radix UI / `radix-ui` | shadcn 底层 | 可访问性、键盘、弹层 |
| Lucide React | 图标库 | 工具栏、文件树、Chat 操作 |
| `react-resizable-panels` | 可拖拽分隔面板 | 文件树 / 中间内容（论文库或编辑器）/ Notes（仅具体论文）/ 可选右侧栏（Agent 或 Backlinks+Graph） |
| tweakcn `modern-minimal` | shadcn token 主题 | 简约视觉；Chat 共用同一套 token |
| `next-themes` | 明暗 | System / Light / Dark |

> 主题：`pnpm dlx shadcn@latest add https://tweakcn.com/r/themes/modern-minimal.json`（见 `docs/frontend/ui.md`）。  
> AI Elements 安装与组件约定见 **`docs/frontend/components.md`**。

**Chat 分层（强制）**

```text
UI (AI Elements: Conversation + Message + PromptInput + Sources)
  → AgentPanel 状态机
  → Tauri invoke / events
  → Rust ACP Client
  → 本机 Agent CLI
```

- **不要**把 Vercel AI SDK 的 `useChat` HTTP 后端当作 Agentero 默认传输层。
- 流式：`agent:stream`（`kind: message | thought`）/ `agent:completed` / `agent:failed` 映射到 `Reasoning` + `MessageResponse` + `Sources`。
- 组件规范与安装：`docs/frontend/components.md`。

### 3.2.1 工作台布局与 Vault 文件树（已接入）

**布局**

| 模块 | 路径 | 说明 |
|---|---|---|
| 可伸缩面板 | `react-resizable-panels`（`Group` / `Panel` / `Separator`） | v4 API；封装见 `src/components/layout/resizable.tsx`；左右侧栏 **collapsible 常驻** + `preserve-pixel-size` |
| 侧边栏文件树 | `src/components/layout/file-tree.tsx` | 包装 **AI Elements** `FileTree`；右键 / 快捷键 |
| Vault IO | `src/lib/vault.ts` | 选目录、建树、读写文本、建目录、删除路径；`src/lib/reveal.ts` 系统文件管理器定位 / 终端打开 |
| Catalog 删除 | Host `paper_delete` | 删除 paper 或组织目录下 catalog 行（`path` / `path/%`） |

**交互（当前实现）**

1. 左侧可拖拽伸缩（可折叠）侧边栏展示 Vault 文件树；右侧 Agent/Backlinks 同为 collapsible 常驻面板（避免条件卸载冲掉折叠态）。  
2. 「Open vault…」通过 `@tauri-apps/plugin-dialog` 选择本地文件夹。  
3. 通过 `@tauri-apps/plugin-fs` 的 `readDir` 递归构建树；忽略 `.git` / `node_modules` / `target` / `dist` / `.agentero` 等。  
4. 点击文本类文件用 `readTextFile` 载入中间 Markdown 面板（Plate WYSIWYG）；写回 `writeTextFile`。  
5. 右键 / `⌥⌘R`：`revealItemInDir` 在 Finder 中显示（无双击）；右键 / `⌥⌘T`「在终端中打开」：`path_open_in_terminal`；右键 / `⌘⌫`：确认后 `remove` + 可选 `paper_delete`。  
6. 非 Tauri 环境（纯浏览器 `pnpm dev`）能力受限；真实读盘需 `pnpm tauri dev`。  
7. 最近 Vault 路径暂存 `localStorage`（后续迁到 `tauri-plugin-store`）。

**权限（`src-tauri/capabilities/default.json`）**

- `fs:default` + `fs:allow-read-dir` / `fs:allow-read-text-file` / `fs:allow-write-text-file` / `fs:allow-mkdir` / `fs:allow-remove` / `fs:allow-stat` / `fs:allow-exists`
- `fs:scope` 静态仅允许 `$HOME/.agentero/**`（拖入 PDF 的 staging 区）；Vault 目录在打开时由 Host `vault_authorize` / `vault_ensure` / `vault_create` 运行时授权（`fs_scope().allow_directory` 递归），并经 `tauri-plugin-persisted-scope` 跨重启持久化
- `opener:default`（含 `revealItemInDir`）
- `dialog:default` 打开文件夹对话框

**未做（后续）**：Zustand 全局状态、索引增量刷新（文件监听热更新已落地：`notify` → `vault:file-changed`）。

### 3.3 Markdown 编辑与预览

采用 **Plate.js WYSIWYG 编辑器**方案，编辑即预览，无需分屏切换：

| 库 | 用途 |
|---|---|
| `@platejs/core` + 插件体系 | 基于 Slate.js 的富文本编辑器框架，WYSIWYG 编辑 Markdown |
| `@platejs/markdown` | Markdown ↔ Slate 序列化/反序列化，支持导入导出 |
| `@platejs/ai` | 内置 AI 能力，可直接对接 Agent 工作流（补全、改写、总结） |
| Plate shadcn/ui 组件 | 工具栏、浮动菜单、AI 面板等 UI 组件，与项目 shadcn/ui 体系一致 |
| 自定义 `[[双链]]` 插件 | 基于 Plate 插件机制实现双链输入、解析、高亮与点击跳转 |

**选型理由**：
- **所见即所得**：用户无需在源码和预览之间切换，编辑体验接近 Notion/Obsidian Live Preview。
- **与 shadcn/ui 原生集成**：Plate 的 UI 组件直接基于 shadcn/ui 构建，与项目现有组件体系无缝配合。
- **内置 AI 能力**：`@platejs/ai` 提供编辑器内 AI 交互（补全、改写、内联建议），可通过 ACP 对接 Agent 工作流。
- **插件架构**：双链、数学公式（KaTeX）、代码高亮等均可通过 Plate 插件扩展。
- **Markdown 兼容**：通过 `@platejs/markdown` 实现 Markdown 文件的导入（反序列化为 Slate 文档）和保存（序列化为 Markdown 文本），保持与 Vault 文件的兼容。

**注意事项**：
- Plate 内部使用 Slate 数据模型，保存时需序列化为 Markdown 再写入磁盘，确保 Vault 文件仍为标准 Markdown。
- Agent 写入的 Markdown 同样需反序列化为 Slate 文档后展示在编辑器中。
- 对于习惯源码编辑的用户，后续可考虑提供 CodeMirror 源码模式作为可选切换。

**Markdown 内嵌图片（已落地）**：

| 项 | 方案 |
|---|---|
| 落盘 | `{mdDir}/assets/`；正文 `![alt](./assets/file.ext)`（Obsidian 兼容） |
| 插入 | Plate `ImagePlugin.uploadImage`（粘贴）+ 工具栏 `pickImageFiles` → `writeVaultBytes` |
| 预览 | 相对路径 → fs `readFile` → `blob:`；**选中**节点时渲染 Markdown 源码而非位图 |
| GC | `collectImageUrlCounts` 引用计数；归零且 managed `./assets/` 时 `remove` 文件 |
| 代码 | `src/lib/markdown-image.ts`；`MarkdownEditor` 配置 `ImagePlugin`；`ImageElement` |
| 权限 | `fs:allow-write-file`（capabilities） |

详见 [`../backend/data-model.md`](../backend/data-model.md)「Markdown 内嵌图片」、[`../frontend/ui.md`](../frontend/ui.md)。

### 3.4 PDF / HTML 阅读器

| 类型 | 方案 |
|---|---|
| PDF 渲染（前端） | **已接入** `react-pdf` + `pdfjs-dist`：本地优先 `blob:` → 自动下载 → 远程回退；**真实 scale 重渲染**（缩放停后 `width = 基准×缩放`）；放大后双向滚动 |
| PDF 工具栏 | 适应宽 / **适应整页**；页码 pill + 跳转；`PageDown/Up`；大纲浮层；**⌘F 查找**（`pdf-find.ts` + 文本层 rects 高亮） |
| PDF 本地归档（Host） | 魔棒 / `paper_download_assets` → `{paper}/{id}.pdf` |
| arXiv LaTeX 归档 | e-print 解压到 `source/`（`lookup/assets.rs`） |
| PDF 解析（Rust） | 可插拔 `PdfParser`（生成 PAPER.md；与预览分离） |
| HTML 预览 | 远程 `html_url` → iframe |
| 中间栏切换 | `ViewModeToggle`；HTML URL 来自 catalog / `arxiv.ts` |
| PDF 划词 | 平滑选区覆盖层 + 操作菜单；`marks/*.json`（highlight/ask/translate）；ACP 流式 |
| 翻译服务 | 应用级可插拔 `TranslateService`（free + agent）；见 [`translate.md`](translate.md) |

**分工说明**：
- **渲染层**（`react-pdf`）：负责在 Webview 中展示 PDF 页面，供用户审阅、缩放、翻页浏览。
- **解析层**（`liteparse`，crate `2.5+`）：在 Rust 端提取 PDF 文本内容，用于生成 `PAPER.md`、Agent 上下文读取、全文检索索引等。输出支持 Markdown（含标题/表格/列表重建）、JSON（含 bounding box）和纯文本。
- **当前落地**：无本地 TeX 时，在 `lookup_import` / `paper_download_assets` **下载之后**自动 liteparse → `PAPER.md`；`paper_parse_body` 亦可手动。有 TeX 不自动生成。Download 图标补资源。精读：**入库/单篇 Download 后自动** paper-reader，资源齐全且未读时 Zap 可手动（catalog `is_read`；skill 触发：**Codex `$paper-reader`**、**Claude `/paper-reader`**、其它仅注入 `SKILL.md`，见 Host `SkillMentionStyle`；前端 `src/lib/paper-read.ts`）。
- `liteparse` 内置 Tesseract OCR，对扫描型 PDF 也能处理；支持多格式（PDF/DOCX/XLSX/PPTX/图片）。
- PDF 引用/插图解析的落盘契约、TeX/PDF 双路径和交互边界见 [`../backend/pdf-analysis.md`](../backend/pdf-analysis.md)。首版只分析本地 paper PDF；sidecar 写入 paper `source/`，不覆盖原始资产。
- **HTML 安全**：完整远程/本地 HTML 文档优先用隔离 `iframe` 或 `convertFileSrc` 加载；任何会进入主文档 DOM 的不可信 HTML 字符串必须调用 `sanitizeHtml`（DOMPurify）。许可证 Apache-2.0。

**可插拔 PDF 解析器（`PdfParser`）**：
- 抽象 `PdfParser` trait，提供两个后端：本地 `LiteparseBackend`（默认，离线开箱即用）与云端 `MineruCloudBackend`（BYOK，配置 MinerU API Key 后启用）。
- 选择策略：配置并启用 MinerU 时优先云端（解析质量更高），失败自动降级本地 `liteparse`；未配置时始终本地。
- 质量映射：MinerU → `body_quality=high`；liteparse 文本层 → `medium`；扫描件 OCR → `low`，写入 catalog。
- 隐私：云端 MinerU 需上传 PDF，首次启用时提示；默认本地解析不外传数据。
- arXiv 入库在无 LaTeX/HTML 时复用同一 `PdfParser` 做兜底解析。

> MVP 阅读器以审阅、定位与就地提问为主，不实现完整 Hypothesis 式批注系统。

**PDF 划词（MVP 已落地）**：选区菜单（高亮/批注/提问/翻译）→ 统一 `papers/<id>/marks/<id>.json`（`kind`）→ 页边针回访。复用 TextLayer + ACP BYOA，不写 PDF 二进制。详设见 [`pdf-ask.md`](pdf-ask.md)。

**翻译服务（首版已落地）**：应用级可插拔 `TranslateService`；**免费 MT**（Host `translate_text`：内置 Google gtx 或 LibreTranslate URL）与 **BYOA Agent**；设置 → **Translate**；PDF 划词为首个消费方。详设见 [`translate.md`](translate.md)。

### 3.5 关系图谱

| 库 | 用途 |
|---|---|
| **`react-force-graph-2d`** | Canvas 力导向：缩放、拖拽、邻域高亮、点击打开 |
| `@xyflow/react`（备选） | 仅当未来要可编辑流程图式节点时再引入 |

**原因**：产品对照 Obsidian 式「中心 + 辐射」力导向图；右侧栏内 Canvas 性能足够；数据来自 wikilink 索引而非手写布局。  
**壳**：右侧栏只有 `agent` 与 `backlinks` 两个顶层 tab；`GraphPanel` 嵌在 Backlinks 下方，与反链共享上下文。  
**详设**：`docs/backend/wikilinks.md` §4.4 / §6.3；Host 契约 `docs/backend/api.md` §3.7 `graph_get_graph`。

### 3.6 状态管理

| 库 | 用途 |
|---|---|
| Zustand | 全局状态：当前 Vault、打开的文件、Agent 会话、UI 布局 |

**原因**：MVP 规模下 Zustand 足够轻量；无需 Redux 的样板代码。

### 3.7 路由（可选）

MVP 为单窗口桌面应用，暂不使用前端路由。若后续需要多视图（图谱全屏、设置页），引入：

| 库 | 用途 |
|---|---|
| TanStack Router | 类型安全路由 |

## 4. 后端/宿主层（Tauri + Rust）

### 4.1 Tauri 插件

| 插件 | 用途 |
|---|---|
| `tauri-plugin-fs` | 读/写 Vault 目录树与文本/二进制、mkdir、remove（文件树、Markdown assets、回收站） |
| `tauri-plugin-dialog` | 选择 Vault 文件夹（**已用于 Open vault**） |
| `tauri-plugin-store` | 持久化用户配置、最近 Vault、API Key（加密存储后续补充；当前最近路径仍用 localStorage） |
| `tauri-plugin-opener` | 打开外部链接（已配置） |
| `tauri-plugin-shell` | 已注册；spawn 用户配置的 ACP agent 子进程 |
| `tauri-plugin-http`（可选）| 前端直接发起受控 HTTP 请求 |

### 4.2 Rust Crates

| Crate | 用途 |
|---|---|
| `tauri` / `tauri-build` | 应用框架 |
| `serde` / `serde_json` | 序列化与 IPC |
| `agent-client-protocol` | ACP Client SDK：stdio JSON-RPC 与本机 Agent Server 通信 |
| `reqwest` + `tokio` | 异步 HTTP：抓取 arXiv 资源、查询 Crossref、调用云端 MinerU API |
| `pulldown-cmark` 或 `comrak` | Markdown 解析、提取双链、标题、frontmatter |
| `regex` | 双链、arXiv ID 解析 |
| `thiserror` / `anyhow` | 错误处理 |
| `notify` | Host 递归监听 Vault → `vault:file-changed`（编辑器 / 文件树热更新；`services/watcher.rs`） |
| `dirs` | 获取系统配置/缓存目录 |
| `tempfile` | Agent 生成内容临时文件，确认后写入 |
| `walkdir` | 遍历 Vault 构建索引 |
| `liteparse` | 默认本地 PDF 解析后端：提取结构化文本 + bounding box，输出 Markdown/JSON/Text，内置 OCR |
| `rusqlite`（`bundled`） | **Catalog**：`.agentero/catalog.sqlite` 论文集合 + metadata；可选 FTS / 双链缓存表 |

### 4.3 核心 Rust 模块设计

```text
src-tauri/src/
  main.rs          # 入口
  lib.rs           # Tauri Builder、命令注册
  commands/        # invoke 命令
    vault.rs       # 创建/打开/列出 Vault、最近记录
    file.rs        # 文件读写、监听
    input.rs       # 输入分类与候选论文查询
    arxiv.rs       # arXiv 入库命令
    pdf.rs         # 本地 PDF 入库：元数据预解析与确认、入库任务
    agent.rs       # Agent 注册表 / 会话 / 权限 / 工作流触发
    graph.rs       # 图谱节点/边查询
  services/        # 业务逻辑
    vault.rs       # Vault 初始化与校验
    catalog/       # .agentero/catalog.sqlite：schema、papers CRUD、export
    fs.rs          # 安全文件操作（路径白名单）
    input.rs       # 输入分类、意图解析、候选检索
    importer/      # 入库来源抽象（统一落盘结构与状态契约）
      mod.rs       #   Importer trait：import/status/输出文件契约
      arxiv.rs     #   arXiv importer：HTML/LaTeX/PDF 抓取与解析
      pdf.rs       #   本地 PDF importer：归档、解析、生成 PAPER.md
    parser/        # PDF 解析后端
      mod.rs       #   PdfParser trait：parse(pdf) -> Markdown/bbox
      liteparse.rs #   本地嵌入式后端（默认，含 OCR）
      mineru.rs    #   云端 MinerU 后端（BYOK，可选）
    metadata.rs    # 元数据解析：DOI/arXiv 识别 + Crossref/arXiv 查询 + Agent 兜底 + citekey
    lookup/        # 魔棒：标识符解析 + Translator Runtime 客户端 + Zotero JSON 映射（见 docs/backend/identifier-lookup.md）
    translator_runtime/  # 本机 translation-server 旁路进程生命周期
    markdown.rs    # Markdown 解析、双链提取、索引构建
    agent/         # ACP Client（BYOA，不内置 agent 二进制）
      acp.rs       # ACP client：spawn 用户配置的 agent、stdio JSON-RPC
      registry.rs  # Agent 注册表：模板预设 + 自定义 command/args/env
      discover.rs  # PATH / 可执行文件探测，空状态安装指引
      session.rs   # 会话管理：cwd=Vault、创建/切换/恢复
      permission.rs# 权限请求转发前端确认（含写文件前确认）
      prompts.rs   # 工作流 prompt 模板 + AGENTS.md 注入
      workflows.rs # 总结/问答/Related Work 流程
      search.rs    # Agent 驱动的论文检索/候选生成
  models/          # 数据类型
    vault.rs
    paper.rs
    note.rs
    # 划词标注：前端 marks-io → papers/<id>/marks/*.json（无 Host annotation 模块）
    graph.rs
    agent.rs
    candidate.rs   # 候选论文/检索结果
    importer.rs    # 入库状态、PDF 元数据草稿、解析器配置
  error.rs         # 应用错误类型
```

### 4.4 安全模型

- **路径白名单**：静态 `fs:scope` 仅 `$HOME/.agentero/**`；Vault 目录在打开时运行时授权（`vault_authorize` / `vault_ensure`），`tauri-plugin-persisted-scope` 持久化。Host 命令侧统一经 `services::fs::normalize_rel` / `path_escapes_root` 拒绝 `..` 穿越。
- **CSP 配置**：`tauri.conf.json` 已启用结构化 CSP（`default-src 'self'`；`script-src` 仅 `'self' 'wasm-unsafe-eval'`（pdfium WASM）；PDF blob 预览 / 远程回退经 `img/connect/frame-src` 的 `blob:`、`https:` 放行；`object-src 'none'`；dev 下 `devCsp` 额外放行 Vite HMR）。
- **引导安装命令**：`agent_open_install_terminal` 仅接受内置模板 id；Host 侧再经包管理器白名单（npm/npx/pnpm/yarn/brew/cargo/pip/pipx/uv）+ shell 元字符黑名单双重校验（`services/terminal.rs`）。
- **密钥边界**：Agentero **不持有、不转发** 模型 API Key。认证由用户本机 Agent CLI 自行管理（各 agent 自己的 login / config）。Host 仅持久化 agent 启动参数（command / args / env 中非敏感项）与 UI 偏好；MinerU 等产品侧 BYOK 仍走 `tauri-plugin-store`（后续可迁系统钥匙串）。
- **网络范围**：Agent 网络访问由 agent 进程自身控制；Agentero 自身 arXiv 抓取限定于 `arxiv.org` 域名。

## 4.5 本地存储分层：Tauri Store vs Catalog SQLite

MVP 涉及两类本地持久化需求，需要明确分层：

| 维度 | Tauri Store | Catalog SQLite |
|---|---|---|
| 数据类型 | 用户配置、最近 Vault 列表、UI 状态、产品侧 BYOK | 论文集合、结构化 metadata；可选 FTS / 双链缓存表 |
| 数据模型 | Key-Value | 关系表 + 可选 FTS5 |
| 典型容量 | 几十到几百条记录 | 可扩展到数万条论文 |
| 查询能力 | 按 key 读取 | 按作者、年份、标签、关键词过滤与列表分页 |
| 事实来源 | 是（配置类无其他来源） | **是**（论文 meta / 集合）；笔记与 source 仍是文件 |
| 存放位置 | 应用配置目录（`dirs::config_dir`） | Vault 内 `.agentero/catalog.sqlite` |
| 损坏处理 | 丢失后用户重新配置 | meta 需备份/export；笔记目录仍在。双链缓存表可删重建 |

**使用原则**：
- Tauri Store 只存配置和机密，不存论文元数据。
- 论文集合与 metadata 的权威来源是 **catalog**；根级 `PAPERS.md` / `library.bib` **默认不生成**，仅 `catalog:export_*` 按需写出。
- 人写笔记（`NOTES.md`）与 `marks/`、`source/` 仍是文件；`PAPER.md` 仍是可选派生文件。
- 入库：写 `papers/<id>/` 文件 + 事务写入 catalog；不维护自动同步的 Markdown 总表。
- Agent 最终引用必须落回 Vault 相对文件路径；L1 总览可靠应用注入列表或临时导出。
- 专题：[`docs/backend/catalog.md`](../backend/catalog.md)。
- 魔棒 / Translator：[`docs/backend/identifier-lookup.md`](../backend/identifier-lookup.md)（Search Translator 旁路进程，写入 catalog）。

## 5. 核心模块搭配与数据流

### 5.1 Vault 初始化与恢复

```text
用户选择目录
  → Rust: dialog.open({ directory: true })
  → Rust: 初始化 AGENTS.md / papers / notes / plans / .agentero/catalog.sqlite
  → Rust: store.set('recent-vaults', [...])
  → Frontend: 加载文件树；打开 AGENTS.md 或空状态（无默认 PAPERS.md）
```

### 5.2 arXiv 入库闭环

**已落地（魔棒精确 ID/URL）**：

```text
侧栏魔棒粘贴 arXiv ID/URL
  → lookup_import → Translator（或 arXiv Atom fallback）
  → catalog upsert + NOTES.md 壳
  → ensure_paper_assets：PDF → {paper}/{id}.pdf；e-print TeX → 解压 LaTeX 到 source/
  → 刷新文件树；打开 paper（PDF 预览优先本地文件）
```

**规划中（关键词 / Agent 候选）**：

```text
用户输入关键词 / 话题 / 一段描述
  → Rust: 输入分类 + Agent 检索 arXiv 候选
  → Frontend: 候选列表确认（单选/多选）
  → 复用 lookup_import / ensure_paper_assets 写盘
  → 可选：生成 PAPER.md、Agent NOTES 深化
```

**输入分类与 Agent 解析**：
- 规则层先用正则识别 arXiv ID（如 `1706.03762`、`arXiv:1706.03762`）和 URL。
- 非精确输入统一交给 Agent，Agent 可调用 arXiv API 进行关键词/摘要搜索，并返回 Top-K 候选。
- 候选需包含：标题、作者、年份、arXiv ID、摘要片段、与输入意图的匹配理由。
- 用户可在列表中多选批量入库，或拒绝全部候选后重新输入。

**PAPER.md 生成策略**（魔棒路径已部分落地）：
- `papers/<id>/source/` 存 PDF / 可选 LaTeX；Agent 优先读 `.tex`。
- **无本地 TeX**：在 PDF（及 e-print 尝试）**下载之后**，Host 用 **liteparse** 写 `PAPER.md`，并更新 catalog `body_source` / `body_quality`；亦可 `paper_parse_body`（Download 路径内触发）。
- **有 TeX**：不自动生成 `PAPER.md`。
- 可选后续：LaTeX→Markdown（pandoc）、arXiv HTML DOM→Markdown、可插拔 MinerU。
- `PAPER.md` 是派生文件，可被删除或重建；`source/` 中的原始文件才是归档事实来源。

### 5.3 本地 PDF 入库闭环

```text
用户选择或拖拽本地 PDF（可批量）
  → Rust: 复制原始 PDF 到临时目录 <tmp>/source/original.pdf（先入临时，确认后落位）
  → Rust: 轻量解析首页文本，正则识别 DOI / arXiv ID
     ├─ 命中 → 查询 Crossref(DOI) / arXiv API 获取权威元数据
     └─ 未命中/失败 → Agent 从首页正文抽取候选元数据（标题/作者/年份/摘要）
  → Frontend: 弹出确认面板，用户校对并修正元数据
  → Rust: 生成 citekey（作者 + 年份 + 标题词，冲突加后缀），重复检测（DOI / 标题指纹）
  → Rust: 临时目录落位为 papers/<citekey>/，catalog 写入 type=pdf
  → Rust: 用当前 PdfParser 全文解析（默认 liteparse；配置并启用则优先 MinerU，失败降级）
          生成 papers/<citekey>/PAPER.md 与 assets/，记录 body_source / body_quality
  → Rust: 调用 Agent 生成 NOTES.md（三段论）
  → Rust: 更新 catalog 行（不自动写 PAPERS.md / library.bib）
  → Frontend: 展示进度、成功、失败原因；自动打开 NOTES.md
```

**与 arXiv 入库的差异**：
- 目录名用 citekey 而非 arXiv ID；无 arXiv API 提供权威元数据，改由“标识符查询 + Agent 抽取 + 用户确认”混合获取。
- 无 LaTeX source，`PAPER.md` 必定生成，是该篇唯一结构化可读正文。
- 解析器可插拔：默认本地 `liteparse`，配置 MinerU API Key 后优先云端 MinerU，失败自动降级；arXiv 入库在缺 LaTeX/HTML 时复用同一 `PdfParser`。

### 5.4 Markdown 工作台

```text
文件树点击
  → Frontend: 请求 Rust 读取 Markdown 文件内容
  → Frontend: @platejs/markdown 将 Markdown 反序列化为 Slate 文档
  → Frontend: Plate.js WYSIWYG 编辑器渲染（所见即所得，双链高亮可点击）
  → Frontend: 右侧 Preview/Notes 展示渲染内容；可选右侧栏展示 Agent 或 Backlinks+Graph

用户保存
  → Frontend: @platejs/markdown 将 Slate 文档序列化为 Markdown 文本
  → Frontend: 将 Markdown 内容发往 Rust 写入磁盘
  → Rust: notify 触发文件变化事件
  → Frontend: 重建双链索引与图谱
```

### 5.5 双链与反链

完整设计见 **`docs/backend/wikilinks.md`**（语法、索引、反链、开源选型与分期）。

- **双链格式**：`[[Concept]]`、`[[papers/1706.03762/NOTES]]`，与 Obsidian 兼容。
- **模型**：单向写入 Markdown + 索引反查（不做目标文件自动插入回链）。
- **提取时机**：Rust 在后台遍历 Vault，构建文件→链接→目标索引（内存；后续可入 catalog 可重建表）。
- **前端渲染**：remark-wiki-link 系 / Plate 插件将 `[[...]]` 转为可点击链接；序列化必须写回 `[[...]]`。
- **反链查询**：Rust 根据当前文件路径返回所有引用它的文件列表。
- **缺失目标**：点击不存在的双链时弹出创建对话框，生成 `notes/<concept>.md`。

### 5.6 关系图谱

- **数据来源**：`graph_get_graph` → `{ nodes, edges, center, depth }`（`docs/backend/api.md` §3.7；设计 `docs/backend/wikilinks.md` §4.4）。
- **节点类型（路径启发）**：`paper` | `note` | `index` | `stub`。
- **边**：wikilink 有向边 `source → target`（未解析目标为 `stub:<raw>`）；邻域模式用无向 BFS 裁剪。
- **前端渲染**：`react-force-graph-2d`；`GraphPanel` 位于 Backlinks 右侧栏下方，点击节点打开文件/paper。
- **Demo**：无 Tauri 时前端从 demo vault Markdown 现算图。

### 5.7 Agent 工作流（ACP Client + BYOA）

Agent 层统一基于 **ACP（Agent Client Protocol）**：Rust Host 作为 **ACP Client**，通过 `agent-client-protocol` crate 与用户本机 **已安装** 的 Agent 子进程进行 stdio JSON-RPC 通信。Agentero **不打包** 任何 agent 二进制。

**BYOA 原则**：
- 用户在设置中添加 / 选择 Agent（预设模板或自定义 `command` + `args` + `env`）。
- 会话 `cwd` = 当前 Vault 根目录，使 Agent 直接面对 `AGENTS.md` / `papers/` 等本地资产（无默认 PAPERS.md）。
- 模型与 API Key 完全由 Agent CLI 管理；Agentero 只负责 Client 侧会话、权限 UX 与工作流 prompt。

```text
用户首次打开 Agent 面板 / 进入设置
  → Rust: 读取 agent 注册表；对 PATH 做可执行文件探测
  → Frontend: 若无可用 agent → 空状态（安装指引 + 添加自定义 agent）
  → 用户选择预设模板或填写 command/args/env 并设为默认

用户选择流程（总结 / 问答 / Related Work / 自由对话）
  → Rust: 按默认或指定 agent 配置 spawn 子进程（cwd = Vault）
  → Rust: 通过 ACP stdio 建立 JSON-RPC 连接，等待 ready
  → Rust: 创建/复用 ACP session
  → Rust: 注入工作流 prompt 模板 + AGENTS.md 约束
  → Agent: 按渐进式披露自行读取 Vault
      （AGENTS.md → catalog/列表或导出 → NOTES.md → marks/ → PAPER.md → source/）
  → Rust: 转发权限请求到 Frontend（读/写/网络等）；写文件默认确认后落盘
  → Rust: 接收流式响应，汇总读取过的本地路径
  → Frontend: 展示结果与 Sources；用户确认后写入目标 Markdown
```

**预设模板（仅命令模板，不随应用分发二进制）**：

| 模板 ID | 典型 command / args | 说明 |
|---|---|---|
| `opencode` | `opencode` + `acp` | 多模型 OpenCode |
| `gemini` | `gemini`（ACP 模式参数以官方为准） | Gemini CLI |
| `claude-acp` | 用户本机 Claude ACP 适配器 | Claude 系 agent |
| `codex-acp` | `codex-acp`（npm `@agentclientprotocol/codex-acp`） | Codex via ACP adapter |
| `qodercli` | `qodercli` + `--acp` | [Qoder CLI ACP](https://docs.qoder.com/en/cli/acp) |
| `custom` | 任意 command + args + env | 用户完全自定义 |

**Agent 切换**：
- 切换只改注册表中的默认 agent id 与启动参数，不改变 Rust 业务逻辑。
- ACP 保证接口统一；某 agent 不可用时展示探测失败原因与重试，不静默回退到「内置」agent。

**权限与写入**：
- **全局权限模式**（设置 → Agent，`agentPermissionMode`）：**受限**（默认）取消 ACP 权限请求 / Codex `workspace-write`；**每次询问**（`ask`）经 `agent:permission-request` + `agent_respond_permission` 对话框；**自动批准**（`auto`）选第一项 AllowOnce / Codex `danger-full-access`。运行经 `permissionMode` 传入（旧 `autoApprove` 仍兼容）。
- **笔记写后审阅**：BYOA 直接写盘，运行前快照目标笔记；重写后 `agent:notes-review` 统一 Diff + Keep/Revert。写前 dry-run / `agent:accept_draft` 路径仍可后续加强。

**Agent 输出规范**（工作流 prompt + `AGENTS.md` 强约束）：
- 结果末尾必须包含 `## Sources` 或 `读取文件：` 列表（相对 Vault 路径）。
- 涉及双链的内容必须保留 `[[...]]` 格式。
- Agent 可先查 SQLite 索引加速路由，但最终引用与展示必须落回本地文件路径。

### 5.8 Agent 配置（注册表，非模型 BYOK）

Agentero 配置的是 **如何启动本机 Agent**，不是模型 API Key。

| 配置项 | 说明 | 示例 |
|---|---|---|
| `agents[]` | 已注册 agent 列表 | 见下 |
| `agents[].id` | 稳定 id | `opencode-default` |
| `agents[].name` | 展示名 | `OpenCode` |
| `agents[].template` | 预设模板或 `custom` | `opencode` |
| `agents[].command` | 可执行文件 | `opencode` |
| `agents[].args` | 启动参数 | `["acp"]` |
| `agents[].env` | 额外环境变量（非密钥优先） | `{}` |
| `agents[].cwd_mode` | 工作目录策略 | `vault`（默认） |
| `agent.default_id` | 默认 agent | `opencode-default` |
| `agent.enabled` | Agent 总开关 | `true` |

- 持久化：`tauri-plugin-store`（或后续等价本地配置）。
- **不** 要求用户在 Agentero 内填写 `CLAUDE_API_KEY` / `OPENCODE_API_KEY` 等模型密钥；若某 agent 需要环境变量，由用户在系统或自定义 `env` 中自行配置，文档明确风险。
- 探测：Host 在 PATH（及可选用户指定绝对路径）上检查 `command` 是否可执行；失败时 UI 展示安装文档链接，不阻塞应用其他功能。

## 6. 平台策略：Mac 优先 + iPadOS 扩展

### 6.1 Mac 优先（MVP）

- **窗口模型**：单文档多面板工作台，参考 Obsidian / Notion 桌面版。
- **Bundle 目标**：`tauri.conf.json` 中 `bundle.targets = "all"`；本地仍以 macOS 开发为主，tag CI 会构建 macOS / Linux / Windows 安装包。
- **原生体验**：
  - 使用 macOS 原生菜单栏（Tauri `Menu` API）。
  - 快捷键遵循 macOS 习惯：`Cmd+O` 打开 Vault、`Cmd+S` 保存、`Cmd+Shift+N` 新建笔记。
  - 支持窗口大小记忆与恢复。
- **文件系统集成**：直接读写用户选择的本地目录，与 Finder 无缝协作。

### 6.2 iPadOS 扩展（后续版本）

Tauri 2 支持 iOS/iPadOS，但需针对触控设备做以下调整：

#### 6.2.1 构建与打包

- 使用 `tauri ios init` / `tauri ios build` 生成 Xcode 工程。
- 在 `tauri.conf.json` 中补充 iOS bundle 配置：
  - `bundle.ios.minimumSystemVersion` 设为 `16.0` 或更高。
  - 配置 `identifier`、`developmentTeam`。
- Rust 代码中避免使用桌面专属插件（如 `shell`），使用 iOS 兼容的 `fs`、`dialog`、`store`。

#### 6.2.2 UI 适配

| Mac 设计 | iPadOS 调整 |
|---|---|
| 三栏固定布局 | 侧边栏可收起，主编辑区全屏；使用 Sheet/Popover 展示右侧面板 |
| 鼠标悬停提示 | 长按菜单替代 |
| 小点击区域 | 增大按钮/节点热区至 44pt |
| 多窗口自由拖拽 | 已支持 `⌘N` 多窗口与**文档标签页**；**分屏** 规划见 roadmap V0.6 余量 |
| PDF 阅读器 | 支持 pinch 缩放、滚动阅读、Apple Pencil 批注（后续） |
| 键盘快捷键 | 同时支持外接键盘快捷键与屏幕触摸操作 |

#### 6.2.3 文件系统差异

- iPadOS 沙盒限制更强，Vault 选择通过系统文件选择器（`UIDocumentPickerViewController`）完成。
- 考虑支持 iCloud Drive / Files App 中的 Vault，保持与 macOS 相同的目录结构。
- 文件监听策略在 iOS 上受限，可改为应用激活时增量扫描。

#### 6.2.4 Agent 与网络

- iPadOS 若支持 ACP，仍作为 Client 连接本机/可用 agent；子进程与沙盒限制更严，**不保证** 与 macOS 同等 BYOA 体验。
- 注意后台任务限制：长时间 Agent 调用需在前台保持连接或拆分为短请求。
- MVP 以 macOS 桌面 BYOA 为准；iPadOS Agent 能力单独评估，不作为 V0.3 验收项。

### 6.3 跨平台共享代码

- **共享层**：Rust 业务逻辑（Vault、Markdown 索引、ACP Client）完全跨平台。
- **前端适配层**：通过 `useMediaQuery` / 平台检测（Tauri `os` API）切换布局组件。
- **平台特定代码**：封装在 `src/platform/` 下，如 `desktop.ts`、`mobile.ts`。

## 7. 开发/构建/部署

### 7.1 本地开发

```bash
pnpm install
pnpm tauri dev
```

### 7.2 构建

```bash
pnpm tauri build
```

### 7.3 Release CI

- `.github/workflows/release.yml` 在 push `v*` tag 时触发（workflow 名 **Release**）。
- Job 拆分（可并行、互不 `needs` 对方）：
  1. **prepare**：创建草稿 GitHub Release + release notes
  2. **installers**（矩阵 `macos-latest` / `ubuntu-22.04` / `ubuntu-24.04-arm` / `windows-latest`）：pnpm、Node 24、Rust stable；Linux 装 WebKit 等；`tauri-apps/tauri-action@v0` 构建桌面安装包并上传
  3. **cli**（同矩阵）：仅 Rust（+ Linux 系统库，因 path 依赖 `agentero_lib`）；`cargo build -p agentero-cli --release`，打包后上传同一草稿。Linux CLI 覆盖 x86_64 与 ARM64（`aarch64-unknown-linux-gnu`）。
- `fail-fast: false`：安装包失败不取消 CLI（反之亦然）。
- 后续若加入签名、公证或自动发布，需要在文档中同步列出所需 secrets，并保证本地开发构建不依赖发布凭据。

### 7.4 代码规范

- TypeScript：Biome 已配置，提交前通过 husky + lint-staged 自动检查。
- Rust：`cargo clippy` + `cargo fmt`。
- 提交信息遵循仓库现有风格：`feat:`, `fix:`, `docs:`, `chore:`。

## 8. 依赖清单（计划）

### 8.1 前端依赖

```json
{
  "@tauri-apps/api": "^2",
  "@tauri-apps/plugin-fs": "^2",
  "@tauri-apps/plugin-dialog": "^2",
  "@tauri-apps/plugin-store": "^2",
  "@tauri-apps/plugin-opener": "^2",
  "@tauri-apps/plugin-shell": "^2",
  "react": "^19.1.0",
  "react-dom": "^19.1.0",
  "react-resizable-panels": "^4",
  "platejs": "^53",
  "@platejs/markdown": "^53",
  "@platejs/basic-nodes": "^53",
  "@platejs/ai": "^53",
  "dompurify": "^3",
  "lucide-react": "^1",
  "remark-gfm": "^4",
  "remark-math": "^6",
  "remark-emoji": "^5",
  "zustand": "^5",
  "react-force-graph-2d": "^1",
  "react-pdf": "^9",
  "class-variance-authority": "^0.7",
  "clsx": "^2",
  "tailwind-merge": "^3"
}
```

> **已落地**：`react-resizable-panels`、`@tauri-apps/plugin-fs`、`@tauri-apps/plugin-dialog`、`react-pdf`、双链反链、`react-force-graph-2d` + `graph_get_graph`。  
> **图谱 UI**：Graph 位于 Backlinks 右侧栏下方，支持 Near / All 模式和节点点击打开。  
> **仍为计划**：`zustand`（可选）。

### 8.2 Rust 依赖

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-fs = "2"
tauri-plugin-dialog = "2"
tauri-plugin-store = "2"
tauri-plugin-opener = "2"
reqwest = { version = "0.12", features = ["json"] }
tokio = { version = "1", features = ["full"] }
pulldown-cmark = "0.12"
regex = "1"
liteparse = "2.5"
agent-client-protocol = "0.2"
rusqlite = { version = "0.32", features = ["bundled"] } # Catalog：.agentero/catalog.sqlite
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"
anyhow = "1"
notify = "6"
dirs = "5"
walkdir = "2"
tempfile = "3"
```

### 8.3 安全相关依赖

| 库 | 用途 | 说明 |
|---|---|---|
| `dompurify` | HTML XSS 消毒 | 已接入；封装见 `src/lib/sanitize.ts` 的 `sanitizeHtml`。内联 HTML 渲染前必须调用。 |

### 8.4 可选依赖

| 场景 | 库 |
|---|---|
| LaTeX → Markdown | `pandoc`（外部 CLI，可选）、`texparser` |
| 数学公式渲染 | Plate math 插件 + `katex` |
| 全文搜索 | `minisearch`（前端）或 Rust `tantivy` / SQLite FTS5 |
| 加密存储产品侧密钥（如 MinerU） | `keyring` crate |
| 本机 Agent（用户自装，不随 Agentero 分发） | OpenCode、Gemini CLI、Claude ACP、Codex App Server、自定义 CLI |
| iOS 原生能力 | `tauri-plugin-os`、Swift 桥接 |

## 9. 与 Roadmap 的对应关系

| Roadmap 版本 | 技术重点 |
|---|---|
| V0.1 | Tauri + React 工作台基本完成；可伸缩文件树（Finder / 删除）、Create Vault + catalog、Open vault、读写 Markdown、最近 Vault、PDF/HTML/图片/Notes、Library 表 + tags、左右侧栏 collapsible 隔离、左下角后台任务条（实色 hover）、右上角全局 Toast（`notifyError`）；文件监听（`notify` → `vault:file-changed`，编辑器/文件树自动重载）已落地。 |
| V0.2 | 魔棒 + Translator 入库、catalog 权威、`paper_download_assets`、`paper_set_tags`、无 TeX 时 liteparse → `PAPER.md`、Library 导入导出已落地；关键词候选等仍待。 |
| V0.3 | BYOA 面板进行中；通用 provider 走 ACP，Codex 走原生 App Server thread；`@` / `$` 上下文、**paper-reader**（可选自动 + Zap 手动 + `is_read`）、**SkillMentionStyle**、**权限三档**（`restricted` / `ask` / `auto` + `agent:permission-request`）、**面板 workflow**（summary / qa / related_work）、**笔记写后审阅**（`agent:notes-review` Keep/Revert）、模型收藏已接入；`AGENTS.md` 自动注入与写前草稿拦截仍待。 |
| V0.4 | 双链解析、反链面板、`graph_get_graph`、`react-force-graph-2d` 图谱已落地；Graph 嵌在 Backlinks 右侧栏下方（**双链图**）；`.md` 变更经 `scheduleWikiRebuild` 防抖重建索引。 |
| V0.5 | 抽象 `Importer` trait 与可插拔 `PdfParser`；落地 arXiv 与本地 PDF 两个 importer（liteparse 默认 + 云端 MinerU）；预留 DOI/BibTeX 扩展点。 |
| V0.6 | **文档标签页已落地**（标题栏多 tab、常驻挂载、`⌘W` 关 tab / 无 tab 关窗、多窗口独立 tab 集）；**2 格分屏**仍待；与 Agent 会话标签分离。 |
| V0.7 | **文献引用图**：cites/cited_by 可重建缓存（API 可插拔）；文内引用 hover → 右侧 Paper Info；Agent 工作流 Explore citations / Map related work / Ingest neighborhood。 |
| Release | push `v*` tag 构建 macOS / Linux / Windows Tauri 安装包并上传草稿 GitHub Release。 |
| Later | iPadOS 构建、完整 PDF 批注、云同步、多 Agent 并行、更深 prior–derivative 引用布局、>2 格分屏。 |

## 10. 风险与技术对策

| 风险 | 对策 |
|---|---|
| arXiv HTML/LaTeX 不可用 | 降级到 `liteparse` PDF 解析（支持 Markdown 输出 + OCR），并在 catalog 中标记 `body_source`/`body_quality`。 |
| 云端 MinerU 不可用或数据敏感 | 默认本地 `liteparse` 解析不外传；MinerU 失败自动降级本地；启用前提示 PDF 将上传第三方。 |
| Agent 输出破坏用户笔记 | BYOA 直接写盘，运行前快照目标笔记；重写后 `agent:notes-review` 统一 Diff + Keep/Revert。写前 dry-run 拦截仍待。 |
| 论文列表性能差 | Catalog SQLite 权威查询；双链边增量索引。 |
| Catalog 损坏 | 启动校验 schema；提示从备份恢复；可选从历史 `metadata.json` 导入；导出 `PAPERS.md`/BibTeX 作可读快照。 |
| iPadOS 文件沙盒限制 | 使用系统文件选择器；Vault 结构保持与 macOS 一致。 |
| 跨平台 UI 差异大 | 核心组件复用，布局通过平台适配层切换。 |

## 11. 相关文档

- `docs/development/prd.md`：产品需求与验收标准。
- `docs/frontend/ui.md`：视觉主题与简约设计原则。
- `docs/frontend/components.md`：AI Elements 组件规范与 Chat / 文件树集成约定。
- `docs/backend/catalog.md`：Catalog SQLite schema 与导出。
- `docs/backend/wikilinks.md`：Obsidian 兼容双链 / 反链 / 图谱设计与开源选型。
- `docs/development/roadmap.md`：版本规划与里程碑。
