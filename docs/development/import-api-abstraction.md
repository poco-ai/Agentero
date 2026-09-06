# Import 学术 API 抽象层设计稿

> 状态：**已落地**，保留为设计记录（§8 阶段 0–6 全部完成）  
> 目标：减少 `features/import/` 里各学术 HTTP 服务的重复代码，统一论文元数据、期刊指标、PDF URL 与题录批处理的抽象接口。  
> 落地后的实际位置：`crates/agentero-core/src/features/paper/scholar_api/`（crate 拆分后从 `src-tauri` 迁入，见 [crate-split-roadmap.md](crate-split-roadmap.md)）。剩余工作与已知缺口见 §11。

## 1. 问题（重构前状态）

当时 `features/import/` 里各服务各自维护一套逻辑：

- `title_search.rs`：Semantic Scholar / arXiv 标题搜索，有 `PaperSearchCandidate` —— **保留**至今，作为魔棒搜索对话框的 IPC 出参（有 `From<ApiPaper>` 实现）
- `chain_resolve.rs`：标题解析链，有 `ResolvedCandidate` —— **已删除**，连同该文件里重复的 `candidate_to_meta` / `merge_candidates`；现在直接消费 `ApiPaper`
- `map.rs`：最终存储格式，有 `PaperMeta` —— **已合并**进 `catalog/papers.rs::PaperRecord`（`PaperMeta` 曾是 `PaperRecord` 的严格字段子集，靠 `paper_record_from_meta` 逐字段手抄桥接，新字段要改四处，`citation_count` 就是在这个接缝上被静默丢掉的）
- `mod.rs`：Translator Runtime 特化请求与错误处理
- `assets.rs`：Unpaywall 独立调用 —— 已收进 `scholar_api/sources/unpaywall.rs`
- `pdf_recognize.rs`：Zotero Recognizer 独立调用 —— 按 §5.5 的结论保持独立（输出 `RecognizeHit`，再转 `ApiQuery`）

三套候选结构互相转换、各自拼 reqwest client、各自处理 timeout / proxy / User-Agent / 限流。新增一个学术数据源要改多处。

## 2. 目标与非目标

**目标：**

- 统一输入查询类型（`ApiQuery`）
- 统一论文候选输出（`ApiPaper`）
- 统一错误类型（`ApiError`）
- 按能力拆 trait，避免一个服务硬塞一堆空方法
- 共享 HTTP 工具，集中处理 timeout / proxy / UA / 限流 / 错误包装
- 把现有 `PaperMeta` 作为 storage 格式保留，只统一「生产 `PaperMeta` 的路径」  
  → **实际结果**：抽象层照此落地，但 storage 格式随后统一到了 `PaperRecord`；`PaperMeta` 与其手写桥接 `paper_record_from_meta` 一并删除，生产路径改为直接构造 `PaperRecord`（`local_pdf` + `at_path`）

**非目标：**

- 不替换 `PaperMeta`（前端 `PaperMetadata` 已依赖其 JSON 形状）  
  → **已被后续重构推翻**：`PaperMeta` 合并进 `PaperRecord` 后，"前端依赖的 JSON 形状"这一约束由 `PaperRecord` 承担，前端 `PaperMetadata` 改为从 specta 生成的 `PaperRecord_Serialize` 派生，形状契约由生成物保证而非手抄
- 不改动前端导入流程的 IPC 契约
- 不删除现有 fallback 行为（Translator → arXiv / Crossref）
- 不一次性重写所有服务；先落地抽象层，再逐个迁移

## 3. 能力矩阵

| 服务 | 论文元数据 | 标识符 | 期刊/会议分级 | 量化指标 | PDF/URL | 文献批量 |
|---|---|---|---|---|---|---|
| | 标题/作者/年份/期刊/卷期页/摘要/出版商/语言 | DOI / arXiv / ISBN / PMID / URL | SCI/SSCI 分区 / 中科院 / CCF / CSSCI / 北大核心 / EI / 各校列表 | IF / IF5 / JCI / h-index / i10 / 2yr mean / citation count | PDF 直链 / 落地页 / HTML | BibTeX/RIS 导入导出 |
| **Translator** | ✅（Zotero item 全字段） | ✅ DOI / arXiv / ISBN / PMID / URL | ❌ | ❌ | ⚠️（item.url / attachments 可能带 PDF） | ✅ `/import` / `/export` |
| **Semantic Scholar** | ✅（缺 volume/issue/pages/publisher/abstract） | ✅ DOI / arXiv / CorpusId | ❌ | ⚠️（仅论文级 citationCount，无期刊 IF/分区） | ⚠️（仅 S2 页面 URL，非 PDF） | ❌ |
| **Crossref** | ✅（abstract 常为 JATS XML） | ✅ DOI / ISSN / ISBN | ❌ | ❌ | ❌ | ❌ |
| **OpenAlex** | ✅（via source 补 venue） | ✅ DOI / ISSN / OpenAlex ID | ❌ | ⚠️（source summary_stats：2yr mean / h-index / i10；work cited_by_count） | ⚠️（primary_location.pdf_url 不稳定） | ❌ |
| **arXiv** | ✅（预印本，无 volume/issue） | ✅ arXiv / 偶有 DOI | ❌ | ❌ | ✅（canonical pdf/html/abs URL） | ❌ |
| **Unpaywall** | ❌ | ✅ DOI | ❌ | ❌ | ✅（OA PDF URL） | ❌ |
| **Zotero Recognizer** | ⚠️（从 PDF 第一页识别，字段不全） | ✅ DOI / arXiv / ISBN | ❌ | ❌ | ❌ | ❌ |
| **EasyScholar** | ❌ | ❌ | ✅ SCI / SSCI / 中科院 / CCF / CSSCI / 北大核心 / EI / 各校自定 | ✅ IF / IF5 / JCI | ❌ | ❌ |

按抽象 trait 细分：

### 3.1 `AcademicApi` — 论文元数据

| 服务 | Title 搜索 | DOI 反查 | arXiv 反查 | URL 反查 | ISBN/PMID | 输出完整度 |
|---|---|---|---|---|---|---|
| **Translator** | ✅ `/search` | ✅ `/search` | ✅ `/web` | ✅ `/web` | ✅ | 最高（Zotero item） |
| **Semantic Scholar** | ✅ `/paper/search` | ✅ `/paper/DOI:{doi}` | ✅ `/paper/ARXIV:{id}` | ❌ | ❌ | 中高（缺卷期页/摘要） |
| **Crossref** | ✅ `/works?query.title` | ✅ `/works/{doi}` | ❌ | ❌ | ✅ ISBN | 中（有 ISSN/卷期页） |
| **OpenAlex** | ✅ `/works?search` | ✅ `/works/{doi}` | ❌ | ❌ | ❌ | 中（via source 补 venue） |
| **arXiv** | ✅ Atom title search | ❌ | ✅ Atom by ID | ❌ | ❌ | 中（预印本） |
| **Zotero Recognizer** | ❌ | ⚠️（从 PDF 识别 DOI） | ⚠️（从 PDF 识别 arXiv） | ❌ | ⚠️（识别 ISBN） | 低（仅作线索） |

### 3.2 `VenueMetricsSource` — 期刊/会议分级与指标

| 服务 | IF | 5-year IF | JCI | 中科院分区 | JCR Q | CCF | CSSCI | 北大核心 | EI | h-index / i10 / 2yr mean |
|---|---|---|---|---|---|---|---|---|---|---|
| **EasyScholar** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **OpenAlex** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **其他** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### 3.3 辅助/特殊能力

| 服务 | OA PDF URL | 文献导入 | 文献导出 | 备注 |
|---|---|---|---|---|
| **Unpaywall** | ✅ | ❌ | ❌ | 只接受 DOI |
| **Translator** | ⚠️ | ✅ `/import` | ✅ `/export` | 实际是 Zotero translation-server |
| **arXiv** | ✅ canonical | ❌ | ❌ | URL 自己生成即可 |
| **OpenAlex** | ⚠️ | ❌ | ❌ | `primary_location.pdf_url` 有时有 |
| **Crossref** | ❌ | ❌ | ❌ |  |
| **Semantic Scholar** | ❌ | ❌ | ❌ |  |
| **Zotero Recognizer** | ❌ | ❌ | ❌ | 只识别，不检索 |
| **EasyScholar** | ❌ | ❌ | ❌ |  |

## 4. 数据结构

### 4.1 统一输入：`ApiQuery`

```rust
pub enum ApiQuery {
    Title(String),
    Doi(String),
    ArxivId(String),
    Url(String),
    Isbn(String),
    Pmid(String),
}

impl ApiQuery {
    /// 人类可读的查询类型标签，用于日志/错误。
    pub fn kind(&self) -> &'static str { ... }
}
```

`scholar_api::identifiers::ResolvedIdentifier` 可直接映射为 `ApiQuery`。

### 4.2 统一标识符包：`PaperIdentifiers`

```rust
pub struct PaperIdentifiers {
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub isbn: Option<String>,
    pub pmid: Option<String>,
}
```

### 4.3 URL 包：`PaperUrls`

```rust
pub struct PaperUrls {
    pub pdf: Option<String>,
    pub html: Option<String>,
    pub landing: Option<String>,
}
```

### 4.4 统一论文候选：`ApiPaper`

```rust
pub struct ApiPaper {
    pub identifiers: PaperIdentifiers,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub date: Option<String>,
    pub venue: Option<String>,      // journal / conference / proceedings 名称
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub pages: Option<String>,
    pub publisher: Option<String>,
    pub abstract_text: Option<String>,
    pub urls: PaperUrls,
    pub citation_count: Option<i64>,    // 论文级被引次数（S2/OpenAlex 提供）
    pub language: Option<String>,
    pub source: &'static str,           // 产生该候选的服务名，如 "s2" / "crossref"
}
```

### 4.5 统一错误：`ApiError`

```rust
pub enum ApiError {
    Network(String),
    Parse(String),
    NotFound,
    RateLimited,
    UnsupportedQuery(ApiQuery),
    Cancelled,
    Other(String),
}

impl From<ApiError> for AppError { ... }
```

### 4.6 能力标志：`ApiCapability`

```rust
bitflags! {
    pub struct ApiCapability: u32 {
        const SEARCH_BY_TITLE  = 1 << 0;
        const FETCH_BY_DOI     = 1 << 1;
        const FETCH_BY_ARXIV   = 1 << 2;
        const FETCH_BY_ISBN    = 1 << 3;
        const FETCH_BY_PMID    = 1 << 4;
        const FETCH_BY_URL     = 1 << 5;
        const PROVIDE_ABSTRACT = 1 << 6;
        const PROVIDE_CITATION_COUNT = 1 << 7;
        const PROVIDE_VENUE    = 1 << 8;
    }
}
```

### 4.7 期刊指标与分级：`VenueMetrics`

```rust
pub struct VenueIdentifiers {
    pub issn: Vec<String>,
    pub issn_l: Option<String>,
}

pub struct VenueRank {
    pub system: String,             // "sci" / "ssci" / "ccf" / "cssci" / "pku" / "eii" / "ajg" / "fms" ...
    pub value: String,              // "Q1" / "A" / "T1" / "经济学4区" / "B" ...
    pub category: Option<String>,   // 可选：大类/学科
}

pub struct VenueMetrics {
    pub venue_name: String,
    pub identifiers: VenueIdentifiers,
    pub impact_factor: Option<f64>,          // JCR IF（主要来自 EasyScholar）
    pub impact_factor_5yr: Option<f64>,
    pub jci: Option<f64>,                    // Journal Citation Indicator
    pub h_index: Option<i64>,                // OpenAlex / S2AG 风格
    pub i10_index: Option<i64>,
    pub two_year_mean_citedness: Option<f64>, // OpenAlex 类 IF 指标
    pub total_works: Option<i64>,
    pub total_citations: Option<i64>,
    pub ranks: Vec<VenueRank>,
    pub source: &'static str,
    pub source_detail: Option<String>,       // 例如 "JCR 2024" / "OpenAlex live"
}
```

## 5. Trait 设计

按能力拆成 4 个 trait，不硬凑一个万能接口。

### 5.1 主 trait：论文元数据

```rust
#[async_trait]
pub trait AcademicApi: Send + Sync {
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> ApiCapability;

    /// 该服务是否支持处理这个查询。
    fn supports(&self, query: &ApiQuery) -> bool {
        match query {
            ApiQuery::Title(_) => self.capabilities().contains(ApiCapability::SEARCH_BY_TITLE),
            ApiQuery::Doi(_)   => self.capabilities().contains(ApiCapability::FETCH_BY_DOI),
            ApiQuery::ArxivId(_) => self.capabilities().contains(ApiCapability::FETCH_BY_ARXIV),
            ApiQuery::Url(_)   => self.capabilities().contains(ApiCapability::FETCH_BY_URL),
            ApiQuery::Isbn(_)  => self.capabilities().contains(ApiCapability::FETCH_BY_ISBN),
            ApiQuery::Pmid(_)  => self.capabilities().contains(ApiCapability::FETCH_BY_PMID),
        }
    }

    /// 返回 Vec 统一单结果与多结果：
    /// - DOI / arXiv 反查返回 vec![paper] 或 vec![]
    /// - 标题搜索返回 0..N 候选
    async fn fetch(&self, query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError>;
}
```

### 5.2 期刊指标

```rust
#[async_trait]
pub trait VenueMetricsSource: Send + Sync {
    fn name(&self) -> &'static str;

    /// 是否支持查这个 venue。有的服务只接受 publicationName，有的接受 ISSN。
    fn supports(&self, venue: &str, identifiers: &VenueIdentifiers) -> bool;

    async fn fetch_metrics(
        &self,
        venue: &str,
        identifiers: &VenueIdentifiers,
    ) -> Result<VenueMetrics, ApiError>;
}
```

### 5.3 OA PDF URL

```rust
#[async_trait]
pub trait PdfUrlSource: Send + Sync {
    fn name(&self) -> &'static str;
    async fn pdf_url(&self, query: &ApiQuery) -> Result<Option<String>, ApiError>;
}
```

### 5.4 题录批量导入导出

```rust
#[async_trait]
pub trait BibliographySource: Send + Sync {
    fn name(&self) -> &'static str;
    async fn import_items(&self, content: &str) -> Result<Vec<Value>, ApiError>;
    async fn export_items(&self, items: &[Value], format: &str) -> Result<String, ApiError>;
}
```

### 5.5 各服务实现关系

| 服务 | 实现 trait |
|---|---|
| **Translator** | `AcademicApi` + `BibliographySource` |
| **Semantic Scholar** | `AcademicApi` |
| **Crossref** | `AcademicApi` |
| **OpenAlex** | `AcademicApi` + `VenueMetricsSource`（开放指标） |
| **arXiv** | `AcademicApi` |
| **Unpaywall** | `PdfUrlSource` |
| **Zotero Recognizer** | 不直接实现 `AcademicApi`；它输出的是 `RecognizeHit`，再转成 `ApiQuery` 交给 `AcademicApi` |
| **EasyScholar** | `VenueMetricsSource` |

## 6. 共享 HTTP 工具

所有服务共享一个内部 `ApiHttpClient` helper，集中处理：

- timeout / User-Agent / proxy（复用 `crate::core::http`）
- JSON / Atom XML / text 获取
- 请求并发限制（替代 `title_search.rs` 里独立的 Semaphore）
- 状态码和 body 错误包装

每个服务实现里只剩「拼 URL + 解析响应到 `ApiPaper` / `VenueMetrics`」。

## 7. 模块布局

按 `scholar_api` 模块组织，与 `features/paper/import/` 解耦，方便 `features/refs/`、`features/recommend/`、`features/coolpapers/` 等复用。

```text
crates/agentero-core/src/features/paper/
  scholar_api/
    mod.rs           # 公开类型：ApiQuery, ApiPaper, ApiError, ApiCapability, VenueMetrics ...
    traits.rs        # AcademicApi, VenueMetricsSource, PdfUrlSource, BibliographySource
    client.rs        # 共享 ApiHttpClient
    scoring.rs       # 与 storage 无关的候选排序/合并：normalize_title, title_similarity, is_same_paper
    sources/
      translator.rs
      semantic_scholar.rs
      crossref.rs
      openalex.rs
      arxiv.rs
      unpaywall.rs
      easy_scholar.rs
```

依赖方向：

- `scholar_api` 不依赖任何 `features/*` 业务模块，只依赖基础层（error、http、time 等）。
- `features/paper/import/` 依赖 `scholar_api`，把 `ApiPaper` 映射为 `PaperRecord`。
- `features/refs/online.rs`、`features/coolpapers/` 等也直接依赖 `scholar_api`。

因此 `api_paper_to_meta()` 不放在 `scholar_api/` 里，而是落在 `features/paper/import/api_mapper.rs`（当初"或新增 `api_mapper.rs`"的选项胜出），由 import 域自己维护 storage 映射；`merge_api_papers` 同文件。通用的候选排序/合并工具不依赖 `PaperRecord`，放在 `scholar_api/scoring.rs`。

## 8. 迁移路径

分阶段进行，避免一次性大爆炸。**阶段 0–6 全部已落地**（crate 拆分后代码位于 `crates/agentero-core/src/features/paper/`）：

1. **阶段 0：新建抽象层** ✅
   - 创建 `scholar_api/mod.rs` 与 `scholar_api/traits.rs`
   - 实现 `ApiQuery`、`ApiPaper`、`ApiError`、`ApiCapability`、`VenueMetrics`
   - 实现共享 `ApiHttpClient`
   - 在 import 域内实现单一映射函数 → 落地为 `features/paper/import/api_mapper.rs::api_paper_to_meta()`

2. **阶段 1：先迁 arXiv 和 Crossref** ✅
   - 这两个服务最独立、已有明确的 fallback 位置
   - 在 `scholar_api/sources/arxiv.rs` / `crossref.rs` 实现 `AcademicApi`
   - 保持 `features/paper/scholar_api/identifiers/resolver.rs` 原有调用点不变，内部改调新的 source

3. **阶段 2：Semantic Scholar** ✅
   - 在 `scholar_api/sources/semantic_scholar.rs` 实现 `AcademicApi`
   - 重写 `title_search.rs` 里的 S2 搜索与 venue 取值（现为 `search_match` / `fetch` / `fetch_venue_by_*` + `venue_from_paper`）
   - 让 `title_search::search_papers` 跑在新抽象上

4. **阶段 3：OpenAlex** ✅
   - 在 `scholar_api/sources/openalex.rs` 实现 `AcademicApi`
   - 重写 `recognize/chain_resolve.rs` 里的 OpenAlex 标题搜索
   - `VenueMetricsSource` 未落在 OpenAlex 上（见 §10 第 2 条）

5. **阶段 4：EasyScholar** ✅
   - `scholar_api/sources/easy_scholar.rs` 实现 `VenueMetricsSource`
   - `settings/commands.rs` 的 `easy_scholar_probe` / `easy_scholar_get_rank` 改调该 source，IPC 契约不变

6. **阶段 5：Translator / Unpaywall / Zotero Recognizer** ✅
   - `scholar_api/sources/translator.rs` 实现 `AcademicApi + BibliographySource`
   - `scholar_api/sources/unpaywall.rs` 实现 `PdfUrlSource`
   - Zotero Recognizer 保持独立，输出 `RecognizeHit` 后转成标识符走 `resolve_metadata`

7. **阶段 6：清理旧结构** ✅
   - 删除 `ResolvedCandidate`；**保留** `PaperSearchCandidate`（见 §10 第 4 条的结论）
   - 删除 `chain_resolve.rs` 里重复的 `candidate_to_meta` / `merge_candidates`，改调 `api_mapper::api_paper_to_meta` / `merge_api_papers`
   - 统一走 `features/paper/import/api_mapper` 的映射函数
   - 后续追加：删除只被自身测试调用的 `meta_from_search_candidate`，等价断言移到 `api_paper_to_meta` 的测试上

## 9. 与现有文档的关系

- [../backend/academic-search-apis.md](../backend/academic-search-apis.md)：Crossref / arXiv Atom / S2 venue 的入口已改指 `scholar_api/sources/*`；crate 拆分造成的路径歧义由该文档开头的一条简写说明统一交代（`scholar_api/…` 与 import 的解析 / 映射逻辑在 `crates/agentero-core`，其余 `features/…` 仍在 `src-tauri`）
- [../backend/identifier-lookup.md](../backend/identifier-lookup.md)：§3.2 记录 resolver 表（含 `fetch_fallback` 直连回退）、§3.4 记录 S2 ∥ arXiv 竞速、§5 记录 → `PaperRecord` 的字段映射
- 本设计稿保留在 `docs/development/`（目录约定：已实现功能说明在 `docs/backend/`，本文件只作为设计记录 + 剩余工作清单）

## 10. 待决策 / 结论

1. **EasyScholar 返回字段过滤** — 未决策，现状是**全部返回**：`parse_response` 把 `officialRank.all` 的每一项都收进 `VenueMetrics.ranks`，同时 `fetch_raw` 仍对外暴露，让前端继续消费原始 `officialRank.all` JSON 形状。
2. **OpenAlex 指标是否接入** — 未决策，现状是**未接入**：OpenAlex 只实现 `AcademicApi`，`VenueMetricsSource` 的唯一实现是 `EasyScholarApi`；EasyScholar 未配置 key 时期刊标签功能整体不启用。
3. **ISSN 是否用于 EasyScholar 查询** — 未决策，现状是**只用 `publicationName`**（`fetch_raw` 的 URL 只带 `secretKey` + `publicationName`，`VenueIdentifiers` 在 `fetch_metrics` 里未参与请求）。
4. **是否保留 `PaperSearchCandidate` 作为前端 IPC 类型** — **结论：保留**。它是魔棒搜索对话框的 IPC 出参（`PaperSearchGroup { query, candidates }`），后端内部一律用 `ApiPaper`，唯一的转换点是 `impl From<ApiPaper> for PaperSearchCandidate`。保留的理由：对话框需要的是**展示形状**而非候选全量——camelCase、已经算好的 `identifier`（arXiv id 优先，其次 DOI，用户确认后原样回灌标识符管线）、以及 `source: "s2" | "arxiv"` 这样的窄类型；`ApiPaper` 是 snake_case 的内部聚合体，直接当契约会把内部字段变更外泄成 IPC breaking change。被删除的是**重复**的候选结构（`ResolvedCandidate` 及其 `candidate_to_meta` / `merge_candidates`），不是这个出参。

## 11. 剩余工作（论文元数据重构后的已知缺口）

抽象层本身已收敛；下列是重构过程中发现、**尚未修**的问题，按影响排序。

### 11.1 `citation_count` 到不了用户眼前

管道已通、数据源已能解析，但**常规入库路径不会把非 NULL 值写进 catalog**：

- 入库以 Translator 为主路径，`map_zotero_item` 不产出被引数；Crossref 只在 Translator 失败时作为直连降级出现（这条降级路径确实会写进真实值）。
- Semantic Scholar 的结果只出现在 `paper_resolve_identifier`，而该命令**只返回给前端、不落库**。

要让用户真正看到被引数，还差下列环节之一：

| 缺口 | 位置 | 说明 |
|---|---|---|
| `PdfIdentProbe` 无 `citation_count` 字段 | `src-tauri/src/features/paper/import/recognize/pdf_recognize.rs` | 本地 PDF 识别路径在这个边界被截断：`from_meta` 逐字段拷贝时丢掉被引数，`apply.rs::apply_probe_fields` 随之也不会写 |
| 魔棒标题搜索确认后丢弃候选被引数 | `src/lib/paper/import-actions.ts` | 只把候选降级成 `identifier` 字符串回传 `lookup_import_batch`，候选自带的 `citationCount` 直接扔掉 |
| `PaperMetaPatch` 不含 `citation_count` | `catalog/papers.rs` | 因此「按标识符刷新元数据」（Edit Metadata 的刷新按钮）即使解析到了被引数也无法回填 |

现状说明见 [../backend/catalog.md](../backend/catalog.md) 与 [../backend/academic-search-apis.md](../backend/academic-search-apis.md) §2.1。

### 11.2 `status` / `body_source` / `body_quality` 仍是 `String`

前端靠 `Omit` + union 窄化维持类型安全（`src/lib/paper/types.ts`）。词表与生产者的实际差距：

- `status` 的生产词表实际只有 `"completed"`（`"unread"` 已消除）；前端 union 里的 `pending` / `importing` / `failed` 目前**无人写入**。旧 catalog 里遗留的 `status = 'unread'` 行**没有 heal**（对比 `"article"` 在读侧做了归一化），因为前端目前不 switch `status`，无实际后果。
- `body_source` 的生产者是 `latex` / `pdf` / `ocr` / `mineru` / `paddle` / `vlm`；union 里的 `"html"` **没有生产者**。

改 enum 的代价：

| 列 | 代价 |
|---|---|
| `status` | 13 处 `status: "completed"` 字面量（其中 3 处在测试里）+ CLI `--status` 过滤（`cli/src/commands/paper.rs`） |
| `body_source` / `body_quality` | 各 13 处 `None`（其中 3 处在测试里）+ 约 7 处真实生产者 + 4 个中间 `String` 载体，其中 `PdfParseWorkerResponse::Ok { body_source: String, .. }`（`analyze/parse/mod.rs`）跨 PDF parse worker 的 serde 契约 |

三列都是 TEXT，照 `PaperKind` 的先例（enum + `From<&str>` + `FromSql` + 未知值兜底）**不需要 schema migration**。

### 11.3 `PaperTag` 的生成契约与真实 wire 形态不符

`impl Serialize for PaperTag`（`catalog/papers.rs`）在**无颜色时输出裸字符串**，而 specta 生成的类型是 `{ name, color }` 对象且 `color: string | null`。前端因此必须保持 `PaperTagInput[]` + `coercePaperTags`。仓库已有现成范式可修（`crates/agentero-core/src/json.rs` 的 untagged specta-only enum + `#[specta(type = ...)]`），但会改生成契约、牵连所有消费者。

### 11.4 `PdfIdentProbe` 是又一份手工维护的扁平字段表

`recognize/pdf_recognize.rs` 的 `PdfIdentProbe` 约 12 个字段复制自 `PaperRecord`，外加 4 个控制字段（`file_path` / `status` / `error` / `source`），与已删除的 `PaperMeta` 同类问题：`PaperRecord` 加字段时这里不会自动跟上（§11.1 的第一条就是后果）。它只 derive `Serialize`、camelCase，是 job 事件的出参，所以收敛成内嵌 record 会改事件 payload 形状。

### 11.5 前端仍有手写副本未收敛到生成类型

| 位置 | 手写类型 |
|---|---|
| `src/lib/paper/lookup.ts` | `PaperSearchCandidate` / `LookupAddResult` |
| `src/lib/paper/api.ts` | `PaperMetaPatch` / `PaperExportResult` |
| `src/lib/paper/load-meta.ts` | `PaperOpenBundle` |

其中 `lookup.ts` 的 `citationCount?: number` 与生成的 `number | null` 不一致 —— 正是 `paper-search-dialog.tsx` 里 `!== undefined` 判断失效的根因（wire 送 `null`，已就地修为 `!= null`，但类型副本本身还没收敛）。

### 11.6 其它

- **远端重导入可能覆盖孤儿 catalog 行**：`src-tauri/src/integration/remote/import_bridge.rs::unique_remote_paper_path` 只查远端 `fs.exists`、不查 work-copy catalog（本地版 `allocate_paper_path` 是盘 + catalog 双查）。孤儿行（有行、无远端目录）可能被同路径重导入从零覆盖——影响所有字段，非 `citation_count` 专属；`prune_missing` 负责清理这类孤儿。既有问题，非本轮引入。
- **`is_remote_vault` 无生产调用方**：`src-tauri/src/integration/connector/state.rs` 的该方法自诞生起只有自身测试覆盖。
