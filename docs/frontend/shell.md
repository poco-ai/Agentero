# 工作台壳

## 布局

- **左栏**：文件树 + Paper Info（显示最近选中的论文；切换到非论文文档时保持不消失；无卡片容器、常驻 collapsible；上边缘可拖拽调整高度，`preserve-pixel-size`；文件树多选时复用固定高度标题栏显示批量操作，不压缩或遮挡树；arXiv 论文在资源按钮下显示 arXiv PDF、魔搭论文解读与 alphaXiv 外链，不再显示摘要按钮；窄宽度下资源按钮退化为仅图标；元信息修改入口位于 Info 底部）。Cool Papers / Kimi 解析入口在论文 `NOTES.md` 的 Markdown 工具栏，不在 Paper Info。
- **中间**：无 Vault 欢迎页；有 Vault 时为全局 Dockview（见 [workspace.md](workspace.md)）。
- **右栏**（可选）：Agent / 批注。
  - 参考文献与版面解析已移入 PDF 阅读器左侧浮层面板（见 [pdf.md](pdf.md)），不再占用右栏。
  - **移至新窗口**：标题栏右栏功能图标 **右键** →「移动至新窗口」→ 单例 `feature-{view}` Webview；主窗右栏收起。工具视图默认 **跟随主窗当前激活文档**（`workspace:active-changed`）。
- 左右栏折叠：`⌥⌘S` / `⌘L`（不重叠）。折叠/展开带 200ms `flex-grow` 过渡（`data-rail-animating`，见 `index.css`）；过渡中拖动分隔条立即接管（可打断）；`prefers-reduced-motion` 下直接切换。
- 标题栏右侧：更新指示器、窗口布局菜单、Agent 切换；有新版本可更新时显示更新指示器按钮（见 [settings.md](settings.md) 「应用更新」）。布局菜单提供 **Agent**（PDF / Agent `1:1`）、**笔记**（PDF / Notes / Agent `1:1:1`）和 **阅读**（仅 PDF）三种预设。预设只调整 panel 宽度并开关当前论文的 Notes / Agent，不关闭其它 PDF tab。

实现：`src/components/shell/`、`src/lib/shell/ui-store.ts`、`src/lib/shell/leaf.ts`、`src/lib/shell/feature-window.ts`、`hooks/use-shell-layout.ts`。

## 欢迎页与多窗口

- 无 Vault：最近路径 MRU、打开 / 创建 / 从 Zotero 迁移。
- `⌘N` → Host `window_new`（`?fresh=1`）；Vault 与 dock 布局按窗口 session 隔离。
- **功能单例窗**：`feature_window_open` → `?window=feature&view=…`（`FeatureWindowRoot`）。
- **文档弹出窗**：文档 tab 右键「移动至新窗口」→ `doc_window_open` → `?window=doc&path=…`（`DocWindowRoot`）；同 path 再开则聚焦。
- 当前窗口 Vault：`sessionStorage`；MRU / 上次路径：`localStorage`。
- 桌面窗口在 Webview 页面加载完成后显示；React 首次提交前由 `index.html` 的零依赖启动壳占位，避免冷启动和 dev 模块加载期间出现空白窗口。

## 全局 Toast

- 操作失败 / 警告：右上角 Sonner。
- API：`notifyError` / `notifyWarning`（`src/lib/core/notify.ts`）。
- 表单就地校验不走 Toast。

## 后台任务条

- 左下角：下载、入库、导入导出、paper-reader、版面解析等。
- **折叠 = 进度圆环**；**悬停约 400ms 或点击圆环 → 详情列表**；**指针离开即收回圆环**（不常驻详情 Toast）。
- 圆环使用不透明 `bg-background` 圆盘 + `ring-1 ring-border`（不用 border，避免内容区缩小导致圆环与底盘错位）+ 轨道（`muted-foreground/30`）与进度弧（`primary` / 失败 destructive / 完成 emerald）；中心图标用 `foreground`。避免浅色模式下底层内容透出或轨道过浅。
- **完成态**：全部任务结束后圆环合并为满环（100%），成功时播放短暂合并/勾选动画（`task-ring-success-*`）；失败为满环 + destructive。进行中无数值进度时短弧旋转（indeterminate），不把完成态画成未闭合短弧。
- 新任务 / 打开页面不自动展开。任务失败时短暂展开详情，未悬停约 5s 后收回；进行中可取消，可清除已完成。
- 论文资源下载的总体进度由 **Host 侧聚合**：PDF 与 TeX 并发下载，两条流的字节合并成一个 `downloadedBytes` / `totalBytes` 后经 `job:progress`（`phase` = `assets`）写回同一行，前端 `mapDownloadProgress` 只做 clamp。这样先下完的一条流不会把进度条钉在 100%，纯 PDF（无 TeX 流）的入库也能走满 0–100%。
- 版面解析 / 引用解析 / 正文解析 / 资源下载 / 元数据识别 / 论文导入（魔棒、本地 PDF、Skill、广场、Cool Papers）/ Connector 附件保存 / 库级批量操作（引用扫描、书目导入导出、批量元数据刷新）/ 版面模型下载由 JobCenter 投影到任务条（前端门面 `src/lib/core/tasks.ts`，投影/执行器桥接在其内部模块 `job-center.ts`）。取消走 `job_cancel`；迟到的 `running` 事件不得把已取消/已完成的行复活。
- 导入与 Connector 是 Renderer-host job：Rust 只负责调度（并发、去重、取消），编排在渲染端执行器里（`src/lib/paper/import/import-tasks.ts` 按 `params.mode` 分发；`connector-tasks.ts` 把 `connector:progress` 中继成 job）。库级批量操作同理（`src/lib/paper/library-tasks.ts`：`citingScan` / `libraryIo` 按 `params.op` / `metadataRefresh` 按 `params.papers` 逐项上报 N/M）。job id 同时作为 Host 的 `task_id`：字节/批次进度经 `job:progress`（`taskId` = job id）由投影层写回面板行，协作取消由 JobCenter 的 cancel token 按 task id 索引（`features::jobs::is_task_cancelled`，注入为 `agentero_core::cancel` 探针）。版面模型下载（`modelDownload`）是 Host runner job：全局资源、cap 1，重复触发按 fingerprint 合并。
- 打开论文时的资源自动下载（`src/lib/workspace/tabs/resources.ts`）同样是 JobCenter `downloadAssets` job：Host runner 下载后续接 PAPER.md / 版面分析，去重合并同篇的并发下载。
- 纯前端 UI 本地活动不进 JobCenter（无去重/依赖/重启恢复语义）：paper-reader、Zotero 迁移向导、散落 PDF 的 viewer 内版面分析经门面 `runLocalActivity`（`src/lib/core/tasks.ts`）创建本地任务行；取消纯靠本地 AbortController（不经 Rust），同类并发由 `tasks.ts` 内的信号量执行。`background-tasks.ts` 只保留面板 store 与视图辅助（行 CRUD、字节/进度格式化），不含执行编排。
- 实现：`src/lib/core/background-tasks.ts` + `background-tasks-panel.tsx`。

## 弹层栈

- `overlay-stack`：`Esc` / `⌘W` 先关最顶层 sheet/Dialog，再关 active panel。
- 弹层可标记为 `modal: false`（如 Agent 面板底部 ask-user 表单），保留 `Esc` 关闭能力，但不阻塞 `whenSettingsClosed` 类的全局快捷键（如 `⌘B` / `⌥⌘S` 切换侧边栏）。
- 仅剩全库 Library 且无弹层时，`⌘W` 关窗。

## 快捷键（壳层）

| 快捷键 | 行为 |
|---|---|
| `⌘,` | 开/关设置窗口 |
| `⌘.` | PDF 视觉批注框选（当前论文：焦点在 PDF 或 NOTES 均可，handle 落在 body 标签） |
| `⌘N` | 新窗口 |
| `⌘W` / `Esc` | 关弹层 → 关 panel → 关窗 |
| `⇧⌘T` | 重新打开最近关闭的 panel（内存历史，最多 10 条；关论文正文记正文，恢复时连带 NOTES；切 Vault 清空） |
| `⌥⌘←/→` | 循环 Dockview panel |
| `⌘\` | 向右 Split pane：当前论文未打开 NOTES 时右侧打开 NOTES；否则复制当前 pane，并将横向 pane 等宽 |
| `⌘P` / `⌘K` | 快速打开 |
| `⇧⌘P` | 命令面板 |
| `⇧⌘I` | 魔棒 |
| `⌘R` | 刷新文件树 |
| `⌥⌘R` | Finder 显示 |
| `⌥⌘T` | 终端打开 |
| `⌘⌫` | 移入回收站 |
| `⌘+` / `⌘=` | 放大全局 UI |
| `⌘-` | 缩小全局 UI |
| `⌘0` | 重置全局 UI 缩放 |
| `⌘1` | 聚焦左侧文件树 |
| `⌘2` | 聚焦中间编辑器 |
| `⌘3` | 聚焦右侧笔记/Agent 面板 |
| `⌘←` | 折叠当前选中文件夹 |
| `⇧⌘←` | 折叠树到默认状态 |
| `⌥⌘S` | 开关左侧边栏（`⌘B` 别名） |
| `⌘L` | 开关右侧 Agent/Graph 等面板 |
| `⇧⌘A` | 固定当前选区为 Agent 上下文，打开 Agent 面板并聚焦输入框（无选区时只打开并聚焦） |

完整快捷键绑定：`src/lib/shell/shortcuts.ts`。文案 i18n 见 [settings.md](settings.md)。

## 设计约定

- 工具栏优先图标 + `aria-label` + Tooltip；避免常驻解释文案。
- 操作型 Chrome（按钮、导航、标题栏、工具栏、可点击卡片）默认禁用浏览器文字选择；正文、可复制 metadata、编辑器、PDF 文字层和输入控件必须保持可选。不要在应用根节点统一设置 `user-select: none`，避免误伤第三方内容层和移动端长按选择。
- 基础组件 shadcn/ui；Chat/树 AI UI 用 AI Elements（[components.md](components.md)）。
- **启动种子放 `boot()`**（`src/main.tsx`），不要在 render 期做副作用。`initSettingsStore` / `initVaultStore` / `initWorkspaceStore` 在 `createRoot` 前调用：既保证首帧前完成，又不依赖 `useState` 初始化器（StrictMode 下可能跑两次）。
- **订阅 Host 事件一律用类型化事件绑定（`src/lib/core/bindings.ts` 的 `events.*`）：组件内 `useTauriEvent(events.x, cb)`，非 UI 模块 `listenEventSafe(events.x, cb)`（`src/lib/core/tauri-events.ts`）**；字符串事件名仅限前端窗口间广播（`workspace:*`、`agent:attach-context` 等）与 iOS bridge client 事件，非 Tauri wire 的 promise 式订阅（bridge、workspace-broadcast）用 `toSafeDisposer()`。手写 `let off; void (async () => { off = await listen(...) })(); return () => off?.()` 会在 `listen` resolve 前 dispose 时泄漏监听器 —— StrictMode 每次开发挂载都会命中。
- **注册全局订阅的 `init*` / `start*` 必须返回 disposer**，并由调用方 effect 返回。
- 每个 vault 的副作用挂在 `vault:opened` 作用域上，清理写在同一 handler 的 teardown 里，见 [../development/lifecycle-events.md](../development/lifecycle-events.md)。
