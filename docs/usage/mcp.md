# 用 MCP 连接外部 Agent

开启 MCP server 后，外部 MCP 客户端可以查询本地 Vault 的论文、笔记、批注和研究表格。应用内 Agent 面板使用 ACP，配置方法见[接入 Agent](agents.md)。

桌面 MCP 需要 Agentero 保持运行并打开本地 Vault，不支持远程 Vault。无桌面环境可以使用文末的 CLI 服务。

## 开启本机服务

1. 打开本地 Vault，进入 **设置 → 通用 → MCP server** 并开启服务。
2. 端口旁出现绿点后，本机客户端可连接 `http://127.0.0.1:8765/mcp`（默认端口）。
3. 客户端需要设置 `Authorization: Bearer <token>`；token 保存在 Agentero 配置目录的 `mcp.token`。

服务默认提供查询工具。可在设置中分别允许修改 Vault、联网和读取论文全文；本机 MCP 和连接的 Tunnel 共用这些权限设置，每次调用都会检查。使用 `vault_list` 查看可访问的库，再选择要查询的 Vault。

## 连接 ChatGPT

ChatGPT 在云端，需要通过 [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 连接本机服务。按以下顺序设置：

1. 在 [API keys](https://platform.openai.com/settings/organization/api-keys) 创建 Restricted Runtime API key，授予 Tunnels **Read + Use**，填入 Agentero MCP 设置。不要在这里使用 Admin key。
2. 在 [Tunnels](https://platform.openai.com/settings/organization/tunnels) 创建隧道，关联目标 ChatGPT workspace，复制 Tunnel ID 并填入设置。
3. 安装 [tunnel-client](https://github.com/openai/tunnel-client)。macOS 可以使用：

   ```bash
   brew install openai/tools/tunnel-client
   ```

   其他平台可从 [Releases](https://github.com/openai/tunnel-client/releases/latest) 下载 full client。Agentero 不会自动安装它。
4. 返回 MCP 设置，确认服务已开启，点击 **Start**，等待状态变为 **Connected**。
5. 在 ChatGPT 设置中开启 Developer mode，在 [Connectors](https://chatgpt.com/#settings/Connectors) 添加连接，选择 Tunnel 和刚创建的隧道。

客户端连接后，可先读取 `agentero://guide`，使用 `vault_list` 查看库，再用 `paper_list` 查询论文。工具的完整说明见 [MCP 工具文档](../backend/mcp.md)。关闭 MCP、停止 Tunnel 或退出 Agentero 后，连接不可用。

### 连接失败

- **没有监听绿点**：确认已打开本地 Vault；端口被占用时更换端口。
- **找不到 tunnel-client**：确认已安装完整客户端并位于 PATH、`/opt/homebrew/bin` 或 `/usr/local/bin`。设置页会自动重新探测。
- **无法 Connected 或 ChatGPT 看不到隧道**：检查 Runtime key 的 Tunnels 权限、Tunnel ID 和 workspace 关联。只有设置页显示 **Connected** 时才建立或检查 ChatGPT 连接；`/readyz` 返回 200 不代表控制面已连接。

## 无桌面服务器

在文献库所在机器上通过 stdio 启动：

```sh
agentero mcp serve --vault /path/to/vault
```

也可用 `--transport http --listen 127.0.0.1:8765` 启动带 bearer 凭据的本机 HTTP 服务。按需重复添加 `--allow write`、`--allow online`、`--allow full-text`；使用相同授权参数运行 `agentero mcp tools --json` 可查看工具目录。
