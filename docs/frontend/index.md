# 前端

React 19 + TypeScript Webview UI。全局状态为按域 **zustand vanilla store**（`src/lib/<域>/store.ts` + `actions.ts`）；`App.tsx` 为薄组装层。`lib/` 不得反向依赖 `components/`（`pnpm deps:check`）。

> 整体架构与跨层工作流见 [../architecture.md](../architecture.md)。

## 定位

- 为人类提供审阅、编辑、导航界面；Host 负责磁盘、网络、索引与 ACP。
- Chat **只**走 AI Elements → Tauri invoke/event → Rust ACP Client → 本机 Agent，**不**用 Vercel AI SDK `useChat` 作默认传输。

## 技术栈

### 基础

| 库 | 用途 |
|---|---|
| React 19 / TypeScript / Vite | UI、类型、构建 |
| Biome | Lint + Format |

### UI 与样式

| 库 | 用途 |
|---|---|
| Tailwind CSS 4 | 布局与 token |
| shadcn/ui（radix-nova） | `src/components/ui/` |
| AI Elements | Chat / Prompt / Sources / FileTree → `src/components/ai-elements/` |
| streamdown | `MessageResponse` 流式 Markdown |
| use-stick-to-bottom | 对话贴底 |
| Radix / Lucide | 可访问性与图标 |
| react-resizable-panels | 左/右 collapsible 侧栏 |
| dockview | 中间文档工作区 |
| Sonner | 全局 Toast（`src/lib/core/notify.ts`） |
| next-themes | System / Light / Dark |
| tweakcn 预设 | `uiTheme` 运行时注入 CSS 变量 |
| @stepperize/react | 新手引导多步流程状态机（`defineStepper`） |

动效约定：`index.css` `:root` 定义 motion token（`--motion-duration-fast: 150ms` 浮层进出、`--motion-duration-normal: 200ms` 布局编排、`--motion-ease-out`）；组件类对应 100=微反馈 / 150=浮层 / 200=布局。全局 `prefers-reduced-motion` 兜底关闭所有动效（`animate-spin` 除外）。

该 CSS 兜底只覆盖 CSS transition/keyframes；JS 驱动的动效（`scrollIntoView` / 虚拟列表滚动 / `use-stick-to-bottom` 贴底 / `motion/react`）必须自行询问 `src/lib/core/motion.ts` 的 `prefersReducedMotion()` / `scrollBehavior()`，`motion/react` 组件用其 `useReducedMotion()`。

### 领域库

| 领域 | 选型 |
|---|---|
| Markdown | Plate + `@platejs/markdown` + media + selection/dnd |
| PDF | EmbedPDF + PDFium |
| 图谱 | react-force-graph-2d |
| 状态 | zustand vanilla（按域 store） |

## Chat 分层（强制）

```text
UI (AI Elements: Conversation + Message + PromptInput + Sources)
  → AgentPanel 状态机
  → Tauri invoke / events
  → Rust ACP Client
  → 本机 Agent CLI
```

流式事件：`agent:stream`（`kind: message | thought`）/ `agent:completed` / `agent:failed` → Reasoning + MessageResponse + Sources。  
组件约定：[components.md](components.md)。

## 与 Host 的职责边界（前端侧）

| 能力 | 前端 | Host |
|---|---|---|
| 文件树 | 展示/选中/打开/拖拽 | 建树、读写、删除、终端 |
| Markdown | Plate 编辑与序列化 | 落盘 |
| 双链 | 渲染、补全、嵌入、反链 | 索引与 `graph_*` |
| PDF | EmbedPDF 渲染与划词 | 下载、liteparse、路径 |
| 入库 | 魔棒 UI、进度、确认 | Translator / commit |
| Agent | 会话 UI、权限对话框 | spawn ACP、prompt |
| 配置 | 设置窗口 UI | XDG `settings.json` |

## 状态管理（按域）

| Store | 职责 |
|---|---|
| `lib/vault/store` | vault 路径、树、选中 |
| `lib/workspace/store` | dockview tabs / layout |
| `lib/paper/library-store` | 论文库行与 scope |
| `lib/pdf/annotations-store` | 按 tab 高亮 / Ask |
| `lib/wiki/store` | 索引 revision、重命名对话框 |
| `lib/shell/ui-store` | 侧栏、PDF 沉浸模式、命令面板、对话框 |
| `lib/settings` | 设置缓存与跨窗口同步 |
| `lib/activity` | 本机使用记录：`track()` 缓冲 → `activity_record_events` |

## 功能索引

| 功能 | 文档 |
|---|---|
| 工作台壳 | [shell.md](shell.md) |
| 新手引导 | [onboarding.md](onboarding.md) |
| Dockview 工作区 / 功能窗 / 文档弹窗 | [workspace.md](workspace.md) |
| 文件树 | [vault-tree.md](vault-tree.md) |
| 论文库 Library（含阅读热力条） | [library.md](library.md) |
| 入库 UI | [paper-import.md](paper-import.md) |
| Markdown 编辑 | [markdown.md](markdown.md) |
| LaTeX 写作、编译与 SyncTeX | [latex.md](latex.md) |
| 写作工作面 | [writing.md](writing.md) |
| 写作模板与新增会议模板 | [writing-templates.md](writing-templates.md) |
| PDF 阅读与划词 | [pdf.md](pdf.md) |
| 网页论文阅读与划词（内置代理 + 选区桥）；本地 HTML 预览 | [web-view.md](web-view.md) |
| PDF 版面分析（Figures / Tables / Algorithms / Formulas） | [pdf-layout-analysis.md](pdf-layout-analysis.md) |
| Agent 面板 | [agent.md](agent.md) |
| 知乎 Agent（内置，直答 / 检索） | [zhihu.md](zhihu.md) |
| 移动端壳与 Bridge 客户端 | [mobile.md](mobile.md) |
| 双链 UI | [wiki.md](wiki.md) |
| 命令面板 | [command-palette.md](command-palette.md) |
| 翻译 | [translate.md](translate.md) |
| 设置与主题 | [settings.md](settings.md) |
| 本机使用记录 | [../backend/usage.md](../backend/usage.md) |
| 组件约定 | [components.md](components.md) |

Host 契约：[../backend/](../backend/index.md)。
