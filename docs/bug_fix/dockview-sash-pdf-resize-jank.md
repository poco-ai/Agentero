# 拖动 Dockview 分隔条时 PDF / NOTES 卡顿（sash drag resize jank）

**状态**：已修复（per-frame pointermove 合并 + Markdown 布局冻结 + 统一手势信号 + EmbedPDF resize 门控 + 临时 layout/paint containment）；其中 PDF 侧的收益未测量，见 §5  
**影响面**：中间栏 PDF / NOTES 分屏（及任意带 PDF 或重型 panel 的 Dockview 拖动）  
**相关代码**：

- `src/lib/workspace/dockview-sash.ts` — `installDockviewSashFrameLoop`、`createLatestFrameDispatcher`、`isDockviewSashTarget`、`onSashDragBegin/End` 钩子
- `src/lib/workspace/resize-gesture.ts` — `createResizeGesture` / `installResizeGesture`（**唯一**的手势信号：显式 sash 钩子 + 工作区根节点 ResizeObserver）
- `src/lib/workspace/markdown-resize-freeze.ts` — `createMarkdownResizeFreeze`（拖动期间冻结 Markdown 布局）
- `src/components/viewer/pdf/viewport/dockview-viewport.tsx` — 订阅手势信号来 gate viewport metrics（不再自己认 `.dv-sash`）
- `src/components/workspace/dock-workspace.tsx` — 挂载 sash frame loop + freeze，挂载点 `.agentero-dockview`
- `src/lib/pdf/dockview-resize.ts` — `createPdfViewportResizeGate`（拖动期间暂停 EmbedPDF viewport metrics）
- `src/components/viewer/embed/pdf-viewer.tsx` — `DockviewViewport` 包装 EmbedPDF viewport，按拖动状态门控
- `src/index.css` — `.agentero-dock-sash-active` 期间的 `contain: layout paint` 与 `user-select: none`
- `test/dockview-sash-pointer.test.ts` — sash frame 调度、pointerup 补齐、手势钩子时序测试
- `test/pdf-dockview-resize.test.ts` — resize gate 合并 / suppress / 一次性提交测试
- `test/markdown-resize-freeze.test.ts` — 冻结的 pin / 还原 / 幂等 / 跳过塌陷面板测试
- 文档：`docs/frontend/workspace.md`、`docs/frontend/shell.md`、`docs/test/release-checklist.md`

---

## 1. 问题现象

PDF 与 NOTES 左右分屏时，用鼠标 / 触控板拖动中间的 Dockview 分隔条（sash）会出现：

1. 分隔条与 panel 边界**跟不上指针**，松手后突然回跳到最终位置；
2. PDF 文本选区、高亮、批注针在拖动过程中**位置错乱或闪烁**；
3. 高刷屏（120Hz / 240Hz 触控板）上一帧内多次 pointermove 堆积，整帧掉帧明显；
4. 同一帧里其它 panel（编辑器、图片预览）也会跟着重排。

直接观感是「拖一下卡一下，松手才到位」。

---

## 2. 根因

拖动 sash 时，每一次原始 `pointermove` 都会同步触发**两条独立的昂贵链路**，且二者都没有节流：

```text
pointermove (原始, 一帧内可能 N 次)
 ├─ Dockview layoutViews()   ← 递归重排所有受影响 panel
 │    └─ 触发 panel 容器几何更新、tabs 条、render overlay
 └─ EmbedPDF viewport ResizeObserver
      └─ 提交 viewport metrics
           └─ 重算可见页 + React setState + 文本层 / 画布重绘
```

### 2.1 Dockview 7 的默认行为

Dockview 7 在每个原始 `pointermove` 中同步执行递归 `layoutViews()`。高刷输入设备在一帧内可以触发多次 `pointermove`，导致同一帧里几何被反复重算，相邻 panel 也被牵连失效。

### 2.2 EmbedPDF 的 ResizeObserver

`DockviewViewport`（pdf-viewer 内）原实现对 viewport DOM 的任何宽高变化都立刻提交 viewport metrics。一次 sash 拖动 = 几十次 metrics 提交 = 几十次可见页重算和 React 状态更新。**这才是 PDF 卡顿的主因**，而不是 Dockview 的几何更新本身。

### 2.3 缺少 containment

`dv-view` / `dv-render-overlay` 没有 layout/paint containment，一次重排会让同级 panel 一起进入 layout 阶段；拖动期间也缺少 `user-select: none`，浏览器原生文本选择会进一步打断指针流。

### 2.4 不应一起做的事

- **手动数值缩放（如 125%）**：拖动期间若让 EmbedPDF 重算 viewport，用户设的 zoom 会被覆盖；
- **布局持久化**：Dockview 的 `onDidLayoutChange` 已经只在松手后触发，这一层无需额外处理。

---

## 3. 修复方案

核心思路：**两条昂贵链路分别节流，且互不耦合**。

### 3.1 Dockview 一侧：每帧只转发最后一次坐标

`installDockviewSashFrameLoop` 挂在工作区 `.agentero-dockview` 根节点上，在捕获阶段拦截 pointerdown：

| 信号 | 处理 |
|---|---|
| pointerdown 命中 `.dv-sash` 且属于本工作区 | 进入「sash 拖动态」，加 `.agentero-dock-sash-active`，`preventDefault` 阻止原生选区 |
| 拖动中的 pointermove | **取消** Dockview 原生监听，改 enqueue 到 `createLatestFrameDispatcher` |
| `requestAnimationFrame` 触发 | 合成一条 pointermove 转发 Dockview，只携带本帧最后一次坐标 |
| pointerup / pointercancel / contextmenu / window blur | 在交给 Dockview 前**同步 flush** 最终坐标，避免松手回跳 |

效果：**一帧最多一次 Dockview layoutViews**，松手前不留尾巴。

### 3.2 EmbedPDF 一侧：拖动期间暂停 metrics

`DockviewViewport` 仍让 viewport DOM 边界随 Dockview 几何即时跟随（所以页面看起来在连续裁剪 / 展开），但 `createPdfViewportResizeGate` 做了门控：

| 阶段 | 行为 |
|---|---|
| 普通 ResizeObserver 触发 | 合并到单次 rAF，提交 metrics |
| `beginDockResize()` | 取消待处理 frame，进入 suppress |
| 拖动中每次 notifyResize | 不提交 metrics（viewport DOM 仍在跟随几何） |
| `endDockResize()` | 排一次 rAF，提交**最终**尺寸，然后恢复正常合并模式 |

进入 / 退出拖动态由 pdf-viewer 的 `pointerdown` 检测目标是否 `.dv-sash` 决定，并在 `pointerup` / `blur` / `contextmenu` 时收尾。手动 zoom 值原样保留，不被 PDF 重算覆盖。

### 3.3 跨 panel 隔离 + 选区抑制

`src/index.css` 在 `.agentero-dock-sash-active` 期间：

```css
.agentero-dockview.agentero-dock-sash-active .dv-view,
.agentero-dockview.agentero-dock-sash-active .dv-render-overlay {
  contain: layout paint;
}

.agentero-dockview.agentero-dock-sash-active {
  -webkit-user-select: none;
  user-select: none;
}
```

注意**不能用 `display: none` 或卸载 render overlay**——那会让 PDF 壳保活失效（见 `docs/frontend/workspace.md` 的 overlay 锚点说明）。

### 3.4 Markdown / NOTES 一侧：拖动期间冻结布局

§3.2 只门控了 EmbedPDF 一侧，NOTES 面板的宽度同样每帧在变。

**先纠正一个曾经的误判。** 最初的假设是「长笔记每帧整篇重新折行」（仓库另一处实测 4000 块重排 ≈16.5ms）。用 Playwright WebKit 27.2 起了一个只挂真实 Markdown 编辑器 + `index.css` 的测量台（`tmp/harness`，441 块 / 401 个标题），实测：

| 场景 | 中位帧间隔 | 判断 |
|---|---|---|
| 不改宽度（地板） | 17.0ms | 60fps |
| resize，不冻结 | **42.0ms** | 真实卡顿 |
| resize，钉**编辑器**宽度 | 39.0ms | **只省 3ms** |
| resize，钉**查询容器**宽度 | **17.0ms** | 卡顿消失 |
| resize，关掉容器查询 | 17.0ms | 同上 |

即：**~24/25ms 来自 `@container/editor` 查询容器在每帧重跑子树样式，文字重排只占 ~3ms**（7%）。只钉编辑器宽度相当于修了那 7%。

**修法**：把 `@container/editor` 从面板 div 下移到它的直接子元素（宽度相同），由 `markdown-resize-freeze` 钉住这个**容器**。容器尺寸不变 → 查询不重跑；容器内的编辑器宽度也不变 → 文字不重折。一次手势只付一次。

| 阶段 | 行为 |
|---|---|
| 手势开始 | 量出查询容器当前 `getBoundingClientRect().width`，写进 inline `width`（保留小数，取整本身就会改变容器尺寸） |
| 拖动中 | 面板边界照常跟手，容器与文字都不动；溢出由 `.agentero-dock-sash-active` 的 `contain: paint` 裁掉 |
| 手势结束 | 撤掉 pin → 样式与布局各重算一次，落在手势真正结束的几何上 |

**覆盖三种手势，而不是一种**。原先所有门闩（本 freeze、`createPdfViewportResizeGate`、`contain: layout paint`、sash rAF 合帧）都只挂在 `isDockviewSashTarget(.dv-sash)` 的 pointerdown 上，所以**拖外壳 rail（react-resizable-panels）和拖 macOS 窗口边缘时一个都不生效**。现在 freeze 自己做来源无关的侦测：

- **显式**：`dockview-sash.ts` 的 `onSashDragBegin/End`（sash 移动时工作区根节点尺寸不变，观察器看不到，且显式信号能拿到精确的拖动前宽度）
- **自动**：观察工作区根节点的 `ResizeObserver`，任何尺寸变化即开始冻结，静默 140ms 判定结束 —— 这一条覆盖 rail 拖拽与原生窗口缩放

实测两者都到 17.0ms（见上表诊断列：容器宽度在自动侦测下同样被钉住）。

**视觉代价**：手势过程中内容不跟随宽度 —— 拉宽时右侧留白，收窄时右侧被裁。与 §3.2 里 PDF 面板「页面被即时裁剪 / 扩展」是同一种取舍，也是本仓库已经接受的交互语义。

### 3.5 前后对比

| 维度 | 修改前 | 修改后 |
|---|---|---|
| Dockview pointermove | 每个原始事件同步 layoutViews | 每帧只 1 次，松手前补齐 |
| EmbedPDF viewport metrics | 每次 ResizeObserver 都提交 | 拖动期间 suppress，松手后单帧提交 |
| DOM viewport 视觉跟随 | 同上 | 仍逐帧跟随（不触发 PDF 重排） |
| NOTES 每帧成本 | 面板宽度每帧变化 → 容器查询重跑子树样式（~24ms）+ 文字重折（~3ms） | 拖动期间钉住查询容器，松手只重算一次（42ms → 17ms/帧） |
| 手动 zoom（如 125%） | 可能被覆盖 | 保留 |
| 跨 panel 失效 | 重排牵连同级 | 拖动期间 contain |
| 原生文本选择 | 干扰指针流 | 拖动期间禁用 |

---

## 4. 验收

### 4.1 手动验收（release-checklist 7.1.3a）

1. 打开一篇 PDF 并与 NOTES 分屏，把 PDF 设为手动 125%。
2. **慢速**向左 / 向右来回拖动中间 divider——分隔条与 PDF panel 边界应逐帧跟手，PDF 选区不抖、页面只被即时裁剪 / 扩展，125% 保持。
3. **快速**来回拖动——无输入堆积、无卡顿。
4. 在一次快速拖动中**直接松手**——panel 边界落到指针松手位置，无回跳，滚动区与最终尺寸一致。
5. 拖动期间不应误选 PDF 或相邻编辑器的文本。

### 4.2 自动化证据

```bash
pnpm exec vitest run \
  test/dockview-sash-pointer.test.ts \
  test/pdf-dockview-resize.test.ts \
  test/markdown-resize-freeze.test.ts
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

`sash-pointer.test.ts` 验证：一帧内多次 enqueue 只 dispatch 一次、pointerup 前补齐最终坐标、`pointerup` / `contextmenu` / `blur` 均能结束拖动态、非本工作区的 sash 不被劫持，以及手势钩子的时序（begin 早于首次 layout、end 晚于最终 flush、拖动中重复 pointerdown 不重复 arm、非 sash 的 pointerdown 不 arm）。  
`pdf-dockview-resize.test.ts` 验证：普通 resize 合并到一帧、`beginDockResize` 取消待处理 frame、拖动期间 suppress、`endDockResize` 后只提交一次、`dispose` 后再不调度。  
`markdown-resize-freeze.test.ts` 验证：按测量值 pin 查询容器（保留小数宽度）、不动编辑器与滚动容器、还原自己没写过的 inline 样式、跳过零宽塌陷面板、已 pin 时不重复测量、dispose 后不再响应。  
`resize-gesture.test.ts` 验证：首个 RO 回调只作 priming、静默窗口起止、持续变化续期、显式信号 ref-count（重叠不早退、多余的 end 不置负）、显式期间不受静默窗口影响、只在跳变时通知、unsubscribe / dispose 生效、`resizeGestureFor` 只认安装过的根节点。  
以上均为单元层面的**语义**验证；`42ms → 17ms` 这个数字来自 `tmp/harness`（Playwright WebKit 27.2 + 真实 `MarkdownEditorKit` + 真实 `index.css`），可用 `bash tmp/harness/run.sh` 复跑。

---

## 5. 边界

- **松手到提交有一帧延迟**：这是用「PDF 不在拖动中重排」换回的代价；松手后视觉立刻对齐。
- **NOTES 拖动期间不换行**：见 §3.4 的视觉代价；换来的是整篇只在松手时重排一次。Markdown 侧读的是 `getBoundingClientRect().width`，因此 pin 的是小数宽度，不会因为取整而触发一次多余折行。
- **`contain: layout paint` 仅在拖动期间启用**：松手立刻移除，不影响日常滚动 / 选区；它同时是 §3.4 冻结溢出的裁剪来源。
- **订阅手势必须与挂载顺序无关**：踩过一次。`DockviewViewport` 用 `useLayoutEffect` 订阅，而工作区用 `useEffect` 安装手势 —— React 中子组件的 layout effect 先于父组件的 passive effect 执行，于是 PDF 挂载时按元素查找拿到 `null`，**gate 从此再也不会接上**（比改动前更糟：原来至少在 sash 拖拽时是 gate 住的）。现改为 `subscribeResizeGesture` 全局扇出：订阅与安装顺序无关，工作区被替换时也会重新挂接。`resize-gesture.test.ts` 有专门一条「先订阅、后安装」的用例锁住这个时序。
- **手势之外（日常编辑 / 滚动）不改任何东西**：pin 只在手势期间存在，松手立刻还原；`@container/editor` 的响应式行为在手势外与原来完全一致。
- **多窗口、多 Dockview 实例**：`isDockviewSashTarget` 只认本工作区 `contains` 的 sash，不会跨窗口劫持 pointerdown。
- **远程 Vault / 无触控板设备**：修复对低频 pointermove 无副作用——per-frame 合并在低刷屏上等价于「原样转发」。
- **不改动布局持久化**：`onDidLayoutChange` 仍是 Dockview 原生「松手后触发」，本次修复未触碰。
- **PDF 侧已接到同一手势信号，但收益未测量**：`DockviewViewport` 原先自己认 `.dv-sash` 的 pointerdown，现在订阅 `resize-gesture.ts` 的同一个信号，因此 rail 拖拽与原生窗口缩放期间也会 suppress viewport metrics 提交。**这一条的收益没有测量数据**：真实 PDF 需要 Tauri + PDFium，测量台（`tmp/harness`）复现不了，而本次只在 Markdown 侧拿到了 42→17ms 的数字。改动本身是低风险的（同一个 gate、同一套已在 sash 路径上验证过的 suppress→松手单次提交语义），但不要把它当成已验证的优化。

---

## 6. 决议记录

| 议题 | 决议 |
|---|---|
| 是否在拖动期间卸载 / 隐藏 PDF panel | 否；会破坏 PDF 壳保活，改为只暂停 viewport metrics 提交 |
| viewport DOM 是否跟随几何 | 是；保持视觉跟手，只把昂贵重排推迟到松手 |
| 节流放在 Dockview 还是 EmbedPDF | 两层都要；两条链路独立、互不耦合 |
| containment 用 `display: none` 还是 `contain` | 用 `contain: layout paint`；前者会破坏保活 |
| 手动 zoom 是否参与重算 | 否；EmbedPDF 重算只覆盖 viewport 尺寸，不改 zoom |
| 是否持久化拖动中的中间几何 | 否；沿用 Dockview 原生「松手后持久化」语义 |
| Markdown 侧靠 `content-visibility` 还是冻结 | 冻结。WebKit 的 CV 只在内容进入视口时才 reveal（#276735 未修），打开它等于把卡顿从拖拽搬到滚动；实测开启 CV 对 resize 也毫无收益（42.0 vs 42.0ms） |
| 钉编辑器宽度还是钉查询容器 | 钉容器。实测钉编辑器只省 3ms，钉容器从 42ms 回到 17ms |
| 手势侦测放在哪 | 抽成单一 `resize-gesture.ts`：显式（sash 钩子，拿精确的拖动前宽度，ref-count）+ 自动（工作区根节点 ResizeObserver + 140ms 静默）。Markdown freeze 与 PDF gate 都订阅它，不再各自认 `.dv-sash` |
| 冻结粒度放在库还是手势 | 手势。`installDockviewSashFrameLoop` 暴露 `onSashDragBegin/End`，冻结实现独立成模块，二者互不知道对方内部 |
| 拖动期间是否让文字继续换行 | 否；与 PDF 面板「即时裁剪 / 扩展」保持同一种交互语义 |
