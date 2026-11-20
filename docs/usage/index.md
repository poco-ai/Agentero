# Agentero 用户指南

## 从第一篇论文开始

1. [安装 Agentero，创建或打开 Vault](getting-started.md)。Vault 是保存资料的文件夹。
2. [导入论文](import-papers.md)，在 Library 中查看和管理。
3. [阅读 PDF、标注并写笔记](read-and-organize.md)。

## 连接 Agent 和其他工具

| 目标 | 指南 |
|---|---|
| 同步资料、订阅论文或写作 | [同步、发现与写作](more-features.md) |
| 连接 Claude、Codex 等 Agent | [接入 Agent](agents.md) |
| 连接 GenericAgent ACP | [接入 GenericAgent ACP](genericagent-acp.md) |
| 配置自己的翻译接口 | [OpenAI 兼容翻译](translate-openai-compatible.md) |
| 从浏览器保存论文 | [Zotero Connector](zotero.md) |
| 让外部 Agent 访问 Vault | [MCP](mcp.md) |
| 打开远程服务器上的 Vault | [远程 Vault](remote-vault.md) |
| 用 iPhone 访问桌面 Vault | [移动端](mobile.md) |

## 资料存在哪里

Vault 是普通文件夹，包含论文、PDF 和 Markdown 笔记。PDF 标注保存在论文目录的 `marks/` 中，原始 PDF 不会被标注改写。Library 的论文元数据保存在 Vault 内的 `.agentero/catalog.sqlite`。建议定期备份整个 Vault，包括这个数据库。

Agentero 通过 ACP 连接你安装并登录的 Agent，Agent 的模型密钥由对应的 Agent CLI 管理。连接方式和权限设置见[接入 Agent](agents.md)。
