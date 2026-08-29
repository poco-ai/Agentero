# 论文入库

多入口共享落盘内核 **`paper_commit`**（`features/import/paper_import`）：分配路径、写 catalog、NOTES 壳、资源。

## 入口

| 入口 | 元数据来源 | Host / 流程 |
|---|---|---|
| 魔棒 | Translator HTTP + arXiv Atom fallback | `lookup_import_batch` |
| 本地 PDF | 用户确认 / 文件名启发式 | `paper_import_local_pdf` |
| Connector | 浏览器扩展 items JSON | `features/connector` → commit |
| Zotero 迁移 | `zotero.sqlite` + storage | `zotero_scan` / `zotero_migrate` |
| Library 导入 | Bib/RIS 等 | `paper_import` |
| CLI | 同库函数 | `agentero import` / `paper …` |

路径分配：`import::allocate_paper_path`（盘 + catalog 双查，撞名改写 id）。

## Skill 导入

魔棒 `lookup_import_batch` 同时接受论文标识符和 Skill 来源。Host 在普通 URL
识别之前通过 `parse::extract_skill_source` 检测 Skill 来源（`skill` kind，不入
resolver 表），解析 GitHub 仓库、
GitHub tree、`github:`、`skills.sh` 和 `npx skills add` 输入。

Skill 安装管线位于 `features/import/skill_import.rs`：

1. 解析默认分支并下载 GitHub codeload tarball；
2. gzip/tar 安全解包，限制归档大小和文件数；
3. 扫描并校验 `SKILL.md` frontmatter；
4. 将压缩包和候选 metadata 保存为一次性 discovery，返回 `skillCandidates`；
5. `skill_install` 仅安装前端确认的 Skill 名称，复制整个 Skill 目录到 `.agents/skills/<name>/`；
6. 写入 `agentero-skill.json` 来源记录；取消操作由 `skill_discard` 清理 discovery。

Skill 不写入 catalog、不创建 `papers/` 条目、不执行 `scripts/`。已有目录跳过，
不会覆盖用户文件。批量候选通过 `LookupImportBatchResult.skillCandidates` 返回。远程 Vault
当前显式拒绝 Skill 导入。

## 魔棒（精确 ID/URL）

```text
粘贴 arXiv ID / DOI / URL
  → arXiv 输入先规范为 `https://arxiv.org/abs/<id>`，再交给 Translator（或 arXiv Atom fallback）
  → PaperMetadata → catalog upsert
  → papers/<id>/ + 带 aliases frontmatter 的 NOTES.md 壳（不覆盖已有 NOTES）
  → PDF → {paper}/{id}.pdf
  → arXiv e-print → 解压 LaTeX 到 source/
  → 无 TeX：liteparse → PAPER.md
  → 前端刷树 / openPaper
```

- 设置：`translatorBaseUrl`。
- arXiv 的 `abs` / `pdf` / `html` / `src` / `e-print` URL 与裸 ID 都会先提取 ID；不会将 PDF 二进制 URL 交给 Translator 的网页解析器。
- Translator 带回的 arXiv 学科分类（`Computer Science - Machine Learning` 这类 `"Archive - Sub-Field"` 标签）写入 catalog 时加 `@arxiv:` 前缀，作为隐标签保留来源、不出现在 Library / Paper Info / 标签筛选。用户自己加的普通标签不受影响。
- 补资源：`paper_download_assets`（单篇 / Library 批量）。
- 失败回滚：文件夹创建后，若 PDF 复制 / NOTES 壳 / catalog 写入任一失败，删除刚建的论文文件夹，避免出现树里有、catalog 无的"半篇论文"；资源下载阶段的错误不回滚（壳与 catalog 已落地）。
- 孤儿文件夹自愈：`paper_download_assets` 发现盘上论文文件夹缺 catalog 行（历史失败导入的残留）时，按 `metadata.json` sidecar 重建 catalog 行（无 sidecar 退化为文件夹名最小记录）并发 `paper:imported`，Library / 树随之刷新。
- 网络资源阶段有整篇论文 `3 分钟`截止时间（`PAPER_ASSET_TIMEOUT`），覆盖 PDF
  fallback、DOI 元数据查询及 arXiv e-print；单个 HTTP
  请求仍使用更短的 reqwest timeout。超时不会回滚已经写入的 paper 壳和 catalog，
  资源错误会保留在导入结果中，后续可再次执行补资源。
- Connector 不启动这条后台资源或解析管线：Chrome 先上传附件，DOI/arXiv Host 下载仅作
  fallback；附件成功或失败的 finalizer 先将 paper 移到 latest target，再通过稳定路径的
  `connector:item-saved` 交给现有 open/reconcile 解析流程。
- 错误：全局 Toast；重复不破坏用户 NOTES。
- 标识符去重（#406）：批量预检之外，commit 阶段再按 `id` / `arxiv_id` / `doi` / `pmid` / `isbn` 查 catalog（`DedupePolicy::ByIdentifiers`），任一命中即 `Deduped`，不新建文件夹。
- 新建壳会写论文全称 alias，并在元数据足够时写确定性短 alias；历史笔记由 [Doctor](doctor.md) 诊断和确认迁移。`created` 不属于入库壳或 Doctor 的职责。
- 壳内容由设置 `paper_note_mode` 决定（`standard` / `title-only` / `blank` / `custom`，默认 `standard`，见 [settings.md](../frontend/settings.md)）；`custom` 模板位于 `{vault}/.agentero/templates/NOTES.md`，缺失或不可读时回退 standard 并 warn。任何模式的产物都会补齐 aliases frontmatter（模板 frontmatter 不可安全改写时留给 Doctor）。Connector 的后台摘要机翻仅对 standard 壳生效，避免改写 custom 模板渲染的原文摘要。

## 可读正文

| 情况 | 行为 |
|---|---|
| 有 TeX | 优先 TeX；不强制 `PAPER.md` |
| 无 TeX 有 PDF | 下载后由选定的正文解析引擎生成 `PAPER.md`（默认本地 liteparse 隔离子进程，单次解析限时 120 秒） |
| 解析失败或超时 | 保留 PDF、`NOTES.md` 与 catalog；`paper_parse_body` 返回 `error`，对应 job 标记 `Failed` 并在任务面板展示原因，后续可重新执行 `paper parse` |
| 质量字段 | catalog `body_source` / `body_quality`（实现以 schema 为准） |

`PAPER.md` 是派生文件，可删可重建；`source/` 与 PDF 才是归档事实来源。

### 正文解析引擎（可插拔）

`settings.layout.parserBackend` 选择 PAPER.md 的生成引擎（Settings →「版面解析」），凭据与版面分析共用 `layout.providerConfigs`：

| backend | 流程 | `body_source` | `body_quality` |
|---|---|---|---|
| `local`（默认） | liteparse worker 子进程 + PDFium | `pdf` / `ocr` | `medium` / `low` |
| `mineru` | 复用 MinerU 批量提取（上传 → 轮询 → 结果 zip），读取 zip 内 `full.md` | `mineru` | `high` |
| `paddle` | 复用 AI Studio 异步任务，拼接 JSONL 中每页 `markdown.text`。正文模型默认 `PaddleOCR-VL-1.6`，可在设置里改（版面分析固定 `PP-StructureV3`，不受影响） | `paddle` | `high` |
| `openaiCompatible` | 渲染 worker 逐页出 150 DPI PNG（上限 100 页）→ OpenAI 兼容 `/chat/completions` 多模态 OCR（预设硅基流动；`PaddlePaddle/PaddleOCR-VL-1.5` 提示词 `OCR:`，`deepseek-ai/DeepSeek-OCR` 用 grounding 提示词，按 model id 自动选择） | `vlm` | `medium` |

- **回退**：云端引擎失败或产出空 markdown 时自动回退本地 liteparse，原因追加进 `messages`；用户取消不回退。`body_source` 始终记录实际来源。
- **凭据注入**：引擎配置以进程级快照持有（启动与 `settings_set` 时从 `AppSettingsStore` 刷新，模式同 `core::http::configure_proxy`），明文 key 不出 Host。
- **提示词**：默认按 model id 自动选择（含 `deepseek-ocr` → grounding 提示词；含 `paddleocr` → `OCR:`；其余 → 通用指令）。设置里的 Prompt 输入框可覆盖，留空即走自动。
  - ⚠️ `PaddleOCR-VL` 是**任务提示词**模型，只认它自己那几个固定提示词；换成自由指令会退化成检测模式并吐出 `<|LOC_n|>` 坐标 token。自定义提示词请配指令型 VLM（如 DeepSeek-OCR 去掉 `<|grounding|>`、Qwen-VL 等）。
- **MinerU 高级选项**：`language`（OCR 语言包，默认 `ch` 中英文，Host 白名单校验）与 `isOcr`（强制 OCR，默认关闭、按文本层自动判断）存在共用的 `layout.providerConfigs.mineru`，版面分析与正文解析复用同一套请求参数。
- **输出清洗**：grounding 输出形如 `<|ref|>label<|/ref|><|det|>[[box]]<|/det|>\n正文`，`<|ref|>` 内是版面**类别名**（`text` / `title`）而非正文，两段都整体丢弃，否则正文里会混入 `text` / `sub_title` 噪声行；`<|LOC_n|>` 同样剥离。
- **实现**：`src-tauri/src/features/import/pdf_parse/engines/`（`BodyParseEngine` trait + local / mineru / paddle / openai_vlm）；云端上传/轮询复用 `layout_remote` 的 `run_mineru_extract` / `run_paddle_ocr_job`。
- **Live 验证**（`#[ignore]`，需自备 key，密钥只走环境变量）：

  ```bash
  AGENTERO_VLM_LIVE_PDF=<pdf> AGENTERO_VLM_API_KEY=<key> [AGENTERO_VLM_MODEL=… AGENTERO_VLM_PROMPT=…] \
    cargo test -p agentero --lib -- live_openai_vlm --ignored --nocapture
  AGENTERO_MINERU_LIVE_PDF=<pdf> AGENTERO_MINERU_API_KEY=<key> \
    cargo test -p agentero --lib -- live_mineru --ignored --nocapture
  AGENTERO_PADDLE_LIVE_PDF=<pdf> AGENTERO_PADDLE_API_KEY=<key> [AGENTERO_PADDLE_MODEL=…] \
    cargo test -p agentero --lib -- live_paddle --ignored --nocapture
  ```

  VLM live 测试在进程内直接渲染（worker 子进程会重入 test 二进制），其余与线上路径一致。

## PDFium 随包分发

liteparse 在**运行时 `dlopen`** PDFium，而 `liteparse-pdfium-sys` 的 build script 只
把**构建机**的下载缓存绝对路径 bake 进二进制。用户机上那个路径不存在，加载失败会
直接 panic（子进程退出码 101），表现为“一直解析中 / 解析失败”。因此 PDFium 必须
随安装包一起分发。

| 环节 | 位置 |
|---|---|
| 暂存 | `scripts/prepare-pdfium.mjs` → `src-tauri/pdfium/{libpdfium.dylib \| pdfium.dll \| libpdfium.so}`（gitignore；`beforeDevCommand` / `beforeBuildCommand` 都会跑 `pnpm pdfium:stage`） |
| 来源优先级 | `PDFIUM_LIB_PATH` → 平台缓存 `<cache>/pdfium-rs/<tag>/<asset>/` → 从 pdfium-binaries release 下载 |
| macOS 打包 | `bundle.macOS.frameworks` → `Contents/Frameworks/libpdfium.dylib`（tauri-bundler 会把它登记为 codesign target，公证需要） |
| Windows / Linux 打包 | `bundle.resources: ["pdfium/*"]` → exe 同级 `pdfium/`，deb/AppImage 为 `/usr/lib/agentero/pdfium/` |
| 运行时定位 | `pdf_parse::bundled_pdfium_dir()` 从 `current_exe` 探测上述位置，作为 `PDFIUM_LIB_PATH` 传给解析子进程；外部已设置该环境变量时不覆盖 |

- iOS/Android 不打包 PDFium：正文解析走配对的桌面 Host，平台 config 已清空 `resources`。
- 子进程 stderr 落到 worker 临时目录的 `stderr.log`；拿不到 response 时其尾部会拼进错误消息。
- **升级 `liteparse` 依赖时**，必须同步 `scripts/prepare-pdfium.mjs` 里的
  `PDFIUM_RELEASE_TAG` 与 `.github/workflows/ci.yml` 的 Provision PDFium 步骤，
  保持与 `liteparse-pdfium-sys` build script 的 tag 一致。

## 本地 PDF

- 魔棒多选或拖到 `papers/` 组织夹 → **即时导入**：复制 PDF + catalog + NOTES shell 立刻完成（秒级），论文马上出现在树/论文库；元数据识别在后台进行（见下），识别完成后自动改名/补全。
- 窗口其它区域拖入不入库（防 WebView 导航）。
- 标识符去重与合并（#406）：导入前按对话框给出的 `id` / DOI / arXiv / PMID / ISBN 查 catalog；命中已有条目时不新建文件夹——原条目缺主 PDF `{id}.pdf` 时，本 PDF 直接成为主 PDF（常见于 PMID 入库后手动补全文）；否则放入 `{paper}/attachments/`（同名自动 `-2` 后缀），并回填 catalog 缺失的标识符列；前端返回 `status: "deduped"` 并 Toast 提示。

### PDF 元数据识别（recognize 链路）

文件名推导只是占位；本地 PDF 导入（拖入与魔棒直选）先以文件名 slug 建目录落库（`meta_source=local`），随后由 JobCenter 的 `RecognizeMetadata` job（并发 2，任务栏可见可取消）在后台跑识别链路补全 DOI/arXiv/标题/作者：

```
本地 liteparse probe（隔离 worker，前 5 页投影行 + 词级字号/坐标，~秒级）
  → Zotero recognizer 服务（POST 词级布局 JSON，非 PDF 文件本身，~50-250ms）
  → 命中 DOI → Translator /search 解析；失败回退 Crossref works/{doi} 直连
  → 命中 arXiv → export.arxiv.org Atom 直连
  → 仅命中 title/authors（无标识符）→ 直接采用识别结果（Zotero 同款兜底）
  → 任何一步失败静默降级为文件名元数据，绝不影响已完成的导入
```

识别结果由 `src-tauri/src/features/import/recognize_apply.rs` 落地：

- **命中标识符（`ok`）** → 目录经 wiki rename 事务改名为规范 id（`papers/<文件名slug>` → `papers/1706.03762`，含 `{id}.pdf` 改名、catalog path/id 重写、`[[...]]` 链接重写、失败回滚），`meta_source=recognize`，emit `paper:renamed`。
- **规范 id 已在库中** → 占位条目并入已有条目（PDF 成为对方主 PDF 或进 `attachments/`），删除占位目录/行，emit `paper:renamed`（`outcome=merged`）。
- **仅命中标题（`title`）** → 只 upsert catalog 元数据，不改目录名。
- **未命中（`no-match`/`error`）** → `meta_source=local-unresolved`，用户可在 Edit Metadata 手填 DOI/arXiv 并刷新（`paper_resolve_identifier`）。
- **用户抢先编辑**：识别完成时若 `meta_source` 已非 `local`（如 `manual`），识别结果整体放弃。

时序约定：`paper_commit` 以 `defer_parse_jobs: true` 跳过 commit 期的 ParseBody/ParseRefs spawn，由 RecognizeMetadata runner 在目录名尘埃落定后统一编排 PAPER.md / refs / layout（`LookupImportResult.recognize_pending=true` 时前端也跳过自己的 layout enqueue）。

- 实现：识别链路 `src-tauri/src/features/import/pdf_recognize.rs`（payload 组装 + HTTP client + `map_crossref_work`）；probe worker 变体在 `pdf_parse/mod.rs`（`--agentero-internal-pdf-recognize-worker`）；job 编排 `import/job_runners.rs::recognize_metadata_runner`。
- payload 结构复刻 Zotero document-worker `getRecognizerData`：`word = [xMin,yMin,xMax,yMax,fontSize,spaceAfter,baseline,rotation,0,bold,italic,0,fontIndex,text]`，行来自 liteparse 投影行（竖排 arXiv stamp 落到独立行，服务端可重建）。
- Host 侧 entries 仍支持 `title`/`doi`/`arxivId`/`extra` 覆盖（`meta_source=manual`，走原有同步路径不触发后台识别），供确认对话框/CLI 等调用方使用。
- 隐私：上传的是前 5 页文本布局 JSON（~200KB），不是 PDF 文件；服务为 Zotero 托管的未公开 API，仅作尽力而为识别，失败无感知。
- live 验证：`AGENTERO_RECOGNIZE_LIVE_PDF=<pdf> cargo test -p agentero --lib -- live_recognize --include-ignored --nocapture`。

## Catalog 相关 command（摘要）

`paper_list` / `paper_get` / `paper_rescan` / `paper_set_tags` / `paper_set_is_read` / `paper_export` / `paper_import`  
详见 [catalog.md](catalog.md)、[api.md](api.md)。

## 规划中的增强（非现状）

- 关键词/描述 → Agent 候选确认后入库（路线图 0.3）。
- 统一 `afterPaperImport` / `paper:imported` 事件（路线图 0.3）。

## 代码

`src-tauri/src/features/import/`  
前端 UI：[../frontend/paper-import.md](../frontend/paper-import.md)
