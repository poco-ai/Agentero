# MCP Server

桌面 Host 内嵌的 Streamable HTTP MCP。设置开关打开后在 loopback 监听；关掉即停。作用域是当前打开的**本地** Vault。

远端 Vault 不服务。App 必须开着。

## 开关与地址

设置 → 通用 → **MCP server**。

| 设置 | 默认 | 说明 |
|---|---|---|
| `mcpEnabled` | `false` | 启停 listener |
| `mcpPort` | `8765` | 只绑 `127.0.0.1` |
| `mcpTunnelId` | `""` | OpenAI Secure MCP Tunnel ID（`tunnel_` + 32 hex） |
| `mcpTunnelApiKey` | `""` | Runtime（Restricted）API key；回显为 mask |

监听 URL：`http://127.0.0.1:{port}/mcp`。设置页端口旁绿点表示正在听；点击 URL 复制。

Host commands：`mcp_get_status` / `mcp_set_enabled` / `mcp_set_port` / `mcp_set_vault` / `mcp_set_parent_dir`，以及隧道相关 `mcp_tunnel_status` / `mcp_tunnel_start` / `mcp_tunnel_stop`。状态事件 `mcp:status`、`mcp:tunnel-status`。

`initialize.serverInfo` 带 `title`、`websiteUrl` 和 `icons`（应用 PNG 的 data URI）。客户端可以忽略不画。

`initialize.instructions` 指向下方 resources，并强调 `paper_list` 默认瘦字段、覆盖 NOTES 前需确认。

无鉴权。不要把端口绑到非 loopback。

## ChatGPT Secure MCP Tunnel

App 开着且 MCP 开关打开后，设置区按界面顺序填写：先 **Runtime API key**，再 **Tunnel ID**，装好 `tunnel-client` 后点 **Start**。Agentero 随即 spawn 并持有 `tunnel-client run`。按钮旁绿点表示隧道已连通控制平面；**注意 `/readyz` 返回 200 不代表认证成功**，真正的 ready 信号是 `tunnel-client health --require-control-plane-poll` 的 `control_plane_poll.ok=true`。

隧道子进程随 Agentero 退出而停止（`RunEvent::Exit` 里 kill），设置区 **Stop** 与关闭 MCP 开关也会真正结束进程；宿主异常退出（崩溃、强杀）遗留的孤儿会在下次启动时按 `--profile-dir` 清扫。找不到 `tunnel-client` 时按钮禁用，并提示可复制安装命令 `brew install openai/tools/tunnel-client`，不会自动安装。该状态不是进程级缓存：`mcp_tunnel_status` 在未运行时重新 `resolve_command`，设置页在缺失期间每 2 秒拉一次状态，二进制出现后相位回到 `stopped`，不必重启应用。

Agentero 用独立 `--profile-dir`（`$XDG_CACHE_HOME/agentero/mcp-tunnel`）运行 tunnel-client，避免串到用户已有的 `~/.config/tunnel-client/*.yaml`；API key 只通过子进程 env `CONTROL_PLANE_API_KEY` 注入，不出现在命令行参数或 UI 日志。

Codex / Inspector 也可直接打 loopback URL。stdio 子进程不是这条通路。详细逐步教程见 [用 MCP 连接外部 Agent](../usage/mcp.md)。

## Resource

| URI | MIME | 内容 |
|---|---|---|
| `agentero://vault` | Markdown | 路径、schemaVersion、papers、unread |
| `agentero://agent-invariants` | Markdown | 与 CLI/`agentero-core::ops` 同源的 agent invariants |
| `agentero://skills/agentero-cli` | Markdown | 当前平台 bundled `agentero-cli` Skill 正文 |

无 Vault 时 `agentero://vault` 仍列出，`resources/read` 返回「未打开 Vault」正文。`initialize` instructions 提示先读 vault → invariants，再调用 tools。

## Tools

`ref` = paper id 或 vault 相对路径（如 `papers/1706.03762`）。禁止 `..`。

每个 tool 都声明 `outputSchema`，成功时走 MCP `structuredContent`（ChatGPT 需要这份才能理解结果）。

| Tool | 作用 |
|---|---|
| `paper_list` | 列表。**默认**每行只有 `id/path/title`（省 token）。`fields[]?` 按需加字段（`year`/`date`/`tags`/`authors`/`isRead`/…）；`full?` 恢复完整 metadata 行。另有 `query?`、`tag[]?`、`unread?`、`limit?`（默认 50，封顶 200）。abstract 只在 `paper_get`。 |
| `paper_get` | 单篇 metadata（含 abstract） |
| `paper_set_read` | 设置 catalog `isRead`（默认 true） |
| `import_id` | 魔棒入库（arxiv / DOI / URL）。`parent?` 默认当前 Library 作用域或 `papers` |
| `discover_arxiv` | 查询式发现：`keywords[]?` / `categories[]?` / `since?` / `until?` / `top?` / `maxCandidates?`，确定性词法排序，返回短名单（含 arXiv id，供后续 `import_id`）。`dedup?`（默认 true）剔除已在库的论文；无 Vault 时也可用（跳过去重）。不写 Vault |
| `paper_notes_get` | 读 `{paper}/NOTES.md`（文件不存在则空字符串） |
| `paper_notes_write` | 写 `NOTES.md`。`mode`: `replace`（默认）或 `append` |
| `paper_tag_add` | 加标签；可用 `topic:blue` 色后缀 |
| `paper_tag_rm` | 删标签 |
| `paper_text_get` | **opt-in**（#676，默认关闭）：读取论文 PDF 的分页文本。`ref` + `pages?`（1-based，缺省全篇）+ `max_chars?`（每页字符预算，默认 20000、上限 50000）。需在设置中开启 `mcpExposePaperText`，未开启时调用直接报错；开启即意味着正文文本将发送给隧道另一端的外部客户端 |
| `layout_list` | 侧栏版面索引（需 `{paper}/source/layout-index.json`）。`kind[]?`、`minScore?` |
| `layout_get` | 按 region id 取一条（如 `figure-3`） |
| `page_read` | 按**物理页**读一篇论文正文（需 `{paper}/source/layout.json`，schemaVersion 3；桌面端跑过版面分析）。`ref` 必填，`page` 为 1-based 物理页。返回该页**阅读顺序**下的全部 region，外加 `textRegions`（段落级）；`pageCount` 为布局页数，越界页返回空数组而非报错 |
| `vault_search` | 只读全库 Markdown 关键词 AND 搜索（大小写不敏感，非语义检索）。`query` 必填；`limit?` 默认 60，限制到 1–200。根目录由 Host 当前本地 Vault 决定，不接受客户端路径。返回 `hits`（相对 `path`、`snippet`、1-based `line`、`title`、`score`、可选 `paperPath`、可选 `page`）及 `truncated`；`PAPER.md` 正文命中会带上由 `source/layout.json` 映射出的 1-based 物理页码 `page`（无法唯一确定时省略）；命中用 `file_read {"path": hit.path}` 回读。可选元数据过滤 `year`（精确）、`publication` / `doi`（大小写不敏感子串）、`isRead`（bool）：一旦给出，只保留能映射到 catalog 论文且全部匹配的命中，其它一律丢弃 |
| `file_list` | 列一层目录。`path?` 为 Vault 相对路径，空则根目录。跳过 `.agentero`、隐藏目录和 LaTeX 编译产物。`limit?` 默认 200，最多 500 |
| `file_read` | 读一个 UTF-8 文本文件（如 `drafts/main.tex`、`notes/idea.md`）。不限 `papers/` |
| `file_write` | 写同一个路径。`mode`: `replace`（默认）或 `append`。父目录不存在会在 Vault 内创建。覆盖前需用户确认 |

`vault_search` 复用 Host 搜索算法，不建索引；在遍历/读取前沿用 `file_read` 的路径过滤与符号链接边界。扫描大小写不敏感的 `*.md`（含 `PAPER.md` / `NOTES.md`），跳过隐藏/系统目录、`source`、超过 2 MiB 的文件；沿用深度 16、最多 20,000 文件的扫描上限。空白 query 返回空结果。`truncated` 仅表示匹配数超过 limit，不是扫描完整性或游标分页的保证。snippet 会去除常见 Markdown 前缀、最多约 200 字符；回读后用 line 定位原行。

`vault_search` 的 `page` 与 `page_read` 都是**启发式**的：`PAPER.md` 命中行与 `layout.json` 的 `text` region 做归一化（小写 + 折叠空白）后的等式/包含匹配，只有所有匹配 region 落在**同一个** `pageIndex` 时才返回页码，否则留空——绝不返回猜测。语义检索不在 MCP 范围（由外部索引承担），这里只补"页码语义 + 结构化元数据过滤"。

复现（macOS 未 stage 打包资源时可仅为测试设置 `TAURI_CONFIG='{"bundle":{"resources":[],"macOS":{"frameworks":[]}}}'`）：

```bash
cargo test -p agentero --lib vault_search_ -- --nocapture
cargo test -p agentero --lib page_read_ -- --nocapture
cargo test -p agentero --lib features::markdown::search -- --nocapture
cargo test -p agentero-core ops::tests
cargo test -p agentero-core pdf::layout_index
```

`vault_search_protocol_round_trip_reads_fixture_hits` 使用 `test/fixtures/mcp-search` 测试资料，实际运行内存 JSON-RPC 的 initialize、tools/list、tools/call 与 file_read 回读；不启动 listener，不代表 Streamable HTTP / App UI / Tunnel 的端到端验收。

`paper_notes_write`：

- 只写 `NOTES.md`，不动 `PAPER.md` / `source/` / `marks/`
- 原子写
- `replace`：新内容没有 YAML frontmatter 时保留原 aliases 头
- `append`：追加正文，保留 frontmatter
- 编辑器有未存改动时走现有 `vault:file-changed` 冲突逻辑

`file_read` / `file_write`：

- 路径是 Vault 相对路径，禁止 `..`；符号链接解析后必须仍在 Vault 内
- 只接受 UTF-8 文本，单次最多 2 MiB。拒绝 PDF / 图片 / 压缩包等二进制扩展名，以及内容中的 NUL
- 与文件树相同，拒绝 `.agentero`、`.` 开头的隐藏项（`.agents` 除外）、`target` 等忽略目录，以及 `.aux` / `.log` 等 LaTeX 编译产物
- 不写 `NOTES.md`（仍走 `paper_notes_write`，以保留 frontmatter）、`marks/annotations.json`、`source/layout-index.json`、`source/layout.json`、`catalog.sqlite`
- 原子写。编辑器打开同一文件时走 `vault:file-changed`

不做：删除 / 回收站、`paper_paths`、mark（请用 CLI）、把 PDF 当文本读、shell、stdio MCP。

机器契约与 CLI 共用 `agentero-core::ops`；CLI 侧用 `agentero describe` 自省。

## 代码

`src-tauri/src/integration/mcp/`：`McpController` + Streamable HTTP（`rmcp`）+ tools/resource。论文工具直接调 `features::{catalog, import, vault, pdf::layout_index}`；`file_*` 只做 Vault 内 UTF-8 文本读写。

## 安全

- 仅 `127.0.0.1`；默认关
- `ref` / `parent` / `file_*` 的 `path` 消毒，解析后的真实路径必须留在 Vault 内
- 不暴露 PDF 二进制、不读 `.agentero` 与 XDG API key
