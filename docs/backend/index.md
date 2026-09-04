# 后端

Tauri 2 + Rust Host：文件系统、Catalog、索引、ACP Client、远程 Vault。CLI（`cli/`）path 依赖同一 `agentero_lib`。

> 整体架构与跨层工作流见 [../architecture.md](../architecture.md)。

## 定位

- **本地优先**：Vault 文件为笔记/源事实来源；catalog 权威存论文集合与结构化 meta。
- **Mac 优先、跨平台**：桌面以 macOS 开发为主；CI 构建 macOS / Linux / Windows。
- **BYOA**：Host 只做 ACP Client，不捆绑 Agent、不托管模型 API Key。

## 为什么 Tauri 2

- Rust 安全操作本地 FS；Webview 用成熟前端栈。
- 包体小，适合常驻研究工具。
- 保留向 iOS/iPadOS 扩展的可能（非当前验收重点）。

## 源码布局（feature-first）

```text
src-tauri/src/
  app/           # run()、menu、logging、command 注册
  core/          # error、fs、paths、log_util
  features/      # 与前端 lib 域对齐
    vault/      # 创建、树、trash、watcher、rename、doctor 聚合
    paper/      # catalog、import、discovery、refs、paper move
    pdf/        # export、locate、parse、marks
    markdown/   # wiki、search
    system/     # settings
    layout/     # model_assets、hosted providers
    agent/ jobs/ translate/
  core/usage/    # XDG usage.sqlite 本地活动日志
  lib.rs
  main.rs
```

每域：`mod.rs` 对外 API + `commands.rs` 薄壳 + 按需 models。

## Tauri 插件

| 插件 | 用途 |
|---|---|
| `tauri-plugin-fs` | 读写 Vault、mkdir、remove |
| `tauri-plugin-dialog` | 选 Vault 目录 |
| `tauri-plugin-opener` | `revealItemInDir`、外链 |
| `tauri-plugin-log` | 运行日志 |
| shell / 子进程 | spawn ACP agent（及 SSH 相关） |

应用设置走 XDG `settings.json`（`features/system/settings`），不依赖把论文 meta 放进 Store。

## 主要 Rust crates

| Crate | 用途 |
|---|---|
| `tauri` / `serde` | 框架与 IPC |
| `agent-client-protocol` | ACP Client stdio JSON-RPC |
| `reqwest` + `tokio` | HTTP（Translator、arXiv、翻译等） |
| `rusqlite`（bundled） | catalog.sqlite |
| `rmcp` | 设置开关启停的 loopback Streamable HTTP MCP |
| `notify` | Vault 文件监听 |
| `liteparse` | 无 TeX 时 PDF → `PAPER.md` |
| `walkdir` / `regex` / `thiserror` | 遍历、解析、错误 |

## 安全

- **路径**：capabilities 限制在用户可选目录（`$HOME/**` 等 scope）；业务上以当前 Vault 为根。
- **CSP**：`tauri.conf.json` 限制 Webview 外部资源。
- **密钥**：模型 Key 由 Agent CLI 管理；Host 只存 command/args 与 UI 偏好。
- **网络**：产品侧抓取限定必要域名；Agent 出站由 agent 进程自己控制。

## 存储分层

| 层 | 存什么 | 位置 |
|---|---|---|
| 文件 | NOTES、PDF、TeX、marks、assets | Vault 内 |
| Catalog SQLite | 论文集合 + metadata | `.agentero/catalog.sqlite` |
| 应用设置 | UI / Agent 注册表 / 偏好 | XDG `~/.config/agentero/` |
| 使用记录 | 打开 / 下载 / Agent 等活动 | XDG data `~/.local/share/agentero/usage.sqlite` |
| 广场订阅 | 订阅名单 + 条目缓存 | XDG data `feeds.sqlite`（不进 catalog） |
| 版面 ONNX | PP-DocLayoutV3（ModelScope → HF） | XDG cache `~/.cache/agentero/models/` |
| 可重建索引 | 双链图 | 内存 / 可重建缓存，非业务权威 |

原则：Store/设置不存论文 meta；`PAPERS.md` / `library.bib` 默认不生成，仅导出。

## 与前端边界（Host 侧）

| 能力 | Host | 前端 |
|---|---|---|
| 文件 IO / 树 / 回收站 | command + 事件 | 展示与交互 |
| 入库 / 下载 / parse | `paper_commit`、lookup、assets | 进度与确认 UI |
| 双链索引 | 解析、查询、修复事务 | 渲染与补全 |
| 使用记录 | XDG `usage.sqlite` 写入与查询 | `track()` 缓冲上报 |
| Agent | spawn、session、prompt、权限桥 | 会话 UI |
| 远程 | SFTP + 远端 ACP | 连接与伪路径 |

## 功能索引

| 功能 | 文档 |
|---|---|
| 数据模型 | [data-model.md](data-model.md) |
| Catalog | [catalog.md](catalog.md) |
| Vault FS | [vault.md](vault.md) |
| 论文入库 | [paper-import.md](paper-import.md) |
| Identifier Lookup / 魔棒入库 | [identifier-lookup.md](identifier-lookup.md) |
| 学术搜索 API | [academic-search-apis.md](academic-search-apis.md) |
| Zotero Connector | [connector.md](connector.md) |
| 双链索引 | [wiki.md](wiki.md) |
| Vault Doctor | [doctor.md](doctor.md) |
| Agent Host | [agent.md](agent.md) |
| 远程 Vault | [remote.md](remote.md) |
| 云同步（S3） | [sync.md](sync.md) |
| 搜索 | [search.md](search.md) |
| 设置 | [settings.md](settings.md) |
| 翻译 | [translate.md](translate.md) |
| 日志 | [logging.md](logging.md) |
| 遥测 | [telemetry.md](telemetry.md) |
| 使用记录 | [usage.md](usage.md) |
| CLI | [cli.md](cli.md) |
| API 全表 | [api.md](api.md) |
