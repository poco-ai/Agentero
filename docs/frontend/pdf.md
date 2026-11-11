# PDF 阅读与划词

笔记中的 PDF 章节/段落嵌入通过 `embeddedTarget` 传入共享解析器的定位结果，复用 layout-ready 导航，在嵌入内部持续绘制原始 bbox 的浅色高亮，降低填充和边框强度以保持文字清晰。文档 ID 按嵌入实例隔离，高亮通过查看器 props 传给页层，不使用全局临时焦点，也不生成永久批注；普通重渲染和缩放不重新触发目标跳转。PDF 嵌入关闭批注栏宽度预留（`reserveCommentRail={false}`），默认按容器页宽缩放，随容器调整自动适配；主阅读器保留批注栏空间。语法见 [wiki.md](wiki.md#pdf-段落导航)。

论文主 PDF 的嵌入复用主阅读器的批注、视觉备注与保存逻辑，共用原论文 `marks/annotations.json` 和各标记文件。独立文档实例通过按论文目录分组的本地批注事件同步增改删；初次加载期间排队接收变更，新挂载实例重放尚未完成持久化的编辑。批注快照按请求顺序保存，卸载前刷新待保存内容，避免旧导出覆盖新快照。每文件标记保存后通知其他查看器刷新，保留文件监听的自身写入回声过滤。嵌入不占用批注栏宽度，悬停或编辑时将备注卡片放到页内；不改写主阅读器的上次阅读页。

初次标注文件读取、导入完成定时器和事件合并微任务均随所属订阅取消；文件监听重导入也取消完成定时器。文档快速关闭或替换后，迟到任务不再读取已销毁的 EmbedPDF annotation plugin；被中断的首次导入在下一次 effect setup 可重启。保存已有用户编辑的卸载 flush 保持独立，不能简单跳过全部 cleanup。

原生链接内容去重统一顶层可选字段的 `null` 与省略形式，并将空 transfer context 视为未设置；保留目标和嵌套 metadata 中有意义的 `null`。这样 PDFium 原生链接与 JSON sidecar 往返后仍可对齐，不会每次保存重开都叠加点击层；不同位置、样式、目标及用户高亮继续分别保留。

## 渲染 vs 解析

| 层 | 位置 | 职责 |
|---|---|---|
| **渲染** | 前端 EmbedPDF + PDFium | 展示页面、缩放、翻页、选区 |
| **解析** | Host liteparse 等 | 生成 `PAPER.md`、Agent 可读正文（与预览分离） |

任意 Vault 路径 `.pdf` 可 `blob:` 预览；论文单元：本地优先 → 自动下载（JobCenter `downloadAssets` job，Host 续接 PAPER.md / 版面分析）→ 远程 `pdf_url` 回退。打开论文时 Host 的 PAPER.md / 参考文献 reconcile（ParseBody / ParseRefs）任务改到 idle 触发，不占 PDF 首屏。HTML 由阅读器直接向 arXiv 拉取并嵌入，样式、脚本和图片仍从 arXiv 加载，不经过会把失败一律显示成 `arXiv unavailable` 的本地代理。有 HTML 时打开对应页面；404 视为尚未生成，网络失败和无效地址分开提示，可回到 PDF 或打开摘要。普通网页条目打开 HTML 并创建 `NOTES.md` 分屏；旧条目缺少 `html_url` 时从 `source_url` 兜底。

阅读器 PDFium engine 由窗口共享；后台版面分析与页数探测共用另一实例，两者统一通过 `src/lib/pdf/engine.ts` 创建。全文翻译的重排构建另有一个按需创建的专用实例（见下文双栏段落），构建结束后自动释放。默认优先 **worker 引擎**（PDFium WASM 跑在 Web Worker，降低主线程光栅开销；出图仍需位图转换与 WebView 合成）；启动时经 `whenReady()` 就绪握手 + 8s 超时探针验证（`@embedpdf/engines` patch 同时把 worker 侧 `wasmError` / `onerror` 暴露为就绪失败，不再静默挂起），失败则自动回退主线程 direct engine 并记住结论（旧版库的 worker 变体在 Tauri WebView 下就绪消息丢失，表现为文档永远“正在加载”）。wasm URL 传给 worker 前先解析为绝对地址（blob worker 不能按页面基址解析相对路径）。对未嵌入字体的 PDF，Host 按 macOS / Windows / Linux 的系统字体路径读取一个本机 CJK 字体，通过本地 `blob:` URL 提供给 PDFium；移动端和找不到可读字体时安全跳过，不产生外部字体请求。Engine 宿主位于 React StrictMode 外；失败或超时直接销毁未就绪的 worker，卸载以 AbortSignal 中断握手，迟到的 direct 初始化结果也会销毁。卸载中止不会被记成 worker 不兼容。direct factory 本身返回 Promise，直接 await；Task 使用上游 `toPromise()`，不再补 readiness 或另包回调。工作区只挂载当前可见与最近使用的至多两个 PDF viewer；恢复的隐藏 PDF 标签按需 hydrate，退出保留集合的本地 PDF 字节会释放并在再次激活时重新读取。Document Manager 补丁跟踪异步打开任务：阅读器在加载中卸载时，等待打开结算并关闭迟到的文档；同一 scope 的重复关闭合并为一次释放，保留其他 pane 的引用。避免 StrictMode 或快速切换后遗留 WASM 文档，复现与验收见 [异步打开文档泄漏](../bug_fix/pdf-inflight-document-leak.md)。

阅读光栅采用 [EmbedPDF 官方推荐的低清底图 + 高清瓦片](https://www.embedpdf.com/docs/react/headless/plugins/plugin-tiling)。整页底图固定 `scale: 1`、`dpr: 1`，不随缩放重渲染；保留最近 24 页的 pinned 底图缓存，遮住缩放与回滚时的瓦片空档。高清 `TilingLayer` 按 `min(devicePixelRatio, 2)`（`pdfTileDpr`）出图，使用 `tileSize: 512`、上游默认 `extraRings: 0`，只请求当前视口的瓦片，减少单 PDFium worker 上的预渲染竞争。512px 将 DPR=2 的单块位图边长限制为 1024px，缩短重页面上不可抢占的同步光栅任务；像素密度、底图与上游瓦片生命周期不变。实测与复现见 [瓦片性能对照](../test/pdf-tiling-performance.md)。整页底图仅在页面进入视口时请求，离开时取消未完成请求，避免 Scroller 缓冲区的屏外重页以 CRITICAL 优先级排在可见瓦片和框选裁剪之前；已有 pinned 底图照常复用。取舍与浏览器 A/B 见 [可见页面优先性能对照](../test/pdf-visible-rendering-performance.md)。

viewport 始终上报滚动容器的真实尺寸，使放大或与笔记分屏时，右侧可见区域也有高清瓦片（#827）。评论列的 `rightGutter` 只通过 zoom 补丁的 `viewportPaddingRight` 从缩放计算中扣除，保留适应宽度与缩放锚点所需的页外留白；手势预览使用同一阅读宽度（视口宽度减去左右 padding，右侧含评论列）。手势容器的居中 `marginLeft` 也按这个宽度计算：适应宽度时边距为 0。若按「只扣 viewport gap、不扣评论列」居中，适应宽度会多出约半栏宽的左边距，页面变宽后这条边距在布局完成后的 resize 回调里被收回，视角就在真实 zoom 提交后向右跳一段（#1042）。纯 PDF 与译文栏传 0，不预留评论空间。滚动容器固定预留滚动条槽（`scrollbar-gutter: stable`）：适应宽度按 `clientWidth` 反推 zoom，若滚动条在首屏排版后才出现，宽度会少约 12px 并触发第二次 fit，写作模式打开时表现为百分比来回跳一档。

`RenderPluginPackage` 配置 `defaultImageType: "image/bmp"`，让不透明的整页底图与阅读瓦片复用 2.14.4 已有的 BMP 快速路径（[上游 #557](https://github.com/embedpdf/embed-pdf-viewer/pull/557)），跳过 PNG 的 Canvas 编码。BMP 未压缩，单张 Blob 更大；瓦片由上游负责加载、取消和 URL 释放，不再在应用里额外缓存 32 张瓦片或协调双栏共享任务。Agent 区域裁剪显式指定 PNG，保持原格式。版本不变，也不修改引擎队列。

带 `/Rotate` 的页面：Document Manager 以 `normalizeRotation: true` 打开时，PDFium 返回的 `page.size` 是**未旋转内容空间**（MediaBox）的尺寸，`page.rotation` 保留 `/Rotate` 元数据——滚动布局、瓦片与底图光栅都按上游公式 `((page.rotation ?? 0) + coreDoc.rotation) % 4` 计算有效旋转，光栅只有叠加该旋转后才是正立显示。`renderPage` 内层 `PdfPageLayers` 使用 `PageLayout.rotatedWidth` / `rotatedHeight`（含 `/Rotate` 与手动旋转后的显示尺寸），第 90°/270° 页按横版页框呈现正立内容。该引擎语义由 `test/pdf-page-rotation.test.ts` 固化，改动旋转接线前先读它。`TilingLayer` 的 `dpr` 属性与瓦片旋转接线由 `@embedpdf/plugin-tiling` patch 提供：`renderTile` 把有效旋转传给引擎（否则 `/Rotate` 页瓦片内容侧躺），`TileImg` 用 `transformRect` 把未旋转空间的 `screenRect` 变换到旋转后容器再摆放（否则竖版瓦片几何溢出横版页框，视觉上两页重叠）。scroll / tiling 的 React 入口正常参与 Vite 预构建；lockfile 中的 patch hash 会使缓存失效，更新 patch 与安装后需重启长驻 dev 进程。WASM / worker 包仍单独排除预构建。

缩放占位复用上游 tiling reducer：只把已完成的旧尺度瓦片保留为 fallback，新瓦片完成后移除；不再额外保留任意上一套瓦片 1.5s，普通滚动移出的未完成瓦片可正常卸载并取消。marks 不再定时轮询，改由 Vault 文件监听（`vault:file-changed`，命中 `{paper}/marks/` 前缀，200ms 合并突发）触发刷新，配合激活时与窗口 focus 兜底；应用自身对 `marks/` 的写入会登记路径（3s TTL），其 watcher 回声直接跳过（写入方已更新内存态），mark 文件并发读取，读取结果仍做 JSON 指纹比对，内容未变不提交 state，避免整 viewer 重渲染。高亮派生态（视图模型 / 页边针锚点 / 链接分页图）的 annotation 事件按微任务合并后重建一次，批量导入 n 条不再逐事件 O(n²) 重建。

滚动路径开销（触控板一帧内可触发多次 scroll）另有两处收敛：viewport 滚动指标按动画帧合并后再 `setViewportScrollMetrics`（每次提交仍推出 scroller layout；挂载窗口未变时不再 `setState`，见下段）；layout hover 命中框与 Eye 调试框按 `hoverableLayoutRegionsByPage` / `rawLayoutRegionsByPage` 预先分页缓存，页渲染只做 `Map.get`，不再每页重跑一遍全文档 NMS。PDF viewport 的延迟跳转请求同样按帧合并，并在用户滚轮先发生时取消；虚拟页重排、缩放布局和双栏同步产生的程序化滚动不会触发取消；虚拟页节点换入换出时关闭浏览器 scroll anchoring，避免 Windows/WebView2 将阅读位置校正到首尾页（见 [bug_fix/pdf-windows-scroll-endpoint-jump.md](../bug_fix/pdf-windows-scroll-endpoint-jump.md)）。

双栏对照左右各挂一套 EmbedPDF，各自使用上游瓦片任务生命周期；两栏同一区域会各自出图，滚回已卸载的页面也会重新生成高清瓦片。`@embedpdf/plugin-scroll` patch 在挂载窗口（间距、总尺寸、页序与页尺寸）没变时跳过 scroller 的 `setState`，纯滚动不再让已挂载页整页重渲染。译文栏跳过整页底图 `AgenteroRenderLayer`，只留 `TilingLayer`，空档由页面壳垫色。译文段落的浏览器度量按框和文本缓存，一帧大约只量 5ms，页面滚出就取消还没做的度量。layout 比较器直接位于 scroll patch 内、各订阅维护自己的上次布局；不再经 `globalThis` 桥接应用模块，也不复制整个 Scroller。全文翻译流式期间批次 `onUpdate` 合并到一帧一次（rAF，非 DOM 宿主退化为同步直通），终局结果直接取代仍排队的合并项；重排预览会话仅在预览发布/吊销、busy 翻转或产出更新时通知重渲染，批次到达本身不再触发，页签名中的 regions 以对象身份参与比较、按 regions 数组缓存分页分组。重排构建（prepare 字符提取、逐页预览、终局导出）不走 viewer 引擎：`ReflowBuildEngine` 懒创建一个专用 PDFium worker 并持有源文档的私有副本，构建期间滚动瓦片不再排在构建请求后面；worker 不可用时回退共享引擎，队列排空 30 秒后释放专用实例（约 25–35 MB），重启翻译按需重建。

页面纸张壳（正文与双栏译文）保留 `ring-1` 细边框，不使用整页 `shadow-sm` 模糊阴影。Linux / WebKitGTK 的 0.12.0 实测中，单独去掉该阴影可显著减少滚动长帧；无需调整位图分辨率或滚动调度。复现、测量边界和版本回归检查见 [PDF 页面阴影与 WebKitGTK 滚动停顿](../bug_fix/pdf-webkit-page-shadow.md)。

## 阅读能力

启用 Vim 模式与 PDF Vim 按键后，依次输入页码，再按 `Shift+G` 可跳到对应 PDF 页，例如 `1` → `2` → `Shift+G` 跳到第 12 页。每次数字输入续期 1.2 秒，最后一个数字到 `G` 也需在此期限内；按下 `Shift` 保留页码，但不延长期限。单独 `G` 跳到末页，`gg` 跳到首页。选区菜单打开且有高亮按钮时，`1–5` 优先选色；关闭菜单后恢复数字跳页。

| 能力 | 说明 |
|---|---|
| 缩放 | 键盘 `+`/`=` 放大、`-` 缩小（10% 一档，50%–300%；仅 PDF 拥有键盘时，输入框内不生效；`⌘+`/`⌘-` 仍是界面缩放）。底部栏滑动条调节 50%–300%（旁显示当前百分比；静止为灰色，hover / 聚焦 / 拖动时为 brand 主题色），滑动条右侧另有适应宽度 / 适应整页按钮；另支持 ⌘滚轮、触控板捏合；真实 scale 重渲染。默认仍以适应宽度打开。⌘滚轮 / 触控板捏合在手势期间**只做 CSS transform 预览**（缩放 ZoomGestureWrapper 那层 div，`transform-origin: 0 0`）；窄页面维持阅读器的自动居中，页面开始横向溢出后在约 30% 阅读区宽度内平滑过渡至以手势点为锚。松手或滚轮静默 150ms 后**只提交一次真实 zoom**（`requestZoom(目标, 指针位置)`，`clampZoomPreviewScale` 把它夹在 50%–300%）；提交会等待虚拟 scroller 发布目标页的新尺寸，在同一绘制帧用手势所在 PDF 点校正 scroll 后再撤掉 transform，避免预览与真实居中布局交接时的横向跳变。一次提交是必须的，不是优化：每次真实 zoom 都会重排 scroller 并在下一帧投递一个视口 scroll 请求，逐帧提交会不断覆盖自己的锚点、最终把视口推向文档开头；而按 10%–20% 固定档位跳格又让慢速捏合看起来毫无响应。wheel 监听不常驻 non-passive（`bindZoomGesture`）：普通滚动手势期间切成 passive，滚轮静默后再换回 non-passive，保证捏合缩放仍可 `preventDefault`，同时普通滚动不被主线程阻塞。WebKit（Safari / macOS WKWebView）的触控板捏合不以 ctrl+wheel 送达，而是 `gesturestart/change/end`，`bindZoomGesture` 用同一组 start/change/end 回调上报相对手势起点的 magnification 并 `preventDefault` 抑制平台放大，`gestureend` 丢失时由 1.2s 看门狗兜底提交。页内覆盖卡片与页面保持固定比例：左上翻译 tab 与右侧评论列在未缩放的页面坐标里排版，再用布局级 `zoom` 按当前比例放大整层，字体、图标与内边距按目标比例重新排版后再绘制（`transform: scale` 拉伸的是已栅格化的层，backdrop-blur 玻璃面会发糊）；50% 时同步减半，300% 时同步放大；Ask / 翻译 / 视觉批注浮卡保持固定 UI 尺寸与字号；其屏幕锚点仍随 PDF 缩放更新，定位与最大高度继续受视口约束 |
| 导航 | 底部页码 pill、PageUp/Down、Home/End；指针悬停或焦点落在阅读区时 `↑`/`↓` 在连续模式按行滚动、在逐页 / 横向模式翻到上一页 / 下一页（`KeyboardScrollHandler`；输入框、菜单、目录、文件树与 PDF 工具栏保留原生方向键） |
| 版式 | 设置 → 通用：「PDF 翻页模式」纵向连续 / 横向连续 / 多页网格 / 逐页切换（#701）与「PDF 页面版式」单页 / 双页奇数 / 双页偶数（`@embedpdf/plugin-spread` 的 `SpreadMode`）。偏好存 Host `settings.json`（`pdfScrollStrategy` / `pdfSpreadMode`），经 `settings:changed` 广播，已打开的阅读器与双栏译文面板实时跟随（`usePdfReadingMode` 按文档 scope 调 `setScrollStrategy` / `setSpreadMode`，切换后保留当前页）。逐页模式只绘制当前页，复用 EmbedPDF 纵向坐标与虚拟占位；滚轮在放大页内滚动，到边界后下一次滚动翻页，一次触控板手势至多翻一页；页码两侧按钮及聚焦阅读区后的 PageUp / PageDown 也可翻页，目录 / 引用 / 页码跳转即时完成。逐页模式暂时使用单页版式，退出后恢复已保存的对开偏好。 |
| 连续阅读 | 右上「阅读模式」把原文按阅读顺序重排为可选择的连续正文；默认行高 1.2、字间距 0%、字符间距 0%、页宽 75%，四项均有滑块与数值输入；面板右上恢复按钮一次还原排版、分屏和主题并保存。支持仅阅读、原文与阅读左右对照、上下对照，以及原始 / 深色 / 黑色 / 雪色 / 棕褐 / 自定义文字和背景色。偏好存本地 `agentero-pdf-continuous-reading-settings`，同窗事件与跨窗 storage 同步；开关只作用于当前文档。 |
| 平移 | 放大后拖拽平移（临时抓手，与 Acrobat / Preview 一致）：按住**鼠标中键**拖拽，或按住**空格** + 左键拖拽；页面 1:1 跟随光标（含横向与斜向），armed 时 `grab`、拖拽中 `grabbing`。空格是无修饰裸键，归属规则与 `⌘F` 一致：**指针悬停的 viewer 优先接管**（阅读时焦点常落在 tab / 侧栏 / 笔记面板，不要求它是 dockview 的 active panel），否则由 active viewer 接管（焦点在 host 内，或点击页面后焦点仍停在 body）；输入框 / 按钮 / 链接，以及 `tab` / `option` / `checkbox` / `treeitem` 等可被空格激活的角色聚焦时保持原生行为；`⌘.` 框选模式下左键拖拽让位给 marquee，中键仍可平移；一旦 armed，左键与中键**完全等价**：除输入框等可编辑区域外，任意位置起手都平移，期间工具栏按钮与文中引用命中区的点击被暂时挂起（与 Acrobat 抓手一致），松开空格即恢复；`bindPanDragGesture` 在滚动容器 capture 阶段拦截并抑制兼容 `mousedown`，因此不会触发 EmbedPDF 划词、链接点击或 WebKit / Windows 中键自动滚动 |
| 大纲 / 参考文献 / 版面解析 | 左侧浮层：书签、参考文献（紧凑列表）、版面解析结果（图/表/算法/公式）。左侧浮层底部统一预留 `4rem`，避让翻页／缩放控制条，长列表在面板内滚动；控制条位置保持不变。侧栏与页内右上角「翻译本页」页签共用壳层字号阶梯（Body `text-sm` / Callout `text-xs`，见 [settings.md](settings.md)） |
| 查找 | `⌘F` + 命中高亮 |
| 页面背景 | 底部换页栏旁的调色板 popover 单选：**白纸 / 米色 `#faf9de` / 护眼绿 `#e3edcd` / 暗色**，偏好保存在本地（key 仍为 `agentero-pdf-color-scheme`，旧值 `light` 读作白纸），经 `agentero:pdf-color-scheme` 事件跨窗同步，不改变应用全局主题。EmbedPDF 尚无页面 color-scheme API：浅色 tone 在 `RenderLayer` / `TilingLayer` 之上叠一层 `mix-blend-multiply` tint（页面 shell 加 `isolate`，避免混到阅读区底色），白纸 × tint 精确落到目标色、黑字不变、插图仅轻微偏色，比 filter 更能保住图表饱和度；暗色仍对光栅做柔和反相（`PDF_PAGE_RASTER_DARK_CLASS`：`invert(0.84)` + `hue-rotate(180)` + 轻亮度/对比）。tint 层绘制在选区 / 搜索 / 批注层之下，高亮颜色与 Agent 裁剪（`renderPageRect`）均不受影响；全文翻译覆盖层按当前 tone 绘制纸面底色。扫描版/插图在暗色下会被一并反相 |
| 沉浸 | 底部换页栏旁切换；全屏 + 限宽居中 |
| 位置 | 记忆阅读位置；从 `#page=` / `#section=` 等引用打开时，引用 intent 优先于恢复上次阅读位置，两者统一等待上游 `onLayoutReady`，不再按 300/800/2000ms 重跳；解析前按主 tab 保留 token，快速 A/B 点击只接受最新结果，旧任务失败或卸载不会清除新请求；分屏的本地页码/大纲/handle 导航各归所属 viewer；跳转后在目标 bbox 上闪黄色半透明高亮块（~1.6s 淡出）。细条 `#section=` 标题扩成标题下预览块，并 `scrollToPage({ pageCoordinates })` 滚到该 y |
| 内部链接 / 引用预览 | 原 PDF、连续阅读及译文共用原生链接和解析器。数字组合引用展开全部明确编号，支持逗号、区间和跨页条目；元数据必须有明确 `rawKey` 且覆盖整组，不能用在线列表生成的 id 代替 PDF 编号。不满足时逐条裁剪 PDF 参考文献，并显示部分缺项。图表、算法预览完整目标页；公式按目标坐标裁剪实际公式。命名目标、链接标注框与源字符几何共同消歧，章节等非引用链接保留导航。元数据卡、裁剪卡与选择/固定卡互斥；拖选不触发悬停。卡片保持当前缩放并支持滚动，指针离开后短延迟隐藏。Ask 卡在指针离开和页面滚动后保持显示，直到主动收起或切换卡片。外部链接悬停显示完整 URL；点击才打开浏览器或跳转原文 |
| 书签 / 目录编辑 | 页面右上角使用无底色、无边框的书签图标：未标记为悬停显现的淡灰空心，已标记为常显暗红实心，深色纸面使用较亮红色；点击仅做轻微按压反馈，遵循 reduced-motion。图标一键添加／取消**该页书签**，默认标题为页码；划词菜单用相同图标创建书签，直接以选中文字为标题创建并自动保存，无需弹框确认或输入页码；标题合并换行与多余空白，空文本回退到页码标题，之后可在目录中重命名。目录行限制在面板宽度内，长标题省略显示，悬停／键盘聚焦标题时浮层换行展示完整内容；默认显示页码，悬停／键盘聚焦该行时在页码位置显示更多菜单（触屏常显），菜单打开期间保持可见。重命名收进更多菜单，标题原处重命名（Enter／失焦确认并自动保存，Esc 取消，Mac Return／Windows F2 开始编辑），支持、添加子书签、删除、拖拽排序／层级，以及菜单中的上移／下移／升一级／降一级；「设为当前页」显式更新目标。新书签点击只跳页，已有精确目标在重命名和移动时保持不变。目录不重复显示标题栏，不需要进入编辑模式；点击目录外的正文或阅读区空白会收起目录，同时保留该次点击的原有行为。目录内操作、菜单和单纯滚动不触发收起。每次修改立即自动写回原 PDF，无需手动保存；写入期间暂时禁用修改，成功不弹提示，失败显示 Toast 并提供重试图标。失败草稿在本次应用会话中跨标签关闭／重开和 viewer LRU 保留，退出应用不保留。 |
| 导出带批注 PDF | 标签页右键「导出带批注的 PDF」或命令面板。先把注释提交回 `marks/annotations.json`，再用 PDFium `saveAsCopy` 把高亮 / 批注作为真实 PDF 注解烘焙进文档副本，最后经 Tauri 保存对话框写盘；不改动原始 PDF，成功后 loading toast 原位切换为成功提示。`@embedpdf/engines` 补丁把拷贝出 WASM 堆的逐字节 `getValue` 循环换成 `HEAPU8.slice` 整块拷贝，长文档导出不再被高常数拷贝拖慢 |
| 视觉批注 | 工具栏或 **⌘.** 进入框选，框定/单击 layout 区域后裁剪直接保存为 `marks/<id>.json`，并在页右缘评论列打开就地编辑。框选中、裁剪中、已打开或正在编辑的视觉区域都使用默认主题的中性色绘制 2px 矩形边缘（浅色近黑、深色近白，不跟随外观配色），并保留轻量 halo 以压住复杂 PDF 内容。评论卡 hover 显示「加入侧边栏对话」图标，点击后将裁剪图送入 Agent composer 草稿（同一 mark 在 composer 中至多一个行内引用块，重复点击只刷新那一个）。发送只把裁剪图放进这轮提示词，不把对话写回这条批注。视觉批注的 Agent 会话继续通过右侧 Agent 面板进行；没有用户备注但已有 Agent 会话的视觉批注，点击页边针会在针旁打开浮动对话卡查看 transcript。面板与 mark 共用 `agentSessionStore` 会话（同一 send 管线、同一 `lines`）。多轮会回写同一 `marks/<id>.json` 的 `messages[]` / `answerSnapshot`。活动 PDF 才轮询 marks；切换 Vault 清空 composer 视觉草稿。裁剪最长边 1600 px。笔记或批注链接跳到视觉批注时只滚动到该区域并闪一下定位块，不打开页边浮动对话卡。页边针单击仍按原语义编辑或查看 transcript |

连续阅读复用 `prepareReflowItems` 的字符段落、公式 ID 与页面点坐标；正文保留粗体、斜体和内联公式，图、表、算法及独立公式按原 PDF 区域惰性裁剪，表格内部文字不重复显示。页眉、页脚边缘独立的页码与 `Page n of m` 不进入连续正文或双语段落，工具栏保留页码导航；正文中的数字、章节标题和公式编号不受影响。源段落位置采用重排 API 返回的 bbox，公式点坐标直接按该页宽高归一化，避免检测区域与实际字形框不同造成错裁。仅本地论文库 PDF 可开启，需要时执行已有版面分析。进入阅读模式不调用翻译服务；阅读段落读取当前 provider / service / 语言匹配的已有翻译 sidecar 与官方共享任务快照，并核对段落原文和受保护的公式、样式标记。共享任务的已完成块可立即显示；Host 原子写入与远程缓存写入完成后也会刷新对应段落；切换 provider 后旧缓存立即停止显示。

迁移到 0.15.4 后，连续阅读复用官方持久化字符 IR 缓存；整篇阅读与选页翻译分别决定需要的页集，无检测正文块的页面仍尝试恢复文字。缓存按 PDF / layout / 页输入核验，提取算法版本升至 2，使旧分行和公式归属缓存失效。JSON 解码后的样式在准备阶段恢复文档级共享，避免每个字符保留独立对象；命中与补提取页一同归并。缓存写入开关沿用设置，关闭写入仍可读取既有缓存。单栏阅读除卸载源页面绘制外，也关闭新版为成品译文注册的隐藏 PDF 显示文档；分屏或返回 PDF 后按需恢复。后台共享翻译的所有权仍由 JobCenter 管理，退出阅读不取消其他消费者的任务。

独立图片使用 PDF 原区域的纵横比与页面点尺寸，按 `96/72 × 1.25` 换算为显示宽度，受阅读栏宽度约束，不放大至整栏。文献引用与单字数学符号恢复为可选择的文字；跨多个保护标记的 `[99, 134]` 仍按完整引用匹配。原文和译文复用 PDF 原生链接目标及 citation / crossref / URL 预览：悬停查看元数据卡，缺少元数据时显示原参考文献截图，点击才跳转；划选不触发导航或悬浮卡。预览锚点使用当前文字的屏幕坐标，不要求源 PDF 页仍在虚拟列表中。

PDFium 字符数组中的空槽按原索引跳过，避免整页解析失败后降级为粗文字行；译文 token 定位按 UTF-16 编码单元映射实际字形框，避免前面的数学 Unicode 字母使后续引用偏移；重叠的合成空格不拆开编号，异常高的空格不连接相邻行。上标参考文献编号即使被分成独立文本块，也只在邻近作者行、抬高位置和同栏连续编号共同确认后合并。行内分式按上下叠置、水平重合的小号数学字形和附近正文行带归属，避免分母落入下一行；不使用论文题名、DOI 或固定页码判断。

引用文字定位优先读取 PDFium 的逐字符 advance、原始文字和字符在页面上的实际位置；同行字符共享紧凑的墨迹高度，既保留词间空格，也避免字体框跨入邻行。文本对象矩阵可能跨行复用，因此行带按字符矩形定位，并排除旋转的图表标签；引擎缺少字符数据时才回退粗文字矩形。图号前的 `Figure` 因软连字符换行时，只拼接同栏上一行末的断词；`Fig.` 与编号分成跨行两个 annotation 时，两半均恢复完整标签，只有行首被命中的编号才借用上一行前缀，不污染本行后面的图号。图注按类型与完整编号匹配，`Figure 1` 不会匹配 `Figure 10`。已确定图表类型且原生目标页有效时，即使版面分析未识别图块也能预览整页。参考文献裁剪按字符真实间距重建编号行，`[11–13]` 在第 14 条开始前停止，不把 `14.` 拼成 `1 4 .` 后误收后续条目。PDF 与阅读模式共用这套解析及每文档缓存。

一个原生链接覆盖整组数字时，预览保留完整组合：`[8–11,15–18]` 展示两个区间的八条，`[1,12,17]` 展示三条；悬停其中任意编号均不丢掉其余条目。原文、连续阅读与译文使用完整段落上下文或源字形恢复同组编号。相同目标复用预览状态与裁剪缓存，点击仍使用原生导航目标。每个编号优先查命名目标页，再查相邻参考文献页，每条最多八个候选页；单一区间最多展开 31 个编号。必须找到印刷编号才显示数字条目，部分失败会列出缺失编号，全部失败则不显示裁剪卡。作者年份括号组按原生 annotation 几何收集所有 citation key，并为每个成员保留可见作者和年份；跨行、跨栏、同作者同年不同目标均分别解析。缺少其中任一条目时不把残缺组显示为完整结果。已核实条目若跨到下一栏或下一页，续行以接下来的参考文献标题为终点；页眉、网址文件名和下一条作者不能相互借用年份。

译文里的一个公式单元可能包含多个引用目标，例如 `[48,49]`；透明选择层按链接范围拆分命中区，各自悬停、点击对应原生链接，并位于原文旧坐标命中层之上。可用字符几何时以实际命中的原生链接为准，防止段落里更早的非标准链接占用后面的引用。跨行 DOI 只在去掉换行空白后能与完整原生 URI 对上时扩展链接，保留完整地址并避免吞入后续正文。

复杂行内公式仍保留原 PDF 字形，宽高按「裁剪宽高 / 源段落字号」换算为 `em`；行内及独立公式均由 PDFium 以透明背景裁剪，alpha mask 以当前文字色绘制，棕褐、深色与自定义主题均无白底。文字矩阵的基线仅在落于该字符物理行时采用，字号及上标位置按同一行正文计算，缺少或跨行复用的矩阵回退原 `baselineOffset`。内联公式栅格倍率随阅读字号及设备像素比增加，至少为 3×；独立图最长边上限 1400px，内联公式上限 600px。裁剪加载前预留相同尺寸，避免加载完成时正文跳动。临近视口才请求 PDFium 裁剪。字符缺少 run 索引时只从同一 PDF 文本对象继承字体；无可继承 metadata 的默认字号已是页面点，不重复乘文字矩阵，避免错误过滤正常文字造成缺字和碎段。

连续阅读复用版面分析的图注聚类：下方主图注上方的相邻多行子图合为完整图块，侧置图注仍与相邻图块成组，正文和另一幅主图注会阻断合并；图注只展示一次，并复用匹配的译文。同页浮动图表夹在跨栏续句之间时，先展示句子后半段再展示图表；有句号结束的段落及跨页图块保持原顺序。重复的页边短文本及页脚角色从正文过滤，标题保留；作者脚注移到该源页正文之后，只有脚注的页面也保留。以上均按版面、文本角色和续段规则判断，不依赖论文名称、DOI 或固定页码。

图注去重仅让达到置信度门槛的候选压制另一图注，避免较宽的低置信度框先挤掉正确图注、自身随后又被过滤。链接前缺空格时，用 annotation 边界恢复图号的词边界。正文分行由正常字号的字母和数字建立行带，位置较高的撇号等标点随后归入邻近行，避免标点掉入上一行而破坏断词续接。

编号明确的图注在重叠正文框之前领取字形，防止跨栏图注被左右正文框拆散，导致图号消失、子图无法成组。完整图组可用与图框高度重叠的原始检测框补齐薄边缘，但不越过独立正文；图内短标签不再重复输出为正文。等宽代码片段沿同一左边界合并，相隔正文时停止；已有整块算法裁剪覆盖的代码不再重复生成，边界按实际代码字形补齐。代码保持原 PDF 排列，以图片显示。

文字层的行带合并跨 text object 的相邻字符，中文行距、独立短横线和数字仍按字形位置判断。`layout.json` 的 `textGeometryVersion=4` 使旧缓存只重走文字层，不重新调用版面模型。无 Unicode 映射的控制码字形保留为原图，不输出方框或猜字；行内公式遮罩从裁剪图估计纸色，去掉 PDF 自身绘制的浅色背景，保留笔画与 alpha，避免深色公式块和纸色白边。

阅读原文与提取字符可对齐时，链接直接按 native annotation 与逐字符坐标关联，支持上标、作者年份以及任意原生内部链接；译文仍走占位标记映射。表格、算法等裁剪图复用同一 `CitationLinkLayer`，裁剪坐标转换后保留原链接的悬停与导航。参考文献识别兼容 `[N]`、`N.`、`(N)` 和紧贴作者名的 `N.Author`，条目齐左续行不会因缺少悬挂缩进被截断。XYZ 位置失准时，只有目标页编号唯一且同列存在邻近连续编号，才允许按编号校正位置；重复编号和孤立编号仍保留距离约束。

作者年份参考文献的续行即使以姓氏和年份开头，也先按同栏缩进判断是否属于上一条，避免长作者名单被截断。PDF 页上原生链接与图表批注命中框同为 `z-2`，链接放在后面绘制，优先响应图表内引用；图表其余区域保留单击批注。两者都低于译文纸面 `z-3`，不让原文坐标覆盖重排后的译文字形。

作者、换行续段和年份被拆成多个原生标注时，按同页、相邻位置和相同 citation key 拼回可见引用文字。XYZ 坐标失准时，只在原目标页内以明确作者名单和年份唯一匹配条目；支持姓氏重音、复姓、机构作者、年份后缀及提取层丢失的 et al./作者间隔。只有原生锚点接近、精确年份和全部所引姓名均吻合时，才允许编辑者/漏首作者形式；同作者同年以原生坐标区分，不把 BibTeX key 猜作作者或年份。匹配缺失或有歧义时不展示错误条目，原生点击导航仍保留。

工具栏沿用原 Languages 图标，在存在当前服务的译文缓存时切换「显示原文 / 显示翻译」，不新增文字按钮，也不提供 Clear all。PDF 普通分屏显示原 PDF 与译文 PDF，左右/上下对照独立于阅读模式的源 PDF 与连续阅读布局。内嵌译文面板只读取共享缓存；缓存稍后完成时更新，不因打开面板启动第二次网络翻译。连续阅读按原文/译文按钮切换译文段落。连续阅读的译文段落左侧加淡竖线并缩进。读取文本或排版期间保留翻译入口。

翻译缓存通知使用一个共享的、按窗口活动状态缓冲的 Vault 文件订阅，覆盖 Host、另一窗口或外部同步写入的 `source/layout-translate.json`，同时处理原子替换的 rename 路径。最后一个阅读/对照订阅者卸载时释放监听；前端自身写入完成仍立即通知。读取后继续核对 provider、服务、语言和原文，不把过期或别篇缓存应用到当前视图。

Aa 弹窗按阅读开关分为两套内容：关闭时显示纵向、横向滚动及单页、双页平铺；开启时改为行高、字间距、字符间距、页宽四个排版控件。多页网格入口和专用实现已移除，旧 grid 设置按无效值回退纵向。PDF 模式的左右/上下分屏显示原文 PDF 与精简译文 PDF 窗格，不开启阅读模式；阅读模式的分屏继续显示 PDF 与连续正文。两种分屏各自保存当前设置。译文窗格复用官方共享任务和缓存，打开对照不会自行请求网络翻译。主题同时作用于 PDF 页纸、译文与阅读正文，黑色使用全反色、雪色与自定义纸色使用页面 tint。主题区使用普通块布局和三列网格；弹窗限制视口宽高，只允许纵向滚动。原逐页模式仍可从通用设置选择。

连续阅读的选区复用 PDF 公共动作菜单及 `marks/annotations.json`。原文以可见 UTF-16 偏移定位源字形，重复词不回退到第一个同名词；公式展开长度参与偏移，公式已知字符索引和墨迹框可恢复旧缓存中损坏的数学字符映射。高亮绘制在正文对应文字上，备注在段落后编辑，切回 PDF 仍使用源页坐标。阅读批注动作栏在卡片内部排版，不浮到上一段文字上；卡片使用独立的 hover group，外层正文悬停不会触发其工具栏。滚动或卸载会取消迟到定位并释放拖选状态。译文按可靠句对映射到原文句子，选中译文的一部分可能高亮整句；只有整段翻译、缺少句对时，局部选区保留复制/聊天而不创建错误批注。跨原文和译文混合拖选将可定位的源范围合并去重，复制保留实际可见选中文字。开发版 Windows 原生拖选、保存、切换和重开证据见[阅读选区映射记录](../test/2026-11-10-reader-selection-mapping.md)，最终安装包验收单独记录。

连续阅读使用 Radix ScrollArea 的常驻纵向滚动滑块，预留右侧空间，不依赖系统 overlay 滚动条的自动隐藏。阅读正文上的 Ctrl/Cmd+滚轮调整 50%–300% 的文字大小，公式与引用使用 em 同步缩放，保留指针所在段落位置；普通滚轮继续滚动，PDF 上的手势继续调整页面比例。

实现对照 Zotero reader 的 [`sdt-block-crops.js`](https://github.com/zotero/reader/blob/9d18073090a3bb54079fb9146aeb9677a8149c36/src/pdf/lib/sdt-block-crops.js) 与 [`defines.js`](https://github.com/zotero/reader/blob/9d18073090a3bb54079fb9146aeb9677a8149c36/src/common/defines.js)：参考按源区域保留比例、惰性裁剪及阅读放大的行为，使用 Agentero 现有 PDFium / reflow 能力独立实现。Zotero reader 为 AGPLv3，本项目未复制或链接其实现代码。

图表交叉引用悬浮预览参考 Zotero reader 的 [`renderPreviewPage`](https://github.com/zotero/reader/blob/9d18073090a3bb54079fb9146aeb9677a8149c36/src/pdf/pdf-renderer.js) 和 [`PreviewPopup`](https://github.com/zotero/reader/blob/9d18073090a3bb54079fb9146aeb9677a8149c36/src/common/components/view-popup/overlay-popup/preview-popup.js) 的整页渲染、目标点滚动定位行为，使用现有 PDFium 独立实现。完整页保留侧图注、页眉和相邻面板；XYZ / FitH 用真实目标点，整页 FitR 用匹配图块中心定位。Radix 常驻双向滚动条使超高或超宽内容保持当前缩放比例，滚轮不带动背景 PDF；卡片宽度不超过视口 80%，内容高度不超过 60%，不足时按链接上下空间收缩。整页栅格最长边上限 3200px，参考文献条目仍保留局部裁剪和 1600px 上限，按文档、页和渲染比例复用缓存。未复制或链接 Zotero 的 AGPLv3 实现代码。

原 PDF 与阅读视图共用当前页，滚动阅读正文同步底部页码和保存位置，页码、目录和原文滚动可定位阅读页；关闭阅读模式仍停留在当前源页。引用点击使用同一跳转与返回栈，阅读视图定位目标段落，返回时恢复跳转前的段落及屏幕偏移，避免只恢复页首。段落旁定位按钮在单视图返回原文，在分屏内保留阅读视图并定位对应源区域。阅读区域接管方向键、PageUp / PageDown、Home / End、空格滚动，输入框和设置滑块保持原生按键。文档切换或关闭阅读视图会取消未完成的准备任务，并丢弃迟到的缓存和裁剪结果。

连续阅读的图像 / 公式裁剪使用 Blob URL，仅在视口外 500px 的预取范围内保留，离屏、依赖改变和卸载时释放；异步迟到结果不再挂载，公式 mask 成功或失败均关闭 ImageBitmap 并清空画布。单栏阅读不挂载隐藏原文页的底图、瓦片和文字层，只保留 Scroller 几何与导航；分屏和退出阅读恢复原文绘制。普通文字页跳过无必要的 2×整页 RGBA 墨迹检测，特殊变换 / 非绘制文字仍按需检测；字符样式按文档共享，无原生链接的段落不重复构建链接字形。

同一已挂载文档再次开启阅读模式时复用已经完成的文字准备结果，避免反复提取整篇 glyph 和 text run。版面区域变化、显式重试、文档替换仍重新准备；取消的任务不会写入复用结果。该复用只作用于当前 viewer，不增加跨文档全局缓存，退出挂载保留集合的长文重新打开后仍需准备。

书签保存使用已有 `pdf-lib` 在独立 Worker 中修改原始 outline 对象，保留原书签的 destination／action、样式和折叠状态，不从已导入 sidecar 批注的阅读实例导出，因此不会顺带把阅读批注写进原 PDF。页面按钮创建的书签仍为标准 PDF outline，额外的 `AgenteroPageBookmark` 标记用于重新打开后恢复开关状态；取消页书签只移除该节点并将子书签提升一级，普通章节和划词书签不受影响。Host `pdf_save_bookmarks` 校验编辑基线的 SHA-256，串行执行临时文件原子替换；外部覆盖冲突、只读、加密、签名或不支持的书签动作拒绝保存，用 Toast 提示并保留草稿。论文标签的路径是论文目录，写回前先解析该目录中的 PDF 文件。直接打开的 `.pdf` 文件则写回该文件。保存成功后目录草稿留在原地，并把哈希基线换成刚写入的字节，不替换阅读器 buffer，因此页面和书签图标不会整页重载。这次写入的文件监听回声同样不刷新阅读器；外部程序改了 PDF 仍按原逻辑重载。当前仅支持本地桌面 PDF，不支持远端 Vault / 网页预览写回。

PDF 链接在阅读器中只用于导航。`link-annotation.tsx` 为 EmbedPDF 的 Link tool 增加独立 `link` category，并只锁定该 category；原生 Link renderer（包括 locked renderer）仅绘制原有下划线 / 边框，不接收指针、不选中，也不允许移动 / 缩放。导航和预览统一由 `CitationLinkLayer` 的透明按钮处理，URI 只经 Host opener 打开一次。高亮仍可选中、改色、编辑和删除。`AnnotationLayer` 保持在 `z-5`（译文纸面之上、字形之下），容器使用 `pointer-events-none`，菜单与其它实际交互元素自行启用指针。链接命中区保留 `z-2`，避免把英文坐标的点击区域放到译文字形上方而挡住译文划选；没有导航目标的 Link 也不会落入批注编辑或出现八点调整框。全文翻译盖住原文时，引用、交叉引用和 URL 先被占位符保住，再在译文字形里按原文中的对应标记重挂到原来的 Link（标记本身沿用原文链接字形的颜色（字形是正文黑时用可见边框的颜色；当前可见页的填色在打开译文前就读好），不再另加下划线；`[17,38]` 这类一组多个编号，只拆中心落在该标记字形上的 Link；字形还没读到时，一根已经盖住整组的宽标注不会把同一行后面的引用借进来。同一行上矩形顶边略有高低时，仍按从左到右配对。中心还在这段标记上方或左方的 Link 先跳过。个数对不上时整段只挂第一个 Link（同一矩形的重复 Link 只算一条）。字形已经对上、但这段上没有链接中心时，这段保持纯文本，不占用下一个 Link。点击与 hover 预览走对应的那一条）；对不上标记、且没被译文盖住的链接仍用 `z-2` 命中区。裸 URL 和 Markdown 链接末尾成对的括号保留，只剥掉多出来的句末括号和标点。

Windows 精准触控板同样支持双指捏合，无需按 Ctrl：Host 只开启 WebView2 的
`IsPinchZoomEnabled` 以接收合成的 Ctrl+wheel，整窗快捷键缩放仍维持原策略。
Windows 初始化脚本在 capture 阶段取消原生页面放大，论文之外捏合不会放大整个
应用；该常驻 non-passive guard 只检查事件、标记来源，不触发布局或 React 更新。
PDF 自己的 wheel 监听仍可在普通滚动期间切换 passive；滚动途中开始捏合时，
guard 也会取消首帧默认放大。未按实体 Ctrl 的细粒度像素事件按原生捏合倍率
换算，Ctrl+鼠标滚轮保留缓慢步进。Mac/WebKit 路径不变。实现与验证边界见
[Windows 触控板论文缩放](../bug_fix/windows-pdf-touchpad-pinch.md)。

## 划词菜单

工具栏以选区顶部中心为锚，将高亮色板与批注按钮后的分隔线对齐该位置（#822）；没有高亮色板的表面则将整栏居中。定位读取实际菜单与分隔线尺寸，随语言、可选动作、插件按钮和窗口尺寸变化重算；靠近窗口边缘时优先保留整栏与展开色板的可见空间。

选区后浮动工具栏：高亮色点（默认半重叠叠放并带深色描边，hover / 聚焦时向左弹簧展开；工具栏按右边缘定位，仅左侧色点区变宽，其余操作位置不变）/ **批注**（评论图标）/ **翻译** / **复制**（图标）/ **加入对话**（默认 `⇧⌘L`，文字按钮 + 独立下拉箭头）。箭头展开「快速对话」（`⌘K`，页内 Ask），工具栏快捷键提示实时跟随用户配置；网页与代码编辑器共用同一对话按钮组。点击已有高亮弹出的编辑菜单使用同样的右边缘定位，色点展开方式与划词菜单一致。复制写入剪贴板，不弹「已复制」；成功后按钮原地换成对勾，约 1.5 秒后恢复，工具栏和选区都留着，失败才 toast。点击**批注**后，在选区对应高度打开页右缘编辑卡并聚焦输入框；悬停批注按钮只显示提示。草稿保存选区快照，工具栏关闭、输入框聚焦后仍保留定位与译文选区底色。鼠标离开输入框继续保持编辑；⌘/Ctrl+Enter 或失焦保存非空内容，空内容失焦或 Esc 取消。已保存批注仍显示在右侧评论列。Settings → 翻译开启「划词自动翻译」后，选区文本提取完成即自动启动翻译并打开结果卡；关闭时保留手动翻译入口。默认全局 `⌘L` 仅开关 Agent 侧栏，不消费选区；`⌘K` 触发页内快速对话；`⇧⌘L` 加入选区、打开侧栏并聚焦输入框（无选区时不操作）。

**远程 PDF**（`agentero:arxiv:*`，如 arXiv Daily 预览）：无本地 sidecar。划词菜单只保留 **加入对话**（主按钮）/ **快速对话**（下拉；Ask 内存 ephemeral，关 tab 即丢，不写 `marks/`）；高亮 / 批注入口 / 翻译隐藏。底栏显示 Remote mode 徽标（`SiArxiv`，与 Info 面板同色）。引用 hover 可从 PDF dest key 生成只读条目，导入按钮走整篇入库。

| 动作 | 落盘 | UI |
|---|---|---|
| 复制 | 不落盘 | 工具栏图标。成功后按钮原地换成对勾，约 1.5 秒恢复；不弹 toast，工具栏和选区留着。失败才 toast |
| 高亮 | `marks/annotations.json` | 颜色 |
| 批注 | 高亮 + `comment` | 划词工具栏评论图标（点击后在页右缘打开并聚焦编辑卡；非空提交后落盘，空草稿失焦或 Esc 取消）；已保存的批注在页右缘外侧常驻评论列（色点 + 评论卡，相邻卡片纵向避让；点击卡片就地编辑，Notion 式：卡片内 textarea，Enter 换行，⌘/Ctrl+Enter 或失焦保存，Esc 取消；hover 出复制链接/嵌入/加入侧边栏对话/删除）；判断注解是否可见、可命中时统一忽略插件里已标记删除的记录，删除立即标记并持久化；若同 uid 的旧 create/update commit 在途，则通过 `onStateChange` 观察其结算（包含不发 committed 事件的失败），在 reducer / 锁释放后的微任务中补回仍处于 deleted 但丢失 pending 标志的意图；只补回一次，删除仍失败则 toast 并释放队列。不再按固定时间表盲试，undo / 新编辑会取消旧删除意图。**Hover 卡片或原文高亮区**时叠强调层，并画一条经页缘的直角细线连到卡片（仅 Hover 显示，编辑中不常驻；文字与视觉批注双向）；原文高亮区不铺可接收 pointerdown 的透明按钮，避免挡住 EmbedPDF 文字重选；视口窄于 640px 时回退为页边针 |
| 快速对话（Ask） | `marks/<id>.json`（kind ask）；远程仅内存 | 划词工具栏下拉「快速对话」；迷你问答；页边针。发出问题后，选区以与批注相同的黄色高亮保持可见，不依赖 hover 页边针或打开卡片。译文上划选时把划中区域记在 `anchor.translatedRects`，译文显示时画这套框并把页边针移到框旁，回到英文时画 `anchor.rects`。还没输入内容的空草稿关闭卡片时直接丢弃，不留下页边针或选区高亮；已输入但未发送的草稿关闭后保留页边针、选区高亮和输入内容，重新打开可继续。打开后输入框自动聚焦；输入框默认单行，最多三行，超出后在框内滚动；草稿先收成更矮的小卡，发出首个问题后动画展开到正常高度；打开时停在用户问题处，不自动滚到回复底部；Esc 收起卡片（编辑消息时先取消编辑）。指针离开、滚动或缩放 PDF 时保持卡片位置，源页面移出视口后仍可继续提问。可拖动标题栏移动卡片，拖后位置固定、不再跟随源锚点；可拖右下角调整宽高，或用标题栏放大 / 还原按钮（支持键盘），放大 / 还原只改尺寸并保留拖后位置；尺寸受窗口边界限制，窗口较矮时高度收缩到视口内，超出内容在卡片内滚动。长公式可横向滚动。卡片右上角 ChatGPT / Claude 图标可把 论文标题 + 页码 + 划选文本 发送到对应外部 AI |
| 快速对话 | 页内 Ask 浮层（ephemeral） | 划词工具栏下拉 / `⌘K`；打开 PDF Ask 对话卡，不强制打开 Agent 侧栏 |
| 加入对话 | 发送该轮后写 `marks/<id>.json`（kind `ask`）；远程无 pin 落盘 | 划词工具栏文字按钮 / 默认 `⇧⌘L`；点击或快捷键后选区以行内引用块插在 Agent composer 光标后并打开侧栏；**发送**后在选区旁插入**对话卡片**页边针（与「快速对话」同一 ask 卡 / 非视觉批注），并常驻同一黄色选区高亮。这条针只记英文框。见 [agent.md](agent.md) |
| 翻译 | 译文卡打开期间写入 `marks/<id>.json`（kind translate）；钉住后跨卡片关闭保留 | 结果卡在选区附近打开，随原文滚动和缩放，滚出阅读区时裁剪；可拖动标题栏移动、拖动右下角调整大小并复制译文，移动后的译文卡仍跟随原文；未钉住时关闭卡片会丢弃译文，钉住后原文页边保留可重开入口；取消钉住后卡片关闭时丢弃译文。原文选区在卡片关闭后仍保留浅黄高亮。全文翻译的纸面不挡住划词高亮和已有英文高亮，字形画在高亮之上；在译文上划选时，选区菜单和右侧批注跟划中的译文走。写入的高亮同时记下按行合并的英文字形框和划中译文的页比例坐标：译文开着时按后者高亮，回到英文时按前者，不把英文的框铺到译文上，也不铺成整块版面；进入批注编辑后，划中的区域仍显示在译文上。点到输入框以外时，写了字就落成批注并交出焦点，没写就收起这块选区。选中译文时墨色跟纸面走，不跟界面前景色反色；译文本身可选中，并显示选区底色。翻译前做的英文高亮在译文上只铺到字形框重叠的那句译文；点击该句色块会选中对应高亮，可改色、编辑或删除。见 [translate.md](translate.md) |
| 视觉批注 | `marks/<id>.json`（kind `visual` v2）：区域 + 用户批注 + 可选嵌套 `agent`；裁剪图 `marks/assets/<id>.png`。默认形态为纯批注（与文字「批注备注」同壳）；有 Agent 会话时仍保留页边针以便定位。旧版 `agent-trace` v1 仍可读，Doctor 可一键升 v2 | 框选或单击 layout 区域后在页右缘打开就地编辑；备注为空时不落盘。失焦、点到卡片外或 Esc 且没有输入时取消这次批注，选框和草稿一起消失。已输入的备注在失焦或 ⌘/Ctrl+Enter 时落盘。评论卡 hover 工具栏含「加入侧边栏对话」图标，点击将裁剪送入 Agent sidebar composer；删除图标也在卡上。「加入」传递的是 mark id，而草稿 id 就是落盘后的 `marks/<id>.json`，因此同一 mark 在 composer 中至多一个行内引用块：重复点击刷新该块（备注 / 区域 / 裁剪图），不会堆出共享同一 id 的重复项。发送不会把这轮对话写进这条批注。引用块图标为图片，插在光标之后；悬停查看裁剪图并编辑备注，点击图片放大，删除在悬浮卡片里，单击不移除。没有用户备注但已有 Agent 会话时，点击页边针在针旁打开浮动对话卡，展示已保存 transcript，并可隐藏或删除该视觉批注；其余续聊统一在右侧 Agent 面板进行。视口窄于 640px 时评论列回退为页边针。`marks/annotations.json` 读写按 annotation id 去重；对不带 transfer context 的链接，还按除顶层 id 以外的完整内容去重，保留目标、位置、样式和备注的差异。导入前跳过引擎中已有的同内容原生链接，防止 PDFium 为无 `/NM` 的链接每次生成新 id 后反复累积；同 id 高亮若 sidecar 中的备注、颜色、透明度或 `custom` 与 PDF 原生副本不同，改为批量更新原生高亮，保留用户覆盖且不重复追加页面 id。原生批注载入完成后才比对 sidecar，防止在空插件状态下排队重放重复链接；等待和重导入随文档卸载取消。普通高亮和视觉批注不做内容合并。详见 [重复原生链接导致首屏与交互停顿](../bug_fix/pdf-native-link-duplicates.md) |

`@embedpdf/plugin-annotation` 的最小补丁把删除 Task 的失败回调绑定到该 Task；上游直接传 `deleteTask.fail` 会丢失 `this`，导致 engine 删除失败时 commit 永远不结算。删除协调器通过公开状态事件处理结算，不依赖固定延时。

### 撤销与重做

PDF 阅读区域支持 `⌘/Ctrl+Z` 撤销、`⌘/Ctrl+Shift+Z` 重做文字高亮的新增、删除、改色，以及文字批注的新增、修改、删除。一次跨页高亮或新建高亮并提交批注合为一个步骤；撤销后进行新的编辑会清除重做分支。批注输入框、搜索框和 Markdown 编辑器保留各自的文字撤销，分屏与嵌入查看器沿用 PDF 键盘归属规则，悬停查看器优先，当前活动查看器兜底。

历史按打开的文档实例隔离，关闭实例后释放。`PdfHistoryPlugin` 复用 EmbedPDF History 的命令栈，通过公开 capability 增加同步操作分组和跳过记录；初次载入、外部文件导入、其他查看器同步及删除补偿均不产生用户步骤。外部更新会清理涉及相同 annotation id 的本地历史组，保留其他标注的历史。撤销与重做按顺序等待注解写入及删除补偿结算，避免在途删除清除刚恢复的标注；变化继续经现有注解事件刷新评论列、同步其他查看器并自动保存到 `marks/annotations.json`，卸载时刷新待保存内容。

视觉区域批注、截图、AI 会话、翻译、书签和导航不进入这条历史。

- 不改 PDF 二进制；不自动写入 `NOTES.md`。
- 评论列中已保存批注和新选区批注的输入框支持 ⌘/Ctrl+B、⌘/Ctrl+I，将选中文字包成 Markdown 加粗或斜体标记；再次按相同快捷键可去掉标记。
- 已保存的文字批注在评论卡 hover 工具栏里有「加入侧边栏对话」，和视觉批注用同一个图标。点击后原文和备注作为行内引用块插在 Agent 输入框光标处；同一条批注再次加入只刷新这一块。
- 文字高亮与视觉区域批注的备注以原始 Markdown 字符串存储；PDF 评论卡在非编辑状态和笔记中的批注嵌入卡均渲染 Markdown，编辑时显示源码。
- PDF 评论卡保留原有 224px 宽度；长备注悬停展开后可在卡内纵向滚动，超宽内容可横向滚动。
- 提问 Agent 可与面板默认 Agent 分开配置。
- 坐标归一化；多段 rect 支持双栏。
- 批注高亮与划词底色画在未旋转的 PDF 点坐标上。带 `/Rotate` 的页面用与瓦片相同的变换（`transformRect` / CSS matrix）把这层旋进正立页框，缩放后仍贴着字形；点击命中经 `restorePosition` 回到同一坐标系。正立页不插入这层变换。
- 页边针：用 PDFium `getPageTextRects` 判断是否压字。优先贴选区右侧，有字则试左侧；压字半透明，空白处实心。文字层未加载时保持实心。划词工具栏随视口滚动 / 缩放重定位，始终贴合选区；选区滚出视口时夹在屏幕边缘并半透明。
- 页缘控件使用固定 CSS px 尺寸：逐页翻译页签仅在 hover 该页时出现在纸张内侧左上角，批注评论列在页右缘外侧；两者只随 PDF 缩放更新锚点位置，不随页面放大/缩小改变自身宽高。
- 卡片打开时靠近原文；对话和视觉卡片优先与页边针同侧，翻译卡出现在选区正下方，空间不足时翻到上方或侧边。
- 普通划词只启用文本选区；选区显示使用浅透明蓝色，并按 PDFium 的紧致字形边界逐行合并，行间保留空隙，首尾严格停在实际选中文字处，不再使用 EmbedPDF 宽松字框产生的整行溢出。EmbedPDF 默认 marquee 矩形框选关闭，视觉区域批注只通过工具栏 / **⌘.** 显式进入。选择层不在页面挂载时就向选择插件注册——那会让打开文档时对 scroller 缓冲区的每一页都跑一遍 PDFium 字形几何提取（`getPageGeometry`，逐字形跨 WASM 边界），与首屏光栅/瓦片抢同一个 worker，既推迟出图也推迟可选中。指针进入页面（`pointerenter` / `pointermove`）会立刻注册。页面持续可见 `PDF_WORKER_SETTLE_MS`（180ms）后才预取几何，减少快速甩页的沿途提取；这是可见性延迟，并不保证滚动已停止，指针进入 / 移动仍立即注册。`usePdfPageText` 的 `getPageTextRects` 窗口在当前页码 180ms 未变化后读取；已经带批注的页仍马上取。窗口保持在当前页附近（约 ±1），避免和光栅抢同一个 worker。
- 普通划词后可通过浮动菜单的复制按钮或系统复制快捷键（macOS **⌘C** / Windows/Linux **Ctrl+C**）复制选中文本。按钮复制成功后原地换成对勾，不弹 toast，工具栏不收起；输入框和 Markdown 编辑器复制保持原生行为。
- 旧版 visual Ask（`kind: ask` + `visualKind`）仍可读、可打开。
- 一次提交可包含多条视觉批注：和文字批注按正文出现顺序共用编号，所在位置写成 `[Annotation N]`，文末是同一编号的 `## Annotation N`；裁剪图按这些视觉批注的编号顺序附上。
- PDF 内视觉批注草稿 / pin 卡片打开时，原页面显示框选区域；浮层不重复显示页码和裁剪图，裁剪图在悬停 Agent 输入框里的行内引用块时，以及批注侧边栏的视觉批注列表中展示。
- 视觉裁剪按用户框选的实际区域生成截图（不隐式外扩），最长边 1600 px；不以 base64 写入 mark JSON。活动 PDF 的 marks 轮询只读取 metadata，悬浮卡片、打开 Agent 与 Wiki 嵌入按需读取图片。图片缺失时仍保留位置、批注和多轮 transcript。
- **写进笔记**：评论卡 / 批注面板复制 / `[[@id]]` / `![[…@id]]`，见 [wiki.md](wiki.md) 编辑器 `@` 说明。

## CLI / Agent 写入的标注

`agentero mark add` 用 PDFium 文字引擎按 quote 定位后直接写盘（见 [backend/cli.md](../backend/cli.md)）：
高亮/批注追加到 `marks/annotations.json`，ask / translate 落 per-id `marks/<id>.json`。

阅读器两条吸收路径：

- `annotations.json`：挂载时导入一次；此外监听 Vault watcher 对该文件的**外部**变更
  （跳过本应用自身写入的 echo，200ms 合并），只导入内存里还没有的 annotation id。
  没有这一步，论文开着时 CLI 追加的高亮既看不见，还会被下一次 debounce 导出覆盖。
- per-id mark：活动 tab 的 marks 刷新同时重读 ask / visual / translate。

PDF 快速对话在会话接收后同时把空的 assistant 消息及其 `agentSessionId` 写入 ask mark。这样本地写入触发的 marks 刷新仍保留回复目标，后续流式内容与最终答案可以按同一消息 id 更新并保存；失败时移除该占位消息。

历史遗留的 per-id `kind: highlight` mark 仍由 `migrateHighlightMarks` 在 `annotations.json`
缺失/为空时一次性投影并删除源文件；新写入不再走这条路。

## 代码

| 路径 | 职责 |
|---|---|
| `src/components/viewer/index.ts` | 对外唯一出口（`PdfViewer` / `PdfViewerHandle` / 面板 / registry）；lazy `import()` 例外走具体模块 |
| `src/components/viewer/pdf/pdf-viewer.tsx` | 阅读器外壳：插件注册、EmbedPDF capability、按域 hook 组装、JSX 拼装 |
| `src/components/viewer/pdf/types.ts` | 对外契约与各卡片 / 编辑器状态类型，含共用 `ScreenPoint` |
| `src/components/viewer/pdf/constants.ts` | 光栅 dpr / 底图 scale 封顶、页层样式与空集合单例（memo 依赖稳定性） |
| `src/components/viewer/pdf/coords.ts` | 页↔屏坐标：页元素查找、rect→屏幕点、选区→归一化 anchor |
| `src/components/viewer/pdf/paper-tone.ts` | PDF 页面背景 tone 偏好持久化与跨窗广播 |
| `src/components/viewer/pdf/host-dom.ts` | 宿主 DOM 判定：可编辑目标、原生选区归属、文档关闭竞态错误 |
| `src/components/viewer/pdf/region-crop.ts` | PDF 区域裁剪与 Agent 图片编码 |
| `src/lib/pdf/engine.ts` + `src/components/viewer/pdf/engine-provider.tsx` | viewer / headless 共享创建与销毁策略：worker 优先 + 就绪探针 + 主线程回退 + 本机字体回退；宿主只负责 React 生命周期 |
| `src/components/viewer/pdf/layers/` | 页内绘制层：`page-layers`（memo 单页栈）/ `agentero-render-layer`（可见页光栅渲染、旋转与位图缓存生命周期）/ `reading-annotation-renderers`（稳定的只读批注 renderer 注册表）/ `citation-links` / `layout-translate-overlay` / `region-select-layer` / `selection-gutter` / `comment-cards-layer`（批注评论列：页右缘常驻卡片 + `layoutCommentCards` 纵向避让；选区竖向评论入口 hover 展开；点击就地编辑；hover 卡片或原文命中区时页内高亮叠半透明强调层，并用 `commentConnectorPath` 画页缘直角连接细线（多段高亮锚到离卡片最近的段落，而非整段竖直中点）；线色与视觉选框相同，用默认主题中性色（浅色近黑、深色近白），不跟随外观配色） |
| `src/components/viewer/pdf/chrome/` | 纯展示 chrome：`pdf-toolbar`（右上：框选 / 全文翻译，常显；翻译进行中显示中性色阶段胶囊、底部细进度线与停止按钮）/ `pdf-left-toolbar` / `pdf-find-bar` / `pdf-outline-panel`（+`outline-tree`）/ `pdf-references-panel` / `pdf-figures-panel` / `pdf-bottom-bar`（页码 + 缩放滑动条 + 适应宽度 / 适应整页 + 纸色）/ `pdf-card-stack`（portal 卡片栈）。共享材质见 `pdf-chrome-surface.ts`（小芯片轻玻璃、侧栏厚材质、划词菜单玻璃、长文卡片近实色；`data-pdf-chrome` 供 `prefers-reduced-transparency` 实色回退）。左上工具栏自动显隐（`use-pdf-chrome-visibility`）：滚动中或指针靠近顶部区域时显示，静读时以 opacity + 轻微上移/缩放 materialize（`prefers-reduced-motion` 仅淡入淡出）；面板打开 / ⌘F 时保持可见；左侧大纲/引用/图表面板自左滑入；⌘F 查找栏自右上角 zoom-in；底部页码条按页数位数扩展输入宽度，并限制在视口内以适配窄面板。阅读区底色 `bg-muted/40`，与纸面 tone 分层 |
| `src/components/viewer/pdf/cards/` | 划词与 mark 卡片：`selection-menu` / `highlight-color-stack`（高亮色点叠放与向左展开）/ `selection-card`（共用壳）/ `ask-popover` / `translate-card` / `visual-trace-card` / `visual-annotation-editor` / `formula-annotation-card` / `citation-preview` |
| `src/components/viewer/pdf/viewport/` | 宿主接线：`dockview-viewport`（resize 门控 + 滚动指标按帧提交；上报真实可视尺寸，`rightGutter` 为评论列预留页外空间，zoom 单独扣除该空间）/ `wheel-zoom-handler` / `pan-handler`（中键 / 空格拖拽平移的空格归属判定与光标 class）/ `keyboard-scroll-handler`（↑↓ 连续滚动或逐页 / 横向翻页，归属规则与空格平移一致）/ `active-card-scroll-sync` |
| `src/lib/pdf/scroll-sync.ts` + `hooks/use-pdf-scroll-sync.ts` | 双栏翻译跨 EmbedPDF 实例的滚动/缩放同步。手指下的那一栏由浏览器自己滚动，滚动过程中另一栏不动。滚动停稳（`scrollend`，没有该事件时在最后一次滚动约 180ms 后）后，另一栏直接跳到同一内容位置，不播放滚动动画，并取消它尚未落地的程序化跳转。纵向滚动不改对方的横向位置。滚轮监听保持 passive，只认领正在滚的那一栏。缩放由 source 侧在手势停稳后镜像 |
| `src/components/viewer/pdf/floating-hover.ts` | 浮动卡 sticky hover 共用：hide 延迟常量、`isFloatingDialogActive` |
| `src/components/viewer/pdf/hooks/use-sticky-hover-hide.ts` | 浮动卡 sticky hover 状态机（hoverSurface ref + 延迟 hide + 浮动 dialog re-arm + 可选 hold 否决），`use-pdf-cards` / `use-pdf-citations` / `use-pdf-crossref-preview` 共用 |
| `src/components/viewer/pdf/hooks/use-pdf-cards.ts` | 浮动卡生命周期：打开 / 定位（虚拟化重试）/ hover 收起（经 `use-sticky-hover-hide`，translate 流式期间 hold） |
| `src/components/viewer/pdf/hooks/use-pdf-highlights.ts` | EmbedPDF 标注桥：高亮视图模型、页边针锚点、链接分页图、导入迁移与防抖导出；annotation 事件按微任务合并重建 |
| `src/components/viewer/pdf/hooks/use-pdf-marks-io.ts` | `marks/` 并发读取与文件监听刷新（自写回声跳过；指纹比对后再提交 state） |
| `src/components/viewer/pdf/hooks/use-pdf-text-selection.ts` | 选区检测、划词菜单状态、`isSelecting`（拖选中压制链接预览；全文译文的 DOM 划选走同一套压制，见 [译文划选与参考文献卡片](../bug_fix/translation-selection-link-preview.md)）、滚动/缩放时 `rePlaceSelectionMenu` 与复制拦截 |
| `src/components/viewer/pdf/hooks/use-pdf-ask-threads.ts` | 划词提问工作流：建/续/停、线程数组容器、`marks/<id>.json` 落盘；单轮状态机（乐观消息 → 流式 → 完成/失败 → resend 截断）在共享引擎 `src/lib/pdf/ask/run-turn.ts`，与 `use-selection-ask.ts` 复用 |
| `src/components/viewer/pdf/hooks/use-pdf-selection-translate.ts` | 划词翻译工作流与结果卡状态；双 provider 执行（agent 流式 / 免费 MT 单发）在共享引擎 `src/lib/pdf/translate/run-selection.ts`，与 `use-web-view-selection.ts` 复用 |
| `src/components/viewer/pdf/hooks/use-pdf-region-framing.ts` | ⌘. 框选模式与单次裁剪（产出草稿交给 visual draft hook） |
| `src/components/viewer/pdf/hooks/use-pdf-visual-marks.ts` | visual mark 工作流：草稿落盘 / 加入对话 / 续聊 / pin 卡片 |
| `src/components/viewer/pdf/hooks/use-pdf-layout-regions.ts` | layout store 订阅与按页分桶（hover 命中框 / Eye 叠加层） |
| `src/components/viewer/pdf/hooks/use-pdf-layout-run.ts` | 版面分析运行：sidecar 优先、headless 队列、可中止任务 |
| `src/components/viewer/pdf/hooks/use-pdf-visual-draft.ts` | 裁剪草稿卡状态（`visualDraftEditor`）与区域屏幕锚点 |
| `src/components/viewer/pdf/hooks/use-pdf-layout-translate.ts` | 全文翻译任务、工具栏三态标签，以及右上角电量条（版面块占比；重排预览出来前不满格） |
| `src/components/viewer/pdf/hooks/use-pdf-page-text.ts` | 按需加载页文字矩形（页边针是否压字） |
| `src/components/viewer/pdf/hooks/use-pdf-citations.ts` | 文中引用 hover 预览与跳转（`use-sticky-hover-hide` + clear API；dest-map 经 `schedulePdfDestMapsBuild` 空闲构建） |
| `src/components/viewer/pdf/hooks/use-pdf-crossref-preview.ts` | 交叉引用 hover 整页滚动预览及参考文献裁剪（`use-sticky-hover-hide` + clear API；dest-map 经 `schedulePdfDestMapsBuild` 空闲构建） |
| `src/components/viewer/pdf/hooks/use-pdf-navigation.ts` + `src/lib/pdf/pending-pdf-page.ts` | 按 viewer 的导航 owner、主 tab 引用 token、layout-ready 后跳转/恢复与阅读位置持久化 |
| `src/lib/pdf/highlight/delete-queue.ts` | 同 uid 删除与在途 commit 协调；立即隐藏/保存草稿、commit 后保留未完成的删除 |
| `src/components/viewer/pdf/hooks/use-pdf-reading-mode.ts` | PDF 阅读版式：订阅设置的滚动方向 / 页面版式，按文档 scope 应用 EmbedPDF `setScrollStrategy` / `setSpreadMode`（主阅读器与双栏译文面板各自应用） |
| `src/components/viewer/pdf/hooks/use-pdf-zoom-controls.ts` | 缩放 level → ref 镜像（页层 / 选区定位不因 zoom 重订阅） |
| `src/components/viewer/pdf/hooks/use-pdf-chrome-visibility.ts` | 左上工具栏自动显隐：滚动事件 + 指针靠近顶部区域触发显示，空闲定时淡出；显隐动画由 `pdf-left-toolbar` 的 `PDF_CHROME_VIS*` 类承担；右上工具栏常显 |
| `src/components/viewer/pdf/hooks/use-pdf-paper-tone.ts` | 页面背景 tone 状态与跨窗同步 |
| `src/components/viewer/pdf/hooks/use-pdf-note-editor.ts` | 文字 / 视觉批注编辑：统一走页右缘评论列就地编辑，不再使用浮动 `AnnotationEditor` |
| `src/components/viewer/pdf/hooks/use-pdf-find.ts` | `⌘F` 查找 |
| `src/components/viewer/pdf/hooks/use-pdf-outline.ts` + `use-pdf-bookmark-editor.ts` | 大纲加载、会话草稿、自动保存；`lib/pdf/bookmark-edit.ts` 管理树操作，`bookmark-write.ts` / worker 修改 PDF outline，Host `features/pdf/bookmarks.rs` 负责校验与原子写回 |
| `src/components/viewer/pdf/hooks/use-pdf-viewer-handle.ts` | 注册命令式 handle（跨簇，唯一入口） |
| `src/components/viewer/pdf/hooks/use-pdf-pin-anchors.ts` | ask/translate 钉锚点几何投影（`useStableDerived` 指纹稳定：流式期间引用不变，`pinsByPage` 不失效） |
| `src/components/viewer/pdf/hooks/use-pdf-active-anchors.ts` | 活动卡记录查找（thread/translate/visualTrace）与 ask/translate 页内源锚点投影（仅几何，流式期间保持引用稳定） |
| `src/components/viewer/pdf/hooks/use-pdf-sidebar-panels.ts` | 左栏 References/Figures 面板开关（与大纲互斥）与评论卡 hover id |
| `src/components/viewer/pdf/hooks/use-pdf-selection-actions.ts` | 划词动作装配（工具栏：高亮/翻译/复制/加入对话/快速对话；右缘入口：批注；全文或单页译文上的划选用英文句子坐标写入高亮和批注，书签默认标题取对应英文）。复制成功不弹 toast、不关工具栏，对勾画在按钮上。划词表面三件套（copied 标签 / ⌘K 注册 / 加入对话尾段）与 plaza / 网页论文 / 文本编辑器共用 `src/components/selection/`（见 [web-view.md](web-view.md)） |
| `src/components/viewer/pdf/hooks/use-pdf-smart-highlights.ts` | 智能高亮任务提交、结果坐标转换、任务事件订阅与清理；阅读器仅组装 busy 状态与触发动作 |
| `src/components/viewer/pdf/hooks/use-pdf-mark-actions.ts` | 页边针打开（ask 线程/翻译卡/高亮编辑/visual 卡）与高亮标注菜单动作（编辑/删除/换色） |
| `src/components/viewer/pdf/hooks/use-pdf-layout-cluster.ts` | layout 簇聚合：region 分桶、分析运行与 Figures 处理器、visual draft 卡状态、全文翻译任务 |
| `src/components/viewer/pdf/marks-index.ts` | 纯派生 `buildMarksIndex`：由各 mark 数组 + 页文字矩形产出 `pinsByPage` / `commentsByPage`（无 React，调用方 memo） |
| `src/components/viewer/panels/figures-panel.tsx` | 版面分析入口（PDF 左侧浮层按钮触发；PDF 内浮层复用同一组件） |
| `src/components/viewer/panels/annotations-panel.tsx` | 提问 / visual mark 总览（右栏；文字批注已迁移到 PDF 页右缘评论列） |
| `src/components/viewer/panels/references-panel.tsx` | 参考文献解析与入库（PDF 左侧浮层面板）；`compact` 模式隐藏 header 与过滤 |
| `src/lib/workspace/viewer/pdf-viewer-registry.ts` | 按 tab 注册 `PdfViewerHandle`（类型契约也在此定义），供 shell / 命令面板 / workspace actions 调用；lib 层纯注册表，无 JSX |
| `src/lib/agent/visual-context-store.ts` | Agent composer 视觉批注草稿（按会话分桶；同一会话内 draft id = mark id，至多一枚） |
| `src/lib/pdf/agent-trace/` | visual mark 契约（v2 + 读兼容 v1）/ mark 资产 IO / prompt / Open-in-Agent / 会话 pending |
| `src/lib/pdf-visual/` | pdf↔agent 共享视觉基元的中立缝：`PdfVisualNormalizedRect` 与 trace/line id 生成器（两域都从这里 import，序列化格式不变） |
| `src/lib/pdf/highlight/` | 高亮 / 批注 |
| `src/lib/pdf/ask/` | 划词提问 |
| `src/lib/pdf/layout/` | EmbedPDF layout-analysis：归一化 bbox、`source/layout.json` raw sidecar、`source/layout-translate.json` 全文翻译缓存、内存 UI store |
| `src/lib/pdf/reflow/` | 字符/公式 IR、固定字体、译文排版、矢量 PDF 输出与链接迁移 |
| `src/lib/pdf/region.ts` | 区域坐标归一化与 PDF rect 转换 |
| `src/lib/pdf/citation-dest-map.ts` | dest-map Worker 加载与缓存；`schedulePdfDestMapsBuild` 供 citations / crossref hover hooks 空闲延迟构建（可取消、失败仅 warn） |
| `src/lib/pdf/translate/` | 划词翻译 IO |
| `src/lib/pdf/zoom.ts` | 精确缩放比例解析与范围限制 |
| `src/lib/pdf/wheel-zoom.ts` | ⌘滚轮缩放 delta 累加与每帧合并步进；wheel 监听 passive / non-passive 切换；WebKit 捏合手势（gesture*）换算为等价 wheel delta |
| `src/lib/pdf/pan-drag.ts` | 拖拽平移（临时抓手）手势：capture 阶段拦截中键 / 空格+左键，1:1 写 viewport `scrollLeft` / `scrollTop`，并抑制兼容 `mousedown`。pointer capture 只作尽力而为（WebKit 会在 `preventDefault` 过的 `pointerdown` 之后立刻释放，`lostpointercapture` 因此不能当结束信号），move / up 靠页面层冒泡回滚动容器，`pan-handler` 再挂一层 document 级抬手兜底 |
| `src/lib/pdf/annotations-store.ts` | 按 tab 状态 |
| `src/lib/pdf/selection/` | 选区与 marks IO |
| `src/lib/core/math.ts` | `clamp01` / `clamp`（几何与放置的唯一实现） |

组织约定：`pdf/` 放阅读器实现（外壳 + `hooks/` 按域状态 + `layers/` 页内绘制 + `chrome/` 工具栏浮层 + `cards/` 划词卡片 + `viewport/` 宿主接线），`panels/` 放右栏面板（只被 shell 引用）。folder 外部只从 `@/components/viewer` 导入；folder 内部一律用具体路径，且不得反向导入该 barrel。

## 版面分析（Figures 浮层）

PDF 左侧 **Figures** 按钮 → 页内浮层（原「解析」：分析 / 叠加层）→ 列表（image/chart、table、algorithm、**有编号 formula 置底**）。浮层用紧凑布局：与左侧工具栏**同一行**的右上角常驻 Eye / EyeOff 切换 PDF 上的 bbox 叠加层（有检测结果时显示，避免叠加层开启后无 UI 入口关闭，[#653](https://github.com/poco-ai/Agentero/issues/653)）；无结果时正文居中提供「分析」按钮。

**完整流水线、14 条核心规则、阈值与代码地图**见：

→ **[pdf-layout-analysis.md](pdf-layout-analysis.md)**

要点：先文字角色再联图；图题须整框在 figure bbox 内；图无 title 丢弃；默认置信度 30%；Paper PDF 的初步解析结果缓存到 `{paper}/source/layout.json`，后续 merge/filter 可重复计算。旧 DOM 翻译路径先把跨栏跨页的续段拼成一条，再按句切开（拉丁 `.` `!` `?` 要空白或结尾，`。` `！` `？` 单独即可；缩写和小数不切），归一化后按阅读顺序分批请求（`buildTranslateBatches`，一个 `[[n]]` 一句，标记解析失败则逐句重译）。缓存写入 `{paper}/source/layout-translate.json`（schema 2，含句对），按 provider / 语言 / region 原文校验后复用。详见 [translate.md](translate.md)。

**单击视觉批注：** hover 插图 / 表 / 算法 / 公式的命中框时，框上出现默认主题的中性 2px 描边（不跟随外观配色）（即将裁剪的确切 bbox）与右上角「单击进行批注」提示；单击裁剪该区域并直接保存为 note-only visual mark，同时在页右缘评论列打开就地编辑（与手动框选相同；不自动发送 Agent）。框选模式或裁剪进行中时命中框不挂载。

交互细节（均有对应实现约束）：

| 项 | 行为 | 原因 |
|---|---|---|
| 拖拽容差 | pointerdown 到 click 位移 > 6px 视为拖拽，不裁剪（`LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX`） | 浏览器只要 down/up 落在同一元素就派发 `click`，起手在图区内的选字或平移会误触发 |
| 键盘 | 命中框在 Tab 序列内，Enter / Space 裁剪；`MouseEvent.detail === 0` 直接放行容差判定 | 键盘激活没有指针位移可测 |
| 焦点 | 描边与提示同时响应 `group-hover` 与 `group-focus-visible` | 半透明 UA 焦点环压在不可预测的页面内容上不可靠 |
| 提示阈值 | 区域实际尺寸小于 `LAYOUT_HINT_MIN_REGION_W/H_PX`（120×28）时不画 chip，并配 `max-w` + `truncate` 兜底 | chip 是固定字号标签，容器随缩放变化，小区域下会溢出压住邻近内容 |
| 光标 | 全部命中框用 `cursor-crosshair` | pointer 光标留给会跳转的引用链接 |
| 裁剪中 | `visualCropRegion` 在页上画描边 + spinner（`role="status"`） | PDFium `renderPageRect` 是异步的，否则单击后到卡片出现之间毫无反馈 |

Host 下载/解析：[../backend/paper-import.md](../backend/paper-import.md)。

引用元数据解析与 References 面板：[../backend/citation-parsing.md](../backend/citation-parsing.md)。

## 限制与后续

- 数字组、范围引用按目标页及已确认的参考文献页逐条收集；单条文献在栏尾或页尾续接时保留下一栏/页的正文，直到下一条作者或编号边界。作者年份组保留原生目标身份，同作者同年不按字符串去重。匹配依赖可用文本层与原生目标，缺失目标不会猜测补齐。

2026-11-08 桌面回归：7 页双栏论文的 36 处阅读模式图表链接逐项悬停命中，PDF 模式抽查跨行图号和曾误定位的图号；两组范围引用分别显示对应条目，逗号列表按命中编号显示单篇。25 页论文抽查侧图注图号、范围引用及拆分引用未退化。合成用例覆盖多行子图、同页续句与跨页边界、孤立脚注、跨行图号、旋转标签、低置信度重复图注和公式基线。上述验证不代表任意 PDF 版面均可无损重建。

扩展回归使用 Zotero 文库的 15 篇、209 页，覆盖 IEEE、Nature、Wiley、ACS、Elsevier、Science Advances、中文论文、ACM 与 Verilog 代码资料；包含一篇 68 页长文。全页结构与链接扫描核对 3,671 个原生内部链接：3,489 个挂到正文、164 个挂到图片裁剪、18 个为同位置同目标重复标注。原始文件没有内部链接的两篇仅检查版面与图表，不能计为引用恢复通过。逐项图表悬停和代表页截图另外检查实际卡片，补获并修复长作者名单裁剪、失准 XYZ 引用位置及 PDF 表格批注层遮挡。旧 7/25/11 页样本另行回归。真实 X11 输入验证 Ctrl+滚轮改变阅读字号、普通滚轮滚动；点击引用后 Jump back 恢复段落偏移。完整扫描不等于逐页视觉无损验收；扫描件 OCR、跨页引用范围和新论文的在线翻译未纳入本轮。

样本、修复证据和复查位置见 [PDF 与连续阅读扩展回归](../test/2026-11-08-pdf-reader-regression.md)。

新增数学、机器学习、天体物理、医学方法学、药物化学、生物统计、大气气候和经济金融 8 篇、247 页验证，含 123 页长文。作者年份引用按实际题名核对；长文的重复文字提取已消除。WebKit 2.50.4 代码回收后捕获异步页变量可能读到前页状态，导致碎句及缺字；字符组装与整页重建现已移入同步函数，见 [异步页状态串用](../bug_fix/pdf-webkit-async-page-state.md)。修复后八篇两轮模型 / DOM 块数与字符总数一致。另已捕获 WebKit 超过 8,192 MB footprint 阈值主动终止的日志，占用来源仍待定位；不能把正文修复等同于长期稳定性验收。测试范围、源文件坏目标及恢复版面缓存的限制见 [跨领域回归](../test/2026-11-08-pdf-reader-crossfield.md)。

2026-11-09 继续定位：文档写入触发的开发页 reload 已通过收窄 Tailwind 源文件扫描修复，见 [刷新复盘](../bug_fix/tailwind-dev-reload.md)。干净页面八篇两轮共 16 次模型、DOM 和字符数一致，343 秒峰值 2,660 MiB；关闭测试 PDF 后，PDFium 的文档 / 页缓存 / 引用计数与包装层跟踪分配均归零，WASM 保留约 240 MiB 容量。历史内存阈值退出尚未在干净流程重现，`other` 分类不能当作具体分配来源；仍需在异常增长现场取证。

同日新增六篇、158 页，前五篇现代论文从零执行本地模型。修复 Nimbus 常规字体被推断成粗体、普通小写续句误作标题，以及字形已在表格图内但行高框越界造成的表头重复。1953 年历史重制 PDF 的首字下沉 / 字间距仍有重排错误，纯图片 fixture 没有可重排正文，不能承诺绝大多数论文完美适配。旧前端 / 当前 PDF / 当前阅读模式各三轮同 Host 对照的内核最高 RSS 为 1,070 / 1,078 / 2,101 MiB；关闭后为 854 / 811 / 1,107 MiB。阅读模式增加内存成本，历史 8 GiB 超限因果仍未证实，见 [交付与内存评估](../test/2026-11-09-pdf-delivery-memory.md)。

补充五轮、20 次关开：493 秒内核最高 RSS 2,234 MiB，全部关闭并等待后 1,384 MiB；主页面 PDF / 阅读 DOM 和 PDFium 文档、页缓存、包装层分配均归零，WASM 保留约 92 MiB。仍有约 905 MiB 的 `other` 分类未归因，不能据此声明长期无泄漏。

按当前验收范围，历史首字下沉、古老字间距和纯图片 OCR 不作为本轮阻塞项，跨页断词 / 自然段拼接暂不处理。最新补测覆盖 Elsevier、Springer、AIP、Taylor & Francis、IOP、MDPI、Wiley/IET、PLOS、RSC、Cambridge、Sage、Frontiers、Oxford 共 13 篇、179 页。数字引用解析过滤重叠空白，PDF 目标名正确解码 UTF-16；带上标无标点的编号、作者首行缩进和名字在前的参考文献可裁剪，空 sidecar 条目回退原文。整栏与独立段落重叠时先分配完整段落，清理正文内误图注，文字几何版本 4 仅重走文字。完整结果、源文件边界与最终内存对照见[出版社补测报告](../test/2026-11-09-pdf-publishers-memory.md)。新样本适配和资源优化不等同于任意论文无损或长期无泄漏；该轮尚未验证 Windows WebView2；后续原生安装包结果见[上游迁移试用](../test/2026-11-10-upstream-reader-trial.md)，长时间异常峰值归因仍未完成。

- #798：低清底图、BMP 编码及移除重复瓦片缓存 / 占位能减少已确认的出图与生命周期开销；Linux / WebKitGTK 的实际帧率与合成耗时仍需在报告者环境复测，不能仅凭 worker 排队判定滚动线程阻塞。
- Windows 试用包补查发现部分 Wiley/IET 数学符号在 PDFium 透明画布裁剪中消失。阅读公式改为普通纸面合成后去背景，再作 CSS mask；新包已复查。Oxford 的词内多余空格仍是文字提取 / 拼接的改进项，见 [Windows 试用记录](../test/2026-11-09-windows-reader-trial.md)。
- 可见页面底图调度已取得 Chromium 与 macOS 原生 WebKit 收益，后者完整 Vault 框选、保存和重开通过；Windows / Linux A/B 仍需补齐，见 [验收范围](../test/pdf-visible-rendering-performance.md)。合法的大量不同批注不应按内容删除，仍可能有逐项导入成本。
- 选区几何目前按可见时间 / 指针意图加载，附近文字矩形按页码延迟；如性能记录显示仍与滚动争用 worker，再单独评估真实 scroll-idle 调度，不追加引擎补丁。

- EmbedPDF 升级时继续核对 engines 原生内存 / 坐标 / refcount、tiling 旋转与 DPR、AI 按 backend 选择 ORT 入口的补丁；2.15.1 对应实现仍与 2.14.4 相同，不能仅凭升版删掉。zoom 评论列留白补丁也需核对上游是否已有等价配置。Document Manager 的加载态关闭所有权补丁需验证迟到成功、失败、重复关闭和共享 pane 后才能移除。待上游修复 annotation 同 uid 在途变更被旧 commit 清 pending 的问题后，移除删除协调器。

字符级全文翻译路径使用 `src/lib/pdf/reflow/`，将公式作为可移动矢量片段，基于固定字体度量重排；每页翻译结束后增量显示重排预览，全文结束时执行全局字号校正，最终预览与译文/双语 PDF 导出共用输出。该路径在段落内保留句对，并用排版偏移和原文字形坐标连接译文选区与英文。跨版面块的句链用于无引擎上下文的回退路径。限制及字体下载见 [translate.md](translate.md#与-babeldoc-的差异和后续)。

### 章节与正文块引用

PDF 支持 `paper.pdf#2`、`paper.pdf#2.1` 和 `paper.pdf#2.1#p3`。段落是版面分析中的一个正文块，按直接所属章节计数，子章节单独计数；具体编号和原文通过 `agentero layout list <paper> --kind paragraph --json` 查询，不能凭页面展示顺序猜测。聊天引用、普通 Markdown 链接和双链 `[[paper.pdf#2.1#p3]]` 共用 Host 的解析、滚动和临时高亮；段落高亮保持原始 bbox，不生成永久批注。编辑器输入 `[[paper.pdf#]]` 时，按 `layout.json` 的章节名补全，Tab 后继续列出该章段落，见 [wiki.md](wiki.md)。

缺少解析、目标不存在或章节编号重复时报告失败，不回退到其他段落。已有 `#section=`、`#page=`、图表引用与批注链接继续使用；Markdown 文件的 `#标题` 和嵌套标题语义不变。首版不合并跨页自然段，不恢复 PDF 替换后的旧锚点。

## 引用与重排的验证边界

[2026-11-10 引用与公式复测](../test/2026-11-10-pdf-citation-formula.md) 将预览加载、编号完整性与内容正确性分开记录。在线参考文献的列表次序不能证明 PDF 编号；源 PDF 的错误目标、无原生链接、未随 PDF 附带的补充材料无法凭空恢复。现代文本层论文也可能存在上述问题，不能按出版社承诺所有模板无损。历史特殊排版和扫描件 OCR 不在当前范围，跨页断词/断段仍是已知限制。后续优先扩大真实模板覆盖、原生 Windows 验证与长时间内存取证，而非按单篇名称增加例外。

### 引用与阅读选区的追加验收（2026-11-10）

InDesign 的上下颠倒 `/Rect` 先做 min/max 归一，命名目标保留完整 key，`-bib-N` 仅是标识，不当作印刷编号。阅读选区复用公共菜单和统一批注存储；原文按可见 UTF-16 偏移映射 PDF 字形，译文按已保存句对映射原文句子。跨段、跨页分别保存各页源坐标。原文/译文混合拖选把重叠源范围合并，避免重复高亮；复制保留实际可见选中文字。已知句对缺失的旧多句缓存不能可靠推导逐句对应，整段选择仍可按整段定位，重新翻译会生成句对。

实际多句翻译、鼠标选区、高亮、备注保存/取消和分屏缓存更新见[阅读选区验证](../test/2026-11-10-reader-selection-mapping.md)。新增 Wiley 全量链接和 Zotero 方法对照见[引用完整性回归](../test/2026-11-10-wiley-citation-completeness.md)。

历史版面缺陷回查补充两类修复：仅在一页被提取为文字的作者页眉，按页顶位置、标题角色及与首页作者行的完整文字对应过滤，忽略标点/机构序号差异，保留首页、正文及章节标题；同栏靠左的短独立公式与远处右侧编号，须有真实竖向重叠才合并，避免跨行或跨栏误接。原 ACM 与 Elsevier 样本继续作为真实回归输入。


上游 `66ecc1267` 合并后，翻译提取排除参考文献，连续阅读以 `includeReferences` 保留其原文；两种 IR 通过用途前缀分开缓存，算法版本 3 使旧结果失效。清晰的单篇作者年份身份与组合引用共用裁剪路径，相邻行再次引用同一目标不会把两个年份拼成一次引用。Vim 的 j/k/d/u 在当前阅读区域滚动；分屏原 PDF 仍使用源 viewport。上述交叉行为与最终包记录见[上游迁移试用](../test/2026-11-10-upstream-reader-trial.md)。
