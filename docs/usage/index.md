# Agentero 用户指南

面向第一次使用 Agentero 的研究者。不需要先了解 Tauri、ACP 或 Catalog；按目标选一篇即可。

## 核心工作方式

1. 用 **Vault**（普通文件夹）保存论文、PDF、Markdown 笔记和阅读标注。
2. 用 **Library** 浏览论文列表，用文件树访问原始文件。
3. 用 PDF 阅读器完成高亮、批注、提问和翻译；用 NOTES 整理阅读结果。
4. 按需连接已安装的 **Agent**（BYOA），在当前 Vault 中总结、问答或整理笔记。

## 推荐路径

| 你想做什么 | 教程 |
|---|---|
| 第一次使用 | [安装与首次使用](getting-started.md) |
| 保存 DOI / arXiv / 本地 PDF / 浏览器论文 | [导入和管理论文](import-papers.md) |
| 读 PDF、高亮、批注、写 NOTES | [阅读、标注与整理](read-and-organize.md) |
| 接 Claude / Codex 等 ACP Agent | [接入 Agent](agents.md) |
| 接 GenericAgent ACP | [接入 GenericAgent ACP](genericagent-acp.md) |
| 把 Vault 接到 ChatGPT / Codex MCP | [用 MCP 连接外部 Agent](mcp.md) |
| 用 iPhone 连接桌面 Vault | [移动端](mobile.md) |
| 用浏览器 Zotero Connector 保存 | [使用 Zotero Connector](zotero.md) |
| 打开服务器上的研究资料库 | [打开远程 Vault](remote-vault.md) |

## 三个概念

### Vault

普通文件夹。`papers/`、`NOTES.md`、PDF、`marks/` 等都在其中；离开 Agentero 仍可用编辑器、终端或 Git 访问。

### Library

根据 catalog 生成的论文列表。排序、标签与元数据来自 `.agentero/catalog.sqlite`；笔记正文以 Vault 内普通文件为准。

### Agent

Agentero **不**内置模型，也**不**托管模型 API Key。通过 ACP 连接你本机或远程服务器上已安装并登录的 Agent。权限由设置中的全局权限模式控制。

## 使用边界（当前）

- 桌面平台：macOS 12.0+；Linux 需 Ubuntu **22.04+**（webkit2gtk 4.1）。详见 [安装与首次使用](getting-started.md)。
- 远程 Vault：macOS / Linux 客户端可用；Windows 客户端暂不支持打开远程 Vault。
- Zotero Connector 与 Zotero 桌面端不能同时占用本机 `23119` 端口。
- Connector 支持保存条目与 PDF 附件；网页快照等能力未覆盖。
- PDF 标注在 `marks/` 中，不改写原始 PDF。
- 自动精读（paper-reader）默认关闭，需在设置中开启。
- 文献引用近邻图已可用（References 下方）；Connected Papers 式多跳布局与广场发现流仍在规划中。
- **Agent 接入**：支持 Claude ACP、Codex CLI（经 `codex-acp` 适配器）、OpenCode 等 ACP CLI；OpenAI Codex 桌面版、WorkBuddy 等桌面应用暂不直接支持。详见 [接入 Agent](agents.md)。

## 开发者文档

若要改代码或理解实现：

- [前端](../frontend/index.md) · [后端](../backend/index.md)
