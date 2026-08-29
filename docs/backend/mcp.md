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

无鉴权。不要把端口绑到非 loopback。

## ChatGPT Secure MCP Tunnel

App 开着且 MCP 开关打开后，可在同一设置区填写 Tunnel ID 与 Runtime API key，点 **Start** 让 Agentero 直接 spawn 并持有 `tunnel-client run`。按钮旁绿点表示隧道已连通控制平面；**注意 `/readyz` 返回 200 不代表认证成功**，真正的 ready 信号是 `tunnel-client health --require-control-plane-poll` 的 `control_plane_poll.ok=true`。

隧道子进程随 Agentero 退出而停止（`RunEvent::Exit` 里 kill）。找不到 `tunnel-client` 时按钮禁用，并提示可复制安装命令 `brew install openai/tools/tunnel-client`，不会自动安装。

Agentero 用独立 `--profile-dir`（`$XDG_CACHE_HOME/agentero/mcp-tunnel`）运行 tunnel-client，避免串到用户已有的 `~/.config/tunnel-client/*.yaml`；API key 只通过子进程 env `CONTROL_PLANE_API_KEY` 注入，不出现在命令行参数或 UI 日志。

Codex / Inspector 也可直接打 loopback URL。stdio 子进程不是这条通路。详细逐步教程见 [用 MCP 连接外部 Agent](../usage/mcp.md)。

## Resource

Vault 概况不是 tool，是文档：

| URI | MIME | 内容 |
|---|---|---|
| `agentero://vault` | Markdown | 路径、schemaVersion、papers、unread |

无 Vault 时 resource 仍列出，`resources/read` 返回「未打开 Vault」正文。`initialize` instructions 提示先读这份文档，再 `paper_list` / `paper_get`。

## Tools

`ref` = paper id 或 vault 相对路径（如 `papers/1706.03762`）。禁止 `..`。

| Tool | 作用 |
|---|---|
| `paper_list` | 列表 metadata：`{ items: [{ id, path, title, authors, year, tags, doi, arxivId, publication, status, isRead }] }`。`query?`、`tag[]?`、`unread?`、`limit?`（默认 50，封顶 200）。abstract 只在 `paper_get`。 |
| `paper_get` | 单篇 metadata（含 abstract） |

每个 tool 都声明 `outputSchema`，成功时走 MCP `structuredContent`（ChatGPT 需要这份才能理解结果）。
| `import_id` | 魔棒入库（arxiv / DOI / URL）。`parent?` 默认当前 Library 作用域或 `papers` |
| `paper_notes_get` | 读 `{paper}/NOTES.md`（文件不存在则空字符串） |
| `paper_notes_write` | 写 `NOTES.md`。`mode`: `replace`（默认）或 `append` |
| `paper_tag_add` | 加标签；可用 `topic:blue` 色后缀 |
| `paper_tag_rm` | 删标签 |

`paper_notes_write`：

- 只写 `NOTES.md`，不动 `PAPER.md` / `source/` / `marks/`
- 原子写
- `replace`：新内容没有 YAML frontmatter 时保留原 aliases 头
- `append`：追加正文，保留 frontmatter
- 编辑器有未存改动时走现有 `vault:file-changed` 冲突逻辑

不做：`vault_info` tool、通用读文件、`paper_paths`、delete/trash、mark/layout、shell。

## 代码

`src-tauri/src/features/mcp/`：`McpController` + Streamable HTTP（`rmcp`）+ tools/resource。直接调 `features::{catalog, import, vault}`。

## 安全

- 仅 `127.0.0.1`；默认关
- `ref` / `parent` 消毒
- 不暴露 PDF 二进制、不读 XDG API key
