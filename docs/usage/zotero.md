# 使用 Zotero Connector

通过官方 Zotero Connector 浏览器扩展，可以把浏览器中的论文逐篇保存到 Agentero。迁移已有 Zotero 文库请参阅[导入和管理论文](import-papers.md)。

## 开启服务

1. 安装官方 Zotero Connector 扩展，在 Agentero 中打开目标 Vault。
2. 进入 **设置 → 通用**，开启 **兼容 Zotero Connector**，确认服务正在监听并绑定到目标 Vault。
3. 如果提示端口占用，退出 Zotero 桌面端后重试：它与 Agentero 不能同时占用本机 `23119` 端口。

服务只监听本机，不应暴露到局域网或公网。远程 Vault 需先连接远程会话，并确认服务绑定到该 Vault。

## 保存论文

1. 在浏览器打开论文、DOI、arXiv、期刊页面或 PDF。
2. 点击 Zotero Connector 图标，在保存对话框中选择 `papers/` 或合适的子文件夹。
3. 回到 Agentero，等待 Library 和文件树刷新。

Connector 支持保存条目和 PDF 附件。Chrome 扩展会先尝试利用浏览器的登录状态获取 PDF；未取得附件时，Agentero 会尝试通过 DOI 或 arXiv 查找开放版本。若仍缺少 PDF，可在论文行手动选择 Download。Connector 是增量导入入口，不会把 Agentero 变成 Zotero 的同步数据库。

## 没有看到论文

确认 Vault 已打开、Connector 服务仍在监听，且 Zotero 桌面端没有占用端口。检查 Agentero 是否显示错误提示，然后右键文件树的 `papers/`，选择 **重新扫描 papers/**。
