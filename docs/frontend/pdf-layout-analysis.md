# PDF 版面分析（Figures / Tables / Algorithms / Formulas）

版面检测（默认浏览器内 ONNX PP-DocLayoutV3，可选远程 Provider：Paddle PP-StructureV3 / MinerU 云 API）→ 应用层 **文字角色 + 联图聚合 + 公式按编号框几何聚合（不解析编号文本）+ 置信度去重** → 右栏 **Figures**。

> 该能力已落地并可随论文打开自动运行；大模型推理在低端设备上可能卡顿，分析结果仅写入可重建 sidecar，不改 PDF 二进制。

| | |
|---|---|
| 上游 | [EmbedPDF Layout Analysis](https://www.embedpdf.com/docs/react/headless/plugins/plugin-layout-analysis) |
| 代码 | `src/lib/pdf/layout/`、`viewer/panels/figures-panel.tsx`（header 按钮）、`viewer/pdf/hooks/use-pdf-layout-{regions,run,hover,translate}.ts`、`viewer/pdf/layers/page-layers.tsx`（页内命中框与 bbox 叠加） |
| 持久化 | Paper PDF 写入 `{paper}/source/layout.json`（raw text-enriched regions）+ `{paper}/source/layout-index.json`（侧栏同构，供 CLI）；`layoutAnalysisStore` 仍是运行时 UI store |

---

## 流水线（一图）

```text
下载 / 添加入库完成后 → 后台任务「解析插图、表格、文字」
        │  headless EmbedPDF 栈写 `{paper}/source/layout.json`（有缓存则跳过；`force` 不跳过）
        │  只打开论文根目录 `{id}.pdf`。根文件还没落盘时跳过，不改用 `source/assets/` 里的插图 PDF
        │  实现：`enqueue-paper-layout.ts` + `headless-analyze.ts`
        │
打开论文 PDF（含非 active 的已挂载 tab）→ enqueue 到后台任务队列
        │  多篇并行打开：都进左下角任务列表
        │  本地 ONNX：JobCenter layoutAnalyze cap=1（避免抢模型）
        │  远程 Provider（Paddle / MinerU）：无 JobCenter 并发上限（远端排队）；进度事件用 requestId 隔离
        │  实现：viewer mount 调 `enqueuePaperLayoutAnalysis`（与入库后同一路径）
        │  终态 `job_report` / 取消必须释放该 cap，否则后续任务会一直排队
        │  后台 ONNX 不依赖当前 active 论文窗口：headless EmbedPDF 独立打开 `{id}.pdf`
        │  激活中的 tab：有 layout.json → 静默载入 store（无新任务条）
        │  已在内存里的结果不会挡住这次载入：`generatedAt` 变了就重新 merge 进当前 tab。
        │  headless 强制重跑写在 `headless-layout-*` 上并随任务结束清掉，侧栏读的是
        │  查看器 documentId；不重载的话重启前一直显示上一次解析（例如只有一页）
        │  viewer-bound 分析在每个异步边界检查 document 是否仍 open；关闭/切换竞态按取消处理
        │  尚无缓存 → 轮询 sidecar，headless 写完后再静默载入
        │  无 paper 目录的散落 PDF：仅 active tab 用 viewer 内分析（asBackgroundTask）
        │  手动：Figures header「分析 / 重新分析」仍是 `force: false`（有缓存不重跑模型）
        │  插图侧栏右上角刷新按钮（Eye 左侧）：确认后强制重跑这一篇
        │     · PDF 必须是论文根目录 `{id}.pdf`；没有则提示，不删 sidecar、不入队
        │     · 取消这篇进行中的 `layoutAnalyze`，再以 `force: true`、focus lane 入队
        │     · executor 把 `force` 传进 `analyzePaperLayoutHeadless`，否则
        │       `regions.length > 0` 会直接返回缓存
        │     · 入队成功后再删 `layout.json` 与 `layout-index.json`
        ▼
PP-DocLayoutV3  每页: render → detect → map to PDF points（仅无 sidecar 或 force）
        │  LayoutBlock[]（插件全量标签；页上 LayoutAnalysisLayer 仍画原始框）
        ▼
① 抽 caption 文字（PDF text runs）
        │  captionRole: figure_main | table_main | algorithm_main | subpanel | other
        │  formula / formula_number **不**解析编号文本
        │  写入 {paper}/source/layout.json
        ▼
①b source/layout.json 缓存命中（打开论文 / 点「重新分析」默认路径）
        │  跳过 PP-DocLayoutV3，只从 raw regions 重新 `mergeCaptionsIntoHosts` + 去重
        │  `source.textLayerExtracted === true`：通常不再读文字层；旧 MinerU 缓存还需
        │  `source.figureCaptionsExtracted === true`，否则本地补读一次编号图注，不重新上传 PDF
        │  标记缺失（含已经存了正文的旧文件）：再抽一次文字层。抽完才写回，
        │  保留 generatedAt；写之前核对 mode、generatedAt 和框几何仍是同一次解析。
        │  某一页没读完则不打标记，下次打开再抽。正文词序变了的块，译文缓存按原文 miss 后重译
        ▼
② mergeCaptionsIntoHosts（联图 / 表题 / 算法题 / 公式按编号框几何合并）
        │  输出 PdfLayoutRegion[]（图题可缺失；公式仅保留有 formula_number 锚点）
        ▼
③ 侧栏展示: isSidebarLayoutKind + dedupeLayoutRegions(minScore 默认 0.3)
        │  分区顺序：插图 → 表 → 算法 → **公式（最底）**
        │  解析运行中：匹配 viewer run 或 JobCenter layoutAnalyze；无结果时居中加载，已有结果时顶部显示进度条与 page/pct
        │  进度归属：`layoutAnalysisStore.activePaperAbsPath`（headless 的 documentId 是
        │  `headless-layout-*`，不能只靠 activeDocumentId）；排队中的 `layoutAnalyze`
        │  任务经 BackgroundTask.paperPath 与当前论文 vault-relative 路径匹配
        ▼
右栏 Figures + 聚焦高亮（store.focused）+ 可选 PDF bbox 叠加层（Eye，调试）
        │  叠加层画 **rawRegions**（合并前、全 kind、无 NMS；score ≥ 0.3）
        │  每框标注分类 + 置信度（如「图片 87%」「摘要 91%」）
        │  标签映射须覆盖 PP-DocLayoutV3 全量（含 abstract）；未映射 label 会在 normalize 被丢弃
        │  侧栏 / hover 仍用 **regions**（post-merge；不含 abstract）
        │  不用 EmbedPDF LayoutAnalysisLayer 画框：sidecar 缓存命中时插件无 page layout
        │
④ PDF 页交互 → 视觉批注卡
        │  hit 层用 **post-merge** 区域（与侧栏同源，非插件 raw 框）
        │  插图 / 表 / 算法 / 有编号公式：hover 框右上角提示「单击进行批注」；
        │    单击 → VisualAnnotationEditor
        │  实现：`hit-test.ts` + `pdf-viewer`
        │
⑤ 正文 / 摘要 / 标题文字抽取（PDF text layer → region.text）
        │  分析或 sidecar 回填时 enrich；供调试与 bulk 翻译
        │  同一行按字形底边对齐（加粗或更大的字头顶更高，底边仍和邻字对齐），
        │  行内从左往右，再接下一行。抽正文和英文句子对字形共用
        │  `reading-order.ts`
        │
⑥ 工具栏「翻译」icon（视觉批注旁）：按阅读顺序批量翻译文字类区域
        │  并发 2；每完成一块立刻盖译文图层（`LayoutTranslateOverlay`）
        │  再次点击：运行中=停止；已有译文=清除
```

注册（`pdf-viewer.tsx`）：

```ts
LayoutAnalysisPluginPackage: {
  layoutThreshold: 0.3,  // 与侧栏默认置信度一致
  tableStructure: false,
  autoAnalyze: false,
  renderScale: 2,
}
```

### 模型落盘（Host / XDG）

| 项 | 值 |
|---|---|
| 路径 | `$XDG_CACHE_HOME/agentero/models/pp-doclayoutv3.onnx`（Unix 默认 `~/.cache/agentero/models/`） |
| 启动 | Host `spawn_background_download` 入队 JobCenter `modelDownload` job（已有文件则跳过；并发触发按 fingerprint 去重） |
| 面板 | JobCenter 投影成 `modelDownload` 行（字节进度 `job:progress`，task id = job id；取消走 `job_cancel`） |
| 代理 | 设置里的 `networkProxyEnabled` / `networkProxyUrl`（`core::http::client_builder`） |
| 源顺序 | **ModelScope 优先** → HuggingFace 回退 |
| ModelScope | `greatv/oar-ocr` → `pp-doclayoutv3.onnx` |
| HuggingFace | EmbedPDF `PP-DocLayoutV3-ONNX/model_fp16.onnx` |
| 来源标记 | 同目录 `pp-doclayoutv3.onnx.source` |
| 前端 | `agentero-model://…/pp-doclayoutv3.onnx`（Windows：`http://agentero-model.localhost/…`） |
| Commands | `layout_model_status` / `job_model_download_enqueue` |

实现：`src-tauri/src/features/paper/analyze/layout/model_assets/`、`src/lib/pdf/layout/model.ts`、`ai-runtime.ts`。

### 后端选择（本地 ONNX / 远程 Provider）

设置 →「版面解析」可选择检测后端（`settings.layout.backend`），选项由前端注册表 `LAYOUT_PROVIDERS`（`src/lib/pdf/layout/providers.ts`）驱动；下拉只列出本地 + 已配置（apiKey 非空）的 provider，可选项 ≤1 时保留 Select 外观但 disabled、不弹出菜单（正文解析引擎 `parserBackend` 同理，避免换成纯文本导致布局抖动）。**内置 provider（`agentero`）没有 apiKey，因此必须和 `local` 一样豁免这条过滤**，否则它会整个从 `parserBackend` 下拉里消失、用户根本选不到：它改由 Host 可用性（`useBuiltinProviderAvailable`）门控，不可用时**若已被选中仍留在列表里但渲染为 disabled**，而不是凭空消失。凭证卡片一侧由 `isProviderCardConfigurable` 过滤掉没有任何可编辑字段的卡片，所以内置 parser 不会渲染出空卡或只有一个 Confirm 的卡。配置卡里清空 API Key 会立即清除已存密钥（无需点确认）；若当前后端指向该 provider 则回退本地：

凭证卡片区默认只平铺 Paddle / MinerU（推荐路径），OpenAI 兼容这类通用兜底卡片收进默认折叠的「其他服务商」，并用一行提示引导先配置 Paddle / MinerU（issue #656）。解析失败时给出可操作的排查入口：查看器内失败 toast 带「打开解析设置」动作（`use-pdf-layout-run.ts` 的 `notifyLayoutFailure` → `openSettingsWindow("layout")`，带动作时停留 20s）；headless / JobCenter 的 `layoutAnalyze` / `parseBody` / `parseRefs` 失败没有查看器 toast，由后台任务面板补同款 toast（`background-tasks-panel.tsx`，排除手动的 `layoutRun` 以免重复）；上述四类失败行本身也带一个设置跳转按钮。

| 后端 | 值 | 说明 |
|---|---|---|
| 本地推理（默认） | `local` | 浏览器内 ONNX PP-DocLayoutV3，完全离线 |
| Paddle API | `paddle` | AI Studio 托管 PP-StructureV3 **异步任务** API，**整份 PDF 会上传到云端**；端点固定（`supportsBaseUrl: false`） |
| MinerU（云端 API） | `mineru` | mineru.net 批量解析 API，**整份 PDF 会上传到云端**；支持 Base URL 覆盖（https-only，loopback 例外）、语言（默认 `ch` 中英文，可选纯英文）与强制 OCR 选项（`supportsLanguage` / `supportsOcr`） |

**`agentero` 刻意不在这张表里**：内置 provider 只是**正文解析**（`parserBackend`）后端，不是版面分析后端。版面分析继续跑上表的 `local`（随包 PP-DocLayoutV3 ONNX，首次使用下载到 XDG cache，经 `agentero-model://` 喂给 webview）——已经免费且离线，切到云端网关只会让每个 PDF 都产生费用而无收益。Host 侧 `LAYOUT_BACKENDS` 白名单不含它，`default_layout_backend()` 无条件返回 `local`；把它写进 `backend` 会在下次保存时被重置。理由与实现见 [../backend/builtin-provider.md](../backend/builtin-provider.md) §版面分析不走内置。

每个 provider 描述符带 `kind` / `requiresApiKey` / `supportsBaseUrl` / `sidecarMode`（MinerU 另有 `supportsLanguage` / `supportsOcr`）：设置面板与 Onboarding 据此显隐 API Key / Base URL / 语言 / 强制 OCR 输入（保存 / 掩码 / 连通性测试逻辑共用 `provider-config.ts`）；`run-analysis.ts` 用 `layoutProviderFor(backend)` + `isRemoteLayoutProvider` 判定走远程分支（`startRemoteLayoutAnalysis`，按 `provider.id` 分发到 Host engine 注册表）。内置 provider 的描述符只在 `PARSER_PROVIDERS` 里（`LAYOUT_PROVIDERS` 不含它），且 `requiresApiKey` / `supportsBaseUrl` / `supportsModel` / `supportsPrompt` / `supportsLanguage` / `supportsOcr` **全为 false**——VLM 引擎只读 model 与 prompt，而这两项都由构建期凭证给出，所以面板不为它渲染任何凭证输入或连通性测试。

远程 provider 共用流程（`src/lib/pdf/layout/paddle.ts` IPC 封装 + `run-analysis.ts`）：

1. 读取本地 PDF，整份 base64 交给 Host 命令 `layout_remote_analyze_pdf`（`provider` 参数分发到 `src-tauri/src/features/paper/analyze/layout/hosted/` 的 `RemoteLayoutEngine` 实现：`paddle.rs` / `mineru.rs`）；token 由 Host 从设置注入，WebView 只持有 `*` 掩码；
2. Host 轮询远端任务（总时限 10 分钟），期间通过 `layout-remote:progress` 事件回报进度（`requestId` 隔离并行任务）；
3. 每页返回统一的 `boxes`（像素坐标 + `label` + `score`）；
4. 后续与本地路径完全共用：PDF text runs 补文字 / captionRole → `mergeCaptionsIntoHosts` → sidecar / index。

**Paddle**（`paddle.rs`）：multipart 提交 `POST https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`（`model: PP-StructureV3`，`Authorization: bearer <token>`）→ 每 3s 轮询 `GET …/jobs/{jobId}` → 下载 `resultUrl.jsonUrl`（JSONL），提取每页 `prunedResult.layout_det_res.boxes`；渲染像素尺寸优先取响应 `dataInfo` / `inputImage` JPEG 头，缺失时按 200 DPI 估算（归一化 `bbox` 不受影响，仅 points `rect` 可能有轻微偏差）。API Key 在 [AI Studio 访问令牌页](https://aistudio.baidu.com/account/accessToken) 获取。

**MinerU**（`mineru.rs`）：`POST {base}/api/v4/file-urls/batch` 申请预签名上传 URL → `PUT` 上传 PDF 字节 → 轮询 `GET {base}/api/v4/extract-results/batch/{batchId}` → 下载结果 zip，解析 `*content_list.json` + 中间结果（每页尺寸；条目名按候选匹配：旧版 `*middle.json` / `middle.json`，云端 v4 为 `layout.json`）。`content_list` 的 bbox 是 **0–1000 归一化** 坐标，Host 按中间结果页尺寸换算回像素；`type`（`image` / `table` / `equation` / `code` / `title`…）在 Rust 侧映射到与 PP-DocLayoutV3 统一的 label 词表（`labels.ts` 直接复用），无置信度字段 → score 固定 1.0（通过前端 0.3 阈值、不扭曲排序）。Base URL 可覆盖（默认 `https://mineru.net`，强制 https，loopback 例外）；不受信 zip 有下载 / 解压上限。API Token 在 [mineru.net API 管理页](https://mineru.net/apiManage/token) 获取。

- 标签词表与本地一致，阈值同为 0.3。
- sidecar `source.mode` 按 provider 记为 `paddle-layout` / `mineru-layout`（本地为 `embedpdf-layout`），均可被解析。
- 进度 / 取消沿用 `LayoutTask` 形状。JobCenter 对远程 provider **不设并发上限**；`layout-remote:progress` 带 `requestId`，并行任务互不串进度。
- 无 paper 目录（拿不到 PDF 字节）或页数未知时自动回退本地 ONNX。

### Layout sidecar

`{paper}/source/layout.json` 保存 **初步解析结果**：模型标签映射后的 `PdfLayoutRegion[]`，并已尽力补充 caption 文本与 `captionRole`（公式编号文本不解析）。它不保存侧栏最终卡片列表，也不保存缩略图；后续 `mergeCaptionsIntoHosts`、去重和置信度筛选都从该 raw sidecar 重新计算。因此修改联图、公式合并或筛选规则后，不需要重新运行 PP-DocLayoutV3。

```ts
type LayoutSidecar = {
  schemaVersion: 3;
  source: {
    mode: "embedpdf-layout" | "paddle-layout" | "mineru-layout";
    generatedAt: string;
    textLayerExtracted?: boolean; // 文字层整篇已抽过；缺省则打开时再抽一次
  };
  regions: PdfLayoutRegion[]; // raw, pre-merge
};
```

#### 侧栏索引（CLI）

`{paper}/source/layout-index.json` 在 **每次 merge 后**（含缓存命中只重算 merge）写出，与 Figures 轨 / hover 目标同源：

- 过滤：`isSidebarLayoutKind` + `LAYOUT_SIDEBAR_MIN_SCORE` + NMS（`dedupeLayoutRegions`）
- 分区：figure（image+chart）→ table → algorithm → formula
- 字段：`id`（如 `figure-3`）、`stableKey`、`kind`、`section`、`page`（**1-based**）、`pageIndex`、`bbox`（0–1）、`score`、`title?`、`layoutRegionId`
- 代码：`src/lib/pdf/layout/layout-index.ts`、`writeLayoutIndexFromRaw`（`io.ts`）
- CLI：`agentero layout list|get`、`agentero mark add --region <id>`（见 [../backend/cli.md](../backend/cli.md)）

缓存只在已知 paper folder 时启用；散落 PDF 没有 `{paper}` 路径，仍使用当前内存流程（也不写 index）。

**重新分析按钮**（Figures header）：`force: false`。有 `source/layout.json` 时不跑 PP-DocLayoutV3。文字层标记已在则只重跑 JSON→侧栏（`mergeCaptionsIntoHosts` + NMS），不改 raw sidecar。标记缺失时把抽到的文字写回同一次解析，`generatedAt` 不变；写之前若磁盘上的 mode、时间戳或框几何已经变了，则放弃这次写回。两种情况都会刷新 `layout-index.json`（内容没变则不落盘）。无缓存时才走完整 PDF→JSON。

**强制重新解析**（插图侧栏右上角，布局叠加开关左侧）：确认弹窗后只处理当前这一篇。入口 `forcePaperLayoutAnalysis`（`enqueue-paper-layout.ts`）+ `PdfForceLayoutButton`。根目录没有 `{id}.pdf` 时只提示，不改 sidecar。否则取消这篇进行中的 `layoutAnalyze`，enqueue `force: true`（focus lane），入队成功后再删 `source/layout.json` 和 `source/layout-index.json`。`analyzePaperLayoutHeadless` 读任务上的 `force`，为真时跳过「已有 regions 就返回」；`runDocumentLayoutAnalysis` 同样收到 `force: true`。版面分析重新选 PDF 时只用 `canonicalPaperPdfPath`（`{paper}/{id}.pdf`），根目录文件不在则 soft-skip，不再调用会下钻到 `source/assets/` 的 `findLocalPdfPath`。远程 provider 上传同一条路径。

**全库重置**（设置 →「版面解析」底部两个按钮）：Host 命令 `clear_parse_results` / `clear_and_reparse`（`src-tauri/src/features/jobs/commands.rs`）按 catalog 逐篇删除所选 scope 的解析产物——`layout`（`source/layout.json` + `layout-index.json`）、`paper`（`PAPER.md`）或 `all`（默认）。删除前先取消该 Vault 下相关 queued/running 的 `layoutAnalyze` / `parseBody` job（防止晚到的 runner 把旧结果写回），删除后清空 `CapsCache`。「清除并重新解析」再对全部论文 enqueue `force: true` 的重新解析 job（idle lane，沿用 per-kind 并发上限）。仅支持本地 Vault；前端入口 `src/lib/paper/reparse.ts` + `layout-pane.tsx`（确认弹窗内选 scope）。

---

## 规则清单（现行，共 **21** 条核心规则）

按阶段编号。实现常量见 `merge-captions.ts` → `LAYOUT_MERGE`。

### A. 标签与侧栏（4）

| # | 规则 | 说明 |
|---|---|---|
| **A1** | 模型 label → kind | 映射：`image` `chart` `table` `algorithm` `formula` `formula_number` `figure_title` `header` `text`/`aside_text`→`text`；其余丢弃 |
| **A2** | 侧栏种类 | 展示 **image / chart / table / algorithm / formula（有 formula_number 框并成功合并）**；**不展示** 无编号框 formula / 裸 `formula_number` / caption |
| **A3** | image+chart 同区 | 侧栏「插图」分区；NMS 时同属 `figure` 组；**公式分区固定在列表最下方** |
| **A4** | 纯 text/header 不得当图片 | 若 image/chart 被 score≥0.3 的 text/header/abstract **覆盖 ≥55%** 且正文置信度不低于图的 ~85%，则 **丢弃** 该 image/chart（双标 / 段落误检）。Eye 叠加层与 merge 共用 `suppressSpuriousFigureDetections` |

### B. 文字角色（4）

| # | 规则 | 说明 |
|---|---|---|
| **B1** | 文本角色优先 | `Figure N` / `Fig. N \|` / `Extended Data Fig. N \|`→`figure_main`；`Table N`→`table_main`；`Algorithm N`→`algorithm_main`；`(a)` / 单字母 `a`→`subpanel`（即使模型标成 figure_title） |
| **B2** | 无文本时几何兜底 | 宽≥0.45 且矮 → 可能主图题；窄短框保持未定角色，已知主图题优先聚合后，再用邻近图框恢复无文字图题（单栏 / 多子图均可）。旧 sidecar 中无文字的几何 `subpanel` 重新判断 |
| **B3** | 角色驱动绑定 | `table_main` 只绑 table；`figure_main` 只绑图；`subpanel` 不当整图锚点 |
| **B4** | 正文误标与漏检图题恢复 | `text` / `header` 以**带编号 + 标点**的主图题开头时，在 merge 中提升为 `figure_main`；也从 PDF text runs 恢复模型漏检的图注并缓存真实几何。包含无检测框的图注页。双栏续文仅在字符序连续且几何匹配时合并；`Figure 5 contains …` 等正文引用不提升 |

### C. 类型分家与贴题方向（2）

| # | 规则 | 说明 |
|---|---|---|
| **C1** | 宿主族隔离 | figure / table / algorithm 不交叉绑主标题 |
| **C2** | 贴题方向 | **图：标题在下**；**表 / 算法：标题在上**（学术惯例） |

### D. 联图与 figure_title（5）

| # | 规则 | 说明 |
|---|---|---|
| **D1** | 主图题锚点 | `figure_main`（或宽 figure_title）优先启动联图；无文字的窄 figure_title 延后匹配，不能抢占已知主图题的子图 |
| **D2** | 竖向带 | panel 须在「水平方向相交的上一主图题底边 → 本图题顶边」内；另一栏图题不截断当前栏 |
| **D3** | 全宽 vs 半宽 | 先过滤置信度 < **0.3** 的图框和图题 / 图例候选，再从距图题 ≤ **0.12** 的子图所在连通组聚合；正文 / 表 / 算法在竖向间隙内阻断连接和贴题。图题宽 ≥ **0.55** 可同时锚定多个不连通的列，保留多行联图且不设高度软上限；半宽只取最贴近图题的组，保留高度软上限 0.55。远处孤立框不因全宽图题而被收入 |
| **D4** | 可选图题 | 同页 `titleBbox` 必须完整包含在 figure `bbox` 中；缺图题或仅有图题文字的可靠图仍保留，继续经过正文 / 表格重复框抑制、面积 / 分数门槛和 NMS |
| **D5** | 保守跨页关联 | 前页底部或后页顶部的编号图注，只与唯一、面积≥0.15、内部无正文阻断且没有同页主图题的连通图组配对；图号冲突或多个候选时保留未命名图。`See next page for caption` 仅作图号约束。跨页图注写入独立的 `captionPageIndex` / `captionBbox`，不扩张图片页 bbox，也不伪造 `titleBbox` |

### E. 清理与展示（2）

| # | 规则 | 说明 |
|---|---|---|
| **E1** | 孤儿 panel | 落在更大联图内（覆盖≥0.55）的无主标题 panel 丢弃；已有主图题的窄图不当孤儿。左右裁切仅用于纵向重叠且图题水平分离的半宽图，上下独立图不裁切 |
| **E2** | 侧栏 NMS | 默认 `minScore=0.3`、`minArea=0.002`、同组 IoU≥0.45 抑低分、小框被盖≥0.85 丢小 |

### F. 公式编号框聚合 — **同行-only，不解析编号文本**

| # | 规则 | 说明 |
|---|---|---|
| **F1** | 必须有够分的 formula_number 框 | **仅**模型 `formula_number` 且 **score ≥ 0.3** 可启动合并；无编号框 / 低分噪声编号 **不**进侧栏；**不**解析 `(1)` 等编号文本 |
| **F2** | 主体 seed 够分且够矮 | formula 体 **score ≥ 0.3** 且 **h ≤ 0.055**（拒段落级误检）；优先高分 / 大宽 |
| **F3** | **禁止竖向多行 grow** | 只并**同一基线带**内、与 seed 竖向重叠 ≥0.35 的碎片；**不**把上下行 / 正文行间公式并进 host |
| **F4** | 侧栏位置 | 合并后 display formula 在 **插图 / 表 / 算法之后（最底）**；标题用 i18n 回退；`title` 不写编号串 |
| **F5** | 排序 = 阅读序 / 序号序 | **页 → 左栏 → 右栏 → 栏内自上而下**（以 `titleBbox`/编号框中心 vs `columnMidX=0.5` 分栏）；双栏避免纯 y 排序把左右栏交错 |

竖向 band 只按 **编号框高度** 收紧（`bandPad=0.02`），不随 body 高度放大。`titleBbox` 保留编号框几何。

**已废止：**
- 与 text 重叠 ≥0.28 则丢（旧 F2）— 段落 text / 双标低分 text 会全灭公式
- 多行竖向邻接扩展（`formulaNeighborGap`）— 会把正文行间公式连成整段高亮

半宽并排（Fig7\|Fig8）仅在双方都是半宽时做**软**水平分开，并**再并回完整 title**；全宽联图不做 mid-split。

---

## 已收敛 / 视为多余（勿再加分支）

| 项 | 状态 |
|---|---|
| 多套「全宽」阈值 0.55 / 0.62 | **已统一**为 `LAYOUT_MERGE.fullWidthTitle = 0.55` |
| 硬中线切全宽图导致细条框 | **已废止**（仅半宽软切 + 标题回并） |
| `clipFigureBboxToTitleColumn` 裁掉标题一半 | **已改为** `buildFigureBboxWithFullTitle`（标题必整框） |
| 缺图题即删除 image/chart | **已废止（#704）**；可靠图不依赖图题存在，`requireFigureTitles` 只保证已有同页标题框完整 |
| 侧栏默认 50% 置信度 | **已改为固定 30%**（无 UI 滑条） |
| 文档写死 0.5 / 无 merge 流水线 | **以本文为准** |
| `looksLikeFigureCaption` | 兼容别名，等价 `captionRoleFromText` 主类判断，勿再扩展 |
| formula 与 text 重叠即丢（旧 F2） | **已废止**（双标 text / 段落包公式 → 侧栏永远为空） |
| 公式多行竖向 grow | **已废止**（会吞并正文行间公式；现同行-only） |

---

## 阈值速查

| 符号 / 位置 | 值 | 用途 |
|---|---|---|
| `layoutThreshold` | 0.3 | 插件层检测 |
| 侧栏 `minScore` | 0.3（固定，无滑条） | 展示过滤 |
| `LAYOUT_MERGE.fullWidthTitle` | 0.55 | 全宽联图 |
| `LAYOUT_MERGE.maxHeightAboveTitle` | 0.55 | **仅半宽**图题无 ceiling 时的竖向软上限 |
| `LAYOUT_MERGE.panelBottomSlack` | 0.04 | 半宽：panel 底可越过 title 顶的量 |
| `LAYOUT_MERGE.fullWidthPanelBottomSlack` | 0.14 | 全宽：底行 chart 允许压进 caption |
| `LAYOUT_MERGE.panelNeighborGap` | 0.08 | 子图邻接 |
| `LAYOUT_MERGE.orphanContainment` | 0.55 | 吞并孤儿 panel |
| `LAYOUT_MERGE.formulaNumberMaxGap` | 0.28 | 公式体与编号水平间距 |
| `LAYOUT_MERGE.formulaNumberBandPad` | 0.02 | 同行竖带（相对编号框） |
| `LAYOUT_MERGE.formulaNumberMinScore` | 0.3 | formula_number 锚点最低置信度 |
| `LAYOUT_MERGE.formulaBodyMinScore` | 0.3 | formula 主体 seed 最低置信度 |
| `LAYOUT_MERGE.formulaMaxBodyHeight` | 0.055 | 拒绝过高「公式」误检 |
| `LAYOUT_MERGE.columnMidX` | 0.5 | 双栏分栏中线（公式排序） |
| `LAYOUT_MERGE.figureTextCover` | 0.55 | image/chart 被正文覆盖比 → 可能丢弃 |
| `LAYOUT_MERGE.figureTextMinScore` | 0.3 | 可否决 image 的 text/header 最低分 |
| ~~`formulaNeighborGap` / 竖向 grow~~ | — | **已废止** |
| ~~`formulaTextOverlap`~~ | ~~0.28~~ | **已废止** |
| NMS `iouThreshold` | 0.45 | 去重 |
| NMS `containmentThreshold` | 0.85 | 去重 |

---

## 返回类型（应用层）

```ts
type PdfLayoutRegion = {
  id: string;
  pageIndex: number;           // 0-based
  kind: "image" | "chart" | "table" | "algorithm" | "formula" | "formula_number" | …;
  label: string;
  score: number;               // 0–1 → UI %
  readingOrder: number;
  rect: { x, y, w, h };        // PDF points
  bbox: { x, y, w, h };        // 0–1 页相对
  title?: string;              // 图/表题文字（公式不解析编号串）
  titleBbox?: { x, y, w, h };  // 完整标题框，或公式的 formula_number 几何
  captionPageIndex?: number;  // 跨页图注所在页；图片 pageIndex 不变
  captionBbox?: { x, y, w, h };// 相对于图注页；不并入图片 bbox
  captionRole?: CaptionRole;
};
```

页上 `LayoutAnalysisLayer` 仍显示**模型原始**多框；侧栏 / 跳转 / 聚焦用 **合并后** `PdfLayoutRegion`。

---

## 代码地图

| 路径 | 职责 |
|---|---|
| `run-analysis.ts` | 分析 → 文字 → merge → store。远程后端上传 `{id}.pdf` |
| `enqueue-paper-layout.ts` | `layoutAnalyze` executor；`forcePaperLayoutAnalysis` 单篇强制重跑 |
| `chrome/pdf-force-layout-button.tsx` | 插图侧栏确认后强制重解析 |
| `providers.ts` / `provider-config.ts` | Provider 注册表（kind / requiresApiKey / supportsBaseUrl / sidecarMode）与设置 UI 共用的保存 / 探测逻辑 |
| `paddle.ts` | 远程分析 / probe 的 IPC 封装（provider 参数分发） |
| `io.ts` | `{paper}/source/layout.json` raw sidecar 读写与 schema 校验 |
| `title-text.ts` | 抽字、captionRole（**不含**公式编号文本解析） |
| `captions-from-runs.ts` / `figure-caption-text.ts` | 从真实 PDF 文字行恢复编号主图注、保守双栏续文、统一图号识别 |
| `merge-captions.ts` | 联图 / 表 / 算法 / **公式按 formula_number 几何合并**、标题完整包含 |
| `normalize.ts` | DocumentLayout → regions（sync 无文字） |
| `dedupe.ts` | 侧栏 NMS |
| `labels.ts` / `colors.ts` / `store.ts` / `types.ts` | 映射、色、状态、类型 |
| `test/pdf-layout-*.test.ts` | 归一化 / 去重 / 角色 / 合并 / 公式 |

---

## 限制与后续

- 实验路径；大模型推理可能卡顿。后端为本地模型时，主窗口每次启动都会弹一次右上角提醒（仅首次运行向导覆盖时暂停；提示本机模型的性能代价，可「打开版面解析设置」或「不再提醒」，见 [settings.md](settings.md) §低频配置提醒）。
- 不改 PDF 二进制；只写可重建的 `{paper}/source/layout.json`。单篇强制重解析在 force 任务入队成功后删掉这篇的 `layout.json` 和 `layout-index.json`，再由新的解析重写。
- 版面分析只读论文根目录 `{id}.pdf`。根文件尚未落盘时跳过，不会改去解析 `source/assets/` 里的插图 PDF。查看器打开 PDF 仍用 `findLocalPdfPath`。
- `layout.json` 只缓存 raw layout，不等同于未来 `agentero-figures.json` / 缩略图资产 sidecar。
- 跨页关联只支持相邻页的唯一候选；更远的图注、扫描件无可用文字层或冲突图号不会强行配对，可靠无图题图片仍展示。MinerU #704 的真实论文回放与修复记录见 [mineru-missing-figures.md](../bug_fix/mineru-missing-figures.md)。
- **模型级整面板误标仍会漏图**（merge 层无法救回，页上没有可用 image/chart 检测）：ViT 附录 Fig 14（注意力图网格被标 `header` 0.91，同框 `image` 仅 0.05）、Transformer 附录 Fig 4（注意力可视化被标 `table` 0.88）。四篇论文（resnet / vit / transformer / swin，单双栏混合）实测图题召回 28/30 ≈ 93%，在容忍范围内；后续如换更强检测模型可回归 `test/pdf-layout-arxiv.test.ts` 复核。
- **真实 PDF smoke test（opt-in，默认跳过）**：`test/pdf-layout-arxiv.test.ts`，需 `AGENTERO_LAYOUT_PDF_DIR`（放 `<name>.pdf`）+ `AGENTERO_LAYOUT_MODEL`（pp-doclayoutv3.onnx 路径），`AGENTERO_LAYOUT_PDFS` 逗号分隔指定论文名（默认 `resnet,vit`）。逐页输出渲染 PNG、合并后 bbox 叠加 PNG 与 `*-detections.json`，供 before/after 回归对比（`/tmp/agentero-bbox-validation/compare.mjs` 为临时脚本，不在仓库内）。
- 后续：最终 figure sidecar、自动分析、一键视觉批注。
