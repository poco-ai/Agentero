# 用 MCP 连接外部 Agent

设置里打开 **MCP server** 后，ChatGPT / Codex / MCP Inspector 可以调用当前 Vault 的论文库（列表、入库、写 NOTES），不必把 MCP 暴露到公网。

应用必须开着。远端 Vault 不可用。应用内 Agent 面板走 ACP（[接入 Agent](agents.md)）；本篇是给 **外部** MCP 客户端用的。协议与工具表：[backend/mcp.md](../backend/mcp.md)。

接到 ChatGPT 时，按设置页从上到下做，不要先装客户端：

1. 打开本机 MCP（§1）
2. 获取 Runtime API key，填进设置（§2）
3. 到 Tunnels 页建立隧道，把 Tunnel ID 填进设置（§3）
4. 安装 `tunnel-client`（§4）
5. 在设置里点 **Start** 连上（§5）
6. 再到 ChatGPT 里建 connector（§6）

本机 Inspector 只需要 §1。ChatGPT 在云端，必须做完 §2–§6。用官方 **tunnel-client** 出站，不要用 ngrok 或其他临时公网隧道。

Agentero 是 **无 OAuth 的 loopback HTTP MCP**，对应 quickstart 的 sample 2（`sample_mcp_remote_no_auth`），不是 stdio、也不是 `--embedded-mcp-stub`。

## 1. 打开本机 MCP

1. 打开一个**本地** Vault。
2. **Settings → General → MCP server** 打开开关。默认地址 `http://127.0.0.1:8765/mcp`；端口旁绿点表示正在监听。

本机 Inspector、能打 loopback 的客户端到这里就可以用这个地址。后面的 API key、隧道和 client 只服务 ChatGPT。

## 2. 获取 Runtime API key

设置页隧道区第一行是 **Runtime API key**。行尾按钮打开 [API keys](https://platform.openai.com/settings/organization/api-keys)。

1. 在该页新建 **Restricted** key，勾 Tunnels **Read + Use**。不要用 All。
2. 把 key 贴进设置里的 **Runtime API key**，失焦即保存。
3. 不要把 Admin key 交给隧道进程。Admin key 只用于下面可选的命令行管理。

这是 organization 级权限，和 ChatGPT Developer mode（workspace）无关：

- 创建这把 key 的主体，以及以后用它跑隧道的人：Tunnels **Read + Use**
- 创建 / 编辑 / 删除隧道：Tunnels **Read + Manage**（下一步）
- 创建 Admin key：另需 Platform admin-key 权限

## 3. 建立 Tunnel

下一行是 **Tunnel ID**。行尾按钮打开 [Tunnels](https://platform.openai.com/settings/organization/tunnels)。

1. 在该页创建隧道，并关联**目标 ChatGPT workspace**。没关联的话，后面 Connectors 列表里看不到。
2. 复制 ID。形如 `tunnel_` + 32 位小写十六进制。
3. 贴进设置里的 **Tunnel ID**，失焦即保存。

也可以用 Admin key 在命令行建或查看（不要把这把 key 填进 Agentero）：

```bash
export OPENAI_ADMIN_KEY="sk-admin-..."
tunnel-client admin tunnels create
tunnel-client admin tunnels get tunnel_...
tunnel-client admin --json tunnels get tunnel_...   # 看 organization_ids / workspace_ids
```

`tunnel-client admin` 要等 §4 装好客户端。页面上创建不需要先装。

| 用途 | URL |
|---|---|
| Runtime API key（§2） | [API keys](https://platform.openai.com/settings/organization/api-keys) |
| 建 / 看隧道（本节） | [Tunnels](https://platform.openai.com/settings/organization/tunnels) |
| 组织角色 | [Roles](https://platform.openai.com/settings/organization/people/roles) |
| 组织组 | [Groups](https://platform.openai.com/settings/organization/people/groups) |
| Admin API keys（仅命令行 CRUD） | [Admin keys](https://platform.openai.com/settings/organization/admin-keys) |
| ChatGPT connector（§6） | [Connectors](https://chatgpt.com/#settings/Connectors) |

## 4. 安装 tunnel-client

Key 和 Tunnel ID 都进设置之后再装客户端。仓库：[openai/tunnel-client](https://github.com/openai/tunnel-client)。不要装 Homebrew 核心的 `brew install tunnel`。

macOS 推荐：

```bash
brew install openai/tools/tunnel-client
tunnel-client --version
tunnel-client help quickstart
```

其它方式：

| 来源 | 做法 |
|---|---|
| [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) | 页面下载，指向 latest |
| [GitHub Releases](https://github.com/openai/tunnel-client/releases/latest) | 选 **full client** zip（`darwin-arm64` / `darwin-amd64` / `linux-*` / `windows-*`），不要只含 `run` 的 `runtime` 包 |
| Docker | `docker pull ghcr.io/openai/tunnel-client:latest`（生产 pin tag） |
| 源码 | `make admin-ui && go build -o bin/tunnel-client ./cmd/client`，再 `./bin/tunnel-client help quickstart` |

装到 `/opt/homebrew/bin`、`/usr/local/bin` 或当前 PATH 后，设置页大约 2 秒内能发现它，不必重启 Agentero。Agentero 不会替你安装。

## 5. 在设置里连接

回到 **Settings → General → MCP server**：

1. 确认 MCP 开关仍开着（端口行绿点），§2 的 key 和 §3 的 Tunnel ID 已在输入框里。
2. 点 **Start**。按钮旁从 **Stopped** → **Starting…** → **Connected**（≤30 秒）。
3. 点 **Stop**、关掉 MCP 开关或退出 Agentero，都会停掉隧道。改 MCP 端口也会停，需要再点一次 Start。

如果按钮禁用并提示 "tunnel-client not found"，回到 §4 安装。装好后停留在这一页即可，Start 会自己恢复。

**注意**：`/readyz` 返回 200 不代表真的连上了。设置页显示 **Connected** 的依据是 `tunnel-client health --require-control-plane-poll` 成功，所以错误的 key 会显示 **Not connected**。

### 手动方式（可选）

更想自己持有进程时，在终端跑（值就是 §2 和 §3 那两个）：

```bash
export CONTROL_PLANE_API_KEY="sk-..."
export CONTROL_PLANE_TUNNEL_ID="tunnel_0123456789abcdef0123456789abcdef"

tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile agentero \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp-server-url http://127.0.0.1:8765/mcp

tunnel-client doctor --profile agentero --explain
tunnel-client run --profile agentero
```

`run` 要一直开着。关掉 Agentero、关掉 MCP 开关、或停掉 tunnel-client，ChatGPT 的发现和每次 MCP 调用都会失败。

其它官方 sample（stdio、企业代理、OAuth/DCR）见 `tunnel-client help samples`，Agentero 用不到。

## 6. 接到 ChatGPT

**只在设置页已经是 Connected 的时候** 去 ChatGPT 里建或核对 connector。

1. ChatGPT **Settings → Security and login** 打开 Developer mode。
2. [Connectors](https://chatgpt.com/#settings/Connectors)（或 [Plugins](https://chatgpt.com/plugins)）点 `+`。
3. **Connection** 选 **Tunnel**，选列表里的隧道或粘贴 §3 的 `tunnel_id`。
4. 发现 tools 后，先读 `agentero://vault` 与 `agentero://agent-invariants`，再 `paper_list`（默认只有 id/path/title）。

官方：[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

列表没有隧道：§3 关联了目标 workspace、key 有 Tunnels **Use**、Agentero 仍是 **Connected**。

## 能做什么

- `paper_list` / `paper_get` — 论文 metadata（list 默认瘦字段；`fields` / `full` 按需）
- `paper_set_read` — 标记已读/未读
- `import_id` — arXiv / DOI / URL 入库
- `paper_notes_get` / `paper_notes_write` — 读写该篇 `NOTES.md`
- `paper_tag_add` / `paper_tag_rm` — 标签
- `layout_list` / `layout_get` — 侧栏图/表/公式索引（需先在 App 跑版面分析）
- `vault_search {"query":"transformer attention","limit":10}` — 只读全库 Markdown 关键词 AND 搜索，非语义检索。返回相对 path、snippet、1-based line 和 truncated；用 `file_read {"path": hit.path}` 回读定位。不读 PDF，不服务 Remote Vault。
- `file_list` / `file_read` / `file_write` — 读改 Vault 里 `papers/` 以外的文本，例如自己的 `drafts/main.tex`。一次只列一层目录；不碰 `.agentero`、PDF 和 `NOTES.md`（笔记仍用 `paper_notes_write`）
- Resources：`agentero://vault`、`agentero://agent-invariants`、`agentero://skills/agentero-cli`

## 常见问题

| 现象 | 处理 |
|---|---|
| Agentero 没有绿点 | 先打开本地 Vault，再开 MCP 开关；端口占用则换 `mcpPort` |
| Start 按钮禁用 / 显示 "tunnel-client not found" | 按 §4 安装 `brew install openai/tools/tunnel-client`。装到 `/opt/homebrew/bin`、`/usr/local/bin` 或当前 PATH 后，设置页约 2 秒内自动恢复 Start，不必重启 |
| 绿点一直 **Starting…** / **Not connected** | 检查 §2 的 key 是否有 Tunnels **Use**、§3 的 Tunnel ID 是否正确、隧道是否关联目标 workspace；注意 `/readyz` 不能作为连通依据 |
| ChatGPT 看不到隧道 | §3 的 workspace 关联 + **Use**；connector 必须在 **Connected** 时创建 |
| 工具调用失败 | Agentero 开关、隧道 **Connected** 都要在 |
| Homebrew 装错包 | `openai/tools/tunnel-client`，不是 `tunnel` |

官方帮助：`tunnel-client help oauth`、`help plugin`、`help troubleshooting`。
