# Agentero 文档

Agentero 是一个基于 Tauri 2 + React 19 的本地优先科研工作台。

## 开始使用

- [快速上手](usage/index.md)
- [安装与首次使用](usage/getting-started.md)
- [导入和管理论文](usage/import-papers.md)
- [阅读、标注与整理](usage/read-and-organize.md)
- [接入 Agent](usage/agents.md)
- [用 MCP 连接外部 Agent](usage/mcp.md)
- [使用 Zotero Connector](usage/zotero.md)

## 按模块阅读

- [架构总览](architecture.md)：整体架构、工作台布局、核心工作流与数据流。
- [前端文档](frontend/index.md)：工作台、文件树、论文库、Markdown、PDF 与 Agent UI。
- [后端文档](backend/index.md)：Host、Vault、Catalog、使用记录、导入与 API 契约。
- [测试与发布](test/index.md)：验证策略和发布前检查。
- [开发草稿](development/index.md)：尚未实现的设计稿，以及仍要对照实现的设计记录。

## 推荐入口

- [魔棒入库与 Identifier Lookup](backend/identifier-lookup.md)
- [论文入库](backend/paper-import.md)
- [Catalog](backend/catalog.md)
- [Agent Host](backend/agent.md)
- [Dockview 工作区](frontend/workspace.md)
- [PDF 阅读与划词](frontend/pdf.md)
