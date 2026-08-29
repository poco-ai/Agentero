# 远程 Vault（SSH/SFTP）

文件权威在服务器；本机 UI + 可选远端 BYOA。

## 能力

| 层 | 说明 |
|---|---|
| 连接 | `remote_connect` / `disconnect`；密钥或 SSH agent；`remote_ssh_config_hosts` 解析 `~/.ssh/config` 供对话框联想 |
| 文件 | SFTP list/read/write/mkdir/remove/bytes |
| Catalog | work mirror（本机查询，写回远端） |
| PDF | blob 缓存（`remote_cache_*`） |
| Agent | ACP over SSH：`remote_agent_probe` / scan / 与 `agent_run_once` 集成（命令实现属 agent 域 `features/agent/remote_catalog_commands.rs`，复用 remote 域的 SSH session/exec） |
| 入库 / 回收站 | 远端写路径与 trash bridge |
| Connector | 可绑定 `remote:<sessionId>` |

前端伪路径 `remote:<sessionId>`。客户端：**macOS / Linux**（Windows 客户端暂不支持打开远程 Vault）。

## 超时

建连与校验约 15s；SFTP 操作约 30s；SSH ServerAlive；不自动重连、不重放写。

## 代码

`src-tauri/src/features/remote/`  
教程：[../usage/remote-vault.md](../usage/remote-vault.md)
