# 远程 Vault（SSH/SFTP）

文件权威在服务器；本机 UI + 可选远端 BYOA。

## 能力

| 层 | 说明 |
|---|---|
| 连接 | `remote_connect` / `disconnect`；密钥或 SSH agent；`remote_ssh_config_hosts` 解析 `~/.ssh/config` 供对话框联想 |
| 文件 | SFTP list/read/write/mkdir/remove/bytes |
| Catalog | work mirror（本机查询，写回远端） |
| PDF | blob 缓存（`remote_cache_*`） |
| Agent | ACP over SSH：`remote_agent_probe` / scan / 与 `agent_run_once` 集成（命令实现属 agent 域 `features/agent/commands/remote.rs`，经反转 trait `agent::remote_host::{RemoteAgentHosts, RemoteAgentLaunch}` 复用 remote 域的 SSH session/exec）。本机 Agent 还可通过 `agentero-delegate` 把任务交到这条已经连上的会话，SSH 目标与 SFTP 相同 |
| 入库 / 回收站 | 远端写路径与 trash bridge。回收站的资格、manifest 与 batch id 校验在 core `plan_trash`，bridge 只做 `VaultFs` 移动和既有 `cat.push`。features 命令经反转 trait `import::RemoteImportOps` / `trash::remote_ops::RemoteTrashOps` 调用（`integration::remote` 实现并在 app 启动时注册为 State） |
| Connector | 可绑定 `remote:<sessionId>` |

前端伪路径 `remote:<sessionId>`（解析在 `core/remote.rs`，纯字符串工具，features/integration 共用）。客户端：**macOS / Linux**（Windows 客户端暂不支持打开远程 Vault）。

## Catalog 发布

连接与 `remote_paper_list` 通过 SSH 调用服务器的 `python3` 标准库 `sqlite3`，只读执行 `VACUUM INTO`，读取包含已提交 WAL 内容的一致快照。服务器需提供 `python3` 及 `sqlite3` 模块；失败时不回退到裸读主文件。

重新加载论文列表（含手动刷新）通过 SQLite backup API 更新 work mirror，与现有 Catalog 操作共用连接锁；单篇查询继续读取本机镜像。未发布的本机修改不会被刷新覆盖，只读断开不发布。远端非空 WAL 尚在时拒绝替换主库，需关闭远端数据库连接后重新打开 Vault；仍按单写者使用。

本机 work mirror 开启 WAL。初始化远端 Catalog 与每次 push 都通过 SQLite `VACUUM INTO` 导出独立一致快照，读取已提交的主库与 WAL 内容；其他写连接保持打开或存在未提交事务时也不依赖连接关闭/checkpoint。临时快照在成功或失败后自动清理，导出失败不上传。

发布仍先检查远端 size/mtime 是否与上次一致，再上传临时文件并 rename（不支持时回退覆盖）；该检查保留现有乐观冲突语义，不是远端原子 CAS。快照只包含开始读取时可见的已提交数据，之后的修改由后续 push 发布。其他字段的 sidecar 投影及完整远端会话清退仍见架构计划 B1/B2。

远端入库先上传资产，再在 work mirror 提交规范化的 Catalog 行并登记待发布 sidecar。`CatalogMirror::push` 先取一致快照并完成现有冲突检查，再从同一快照生成 `metadata.json` 并发布 Catalog；批量入库、显式 push 与断开 flush 都经过这个出口。上传或发布失败返回错误；待发布路径保留到成功；上传期间发生的新修改保留到下一次 push，断开发布后若 work mirror 又发生修改也返回错误，不清理尚未发布数据。断开失败时保留 session 与 work-root，可通过同会话再次 push / disconnect 重试。重新执行入库不是发布重试，会按已有路径分配新后缀。待发布集合只在内存中，不保证进程崩溃后自动恢复。切库时若旧远端 session 发布失败，保留当前 Vault、文档与会话信息，由现有错误 Toast 提示，用户可重试切换。

## 论文命令的实现共享（本地/远端）

`remote_paper_get` / `remote_paper_set_tags` / `remote_paper_set_is_read` 与本地 `paper_get` / `paper_set_tags` / `paper_set_is_read` 共用同一实现入口 `src-tauri/src/features/paper/catalog/service.rs`：命令先解析目标（本地 `resolve_vault` → `PathBuf`，远端 `try_session!` → `session.work_root`），再调用同一用例（同一校验、错误文案与 catalog 写入）；远端壳额外在写入成功后经 `RemoteSession::push_catalog` 发布 catalog（`PaperCommitOptions.push_catalog` 与断开 flush 复用同一方法）。`remote_paper_rescan` 的 SFTP 回填扫描（与本地相同的 `NOTES.md` 或 `metadata.json` 身份判定 + NOTES.md 标题回填 + `remote_rescan` 兜底行）是远端独有的 IO 实现，本地 rescan 走 `papers::rebuild_from_disk`，两者只在参数/包络与 push 时机上一致。身份标记已对齐；标题回填与 `updated_at` 刷新仍是远端行为。

**已知差异（wire 契约保留，待后续单独评估）**：`paper_list` 返回按 `id` 去重的 `PaperListRow`（含本地 `has_pdf` 探测）；`remote_paper_list` 刷新远端镜像后返回裸 `PaperRecord[]`，不去重、无 `has_pdf`（前端视为"未探测"，见 [api.md](api.md) 的 `paper_list` 一节）。两端命令名、参数、返回类型（specta bindings）保持现状，不因去重实现而变化。

## 文件存在性检查

`VaultFs::exists` 仅把本地 `ErrorKind::NotFound` 或 SFTP 服务端 `NoSuchFile` 转为 `false`；路径校验、权限、连接与超时错误继续返回错误。SFTP transport 自身的 IO NotFound 也不代表远端文件缺失，避免回收站恢复等碰撞检查在断连时继续执行。

## 超时

建连与校验约 15s；SFTP 操作约 30s；SSH ServerAlive；不自动重连、不重放写。

## 代码

`src-tauri/src/integration/remote/`（handle 解析：`crates/agentero-core/src/remote.rs`）  
教程：[../usage/remote-vault.md](../usage/remote-vault.md)
