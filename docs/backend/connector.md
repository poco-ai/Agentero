# Zotero Connector 兼容

Host 在 **`127.0.0.1:23119`** 模拟 Zotero 桌面 Connector HTTP，官方浏览器扩展无需修改。

## 行为

- 设置 → 通用：**兼容 Zotero Connector**（`connectorEnabled`，**默认关**）。
- 与 Zotero 桌面端端口互斥；端口可在设置中修改（默认 `23119`）。
- 支持 `saveItems`、目标文件夹选择、**`saveAttachment`**（浏览器上传 PDF）。
- 支持 **`saveStandaloneAttachment`**（在 PDF 标签页直接保存，无父书目条目）。
- 支持 **`hasAttachmentResolvers`** / **`saveAttachmentFromResolver`**：浏览器直连 PDF
  失败时，用 DOI/arXiv 走 Crossref + Unpaywall 再尝试 OA 副本。
- 绑定当前 Vault（本地路径或 `remote:<sessionId>`）。
- `saveItems` 只在 session 创建时记录的 Library 作用域中写 paper 壳与 catalog；Chrome
  先通过 `saveAttachment` 上传 PDF，只有浏览器未取得附件时才进入 DOI/arXiv fallback。
- 路径术语：`parent_dir` 是初始父目录；`desired_parent` 是请求父目录（该 session 最近一次
  有效的文件夹选择）；`paper_paths` / `item_map` 保存当前实际论文路径。
- Connector 保存对话框后续发送的 `updateSession` 只更新该 session 的 `desired_parent`；附件
  仍未终结时不移动，成功或失败终结后，本地 Vault 统一通过共享 `paper_move` 事务移动一次。
- `connector:item-saved` 只在初次 finalizer 得到稳定路径后发出；前端随后刷新并打开该路径，
  现有 open/reconcile 流程再按需启动 backend parser。Connector 本身不主动解析。
- Connector 返回的 Zotero 标签会以 `@zotero:` 前缀保存在 catalog 中，用于保留来源信息；
  这类内部标签不会显示在 Library、Paper Info 或标签筛选中。
- 远程：stage 后 SFTP；catalog 经 work mirror。
- PDF 保存失败会通过 `connector:progress` 报错，但仍无条件进入 finalizer，使已有 paper
  壳和资源到达 `desired_parent`。移动失败时保留 `desired_parent`；错误与回滚语义沿用共享
  `paper_move` 事务。

## 兼容端点（`127.0.0.1:23119`）

| 端点 | 状态 |
|---|---|
| `ping` | 完整 |
| `saveItems` | 完整 |
| `saveAttachment` | 完整（浏览器上传 PDF） |
| `saveStandaloneAttachment` | 完整（独立 PDF → 新建 paper；`canRecognize: false`） |
| `hasAttachmentResolvers` | 完整（DOI/arXiv 且尚无本地 PDF → true） |
| `saveAttachmentFromResolver` | 完整（Crossref/Unpaywall 下载） |
| `saveSnapshot` / `saveSingleFile` / `savePage` | 完整 |
| `getSelectedCollection` / `updateSession` / `delaySync` | 完整（须返回 `filesEditable: true`，否则扩展跳过 `saveAttachment`） |
| `detect` / `getTranslators` / `proxies` / `selectItems` | stub（空列表/透传） |
| `getRecognizedItem` / `import` / `installStyle` / Google Docs | 未实现 |

## 命令 / 事件

- `connector_get_status`：获取监听状态、端口、绑定地址、当前 Vault。
- `connector_set_enabled`：开启或关闭 Connector HTTP 服务。
- `connector_set_vault`：绑定当前目标 Vault。
- `connector_set_parent_dir`：设置默认保存父目录（如 `papers` 或 `papers/子目录`）。
- `connector_set_port`：修改监听端口（默认 `23119`）。
- 前端事件 `connector:*`（`src/lib/paper/import/connector.ts`）

## 代码

`src-tauri/src/features/connector/`  
用户教程：[../usage/zotero.md](../usage/zotero.md)
