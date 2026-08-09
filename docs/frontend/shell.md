# 工作台壳

## 布局

- **左栏**：文件树 + Paper Info（显示最近选中的论文；切换到非论文文档时保持不消失；无卡片容器、常驻 collapsible；上边缘可拖拽调整高度，`preserve-pixel-size`；arXiv 论文在资源按钮下显示魔搭论文解读与 alphaXiv 外链）。
- **中间**：无 Vault 欢迎页；有 Vault 时为全局 Dockview（见 [workspace.md](workspace.md)）。
- **右栏**（可选）：Agent / Backlinks / 批注 / **References** / **Figures**（同样 collapsible）。
  - References：当前激活 paper 的参考文献卡片（数据来自 `agentero-cite.json` sidecar，Host `paper_refs_list` / `paper_refs_parse`）。卡片含编号 `[n]`、标题（无标题回退 raw）、首作者 et al. · 年份 · venue、DOI/arXiv 徽标；已入库（`localMatch`）卡片点击打开库内论文，未入库 hover 出「导入文库」（复用魔棒管线，但导入后不自动打开新论文）；顶部过滤框 + header 重解析按钮。实现：`src/components/viewer/panels/references-panel.tsx`、`src/lib/paper/refs.ts`。
  - **Figures**：版面分析后的插图（image+chart）/ 表 / 算法 / 有编号公式；**分析与 bbox 叠加层按钮在侧栏 header**；固定置信度 ≥30%（无滑条）；联图与标题规则见 [pdf-layout-analysis.md](pdf-layout-analysis.md)。实现：`viewer/panels/figures-panel.tsx` + `src/lib/pdf/layout/`（raw 结果缓存到 `{paper}/source/layout.json`）。
  - **移至新窗口**：标题栏右栏功能图标 **右键** →「移动至新窗口」→ 单例 `feature-{view}` Webview；主窗右栏收起。工具视图默认 **跟随主窗当前激活文档**（`workspace:active-changed`）。
- 左右栏折叠：`⌥⌘S` / `⌘L`（不重叠）。
- 标题栏右侧：布局菜单、右栏 tab 切换；有新版本可更新时显示更新指示器按钮（见 [settings.md](settings.md) 「应用更新」）。

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
- 新任务 / 打开页面不自动展开。任务失败时短暂展开详情，未悬停约 5s 后收回；进行中可取消，可清除已完成。
- 论文资源下载的总体进度按顺序聚合 PDF 与 TeX：PDF 占前 50%，TeX 占后 50%，避免切换阶段时进度回退。
- 实现：`src/lib/core/background-tasks.ts` + `background-tasks-panel.tsx`。

## 弹层栈

- `overlay-stack`：`Esc` / `⌘W` 先关最顶层 sheet/Dialog，再关 active panel。
- 仅剩全库 Library 且无弹层时，`⌘W` 关窗。

## 快捷键（壳层）

| 快捷键 | 行为 |
|---|---|
| `⌘,` | 开/关设置窗口 |
| `⌘.` | PDF 视觉批注框选（当前论文：焦点在 PDF 或 NOTES 均可，handle 落在 body 标签） |
| `⌘N` | 新窗口 |
| `⌘W` / `Esc` | 关弹层 → 关 panel → 关窗 |
| `⌥⌘←/→` | 循环 Dockview panel |
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
| `⌘L` | 开关右侧 Agent/Backlinks 面板 |

完整快捷键绑定：`src/lib/shell/shortcuts.ts`。文案 i18n 见 [settings.md](settings.md)。

## 设计约定

- 工具栏优先图标 + `aria-label` + Tooltip；避免常驻解释文案。
- 基础组件 shadcn/ui；Chat/树 AI UI 用 AI Elements（[components.md](components.md)）。
