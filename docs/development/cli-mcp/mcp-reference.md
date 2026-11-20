# Agentero MCP 工具契约（设计稿）

本服务供外部客户端访问经授权的 Vault。具备 shell 的桌面 Agent 调用 CLI；桌面侧栏和 Zen 使用相同的绑定机制，每个回合独立授权。MCP 的每项数据操作都对应一个可执行的 CLI 业务入口。工具选择依据是外部客户端要完成哪项研究任务。终端输出、窗口焦点、标准输入和服务器启动都是宿主职责。

## 发现与调用

- `tools/list` 的完整候选集合见共享的 [MCP manifest](../../../crates/agentero-core/src/ops/mcp.json)。每个工具都有真实的 JSON Schema，列明类型、必填项、默认值、范围、输入形状、结果字段和行为注解。下表的星号表示无条件必填；条件必填及跨字段约束查看 schema 和对应 CLI 的行为。HTTP 与 stdio 共享同一套名称、DTO、错误和授权判断。
- 有 Vault 的工具接受可选 `vault`，值取自 `vault_list` 返回的 ID。连接只绑一个默认库时可省略；多库未设默认时返回 `vault_required` 和可见库 ID。MCP 不接受服务进程的任意绝对路径。`to_vault` 同样按授权 ID 解析，两端分别校验。
- 默认发布本库的查询工具，可返回题录、普通笔记、已开放的 Vault 文档、表格和有长度限制的证据摘录。`--allow full-text` 开放论文正文的连续读取、物理页、版面全文及包含正文的结构化区域。`--allow write` 增加写工具。`--allow online` 增加可主动发起网络请求的工具。导入标识需要 write + online；`annotation_add` 的机器翻译分支另需 online，传人工译文可离线。`paper_discover` 需 online，公开的 profile 由管理员预配置。每次实际调用复核授权。
- 论文的 TeX、PAPER.md、PDF、副本引用、布局缓存和穿过目录链接的路径都按最终资源归属授权。search 默认仅返回有界片段；未授予全文时，整页、区域原文、续读拼接与直接读资产路径受相同的正文预算约束。只读模式中的 `paper_regions` 可列区域元数据。私有管理目录及系统凭据不进入文件 API。服务只返回当前调用者可见的关系目标、路径和引用。
- 输入的一般拼写是 CLI 的 `--if-revision` 对应 MCP 的 `if_revision`。批注的 `--mark-color` 对应 `color`。MCP 的 `content` 直接传 Markdown/UTF-8 字符串，二进制写入使用标准 Base64（解码后最多 2 MiB）。表格直接传 `rows` 或 `cells`。追加、创建批注和表格写入需要调用者显式给出 request_id 以便重放。服务不会从客户端给出的本机文件名或 stdin 读取写入内容。
- `tools/call` 成功时在 `structuredContent` 返回工具的 outputSchema 对象，并给出对应文本内容。参数或协议分派问题按协商的 MCP 规范处理；业务失败返回 `isError: true`，文本内容含下文的领域错误 JSON，客户端可据此重试或换目标。失败内容独立于成功结果 schema。本稿采用 2026-07-28 版协议，每次请求在 _meta 声明版本，HTTP 同时发送 MCP-Protocol-Version 头；服务端逐次校验版本。[MCP 版本规则](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- `readOnlyHint`、`destructiveHint` 和 `openWorldHint` 描述行为，由服务端独立执行授权。`agentero://guide` 提供只读的 ID、引用和预算说明；`resources/read` 查看该指南，科研数据查询走下表的工具，`resources/list` 不枚举论文正文。桌面自带的会话授权及 SSH 凭据均不经 resources 公开。

### 相同研究操作的两种调用方式

| 用户意图 | CLI | MCP 工具参数 |
|---|---|---|
| 展开一次命中 | `read "$cite"` 或 `read -` 读取管道中的单个引用 | `evidence_read` 收到 `{"source":"agentero://cite/lab/8f"}` |
| 核对三个物理页 | `read papers/atlas --page 2-3,8` | `evidence_read` 收到 `{"source":"papers/atlas","pages":[2,3,8]}` |
| 找出最相关的出处 | `search "batch size" --limit 1 --plain` | `evidence_search` 返回的 `items[0].cite` 可直接交给下一次调用 |

页码在 CLI 边界解析为正整数、展开范围、去重、排序，倒序区间或展开超过 200 个不同页时直接报错。MCP 以最多 200 个不重复的正整数表示同一选择。两个适配器都在开始读取前校验全文授权和页码边界。`--plain`、stdin 及终端颜色只影响 CLI 呈现，MCP 始终返回结构化业务结果。

## 完整工具表

| 工具 | CLI | 业务输入 | 成功结果 | 发布所需能力 |
|---|---|---|---|---|
| `evidence_search` | `search` | `query*`、`in`、`kind`、`tag`、`match`、`limit`、`cursor` | Sources | 读 |
| `evidence_read` | `read` | `source*`、`part`、`pages`、`section`、`region`、`quote`、`lines`、`max_chars`、`cursor` | Passage | 读 |
| `paper_list` | `paper list` | `query`、`tag`、`state`、`status`、`include_internal`、`sort`、`limit`、`cursor` | Papers | 读 |
| `paper_get` | `paper get` | `paper*`、`include_internal` | PaperDetail | 读 |
| `paper_update` | `paper update` | `paper*`、`title`、`author`、`venue`、`date`、`doi`、`arxiv`、`state`、`status`、`clear`、`if_revision*` | PaperDetail | write |
| `paper_discover` | `paper discover` | `keyword`、`category`、`match`、`since`、`until`、`limit`、`candidates`、`include_known`、`rank`、`embedding_profile`、`semantic_weight` | Candidates | 读 + online |
| `paper_import` | `paper import id` | `identifier*`、`into` | Import | write + online |
| `paper_regions` | `paper regions` | `paper*`、`kind`、`page`、`min_score`、`limit`、`cursor` | Regions | 读 |
| `paper_relations` | `paper relations` | `paper*`、`direction`、`local_only`、`limit`、`cursor` | Relations | 读 |
| `paper_tag_list` | `paper tag list` | `include_internal`、`limit`、`cursor` | Tags | 读 |
| `paper_tag_add` | `paper tag add` | `paper*`、`tags*` | PaperDetail | write |
| `paper_tag_remove` | `paper tag remove` | `paper*`、`tags*` | PaperDetail | write |
| `paper_tag_set` | `paper tag set` | `paper*`、`tags`、`clear`、`if_revision*` | PaperDetail | write |
| `paper_note_append` | `paper note append` | `paper*`、`request_id*`、`content*` | DocChange | write |
| `paper_note_replace` | `paper note replace` | `paper*`、`if_revision*`、`content*` | DocChange | write |
| `file_list` | `file list` | `path`、`hidden`、`limit`、`cursor` | Files | 读 |
| `file_write` | `file write` | `path*`、`mode`、`encoding`、`if_revision`、`request_id`、`content*` | DocChange | write |
| `file_move` | `file move` | `source*`、`destination*`、`to_vault`、`dry_run` | Receipt | write |
| `file_remove` | `file remove` | `paths*`、`dry_run` | TrashChange | write |
| `trash_list` | `file trash list` | `limit`、`cursor` | TrashItems | 读 |
| `trash_restore` | `file trash restore` | `id*` | Receipt | write |
| `annotation_list` | `annotation list` | `paper*`、`kind`、`page`、`limit`、`cursor` | Marks | 读 |
| `annotation_get` | `annotation get` | `paper*`、`id*` | Mark | 读 |
| `annotation_add` | `annotation add` | `paper*`、`cite`、`quote`、`region`、`page`、`occurrence`、`all_matches`、`kind`、`comment`、`question`、`color`、`language`、`translation`、`request_id*` | Marks | write |
| `annotation_update` | `annotation update` | `paper*`、`id*`、`comment`、`color`、`if_revision*` | Mark | write |
| `annotation_remove` | `annotation remove` | `paper*`、`id*`、`if_revision*` | Receipt | write |
| `table_query` | `table query` | `path*`、`row`、`field`、`equals`、`archived`、`limit`、`cursor` | Rows | 读 |
| `table_upsert` | `table upsert` | `path*`、`if_revision*`、`request_id*`、`rows*` | TableChange | write |
| `table_patch` | `table patch` | `path*`、`if_revision*`、`request_id*`、`cells*` | TableChange | write |
| `vault_list` | `vault list` | 无 | Vaults | 读 |

## 两个实际调用

搜索命中中的 `cite` 可以逐字交给 `evidence_read`。下面是 `tools/call` 的业务参数与成功数据节选，省略传输层字段。`agentero://cite/lab/8f`、`r7` 是示例值。

```json
{"name":"evidence_search","arguments":{"query":"batch size","in":["papers/atlas"],"kind":["body"],"limit":3}}
```

```json
{"items":[{"source":"papers/atlas","kind":"body","locator":{"page":8},"revision":"r7","excerpt":"We use a batch size of 64.","cite":"agentero://cite/lab/8f"}],"next_cursor":null}
```

```json
{"name":"evidence_read","arguments":{"source":"agentero://cite/lab/8f","max_chars":1800}}
```

一次表格更新先用 `table_query` 读出 `revision`，再提交条件写入。只有首次成功后响应丢失才用原请求 ID 原样重放。若别人已经修改了表，重新查询和计算后的新写入使用新 ID。

```json
{"name":"table_patch","arguments":{"path":"experiments/results.table.json","if_revision":"5","request_id":"fix-21","cells":[{"id":"trial-0003","field":"split","value":"test"}]}}
```

成功回执形如 `{"path":"experiments/results.table.json","revision":"6","changed_rows":["trial-0003"],"changed_cells":1}`。版本冲突的错误形如 `{"error":{"code":"revision_conflict","message":"表格已被更新","details":{"expected":"5","actual":"6"},"hint":"重新查询目标行后提交"}}`。

## 只在 CLI 和相应宿主提供的能力

| 类别 | 完整范围及原因 |
|---|---|
| 本机身份与维护 | `vault create/info/check/repair`、`file trash purge`、`sync` 全组。涉及文件系统、永久清除、本机连接或凭据。外部客户端可以将条目移入回收站、查看并恢复。 |
| 本机文件及提供方 | `paper import pdf/bib`、`paper export/download/extract/analyze/link/copy`、`paper note fetch`、`translate`、`feed` 全组。涉及本机路径、个人订阅、批处理或显式选择服务。MCP 可按标识入库、查询分析结果、移动库内文件及论文。 |
| 桌面或运行时 | `app`、`delegate`、`mcp`、`help`。桌面操控、远端任务、服务本身以及 CLI 自省各有明确调用者。外部客户端用协议发现工具。 |

## 输出类型速查

CLI `--json` 的具体顶层字段如下。MCP 公开的结果以 JSON 文件内的嵌套 outputSchema 为准，分页查询用 `items` 和 `next_cursor`。`Candidates` 为单次在线排序的 shortlist，`limit` 是截断上限。`Server` 描述启动元数据，stdio 的 stdout 保留给协议帧。

- **Artifacts**　`items`
- **Assets**　`paper`、`assets`
- **Candidates**　`items`
- **DocChange**　`path`、`revision`、`bytes`
- **Export**　`format`、`content`、`path`、`count`
- **Feed**　`id`、`title`、`url`
- **FeedItems**　`items`、`next_cursor`
- **FeedRefresh**　`items`
- **Feeds**　`items`、`next_cursor`
- **Files**　`items`、`next_cursor`
- **Health**　`ok`、`findings`
- **Help**　当前命令的结构化帮助树
- **Import**　`items`
- **Job**　`id`、`state`、`result`
- **Mark**　`id`、`paper`、`kind`、`cite`、`locator`、`revision`、`comment`、`color`、`question`、`translation`
- **Marks**　`items`、`next_cursor`
- **PaperDetail**　`id`、`path`、`title`、`state`、`tags`、`revision`、`authors`、`venue`、`date`、`doi`、`arxiv`、`status`、`abstract`、`assets`
- **Papers**　`items`、`next_cursor`
- **Passage**　`source`、`revision`、`text`、`evidence`、`entries`、`regions`、`metadata`、`next_cursor`、`truncated`
- **Receipt**　`changed`、`items`、`preview`
- **Regions**　`items`、`next_cursor`
- **Relations**　`items`、`next_cursor`、`coverage`、`cache_state`
- **Repair**　`applied`、`items`
- **Rows**　`revision`、`columns`、`items`、`next_cursor`
- **Server**　`transport`、`address`
- **Sources**　`items`、`next_cursor`
- **SyncRun**　`uploaded`、`downloaded`、`conflicts`、`errors`
- **SyncState**　`backend`、`location`、`last_run`
- **SyncTest**　`ok`、`checks`
- **TableChange**　`path`、`revision`、`changed_rows`、`changed_cells`
- **Tags**　`items`、`next_cursor`
- **Targets**　`items`
- **Tools**　`tools`
- **Translation**　`text`、`from`、`to`
- **TrashChange**　`items`、`preview`
- **TrashItems**　`items`、`next_cursor`
- **Vault**　`id`、`name`、`current`、`path`、`catalog_state`、`paper_count`、`outcome`
- **Vaults**　`items`
- **View**　`view`、`window`、`path`
- **Views**　`items`
- **Window**　`window`
