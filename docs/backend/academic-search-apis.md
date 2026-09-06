# 学术搜索 API 一览

Agentero Host 端（`src-tauri/src/features/`）在论文识别、入库、引用补全、推荐等流程中，会调用若干外部学术服务。本文档列出所有当前在用的学术搜索/元数据 API，说明其用途、调用入口、请求形态、fallback 链路与并发控制。

> 范围限定在**学术元数据与论文发现**相关的外部 HTTP API。翻译 API（Google/Bing/DeepL/OpenAI 等）、版面分析 ONNX、本地 Agent/ACP、PostHog 遥测不在本文讨论范围内。

> 路径简写：`scholar_api/…` 与 `features/paper/import/` 的映射 / resolver / 批处理（`scholar_api::identifiers`、`api_mapper.rs`、`title_search.rs`、`batch.rs`、`assets.rs`、`sources/`）已随 crate 拆分迁到 `crates/agentero-core/src/features/paper/…`；`import/recognize/`（标题解析链、PDF 识别）与 `import/commands.rs` 仍在 `src-tauri`。其余 `features/…` 均指 `src-tauri/src/features/…`。

## 1. API 总览

| 服务 | 主要端点 | 用途 | 核心调用模块 |
|---|---|---|---|
| **Semantic Scholar Graph API** | `GET /graph/v1/paper/search` | 标题/关键词搜索 | `features/import/title_search.rs` |
| **Semantic Scholar Graph API** | `GET /graph/v1/paper/{id}/references` | 在线参考文献补全 | `features/refs/online.rs` |
| **Semantic Scholar Graph API** | `GET /graph/v1/paper/ARXIV:{id}` / `DOI:{doi}` | venue 回填（`publicationVenue.name`） | `features/paper/scholar_api/sources/semantic_scholar.rs`（`fetch_venue_by_*`），调用方 `features/paper/import/commands.rs` |
| **Semantic Scholar Graph API** | `GET /graph/v1/paper/{id}/citations` | "谁引用了我" 候选发现 | `features/refs/citing.rs` |
| **arXiv Atom API** | `GET https://export.arxiv.org/api/query` | 按 ID 取元数据 / 按标题搜索 | `features/import/mod.rs`, `features/import/title_search.rs` |
| **arXiv 二进制端点** | `https://arxiv.org/pdf/{id}` / `https://arxiv.org/e-print/{id}` / `https://arxiv.org/src/{id}` | PDF / TeX 源码下载 | `features/import/assets.rs` |
| **Crossref REST API** | `GET https://api.crossref.org/works/{doi}` | DOI → 元数据 / 参考文献 | `features/paper/import/recognize/pdf_recognize.rs`, `features/paper/analyze/refs/online.rs`, `features/paper/catalog/commands.rs` |
| **OpenAlex REST API** | `GET https://api.openalex.org/works` | 标题搜索兜底（含 `cited_by_count`） | `features/paper/import/recognize/chain_resolve.rs` |
| **Unpaywall** | `GET https://api.unpaywall.org/v2/{doi}` | DOI → 开放获取 PDF | `features/import/assets.rs` |
| **PubMed / NCBI E-utilities** | `GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` / `efetch.fcgi` | 标题/PMID → 医学/生命科学元数据 | `features/paper/scholar_api/sources/pubmed.rs` |
| **bioRxiv** | `GET https://api.biorxiv.org/details/biorxiv/{doi}` | DOI → 生命科学预印本元数据 | `features/paper/scholar_api/sources/biorxiv.rs` |
| **medRxiv** | `GET https://api.biorxiv.org/details/medrxiv/{doi}` | DOI → 医学预印本元数据 | `features/paper/scholar_api/sources/biorxiv.rs` |
| **Zotero Recognizer** | `POST https://services.zotero.org/recognizer/recognize` | PDF 首页文字几何识别 | `features/paper/import/recognize/pdf_recognize.rs` |
| **Translator Runtime** | `POST {base}/web`, `POST {base}/search`, `POST {base}/import` | 通用 URL/标识符/题录解析 | `features/import/mod.rs` |
| **Cool Papers (papers.cool)** | `GET https://papers.cool/{branch}/search?query=...`, `GET https://papers.cool/{branch}/kimi?paper={id}` | Kimi 论文解析 / 广场导入 | `features/coolpapers/` |
| **arXiv RSS** | `GET https://rss.arxiv.org/rss/{category}` | 推荐与订阅流 | `features/recommend/mod.rs`, `features/feeds/` |

## 2. 调用链路详解

### 2.1 论文识别与魔棒入库

入口：`features/import/commands.rs::paper_resolve_identifier`、`features/import/mod.rs::import_by_identifier_with_progress`。

当前主路径按以下顺序尝试：

1. **标题/关键词搜索**（`features/import/title_search.rs::search_papers`）
   - Semantic Scholar `GET /graph/v1/paper/search?query=...&fields=title,authors,year,venue,publicationVenue,journal,externalIds,citationCount,url` 与 arXiv Atom `GET export.arxiv.org/api/query?search_query=ti:"..."` **并行**发起。S2 在 5s 预算（`S2_SEARCH_BUDGET`）内返回非空则优先（venue 取 `publicationVenue.name`（跳过 `type=repository`），其次 `journal.name`，再次 `venue`），否则取已在途的 arXiv 结果；最坏耗时 ≈ max(预算, 单请求 20s 超时)。
   - 仅保留带 DOI 或 arXiv id 的候选；返回结果会按精确标题匹配重新排序。
   - `resolve_search_queries` 接收前端 `task_id`：关闭搜索卡片取消任务后，剩余查询直接跳过。
2. **Translator Runtime**（`features/import/mod.rs::resolve_metadata`）
   - 若用户输入被识别为 arXiv id / DOI / URL，会构造 `{base}/web` 或 `{base}/search` 请求。
   - arXiv 的各类输入（`2508.05004`、`arXiv:2508.05004v2`、`https://arxiv.org/pdf/...`、`https://arxiv.org/html/...`）都会被规范化为 `https://arxiv.org/abs/{id}` 再走 `/web`。
   - Translator 失败且输入是 arXiv id 时，本地 fallback 到 `fetch_arxiv_metadata`。
3. **Crossref DOI fallback**（`features/paper/scholar_api/identifiers/fallback.rs::fetch_crossref_metadata`）
   - 当 Translator 无法解析一个 DOI 时，`fetch_direct_fallback` 直接请求 `api.crossref.org/works/{doi}`。
4. **arXiv Atom 直接 fallback**（`features/paper/scholar_api/identifiers/fallback.rs::fetch_arxiv_metadata`）
   - 请求 `export.arxiv.org/api/query?id_list={id}`，解析 `<arxiv:journal_ref>` 作为 publication/venue。

> **被引数（`citation_count`）**：Crossref 解析 `is-referenced-by-count`、OpenAlex 解析 `cited_by_count`、Semantic Scholar 解析 `citationCount`，三者 `capabilities()` 均声明 `PROVIDE_CITATION_COUNT`；Crossref / OpenAlex 的 title search 还必须把该字段列进 `select` 白名单，否则 API 根本不返回它。`api_paper_to_meta` 把值带进 `PaperRecord`，`merge_api_papers` 合并两个源时取较大值（各自索引的引用文献子集不同）。arXiv Atom 与 Translator 不产出被引数。**注意**：入库以 Translator 为主路径，`map_zotero_item_to_record` 不带被引数，因此常规导入写入的仍是 NULL；只有 Translator 失败后降级到 Crossref 直连的 DOI 导入才会落进真实值。完整缺口见 [catalog.md](catalog.md)。

### 2.2 PDF 元数据识别

入口：`features/paper/import/recognize/pdf_recognize.rs::recognize_and_resolve`。

流程：

1. 本地 liteparse 探测 PDF 前若干页文字几何。
2. 将文字几何按 Zotero Worker 形状提交到 `https://services.zotero.org/recognizer/recognize`，获取可能的 DOI / arXiv / title。
3. 若识别出 DOI → `import/mod.rs::resolve_metadata` → Translator → Crossref 直连 fallback。
4. 若识别出 arXiv → `fetch_arxiv_metadata`。
5. 仅有 title/authors 时 → 生成本地 PDF 占位元数据（`meta_from_recognize`）。

### 2.3 参考文献在线补全

入口：`features/refs/online.rs::fetch_references`。

- 优先 Semantic Scholar：`GET /graph/v1/paper/{id}/references?fields=title,authors,year,venue,externalIds,url&limit=1000`，`{id}` 为 `arXiv:...` 或 `DOI:...`。
- 失败或无结果且存在 DOI 时，fallback Crossref：`GET api.crossref.org/works/{doi}?mailto=agentero@users.noreply.github.com`，取 `message.reference[]`。

### 2.4 反向引用发现（"谁引用了我"）

入口：`features/refs/citing.rs`。

- 仅使用 Semantic Scholar：`GET /graph/v1/paper/{id}/citations?fields=...&offset={offset}&limit={limit}`。
- 因为 OpenAlex 的 arXiv 预印件引用边稀疏，所以未采用。
- 内部有 L0/L1/L2 三层过滤与 SPECTER2 相似度排序，分页上限受 S2 `offset + limit < 10000` 限制。

### 2.5 Venue / Publication 回填

入口：`features/import/commands.rs::paper_backfill_publication`。

用于 Library 的 publication 列批量补全。实测各源准确度：

| 源 | 适合 | 缺陷 |
|---|---|---|
| arXiv `<arxiv:journal_ref>` | 作者已回填的发表信息，最完整（含年/卷） | 大量已发表论文仍为空（如 Attention Is All You Need） |
| S2 `publicationVenue.name` | 会议 + 期刊的规范化全名 | 免费端点限流；`venue` 字段常为空或缩写 |
| Crossref `container-title` | 期刊（Nature 等）准确 | ACL/NAACL 等会议名会被截断（`Proceedings of the 2019 Conference of the North`） |
| OpenAlex / DBLP | — | OpenAlex 对 CS arXiv 常无 venue；DBLP 只有缩写（`NIPS` / `NAACL-HLT`） |

因此顺序是：

1. arXiv id → arXiv Atom `export.arxiv.org/api/query?id_list={id}`，取 `<arxiv:journal_ref>`；缺失则 `GET /graph/v1/paper/ARXIV:{id}?fields=venue,publicationVenue,journal`（`s2_venue_from_paper`）。丢弃 `arXiv` / `CoRR` 等仓储名。
2. DOI → 取 S2 `publicationVenue` 与 Crossref `container-title` 中更长的可用名（S2 赢截断的 ACL/NAACL；Crossref 赢完整 proceedings 标题）。跳过 `10.48550/arXiv.…`。
3. 仅 title → Semantic Scholar `search_papers(title, 1)`，同样走 `publicationVenue`。

UI 刷新（`paper_resolve_identifier`）对 DOI/arXiv/URL **先走标识符解析**，再用 S2 补全空缺或 Crossref 截断的 proceedings 标题；自由文本才走 title search。

### 2.6 arXiv / DOI Venue 回填

入口：`features/paper/scholar_api/sources/semantic_scholar.rs::SemanticScholarApi::fetch_venue_by_arxiv` / `fetch_venue_by_doi` / `fetch_venue_by_ids`（取值逻辑 `venue_from_paper`）。

请求 `GET /graph/v1/paper/{ARXIV:id\|DOI:doi}?fields=venue,publicationVenue,journal`。取值顺序：

1. `publicationVenue.name`（`type=repository` 跳过）
2. `journal.name`
3. 遗留 `venue` 字符串

用于：

- `paper_backfill_publication` 的 arXiv 分支：Atom 的 `<arxiv:journal_ref>`（`scholar_api/sources/arxiv.rs::parse_entries` → `ApiPaper.venue`）缺失时补 venue。
- 批量 publication 回填与 Edit Metadata 刷新（`enrich_publication_from_s2`）。
- title search 候选的 venue 字段。

### 2.7 推荐与订阅

入口：`features/recommend/mod.rs`。

- 按用户关注的 arXiv category 拉取 `https://rss.arxiv.org/rss/{category}`。
- 解析后基于本地 embedding 做相似度排序，产生推荐候选。

### 2.8 广场 Feed 解析

入口：`features/feeds/`。

- 订阅源同样以 `rss.arxiv.org` 为主。
- `features/feeds/parse.rs::extract_paper_url` 会把 `rss.arxiv.org` 链接规范化到 `arxiv.org/abs/{id}`，并支持 Nature DOI 链接提取。

### 2.9 Cool Papers (papers.cool)

入口：`features/coolpapers/mod.rs`。

- 解析论文 URL：`https://papers.cool/{arxiv|venue}/{id}`。
- 按标题搜索：`GET https://papers.cool/{branch}/search?query=...`。
- 获取 Kimi 解析：`GET https://papers.cool/{branch}/kimi?paper={id}`。
- 这是一个人工整理的学术站点，不是开放 API；解析结果写入 NOTES.md。

### 2.10 PDF / TeX 资产下载

入口：`features/import/assets.rs`。

- arXiv PDF 候选链：`https://arxiv.org/pdf/{id}` → `https://arxiv.org/pdf/{id}.pdf` → `https://export.arxiv.org/pdf/{id}`。
- arXiv TeX 源码：`https://arxiv.org/e-print/{id}`（`/src/` 为别名）。
- DOI 论文 PDF：先查 `api.unpaywall.org/v2/{doi}`，再查 Crossref `message.link` 中的 PDF 链接。

### 2.11 PubMed / bioRxiv / medRxiv 元数据兜底

入口：`features/paper/scholar_api/sources/pubmed.rs`、`features/paper/scholar_api/sources/biorxiv.rs`。

- **PubMed**：实现 `AcademicApi`，支持标题搜索和 PMID 查询。流程为 `esearch.fcgi`（JSON）拿 PMID 列表 → `efetch.fcgi`（XML）批量取详情；请求带 `email` 与 `tool` 参数以符合 NCBI 礼貌使用要求。解析字段包括 title、authors、year、venue、volume、issue、pages、DOI、PMID、abstract；PMC 存在时给出 PDF 候选。
- **bioRxiv / medRxiv**：共用 `biorxiv.rs`，实现 `AcademicApi`，仅支持 `FETCH_BY_DOI`（上游 API 无 title 搜索端点）。请求 `https://api.biorxiv.org/details/{server}/{doi}`，解析 title、authors、date、abstract，并构造 `.full.pdf` 直链。
- PMID 在 `scholar_api::identifiers::resolver` 中已有识别器，现在为其补充 PubMed `efetch` 直连 fallback（`scholar_api::identifiers::fallback::fetch_pubmed_metadata`）；Translator 失败时可直接从 NCBI 拉取。

## 3. 并发与限流

| 能力 | 并发控制 | 说明 |
|---|---|---|
| 标题/关键词搜索 | `SEARCH_CONCURRENCY = 2`（Semaphore） | S2 免费搜索端点限流严格，arXiv Atom 也有速率限制；单条查询并行占用至多 2 个 permit（S2 + arXiv） |
| 在线参考文献 | `ONLINE_REFERENCE_CONCURRENCY = 2` | 与 title search 独立 |
| 批量入库 | 默认 `concurrency = 5` | `LookupImportBatchArgs.concurrency` 可覆盖 |
| 反向引用发现 | `FETCH_CONCURRENCY = 8` | 实测 8 并发比串行快约 4.6 倍 |
| Cool Papers /kimi | `1` | 避免触发上游 LLM 配额 |
| 通用 HTTP | `crate::core::http::client` | 共享连接池，单个请求超时 20s，PDF/TeX 下载 180s |

所有调用均使用无 API key 的免费端点（Semantic Scholar、arXiv、Crossref、Unpaywall）。Cool Papers 无 auth。Translator Runtime 默认使用作者托管实例 `https://translator.philfan.cn`，用户可在设置中替换。

## 4. 配置与可替换项

| 配置项 | 位置 | 默认值 | 说明 |
|---|---|---|---|
| `translatorBaseUrl` | `features/system/settings/mod.rs` | `https://translator.philfan.cn` | 可替换为自托管 Translator Runtime |
| `LookupImportArgs.translator_base_url` | 单次请求参数 | 空则使用设置值 | CLI/批量导入可临时覆盖 |
| 后台 PDF 识别（RecognizeMetadata job） | `job_runners.rs` 直接读设置 `translator_base_url` | 空则用 `DEFAULT_TRANSLATOR_BASE_URL` | **不**经 IPC 入参传入（`ImportLocalPdfArgs` 无此字段） |

Translator Runtime 约定端点：

- `POST {base}/web`：解析 URL（arXiv abstract page、期刊 landing page 等）。
- `POST {base}/search`：按标识符或标题搜索。
- `POST {base}/import`：解析 BibTeX / RIS 等题录。

## 5. Fallback 行为速查

| 场景 | 第一选择 | Fallback | 最后兜底 |
|---|---|---|---|
| 用户输入 title/关键词 | S2 ∥ arXiv 并行竞速（5s 预算内 S2 优先） | 已在途的 arXiv 结果 | 无 |
| 用户输入 arXiv id | Translator `/web` (canonical abs URL) | arXiv Atom | 无 |
| 用户输入 DOI | Translator `/search` | Crossref `works/{doi}` | 无 |
| 用户输入 PMID | Translator `/search` | PubMed `efetch` | 无 |
| 用户输入 URL | Translator `/web` | - | 无 |
| PDF 识别出 DOI | Translator | Crossref | 本地 title fallback |
| PDF 识别出 arXiv | arXiv Atom | - | 本地 title fallback |
| 在线参考文献 | S2 references | Crossref `reference[]` | 本地 TeX/`.bbl` |
| 反向引用 | S2 citations | 无 | 无 |
| 补全 publication | arXiv journal_ref / S2 `publicationVenue` | S2 `DOI:{doi}` → Crossref `container-title` | S2 title search |
| 下载 PDF | arXiv 直连 | arXiv export / Unpaywall / Crossref link | 无 PDF |
| 下载 TeX | arXiv e-print | - | PDF only |

## 6. 相关文档

- [identifier-lookup.md](./identifier-lookup.md)
- [paper-import.md](./paper-import.md)
- [citation-parsing.md](./citation-parsing.md)
- [search.md](./search.md)
