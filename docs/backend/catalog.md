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
- 字段以 `features/paper/catalog/schema.rs` 为准
- 时间戳统一走 `core/time.rs::now_rfc3339_millis()`（RFC 3339 毫秒 + `Z`，固定宽度）。`updated_at` 参与 SQL 字符串 `ORDER BY`，Secs/`+00:00` 变体与毫秒格式混排会排错序（`'+' < '.' < 'Z'`）；schema v7 迁移已把存量 `papers.updated_at` / `added_at`、`arxiv_rec_state.computed_at` 重写为规范格式（不可解析值原样保留，幂等）
- `tags_json`：字符串或 `{name,color}`（Apple 8 色）。`@zotero:` / `@arxiv:` 前缀为内部隐标签（Connector 来源 / arXiv 学科分类），UI 与 CLI 默认不展示
- `paper_list` 对前端 Library 返回按 `id` 去重的视图：同一逻辑论文若因历史原因出现在多个路径，只保留一条（优先存在磁盘的路径，其次 `updated_at` 最新、路径最短/字典序最小）
- `paper_rescan`：盘上有、库内无则补齐
- 删除：回收站快照；恢复 upsert
- 连接启用 WAL + `busy_timeout`，写入不阻塞列表读取；每个 Vault 维护一条常驻连接（`schema.rs::with_catalog`，进程级缓存，Mutex 串行化 `spawn_blocking` 并发），PRAGMA/迁移只在首次打开执行；数据库文件被外部删除时自动丢弃旧句柄并重建
- 连接缓存生命期：切走 / 关闭 vault 时由前端 `vault:opened` 作用域的 teardown 调 `vault_release` 驱逐（`evict_catalog_conn`）。否则一次会话中访问过的每个 Vault 都会把 SQLite 句柄与 WAL 留到进程退出。驱逐对进行中的操作安全 —— 它们持有连接的 `Arc` 克隆
- `pdf_page_counts`：PDF 页数缓存表（随移动/删除同步），阅读热力图不再整文件打开 PDF 数页；缺缓存时仅对可视行按需补数并回写
- `embed_cache` / `arxiv_rec_state`（schema v6）：广场 arXiv 推荐的摘要向量缓存与上次运行结果。前者按 sha256(title+abstract)+model 存小端 f32，使论文库语料只 embed 一次；后者单行，供页面与 `vault:opened` 预热直接读取。均不触碰 `papers` 表；规格见 [../development/plaza.md](../development/plaza.md) §3.4
- `paper_reading_activity_batch`：批量读取 `papers/<id>/marks/*.json` 侧车（highlight/ask/translate），一次 IPC 返回热力图所需最小活动点（kind/page/y/weight），替代前端逐论文 3 次 IPC 的读取风暴（`features/pdf/marks/activity.rs`）
- 重复行检测与修复：`catalog::papers::find_duplicates` / `repair_duplicates`，并在 Vault Doctor 中暴露

## 命令（摘要）

| Command | 说明 |
|---|---|
| `paper_list` / `paper_get` | 读 |
| `paper_set_tags` / `paper_set_is_read` | 写 |
| `paper_update_meta` | 手动编辑元数据（patch 语义：只更新传入字段，空串清空；置 `meta_source=manual`；改标题时向 NOTES.md aliases 追加新标题）。远程 Vault 暂不支持 |
| `paper_rescan` | 盘 → 库 |
| `paper_export` / `paper_import` | Bib 等 |
| `paper_page_counts` / `paper_set_page_counts` | 页数缓存读写 |
| `paper_reading_activity_batch` | 批量读 marks 活动点（热力图） |

CLI：`agentero paper …` / `paper tag *`。

入库如何写 catalog：[paper-import.md](paper-import.md)。  
代码：`src-tauri/src/features/paper/catalog/`；派生能力探测在 `src-tauri/src/features/paper/capabilities.rs`。
