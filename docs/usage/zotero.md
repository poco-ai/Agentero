# 使用 Zotero Connector

如果你习惯在浏览器中浏览论文，Zotero Connector 是最快的增量导入方式。Agentero 兼容官方浏览器扩展的保存协议，不需要修改扩展。

## 使用前提

需要准备：

1. 已安装 Agentero；
2. 已打开一个 Vault；
3. 已安装官方 Zotero Connector 浏览器扩展；
4. Agentero 中已开启 Connector 兼容服务。

Agentero Connector 服务默认监听本机 `127.0.0.1:23119`。它只接受本机请求，不应被配置为局域网或公网服务。

## 开启 Connector

1. 打开 Agentero 并进入目标 Vault。
2. 打开 **Settings**。
3. 在通用设置中开启 **兼容 Zotero Connector**。
4. 确认状态显示正在监听，并且绑定到了当前 Vault。

如果出现端口占用错误，请先退出 Zotero 桌面端。Zotero 桌面端和 Agentero 不能同时使用 `23119`。

## 从浏览器保存论文

1. 在浏览器打开论文页面、DOI 页面、arXiv 页面或期刊页面。
2. 点击浏览器工具栏中的 Zotero Connector 图标。
3. 在保存位置中选择 Agentero 提供的目标目录。
4. 确认保存。
5. 回到 Agentero，等待 Library 和文件树刷新。

保存时 Chrome Connector 会先使用当前浏览器登录状态取得并上传 PDF；浏览器未取得附件时，Agentero 才会尝试 DOI/arXiv OA fallback。无论附件成功或失败，已有论文内容都会在保存流程终结时落到保存对话框最后选择的目标目录；如果仍然缺少 PDF，可以在论文行上手动选择 Download。

## 保存到子文件夹

在 Connector 保存对话框中选择目标目录。Agentero 会提供 `papers/` 和符合论文组织规则的子目录；不要选择论文单元内部的 `NOTES.md`、PDF 等文件作为目标。

## Connector 与 Zotero 的分工

| 任务 | 推荐方式 |
|---|---|
| 浏览器中逐篇保存 | Connector |
| 整体迁移已有 Zotero 文库 | [从 Zotero 迁移](import-papers.md) |
| 粘贴 DOI 或 arXiv ID | 魔棒 |
| 管理完整 Zotero 数据库 | Zotero 本身 |

Connector 是增量导入入口，不会把 Agentero 变成 Zotero 的同步数据库。

## 保存后没有出现论文

按顺序检查：

1. Agentero 中是否已经打开 Vault。
2. Connector 兼容服务是否仍处于开启状态。
3. 浏览器扩展是否能探测到本机服务。
4. Zotero 桌面端是否占用了 `23119`。
5. Agentero 是否显示了错误 Toast。
6. 在 Library 中执行 Rescan。

## 当前限制

- Connector 服务仅监听本机 loopback，不要暴露到局域网或公网。
- 不能与 Zotero 桌面端同时占用 `23119`。
- 支持保存条目与 PDF 附件（含浏览器上传登录墙 PDF）；浏览器直连失败时会再尝试 OA resolver（DOI/arXiv → Crossref/Unpaywall）。
- 支持在已打开的 PDF 页面用 Connector 图标直接保存（standalone attachment）。
- 部分站点仍可能需在 Agentero 内手动 Download。
- 远程 Vault 可以使用 Connector，但必须先连接远程会话，并确认状态绑定到该 Vault。
