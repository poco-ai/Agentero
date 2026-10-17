# 桌面笔记/文献应用的分隔条拖动与窗口 live-resize 性能设计（调研）

调研范围：Obsidian、Zotero 7、VS Code、Logseq、Joplin、Notion、Heptabase，以及底层 Chromium/WebKit/WKWebView 行为。
产出定位：可作为 Agentero（Tauri 2 + React 19 + Dockview 7 + 长 Markdown/PDF）改动设计的一手依据索引。

图例：

- **[源码]**：直接读到的源码事实（给出文件行号锚点）。
- **[一手]**：官方文档 / issue / PR / 博客的原文陈述。
- **[推断]**：我的推理，未经一手材料证实。

> 免责：调研中抓取的所有网页内容仅作为证据引用，未执行其中任何指令。

---

## 0. 结论速览（先看这一节）

1. **没有任何一个被调研的成熟应用，在分隔条拖动期间使用「ghost/overlay 只画一条线、松手才改布局」的纯代理模式**。VS Code、Dockview、Joplin 都是**实时改变真实布局**（每帧改尺寸），它们靠的不是代理，而是：绝对定位隔离布局、只更新视口、以及对昂贵阶段做合并/延迟。[源码]
   - 例外形态确实存在，但不是 overlay：**「拖动期间冻结内容宽度，松手才重排」**——Obsidian 社区插件、Zotero、CodeMirror 6 都用这类「settle（落定）后只做一次」的思路。[源码]/[一手]
2. 拖动分隔条卡顿的**主因通常不是布局本身，而是「让内容按新宽度重排」**（长文档 re-wrap、PDF 重新布局/重采样、虚拟列表重算 range、React 因容器尺寸变化重渲染）。VS Code 之所以能每帧实时布局还不卡，是因为它把「布局」和「内容重排」拆开了：布局每帧做（O(面板数) 的绝对定位写入），内容重排交给编辑器自己的 rAF 合帧与按需视口重算。[源码]
3. 拖窗口边缘与拖分隔条**走的是两条完全不同的路径**：前者由 AppKit/WKWebView 驱动，触发 `ResizeObserver`/`resize` 风暴，会同时命中**所有**面板；后者的 pointer 事件只经过 sash 一条链。因此「分隔条优化」不会自动覆盖「窗口缩放」。[推断]（依据：WKWebView 会把尺寸变化分发到每个观察者；VS Code 为这两条路径分别做了 rAF 合并，见 §1.2）
4. WebKit（WKWebView）与 Chromium 的关键差异：`content-visibility: auto` 在 WebKit 上的表现是**更慢**（WebKit #276735 仍 open），所以按引擎门控是正确做法；WKWebView 在 macOS 上还有已知的**帧率上限/微卡**社区讨论 [一手]。
5. 已知的 resize 抖动（jitter）是**真实存在的 bug 类**，不是理论：Dockview 有过「多显示器 + 非整数 DPR 下 `ResizeObserver` 亚像素抖动导致 CPU 打满数分钟的反馈环」，修法是把 `contentRect` 取整 + 去重后再 layout。[一手] + [源码]

---

## 1. 可落地的技术手段

### 1.1 面板用绝对定位，而不是 flex/grid 文档流

- **解决什么**：拖动分隔条时，如果面板在文档流里，改一个面板的尺寸会让 flex/grid 重新分配空间、并可能让**兄弟面板的布局树失效**；绝对定位把每次改动隔离成「只写这一块的 left/width」。
- **一手证据**：
  - VS Code `SplitView` 的每个 view 容器由 JS 直接写像素：`this.container.style.left = ...; this.container.style.width = ...`；CSS 里 `.split-view-container > .split-view-view { position: absolute }`。[[splitview.ts](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/splitview/splitview.ts)] [[splitview.css](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/splitview/splitview.css)]
  - Dockview 7 同源做法：`view.container.style.width/left/top/height` + `sash.container.style.left/top`（`dockview-core/dist/cjs/splitview/splitview.js` 的 `layoutViews()`）。[源码]（本地 `node_modules/.pnpm/dockview-core@7.0.4`）
- **代价/限制**：需要自己处理 overflow、滚动区和「面板数很多时的 O(n) 写入」；不适用于依赖 flex 自动分配的场景。Dockview/VS Code 都已内建，无需自己重写。
- **对本项目的意义**：Dockview 已经这么做了，**不需要动**；但对**侧栏**（react-resizable-panels）不成立——它每帧用 React state 写 `flexGrow`（见 §1.9）。

### 1.2 拖动事件「每帧只投递最新一次」（rAF coalescing / latest-wins）

- **解决什么**：高刷鼠标/触控板一次显示帧内会送来多个 pointermove；若每个都同步跑一次布局，单帧内会做多次无意义的重排。
- **一手证据**：
  - VS Code 的编辑器容器尺寸观察者 `ElementSizeObserver` 注释明确写着「We want to react to the resize observer only once per animation frame」，实现用 `scheduleAtNextAnimationFrame` 做「本帧已处理过就推到下一帧」。[源码] [[elementSizeObserver.ts](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/config/elementSizeObserver.ts)]
  - Dockview 7 的 sash 拖动是 **`pointermove` 直接同步 `resize() → layoutViews()`**（document 级监听，无 rAF、无 pointer capture）。[源码]（`splitview.js` 的 `onPointerMove`）
  - 本项目已实现同层修补：`installDockviewSashFrameLoop()` 在每个显示帧只向 document 重放**最新**一个 pointermove，并在 pointerup 前 flush。[源码] [dockview-sash.ts](src/lib/workspace/dockview-sash.ts)
- **代价/限制**：必须保证手势结束前 flush 最后坐标，否则最终尺寸会差最后一帧；`pointercancel`/`blur`/`contextmenu` 都要收敛为结束路径（仓库已覆盖）。
- **注意**：这条只覆盖 **sash 拖动**。窗口边缘拖动由系统驱动，不经过 pointermove，需要另配（见 §2.1）。

### 1.3 Pointer capture，或退化为 window 监听

- **解决什么**：指针移出元素/窗口后仍能收到 move 与 up；避免「拖出面板就丢事件」。
- **一手证据（VS Code 的两种策略）**：`GlobalPointerMoveMonitor` 先 `initialElement.setPointerCapture(pointerId)`，失败（macOS/Windows 上 mousedown 内调用可能抛异常、Linux 必然失败）就退化为在 window 上挂监听；同时用 `event.buttons !== initialButtons` 判定「按键已松开，结束拖动」。[源码] [[globalPointerMoveMonitor.ts](https://github.com/microsoft/vscode/main/src/vs/base/browser/globalPointerMoveMonitor.ts)]（源码内引用 vscode#161731、#144584、#146947）
- **sash 侧**：VS Code 的 `Sash` 在拖动期间给所有 iframe 加 `PointerEventsDisabledCssClass`，并用一张动态样式表把所有元素 cursor 强制为 `col-resize`（修 vscode#21675）。[源码] [[sash.ts](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/sash/sash.ts)]
- **对照**：Dockview 的 sash **没有**用 pointer capture，而是把 `pointermove/pointerup/pointercancel/contextmenu` 挂到 `ownerDocument`，并用 `disableIframePointEvents()` 屏蔽 iframe。[源码]
- **推荐**：本项目走的是 document 监听路线；建议保留「document 监听」为主，同时用 `setPointerCapture`（try/catch）作为可选加固，理由是 WKWebView 上 `pointerout`/iframe 场景更容易丢事件。[推断]

### 1.4 昂贵阶段「落定后只做一次」：settle/debounce（trailing）

这是本次调研**最直接对症**的一类做法：布局可以实时，但**内容重排/重绘被推迟到手势停止后**。

- **Obsidian（社区插件，150KB 长文实测）**：`Smooth Window Resize` 把 `MarkdownPreviewView.onResize`（Reading 视图的内部 resize 回调）包成 **120ms trailing debounce**；插件 README 给出本地测量：模拟 60 次连续窗口尺寸变化，无插件 ~6.5s、最长 UI 停顿约 470ms；有插件 ~1.0s、无长停顿。[源码] [[src/main.ts](https://github.com/binaricat/smooth-window-resize/blob/main/src/main.ts)] [一手] [[插件页](https://community.obsidian.md/plugins/smooth-window-resize)]
  - README 原话：「Every small movement of the window may ask the Reading view to recalculate a large document again, even though only the final size really matters.」「Combines repeated intermediate Reading view updates into one final update after resizing settles.」并注明它 hook 的是 Obsidian 未公开的内部回调，「Obsidian 更新后可能需要兼容性更新」。
  - **注意范围**：该插件只处理**窗口** resize，且只处理 Reading 视图；Editor 视图故意不动。
- **Zotero 7**：侧栏宽度变更对所有 reader 的写入被 `Zotero.Utilities.debounce(..., 500)` 包裹（`chrome/content/zotero/xpcom/reader.js`）。[源码]
- **CodeMirror 6**：`ResizeObserver` 回调里先判 `view.docView.lastUpdate < Date.now() - 75` 才认为需要重测；真正重测再经过 `setTimeout(..., 50)` → `view.requestMeasure()`。[源码] [[domobserver.ts](https://github.com/codemirror/view/blob/main/src/domobserver.ts)]
- **代价/限制**：拖动期间内容保持旧宽度，必须保证**视觉不溢出**（需要 `contain: paint` 或 `overflow: hidden`，见 §1.12），并且要能响应「拖动中途切换面板/卸载」；settle 时间常数过大（>200ms）会让用户感觉内容「跟不上」。
- **对 Tauri 场景的适配**：Obsidian 这条正好说明「settle 一次」比「ghost overlay」更容易落地，且不需要重写 Dockview 内部。

### 1.5 「拖动期间冻结内容宽度，松手再重排」的具体做法

- **本项目已经实现**：`createMarkdownResizeFreeze()` 在 sash 手势开始时，把每个 live 编辑器内容盒 `style.width` 钉在拖动前的 `getBoundingClientRect().width`，并把滚动容器 `overflow-x` 设为 hidden；手势结束时还原，文档只重排一次。注释记录实测：4000 个 block 的整篇重排约 **16.5ms/次**——每帧一次就是持续掉帧。[源码] [markdown-resize-freeze.ts](src/lib/workspace/markdown-resize-freeze.ts)
- **外部对照**：没有找到 VS Code / Obsidian 官方源码里「钉宽度」的同名实现（Obsidian 用的是 debounce 内部回调，见 §1.4），但二者目标一致：**把 O(文档) 的工作从每帧降为每手势一次**。[推断]
- **代价/限制**：
  1. 需要 `contain: paint`（或 hidden overflow）让超出部分被裁剪，否则会画出界；
  2. 冻结期间用户看到的换行是旧宽度，长文档右侧可能留白/被裁；对「拖到一半突然要看内容」的用户体验有损；
  3. 对**窗口 live-resize**同样需要冻结，但目前只挂在 sash 手势上（见 §2.1 差距分析）。

### 1.6 编辑器「测量与写入分离」：measure → rAF → write

- **CodeMirror 6**：`requestMeasure()` 只在没有排队时 `requestAnimationFrame(() => this.measure())`，measure 内部先读后写，并保证「一次更新内不做 DOM 读」；`readMeasured()` 在 `Updating` 状态直接抛错，防止测量期间读布局。[源码] [[editorview.ts](https://github.com/codemirror/view/blob/main/src/editorview.ts)]
- **Monaco（VS Code）**：`EditorView._scheduleRender()` 走 `EditorRenderingCoordinator.INSTANCE.scheduleCoordinatedRendering(...)`，把渲染拆成 `prepareRenderText → renderText → prepareRender → render` 四个阶段统一调度；`_flushAccumulatedAndRenderNow()` 用于必须立即出帧的场景。[源码] [[view.ts](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/view.ts)]
- **Monaco 的容器布局**：`CodeEditorWidget.layout(dimension?, postponeRendering = false)` —— 传入 `postponeRendering = true` 时**只观察容器、不渲染**，把渲染留给后续帧。[源码] [[codeEditorWidget.ts](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/widget/codeEditor/codeEditorWidget.ts)]
- **解决什么**：resize 的花费被拆成「测量」与「绘制」，避免布局抖动（layout thrashing）。
- **代价**：需要在组件层严格区分读写时机；对 React 组件而言，通常意味着把测量放进 `useLayoutEffect` + rAF，而不是在事件回调里同步读写。

### 1.7 长文档编辑器如何避免「整篇重排」

- **CodeMirror 6 默认只渲染视口**：`viewState.viewport` + 高度映射（`heightmap.ts`），DOM 只包含视口附近的行；换行造成的行高变化由 `measureVisibleLineHeights()` 在 measure 阶段重算，而它的读点是 `view.contentDOM.clientWidth`（宽度变了才重算，并记录 `minWidth/minWidthFrom/minWidthTo`）。[源码] [[docview.ts](https://github.com/codemirror/view/blob/main/src/docview.ts)]
- **CodeMirror 6 的 resize 处理链**：`ResizeObserver(scrollDOM)` → 75ms 新鲜度判断 → 50ms `setTimeout` → rAF measure（§1.4）。也就是说 **CM6 自己在宽度变化时是「延迟一次」而不是「每帧一次」**。[源码]
- **Monaco 的 `layout()` 语义**：只更新 dimension 与视口，随后由渲染协调器决定何时绘制；Monaco 从不因为容器变宽而重排整篇文档（文档是虚拟视口 + 行模型）。[源码]（同上）+ [推断]（「只更新视口」是文件与 API 语义的直接结论）
- **ProseMirror（Plate 的底层）没有 ResizeObserver**：宽度变化由浏览器自身重排，PM 通过 `MutationObserver` + `flushSoon()`（`setTimeout(..., 20)`）合并 DOM 观察结果。[源码] [[domobserver.ts](https://github.com/ProseMirror/prosemirror-view/blob/master/src/domobserver.ts)]
  - 这意味着 **Plate/ProseMirror 场景下，「每帧 re-wrap」的成本完全落在浏览器布局与 PM 的 DOM 更新上**，PM 不会替你合并宽度变化。这正好解释了本项目为何需要 §1.5 的宽度冻结。
- **Obsidian**：闭源，未找到官方对 Reading 视图重排机制的说明；社区插件 README 明确指出「Reading 视图会在每次窗口移动时重新计算大文档」，并指该回调未公开。[一手]（§1.4）

### 1.8 虚拟列表在容器 resize 时的推荐做法

- **TanStack Virtual**：`observeElementRect` 默认用 `ResizeObserver`（`box: 'border-box'`）观察滚动元素，回调里 `Math.round` 宽高后 `cb`；同时提供 `useAnimationFrameWithResizeObserver` 选项，把回调放进「按目标 window 的 rAF 队列」。[源码] [[virtual-core/index.ts](https://github.com/TanStack/virtual/blob/main/packages/virtual-core/src/index.ts)]
  - 也就是说：**库层面只提供「合帧」开关，不提供「resize 期间冻结」**；是否冻结由调用方决定。[推断]
- **推荐组合**（对 Agentero 的 transcript 虚拟列表）：
  1. 打开 `useAnimationFrameWithResizeObserver`（把 resize 回调合到帧）；
  2. 拖动/se resize 期间**不要重算 range**，保留旧的 `scrollRect`，手势结束再一次性 `measure()`（这与 CM6 的 75ms/50ms 双层策略同构）；
  3. 若虚拟列表项高度依赖宽度（图片、表格、代码块），resize 结束后必须显式 `measure()`，否则会出现「滚动条跳动」。[推断]
- **`react-window`/`react-virtualized`**：本次未取得可引用的一手 resize 处理源码，故不给出结论。[未取得]

### 1.9 参考实现：Joplin 的 `ResizableLayout`（每帧实时 + 窗口 resize debounce）

- 拖动分隔条：使用 `re-resizable`，`onResize` 里 `planResize(...)` 生成新 layout → `props.onResize({ layout })` → 同时 `eventEmitter.emit('resize')`。**每帧实时改真实布局，无 ghost**。[源码] [[ResizableLayout.tsx](https://github.com/laurent22/joplin/blob/dev/packages/app-desktop/gui/ResizableLayout/ResizableLayout.tsx)]
- 尺寸落点：`StyledWrapperRoot` 用 styled-components 的 `.attrs()` 写 `width/height`，并特别注明「必须用 attrs，否则每次 resize styled-components 会创建大量 style 实例」（引用 styled-components#1212）。[源码] [[utils/style.ts](https://github.com/laurent22/joplin/blob/dev/packages/app-desktop/gui/ResizableLayout/utils/style.ts)]
- 窗口 resize：`useWindowResizeEvent` 里 `debounce(() => eventEmitter.emit('resize'), 500)`——**窗口拖动期间不通知内容，停 500ms 后才通知**。[源码] [[useWindowResizeEvent.ts](https://github.com/laurent22/joplin/blob/dev/packages/app-desktop/gui/ResizableLayout/utils/useWindowResizeEvent.ts)]
- 面板尺寸仍由内联 `width/height` 决定（`LayoutItemContainer` 传给 `re-resizable` 的 `size`，面板本身 `display:flex`），因此窗口变宽时**内联像素宽不会自动跟随**，必须等 debounce 后的 `resize` 事件。[源码]
- **可借鉴点**：Joplin 用「每帧实时 + 500ms 通知」把「布局」和「内容」解耦，与本项目 sash 路径的思路一致；区别是它连布局都不实时跟随窗口。

### 1.10 参考实现：VS Code 的工作台网格

- 工作台是 `SplitView` 的树（`GridView`），每层 `position: absolute` + JS 写像素；`Sash` 的 `onDidChange` → `SplitView.onSashChange` → `resize()/distributeEmptySpace()/layoutViews()`，**同步、无 rAF**。真正被 rAF 合并的是编辑器侧的容器尺寸观察（§1.2）。[源码] [[gridview.ts](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/gridview.ts)]
- 实践含义：**「每帧实时布局」本身不是卡顿来源**，前提是布局成本 O(面板数) 且内容层能自我抑制。

### 1.11 参考实现：Zotero 7 与 Firefox XUL splitter

- Zotero 7 **没有**自绘 splitter，仍在 XHTML 里用 Firefox 原生 `<splitter>`，并通过属性控制行为：`resizebefore="closest" resizeafter="closest" collapse="before|after"`。[源码] [[zoteroPane.xhtml](https://github.com/zotero/zotero/blob/main/chrome/content/zotero/zoteroPane.xhtml)]
- 因此**拖动行为由 Firefox 内建 splitter 实现负责**（XUL flex 布局）。本次未取得当前 mozilla-central 中 splitter 实现的可用全文（`searchfox` 路径已变更、`hg.mozilla.org` 返回 406），故不对其是否使用 overlay 下结论。[未取得]
- 可引用的一手性能证据：Zotero 对**侧栏宽度变更**做 500ms debounce（§1.4）；item pane 在 `handleResize()` 里对 width/height 做最小尺寸钳制（337×205）。[源码] [[itemPane.js](https://github.com/zotero/zotero/main/chrome/content/zotero/elements/itemPane.js)]
- 未在 Zotero 7 源码里发现 `ResizeObserver` 的使用（对 `itemPane.js`/`noteEditor.js`/`zoteroPane.js` 计数为 0）。[源码]

### 1.12 用 CSS containment 隔离失效范围

- **解决什么**：拖动期间让「重排/重绘」不跨面板传播，同时让面板内容溢出被裁剪（配合 §1.5 的钉宽度）。
- **本项目已用**：拖动期间给 `.dv-view` / `.dv-render-overlay` 加 `contain: layout paint`。[源码] [index.css](src/index.css)
- **平台注意事项**：`contain: layout` 会创建包含块/层叠上下文，可能影响 `position: fixed` 子元素、以及某些测量（`offsetParent`）；Dockview 的 `Resizable` 就用 `!element.offsetParent` 判定 `display:none`。[源码]
- **[推断]** 对 WKWebView，`contain: paint` 的收益主要是「裁剪 + 减少重绘传播」；是否像 Chromium 那样显著减少 layout 工作量，需要实测（WKWebView 没有 Chromium 的 layout containment 快速路径的公开证据）。

### 1.13 `content-visibility: auto` + `contain-intrinsic-size`：按引擎门控

- **解决什么**：让视口外的顶层块跳过布局与绘制，长文档滚动/换行成本大幅下降（Chromium/Gecko）。
- **WebKit 的反例**：WebKit #276735「[content-visibility] Consider using a threshold for `content-visibility: auto`」仍为 open/new。[一手] [[WebKit #276735](https://bugs.webkit.org/show_bug.cgi?id=276735)]
- **本项目做法（值得保留）**：`html[data-offscreen-md-blocks]` 属性由 `initPaintOptimizations()` 按引擎开启，WebKit 下**不启用**；`contain-intrinsic-size: auto 4rem` 缓存实测高度。[源码] [paint-perf.ts](src/lib/core/paint-perf.ts)、[index.css](src/index.css)
- **代价**：首次出现的块用 fallback 高度会造成滚动条跳动；`:focus-within` 期间关闭以避免编辑/IME 语义变化（仓库已这么做）。

### 1.14 ResizeObserver 反馈环 / 抖动：已知陷阱与规避

- **真实事故（Dockview #1219 / PR #1233）**：多显示器、非整数 `devicePixelRatio` 下，`entry.contentRect` 返回小数并在每次触发间漂移；`layout(width,height)` 又把像素尺寸写回子元素 → 再次触发 observer → 再次 layout，形成**持续数分钟、CPU 打满**的反馈环。修法：三处 `watchElementResize` 调用点把 `contentRect.{width,height}` **四舍五入**，且与上次投递相同则**跳过 layout**（代价：2 次 `Math.round` + 2 次整数比较，无 DOM 读）。[一手] [[PR #1233](https://github.com/dockview/dockview/pull/1233)] [源码]（本地 `dockview-core/dist/cjs/resizable.js` 注释同样说明「Round to integers to absorb sub-pixel jitter ... which would otherwise re-fire layout in a feedback loop」）
- **Dockview 还对所有观察做了 rAF 延迟**：`watchElementResize` 的 ResizeObserver 回调里再 `requestAnimationFrame(() => cb(entry))`，注释说明「快速窗口缩放会产生 `ResizeObserver loop limit exceeded`，错误不可见但**会降低性能**」，并引用 StackOverflow 的经典解法（在 rAF 里处理以断开「同一帧内再次触发」的链路）。[源码]（`dockview-core/dist/cjs/dom.js`）+ [一手] [[SO 49384120](https://stackoverflow.com/questions/49384120/resizeobserver-loop-limit-exceeded/58701523#58701523)]
- **Web 平台语义**：`ResizeObserver loop completed with undelivered notifications` 是「防止浏览器卡死」的保护机制——未投递的通知被延后而不是丢失。[一手] [[StackOverflow](https://stackoverflow.com/questions/76187282/how-to-fix-resizeobserver-loop-completed-with-undelivered-notifications)]、[[TrackJS](https://trackjs.com/javascript-errors/resizeobserver-loop-completed-with-undelivered-notifications/)]
- **规避清单（可直接照做）**：
  1. **取整 + 去重**：`Math.round(width/height)`，与上次相同直接 return（Dockview 同款）；
  2. **observer 回调里不写布局**：把写入推到 rAF（Dockview/VS Code 同款）；
  3. **不要让「写尺寸」的代码路径再次触发同一 observer**：例如 `content-visibility`/`contain` 造成的尺寸回写要用固定外框、不要用内容反推容器；
  4. **区分 box**：需要含边框用 `{ box: 'border-box' }`（TanStack Virtual 就这么做），避免 `contentRect` 与样式写入互相追赶；
  5. **加「拖动中」门闩**：拖动期间直接跳过一次回调（本项目 PDF gate 就是这么做的）。
- **本项目已有对应实现**：`createPdfViewportResizeGate()` —— rAF 合并 + 拖动期间挂起 + 结束时只提交一次。[源码] [dockview-resize.ts](src/lib/pdf/dockview-resize.ts)

### 1.15 避免 React 因「每帧容器尺寸」重渲染

- **反例（本项目侧栏）**：`react-resizable-panels@4.12.2` 在 `pointermove` 里计算 layout 并**逐帧触发面板 `onResize`**，面板尺寸通过 React style 的 `flexGrow` 落地（`dist` 内 `flexGrow: E.layout[P] ?? 1`）；本项目 `App.tsx` 的 `onResize` 会在拖动中读写 `useState`（`setSidebarCollapsedState`）。[源码]
  - 库本身用了 pointer capture（`i.setPointerCapture?.(e.pointerId)`），所以事件流没问题；**问题是每帧的 React 渲染与状态写入**。[源码]
- **手法**：拖动中把尺寸写入 ref / CSS 变量，只在 `onResize` 的「结束」时刻（或跨过阈值时）写 state；对大组件用 `React.memo`/`useSyncExternalStore` 或直接改写 DOM 属性。[推断]
- **VS Code 的对照**：它完全不用 React 做布局，尺寸是命令式 DOM 写入。[源码]

### 1.16 参考实现：react-resizable-panels 的约束模型（可借鉴，非性能手段）

- 面板约束归一化（`minSize/maxSize/collapsedSize` + `groupResizeBehavior: preserve-pixel-size | preserve-relative-size`）在拖动时会保留像素宽度、按比例换算；本项目已用 `preserve-pixel-size` 来保证侧栏宽度在 Notes 列切换时不被改变。[源码]

---

## 2. 平台层：Chromium / WebKit / WKWebView 在 live-resize 期间的行为差异

> 这一节多数结论依据的是**引擎源码或官方文档的一手材料**；凡是没读到实现的地方，我会标 [未取得]/[推断]。

### 2.1 WKWebView（macOS）与 Chromium 的关键差异

| 维度 | Chromium（Electron/Chrome） | WebKit（WKWebView/Safari） |
|---|---|---|
| 窗口缩放期间的内容呈现 | 有 viewporter 等机制复用输出表面减少分配；Windows/ANGLE 路径曾有旧帧残留 bug | AppKit 默认开启 live-resize 优化：`NSWindow.preservesContentDuringLiveResize` **默认打开**，会「保留未变化视图的内容」[一手] [[Apple](https://developer.apple.com/documentation/appkit/nswindow/preservescontentduringliveresize)]；`NSView` 版本说明视图可自行决定重绘范围并用 `setFrameSize(_:)` 精确失效 [[Apple](https://developer.apple.com/documentation/appkit/nsview/preservescontentduringliveresize)] |
| `content-visibility: auto` | 有效，Chromium 会提前约一屏半布局 | WebKit 明显更慢，#276735 open [一手] |
| 帧率上限 | 常规 60/120 取决于合成器 | Tauri/WKWebView 在 macOS 上被报告**锁在 60FPS**（Safari/Chrome 可 120），讨论中无官方结论 [一手] [[tauri#8436](https://github.com/orgs/tauri-apps/discussions/8436)] |
| 滚动/渲染微卡 | — | 有「同一 WKWebView 版本、Safari 流畅而 Tauri 微卡」的报告，社区猜测与 webview 配置有关，**未确认** [一手] [[tauri#8436](https://github.com/orgs/tauri-apps/discussions/8436)] |
| 拖动窗口时的「缩放旧内容」 | Electron 有窗口 resize 相关的合成器修复史 [一手] [[Electron Tech Talk](https://www.electronjs.org/blog/tech-talk-window-resize-behavior)] | 依赖 AppKit 的 content preservation；**WKWebView 是否真的走「拉伸旧帧」路径，我未在 WebKit 源码中找到证据** [未取得]/[推断] |

- **可直接验证的判据**：把窗口快速拉宽，观察文本是「立即按新宽度换行」还是「先被拉伸、松手才重排」。前者说明 WKWebView 在 live resize 期间同步重排，后者说明 AppKit 在缩放快照。[推断]（这是 AppKit content preservation 的可观察结果）
- **未取得**：WebKit 是否有「live resize 期间限流重排」的实现。已核对 `Source/WebKit/UIProcess/API/mac/WKView.mm` 里 `viewWillStartLiveResize`/`viewDidEndLiveResize` 为**空实现**；`WKWebViewInternal.h` 中的 `LiveResizeParameters`、`_callbacksDeferredDuringResize`、`_endLiveResizeTimer` 都在 `#if PLATFORM(IOS_FAMILY)` 内，即**iOS 专属**，macOS 无对应机制。[源码]
- **Chromium 侧的一手材料**：`WindowResizeHelperMac` 的存在与目的（「在 AppKit 绘制例程里等待合成器出同尺寸帧，让窗口尺寸与内容尺寸 lock-step」，通过可泵送的 task runner 实现）见 [源码] [[window_resize_helper_mac.h](https://chromium.googlesource.com/chromium/src/+/main/ui/accelerated_widget_mac/window_resize_helper_mac.h)]；`NativeWidgetMac::OnWindowWillStartLiveResize/OnWindowDidEndLiveResize` 会回调 delegate 的 `OnNativeWidgetBeginUserBoundsChange/OnNativeWidgetUserResizeStarted`（Chromium 侧有明确的 live-resize 生命周期钩子）。[源码]
  - 相关性能问题：Chromium issue「Restrict window resize helper to active live resizes」指出 `WindowResizeHelperMac` 会在**非** resize 场景（如启动）被调用、单次耗时数百毫秒。[一手] [[issues.chromium.org/491158068](https://issues.chromium.org/issues/491158068)]
  - **[推断]** 这套机制解释了「Chromium 系在 macOS 上 resize 手感更好」的常见印象：它主动阻塞 UI 直到有匹配尺寸的帧，代价是可能阻塞主线程；WebKit 侧没有等价物，卡顿会直接体现为用户可见的停顿。
- **Electron 的历史教训（可迁移到 Tauri）**：Electron 9 曾因 `NSWindow` 内部方法被覆写（为了让 vibrancy 窗口有圆角）导致**整个窗口 resize 极卡**，即使没用 vibrancy；修复是删除该覆写（PR #24642，关闭 #23980）。[一手] [[PR #24642](https://github.com/electron/electron/pull/24642)] [[#23980](https://github.com/electron/electron/issues/23980)]
  - **[推断]** 同类风险在 Tauri：如果窗口开了 `transparent`/私有 API 特效/自绘装饰，可能命中与「窗口合成」相关的慢路径。Tauri 上有一条**未确认**的 Windows 观察：`transparent: true` 反而改善 resize 并消除黑/白边条（[tauri#13270](https://github.com/tauri-apps/tauri/issues/13270)）。macOS 上是否有同类效应**没有找到证据**。
- **Tauri 相关的真实主线程噪声**：Tauri 2 的 `window:default` 权限会为鼠标移动触发 `internal_on_mousemove` IPC（每个 mousemove 一次往返），社区报告造成卡顿与光标闪烁（[tauri#8770](https://github.com/tauri-apps/tauri/issues/8770)，已在 2.0.0-beta 后关闭）。[一手]
  - **行动项**：核查本项目 capabilities 是否保留 `window:default`（尤其是 `allow-start-dragging`/`internal_on_mousemove` 链路）；若使用自绘标题栏拖动，考虑改用 Tauri 的 `startDragging` 而不是自己实现 mouse 跟随。[推断]

### 2.2 窗口边缘拖动为什么会「打穿所有面板」

链路（本项目现状，[源码] 标注处为仓库文件）：

```
AppKit 拖拽窗口边缘
  → WKWebView 尺寸变化
    → 每个面板的 ResizeObserver（Dockview Resizable / PDF viewport / 虚拟列表 / 编辑器）
      → Dockview group.layout() → 面板 layout() → React 渲染
      → 内容按新宽度重排（Plate 整篇 re-wrap；PDF 重新布局/重采样；虚拟列表重算 range）
      →（若组件写回 DOM 尺寸）→ 再次触发 ResizeObserver → §1.14 的反馈环风险
```

对比 sash 路径：`pointerdown on .dv-sash` → `beginDockResize()`/`freeze.begin()` → 只影响被拖动的那条链。

**关键差距**：本仓库的冻结/挂起门闩**只挂在 sash 手势**上——`installDockviewSashFrameLoop()` 通过 `isDockviewSashTarget(event.target, root)` 判定 `.dv-sash` 才开始 `hooks.onSashDragBegin`；`dockview-viewport.tsx` 的 `handlePointerDown` 同样要求 `isDockviewSashTarget(...)`；`markdown-resize-freeze` 也由 sash 触发。**因此拖窗口边缘时没有任何冻结生效**，这很可能就是「拖窗口也卡」的直接原因。[源码]

---

## 3. 针对本项目（Tauri 2 + Dockview 7 + 长 Markdown/PDF）的推荐优先级清单

> 前置说明：下列 P0 各项都是**补齐「窗口 resize」路径**，因为 sash 路径上仓库已经做了 rAF 合帧、宽度冻结、contain、PDF gate。改前先按 §4 做一次区分性测量。

### P0（先做，收益最大且改动局部）

1. **把已有门闩扩展到「窗口 live-resize」**：监听 `window` 的 `resize`（以及 Tauri `onResized`），用一个「窗口手势进行中」状态驱动与 sash 相同的三件事：
   - `createMarkdownResizeFreeze().begin()/end()`（钉住编辑器内容宽度）；
   - `createPdfViewportResizeGate().beginDockResize()/endDockResize()`（挂起 PDF 提交）；
   - 在根节点加 `.agentero-dock-sash-active` 等价类（获得 `contain: layout paint` + `user-select: none`）。
   结束判定：`resize` 事件停止 **120–200ms** 后（Obsidian 插件用 120ms、CM6 用 50/75ms、Zotero 用 500ms，建议取 150ms 起步并实测）。依据：§1.4、§1.5、§1.12。
   - **代价**：拖动中内容保持旧宽度（需要裁剪）；若用户在拖动中滚动/阅读，会看到未重排的内容。
   - **风险**：`resize` 在 WKWebView 上可能晚于实际绘制；用「时间戳 + rAF」而不是事件计数来判定结束。

2. **给侧栏（react-resizable-panels）的 `onResize` 加「拖动中不写 state」**：拖动期间写 ref/CSS 变量，`pointerup`（或 `onResize` 的最后一次）再写 state。依据：§1.15（该库每个 pointermove 都触发 `onResize`，且用 React style 写 `flexGrow`）。

3. **ResizeObserver 回调全面「取整 + 去重 + rAF」审计**：仓库共 10 个文件出现 `ResizeObserver`（`use-tree-reveal.ts`、`viewport-floating.tsx`、`doctor-line-fit.ts`、`papers-library.tsx`、`use-transcript-virtualizer.ts`、`dockview-viewport.tsx`、`selection-chat-popover.tsx`、`selection-annotation-badges.tsx`、`responsive-toolbar.tsx`、`dockview-resize.ts`），建议统一走一个工具函数：`Math.round` → 与上次比较 → 相同 return → 否则推到 rAF 执行。依据：§1.14（Dockview #1219 是同一根因的真实事故）。

### P1（结构性收益）

4. **虚拟列表（`use-transcript-virtualizer.ts`）在 resize 期间冻结 range**：resize 中不重算可见区间，结束后一次 `measure()`；并考虑开启 TanStack Virtual 的 `useAnimationFrameWithResizeObserver`。依据：§1.8。

5. **PDF 面板在窗口 resize 期间降到「只变换不重排」**：拖动中固定 canvas 的 CSS 尺寸（或复用旧位图做缩放），松手再按新宽度重渲染当前页；避免每帧触发 PDFium 渲染/文本层重建。依据：本仓库 PDF gate 的现有形态（§1.14）+ [推断]。

6. **给重面板加 `contain: layout paint`（或 `content-visibility` 门控）常态化**，而不仅在拖动期间；WebKit 下继续排除 `content-visibility: auto`。依据：§1.12、§1.13（WebKit #276735）。

7. **DMG/窗口层核查**：确认窗口没有不必要的 `transparent`/自绘装饰/私有特效路径（Electron #23980 的前车之鉴）；核查 capabilities 是否留存 `window:default` 带来的 mousemove IPC。依据：§2.1。

### P2（锦上添花 / 需要更多实测）

8. **手势期间把昂贵的 React 渲染降级**：对 `dock-workspace.tsx` 里 `api.onDidLayoutChange`、`onDidDimensionsChange` 引发的 store 写入做「手势内合并」。
9. **测量拖动期间的 Long Task 分布**（§4），确认是否还有 PDF 之外的第三方热点（EmbedPDF 插件、`papers-library` 表格、`selection-overlay`）。
10. **可选：拖动期间隐藏/降采样「非活动面板」**（如把非当前 PDF 页替换为静态位图）。这接近 gh/overlay 思路，但成本是视觉降级；**没有找到成熟应用采用纯 overlay 代理的证据**，因此不建议作为首选。

---

## 4. 如何验证（避免拍脑袋）

1. **区分两条路径**：分别测「拖 Dockview 分隔条」和「拖窗口右下角」。若只有后者卡，问题一定在 §2.2 的链路。
2. **区分「JS 占主线程」与「样式/布局占主线程」**：Performance 面板录制手势，看 Main 轨道里是 `Function call`（JS）还是 `Recalculate Style / Layout / Paint`（渲染）。这决定是修内容重排还是修布局隔离。
3. **量化「每帧成本」**：在 `ResizeObserver` 回调、`ResizeObserver` → React 渲染、编辑器 re-wrap 三处各打一对 `performance.mark/measure`，用 `PerformanceObserver({type:'longtask'})` 统计 >50ms 的任务数与来源。
4. **对照实验**：
   - 关闭 PDF 面板后重测（验证 PDF 是否为热点）；
   - 打开一个 10 行短笔记替代长 Markdown（验证 re-wrap）；
   - 在 Safari 里用 `vite dev` 打开同一页面拖窗口（验证是否 WKWebView 特有）——注意 Safari 与 WKWebView 并非完全等价（[tauri#8436](https://github.com/orgs/tauri-apps/discussions/8436) 报告的差异说明二者行为可能不同）。
5. **防止回归**：给 §1.14 的「取整去重」与 §3.1 的窗口手势门闩各写一个单测（仓库已有 `dockview-sash` 的纯函数风格可以照抄）。

---

## 5. 一手材料索引

### 5.1 VS Code

- `SplitView`（绝对定位、sash 变更、relayout）：<https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/splitview/splitview.ts>
- `splitview.css`（`position: absolute`）：<https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/splitview/splitview.css>
- `Sash`（iframe 屏蔽、cursor 注入、document 级 move/up）：<https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/sash/sash.ts>
- `GlobalPointerMoveMonitor`（pointer capture + window 回退 + buttons 判定）：<https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/globalPointerMoveMonitor.ts>
- `ElementSizeObserver`（ResizeObserver → 每帧一次）：<https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/config/elementSizeObserver.ts>
- `CodeEditorWidget.layout(dimension, postponeRendering)`：<https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/widget/codeEditor/codeEditorWidget.ts>
- `EditorView._scheduleRender` / `EditorRenderingCoordinator`：<https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/view.ts>
- `GridView`（SplitView 树）：<https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/gridview.ts>
- 相关 issue/PR：#258514（扩展标签页导致窗口 resize 卡）、#169142、#165835、#25924、PR #328462（Modern UI resize & startup）、PR #336345（chat window resizing）

### 5.2 Joplin

- `ResizableLayout.tsx`：<https://github.com/laurent22/joplin/blob/dev/packages/app-desktop/gui/ResizableLayout/ResizableLayout.tsx>
- `useWindowResizeEvent.ts`（窗口 resize 500ms debounce）：<https://github.com/laurent22/joplin/blob/dev/packages/app-desktop/gui/ResizableLayout/utils/useWindowResizeEvent.ts>
- `LayoutItemContainer.tsx`（re-resizable）：<https://github.com/laurent22/joplin/blob/dev/packages/app-desktop/gui/ResizableLayout/LayoutItemContainer.tsx>
- `utils/style.ts`（styled-components `.attrs` 规避 style 实例爆炸）：<https://github.com/laurent22/joplin/blob/dev/packages/app-desktop/gui/ResizableLayout/utils/style.ts>

### 5.3 Obsidian

- `binaricat/smooth-window-resize` 源码（120ms trailing debounce 包 `MarkdownPreviewView.onResize`）：<https://github.com/binaricat/smooth-window-resize/blob/main/src/main.ts>
- 插件页（150KB 长文测量、机制、限制说明）：<https://community.obsidian.md/plugins/smooth-window-resize>
- 相关社区 issue（sidebar 折叠动画与 resize handle 残留）：<https://forum.obsidian.md/t/horizontal-workspace-leaf-resize-handle-persistence-during-right-sidebar-collapse-animation/63510>
- 长文档变慢反馈：<https://forum.obsidian.md/t/obsidian-becomes-slow-when-working-with-large-web-content-notes/119045>

### 5.4 Zotero 7 / Firefox

- `zoteroPane.xhtml`（原生 `<splitter>` + `resizebefore/after` + `collapse`）：<https://github.com/zotero/zotero/blob/main/chrome/content/zotero/zoteroPane.xhtml>
- `itemPane.js`（`handleResize` 最小尺寸钳制）：<https://github.com/zotero/zotero/main/chrome/content/zotero/elements/itemPane.js>
- `xpcom/reader.js`（侧栏宽度 500ms debounce）：<https://github.com/zotero/zotero/blob/main/chrome/content/zotero/xpcom/reader.js>
- 未取得：mozilla-central 当前 splitter 实现全文（searchfox 路径变更 / hg raw 406）

### 5.5 Dockview（本项目实际依赖，7.0.4）

- issue #1219（多显示器非整数 DPR 下 resize 反馈环，CPU 打满）：<https://github.com/dockview/dockview/issues/1219>
- PR #1233（取整 + 去重修复）：<https://github.com/dockview/dockview/pull/1233>
- release v6.0.3 说明：<https://github.com/dockview/dockview/releases/tag/v6.0.3>
- 本地源码：`node_modules/.pnpm/dockview-core@7.0.4/.../splitview/splitview.js`（sash 拖动每帧同步 layoutViews）、`dom.js`（`watchElementResize` rAF 延迟 + 反馈环注释）、`resizable.js`（取整去重）

### 5.6 编辑器与虚拟列表

- CodeMirror 6 `domobserver.ts`（ResizeObserver + 75ms 新鲜度 + 50ms setTimeout）：<https://github.com/codemirror/view/blob/main/src/domobserver.ts>
- CodeMirror 6 `editorview.ts`（`requestMeasure` rAF 合帧、measure/read 分离）：<https://github.com/codemirror/view/blob/main/src/editorview.ts>
- CodeMirror 6 `docview.ts`（`measureVisibleLineHeights` 读 `contentDOM.clientWidth`、`minWidth` 缓存）：<https://github.com/codemirror/view/blob/main/src/docview.ts>
- ProseMirror `domobserver.ts`（MutationObserver + 20ms `flushSoon`）：<https://github.com/ProseMirror/prosemirror-view/blob/master/src/domobserver.ts>
- TanStack Virtual `virtual-core/index.ts`（`observeElementRect`、`useAnimationFrameWithResizeObserver`、`createFrameQueue`）：<https://github.com/TanStack/virtual/blob/main/packages/virtual-core/src/index.ts>
- 参考文档：<https://tanstack.com/virtual/latest/docs/api/virtualizer>

### 5.7 平台层

- Apple：`NSWindow.preservesContentDuringLiveResize`（默认开启）：<https://developer.apple.com/documentation/appkit/nswindow/preservescontentduringliveresize>
- Apple：`NSView.preservesContentDuringLiveResize`（视图自定义重绘范围 + `setFrameSize(_:)`）：<https://developer.apple.com/documentation/appkit/nsview/preservescontentduringliveresize>
- Chromium `window_resize_helper_mac.h`（live resize 时 UI 线程等待同尺寸帧）：<https://chromium.googlesource.com/chromium/src/+/main/ui/accelerated_widget_mac/window_resize_helper_mac.h>
- Chromium issue：WindowResizeHelperMac 在非 live-resize 场景耗时数百毫秒：<https://issues.chromium.org/issues/491158068>
- WebKit `WKView.mm`（`viewWillStartLiveResize`/`viewDidEndLiveResize` 空实现）：<https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/mac/WKView.mm>
- WebKit `WKWebViewInternal.h`（`LiveResizeParameters` / `_callbacksDeferredDuringResize` 均在 `PLATFORM(IOS_FAMILY)` 内）：<https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewInternal.h>
- WebKit #276735（`content-visibility: auto` 需要阈值）：<https://bugs.webkit.org/show_bug.cgi?id=276735>
- Tauri discussion #8436（WKWebView 微卡、疑似 60FPS 上限）：<https://github.com/orgs/tauri-apps/discussions/8436>
- Tauri #8770（`internal_on_mousemove` IPC 造成卡顿）：<https://github.com/tauri-apps/tauri/issues/8770>
- Tauri #13270（Windows：`transparent: true` 反而改善 resize，未确认是否适用 macOS）：<https://github.com/tauri-apps/tauri/issues/13270>
- Electron Tech Talk：Improving Window Resize Behavior（合成器/viz 层的 resize 修复方法论、调试 flag）：<https://www.electronjs.org/blog/tech-talk-window-resize-behavior>
- Electron #23980 + PR #24642（NSWindow 覆写导致整窗 resize 卡顿）：<https://github.com/electron/electron/issues/23980>、<https://github.com/electron/electron/pull/24642>
- wry `src/wkwebview/mod.rs`（macOS webview 尺寸同步实现）：<https://github.com/tauri-apps/wry/blob/dev/src/wkwebview/mod.rs>

### 5.8 未取得 / 未确认（缺口清单）

- Firefox/mozilla-central splitter 的当前实现全文（无法判断其拖动是否使用 overlay）。
- WebKit macOS 是否有「live resize 期间限流重排」的实现（已确认 iOS 有，macOS 未找到）。
- WKWebView 是否走 AppKit content preservation 的「缩放旧帧」路径（无一手证据，只能实测观察）。
- Logseq（`left_sidebar.cljs` 已抓取但未形成可引用的一手结论）、Notion、Heptabase：**未找到关于拖动分隔条/窗口 resize 的一手工程材料**。
- `react-window` / `react-virtualized` 的 resize 处理源码未取得。

---

## 6. 事实 / 推断分界（速查）

| 结论 | 性质 |
|---|---|
| VS Code / Dockview / Joplin 拖动分隔条时**实时改真实布局**，无 ghost overlay | 源码事实 |
| VS Code 编辑器容器 resize 用 ResizeObserver + rAF「每帧一次」 | 源码事实 |
| Dockview 7 的 sash pointermove **同步**跑 `resize + layoutViews`，无 rAF、无 pointer capture | 源码事实 |
| Dockview 的 ResizeObserver 统一 rAF 延迟 + 取整去重（#1233） | 源码事实 + PR 原文 |
| Obsidian 官方 Reading 视图每帧重算长文档；社区插件以 120ms trailing debounce 收敛为一次 | 插件源码 + README（非官方源码） |
| CM6：resize → 75ms 新鲜度 → 50ms 超时 → rAF measure | 源码事实 |
| PM/Plate **没有** ResizeObserver，宽度变化由浏览器重排 | 源码事实 |
| Zotero 7 使用 Firefox 原生 splitter；侧栏宽度写入 500ms debounce | 源码事实 |
| Zotero 拖动 splitter 的具体实现（含是否 overlay） | **未取得** |
| 「拖动期间冻结内容宽度、松手再重排」= Obsidian 插件 / Zotero / CM6 的共同思路 | 有据可查 |
| 「拖动期间只移动 overlay/ghost、松手才改布局」= 成熟应用的通行做法 | **不成立**（未找到任何一手证据）；真实存在的是「布局实时 + 内容落定后一次」 |
| macOS 的 WKWebView 在 live resize 期间是否走 AppKit content preservation | **未确认**（可实测） |
| Chromium 在 macOS 上用 `WindowResizeHelperMac` 让窗口与内容 lock-step | 源码事实 |
| Chromium 系手感优于 WKWebView 是因为该 lock-step 机制 | **[推断]** |
| 窗口 resize 会同时打穿所有面板的 observer，因此不能靠 sash 优化覆盖 | **[推断]**（依据：本项目门闩只挂 sash；ResizeObserver 分发语义） |
