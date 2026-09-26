# 左侧文件树偶发黑屏，滚动后恢复

**状态**：已修复（虚拟行改 `top` 定位 + 视口 Resize 同步 scrollOffset + 侧栏只保留 `isolate` 叠层隔离，去掉全区 `transform-gpu` 合成层）  
**影响面**：左侧 Vault 文件树（打开/关闭论文、切换标签、树刷新、导入后更易触发）  
**相关代码**：

- `src/components/sidebar/file-tree/tree-rows-viewport.tsx` — 虚拟行用 `top` 而非 `transform: translateY`
- `src/components/sidebar/file-tree/hooks/use-tree-reveal.ts` — `useAnimationFrameWithResizeObserver`；ResizeObserver 把 DOM `scrollTop` 同步回 virtualizer
- `src/App.tsx` — `[data-vault-sidebar]` 只用 `isolate`（叠层隔离），不再给整个侧栏加 `transform-gpu` 合成层
- 文档：`docs/frontend/vault-tree.md`

---

## 1. 问题现象

左侧文件树区域偶尔整片变黑 / 空白，像没有绘制；鼠标滚一下或拖动滚动条后内容立刻回来。多在打开/关闭论文、导入或树刷新之后出现。

---

## 2. 根因

文件树用 `@tanstack/react-virtual` 窗口化，原先每行：

```tsx
style={{ transform: `translateY(${vi.start}px)` }}
```

在 Tauri macOS（WKWebView）上，`transform` 会把每一行提升为独立合成层。打开论文时中间栏 PDF / EmbedPDF 会制造大量 GPU 层与布局抖动；侧栏这些 transform 层有时不会被正确标脏，直到下一次滚动强制重绘。

叠加第二条路径：Paper Info 面板挂载会缩短树的滚动视口高度。WebKit 可能在**不发 `scroll` 事件**的情况下钳制 `scrollTop`，而 virtualizer 仍持有旧的 `scrollOffset`，`getVirtualItems()` 算出空窗口，表现同样是侧栏空白，滚动后才对齐。

**复发（#607）**：首轮修复在 `aside[data-vault-sidebar]` 上加了 `transform-gpu`，却把整条侧栏提升成**单个合成层**。打开论文 / 切换标签 / 导入时中间栏 PDF 制造大量 GPU 层，WKWebView 会把这条整区层留在「已合成但未标脏」的状态——表现仍是整片变黑、滚动后恢复。此时行已用 `top` 定位（无逐行层），整区合成层不再必要，反而是复发源。

---

## 3. 修复

1. **行定位改 `top`**：不再用 `translateY`，减少逐行合成层，避开 WKWebView 脏区漏标。
2. **视口 Resize 同步偏移**：观察树滚动容器，若 DOM `scrollTop` 与 virtualizer 偏移不一致则 `scrollToOffset`；并开启 `useAnimationFrameWithResizeObserver`，让 React 提交后再量几何。
3. **只做叠层隔离，不做整区合成层**：`aside[data-vault-sidebar]` 只保留 `isolate`（创建 stacking context），去掉 `transform-gpu`。行不再有 `transform`，无需再靠整区 GPU 层与 PDF 隔离；避免整区层被 WKWebView 漏标而整片变黑（#607）。

---

## 4. 验证注意

该问题依赖 WKWebView 合成行为，纯浏览器 `pnpm dev` 不一定复现。回归时用 `pnpm tauri dev`：打开带 PDF 的论文、切换标签、导入后观察左侧树是否仍会黑屏；故意滚一下应不再是「唯一恢复手段」。

#607 的修复（去掉整区 `transform-gpu`）必须用 `pnpm tauri dev` 在 macOS WKWebView 上验证——Chromium 下侧栏本就不会出现该合成层漏标，无法作为回归证据。验证清单：打开论文 / 切换标签 / 导入后，左侧树应直接完整绘制，无需滚动；同时确认侧栏与 PDF 之间没有出现新的层叠/穿透问题。
