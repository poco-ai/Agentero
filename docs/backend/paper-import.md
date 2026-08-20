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
识别之前检测 `IdentifierKind::Skill`，通过 `SkillSource` 解析 GitHub 仓库、
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
- 新建壳会写论文全称 alias，并在元数据足够时写确定性短 alias；历史笔记由 [Doctor](doctor.md) 诊断和确认迁移。`created` 不属于入库壳或 Doctor 的职责。

## 可读正文

| 情况 | 行为 |
|---|---|
| 有 TeX | 优先 TeX；不强制 `PAPER.md` |
| 无 TeX 有 PDF | 下载后由隔离的 liteparse 子进程生成 `PAPER.md`；单次解析限时 120 秒 |
| 解析失败或超时 | 保留 PDF、`NOTES.md` 与 catalog；`paper_parse_body` 返回 `error`，对应 job 标记 `Failed` 并在任务面板展示原因，后续可重新执行 `paper parse` |
| 质量字段 | catalog `body_source` / `body_quality`（实现以 schema 为准） |

`PAPER.md` 是派生文件，可删可重建；`source/` 与 PDF 才是归档事实来源。

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

- 魔棒多选或拖到 `papers/` 组织夹 → 直接后台导入（无确认对话框）：复制 PDF + catalog + 通常生成 `PAPER.md`，识别链路在导入任务内自动补全元数据，识别有误由用户在 Edit Metadata 中修正。
- 窗口其它区域拖入不入库（防 WebView 导航）。

### PDF 元数据识别（recognize 链路）

文件名推导只是兜底；导入（拖入与魔棒直选）会在导入任务内跑一条识别链路补全 DOI/arXiv/标题/作者：

```
本地 liteparse probe（隔离 worker，前 5 页投影行 + 词级字号/坐标，~秒级）
  → Zotero recognizer 服务（POST 词级布局 JSON，非 PDF 文件本身，~50-250ms）
  → 命中 DOI → Translator /search 解析；失败回退 Crossref works/{doi} 直连
  → 命中 arXiv → export.arxiv.org Atom 直连
  → 仅命中 title/authors（无标识符）→ 直接采用识别结果（Zotero 同款兜底）
  → 任何一步失败静默降级为文件名元数据，绝不阻塞导入
```

- 实现：`src-tauri/src/features/import/pdf_recognize.rs`（payload 组装 + HTTP client + `map_crossref_work`）；probe worker 变体在 `pdf_parse/mod.rs`（`--agentero-internal-pdf-recognize-worker`）。
- payload 结构复刻 Zotero document-worker `getRecognizerData`：`word = [xMin,yMin,xMax,yMax,fontSize,spaceAfter,baseline,rotation,0,bold,italic,0,fontIndex,text]`，行来自 liteparse 投影行（竖排 arXiv stamp 落到独立行，服务端可重建）。
- 拖入与魔棒直选统一在 `import_one_local_pdf` 内联跑同一链路，`meta_source=recognize`，识别出的 arXiv/DOI slug 作为文件夹 id（与标识符导入命名一致）；Host 侧 entries 仍支持 `title`/`doi`/`arxivId`/`extra` 覆盖（`meta_source=manual`），供 CLI 等调用方使用。导入后可在 Edit Metadata 中手填 DOI/arXiv 并刷新（`paper_resolve_identifier`）。
- 隐私：上传的是前 5 页文本布局 JSON（~200KB），不是 PDF 文件；服务为 Zotero 托管的未公开 API，仅作尽力而为识别，失败无感知。
- live 验证：`AGENTERO_RECOGNIZE_LIVE_PDF=<pdf> cargo test -p agentero --lib -- live_recognize --include-ignored --nocapture`。

## Catalog 相关 command（摘要）

`paper_list` / `paper_get` / `paper_rescan` / `paper_set_tags` / `paper_set_is_read` / `paper_export` / `paper_import`  
详见 [catalog.md](catalog.md)、[api.md](api.md)。

## 规划中的增强（非现状）

- 关键词/描述 → Agent 候选确认后入库（路线图 0.3）。
- 可插拔 `PdfParser`（liteparse 默认 + 可选 MinerU BYOK）（路线图 0.4）。
- 统一 `afterPaperImport` / `paper:imported` 事件（路线图 0.3）。

## 代码

`src-tauri/src/features/import/`  
前端 UI：[../frontend/paper-import.md](../frontend/paper-import.md)
