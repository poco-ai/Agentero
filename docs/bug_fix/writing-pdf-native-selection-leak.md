# 写作分栏：在 PDF 里选字会带出左侧源码原生选区

**Issue**：#895  
**状态**：已修复（2026-11）  
**影响面**：写作项目内的源码编辑器与编译 PDF 分栏；不涉及普通论文阅读的 PDF 选择

## 现象

写作模式下：

1. 先在左侧 CodeMirror 编辑器里点击一次。
2. 再到右侧 PDF 里拖选一段文字。
3. 左侧编辑器会同时出现一段**按相同纵向位置**高亮的选区，但不是 PDF 选中文字对应的源码内容。

用户第一眼会认为是 SyncTeX 把 PDF 选区同步成了源码选区，或者 CodeMirror 在读取窗口级选区。实际两者都不是。

## 复现

- 打开任意 `thesis/<project>/` 项目，左侧显示 `.tex`，右侧显示编译 PDF。
- 在左侧编辑器的任意位置单击（不要选中文本）。
- 在右侧 PDF 中拖选一段文字。
- 观察左侧：源码出现跨多行的原生选区，位置与 PDF 选区的纵向范围对应。

## 根因

浏览器原生选区在同一个文档内是共享的，而左侧 CodeMirror 是 `contenteditable`。

1. 点击 CodeMirror 后，原生选区锚点停在 `.cm-content` 里。
2. 右侧 PDF 的根节点带 `select-none`（`src/components/viewer/pdf/pdf-viewer.tsx` 的 `data-pdf-root`），PDF 页面本身不是可选文本。
3. 在 PDF 上拖选时，浏览器把拖选终点映射到文档中最近的**可选文本**，也就是左侧 CodeMirror；于是一个原生选区范围从 CodeMirror 内的旧锚点延伸到 PDF 拖选位置，左侧就出现“同高度”的高亮。
4. 如果 CodeMirror 仍保持焦点，它的 DOM observer 还可能把这段原生选区读进编辑器状态，形成更持久的选区。
5. 与此同时，PDF 自己的选区由 PDFium 管理（`usePdfTextSelection`），与浏览器原生选区互不相干，所以两边会同时显示。

### 排查时排除的方向

- **不是 `syncTexBackward` 的普通拖选**：`use-pdf-synctex.ts` 只在显式 `⌘/Ctrl + 点击`（以及当时存在、后来移除的双击）时调用反向 SyncTeX；普通拖选不会走这条路径。
- **不是 CodeMirror 主动订阅 `window.getSelection`**：CodeMirror 不会把窗口选区同步成编辑状态；但在它保持焦点时，浏览器原生选区确实可以被它的 DOM observer 观察。
- **不是 SyncTeX 多区域高亮**：那种高亮由 PDF 侧绘制，没有 PDF 选区菜单；截图里的 PDF 选区带有书签/复制/快速对话菜单，是 PDFium 的真实文本选择。
- **不是单纯的“选区没有互相清除”**：即使清掉旧选区，只要原生选区锚点还在 CodeMirror 里，下一次 PDF 拖选仍会把它重新延伸出来。

## 修复

### 1. PDF 页面按下鼠标时释放外部原生选区

`src/components/viewer/pdf/hooks/use-pdf-text-selection.ts` 新增 `releaseNativeSelectionForPdfPointer`：

- 在 PDF 根节点的 `pointerdown` 捕获阶段执行。
- 如果落点在译文/回排的 DOM 文字层、批注输入框或普通输入框内，保留原生选区。
- 否则：
  - 如果当前焦点是 PDF 外的 `contenteditable`（CodeMirror），先 `blur()`，避免 DOM observer 继续接收跨栏选区。
  - 调用 `window.getSelection()?.removeAllRanges()` 清掉旧锚点。

PDFium 的 PDF 选区不依赖 DOM 原生选区，因此清掉它不会影响 PDF 内划词。

### 2. 写作分栏内只保留一侧选区

`src/components/writing/writing-selection-group.tsx` 为每个 `TexProjectView` 提供一个选区组：

- 源码编辑器开始实时选择时发出 `source`，PDF 侧收起 PDFium 选区和浮动工具栏。
- PDF 开始实时选择时发出 `pdf`，源码侧把范围折叠为一个光标，不滚动、不抢焦点。
- 译文/回排文字层仍走原生 DOM 选区，不做折叠。

### 3. 去掉双击 PDF 的隐式反向定位

`src/components/viewer/pdf/hooks/use-pdf-synctex.ts` 只保留显式反向定位：

- `⌘/Ctrl + 点击`。
- 中间的 `←` 按钮。
- 普通单击、双击只记录位置用于箭头按钮，不再移动源码光标/行。

双击选词是 PDF 里最常用的文本选择手势，不应同时触发源码跳转。

## 验证

自动化：

```bash
pnpm exec vitest run \
  test/pdf-selection-native-detach.test.ts \
  test/pdf-synctex-click.test.ts \
  test/writing-selection-group.test.ts \
  test/tex-synctex.test.ts \
  test/tex-editor-navigation.test.ts \
  test/pdf-layout-store-keys.test.ts
pnpm typecheck
```

`test/pdf-selection-native-detach.test.ts` 覆盖两条关键边界：

- PDF 页面按下时，外部 `contenteditable` 的原生选区被清掉。
- `.pdf-translate-selection` 这类 DOM 文字层仍保留选区。

手工：

- 先点源码、再拖选 PDF：左侧不再出现同高度选区。
- 先拖选 PDF、再点源码：PDF 选区和工具栏收起。
- 双击 PDF 选词：源码不移动。
- `⌘/Ctrl + 点击` PDF：仍能反向定位源码。
- 在译文层上拖选：译文仍可正常选择。

## 防再发

- **CodeMirror 是 `contenteditable`**：任何与它同窗口、可能接收拖选的非文本面板，都要在 `pointerdown` 时主动释放原生选区；不能假设 `select-none` 会保护相邻编辑器。
- **PDF 选区不是 DOM 选区**：PDFium 选择与 `window.getSelection()` 是两套状态。排查“两侧同时选中”时先分别确认是哪一套状态。
- **清理 DOM 选区时要放行 DOM 文字层**：译文/回排/批注输入框依赖原生选区，选择器必须显式排除。
- **`event.target` 可能是 Text 节点**：判断是否落在可选区域时，先取 `parentElement` 再 `closest()`，不要只判断 `Element`。
- **诊断顺序**：先区分“PDF 真实选区 / SyncTeX 高亮 / 源码原生选区 / CodeMirror 状态选区”，再决定修哪一层。
