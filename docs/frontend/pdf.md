# PDF 阅读与划词

## 渲染 vs 解析

| 层 | 位置 | 职责 |
|---|---|---|
| **渲染** | 前端 EmbedPDF + PDFium | 展示页面、缩放、翻页、选区 |
| **解析** | Host liteparse 等 | 生成 `PAPER.md`、Agent 可读正文（与预览分离） |

任意 Vault 路径 `.pdf` 可 `blob:` 预览；论文单元：本地优先 → 自动下载（JobCenter `downloadAssets` job，Host 续接 PAPER.md / 版面分析）→ 远程 `pdf_url` 回退。HTML 用远程 `html_url` iframe（不注入主 DOM）。普通网页条目打开 HTML 并创建 `NOTES.md` 分屏；旧条目缺少 `html_url` 时从 `source_url` 兜底。

PDFium engine 由窗口共享。默认优先 **worker 引擎**（PDFium WASM 跑在 Web Worker，缩放/滚动不阻塞主线程）；启动时经 `whenReady()` 就绪握手 + 8s 超时探针验证（`@embedpdf/engines` patch 同时把 worker 侧 `wasmError` / `onerror` 暴露为就绪失败，不再静默挂起），失败则自动回退主线程 direct engine 并记住结论（旧版库的 worker 变体在 Tauri WebView 下就绪消息丢失，表现为文档永远“正在加载”）。wasm URL 传给 worker 前先解析为绝对地址（blob worker 不能按页面基址解析相对路径）。对未嵌入字体的 PDF，Host 按 macOS / Windows / Linux 的系统字体路径读取一个本机 CJK 字体，通过本地 `blob:` URL 提供给 PDFium；移动端和找不到可读字体时安全跳过，不产生外部字体请求。Engine 宿主位于 React StrictMode 外，异步初始化即使在完成前被卸载也会主动销毁结果，避免 dev reload 遗留孤儿 WASM engine。工作区只挂载当前可见与最近使用的至多两个 PDF viewer；恢复的隐藏 PDF 标签按需 hydrate，退出保留集合的本地 PDF 字节会释放并在再次激活时重新读取。

光栅化分辨率分两层封顶：整页底图 `RenderLayer` 按 `min(devicePixelRatio, 1.5)`（`pdfRasterDpr`）出图——高 DPI 屏全 dpr 光栅会让每次缩放重渲染过重；高清瓦片 `TilingLayer` 是用户实际阅读的层，按 `min(devicePixelRatio, 2)`（`pdfTileDpr`）出图，HiDPI 屏小字号保持清晰，瓦片只覆盖视口 + 一圈故成本有界（`TilingLayer` 的 `dpr` 属性由 `@embedpdf/plugin-tiling` patch 提供）。Agent 区域裁剪走 `renderPageRect`，不受封顶影响。

`RenderLayer` 只是瓦片下的底图层，其 scale 另按 `PDF_BASE_LAYER_SCALE_CAP`（1.5）封顶：zoom 超过该值后整页光栅不再重渲染（单 worker 串行渲染下，长文档高倍缩放的整页光栅 + blob 传输是主要开销），清晰层由 `TilingLayer` 承担。瓦片 `tileSize: 1024` + `extraRings: 1`，减少长文档快速滚动时的渲染往返与边缘弹出。

抗抽动（twitch）措施：瓦片 `extraRings: 1` 预渲染视口外圈，减少快速滚动时边缘瓦片延迟弹出；`TilingLayer` patch 在新瓦片集异步光栅到达前保留旧瓦片作拉伸占位（`scale/srcScale` 重映射，1.5s 超时兜底），消除缩放瞬间的空白闪烁；marks 不再定时轮询，改由 Vault 文件监听（`vault:file-changed`，命中 `{paper}/marks/` 前缀，200ms 合并突发）触发刷新，配合激活时与窗口 focus 兜底；应用自身对 `marks/` 的写入会登记路径（3s TTL），其 watcher 回声直接跳过（写入方已更新内存态），mark 文件并发读取，读取结果仍做 JSON 指纹比对，内容未变不提交 state，避免整 viewer 重渲染。高亮派生态（视图模型 / 页边针锚点 / 链接分页图）的 annotation 事件按微任务合并后重建一次，批量导入 n 条不再逐事件 O(n²) 重建。

滚动路径开销（触控板一帧内可触发多次 scroll）另有两处收敛：viewport 滚动指标按动画帧合并后再 `setViewportScrollMetrics`（每次提交都会推出新的 scroller layout 对象，令所有挂载页重渲染）；layout hover 命中框与 Eye 调试框按 `hoverableLayoutRegionsByPage` / `rawLayoutRegionsByPage` 预先分页缓存，页渲染只做 `Map.get`，不再每页重跑一遍全文档 NMS。PDF viewport 的延迟跳转请求同样按帧合并，并在用户滚轮先发生时取消；虚拟页重排、缩放布局和双栏同步产生的程序化滚动不会触发取消；虚拟页节点换入换出时关闭浏览器 scroll anchoring，避免 Windows/WebView2 将阅读位置校正到首尾页（见 [bug_fix/pdf-windows-scroll-endpoint-jump.md](../bug_fix/pdf-windows-scroll-endpoint-jump.md)）。

## 阅读能力

| 能力 | 说明 |
|---|---|
| 缩放 | 底部栏滑动条调节 50%–300%（旁显示当前百分比；静止为灰色，hover / 聚焦 / 拖动时为 brand 主题色）；另支持 ⌘滚轮、触控板捏合；真实 scale 重渲染。默认仍以适应宽度打开。⌘滚轮 / 触控板捏合在手势期间**只做 CSS transform 预览**（缩放 ZoomGestureWrapper 那层 div，`transform-origin: 0 0` 配 `zoomPreviewTranslate` 让手指下的点不动），松手或滚轮静默 150ms 后**只提交一次真实 zoom**（`requestZoom(目标, 指针位置)`，`clampZoomPreviewScale` 把它夹在 50%–300%）；提交在同一帧内完成——真实 zoom 落地的同一次 React commit 里由 `useLayoutEffect` 把 zoom 插件为本次 focus 算好的 scroll（`viewportCapability.forDocument(docId).getMetrics()`）直接写进 DOM 并撤掉 transform，否则"新缩放 × 残留预览变换"会在文档高度的大元素上叠出超大合成层，卡住渲染线程（缩放结束后一段时间无响应）。这个位移不要自己按几何重算：内容窄于视口时插件会横向居中（`offX` 随缩放变化），自算版本在小缩放（如 50%）下对准纸面左半边放大后会偏出一个页宽，视觉中心瞬移到右半边。一次提交是必须的，不是优化：每次真实 zoom 都会重排 scroller 并在下一帧投递一个视口 scroll 请求，逐帧提交会不断覆盖自己的锚点、最终把视口推向文档开头；而按 10%–20% 固定档位跳格又让慢速捏合看起来毫无响应。wheel 监听不常驻 non-passive（`bindZoomGesture`）：普通滚动手势期间切成 passive，滚轮静默后再换回 non-passive，保证捏合缩放仍可 `preventDefault`，同时普通滚动不被主线程阻塞。WebKit（Safari / macOS WKWebView）的触控板捏合不以 ctrl+wheel 送达，而是 `gesturestart/change/end`，`bindZoomGesture` 用同一组 start/change/end 回调上报相对手势起点的 magnification 并 `preventDefault` 抑制平台放大，`gestureend` 丢失时由 1.2s 看门狗兜底提交 |
| 导航 | 底部页码 pill、PageUp/Down、Home/End |
| 平移 | 放大后拖拽平移（临时抓手，与 Acrobat / Preview 一致）：按住**鼠标中键**拖拽，或按住**空格** + 左键拖拽；页面 1:1 跟随光标（含横向与斜向），armed 时 `grab`、拖拽中 `grabbing`。空格是无修饰裸键，归属规则与 `⌘F` 一致：**指针悬停的 viewer 优先接管**（阅读时焦点常落在 tab / 侧栏 / 笔记面板，不要求它是 dockview 的 active panel），否则由 active viewer 接管（焦点在 host 内，或点击页面后焦点仍停在 body）；输入框 / 按钮 / 链接，以及 `tab` / `option` / `checkbox` / `treeitem` 等可被空格激活的角色聚焦时保持原生行为；`⌘.` 框选模式下左键拖拽让位给 marquee，中键仍可平移；一旦 armed，左键与中键**完全等价**：除输入框等可编辑区域外，任意位置起手都平移，期间工具栏按钮与文中引用命中区的点击被暂时挂起（与 Acrobat 抓手一致），松开空格即恢复；`bindPanDragGesture` 在滚动容器 capture 阶段拦截并抑制兼容 `mousedown`，因此不会触发 EmbedPDF 划词、链接点击或 WebKit / Windows 中键自动滚动 |
| 大纲 / 参考文献 / 版面解析 | 左侧浮层：书签、参考文献（紧凑列表）、版面解析结果（图/表/算法/公式）。侧栏与页缘「翻译本页」页签共用壳层字号阶梯（Body `text-sm` / Callout `text-xs`，见 [settings.md](settings.md)） |
| 查找 | `⌘F` + 命中高亮 |
| 页面背景 | 底部换页栏旁的调色板 popover 单选：**白纸 / 米色 `#faf9de` / 护眼绿 `#e3edcd` / 暗色**，偏好保存在本地（key 仍为 `agentero-pdf-color-scheme`，旧值 `light` 读作白纸），经 `agentero:pdf-color-scheme` 事件跨窗同步，不改变应用全局主题。EmbedPDF 尚无页面 color-scheme API：浅色 tone 在 `RenderLayer` / `TilingLayer` 之上叠一层 `mix-blend-multiply` tint（页面 shell 加 `isolate`，避免混到阅读区底色），白纸 × tint 精确落到目标色、黑字不变、插图仅轻微偏色，比 filter 更能保住图表饱和度；暗色仍对光栅做柔和反相（`PDF_PAGE_RASTER_DARK_CLASS`：`invert(0.84)` + `hue-rotate(180)` + 轻亮度/对比）。tint 层绘制在选区 / 搜索 / 批注层之下，高亮颜色与 Agent 裁剪（`renderPageRect`）均不受影响；全文翻译覆盖层按当前 tone 绘制纸面底色。扫描版/插图在暗色下会被一并反相 |
| 沉浸 | 底部换页栏旁切换；全屏 + 限宽居中 |
| 位置 | 记忆阅读位置；从 `#page=` / `#section=` 等引用打开时，一次性 pending 页意图优先于恢复上次阅读位置，并短时重试跳转，避免先闪到目标页再被拉回第 1 页；跳转后在目标 bbox 上闪黄色半透明高亮块（~1.6s 淡出）。细条 `#section=` 标题扩成标题下预览块，并 `scrollToPage({ pageCoordinates })` 滚到该 y |
| 文中链接 | Link annotation 覆盖层：citation / 图表·公式交叉引用 / 章节 GoTo 点击跳页，URI 开系统浏览器；未带 Link annotation 的纯文本 `http(s)` URL 与 `arXiv:<id>` 也会根据现有 PDFium 文字矩形生成外链命中区，并跳过与原生链接重叠的区域。打开论文后（主线程空闲时）在 Worker 里解析命名目标（`lib/pdf/citation-dest-keys.ts`），字节优先复用 `tab.pdfBytes`，按 `pdfPath:size` 缓存。**Citation hover**：hyperref `cite.<key>` 走 `pageIndex:pdfY → key → sidecar.rawKey`；ACS `mk:refN` 因 `/FitR` 整页冲突改走 **Link rect → mk:refN → sidecar id `ref-N`**。同一上标簇内按间距区分逗号与连字符：`14-18` 展开为 14…18 多条列表，`7,9` 保持两条。**Crossref hover**（`Fig. 3` / `Table 1` / `Eq. (2)`）：同理先 dest 坐标，冲突时 **Link rect → mk:tbl1 / mk:fig3**，再配 layout region 裁剪。索引 / layout / sidecar 未就绪或无法消歧时不弹卡片；章节等非 float 内部链接只保留导航。**浮动卡互斥（#430）**：citation 与 crossref 预览互斥；划词拖选进行中、选区操作菜单存在（`selectionMenu`）、全文翻译覆盖层打开或运行（`layoutTranslateActive` / `layoutTranslateRunning`）以及 pin 卡（ask·translate·visual）打开时压制链接预览；链接命中区在主键按下时不触发 hover，避免拖选扫过引用时闪卡；预览卡与 pin 卡共用 sticky hover（指针在卡上不收起，离开后短延迟关闭；link 命中区用 pointer 事件与卡片对齐） |
| 视觉批注 | 工具栏或 **⌘.** 进入框选，框定/单击 layout 区域后裁剪直接保存为 `marks/<id>.json`，并在页右缘评论列打开就地编辑。框选中、裁剪中、已打开或正在编辑的视觉区域都使用当前 UI 主题色绘制 2px 矩形边缘，并保留轻量 halo 以压住复杂 PDF 内容。评论卡 hover 显示「加入侧边栏对话」图标，点击后将裁剪图送入 Agent composer 草稿。视觉批注的 Agent 会话继续通过右侧 Agent 面板进行；没有用户备注但已有 Agent 会话的视觉批注，点击页边针会在针旁打开浮动对话卡查看 transcript。面板与 mark 共用 `agentSessionStore` 会话（同一 send 管线、同一 `lines`）。多轮会回写同一 `marks/<id>.json` 的 `messages[]` / `answerSnapshot`。活动 PDF 才轮询 marks；切换 Vault 清空 composer 视觉草稿。裁剪最长边 1600 px |
| 隐私模式 | **窗口失焦**时淡出批注（高亮）、评论卡、翻译覆盖、Agent 对话卡等浮层（`usePdfPrivacy` 经 `onFocusChanged` 监听），页面正文渲染层保留——切换窗口后再截图不会带出标注内容。系统不提供“正在截图”事件，失焦是无需权限的近似代理；纯浏览器 dev 构建恒可见 |

## 划词菜单

选区后浮动工具栏：高亮色点（默认半重叠叠放并带深色描边，hover / 聚焦时向左弹簧展开；工具栏按右边缘定位，仅左侧色点区变宽，翻译 / 快速对话 / 加入对话位置不变、整栏不抖动）/ **翻译** / **快速对话**（`⌘K`，页内 Ask）/ **加入对话**（`⌘L`），文字按钮小号、快捷键提示更小。点击已有高亮弹出的编辑菜单使用同样的右边缘定位，色点展开方式与划词菜单一致。选中后自动复制，工具栏不再放复制按钮。**批注**不在工具栏里：选区出现时页右缘评论列会在对应高度出现一条竖向入口（与空评论卡同高、宽度更窄，内为评论图标）。**Hover 直接进入编辑**（展开并聚焦输入框）；**移走且尚未输入则缩回竖向卡片**；已有输入则保持编辑直至 ⌘/Ctrl+Enter / 失焦提交或 Esc 取消。入口用选区快照，聚焦时即使 EmbedPDF 清掉选区也保留卡片。Settings → 翻译开启「划词自动翻译」后，选区文本提取完成即自动启动翻译并打开结果卡；关闭时保留手动翻译入口。全局 `⌘L` 有选区时加入对话并打开侧栏；`⌘K` 触发页内快速对话；`⇧⌘A` 加入对话并聚焦输入框。

**远程 PDF**（`agentero:arxiv:*`，如 arXiv Daily 预览）：无本地 sidecar。划词菜单只保留 **加入对话 / 快速对话**（Ask 内存 ephemeral，关 tab 即丢，不写 `marks/`）；高亮 / 批注入口 / 翻译隐藏。底栏显示 Remote mode 徽标（`SiArxiv`，与 Info 面板同色）。引用 hover 可从 PDF dest key 生成只读条目，导入按钮走整篇入库。

| 动作 | 落盘 | UI |
|---|---|---|
| 高亮 | `marks/annotations.json` | 颜色 |
| 批注 | 高亮 + `comment` | 选区时页右缘竖向评论入口（hover 进入编辑；移走且无输入则缩回图标卡；提交后落盘）；已保存的批注在页右缘外侧常驻评论列（色点 + 评论卡，相邻卡片纵向避让；点击卡片就地编辑，Notion 式：卡片内 textarea，Enter 换行，⌘/Ctrl+Enter 或失焦保存，Esc 取消；hover 出复制链接/嵌入/删除）；**Hover 卡片或原文高亮区**时叠强调层，并画一条经页缘的直角细线连到卡片（仅 Hover 显示，编辑中不常驻；文字与视觉批注双向）；原文高亮区不铺可接收 pointerdown 的透明按钮，避免挡住 EmbedPDF 文字重选；视口窄于 640px 时回退为页边针 |
| 快速对话（Ask） | `marks/<id>.json`（kind ask）；远程仅内存 | 划词工具栏文字「快速对话」；迷你问答；页边针；**hover / 打开卡片时高亮**锚定选区原文；打开时停在用户问题处，不自动滚到回复底部；卡片右上角 ChatGPT / Claude 图标可把 论文标题 + 页码 + 划选文本 发送到对应外部 AI |
| 快速对话 | 页内 Ask 浮层（ephemeral） | 划词工具栏文字按钮 / `⌘K`；打开 PDF Ask 对话卡，不强制打开 Agent 侧栏 |
| 加入对话 | 发送该轮后写 `marks/<id>.json`（kind `ask`）；远程无 pin 落盘 | 划词工具栏文字按钮 / `⌘L` / `⇧⌘A`（额外聚焦）；点击或快捷键后选区固定为 Agent composer 文本 chip 并打开侧栏；**发送**后在选区旁插入**对话卡片**页边针（与「快速对话」同一 ask 卡 / 非视觉批注）；hover / 打开同样高亮原文，见 [agent.md](agent.md) |
| 翻译 | `marks/<id>.json`（kind translate） | 浮层结果卡：贴合选区随滚轮重定位；未悬停卡片 / 原文高亮 / 页边针时自动收起（流式中除外）。见 [translate.md](translate.md) |
| 视觉批注 | `marks/<id>.json`（kind `visual` v2）：区域 + 用户批注 + 可选嵌套 `agent`；裁剪图 `marks/assets/<id>.png`。默认形态为纯批注（与文字「批注备注」同壳）；有 Agent 会话时仍保留页边针以便定位。旧版 `agent-trace` v1 仍可读，Doctor 可一键升 v2 | 框选或单击 layout 区域后裁剪直接落盘，并在页右缘评论列打开就地编辑。评论卡 hover 工具栏含「加入侧边栏对话」图标，点击将裁剪送入 Agent sidebar composer；删除图标也在卡上。没有用户备注但已有 Agent 会话时，点击页边针在针旁打开浮动对话卡，展示已保存 transcript，并可隐藏或删除该视觉批注；其余续聊统一在右侧 Agent 面板进行。视口窄于 640px 时评论列回退为页边针。`marks/annotations.json` 读写会按 annotation id 去重，避免重复导入脏数据 |

- 不改 PDF 二进制；不自动写入 `NOTES.md`。
- 提问 Agent 可与面板默认 Agent 分开配置。
- 坐标归一化；多段 rect 支持双栏。
- 页边针：用 PDFium `getPageTextRects` 判断是否压字。优先贴选区右侧，有字则试左侧；压字半透明，空白处实心。文字层未加载时保持实心。划词工具栏随视口滚动 / 缩放重定位，始终贴合选区；选区滚出视口时夹在屏幕边缘并半透明。
- 页右缘控件使用固定 CSS px 尺寸：逐页翻译页签和批注评论列只随 PDF 缩放更新锚点位置，不随页面放大/缩小改变自身宽高。
- 对话 / 翻译 / 视觉卡片与**同一侧页边针**对齐（左针开左、右针开右），贴合锚点，避免卡片落到选区另一侧。
- 普通划词只启用文本选区；EmbedPDF 默认 marquee 矩形框选关闭，视觉区域批注只通过工具栏 / **⌘.** 显式进入。
- 普通划词后可通过浮动菜单或系统复制快捷键（macOS **⌘C** / Windows/Linux **Ctrl+C**）复制选中文本；输入框和 Markdown 编辑器复制保持原生行为。
- 旧版 visual Ask（`kind: ask` + `visualKind`）仍可读、可打开。
- 一次提交可包含多条视觉批注：prompt 按 `## Annotation N` 分点，图片顺序与 annotation 对齐。
- PDF 内视觉批注草稿 / pin 卡片打开时，原页面显示框选区域；浮层不重复显示页码和裁剪图，裁剪图在 Agent 侧边栏视觉上下文与批注侧边栏视觉批注列表中展示。
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
| `src/components/viewer/pdf/engine-provider.tsx` | PDFium engine 宿主：worker 优先 + 就绪探针 + 主线程回退 + 本机字体回退 |
| `src/components/viewer/pdf/layers/` | 页内绘制层：`page-layers`（memo 单页栈）/ `citation-links` / `layout-translate-overlay` / `region-select-layer` / `selection-gutter` / `comment-cards-layer`（批注评论列：页右缘常驻卡片 + `layoutCommentCards` 纵向避让；选区竖向评论入口 hover 展开；点击就地编辑；hover 卡片或原文命中区时页内高亮叠半透明强调层，并用 `commentConnectorPath` 画页缘直角连接细线（多段高亮锚到离卡片最近的段落，而非整段竖直中点）；线色随 PDF 纸面 tone，不跟 app 主题） |
| `src/components/viewer/pdf/chrome/` | 纯展示 chrome：`pdf-toolbar`（右上：框选 / 全文翻译，常显）/ `pdf-left-toolbar` / `pdf-find-bar` / `pdf-outline-panel`（+`outline-tree`）/ `pdf-references-panel` / `pdf-figures-panel` / `pdf-bottom-bar`（页码 + 缩放滑动条 + 纸色）/ `pdf-card-stack`（portal 卡片栈）。共享材质见 `pdf-chrome-surface.ts`（小芯片轻玻璃、侧栏厚材质、划词菜单玻璃、长文卡片近实色；`data-pdf-chrome` 供 `prefers-reduced-transparency` 实色回退）。左上工具栏自动显隐（`use-pdf-chrome-visibility`）：滚动中或指针靠近顶部区域时显示，静读时以 opacity + 轻微上移/缩放 materialize（`prefers-reduced-motion` 仅淡入淡出）；面板打开 / ⌘F 时保持可见；左侧大纲/引用/图表面板自左滑入；⌘F 查找栏自右上角 zoom-in；底部页码条按页数位数扩展输入宽度，并限制在视口内以适配窄面板。阅读区底色 `bg-muted/40`，与纸面 tone 分层 |
| `src/components/viewer/pdf/cards/` | 划词与 mark 卡片：`selection-menu` / `highlight-color-stack`（高亮色点叠放与向左展开）/ `selection-card`（共用壳）/ `ask-popover` / `translate-card` / `visual-trace-card` / `visual-annotation-editor` / `formula-annotation-card` / `citation-preview` |
| `src/components/viewer/pdf/viewport/` | 宿主接线：`dockview-viewport`（resize 门控 + 滚动指标按帧提交；`rightGutter` 为评论列预留页外空间，并向 EmbedPDF 报告缩减后的 width/clientWidth 使 fitWidth 页面让出该空间）/ `wheel-zoom-handler` / `pan-handler`（中键 / 空格拖拽平移的空格归属判定与光标 class）/ `active-card-scroll-sync` |
| `src/lib/pdf/scroll-sync.ts` + `hooks/use-pdf-scroll-sync.ts` | 双栏翻译跨 EmbedPDF 实例的滚动/缩放同步：各 viewer 注册 peer，pair 的 source 侧接线，按视口比例对齐 scroll、镜像 zoom |
| `src/components/viewer/pdf/floating-hover.ts` | 浮动卡 sticky hover 共用：hide 延迟常量、`isFloatingDialogActive` |
| `src/components/viewer/pdf/hooks/use-pdf-cards.ts` | 浮动卡生命周期：打开 / 定位（虚拟化重试）/ hover 收起 |
| `src/components/viewer/pdf/hooks/use-pdf-highlights.ts` | EmbedPDF 标注桥：高亮视图模型、页边针锚点、链接分页图、导入迁移与防抖导出；annotation 事件按微任务合并重建 |
| `src/components/viewer/pdf/hooks/use-pdf-marks-io.ts` | `marks/` 并发读取与文件监听刷新（自写回声跳过；指纹比对后再提交 state） |
| `src/components/viewer/pdf/hooks/use-pdf-text-selection.ts` | 选区检测、划词菜单状态、`isSelecting`（拖选中压制链接预览）、滚动/缩放时 `rePlaceSelectionMenu` 与复制拦截 |
| `src/components/viewer/pdf/hooks/use-pdf-ask-threads.ts` | 划词提问工作流：建/续/停、ACP 流监听、`marks/<id>.json` 落盘 |
| `src/components/viewer/pdf/hooks/use-pdf-selection-translate.ts` | 划词翻译工作流与结果卡状态 |
| `src/components/viewer/pdf/hooks/use-pdf-region-framing.ts` | ⌘. 框选模式与单次裁剪（产出草稿交给 visual draft hook） |
| `src/components/viewer/pdf/hooks/use-pdf-visual-marks.ts` | visual mark 工作流：草稿落盘 / 加入对话 / 续聊 / pin 卡片 |
| `src/components/viewer/pdf/hooks/use-pdf-layout-regions.ts` | layout store 订阅与按页分桶（hover 命中框 / Eye 叠加层） |
| `src/components/viewer/pdf/hooks/use-pdf-layout-run.ts` | 版面分析运行：sidecar 优先、headless 队列、可中止任务 |
| `src/components/viewer/pdf/hooks/use-pdf-visual-draft.ts` | 裁剪草稿卡状态（`visualDraftEditor`）与区域屏幕锚点 |
| `src/components/viewer/pdf/hooks/use-pdf-layout-translate.ts` | 全文翻译任务与工具栏三态标签 |
| `src/components/viewer/pdf/hooks/use-pdf-page-text.ts` | 按需加载页文字矩形（页边针是否压字） |
| `src/components/viewer/pdf/hooks/use-pdf-citations.ts` | 文中引用 hover 预览与跳转（sticky hover + clear API） |
| `src/components/viewer/pdf/hooks/use-pdf-crossref-preview.ts` | 交叉引用 hover 裁剪预览（sticky hover + clear API） |
| `src/components/viewer/pdf/hooks/use-pdf-navigation.ts` | 页码输入、跳页与阅读位置恢复/持久化 |
| `src/components/viewer/pdf/hooks/use-pdf-zoom-controls.ts` | 缩放 level → ref 镜像（页层 / 选区定位不因 zoom 重订阅） |
| `src/components/viewer/pdf/hooks/use-pdf-chrome-visibility.ts` | 左上工具栏自动显隐：滚动事件 + 指针靠近顶部区域触发显示，空闲定时淡出；显隐动画由 `pdf-left-toolbar` 的 `PDF_CHROME_VIS*` 类承担；右上工具栏常显 |
| `src/components/viewer/pdf/hooks/use-pdf-paper-tone.ts` | 页面背景 tone 状态与跨窗同步 |
| `src/components/viewer/pdf/hooks/use-pdf-note-editor.ts` | 文字 / 视觉批注编辑：统一走页右缘评论列就地编辑，不再使用浮动 `AnnotationEditor` |
| `src/components/viewer/pdf/hooks/use-pdf-find.ts` | `⌘F` 查找 |
| `src/components/viewer/pdf/hooks/use-pdf-outline.ts` | 书签大纲加载 |
| `src/components/viewer/pdf/hooks/use-pdf-viewer-handle.ts` | 注册命令式 handle（跨簇，唯一入口） |
| `src/components/viewer/pdf/hooks/use-pdf-privacy.ts` | 隐私模式：监听窗口 `onFocusChanged`，失焦时返回 hidden（驱动批注/评论/翻译/Agent 卡淡出） |
| `src/components/viewer/pdf/hooks/use-pdf-pin-anchors.ts` | ask/translate 钉锚点几何投影（`useStableDerived` 指纹稳定：流式期间引用不变，`pinsByPage` 不失效） |
| `src/components/viewer/pdf/hooks/use-pdf-active-anchors.ts` | 活动卡记录查找（thread/translate/visualTrace）与 ask/translate 页内源锚点投影（仅几何，流式期间保持引用稳定） |
| `src/components/viewer/pdf/hooks/use-pdf-sidebar-panels.ts` | 左栏 References/Figures 面板开关（与大纲互斥）与评论卡 hover id |
| `src/components/viewer/pdf/hooks/use-pdf-selection-actions.ts` | 划词动作装配（工具栏：高亮/加入对话/快速对话/翻译；右缘入口：批注），各动作入口注入 |
| `src/components/viewer/pdf/hooks/use-pdf-mark-actions.ts` | 页边针打开（ask 线程/翻译卡/高亮编辑/visual 卡）与高亮标注菜单动作（编辑/删除/换色） |
| `src/components/viewer/pdf/hooks/use-pdf-layout-cluster.ts` | layout 簇聚合：region 分桶、分析运行与 Figures 处理器、visual draft 卡状态、全文翻译任务 |
| `src/components/viewer/pdf/marks-index.ts` | 纯派生 `buildMarksIndex`：由各 mark 数组 + 页文字矩形产出 `pinsByPage` / `commentsByPage`（无 React，调用方 memo） |
| `src/components/viewer/panels/figures-panel.tsx` | 版面分析入口（PDF 左侧浮层按钮触发；PDF 内浮层复用同一组件） |
| `src/components/viewer/panels/annotations-panel.tsx` | 提问 / visual mark 总览（右栏；文字批注已迁移到 PDF 页右缘评论列） |
| `src/components/viewer/panels/references-panel.tsx` | 参考文献解析与入库（PDF 左侧浮层面板）；`compact` 模式隐藏 header 与过滤 |
| `src/lib/workspace/viewer/pdf-viewer-registry.ts` | 按 tab 注册 `PdfViewerHandle`（类型契约也在此定义），供 shell / 命令面板 / workspace actions 调用；lib 层纯注册表，无 JSX |
| `src/lib/agent/visual-context-store.ts` | Agent composer 视觉批注草稿 |
| `src/lib/pdf/agent-trace/` | visual mark 契约（v2 + 读兼容 v1）/ mark 资产 IO / prompt / Open-in-Agent / 会话 pending |
| `src/lib/pdf-visual/` | pdf↔agent 共享视觉基元的中立缝：`PdfVisualNormalizedRect` 与 trace/line id 生成器（两域都从这里 import，序列化格式不变） |
| `src/lib/pdf/highlight/` | 高亮 / 批注 |
| `src/lib/pdf/ask/` | 划词提问 |
| `src/lib/pdf/layout/` | EmbedPDF layout-analysis：归一化 bbox、`source/layout.json` raw sidecar、`source/layout-translate.json` 全文翻译缓存、内存 UI store |
| `src/lib/pdf/region.ts` | 区域坐标归一化与 PDF rect 转换 |
| `src/lib/pdf/translate/` | 划词翻译 IO |
| `src/lib/pdf/zoom.ts` | 精确缩放比例解析与范围限制 |
| `src/lib/pdf/wheel-zoom.ts` | ⌘滚轮缩放 delta 累加与每帧合并步进；wheel 监听 passive / non-passive 切换；WebKit 捏合手势（gesture*）换算为等价 wheel delta |
| `src/lib/pdf/pan-drag.ts` | 拖拽平移（临时抓手）手势：capture 阶段拦截中键 / 空格+左键，1:1 写 viewport `scrollLeft` / `scrollTop`，并抑制兼容 `mousedown`。pointer capture 只作尽力而为（WebKit 会在 `preventDefault` 过的 `pointerdown` 之后立刻释放，`lostpointercapture` 因此不能当结束信号），move / up 靠页面层冒泡回滚动容器，`pan-handler` 再挂一层 document 级抬手兜底 |
| `src/lib/pdf/annotations-store.ts` | 按 tab 状态 |
| `src/lib/pdf/selection/` | 选区与 marks IO |
| `src/lib/core/math.ts` | `clamp01` / `clamp`（几何与放置的唯一实现） |

组织约定：`pdf/` 放阅读器实现（外壳 + `hooks/` 按域状态 + `layers/` 页内绘制 + `chrome/` 工具栏浮层 + `cards/` 划词卡片 + `viewport/` 宿主接线），`panels/` 放右栏面板（只被 shell 引用）。folder 外部只从 `@/components/viewer` 导入；folder 内部一律用具体路径，且不得反向导入该 barrel。

## 版面分析（Figures 浮层）

PDF 左侧 **Figures** 按钮 → 页内浮层（原「解析」：分析 / 叠加层）→ 列表（image/chart、table、algorithm、**有编号 formula 置底**）。

**完整流水线、14 条核心规则、阈值与代码地图**见：

→ **[pdf-layout-analysis.md](pdf-layout-analysis.md)**

要点：先文字角色再联图；图题须整框在 figure bbox 内；图无 title 丢弃；默认置信度 30%；Paper PDF 的初步解析结果缓存到 `{paper}/source/layout.json`，后续 merge/filter 可重复计算。全文翻译先归一化文字层原文（断词 / ligature / 页眉页脚残留），把跨栏跨页的续段合并成一个翻译单元，再按阅读顺序**分批**请求（`buildTranslateBatches`，批内 `[[n]]` 标记保上下文，解析失败回退逐段），缓存独立写入 `{paper}/source/layout-translate.json`，按 provider / 语言 / region 原文校验后复用。详见 [translate.md](translate.md)。

**单击视觉批注：** hover 插图 / 表 / 算法 / 公式的命中框时，框上出现当前 UI 主题色的 2px 描边（即将裁剪的确切 bbox）与右上角「单击进行批注」提示；单击裁剪该区域并直接保存为 note-only visual mark，同时在页右缘评论列打开就地编辑（与手动框选相同；不自动发送 Agent）。框选模式或裁剪进行中时命中框不挂载。

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
