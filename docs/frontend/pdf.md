# PDF 阅读与划词

## 渲染 vs 解析

| 层 | 位置 | 职责 |
|---|---|---|
| **渲染** | 前端 EmbedPDF + PDFium | 展示页面、缩放、翻页、选区 |
| **解析** | Host liteparse 等 | 生成 `PAPER.md`、Agent 可读正文（与预览分离） |

任意 Vault 路径 `.pdf` 可 `blob:` 预览；论文单元：本地优先 → 自动下载 → 远程 `pdf_url` 回退。HTML 用远程 `html_url` iframe（不注入主 DOM）。普通网页条目打开 HTML 并创建 `NOTES.md` 分屏；旧条目缺少 `html_url` 时从 `source_url` 兜底。

PDFium engine 由窗口共享。默认优先 **worker 引擎**（PDFium WASM 跑在 Web Worker，缩放/滚动不阻塞主线程）；启动时经 `whenReady()` 就绪握手 + 8s 超时探针验证（`@embedpdf/engines` patch 同时把 worker 侧 `wasmError` / `onerror` 暴露为就绪失败，不再静默挂起），失败则自动回退主线程 direct engine 并记住结论（旧版库的 worker 变体在 Tauri WebView 下就绪消息丢失，表现为文档永远“正在加载”）。wasm URL 传给 worker 前先解析为绝对地址（blob worker 不能按页面基址解析相对路径）。Engine 宿主位于 React StrictMode 外，异步初始化即使在完成前被卸载也会主动销毁结果，避免 dev reload 遗留孤儿 WASM engine。工作区只挂载当前可见与最近使用的至多两个 PDF viewer；恢复的隐藏 PDF 标签按需 hydrate，退出保留集合的本地 PDF 字节会释放并在再次激活时重新读取。

光栅化分辨率按 `min(devicePixelRatio, 1.5)` 封顶（`pdfRasterDpr`）：高 DPI 屏全 dpr 光栅会让每次缩放重渲染过重；封顶后 `RenderLayer` / `TilingLayer` 都按该 dpr 出图（`TilingLayer` 的 `dpr` 属性由 `@embedpdf/plugin-tiling` patch 提供）。Agent 区域裁剪走 `renderPageRect`，不受封顶影响。

`RenderLayer` 只是瓦片下的底图层，其 scale 另按 `PDF_BASE_LAYER_SCALE_CAP`（1.5）封顶：zoom 超过该值后整页光栅不再重渲染（单 worker 串行渲染下，长文档高倍缩放的整页光栅 + blob 传输是主要开销），清晰层由 `TilingLayer` 承担。瓦片 `tileSize: 1024` + `extraRings: 1`，减少长文档快速滚动时的渲染往返与边缘弹出。

抗抽动（twitch）措施：瓦片 `extraRings: 1` 预渲染视口外圈，减少快速滚动时边缘瓦片延迟弹出；`TilingLayer` patch 在新瓦片集异步光栅到达前保留旧瓦片作拉伸占位（`scale/srcScale` 重映射，1.5s 超时兜底），消除缩放瞬间的空白闪烁；marks 不再定时轮询，改由 Vault 文件监听（`vault:file-changed`，命中 `{paper}/marks/` 前缀，200ms 合并突发）触发刷新，配合激活时与窗口 focus 兜底，读取结果仍做 JSON 指纹比对，内容未变不提交 state，避免整 viewer 重渲染。

滚动路径开销（触控板一帧内可触发多次 scroll）另有两处收敛：viewport 滚动指标按动画帧合并后再 `setViewportScrollMetrics`（每次提交都会推出新的 scroller layout 对象，令所有挂载页重渲染）；layout hover 命中框与 Eye 调试框按 `hoverableLayoutRegionsByPage` / `rawLayoutRegionsByPage` 预先分页缓存，页渲染只做 `Map.get`，不再每页重跑一遍全文档 NMS。

## 阅读能力

| 能力 | 说明 |
|---|---|
| 缩放 | 可输入 50%–300% 精确比例；支持 +/-、⌘滚轮；适应宽度 / 适应整页放在底部栏的沉浸式按钮左侧；真实 scale 重渲染。⌘滚轮步进按动画帧合并（`createWheelZoomCoalescer`）：一帧内多个 wheel 事件先累加抵消，再一次性应用净步进，避免触控板高频事件逐事件触发整页重光栅。wheel 监听不常驻 non-passive（`bindWheelZoomGesture`）：普通滚动手势期间切成 passive，滚轮静默后再换回 non-passive，保证捏合缩放仍可 `preventDefault`，同时普通滚动不被主线程阻塞 |
| 导航 | 底部页码 pill、PageUp/Down、Home/End |
| 大纲 | 左侧书签浮层 |
| 查找 | `⌘F` + 命中高亮 |
| 明暗模式 | 底部换页栏旁可单独切换亮色 / 暗色页面，偏好保存在本地，不改变应用全局主题。EmbedPDF 尚无页面 color-scheme API，仅在 PDF 暗色模式下对 `RenderLayer` / `TilingLayer` 做柔和反相（`PDF_PAGE_RASTER_DARK_CLASS`：`invert(0.88)` + `hue-rotate(180)` + 轻亮度/对比）；全文翻译覆盖层同样按浅色纸面绘制后套用同一 filter，以匹配反转后的纸面。选区 / 搜索 / 批注覆盖层与 Agent 裁剪（`renderPageRect`）不受影响。扫描版/插图会被一并反相 |
| 沉浸 | 底部换页栏旁切换；全屏 + 限宽居中 |
| 位置 | 记忆阅读位置 |
| 文中链接 | Link annotation 覆盖层：citation / 图表 / 章节 GoTo 点击跳页，URI 开系统浏览器；hover citation 锚文本（`[12]` / 作者-年份）显示元数据预览并联动右侧 References 卡片高亮。图表、章节、公式等内部链接只保留导航，不显示引用预览 |
| 视觉批注 | 工具栏或 **⌘.** 进入框选。**Enter** → composer 草稿；**⌘/Ctrl+Enter** → 浮层。浮层与右侧 Agent **共用** `agentSessionStore` 会话（同一 send 管线、同一 `lines`），不是两套记录。Host 按能力 `session/load`（Grok）或 `session/resume` 续聊。多轮会回写同一 `marks/<id>.json` 的 `messages[]` / `answerSnapshot`（草稿 id 用 nanoid，跨重启不覆盖）。活动 PDF 才轮询 marks；切换 Vault 清空 composer 视觉草稿。裁剪最长边 1600 px |

## 划词菜单

选区后：高亮 / 批注 / 提问 / 加入对话 / 翻译。

| 动作 | 落盘 | UI |
|---|---|---|
| 高亮 | `marks/annotations.json` | 颜色 |
| 批注 | 高亮 + `comment` | 页边针 + 右侧批注面板 |
| 提问 | `marks/<id>.json`（kind ask） | 迷你问答；页边针；**hover / 打开卡片时高亮**锚定选区原文；打开时停在用户问题处，不自动滚到回复底部 |
| 加入对话 | 发送该轮后写 `marks/<id>.json`（kind `ask`） | 选区固定为 Agent composer 文本 chip；**发送**后在选区旁插入**对话卡片**页边针（与「提问」同一 ask 卡 / 非视觉批注）；hover / 打开同样高亮原文，见 [agent.md](agent.md) |
| 翻译 | `marks/<id>.json`（kind translate） | 浮层结果卡：贴合选区随滚轮重定位；未悬停卡片 / 原文高亮 / 页边针时自动收起（流式中除外）。见 [translate.md](translate.md) |
| 视觉批注 | `marks/<id>.json`（kind `visual` v2）：区域 + 用户批注 + 可选嵌套 `agent`；裁剪图 `marks/assets/<id>.png`。默认形态为纯批注（与文字「批注备注」同壳）；有 Agent 会话时可切到对话视图。旧版 `agent-trace` v1 仍可读，Doctor 可一键升 v2 | 框选后：**批注备注** 输入 + 取消/保存；右上角「加入侧边栏对话」。已落盘 pin：纯批注模式可改备注；有对话时右上角切换「编辑备注 / 查看对话」。续聊走 ACP 同一 session |

- 不改 PDF 二进制；不自动写入 `NOTES.md`。
- 提问 Agent 可与面板默认 Agent 分开配置。
- 坐标归一化；多段 rect 支持双栏。
- 页边针：用 PDFium `getPageTextRects` 判断是否压字。优先贴选区右侧，有字则试左侧；压字半透明，空白处实心。文字层未加载时保持实心。划词菜单仅在翻到选区下方时半透明。
- 对话 / 翻译 / 视觉卡片与**同一侧页边针**对齐（左针开左、右针开右），贴合锚点，避免卡片落到选区另一侧。
- 普通划词只启用文本选区；EmbedPDF 默认 marquee 矩形框选关闭，视觉区域批注只通过工具栏 / **⌘.** 显式进入。
- 普通划词后可通过浮动菜单或系统复制快捷键（macOS **⌘C** / Windows/Linux **Ctrl+C**）复制选中文本；输入框和 Markdown 编辑器复制保持原生行为。
- 旧版 visual Ask（`kind: ask` + `visualKind`）仍可读、可打开。
- 一次提交可包含多条视觉批注：prompt 按 `## Annotation N` 分点，图片顺序与 annotation 对齐。
- PDF 内视觉批注草稿 / pin 卡片打开时，原页面显示框选区域；浮层不重复显示页码和裁剪图，裁剪图在 Agent 侧边栏视觉上下文与批注侧边栏视觉批注列表中展示。
- 视觉裁剪按用户框选的实际区域生成截图（不隐式外扩），最长边 1600 px；不以 base64 写入 mark JSON。活动 PDF 的 marks 轮询只读取 metadata，悬浮卡片、打开 Agent 与 Wiki 嵌入按需读取图片。图片缺失时仍保留位置、批注和多轮 transcript。
- **写进笔记**：批注面板复制 / `[[@id]]` / `![[…@id]]`，见 [wiki.md](wiki.md) 编辑器 `@` 说明。

## 代码

| 路径 | 职责 |
|---|---|
| `src/components/viewer/embed/pdf-viewer.tsx` | 阅读器外壳：插件注册、EmbedPDF capability、按域 hook 组装、JSX 拼装 |
| `src/components/viewer/embed/pdf-viewer-types.ts` | 对外契约（`PdfViewerHandle` / `PdfViewerProps`）与各卡片 / 编辑器状态类型 |
| `src/components/viewer/embed/pdf-page-constants.ts` | 光栅 dpr / 底图 scale 封顶、页层样式与空集合单例（memo 依赖稳定性） |
| `src/components/viewer/embed/pdf-color-scheme.ts` | PDF 页面明暗偏好持久化与跨窗广播 |
| `src/components/viewer/embed/pdf-host-dom.ts` | 宿主 DOM 判定：可编辑目标、原生选区归属、文档关闭竞态错误 |
| `src/components/viewer/embed/pdf-page-layers.tsx` | 单页图层栈（memo）：光栅 / 瓦片 / 选区 / 批注 / 链接 / 命中框 / 页边针 |
| `src/components/viewer/embed/dockview-viewport.tsx` | 视口注册 + sash 拖拽期 resize 门控 + 滚动指标按帧提交 |
| `src/components/viewer/embed/wheel-zoom-handler.tsx` | ⌘滚轮缩放绑定（passive 切换 + 每帧合并） |
| `src/components/viewer/embed/active-card-scroll-sync.tsx` | 滚动时按帧重锚浮动卡片 |
| `src/components/viewer/embed/outline-tree.tsx` | 大纲（书签）递归列表 |
| `src/components/viewer/embed/citation-links.tsx` | 文中链接命中层与目标预览解析 |
| `src/components/viewer/embed/layout-translate-overlay.tsx` | 全文翻译逐块覆盖层与字号自适应 |
| `src/components/viewer/embed/chrome/` | 纯展示 chrome：`pdf-toolbar` / `pdf-find-bar` / `pdf-outline-panel` / `pdf-bottom-bar` / `pdf-card-stack`（portal 卡片栈） |
| `src/components/viewer/embed/use-pdf-cards.ts` | 浮动卡生命周期：打开 / 定位（虚拟化重试）/ hover 收起 |
| `src/components/viewer/embed/use-pdf-highlights.ts` | EmbedPDF 标注桥：高亮视图模型、页边针锚点、链接分页图、导入迁移与防抖导出 |
| `src/components/viewer/embed/use-pdf-marks-io.ts` | `marks/` 读取与文件监听刷新（指纹比对后再提交 state） |
| `src/components/viewer/embed/use-pdf-text-selection.ts` | 选区检测、划词菜单状态与复制拦截 |
| `src/components/viewer/embed/use-pdf-ask-threads.ts` | 划词提问工作流：建/续/停、ACP 流监听、`marks/<id>.json` 落盘 |
| `src/components/viewer/embed/use-pdf-selection-translate.ts` | 划词翻译工作流与结果卡状态 |
| `src/components/viewer/embed/use-pdf-visual-marks.ts` | 框选裁剪与 visual mark 工作流（批注 / 加入对话 / 续聊） |
| `src/components/viewer/embed/use-pdf-layout-analysis.ts` | 版面分析、图/公式 hover（`visualDraftEditor` 与 `formulaAnnotationPreview` 互斥的唯一 owner）、`Annotation.md` 符号表、全文翻译任务 |
| `src/components/viewer/embed/use-pdf-page-text.ts` | 按需加载页文字矩形（页边针是否压字） |
| `src/components/viewer/embed/use-pdf-citations.ts` | 文中引用 hover 预览与跳转 |
| `src/components/viewer/embed/use-pdf-find.ts` | `⌘F` 查找 |
| `src/components/viewer/embed/use-pdf-outline.ts` | 书签大纲加载 |
| `src/components/viewer/embed/use-pdf-viewer-handle.ts` | 注册命令式 handle（跨簇，唯一入口） |
| `src/components/viewer/embed/engine-provider.tsx` | PDFium engine 宿主：worker 优先 + 就绪探针 + 主线程回退 |
| `src/components/viewer/embed/pdf-region-select-layer.tsx` | 图片区域框选覆盖层 |
| `src/components/viewer/embed/pdf-region-crop.ts` | PDF 区域裁剪与 Agent 图片编码 |
| `src/components/viewer/panels/figures-panel.tsx` | 版面分析入口（右栏 header：分析 / 显示 bbox） |
| `src/components/viewer/panels/annotations-panel.tsx` | 批注 / 提问 / visual mark 总览（右栏） |
| `src/components/viewer/panels/references-panel.tsx` | 参考文献解析与入库（右栏） |
| `src/components/viewer/pdf-ask/visual-annotation-editor.tsx` | 框选后批注编辑器 |
| `src/components/viewer/pdf-citation-preview.tsx` | 文中引用悬浮预览 |
| `src/components/viewer/pdf-ask/formula-annotation-card.tsx` | 公式 hover「公式解析」符号对照卡 |
| `src/components/viewer/pdf-viewer-registry.ts` | 按 tab 注册 `PdfViewerHandle`，供 shell / 命令面板调用 |
| `src/lib/pdf/equation-annotation/` | `Annotation.md` 符号表解析与加载 |
| `src/lib/agent/visual-context-store.ts` | Agent composer 视觉批注草稿 |
| `src/lib/pdf/agent-trace/` | visual mark 契约（v2 + 读兼容 v1）/ mark 资产 IO / prompt / Open-in-Agent / 会话 pending |
| `src/lib/pdf/highlight/` | 高亮 / 批注 |
| `src/lib/pdf/ask/` | 划词提问 |
| `src/lib/pdf/layout/` | EmbedPDF layout-analysis：归一化 bbox、`source/layout.json` raw sidecar、内存 UI store |
| `src/lib/pdf/region.ts` | 区域坐标归一化与 PDF rect 转换 |
| `src/lib/pdf/translate/` | 划词翻译 IO |
| `src/lib/pdf/zoom.ts` | 精确缩放比例解析与范围限制 |
| `src/lib/pdf/wheel-zoom.ts` | ⌘滚轮缩放 delta 累加与每帧合并步进；wheel 监听 passive / non-passive 切换 |
| `src/lib/pdf/annotations-store.ts` | 按 tab 状态 |
| `src/lib/pdf/selection/` | 选区与 marks IO |
| `src/lib/core/math.ts` | `clamp01` / `clamp`（几何与放置的唯一实现） |

组织约定：`embed/` 放阅读器实现（外壳 + 按域 `use-pdf-*` hook + 单页图层 + 纯展示 `chrome/`），`panels/` 放右栏面板（只被 shell 引用），`pdf-ask/` 放划词与 mark 卡片。`src/components` 下不设 `index.ts` barrel。

## 版面分析（Figures 侧栏）

右栏 **Figures**（原「解析」header：分析 / 叠加层）→ 页内检测 → 列表（image/chart、table、algorithm、**有编号 formula 置底**）。

**完整流水线、14 条核心规则、阈值与代码地图**见：

→ **[pdf-layout-analysis.md](pdf-layout-analysis.md)**

要点：先文字角色再联图；图题须整框在 figure bbox 内；图无 title 丢弃；默认置信度 30%；Paper PDF 的初步解析结果缓存到 `{paper}/source/layout.json`，后续 merge/filter 可重复计算。

**Hover 视觉提问：** 指针在插图 / 表 / 算法 / 有编号公式上停留约 600ms 后，自动裁剪该区域并打开 `VisualAnnotationEditor`（与手动框选相同；不自动发送 Agent）。中途移开取消；打开后离开源区 / 草稿卡约 1000ms 自动关闭（与 ask / 视觉 pin 卡 hide 一致，便于指针移到卡片）；框选模式或已有草稿卡时不触发。手动框选草稿不会因移开而自动关闭。

**Hover 公式解析：** 当论文目录存在 `Annotation.md`（由 `equation-annotation` Skill 生成的符号词典）且解析到符号表时，hover **有编号公式** 不打开视觉提问，改为弹出「公式解析」卡片：展示符号 / 含义 / 通俗理解对照（符号列 KaTeX 渲染）。卡片可打开 `Annotation.md`。

Hover UX（与视觉提问分离）：

| 项 | 值 |
|---|---|
| 打开 dwell | ~280ms（无裁图，比视觉提问 600ms 更短） |
| 移走关闭 | 离开公式 hit 或卡片后 ~320ms（够穿越到卡片空隙；比 1s 更利落） |
| 回到公式 / 卡片 | 取消关闭；同一公式重新进入立即保持打开 |
| 切换公式 | 图例已开时 hover 另一公式立即切换（无二次 dwell） |
| 滚动 / 缩放 | 卡片随 bbox 重定位 |
| Escape | 立即关闭 |
| hit 层 | 图例打开时仍挂载，负责 leave/enter，不依赖第二层 hover surface |
| 页上框 | 与视觉提问相同的 primary 描边框，标出当前公式区域 |

无 `Annotation.md` 或表为空时，公式仍走上述视觉提问 hover。实现：`src/lib/pdf/equation-annotation/`、`formula-annotation-card.tsx`、`LAYOUT_FORMULA_HOVER_*`。

Host 下载/解析：[../backend/paper-import.md](../backend/paper-import.md)。

引用元数据解析与 References 侧栏：[../backend/citation-parsing.md](../backend/citation-parsing.md)。
