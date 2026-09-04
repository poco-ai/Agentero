# Import 学术 API 抽象层设计稿

> 状态：设计稿，待实现  
> 目标：减少 `features/import/` 里各学术 HTTP 服务的重复代码，统一论文元数据、期刊指标、PDF URL 与题录批处理的抽象接口。

## 1. 问题

当前 `features/import/` 里各服务各自维护一套逻辑：

- `title_search.rs`：Semantic Scholar / arXiv 标题搜索，有 `PaperSearchCandidate`
- `chain_resolve.rs`：标题解析链，有 `ResolvedCandidate`
- `map.rs`：最终存储格式，有 `PaperMeta`
- `mod.rs`：Translator Runtime 特化请求与错误处理
- `assets.rs`：Unpaywall 独立调用
- `pdf_recognize.rs`：Zotero Recognizer 独立调用

三套候选结构互相转换、各自拼 reqwest client、各自处理 timeout / proxy / User-Agent / 限流。新增一个学术数据源要改多处。

## 2. 目标与非目标

**目标：**

- 统一输入查询类型（`ApiQuery`）
- 统一论文候选输出（`ApiPaper`）
- 统一错误类型（`ApiError`）
- 按能力拆 trait，避免一个服务硬塞一堆空方法
- 共享 HTTP 工具，集中处理 timeout / proxy / UA / 限流 / 错误包装
- 把现有 `PaperMeta` 作为 storage 格式保留，只统一「生产 `PaperMeta` 的路径」

**非目标：**

- 不替换 `PaperMeta`（前端 `PaperMetadata` 已依赖其 JSON 形状）
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

`resolver.rs` 的 `ResolvedIdentifier` 可直接映射为 `ApiQuery`。

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

按顶层 `scholar_api` 组织，与 `features/import/` 解耦，方便 `features/refs/`、`features/recommend/`、`features/coolpapers/` 等复用。

```text
src-tauri/src/
  scholar_api/
    mod.rs           # 公开类型：ApiQuery, ApiPaper, ApiError, ApiCapability, VenueMetrics ...
    traits.rs        # AcademicApi, VenueMetricsSource, PdfUrlSource, BibliographySource
    client.rs        # 共享 ApiHttpClient
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

- `scholar_api` 不依赖任何 `features/*` 模块，只依赖 `core/`（error、http、time 等）。
- `features/import/` 依赖 `scholar_api`，把 `ApiPaper` 映射为 `PaperMeta`。
- `features/refs/online.rs`、`features/coolpapers/` 等也直接依赖 `scholar_api`。

因此 `api_paper_to_paper_meta()` 不适合放在 `scholar_api/` 里，而应留在 `features/import/map.rs`（或新增 `features/import/api_mapper.rs`），由 import 域自己维护 storage 映射。通用的候选排序/合并工具如果也不依赖 `PaperMeta`，可以放 `scholar_api/scoring.rs`。

## 8. 迁移路径

分阶段进行，避免一次性大爆炸：

1. **阶段 0：新建抽象层**
   - 创建 `scholar_api/mod.rs` 与 `scholar_api/traits.rs`
   - 实现 `ApiQuery`、`ApiPaper`、`ApiError`、`ApiCapability`、`VenueMetrics`
   - 实现共享 `ApiHttpClient`
   - 在 `features/import/` 内实现 `api_paper_to_paper_meta()` 单一映射函数

2. **阶段 1：先迁 arXiv 和 Crossref**
   - 这两个服务最独立、已有明确的 fallback 位置
   - 在 `scholar_api/sources/arxiv.rs` / `crossref.rs` 实现 `AcademicApi`
   - 保持 `features/import/resolver.rs` 原有调用点不变，内部改调新的 source

3. **阶段 2：Semantic Scholar**
   - 在 `scholar_api/sources/semantic_scholar.rs` 实现 `AcademicApi`
   - 重写 `features/import/title_search.rs` 里的 `s2_search` / `s2_search_match` / `s2_venue_from_paper`
   - 让 `title_search::search_papers` 跑在新抽象上

4. **阶段 3：OpenAlex**
   - 在 `scholar_api/sources/openalex.rs` 实现 `AcademicApi`
   - 重写 `features/import/chain_resolve.rs` 里的 `openalex_search_by_title`
   - 可选在同一文件实现 `VenueMetricsSource` 提供开放指标

5. **阶段 4：EasyScholar**
   - 把 `settings/commands.rs` 里的 `easy_scholar_get_rank` 移到 `scholar_api/sources/easy_scholar.rs`
   - 实现 `VenueMetricsSource`
   - `settings/commands.rs` 里的命令改调新的 source，保持 IPC 契约不变

6. **阶段 5：Translator / Unpaywall / Zotero Recognizer**
   - 在 `scholar_api/sources/translator.rs` 实现 `AcademicApi + BibliographySource`
   - 在 `scholar_api/sources/unpaywall.rs` 实现 `PdfUrlSource`
   - Zotero Recognizer 保持独立，但输出转成 `ApiQuery` 后走 `AcademicApi`

7. **阶段 6：清理旧结构**
   - 删除 `ResolvedCandidate`、`PaperSearchCandidate`（或保留为 legacy alias 到 `ApiPaper`）
   - 删除 `chain_resolve.rs` 里重复的 `candidate_to_meta` / `merge_candidates`
   - 统一走 `features/import/api_mapper` 的映射函数

## 9. 与现有文档的关系

- 实现完成后，更新 [../backend/academic-search-apis.md](../backend/academic-search-apis.md)：把「调用入口」改为指向新的 `scholar_api/sources/*`
- 实现完成后，更新 [../backend/identifier-lookup.md](../backend/identifier-lookup.md)：说明新的 identifier → `ApiQuery` → `AcademicApi` 链路
- 本设计稿保留在 `docs/development/`，落地后可在其中追加「已实现」标记，但不迁移到 `docs/backend/`，避免重复

## 10. 待决策

1. **EasyScholar 返回字段过滤**：你之前说 UI 只保留 `sci` / `sciif` / `sciif5` / `ssci` / `eii` / `cssci` / `pku` / `ccf`。是否在后端 `VenueMetrics` 里就过滤，还是全部返回、前端决定显示哪些？
2. **OpenAlex 指标是否接入**：EasyScholar 未配置时整个期刊标签功能不启用，是否还需要 OpenAlex 作为 `VenueMetricsSource` fallback？
3. **ISSN 是否用于 EasyScholar 查询**：当前 `easy_scholar_get_rank` 只用 `publicationName`。是否先用 ISSN 查 OpenAlex 再回退到名称，提高命中率？
4. **是否保留 `PaperSearchCandidate` 作为前端 IPC 类型**：前端魔棒搜索目前返回 `PaperSearchGroup`（含 `PaperSearchCandidate`）。是否让前端继续用这个 shape，后端内部转成 `ApiPaper`？
