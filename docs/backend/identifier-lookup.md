# 魔棒入库（Identifier Lookup）与 Translator 后端

> 状态：**v0 已落地**（侧栏魔棒 + `lookup_import_batch` + HTTP Translator + 默认 PDF/LaTeX 下载；sidecar/批量/快捷键仍可扩展）  
> 目标：用户点击 **魔棒**，粘贴 **链接或编号** → 用 **Translator** 解析元数据 → **写 catalog + paper 文件夹**（`NOTES.md` 壳 + **PDF 默认到论文根目录**；arXiv **e-print 解压 LaTeX 到 `source/`**）→ 落到 `papers/` 或当前 Papers 子文件夹。catalog 仍保留远程 `pdf_url`/`html_url`（PDF 预览本地优先，远程作下载候选与回退；HTML 仍远程 iframe）。

相关文档：

- Catalog 权威存储：[`catalog.md`](catalog.md)
- 入库命令与事件：[`api.md`](api.md) §3.5
- Vault 文件模型：[`data-model.md`](data-model.md)
- UI：[`../frontend/paper-import.md`](../frontend/paper-import.md)
- **浏览器一键保存**：官方 Zotero Connector → 本机兼容服务 — [`connector.md`](connector.md)（与魔棒并存；元数据映射复用 `map_zotero_item`）
- **多入口入库统一方案**（魔棒 / Connector / 本地 PDF / Bib / 迁移 / CLI）— [`paper-import.md`](paper-import.md)

---

## 1. 产品目标

### 1.1 主交互（必须先满足）

```text
用户点击魔棒
  → 输入框：粘贴链接或编号（DOI / arXiv URL / arXiv ID / ISBN / PMID …）
  → Translator 解析元数据
  → 展示标题/作者等简要结果（可极简：成功即入库，失败走全局 `notifyError` Toast）
  → 加入 Papers：
       ├─ 默认：papers/<id>/
       └─ 若当前上下文是 papers 下的组织子文件夹：papers/<子路径>/<id>/
  → catalog.sqlite 写入一行（含 pdf_url / html_url / source_url 等）
  → 始终下载 PDF → {paper}/{id}.pdf
  → 若 arXiv：下载 e-print 并解压 LaTeX → source/
```

#### 用户故事

1. 用户在工具栏点击 **魔棒**（或 `⇧⌘I`）。
2. 粘贴 **链接**（如 `https://arxiv.org/abs/1706.03762`、`https://doi.org/10.…`）或 **编号**（如 `1706.03762`、`10.1038/…`）。
3. Agentero 用 **本机 Translator Runtime**（Search / 必要 Web）解析出书目元数据。
4. 将条目加入 **Papers**：
   - **默认目标**：Vault 的 `papers/` 根下，`papers/<id>/`。
   - **上下文目标**：若文件树当前选中（或等价「当前打开」）的是 `papers/` 下的**组织子文件夹**（非 paper 本体），则写入  
     `papers/<该子路径>/<id>/`。
5. **Catalog 写入** title / authors / year / doi / arxiv_id / **`pdf_url` / `html_url` / `source_url`** 等；中间栏 **PDF 预览本地优先**（见 [`../frontend/pdf.md`](../frontend/pdf.md)），`pdf_url` 作下载候选与失败回退；HTML 仍读远程 `html_url`。
6. 本地只创建轻量 paper 壳：`NOTES.md`（占位或短摘要）；**不**强制 `source/` 下载、**不**因魔棒去抓 PDF/HTML 文件。

### 1.2 目标文件夹解析规则

| 当前上下文（前端算出后传给 Host） | 入库父目录 `parent_dir` | 最终 path 示例 |
|---|---|---|
| 未选中 / 选中不在 `papers/` 下 | `papers` | `papers/1706.03762` |
| 选中 `papers` 根目录 | `papers` | `papers/1706.03762` |
| 选中 `papers/nlp`（组织文件夹，非 paper） | `papers/nlp` | `papers/nlp/1706.03762` |
| 选中某个 paper 文件夹或其中的文件 | **该 paper 的父目录** | `papers/nlp/1706.03762`（与兄弟 paper 同级） |
| 选中 `notes/`、`plans/` 等 | 回退 `papers` | `papers/1706.03762` |

规则摘要（前端 `resolvePapersParentDir`）：

1. 取文件树 **当前选中路径**（与新建文件时类似；若打开的是 paper 内文件，先归到 paper 文件夹再取其父目录）。
2. 若路径落在某个 **paper 最小单元** 内 → 使用该 paper 的 **父目录** 作为 `parent_dir`。
3. 若路径是 `papers/` 下目录且 **不是** paper → 该目录即为 `parent_dir`。
4. 否则 `parent_dir = "papers"`。
5. Host **校验**：`parent_dir` 必须是 `papers` 或 `papers/` 下既有（或可创建的）相对路径；禁止写到 Vault 外。

UI：弹层底部一行轻量文案，如「将加入 `papers/nlp/`」（i18n），避免大段说明。

### 1.3 本地下载（默认策略）

catalog **始终**写入 `pdf_url` / `html_url`（有则仍可供在线预览）。入库时**默认本地下载**，无配置开关：

| 资源 | 行为 |
|---|---|
| **PDF** | **始终**尝试下载到 **`{paper}/{id}.pdf`（论文文件夹根目录）**（`pdf_url` + arXiv 多候选 URL 回退） |
| **arXiv LaTeX** | 从 `https://arxiv.org/e-print/{id}` 下载；gzip/tar 解压到 `source/`（路径穿越拒绝）；纯 PDF e-print 写到论文根目录 |
| **已有文件** | 跳过对应资源 |
| **`PAPER.md`（无 TeX 时）** | 下载结束后：若**无**本地 `.tex`/`.ltx`、**有** PDF、且尚无 `PAPER.md` → 用选定正文解析引擎（默认 **liteparse**，见 paper-import.md § 正文解析引擎）写 `{paper}/PAPER.md`，并写 catalog `body_source` / `body_quality`。有 TeX 则不自动生成 |

按需补下（**Download** 图标）：

- **显示条件**：缺 PDF **或**（既无 TeX 也无 `PAPER.md`）。可读正文 **TeX 与 PAPER.md 二选一即可，优先 TeX**（有 TeX 不强制 PAPER.md）。**不再**因缺少空 `source/` 单独显示 Download。hover 说明原因。
- **点击**：`paper_download_assets` → PDF 到论文根目录 → arXiv 尽量 TeX 到 `source/` → 无 TeX 则 liteparse `PAPER.md`。
- **Library 行**：库内任一篇不完整时批量同一逻辑。

**精读（Zap 图标 + 自动触发）**：

- **显示条件（Zap）**：本地资源齐全且 catalog **`is_read === false`**（与 Download 互斥）。
- **自动触发**：`lookup_import_batch`（魔棒，单条）或单篇 `paper_download_assets` 成功且 PDF/TeX/`PAPER.md` 任一可读正文/归档就绪时，前端 `maybeAutoRunPaperReader` 自动跑同一工作流（批量 Library 导入/批量 Download **不**自动连跑，避免并发炸 Agent）。
- **手动**：点击 Zap → 同上。
- **实现**：`src/lib/paper/reader.ts` → `agent_run_once` + skill（**`hideFromChatHistory: true`**，不进 Agent 对话记录）；Codex `$paper-reader` / Claude `/paper-reader` / 其它注入 `SKILL.md` → 写 `{paper}/NOTES.md` → `paper_set_is_read(true)`；进度在左下角后台任务条。
- **进度**：左下角后台任务条——入库/下载阶段 `kind=lookup|download`（分阶段 detail/progress），随后精读 `kind=paperRead`。

UI 阅读：优先 catalog 远程 URL；`source/` 为 arXiv TeX 归档；`PAPER.md` 为无 TeX 时的派生正文。

#### Translator 服务地址（设置）

| 项 | 值 |
|---|---|
| 设置 key | `translatorBaseUrl`（Settings → General） |
| 默认 | **`https://translator.philfan.cn`** |
| Host 常量 | `DEFAULT_TRANSLATOR_BASE_URL`（与设置默认一致） |

- 魔棒入库时前端把设置中的 URL 传入 `lookup_import_batch.args.translatorBaseUrl`。
- Host：`POST {base}/search` 或 `/web`（`Content-Type: text/plain`）。
- 服务不可达且输入为 arXiv 时，回退 export.arxiv.org。

> ~~`downloadFulltextToLocal`~~ 已移除；始终下载 PDF。

实现：`AppSettings` + General Switch；`lookup:import` 传入该标志。

### 1.4 非目标（本阶段）

| 不做 | 说明 |
|---|---|
| 有远程 URL 时跳过本地下载 | 不做：入库与预览均本地优先；远程仅作下载候选与失败回退 |
| 官方 Zotero 公网 Translation SaaS | 自托管 Runtime |
| AGPL 翻译器链进主二进制 | sidecar 旁路进程 |
| 复杂多步确认面板 | v1 可「解析成功即入库」；重复时提示 skip / 打开已有 |

### 1.5 统一数据流（arXiv 与 DOI 等合并）

**不要**再分「左边 arXiv API / 右边 Translator」两条线。魔棒只走一条管道：

```text
用户输入（链接或编号：arXiv / DOI / ISBN / PMID …）
        │
        ▼
  parse → 规范化标识符 / URL
        │
        ▼
  Translator Runtime
    ├─ 编号 → POST /search
    └─ 链接 → POST /web（必要时）
        │
        ▼
  Zotero API JSON Item
        │
        ▼
  map → PaperMetadata（字段直接写入，见 §5）
    + 补全：arxiv 时用 arxiv.ts 填 pdf_url/html_url/source_url（若 Translator 未给）
        │
        ▼
  parent_dir 解析 → path = {parent_dir}/{id}
        │
        ▼
  catalog.papers UPSERT（sqlite，权威）
  + papers/.../NOTES.md
        │
        ▼
  下载（见 §1.3）：始终 PDF → 论文根目录；arXiv 另 e-print 解压 LaTeX 到 source/

读路径：UI 用 paper_get 读 catalog；catalog 为唯一权威。
```

| 来源 | 在统一流中的位置 |
|---|---|
| arXiv 编号/abs URL | 同一 Translator（arXiv Search/Web）→ map 进 metadata + PDF/TeX 下载 |
| DOI / ISBN / PMID | 同一 Translator Search → map 进 metadata + 尽量下载 PDF |
| 远程 PDF/HTML | catalog 字段 + **PDF 默认本地下载**；HTML 可仍远程预览 |
| 旧独立 `arxiv:import` 全量下载 | 已并入魔棒默认下载路径 |

原则：

- **Translator 返回值 → 直接并入 `PaperMetadata`**，再落 catalog；不并行维护两套 arXiv 专用结构。
- **魔棒 = 加入文库 + 本地归档**（metadata + 远程 URL + 笔记壳 + PDF；arXiv 含 LaTeX）。

---

## 2. 架构总览

### 2.1 分层

```text
┌──────────────────────────────────────────────────────────┐
│ Frontend：魔棒输入 + parent_dir + 打开 paper              │
└───────────────────────────┬──────────────────────────────┘
                            │ lookup:add / lookup:search+import
┌───────────────────────────▼──────────────────────────────┐
│ Host：parse → Translator client → map→PaperMetadata      │
│       → catalog upsert + 最小文件落盘                      │
└───────────────────────────┬──────────────────────────────┘
                            │ POST /search | /web
┌───────────────────────────▼──────────────────────────────┐
│ Translator Runtime（本机 sidecar）                         │
│  Search/Web translators（含 arXiv、DOI、ISBN、PMID…）      │
└──────────────────────────────────────────────────────────┘
```

### 2.2 为何用旁路 Translator Runtime

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 仅自写 Crossref/arXiv 客户端 | 无 AGPL、实现简单 | 覆盖面远小于 Zotero；ISBN/PMID/ADS 等要逐个做 | 可作为 **fallback** |
| B. Agentero 进程内嵌 JS 翻译器引擎 | 零外部进程 | AGPL 传染风险、打包复杂 | **不做**（除非产品整体 AGPL） |
| C. **本机 sidecar：translation-server** | 复用全量 Search Translator；进程边界清晰；可热更新 translators | 需管理子进程生命周期 | **推荐主路径** |
| D. 用户自备 URL 指向外部 server | 灵活 | 隐私/ToS/可用性不可控 | 高级设置可选 |

**默认策略**：Agentero 启动后按需拉起本地 Translator Runtime；不可用时降级到内置轻量客户端（DOI→doi.org/Crossref，arXiv→export API），并在 UI 标明「精简模式」。

### 2.3 与 Zotero 魔棒的对应关系

| Zotero | Agentero |
|---|---|
| `lookup.js` UI | `MagicWand` 弹层 |
| `extractIdentifiers()` | `lookup:parse` / Host `parse.rs` |
| `Zotero.Translate.Search` | `POST /search` on translation-server |
| Search Translators 仓库 | sidecar 内置 / 可更新的 translators 目录 |
| 写入 Zotero SQLite | 写 Vault 文件 + **catalog.sqlite** |
| 可选附件 | 本阶段可选：有 `pdf_url`/`arxiv_id` 再走 source 抓取 |

参考实现（上游，不 fork 进 Agentero 主仓逻辑）：

- UI：[`zotero/zotero` `lookup.js`](https://github.com/zotero/zotero/blob/main/chrome/content/zotero/lookup.js)
- 解析：[`zotero/utilities` `extractIdentifiers`](https://github.com/zotero/utilities)
- 引擎：[`zotero/translate` `Translate.Search`](https://github.com/zotero/translate)
- HTTP 服务：[`zotero/translation-server`](https://github.com/zotero/translation-server)
- 翻译器：[`zotero/translators`](https://github.com/zotero/translators)（如 `DOI Content Negotiation.js`、`Library of Congress ISBN.js`、`PubMed.js`、`arXiv.org.js`）

---

## 3. 标识符与解析规则

### 3.1 支持的类型（v1）

| 类型 | 示例 | Translator 侧典型来源 |
|---|---|---|
| **DOI** | `10.1038/nature12373`、`https://doi.org/10.…` | DOI Content Negotiation → Crossref / DataCite / CSL |
| **ISBN** | `978-0-262-03384-8`、`0838985890` | LoC / WorldCat 等 ISBN Search Translator |
| **PMID** | `24297125`、`PMID:24297125` | NCBI E-utilities via PubMed Translator |
| **arXiv** | `1706.03762`、`arXiv:1706.03762v1`、abs URL | arXiv Search Translator 或 Agentero arXiv API |
| **ADS Bibcode** | `2015ApJ...810...89S` | ADS 相关 Search Translator |

批量：魔棒输入框支持一次粘贴多个标识符，按**换行 / 回车、逗号 `,`、分号 `;`、中文逗号 `，`、中文分号 `；`**拆分（正则 `/[\n\r,;，；]+/`）。空格**不再**是分隔符 —— 论文标题与 `npx skills add …` 都含空格，必须整段送到 Host。Host 侧 `classify_segment`（`src-tauri/src/features/import/batch.rs`）按以下顺序判定每一段：

1. 单 token → `extract_primary_identifier`，命中即标识符，否则转标题搜索。
2. 多 token 且整段是 Skill 来源（`npx skills add …`）→ 单条 Skill。
3. 多 token 且**每个** token 都能解析出标识符 → 展开为多条（保住"空格分隔多个 ID"的粘贴习惯）。
4. 其余 → 标题/关键词查询（见 3.4）。

> 多 token 不做整段匹配：`clean_doi` / `clean_isbn` 会扫描整个字符串，整段匹配会把列表其余部分或整句标题一起吞掉。

去重按去 version 的 arXiv ID / DOI / ISBN / PMID 等进行。PMID 仍可在 Runtime 侧按批合并（Zotero 习惯每批 ≤200）。

### 3.2 解析优先级（对齐 Zotero `extractIdentifiers`）

对同一段输入文本，**按序**尝试（命中一类后，Zotero 原逻辑会停止后续类型；Agentero 建议：

- **单条粘贴框**：采用 Zotero 同序，降低数字误识别为 PMID。
- **显式多行「每行一个」模式**：逐行独立解析，允许一行 DOI、一行 arXiv 混合。

顺序：

1. DOI（含 URL 解码与 `cleanDOI`）
2. ISBN（校验位；ISBN-10/13）
3. arXiv（去掉 version 后缀用于查库）
4. ADS Bibcode
5. PMID（1–9 位数字，最后匹配）

> 实现上，优先级由 `src-tauri/src/features/import/resolver.rs` 的静态 resolver 表驱动：Url / Doi / Arxiv / Isbn / Pmid / Ads 各实现 `PaperResolver`（`priority` 探测顺序、`catalog_column` 查重列、`translator_target` 构造 Translator 请求、`fetch_fallback` Translator 失败后的直连回退——arXiv→Atom、DOI→Crossref）。Skill 不入表，由 `parse::extract_skill_source` 前置分流。新增导入源只需实现一个 resolver 并登记进表（表按 `priority` 排序，有测试守护）。

解析失败：返回 `lookup.failure_to_id`，不调用网络。

### 3.3 输出：`ParsedIdentifier`

```ts
type IdentifierKind = 'doi' | 'isbn' | 'pmid' | 'arxiv' | 'ads_bibcode';

interface ParsedIdentifier {
  kind: IdentifierKind;
  /** 规范化后的原始值（无 version 的 arXiv、clean DOI 等） */
  value: string;
  /** 用户输入中的原始片段（用于 UI 高亮） */
  raw: string;
}
```

### 3.4 标题搜索回退

**Zotero translator 无法承担这一步。** translation-server 的 `POST /search`（§4.2）是标识符入口，Zotero Search Translators 只做「标识符 → 元数据」，没有自由文本检索能力；Agentero 本地也没有 JS runtime 来跑 translator。因此标题搜索必须直连检索 API。

兼容性通过分工保留：**搜索只负责「文本 → 候选标识符」**，用户选中后把 `identifier`（arXiv ID 优先，其次 DOI）重新提交 `lookup_import_batch`，Translator 仍是元数据的唯一事实来源，入库管道不分叉。

- 实现：`src-tauri/src/features/import/title_search.rs`
- 数据源：Semantic Scholar Graph API `/paper/search` 为主；报错或 0 结果时回退 **arXiv** `search_query=ti:"…"&sortBy=relevance`。两者均免 key，复用 `core::http::client_builder()` 与信号量限流（并发 2）。
  > **S2 无 key 的搜索接口限流极严（实测连续 3 次均 429）**，所以 arXiv 才是线上的常走路径。不选 Crossref 兜底：NeurIPS proceedings 之类没有 Crossref DOI，搜 "Attention is all you need" 时正确论文**根本不在** Crossref 结果集里，只会返回一堆同名论文。
  > arXiv 的 Atom 需要按 `<entry>` 切块解析 —— `map::map_arxiv_atom` 只处理单条响应，不能复用。
- 排序：保留 provider 的相关度顺序，但把**标题与 query 归一化后完全相等**的条目提到最前（归一化 = 小写、去非字母数字、压空格）。同名论文很多，这一步防止真正那篇被埋掉。
- **过滤掉既无 DOI 也无 arXiv ID 的条目** —— 没有标识符就无法入库，不能出现在候选里。
- Top 3 返回给前端（`SEARCH_CANDIDATE_LIMIT`）；无结果或搜索失败写入 `errors`，不静默。单源失败走 `log::warn!`，否则 S2 的 429 完全不可见。
- 副作用：拼错的标识符（如 `1706.0376`）现在会走搜索并得到「无结果」，比原来的 `unrecognized identifier` 更可读。

---

## 4. Translator Runtime 契约

### 4.1 部署形态

| 模式 | 说明 | 默认 |
|---|---|---|
| `bundled` | Agentero 附带/下载 sidecar 二进制或 Docker 镜像说明；Host 管理端口与生命周期 | 是（桌面） |
| `external` | 用户在设置中填 `http://127.0.0.1:1969` | 可选 |
| `off` | 仅用内置 fallback 客户端 | 降级 |

设置项（应用配置 / Tauri Store，**非** Vault）：

```ts
interface TranslatorRuntimeConfig {
  mode: 'bundled' | 'external' | 'off';
  base_url?: string;           // external 时必填，如 http://127.0.0.1:1969
  auto_start?: boolean;        // bundled 时默认 true
  user_agent_suffix?: string;  // 追加到请求 UA，便于站点联系
  timeout_ms?: number;         // 默认 30000
}
```

**User-Agent**：对外请求应带可识别后缀，例如  
`agentero-translation/0.1 (+https://github.com/poco-ai/agentero; contact@…)`，避免伪装成无标识爬虫（与 translation-server README 建议一致）。

### 4.2 HTTP API（与官方 translation-server 对齐）

#### `POST /search` — 标识符查元数据（魔棒主路径）

- **Request**：`Content-Type: text/plain`  
  Body：单个标识符字符串，或实现约定的多 ID 文本。
- **Response**：`200` + Zotero API JSON 数组（items）。

```bash
curl -d '10.2307/4486062' \
  -H 'Content-Type: text/plain' \
  http://127.0.0.1:1969/search
```

#### `POST /web` — 网页 URL（v2 可选）

用于后续「粘贴论文页 URL」；本阶段可不接 UI。

#### `POST /import` — BibTeX/RIS 等（Library 导入已用）

- **Request**：`Content-Type: text/plain`，body = 文件全文。  
- **Response**：`200` + **Zotero API JSON 数组**（与 `/search` 相同 item 形状）。  
- Agentero：`paper_import` → map → catalog + paper 壳。

#### `POST /export` — Zotero items → BibTeX/RIS/…（Library 导出已用）

- **Request**：`Content-Type: application/json`，body = **items 数组**（非单个 object）。  
- **Query**：`format=bibtex|biblatex|ris|csljson|…`  
- Agentero：catalog 行先 `paper_record_to_zotero_item` 再调 `/export`。

### 4.3 健康检查与懒启动

```text
lookup:search 被调用
  → client.ensure_ready()
       ├─ mode=off → 走 fallback
       ├─ external → GET/探测 base_url，失败则错误「无法连接 Translator」
       └─ bundled → 若进程未起：spawn sidecar，轮询 ready（≤ N 秒）
  → POST /search
```

事件（可选）：`translator:status` → `{ state: 'stopped'|'starting'|'ready'|'error', detail? }`。

### 4.4 失败与降级

| 情况 | 行为 |
|---|---|
| Runtime 未启动且 auto_start 失败 | 错误 + 引导打开设置；可选「用精简模式重试」 |
| `/search` 超时 | `lookup.timeout`；该 ID 标记 failed，其它 ID 继续 |
| 无匹配书目 | `lookup.not_found` |
| Runtime 返回部分成功 | 返回成功草稿 + 失败列表（对齐 Zotero「部分失败仍继续」） |
| fallback 成功 | `source: 'fallback'`，libraryCatalog 填 `Agentero (Crossref)` 等 |

---

## 5. 数据映射：Translator Item → `PaperMetadata`（直接并入）

Translator 输出的 **Zotero API JSON Item** 经 `map` **直接写入** `PaperMetadata` / catalog 列，**不再**先落到另一套 arXiv 专用结构。  
catalog **schema v2** 起补齐期刊/卷期页等字段（见 [`catalog.md`](catalog.md) §4.2）。

### 5.1 字段对照（Item → metadata）

| `PaperMetadata` / catalog | Translator Item 来源 | 说明 |
|---|---|---|
| `title` | `title` | 必填；缺失则失败 |
| `authors` | `creators[]` → 展示串 | `firstName`+`lastName` 或 `name`；优先 `creatorType=author` |
| `creators_json` | `creators` 原数组 | 保留角色（author/editor…），JSON 文本 |
| `year` | 自 `date` 解析四位年 | |
| `date` | `date` | 原始日期串（如 `2017-06-12`） |
| `abstract` | `abstractNote` | |
| `summary` | 截断 `abstractNote` 或 Translator 短摘要 | 可选 |
| `doi` | `DOI` | |
| `isbn` | `ISBN` | 图书 |
| `issn` | `ISSN` | |
| `pmid` | `extra` 中 `PMID:` 或字段 | |
| `arxiv_id` | `archiveID` / `extra` 的 `arXiv:` / 用户输入 | 去 version |
| `publication` | `publicationTitle` \| `proceedingsTitle` \| `bookTitle` | 期刊/会议/书名 |
| `volume` | `volume` | |
| `issue` | `issue` | |
| `pages` | `pages` | |
| `publisher` | `publisher` | |
| `place` | `place` | 出版地 |
| `series` | `series` | |
| `language` | `language` | |
| `source_url` | `url` | 条目页；缺省时按类型推导 |
| `pdf_url` | attachments 中 pdf 的 `url`（若有） | **只存 URL**；arXiv 可再推导 |
| `html_url` | — | arXiv 可推导 `…/html/{id}` |
| `tags` | `tags[].tag` | |
| `zotero_item_type` | `itemType` | 如 `journalArticle`、`preprint`、`book` |
| `meta_source` | `libraryCatalog` | 如 `DOI.org (Crossref)`、`arXiv.org` |
| `extra` | `extra` | 未结构化残余 |
| `type` | 由 `zotero_item_type` + 标识符推断 | 有 `arxiv_id`→`arxiv`；有 `doi`→`doi`；book→`other` 等 |
| `id` | arXiv ID 或 citekey | |
| `bibtex_key` | 生成或沿用 | 作者 + 年+题词 |
| `path` | Host 用 `parent_dir`+`id` 写入 | 入库时填 |
| `status` | Host | 入库完成 → `completed` |
| `added_at` / `updated_at` | Host | ISO 8601 |
| `body_source` / `body_quality` | 魔棒通常不填 | 无本地正文解析 |
| `citation_count` | 一般无 | 可空 |

### 5.2 URL 补全

在 map 之后、写库之前：

1. 若有 `arxiv_id` 且缺 URL → 推导 `pdf_url` / `html_url` / `source_url`。
2. 若有 `doi` 且缺 `source_url` → `https://doi.org/{doi}`。
3. 若有 `pmid` 且缺 `source_url` → PubMed 条目 URL。
4. **URL 补全本身不下载**；下载在 catalog upsert **之后**由 `ensure_paper_assets` 统一执行（§1.3）。

### 5.3 中间结果

入库前 Host 手中只有 **`PaperMetadata`（已 map）**；不必单独长期持有 Zotero Item。调试可选暂存 `raw` 日志，不进 catalog。

```ts
// 概念：一次魔棒调用（落地：lookup_import_batch）
const item = await translator.searchOrWeb(input); // Zotero Item
const metadata = mapZoteroItemToPaperMetadata(item); // → PaperMetadata
enrichRemoteUrls(metadata); // arxiv/doi 推导
await catalog.upsert({ ...metadata, path });
await ensure_paper_assets(paperDir, metadata); // PDF + arXiv LaTeX → source/
```

---

## 6. Tauri 命令与事件（契约）

命令名采用 `lookup:*`，与 `arxiv:*` / `pdf:*` 并列。完整登记见 [`api.md`](api.md)（实现时同步）。

### 6.1 `lookup:parse`

从文本提取标识符，**不访问网络**。

```ts
// 参数
{ text: string; mode?: 'zotero' | 'line_by_line' }

// 返回
{
  ok: true;
  data: { identifiers: ParsedIdentifier[] }
}
```

### 6.2 `lookup:search`

解析 + 调用 Translator Runtime（或 fallback），返回草稿列表。

```ts
// 参数
{
  text: string;
  mode?: 'zotero' | 'line_by_line';
  /** 强制只用 fallback，用于调试 */
  force_fallback?: boolean;
}

// 返回
{
  ok: true;
  data: {
    drafts: LookupDraft[];
    failures: { raw: string; code: string; message: string }[];
    runtime: { mode: string; used: 'translator' | 'fallback' };
  }
}
```

### 6.3 `lookup:import`

将解析结果写入目标 Papers 文件夹 + catalog；下载策略见 §1.3。

```ts
// 参数
{
  /** Vault 相对父目录：`papers` 或 `papers/nlp` 等（见 §1.2） */
  parent_dir: string;
  items: {
    draft_id?: string;
    metadata: PaperMetadata; // 可含 pdf_url / html_url / source_url
    on_duplicate?: 'skip' | 'open_existing';
  }[];
  options?: {
    /** Agent 生成 NOTES；默认 false 写占位模板 */
    generate_notes?: boolean;
  };
}

// 返回
{ ok: true; data: { job_id: string } }
// 或同步：{ ok: true; data: { paths: string[] } }
```

**Host 行为**（落地实现：`lookup_import_batch` 单条路径）：

1. 规范化 `parent_dir`（必须位于 `papers` 下）。
2. `path = {parent_dir}/{id}`。
3. 创建目录 + 占位 `NOTES.md`。
4. **事务 upsert catalog**（远程 URL 仍存字符串供预览）。
5. **始终** `ensure_paper_assets`：PDF → `{paper}/{id}.pdf`；有 `arxiv_id` 时 e-print TeX 解压到 `source/`。
6. 返回 `path`；前端刷新并打开 paper。

### 6.4 `lookup_import_batch`（魔棒批量入库）

一次性解析、去重并入库多个标识符。前端魔棒输入框改为可变高度 textarea，粘贴 `1706.03762 1810.04805` 或每行一个 URL 后提交即走本命令。

- **参数**（invoke 字段名 `args`）：

  ```ts
  {
    vaultPath: string;
    parentDir: string;              // "papers" | "papers/nlp"
    texts: string[];                // 用户输入拆分后的原始 token 数组
    translatorBaseUrl?: string;     // 同上
    taskId?: string;                // 前端后台任务 id
    concurrency?: number;           // 最大并发入库数，默认 5，范围 1–10
  }
  ```

- **返回**：

  ```ts
  {
    ok: true;
    data: {
      imported: LookupImportResult[];
      skipped: { raw: string; kind: string; value: string; reason: 'duplicate_in_batch' | 'already_in_library' }[];
      errors: string[];
    }
  }
  ```

- **行为**：
  1. 对 `texts` 逐条调 `extract_primary_identifier`；未识别则计入 `errors`。
  2. 按规范化 value（arXiv 去 version、DOI 小写等）去重：同一 batch 内重复 → `skipped`（`duplicate_in_batch`）。
  3. 对每条唯一标识符查 catalog：已存在同 `arxiv_id` / `doi` / `isbn` / `pmid` / `id` 的 paper → `skipped`（`already_in_library`）。
  4. 剩余条目以 `concurrency`（默认 5，范围 1–10）为上限**并发**调 `import_by_identifier_with_progress`。单条失败继续下一条，错误文本加入 `errors`。并发上限可在 **Settings → General → Batch import concurrency** 调整。commit 阶段仍按 `id` / `arxiv_id` / `doi` / `pmid` / `isbn` 做跨标识符去重（`DedupePolicy::ByIdentifiers`，#406），预检后出现的重复不会新建文件夹。
  5. 返回全部 `imported` 条目；前端刷新树 / Library / wiki 后，对 `imported` 中仍缺资源的 paper 逐个加入下载队列，每篇对应一个独立的 `download` 后台任务，并按并发上限排队执行。

魔棒界面使用通用的 `enqueueBackgroundTask` 为每个输入创建一个独立的前端任务。任务面板只展示每个标识符的状态和资源进度，不展示 Host 批处理的内部阶段或聚合计数；并发限制由同类任务共享的信号量执行。

- **不自动精读**：批量入库不连跑 `paper-reader`，避免 Agent 与写笔记开销爆炸；用户可后续单篇手动 Zap 或等设置 `autoPaperReader` 对单篇触发。

### 6.5 事件

| 事件 | 载荷 |
|---|---|
| `lookup:progress` | `{ job_id, done, total, current_id?, phase }` |
| `lookup:item_completed` | `{ job_id, path, id }` |
| `lookup:item_failed` | `{ job_id, draft_id, code, message }` |
| `lookup:completed` | `{ job_id, paths: string[] }` |
| `lookup:failed` | `{ job_id, message }` |
| `translator:status` | Runtime 状态（可选） |

### 6.5 `translator:status` / `translator:restart`（设置页）

供设置页显示 Runtime 是否就绪、手动重启 sidecar。

---

## 7. 许可、隐私与合规

### 7.1 许可

| 组件 | 许可（典型） | Agentero 用法 |
|---|---|---|
| `zotero/translators` | 多为 AGPL-3.0 | **仅在 sidecar 进程内**使用与分发 |
| `zotero/translate` / translation-server | AGPL-3.0 | 旁路进程；源码按 AGPL 提供或指向上游 |
| Agentero 主应用 | 以仓库 LICENSE 为准 | 通过 **HTTP localhost** 调用 sidecar，不把 translators 链进主二进制 |

产品文案建议：

- 设置页注明：「书目解析可选用 Zotero Translator 引擎（开源，AGPL），运行在本机独立进程。」
- 不声称「Official Zotero」；不使用 Zotero 商标做应用名。

### 7.2 隐私与网络

- 标识符与查询会发往 **第三方书目服务**（Crossref、PubMed、出版社 DOI 解析等），由各 Translator 决定，**不经 Zotero 公司服务器**（自托管 Runtime 时）。
- Agentero 默认 **不**把 Vault 路径或笔记内容发给 Translator Runtime（Search 路径只传 ID）。
- 遵守目标站 ToS；控制并发与超时；批量入库限流。

### 7.3 local-first

- 元数据确认后写入 **用户 Vault** + **catalog**；离开应用后仍是普通文件 + sqlite。
- 不引入「仅云端可解析」为默认；Runtime 可离线则仅失败，不锁死 Vault。

---

## 8. 前端 UI（概要）

详细视觉以 [`paper-import.md`](../frontend/paper-import.md) 为准；本处只定行为。

### 8.1 入口

- 工具栏 **魔棒图标**（`WandSparkles` 等），Tooltip + `aria-label` → i18n `lookup.magicWand`。
- 快捷键：`⇧⌘I`（`shortcuts.ts` `magicWand` + 设置 Keyboard；无 Vault 时提示先打开）。
- 无 Vault 时 disabled。

### 8.2 主交互流（v1）

```text
点击魔棒
  → 弹出输入框（单行或小多行）：placeholder 如“arXiv URL / ID, DOI, …”
  → 展示目标路径提示：将加入「papers/」或「papers/nlp/」（来自 §1.2）
  → 用户 Enter 或点「添加」
  → lookup:search（Translator）→ 可选极简预览
  → lookup_import_batch({ parent_dir, texts, translatorBaseUrl })
  → 成功：catalog + source/PDF（arXiv 含 TeX）；刷新文件树 / Library / wiki；`openPaper` 打开 paper（PDF 预览优先本地）并 **左侧树展开祖先、滚到新论文行**
  → 失败：全局 Toast（`notifyError`，见 [`../frontend/paper-import.md`](../frontend/paper-import.md)）；Popover 内字段校验可仍就地显示
```

**默认体验偏好**：少步骤——解析成功即可入库；仅在 **重复** 或 **解析到多结果** 时打断确认。

文案：English 源语言 `en`，同步 `zh-CN`。无常驻说明段落。

### 8.3 目标文件夹展示

- 弹层内一行：`t('lookup.addTo', { path: parentDirDisplay })`。
- 用户切换文件树选中项后再次打开魔棒，目标随之更新（打开弹层时快照一次即可）。

---

## 9. Host 模块布局（早期规划，仅供参考）

> 实际落地时相关逻辑并入了 `src-tauri/src/features/import/`（`parse.rs`、`map.rs`、`assets.rs`、`paper_import/mod.rs` 等），没有独立的 `commands/` / `services/` 分层。下列结构保留为设计阶段参考。

```text
src-tauri/src/
  commands/
    lookup.rs
    translator.rs          # status / restart
  services/
    lookup/
      mod.rs
      parse.rs             # extractIdentifiers 规则
      client.rs            # Runtime HTTP
      map.rs               # Zotero JSON → PaperMetadata
      dedupe.rs
      fallback/
        mod.rs
        crossref.rs
        arxiv.rs
    importer/
      mod.rs               # 统一落盘
      from_metadata.rs     # 魔棒确认后的 metadata-only / optional source
    translator_runtime/
      mod.rs               # spawn / health / shutdown
```

前端：

```text
src/
  components/lookup/
    MagicWandButton.tsx
    LookupPopover.tsx
    LookupDraftList.tsx
  lib/lookup.ts            # invoke 封装
  i18n/locales/{en,zh-CN}/lookup.json
```

---

## 10. 入库落盘契约（魔棒）

```text
papers/
└── [optional-subfolders/]
    └── <id>/
        ├── NOTES.md
        ├── <id>.pdf           # 默认下载到论文根
        ├── source/            # arXiv：e-print 解压后的 .tex 工程
        └── attachments/       # 可选；入库不预建。用户/Agent 的支撑材料
# catalog.papers: path, title, pdf_url, html_url, …
# 划词标注运行时写入 marks/*.json（非入库壳）
```

1. `path = {parent_dir}/{id}`（§1.2 + §6.3）。
2. 写 `NOTES.md` 壳（摘要 blockquote 经 Host 免费 MT **并行竞速** bing / 火山 / 腾讯，取最先成功；单引擎超时 5s；**全失败则不写摘要块**；catalog `abstract` 仍为原文）。
3. **catalog 事务**：有则写入 `pdf_url` / `html_url`。
4. 下载按 §1.3：**始终 PDF**（候选：`pdf_url` → arXiv → Crossref 直链 → **Unpaywall OA**）；**arXiv 另解压 LaTeX**。
5. **不**写默认 `PAPERS.md` / `library.bib`；元数据仅存于 catalog。
6. 重复：`on_duplicate: skip | open_existing`，**不**覆盖用户 `NOTES.md`。

arXiv URL 推导：

- `pdf_url`: `https://arxiv.org/pdf/{id}`（并下载）
- `html_url`: `https://arxiv.org/html/{id}`
- `source_url`: `https://arxiv.org/abs/{id}`
- e-print: `https://arxiv.org/e-print/{id}`（解压到 `source/`）

`type`：`arxiv` | `doi` | `other`（按标识符）。

---

## 11. 实现分期

### Phase A — 交互闭环（可先 fallback）

- [x] 文档：交互、目标文件夹、默认下载约定
- [x] 魔棒 Popover + `parent_dir` 解析 + i18n（侧栏 `WandSparkles`）
- [x] Host 解析 + arXiv fallback（Translator 失败时）
- [x] 魔棒入库：catalog upsert + NOTES 壳 + PDF/LaTeX 下载

### Phase B — Translator 服务

- [x] HTTP 客户端 → `POST {translatorBaseUrl}/search|/web`（默认 `https://translator.philfan.cn`）
- [x] map → `PaperMetadata` / catalog schema v2；设置页 `translatorBaseUrl`
- [ ] 可选本机 sidecar 捆绑 / 探测；更细 dedupe UX

### Phase C — 体验打磨

- [x] 入库后刷新文件树；可打开 paper；树选中并滚到新论文行
- [x] 入库后 `graph_rebuild` 并刷新 Backlinks/Graph
- [x] 与文件树选中态同步目标 `parent_dir`
- [x] 论文库 UI：`paper_list` 表格 + 虚拟 Library 节点（见 [`../frontend/library.md`](../frontend/library.md)）
- [x] 单篇 / Library 批量补下缺失 PDF 与 arXiv TeX（`paper_download_assets`）
- [x] 无 TeX 时 liteparse → `PAPER.md`（下载后自动）
- [x] `⇧⌘I` 魔棒快捷键
- [x] 魔棒批量入库：多标识符粘贴、去重、批量下载、进度聚合
- [x] 标题/关键词搜索回退：Top 3 候选单选弹窗 → 回填标识符入库（#326）
- [ ] 重复提示增强（单条弹层内）、入库任务可取消

### Phase D — 可选

- [x] 默认下载 PDF；arXiv e-print 解压 LaTeX；无 `downloadFulltextToLocal` 开关
- [x] 文件树缺 PDF，或既无 TeX 也无 `PAPER.md` 时 Download → `paper_download_assets`
- [x] 无 TeX 时生成 `PAPER.md`（liteparse）
- [ ] PDF prepare 复用同一 Lookup

---

## 12. 测试要点

### 12.1 单元测试

| 层级 | 内容 |
|---|---|
| 单测 `parse` | arXiv URL/ID、DOI、version 剥离 |
| 单测 `parent_dir` | 根 / 子文件夹 / paper 内文件 → 父目录 |
| 单测 import | catalog 有 `pdf_url`；`source/` 不出现 pdf（设置关时） |
| 单测 settings | `batchImportConcurrency` 越界时自动恢复为默认值 5 |

### 12.2 批量魔棒导入手动测试

| 编号 | 场景 | 输入示例 | 预期现象 |
|---|---|---|---|
| B-1 | 多分隔符混合解析 | `1706.03762, 1810.04805; 2501.12345，2502.67890\n2503.11111 2504.22222` | 解析出 6 个 token；任务面板显示 6 个独立导入任务，各自按条目更新进度；失败条目显示独立错误 |
| B-2 | Batch 内去重 + 已存在去重 | 库中已有 `1706.03762`；输入 `1706.03762\n1706.03762\n1810.04805` | 第 1 个 `1706.03762` → `skipped`（`already_in_library`）；第 2 个 → `skipped`（`duplicate_in_batch`）；`1810.04805` 导入成功；summary `Imported 1, skipped 2, failed 0` |
| B-3 | 并发上限生效 | 设置 `Batch import concurrency = 2`，粘贴 5 个不同 ID | 任务面板显示 5 个独立任务；同时运行的导入任务不超过 2 个，其余任务排队；每个任务独立显示进度 |
| B-4 | 非法/无法识别输入 | `1706.03762\nnot-a-valid-id` | `1706.03762` 导入成功；`not-a-valid-id` 进入 `errors`；summary `Imported 1, skipped 0, failed 1` 并走 error toast |
| B-5 | 导入后逐篇补下缺失资源 | 6 个 ID 均缺 PDF/TeX | 导入完成后左下角任务列表出现 **6 个独立的 `Download paper assets`** 任务；默认并发 5 时前 5 个 `running`、后 1 个 `queued`；每完成一篇队列中下一篇自动开始 |
| B-6 | 只打开第一篇成功论文 | 4 个 ID，其中第 2 个失败 | 成功后只打开第 1 篇成功导入的 paper tab；失败条目不打开；文件树展开到新论文路径 |
| B-7 | 设置值越界自动恢复 | 手动把 `settings.json` 的 `batchImportConcurrency` 改为 `20` 或 `-1` | 启动后自动 clamp 为默认值 5；UI 中显示 5 |

---

## 13. 验收标准

1. ~~点击魔棒，粘贴链接或编号，成功后 paper 壳 + **catalog 有行**。~~ ✅  
2. ~~入库始终尝试下载 PDF 到 `source/`。~~ ✅  
3. ~~arXiv 另下载 e-print 并解压 LaTeX。~~ ✅  
4. ~~缺 PDF，或既无 TeX 也无 `PAPER.md` 时文件树显示 Download，可补下。~~ ✅  
5. ~~无 TeX 时下载后 liteparse 可生成 `PAPER.md`（无独立眼睛图标）。~~ ✅  
6. 文件树选中 `papers/nlp` 时路径为 `papers/nlp/<id>/`。  
7. 重复不覆盖 `NOTES.md`；文案 i18n。  
8. ~~论文库表格（`paper_list`）能列出已入库论文。~~ ✅  

---

## 14. 开放问题

1. **sidecar 分发**方式（捆绑 / Docker / 首次下载）— 当前默认远程 Translator URL。  
2. v1 是否「解析成功即入库」还是始终二次确认。  
3. `generate_notes` 默认是否调 Agent（建议默认占位模板）。  

---

## 15. 修订记录

| 日期 | 说明 |
|---|---|
| 2026-07-15 | 初稿：Translator sidecar、命令契约 |
| 2026-07-15 | 交互收敛：链接/编号 → Translator → 加入 papers/ 或当前子文件夹；远程 URL 只写 catalog、不下载 |
| 2026-07-15 | 数据流合并：arXiv/DOI 等统一 Translator → 直接 map 进 PaperMetadata；catalog schema v2 补字段 |
| 2026-07-15 | 下载策略：无预览 URL 始终尝试下载；有 URL 时仅 `downloadFulltextToLocal` 开才额外本地下载 |
| 2026-07-15 | 实现进度：`lookup_import` / 设置 Translator URL / catalog 权威 / `paper_list` + Library UI |
| 2026-07-15 | 默认下载 PDF；arXiv 解压 LaTeX；移除 `downloadFulltextToLocal`；`paper_download_assets` + 树行 Download |
| 2026-07-15 | 无 TeX 时 liteparse → `PAPER.md`（下载后自动） |
| 2026-07-16 | 从本地 Zotero 迁移（直读 `zotero.sqlite` + `storage/`；`zotero_scan` / `zotero_migrate`；可选拷 PDF） |

---

## 16. 从本地 Zotero 迁移（直读 zotero.sqlite）

> 状态：**已落地**。一键把本地 Zotero 文库迁入当前 Vault，全程本地、**不经 Translator**。

- 入口：
  1. **无 Vault 欢迎页**：与 Create / Open vault 同一行的 **Migrate from Zotero**（先创建 Vault，再打开对话框）；
  2. **论文库工具栏**（已打开 Vault 时）：图标按钮。
  共用 `ZoteroMigrateDialog`。打开时自动探测默认 `~/Zotero` 目录（否则手动选含 `zotero.sqlite` + `storage/` 的目录）；扫描预览以 chips 显示文献 / PDF / 笔记数，迁移后展示结果小结（导入 / 补笔记 / 拷 PDF / 清理）。
- Host：`zotero_scan`（只读预览：文献数 / 有本地 PDF 数）、`zotero_migrate`（执行）；实现在 `features/zotero/db.rs`。
- 读库：把 `zotero.sqlite`（含 `-wal`/`-shm`）**拷到临时目录**再只读打开（容忍 Zotero 正在运行）；查 `items`/`itemData`/`creators`/`itemTags`/`itemAttachments`，跳过 `deletedItems` 与 attachment/note/annotation 类型，并排除插件产生的 `computerProgram` 垃圾条目（如标题为 "Addon Item" 的项）。
- 映射：每条**拼装成 Zotero-API-JSON item** → 复用 `map_zotero_item` + `enrich_remote_urls` + `write_paper_shell` + `paper_record_from_meta` + catalog upsert，落到 `{parent_dir}/{id}/`（id/citekey 与魔棒 / 文件导入一致）。
- 附件 PDF URL：`map_zotero_item` 未给出 `pdf_url` 时，采用 Connector `attachments[]` 里的 PDF 链接（浏览器侧捕获，ACM/IEEE 等常仅经此暴露）。
- 中文摘要：为不超 Connector 15s 超时，壳先以原文写入；**后台**三引擎并行竞速翻译摘要，成功则安全替换 `NOTES.md` 的 `>` 摘要块（mtime 守卫，用户已编辑或 MT 全失败则跳过）。
- 标签：用户标签原样保留；Zotero 自动标签（网络翻译器加的来源/状态标签，`itemTags.type ≠ 0`）保留并加 `@zotero:` 前缀，因此在 Agentero 的标签界面中隐藏。arXiv 学科分类（`Computer Science - Machine Learning` 等）无论来自魔棒 Translator 还是 Zotero 条目，都加 `@arxiv:` 前缀，同样隐藏。旧库无 `type` 列时回退为将全部标签视为用户标签。collection 名仍作为组织标签补充。
- PDF：对话框 **“把 PDF 复制进知识库”** 勾选项（默认开）。勾选时从 `storage/<attachmentKey>/` 拷到 `{paper}/{id}.pdf` 并 liteparse `PAPER.md`；不勾则只留书目，`pdf_url` 供按需下载。
- 去重：按 arXiv id / DOI / 归一化标题跳过重复（re-run 与既有）；不同文献 citekey 相撞时目录追加后缀。**不覆盖** `NOTES.md`。开启分类建文件夹时，去重命中的旧论文若不在其分类文件夹内（如早期平铺导入），会**自动移入**并改写 catalog 路径（目标已占用则保留原位，失败自动回滚；结果含 `relocated` 计数），重迁移即收敛到 Zotero 树。
- 自愈：迁移前 `prune_missing` 清掉「文件夹已被手动删除」的 catalog 孤儿行，防止幽灵条目占位、去重误跳过导致无法重导（结果含 `pruned` 计数）。
- 分类：对话框 **“按 Zotero 分类建子文件夹”** 勾选项（**默认开**，可手动关闭）→ 迁移开始时**物化完整 collection 树**（含空分类与条目被去重的分类，目录结构与 Zotero 完全对应），条目落在 `{parent}/<collection 路径>/<id>/`，collection 名同时写入 tags（多归属不丢失）；关闭则平铺。条目在多个 collection 时取确定性的单一路径（**最深路径优先**，同深按字典序，避免父级分类吸走子级条目）。
- 选择性导入：`zotero_scan` 预览返回各 collection（含「未分类」= id 0）及条目数，并返回逐条 `items`（id/title/itemType/year/hasPdf/notes/collections）；对话框提供**搜索 + 文件夹筛选 + 逐条勾选**（`include_items` 优先于 `include_collections`，缺省 = 全部），非常规类型（webpage 等）在列表中以类型徽标标出；迁移经 Tauri Channel 回传 `{current,total}` 进度，选项记于 localStorage。
- 笔记：对话框「迁移 Zotero 笔记」勾选项（默认开）→ 每篇挂载的子笔记（`itemNotes`）HTML 经 `htmd` 转 Markdown，追加进该篇 `NOTES.md`（以 `---` 分隔）；`zotero_scan` 预览显示笔记总数。仅处理有父条目的子笔记。
- 批注：对话框「迁移 PDF 高亮批注」勾选项（默认开）→ 读 `itemAnnotations`（高亮 text + comment + 页码）转 Markdown 引用块追加进 `NOTES.md`（与笔记共用幂等追加）。**注**：阅读器运行时批注为 `marks/*.json`；Zotero 导入侧暂只把文本迁入 `NOTES.md`，不做原位 PDF 高亮还原。
- 非目标（v1）：Zotero 批注的**原位高亮渲染**（现仅迁移文本入 NOTES.md）、独立笔记（无父条目）、群组库。
| 2026-07-16 | 精读：入库/单篇 Download 后自动 paper-reader + Zap 手动；任务条 lookup/download → paperRead 衔接 |

---

## 17. Zotero 双向同步（映射层）

> 状态：**已落地**。`zotero_sync` 命令（魔棒弹层「与 Zotero 同步」按钮）：拉取 Zotero 变更 + 把 NOTES.md 推送回 Zotero。两边数据模型都不改：Vault 保持 Markdown-first、catalog 权威；Zotero 保持自己的 sqlite。

### 关联与水位（catalog schema v4）

- `papers.zotero_item_id`：Zotero itemID。迁移落库时写入；旧行在同步/重迁移时按 DOI → arXiv → 归一化标题回退匹配后回填。
- `papers.zotero_last_synced`：ISO 8601 同步水位。拉取处理完一篇即推进；推送候选用**拉取前**的水位快照选择（否则同轮拉取推进水位会掩盖所有笔记变更）。

### 拉取（只读，Zotero 运行时也安全）

- 沿用「拷 `zotero.sqlite`+WAL/SHM 到临时目录」方案（`copy_zotero_sqlite`）。
- **元数据**：仅填补空字段（year/doi/arxiv/abstract/publication/creators 等），永不覆盖已有值。
- **笔记**：只拉取**非 Agentero 标记**的子笔记（用户手写的），`htmd` 转 MD 后幂等追加进 NOTES.md。
- **批注**：`itemAnnotations` 转 MD 块幂等追加（与迁移同格式，内容级去重）。
- **冲突**：水位之后两侧都变更（Zotero 笔记 dateModified 与 NOTES.md mtime 都新于水位）→ 跳过该篇笔记拉取并计入 conflicts 列表报告，不自动合并。
- **不做**：不自动导入 Zotero 新增条目（那是迁移的职责）；Zotero 侧删除不联动删 paper。

### 推送（离线直写，Zotero 必须关闭）

- **预检**：`BEGIN IMMEDIATE` 写锁探测，SQLITE_BUSY → 报错「请先关闭 Zotero」。
- **备份**：每次推送前复制 `zotero.sqlite`（+wal/shm）到 `<zoteroDir>/agentero-backups/zotero-<时间戳>.sqlite`，保留最近 5 份。
- **标记块协议**：NOTES.md → `pulldown-cmark` 转 HTML（先净化为可读内容：剥离 YAML frontmatter、删除内部 `---`/`***`/`___` 分隔线避免 `<hr />` 泛滥（首个文本决定 Zotero 笔记标题）、清理 htmd 零宽空格、`> [!type]` callout 转加粗标签、`[[双链]]` 转纯文本），**纸壳（标题+摘要）忠实保留**——推送是 NOTES.md 的镜像，不静默丢内容；纸壳仅用于判断“无正文可推”（shell-only 不建笔记，并回收旧标记笔记），包裹 `<!-- agentero:sync paper=<id> -->…<!-- /agentero:sync -->`，并**必须**再包一层 Zotero 7 富文本笔记格式 `<div class="zotero-note znv1"><div data-schema-version="9">…</div></div>`——缺少该包装时 Zotero 会把内容当作遗留纯文本笔记：标签当文字显示、下次保存整体转义（`&lt;p&gt;`）并摧毁标记（已在真实库验证）。
- **去重与认领**：按宽松签名 `agentero:sync paper=<id>`（LIKE 通配符已转义）匹配——原始与已被转义的标记都能认领；命中多条时更新最早一条、其余移入 Zotero 回收站（`deletedItems`，可恢复）；内容与库中一致则不写入（避免每轮无谓 churn）。**永不触碰无标记的用户笔记**。
- **回流防御与自愈**：拉取/迁移跳过一切含同步签名的笔记（无论标记完整、被 Zotero 转义还是被 Markdown 转义）；拉取前先对 NOTES.md 自愈——剔除 `---` 分隔的泄漏同步块（历史版本回流造成的垃圾），frontmatter 与用户内容逐字保留。
- **事务**：整轮单事务，任一条失败整体回滚（备份可恢复）。
- **已知边界**（已对真实 Zotero 7 库验证触发器）：`items`/`itemNotes` 无写入 `syncQueue` 的触发器 → 推送的笔记**本地 Zotero 可见**，但需在 Zotero 内编辑过才会被其云同步上传。UI 推送警示中明示。彻底方案（伴生 Zotero 插件经官方 JS API 读写）为后续升级路径。

### 命令 / 事件

- `zotero_sync`（Channel 进度 `{current,total,phase}`，phase = read/pull/push）；前端 `src/lib/paper/import/zotero-sync.ts`，对话框 `zotero-sync-dialog.tsx`（选项与目录记 localStorage，`zoteroSyncDir` 设置可预设目录）。
