# 架构总览

Agentero 基于 Tauri 2 + React 19，本地优先，Vault 文件与 Catalog SQLite 为事实来源。

## 整体架构

```text
┌─────────────────────────────────────────────────┐
│  React 19 Webview (src/)                        │
│  zustand vanilla stores → AI Elements UI        │
├─────────────────────────────────────────────────┤
│  Tauri IPC (invoke / events)                    │
├─────────────────────────────────────────────────┤
│  Rust Host (src-tauri/)                         │
│  feature-first: vault/catalog/import/wiki/agent │
├─────────────────────────────────────────────────┤
│  Vault 文件系统 + Catalog SQLite + XDG 设置     │
└─────────────────────────────────────────────────┘
```

- **前端**：[`docs/frontend/index.md`](frontend/index.md) — React 19、TypeScript、Tailwind CSS 4、shadcn/ui、AI Elements。按域 zustand vanilla store（`src/lib/<域>/store.ts` + `actions.ts`）；React 经 `hooks/use-app-stores.ts` selector 订阅。
- **Host**：[`docs/backend/index.md`](backend/index.md) — Rust、Tauri commands、文件系统、Wiki 索引、ACP Client。`app/` 装配、`core/` 基础、`features/<域>/`（`mod` + `commands` + 按需 `models`）。
- **CLI**：[`docs/backend/cli.md`](backend/cli.md) — `agentero` headless Vault/Catalog，path 依赖 `agentero_lib`。

## 工作台布局

| 区域 | 内容 | 详情 |
|---|---|---|
| 左侧栏 | 文件树 + Paper Info | 常驻 collapsible，`preserve-pixel-size` |
| 中间 | Dockview 工作区 | Library / PDF / HTML / 图片 / Markdown / Trash |
| 右侧栏 | Agent / Backlinks / 批注 / References / Figures | 可选，同样 collapsible |

- **文件树**：顶部虚拟 Library + Recycle Bin、魔棒按钮。右键新建/删除/在 Finder 中显示/终端打开。多选（⌘/Shift）+ 拖拽移动。详见 [vault-tree.md](frontend/vault-tree.md)。
- **Dockview**：每个打开文档一个 panel，支持 tab、上下左右分屏、多格网格。布局 `toJSON()` 持久化，path/mode 在 panel params。详见 [workspace.md](frontend/workspace.md)。
- **论文 NOTES**：默认左右分屏（PDF/HTML 左、`NOTES.md` 右）；多篇 paper 叠到同一两栏；body/NOTES tab 同步切换。
- **错误 Toast**：右上角 Sonner，经 `notifyError`（`src/lib/core/notify.ts`）；表单就地校验不走 Toast。

## 核心工作流

### 论文入库

魔棒入库 → 下载 PDF 到 `{paper}/{id}.pdf`；arXiv 另解压 LaTeX 到 `source/`。成功后刷新树并 `openPaper`，展开并滚到新论文。详见 [paper-import.md](frontend/paper-import.md) / [backend/paper-import.md](backend/paper-import.md)。

- **可读正文**：TeX 与 `PAPER.md` 有其一即可（优先 TeX）。无 TeX 时下载后 liteparse 生成 `PAPER.md`。
- **补下载**：paper 行缺 PDF 或既无 TeX 也无 `PAPER.md` 时显示 Download（hover 说明原因）；Library 行可批量补下。
- **Rescan**：`paper_rescan` 从 `papers/` 目录（以 `NOTES.md` 为标记）补齐盘上有、catalog 无的条目。
- **Zotero Connector**：Host 在 `127.0.0.1:23119` 收浏览器扩展 `saveItems` + `saveAttachment`。详见 [backend/connector.md](backend/connector.md)。

### 论文库

`paper_list` 读 catalog 一次进内存。表头排序/右键选列/拖拽排序（持久化到 `settings.json` 的 `libraryColumns`，标题列不可隐藏）。tags 列展示，搜索框可匹配标签子串；标题列左侧显示阅读进度热力条。文件夹作用域仅对 `papers/` 下目录按 `paper.path` 前缀过滤（不扫盘）；`notes/` / `.agents/` 等非 papers 目录显示全库。可从访达把 PDF 拖到 Library 表入库（仅 PDF overlay）。详见 [frontend/library.md](frontend/library.md) / [backend/catalog.md](backend/catalog.md)。

### 标签

Apple 风格 8 色 → Host `paper_set_tags`（catalog `tags_json` 权威）。Library 染色 chip 与筛选。CLI `paper tag list|set|add|rm`。

### 精读（paper-reader）

设置 → Agent `autoPaperReader`（默认关）。开启后魔棒入库/单篇 Download 资源就绪且未读时自动运行。资源齐全且 `is_read === false` 时文件树 Zap 可手动。写入 `NOTES.md`，成功后 `is_read = true`。进度在左下角后台任务条。Skill 运行时语法：Claude `/id`，其它仅注入 `SKILL.md`。详见 [frontend/agent.md](frontend/agent.md)。

### Agent 面板

BYOA，连接本机 ACP Agent。详见 [frontend/agent.md](frontend/agent.md) / [backend/agent.md](backend/agent.md)。

- **空态**：建议 chips → `summary` / `qa` / `related_work`。
- **上下文**：当前论文默认加入（实心 chip，可 X 移除）。`@` 提及与文件树拖入为可移除 context chip。
- **选区上下文**：Markdown/PDF 选中文字 → 瞬时选区 chip（虚线）；`⌘L` 或「加入对话」固定为 chip。发送时以引用块消费；PDF 带几何的选区在发送后插入 `kind: ask` 对话卡片页边针（非视觉批注）。
- **运行中继续输入**：后续消息进 Queue waitlist，当前回复结束后自动发送。
- **权限**：全局模式 `restricted`（默认）/ `ask` / `auto`。`ask` 时弹权限对话框。
- **结构化提问**：各 harness 的 ask-user / elicitation / Grok ext 归一为底部问卷（与 free-text composer 互斥）。详见 [frontend/agent.md](frontend/agent.md) / [backend/agent.md](backend/agent.md)。
- **个人偏好**：`agentPersonalPrompt` 非空时经 Host `build_prompt` 注入 envelope。

### PDF 阅读

Vault 任意路径 `.pdf` → `blob:` 预览。页码导航/适应宽·整页/大纲/⌘F 查找。真实 scale 渲染 + 平滑划词覆盖层。划词菜单：高亮/批注/提问/翻译。支持视觉区域批注（框选插图/表/算法/公式，可写备注或向 Agent 提问）、版面分析（Figures 侧栏列出检测到的图/表/算法/公式）、有编号公式 hover 符号解析卡。详见 [frontend/pdf.md](frontend/pdf.md) / [frontend/pdf-layout-analysis.md](frontend/pdf-layout-analysis.md)。

### Markdown 编辑

Plate + `@platejs/markdown`。普通文本粘贴默认按 Markdown 解析。右键「整理 Markdown 格式」执行 Prettier round-trip。`\$a\$` 保持普通文本、`$a$` 保持公式。Obsidian Callout（`> [!type]`）结构化渲染并原样写回。内嵌图片粘贴到 `{mdDir}/assets/`，删节点且无引用时 GC。详见 [frontend/markdown.md](frontend/markdown.md)。

### 双链与图谱

嵌套标题双链：`[[文件#外层标题#内层标题]]`。Wiki 索引 `.md` 变更防抖重建（~900ms）。反链见编辑器状态栏；**文献引用图谱**嵌在右侧 **References** 下方约 35% 高度（`agentero-cite.json` + catalog `localMatch`），入库后自动解析。与 Markdown 双链索引分层、不共用边语义。详见 [frontend/wiki.md](frontend/wiki.md) / [backend/wiki.md](backend/wiki.md) / [backend/citation-parsing.md](backend/citation-parsing.md)。

## 数据流

| 层 | 内容 | 位置 |
|---|---|---|
| 文件 | NOTES、PDF、TeX、Markdown、assets | Vault 内 |
| Catalog | 论文集合 + metadata | `.agentero/catalog.sqlite` |
| 阅读标注 | 高亮、划词问答、翻译、视觉批注 | `{paper}/marks/` |
| 版面分析 | 原始 layout regions / 侧栏索引 | `{paper}/source/layout.json` / `layout-index.json` |
| 引用解析 | 参考文献元数据 | `{paper}/source/agentero-cite.json` |
| 设置 | UI/Agent 偏好 | XDG `~/.config/agentero/settings.json` |
| 索引 | 双链图（编辑器/反链） | 内存，可重建 |
| 引用图 | 文献 cites（sidecar + localMatch） | 按需扫描 sidecar，可重建 |

## 跨领域关注点

### 国际化

所有面向用户文案经 `t()` 走 `react-i18next`。en 源语言 → 同步 `zh-CN`（`src/i18n/locales/`）。详见 [frontend/settings.md](frontend/settings.md#i18n)。

### 外部改动自动重载

Host `notify` → `vault:file-changed`。打开的 `.md`/`NOTES.md` 磁盘变化：无未存改动则重载；有未存改动则 toast 提示；内容相等抑制自写回声。create/remove/rename 去抖刷新文件树。

### 保存冲突

写盘前比对上次落盘内容；磁盘已被外部改则中止写入并警告（`diskConflict.saveBlocked`）。

### 多窗口

`⌘N` → Host `window_new`。Vault 按窗口 session 隔离，最近列表在 localStorage。设置窗口独立原生单例。

### 配色主题

设置 → Appearance `uiTheme`（默认 `default`）。36 个 tweakcn 预设打包于 `src/themes/tweakcn.json`，`src/lib/ui/theme.ts` 运行时注入 CSS 变量。详见 [frontend/settings.md](frontend/settings.md)。

### 日志

Host `tauri-plugin-log` + 前端 `logger` + CLI `env_logger`。详见 [backend/logging.md](backend/logging.md)。

### 命令面板

`⌘P`/`⌘K` 快速打开（论文 + `vault_search` 全文）；`⇧⌘P`/`>` 执行内置命令。

### 翻译服务

可插拔 `TranslateService`（免费 MT + BYOA Agent）。详见 [frontend/translate.md](frontend/translate.md) / [backend/translate.md](backend/translate.md)。
