# 用 MCP 连接外部 Agent

设置里打开 **MCP server** 后，ChatGPT / Codex / MCP Inspector 可以调用当前 Vault 的论文库（列表、入库、写 NOTES），不必把 MCP 暴露到公网。

应用必须开着。远端 Vault 不可用。应用内 Agent 面板走 ACP（[接入 Agent](agents.md)）；本篇是给 **外部** MCP 客户端用的。

把本机 MCP 接到 ChatGPT / Codex，用官方 **tunnel-client** 出站隧道，不要用 ngrok 或其他临时公网隧道。装好后先跑 `tunnel-client help quickstart`。协议与工具表：[backend/mcp.md](../backend/mcp.md)。

## 1. 打开 Agentero MCP 与隧道

1. 打开一个**本地** Vault。
2. **Settings → General → MCP server** 打开开关。默认地址 `http://127.0.0.1:8765/mcp`；端口旁绿点表示正在监听。
3. 在同一设置区填写 **Runtime API key** 和 **Tunnel ID**（见 §2-3 获取），然后点 **Start**。
4. 按钮旁绿点变 **Connected** 后，去 ChatGPT 建 connector（§5）。

本机 Inspector、能打 loopback 的客户端可以直接用 `http://127.0.0.1:8765/mcp`。ChatGPT 在云端，需要 tunnel-client。

Agentero 是 **无 OAuth 的 loopback HTTP MCP**，对应 quickstart 的 sample 2（`sample_mcp_remote_no_auth`），不是 stdio、也不是 `--embedded-mcp-stub`。

## 2. 安装 tunnel-client

仓库：[openai/tunnel-client](https://github.com/openai/tunnel-client)。不要装 Homebrew 核心的 `brew install tunnel`。

PATH 上已有二进制：

```bash
tunnel-client help quickstart
```

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

## 3. 官方设置页和三个值

| 用途 | URL |
|---|---|
| 建 / 看隧道 | [Tunnels](https://platform.openai.com/settings/organization/tunnels) |
| 组织角色 | [Roles](https://platform.openai.com/settings/organization/people/roles) |
| 组织组 | [Groups](https://platform.openai.com/settings/organization/people/groups) |
| **Runtime API keys**（daemon 用） | [API keys](https://platform.openai.com/settings/organization/api-keys) |
| Admin API keys（仅 CRUD 隧道） | [Admin keys](https://platform.openai.com/settings/organization/admin-keys) |
| ChatGPT connector | [Connectors](https://chatgpt.com/#settings/Connectors) |

| 变量 | 从哪来 | 给谁 |
|---|---|---|
| `CONTROL_PLANE_TUNNEL_ID` | Tunnels 页创建/查看，或 `tunnel-client admin tunnels create\|list\|get`（要 `OPENAI_ADMIN_KEY`） | `init` / `run` |
| `CONTROL_PLANE_API_KEY` | **Runtime API keys** 页新建 Restricted key | `doctor` / `run` |
| `OPENAI_ADMIN_KEY` | Admin API keys | 仅 `admin tunnels list\|create\|update\|delete`，**不要**给长期 daemon |

`tunnel_id` 形如 `tunnel_` + 32 位小写十六进制。

Runtime key：在 [API keys](https://platform.openai.com/settings/organization/api-keys) 建 **Restricted**，勾 Tunnels **Read + Use**。不要用 All，不要把 Admin key 交给 `tunnel-client run`。

权限是 organization 级，和 ChatGPT Developer mode（workspace）无关：

- Runtime 用户、以及创建 `CONTROL_PLANE_API_KEY` 的主体：Tunnels **Read + Use**
- 创建/编辑/删除隧道：Tunnels **Read + Manage**
- 创建 Admin key：另需 Platform admin-key 权限

隧道要关联**目标 ChatGPT workspace**，否则 Connectors 列表里看不到。

只读隧道元数据（Runtime 或 Admin key 均可）：

```bash
tunnel-client admin tunnels get tunnel_...
tunnel-client admin --json tunnels get tunnel_...   # 看 organization_ids / workspace_ids
```

## 4. 接到 Agentero

在 **Settings → General → MCP server** 里：

1. 确认 MCP 开关已打开（端口行绿点）。
2. 填入 §3 获取的 **Runtime API key** 和 **Tunnel ID**。
3. 点 **Start**。按钮旁状态从 **Stopped** → **Starting…** → **Connected**（≤30 秒）。
4. 点 **Stop** 或退出 Agentero 都会停掉隧道；改 MCP 端口时也会自动停隧道，需要再点一次 Start。

如果按钮禁用并提示 "tunnel-client not found"，先安装（§2），然后重新打开 Settings 页即可。

**注意**：`/readyz` 返回 200 不代表真的连上了；设置页显示 **Connected** 的依据是 `tunnel-client health --require-control-plane-poll` 成功，所以 bogus key 会显示 **Not connected**。

### 手动方式（可选）

如果你更喜欢自己持有 tunnel-client 进程，可以在终端里跑：

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

## 5. 接到 ChatGPT

**只在 tunnel-client 正在跑的时候** 去 ChatGPT 里建或核对 connector。

1. ChatGPT **Settings → Security and login** 打开 Developer mode。
2. [Connectors](https://chatgpt.com/#settings/Connectors)（或 [Plugins](https://chatgpt.com/plugins)）点 `+`。
3. **Connection** 选 **Tunnel**，选列表里的隧道或粘贴 `tunnel_id`。
4. 发现 tools 后，先读资源 `agentero://vault`，再 `paper_list`。

官方：[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

列表没有隧道：关联了目标 workspace、有 Tunnels **Use**、`/readyz` 为 200。

## 能做什么

- `paper_list` / `paper_get` — 论文 metadata
- `import_id` — arXiv / DOI / URL 入库
- `paper_notes_get` / `paper_notes_write` — 读写该篇 `NOTES.md`
- `paper_tag_add` / `paper_tag_rm` — 标签

## 常见问题

| 现象 | 处理 |
|---|---|
| Agentero 没有绿点 | 先打开本地 Vault，再开 MCP 开关；端口占用则换 `mcpPort` |
| Start 按钮禁用 / 显示 "tunnel-client not found" | 按提示安装 `brew install openai/tools/tunnel-client`，重新打开 Settings |
| 绿点一直 **Starting…** / **Not connected** | 检查 Runtime API key 是否有 Tunnels **Use**、Tunnel ID 是否正确、隧道是否关联目标 workspace；注意 `/readyz` 不能作为连通依据 |
| ChatGPT 看不到隧道 | workspace 关联 + **Use**；connector 必须在 `Connected` 时创建 |
| 工具调用失败 | Agentero 开关、隧道 **Connected** 都要在 |
| Homebrew 装错包 | `openai/tools/tunnel-client`，不是 `tunnel` |

官方帮助：`tunnel-client help oauth`、`help plugin`、`help troubleshooting`。
