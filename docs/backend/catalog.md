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
- 字段以 `crates/agentero-core/src/features/paper/catalog/schema.rs` 为准（当前 schema v13）
- **单一模型**：`papers.rs::PaperRecord` 同时是 catalog 行、`papers/<id>/metadata.json` sidecar 投影与 IPC 出参（前端 `PaperMetadata` 只是其生成类型的派生别名）。构造走 `PaperRecord::local_pdf(id, title)`（`path` 故意为空），入库管线分配到文件夹后用 `at_path(rel)` 绑定；`upsert_conn` 归一化 `\` → `/` 并**拒绝空 `path`**，避免写出 `path = ''` 主键或把 sidecar 落到 Vault 根（#181）
- **`date` / `year`**：发表时间以 `date`（TEXT）为准，精度随来源——`YYYY`、`YYYY-MM` 或 `YYYY-MM-DD`（arXiv/alphaXiv/bioRxiv 给全日期；Crossref 取 `issued`→`published-online`→`published-print` 的 date-parts，PubMed 取首个 `PubDate` 的 Year/Month/Day）。`year` 是派生列，由 `date` 的前四位重算，供引用键、树标签与既有消费者使用；`paper_update_meta` 只接受 `date`，清空它同时清空 `year`
- **字段修改事务**：`update_meta` / `set_is_read` / `set_tags` / `add_tags` / `remove_tags` 共用 `mutate_paper`，在 `BEGIN IMMEDIATE` 事务内读取当前行、应用 patch、写入并回读结果后提交。写预约先于读，既防同进程并发，也覆盖桌面与 CLI 独立连接；标签增删保留集合语义。提交后 sidecar 经持久化 pending 路径重试并保持顺序（见下文）；标题对应的 NOTES 同步仍为 best-effort。
- **sidecar 形状**：`metadata.json` = `PaperRecord` 的 pretty JSON（snake_case，`abstract` / `type` 经 serde rename）。读回时 `path` 一律取盘上位置（sidecar 随文件夹移动，内嵌值可能过期）；容忍 Connector 时代的旧文件（无 `path`、tags 为裸字符串）
- **`type` 列 = `PaperKind` 枚举**：`arxiv` / `pdf` / `html` / `doi` / `other`（全小写序列化，与前端 union 一致）。读侧归一化：历史 `'article'` → `Doi`，任何未识别值 → `Other`；**没有 schema migration**，下次 upsert 自然写回规范拼写。`From<&str>` / `FromSql` / `Deserialize` 三条读路径共用同一归一化，因此不会因脏值整行解析失败
- **`status` 列 = 导入状态**，词表 `pending` / `importing` / `completed` / `failed`；已读与否由 `is_read` 专管（不要把阅读状态写进 `status`）。当前所有生产者都写 `completed`。Rust 侧仍是 `String`，前端靠 union 窄化维持类型安全；旧库遗留的 `status = 'unread'` 行**未**在读侧 heal（对比 `'article'`），因为前端目前不 switch `status`，无实际后果
- **`citation_count`（INTEGER，模型侧 i64）**：管道已通——Crossref / OpenAlex / Semantic Scholar 都能解析并声明 `PROVIDE_CITATION_COUNT`，`api_paper_to_meta` 带进 record，`merge_api_papers` 取较大值，upsert / sidecar / 部分更新都不会丢（有测试守护）。**但常规入库路径写入的仍是 NULL**：入库以 Translator 为主，`map_zotero_item_to_record` 不产出被引数；只有 Translator 失败后降级到 Crossref 直连的 DOI 导入才会落进真实值。补齐缺口见 [../development/import-api-abstraction.md](../development/import-api-abstraction.md) §11
- **`code_repo`（TEXT，schema v9）**：论文自己的代码仓库。主 PDF 落盘时，以及之后第一次打开这篇且该列仍为空、用户也没改过时，从 PDF 解析：先首页摘要及其附近，再首页脚注（含显示文字不是 URL 的链接注释），再末页正文（参考文献标题之前）；这些都没有，才在其余正文里找带有「代码可获得」这类表述的仓库。规范成 `https://github.com/{owner}/{repo}`（`tree` / `blob` 仍算该仓库，issue / commit 等子页面置信度更低；去掉 `.git` 和句末标点；换行拆开的 URL 会接上）。参考文献条目和其他工作的仓库不写入。多个候选按位置和置信度取一个。已有值不覆盖，`meta_source` 不变。用户经 `paper_update_meta` 改过或清空后（schema v13 的 `code_repo_manual`，不进 `PaperRecord`）不再自动回填。没找到时本进程内不再重复解析。随 sidecar 投影，Paper Info 面板以 GitHub 芯片展示（值无协议前缀时展示侧补 `https://`，存储保持原样）
- **`openreview_url`（TEXT，schema v10）**：手动维护的 OpenReview 链接，经 `paper_update_meta` 设置（省略保持、空串清空），不按 DOI/arXiv 或其它 URL 自动查找或补齐。随 `PaperRecord` 和 `metadata.json` 投影传递；导入去重、元信息刷新和 Zotero 同步保留手工值。Paper Info 仅展示有效 HTTP(S) 链接，无协议前缀时展示侧补 `https://`，存储保持原样。
- **自定义属性（schema v11）**：定义存 `.agentero/properties.json`（真源）并镜像到 `custom_properties` 表；论文取值在 `papers.custom_props_json`，即 `property_id -> String`。`type` 决定取值语义：`select` 存 `option_id`（写入时校验选项属于该属性），`text` 存 trim 后的原文（≤ `TEXT_VALUE_MAX_CHARS` = 2000 字符，空值即清除）。类型创建后不可变更（`update_property` 强制保留原 `type`），未知类型在 `normalize_property_type` 直接报错，因此新增类型不需要 schema 迁移
- 时间戳统一走 `core/time.rs::now_rfc3339_millis()`（RFC 3339 毫秒 + `Z`，固定宽度）。`updated_at` 参与 SQL 字符串 `ORDER BY`，Secs/`+00:00` 变体与毫秒格式混排会排错序（`'+' < '.' < 'Z'`）；schema v7 迁移已把存量 `papers.updated_at` / `added_at`、`arxiv_rec_state.computed_at` 重写为规范格式（不可解析值原样保留，幂等）
- `tags_json`：字符串或 `{name,color}`（Apple 8 色）。`@zotero:` / `@arxiv:` 前缀为内部隐标签（Connector 来源 / arXiv 学科分类），UI 与 CLI 默认不展示。`#submitted:`（arXiv LaTeX 模板推断的投稿目标）与 `#easyscholar:`（Host 解析的期刊指标）是 Host 写入的**只读投影**，前端只展示不编辑；`publication` 是唯一权威 venue 字段，`#venue:` 已废弃并在同步时清理。**契约缺口**：`impl Serialize for PaperTag` 无色时输出裸字符串，而 specta 生成的类型是 `{ name, color }` 对象，因此前端必须保留 `PaperTagInput[]` + `coercePaperTags`
- `paper_list` 对前端 Library 返回按 `id` 去重的视图：同一逻辑论文若因历史原因出现在多个路径，只保留一条（优先存在磁盘的路径，其次 `updated_at` 最新、路径最短/字典序最小）。远端 `remote_paper_list` 不做该去重、返回裸 `PaperRecord`，为已知 wire 差异（见 [remote.md](remote.md)）
- `paper_rescan`：盘上有、库内无则补齐。论文叶子以该目录下一层的文件 `NOTES.md` 或 `metadata.json` 为准（`PAPER.md` 与 `source/`、`assets/`、`marks/`、`attachments/` 本身不是身份标记）。远端 rescan 用同一判定做 SFTP 回填（见 [remote.md](remote.md)）。`ensure_row_for_path` 补缺失行时用同一规则：已有行若 sidecar 的 `updated_at` 更新，则用 sidecar 覆盖这一行。`ensure_rows_for_paths` 把监视器路径折到单篇目录，并接受 `\\?\` 与 `/var`、`/private/var` 这两种写法；对不上单篇时才全库 rescan
- 本地/远端命令共享实现入口：`paper_get` / `paper_set_tags` / `paper_set_is_read` 的校验、错误文案与 catalog 写入与 `remote_paper_*` 对应命令共用 `src-tauri/src/features/paper/catalog/service.rs`；远端侧只补 session 解析与 `RemoteSession::push_catalog`
- **同 Vault 移动**：core `catalog/move_paper.rs::move_with_index` 统一文件移动、Wiki 改链、Catalog 与页数路径更新；后两者在同一个 SQLite 事务内提交，提交失败由既有 rename 事务补偿文件和链接。桌面/本地 Connector 经 Host `catalog/service.rs` 适配，CLI 经 `move_paper_under` 构造 Wiki 索引；业务不再放在 commands。重复移动到当前父目录统一成功返回原路径和空 `linkUpdate.updatedSources`（桌面原先报错，CLI/Connector 保持幂等）；桌面 `dirty_paths` 仍在写入前校验。跨 Vault migrate 与远端移动保持原实现。
- **同 Vault 别名**：`paper add` 在另一文件夹放下目录链接（Windows 无软链接权限时为 junction）。`rebuild_from_disk` 不把该链接当第二篇论文导入；`get_by_path` / `ensure_row_for_path` 把链接路径认回目标论文。跨 Vault 的 `paper add` 是复制，目标 Vault 另有一行，id 与源相同。
- 删除：回收站快照；恢复 upsert。`list_under_path` / `delete_under_path` / `move_under_path` 共用转义后的 SQL 子路径 pattern，`%`、`_` 与 escape 字符 `!` 按文件名的字面值匹配；保留 `/` 组件边界、Windows 分隔符归一及 SQLite 既有 LIKE 大小写规则，避免修改相似兄弟路径。
- 连接启用 WAL + `busy_timeout`，写入不阻塞列表读取；每个 Vault 维护一条常驻连接（`schema.rs::with_catalog`，进程级缓存，Mutex 串行化 `spawn_blocking` 并发），PRAGMA/迁移只在首次打开执行；数据库文件被外部删除时自动丢弃旧句柄并重建
- 连接缓存生命期：切走 / 关闭 vault 时由前端 `vault:opened` 作用域的 teardown 调 `vault_release` 驱逐（`evict_catalog_conn`）；同一 vault 被多窗口打开时按窗口持有计数，仅最后持有者离开才驱逐。否则一次会话中访问过的每个 Vault 都会把 SQLite 句柄与 WAL 留到进程退出。驱逐对进行中的操作安全 —— 它们持有连接的 `Arc` 克隆
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
| `catalog_list_properties` / `catalog_create_property` / `catalog_update_property` / `catalog_delete_property` | 自定义属性定义 CRUD（`.agentero/properties.json` + `custom_properties` 表） |
| `catalog_set_paper_property` / `catalog_create_option_and_set` / `catalog_delete_property_option` | 自定义属性取值（Select 选项原子新建并赋值、选项删除级联清理） |

CLI：`agentero paper …` / `paper tag *`。

入库如何写 catalog：[paper-import.md](paper-import.md)。  
代码：模型 / schema / sidecar 与派生能力探测在 `crates/agentero-core/src/features/paper/catalog/` 与 `crates/agentero-core/src/features/paper/capabilities.rs`；Tauri 命令层在 `src-tauri/src/features/paper/catalog/commands.rs`，本地/远端共享的命令体在 `src-tauri/src/features/paper/catalog/service.rs`（远端侧见 `src-tauri/src/integration/remote/commands.rs`）。

### Metadata 投影重试

Catalog schema v12 在论文变更的同一事务内记录 `pending_sidecars` 路径，移动时迁移路径，删除时清除。单篇写入只重试该路径；打开 Catalog 重试积压项。投影持有 SQLite IMMEDIATE 写预约，读取最新行后原子替换 `metadata.json`，成功才清记录，因此失败和进程退出不会丢失待投影状态，旧调用也不会写回捕获的旧行。升级时将已有论文加入待投影集合。

S3/WebDAV/Git 同步扫描前先 flush；已有目录的写失败或更新的外部 sidecar 会阻止同步，后者先由现有 rescan 对账。稀疏远端 work mirror 中缺少的论文目录保留 pending，但跳过本地投影，不创建目录。远端文件发布仍由 `CatalogMirror` 负责。盘上导入/同步回填不产生额外投影，避免 NOTES-only 论文在空闲同步时新增 sidecar。这里不提供跨文件事务或外部编辑器的文件锁。
