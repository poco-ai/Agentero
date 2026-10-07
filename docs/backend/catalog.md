# Catalog（`.agentero/catalog.sqlite`）

论文集合 + 结构化 metadata 的权威存储。笔记正文仍在文件。

## 与其它存储的边界

| 存储 | 内容 |
|---|---|
| Catalog | 论文行、tags、is_read、url、body 元数据等 |
| Vault 文件 | NOTES、PDF、TeX、marks、PAPER.md |
| 应用设置 | UI / Agent 注册表（**不**存论文 meta） |

根级 `PAPERS.md` / `library.bib` **默认不生成**；需要时 `paper_export` / 规划中的 `export_papers_md`。

## 要点

- 主键：论文 `path`（Vault 相对路径）
- 字段以 `crates/agentero-core/src/features/paper/catalog/schema.rs` 为准（当前 schema v7）
- **单一模型**：`papers.rs::PaperRecord` 同时是 catalog 行、`papers/<id>/metadata.json` sidecar 投影与 IPC 出参（前端 `PaperMetadata` 只是其生成类型的派生别名）。构造走 `PaperRecord::local_pdf(id, title)`（`path` 故意为空），入库管线分配到文件夹后用 `at_path(rel)` 绑定；`upsert_conn` 归一化 `\` → `/` 并**拒绝空 `path`**，避免写出 `path = ''` 主键或把 sidecar 落到 Vault 根（#181）
- **`date` / `year`**：发表时间以 `date`（TEXT）为准，精度随来源——`YYYY`、`YYYY-MM` 或 `YYYY-MM-DD`（arXiv/alphaXiv/bioRxiv 给全日期；Crossref 取 `issued`→`published-online`→`published-print` 的 date-parts，PubMed 取首个 `PubDate` 的 Year/Month/Day）。`year` 是派生列，由 `date` 的前四位重算，供引用键、树标签与既有消费者使用；`paper_update_meta` 只接受 `date`，清空它同时清空 `year`
- **字段修改事务**：`update_meta` / `set_is_read` / `set_tags` / `add_tags` / `remove_tags` 共用 `mutate_paper`，在 `BEGIN IMMEDIATE` 事务内读取当前行、应用 patch、写入并回读结果后提交。写预约先于读，既防同进程并发，也覆盖桌面与 CLI 独立连接；标签增删保留集合语义。提交后 sidecar 与标题对应的 NOTES 同步仍为 best-effort；可靠投影重试与顺序保护尚未实现（见架构计划 B1）。
- **sidecar 形状**：`metadata.json` = `PaperRecord` 的 pretty JSON（snake_case，`abstract` / `type` 经 serde rename）。读回时 `path` 一律取盘上位置（sidecar 随文件夹移动，内嵌值可能过期）；容忍 Connector 时代的旧文件（无 `path`、tags 为裸字符串）
- **`type` 列 = `PaperKind` 枚举**：`arxiv` / `pdf` / `html` / `doi` / `other`（全小写序列化，与前端 union 一致）。读侧归一化：历史 `'article'` → `Doi`，任何未识别值 → `Other`；**没有 schema migration**，下次 upsert 自然写回规范拼写。`From<&str>` / `FromSql` / `Deserialize` 三条读路径共用同一归一化，因此不会因脏值整行解析失败
- **`status` 列 = 导入状态**，词表 `pending` / `importing` / `completed` / `failed`；已读与否由 `is_read` 专管（不要把阅读状态写进 `status`）。当前所有生产者都写 `completed`。Rust 侧仍是 `String`，前端靠 union 窄化维持类型安全；旧库遗留的 `status = 'unread'` 行**未**在读侧 heal（对比 `'article'`），因为前端目前不 switch `status`，无实际后果
- **`citation_count`（INTEGER，模型侧 i64）**：管道已通——Crossref / OpenAlex / Semantic Scholar 都能解析并声明 `PROVIDE_CITATION_COUNT`，`api_paper_to_meta` 带进 record，`merge_api_papers` 取较大值，upsert / sidecar / 部分更新都不会丢（有测试守护）。**但常规入库路径写入的仍是 NULL**：入库以 Translator 为主，`map_zotero_item_to_record` 不产出被引数；只有 Translator 失败后降级到 Crossref 直连的 DOI 导入才会落进真实值。补齐缺口见 [../development/import-api-abstraction.md](../development/import-api-abstraction.md) §11
- 时间戳统一走 `core/time.rs::now_rfc3339_millis()`（RFC 3339 毫秒 + `Z`，固定宽度）。`updated_at` 参与 SQL 字符串 `ORDER BY`，Secs/`+00:00` 变体与毫秒格式混排会排错序（`'+' < '.' < 'Z'`）；schema v7 迁移已把存量 `papers.updated_at` / `added_at`、`arxiv_rec_state.computed_at` 重写为规范格式（不可解析值原样保留，幂等）
- `tags_json`：字符串或 `{name,color}`（Apple 8 色）。`@zotero:` / `@arxiv:` 前缀为内部隐标签（Connector 来源 / arXiv 学科分类），UI 与 CLI 默认不展示。`#venue:`（出版 venue，来自 `publication` 元数据）与 `#submitted:`（arXiv LaTeX 模板推断的投稿目标）是**可见**命名空间标签，正常参与展示与筛选。**契约缺口**：`impl Serialize for PaperTag` 无色时输出裸字符串，而 specta 生成的类型是 `{ name, color }` 对象，因此前端必须保留 `PaperTagInput[]` + `coercePaperTags`
- `paper_list` 对前端 Library 返回按 `id` 去重的视图：同一逻辑论文若因历史原因出现在多个路径，只保留一条（优先存在磁盘的路径，其次 `updated_at` 最新、路径最短/字典序最小）
- `paper_rescan`：盘上有、库内无则补齐
- **同 Vault 移动**：core `catalog/move_paper.rs::move_with_index` 统一文件移动、Wiki 改链、Catalog 与页数路径更新；后两者在同一个 SQLite 事务内提交，提交失败由既有 rename 事务补偿文件和链接。桌面/本地 Connector 经 Host `catalog/service.rs` 适配，CLI 经 `move_paper_under` 构造 Wiki 索引；业务不再放在 commands。重复移动到当前父目录统一成功返回原路径和空 `linkUpdate.updatedSources`（桌面原先报错，CLI/Connector 保持幂等）；桌面 `dirty_paths` 仍在写入前校验。跨 Vault migrate 与远端移动保持原实现。
- 删除：回收站快照；恢复 upsert。`list_under_path` / `delete_under_path` / `move_under_path` 共用转义后的 SQL 子路径 pattern，`%`、`_` 与 escape 字符 `!` 按文件名的字面值匹配；保留 `/` 组件边界、Windows 分隔符归一及 SQLite 既有 LIKE 大小写规则，避免修改相似兄弟路径。
- 连接启用 WAL + `busy_timeout`，写入不阻塞列表读取；每个 Vault 维护一条常驻连接（`schema.rs::with_catalog`，进程级缓存，Mutex 串行化 `spawn_blocking` 并发），PRAGMA/迁移只在首次打开执行；数据库文件被外部删除时自动丢弃旧句柄并重建
- 连接缓存生命期：切走 / 关闭 vault 时由前端 `vault:opened` 作用域的 teardown 调 `vault_release` 驱逐（`evict_catalog_conn`）。否则一次会话中访问过的每个 Vault 都会把 SQLite 句柄与 WAL 留到进程退出。驱逐对进行中的操作安全 —— 它们持有连接的 `Arc` 克隆
- `pdf_page_counts`：PDF 页数缓存表（随移动/删除同步），阅读热力图不再整文件打开 PDF 数页；缺缓存时仅对可视行按需补数并回写
- `embed_cache`（schema v6）：广场 arXiv 推荐的摘要向量缓存，按 sha256(title+abstract)+model 存小端 f32，使论文库语料只 embed 一次。
- `discovery_runs`（schema v8）：广场 arXiv 推荐的多行运行结果，按 `key = sha256(source|model|top_n|分类)` 分槽，`recommend_arxiv_last` 取最新一行。取代 v6 的单行 `arxiv_rec_state`（保留给旧库、不再写入）。均不触碰 `papers` 表；规格见 [../development/plaza.md](../development/plaza.md) §3.4
- `paper_reading_activity_batch`：批量读取 `papers/<id>/marks/*.json` 侧车（highlight/ask/translate），一次 IPC 返回热力图所需最小活动点（kind/page/y/weight），替代前端逐论文 3 次 IPC 的读取风暴（`features/pdf/marks/activity.rs`）
- 重复行检测与修复：`catalog::papers::find_duplicates` / `repair_duplicates`，并在 Vault Doctor 中暴露

## 命令（摘要）

| Command | 说明 |
|---|---|
| `paper_list` / `paper_get` | 读 |
| `paper_set_tags` / `paper_set_is_read` | 写 |
| `paper_update_meta` | 手动编辑元数据（patch 语义：只更新传入字段，空串清空；置 `meta_source=manual`；改标题时同步 NOTES.md：合并 aliases 旧+新标题，占位 H1 替换为新标题，用户自拟标题保留）。时间字段传 `date`：接受 `YYYY` / `YYYY-MM` / `YYYY-MM-DD`（兼容 `2017-06-12T00:00:00Z`、`Spring 2017` 等松散串），规范化后写回并派生 `year`；无法解析则报错。远程 Vault 暂不支持 |
| `paper_rescan` | 盘 → 库 |
| `paper_export` / `paper_import` | Bib 等 |
| `paper_page_counts` / `paper_set_page_counts` | 页数缓存读写 |
| `paper_reading_activity_batch` | 批量读 marks 活动点（热力图） |

CLI：`agentero paper …` / `paper tag *`。

入库如何写 catalog：[paper-import.md](paper-import.md)。  
代码：模型 / schema / sidecar 与派生能力探测在 `crates/agentero-core/src/features/paper/catalog/` 与 `crates/agentero-core/src/features/paper/capabilities.rs`；Tauri 命令层在 `src-tauri/src/features/paper/catalog/commands.rs`。
