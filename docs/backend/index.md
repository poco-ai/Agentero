# 后端

Tauri 2 + Rust Host：文件系统、Catalog、索引、ACP Client、远程 Vault。tauri 无关的基座与数据域在 `agentero-core` crate；CLI（`cli/`）只依赖 `agentero-core`，Host 经桥接 re-export 复用同一实现。

> 整体架构与跨层工作流见 [../architecture.md](../architecture.md)。

## 定位

- **本地优先**：Vault 文件为笔记/源事实来源；catalog 权威存论文集合与结构化 meta。
- **Mac 优先、跨平台**：桌面以 macOS 开发为主；CI 构建 macOS / Linux / Windows。
- **BYOA**：Host 只做 ACP Client，不捆绑 Agent；ACP Agent 的模型 Key 由 Agent CLI 自己管理，Host 不代管。
- **内置 Provider**：翻译 / embedding / 正文 OCR 另有一条构建期注入凭证的内置通道（id `agentero`），与 BYOA 正交。见 [builtin-provider.md](builtin-provider.md)。

## 为什么 Tauri 2

- Rust 安全操作本地 FS；Webview 用成熟前端栈。
- 包体小，适合常驻研究工具。
- 保留向 iOS/iPadOS 扩展的可能（非当前验收重点）。

## 源码布局（feature-first）

```text
crates/agentero-core/src/   # tauri 无关基座 + 数据域（agentero-core crate）
  error、fs、http、paths、log_util、perf、sqlite、time、blocking、usage（存储层）、decision…
  app_handle    # AppHandle + HostHooks（宿主回调抽象：emit / job spawn）
  features/     # catalog、vault（tree/trash/rename/doctor）、wiki、import、
                # zotero codec/io、scholar_api、pdf_parse、refs、feeds、
                # translate、pdf locate/marks、lifecycle、open_request
src-tauri/src/
  app/          # run()、menu、logging、command 注册、open_request desktop 壳
  core/         # 桥接层：re-export agentero-core；app_handle 桥（TauriHostHooks）、telemetry、usage::commands
  features/     # 与前端 lib 域对齐；各域 mod.rs = pub use agentero_core + desktop 壳留守
    vault/      # commands、watcher（trash/rename/doctor 的 commands 留守）
    paper/      # catalog commands、import 壳（job_runners/remote_ops/recognize）、
                # analyze/layout、body_engines（云端 parse 引擎）、zotero db、discovery 站点代理
    web/        # agentero-web 通用网页代理（allowlist + web_proxy_allow_host，网页论文 iframe 划词用）；agentero-html 本地 HTML 预览
    pdf/        # export
    markdown/   # wiki commands、search
    system/     # settings、builtin（构建期内置 provider 凭证）、desktop_apps（本地桌面应用检测）
    decision/   # 决策层装配（DecisionEngine + providers + schemas）
    agent/ jobs/ lifecycle（job 事件）
  integration/  # connector、word、mcp、remote、bridge、sync（desktop-only）
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

ACP / SSH 子进程由 Rust 与 ACP SDK 启动，不注册 Tauri shell 插件。应用设置走 XDG `settings.json`（`features/system/settings`），也不依赖 Tauri store 插件。

## 主要 Rust crates

| Crate | 用途 |
|---|---|
| `tauri` / `serde` | 框架与 IPC |
| `agent-client-protocol` | ACP Client stdio JSON-RPC |
| `reqwest` + `tokio` | HTTP（Translator、arXiv、翻译等） |
| `rusqlite`（bundled） | catalog.sqlite |
| `rmcp` / `agentero-mcp` | loopback Streamable HTTP MCP。桌面设置开关与 CLI `mcp serve` 共用 |
| `notify` | Vault 文件监听 |
| `liteparse` | 无 TeX 时 PDF → `PAPER.md` |
| `walkdir` / `regex` / `thiserror` | 遍历、解析、错误 |

## 安全

- **路径**：capabilities 限制在用户可选目录（`$HOME/**` 等 scope）；业务上以当前 Vault 为根。
- **CSP**：`tauri.conf.json` 限制 Webview 外部资源。
- **密钥**：三条互不相干的托管路径。① ACP Agent 的模型 Key 由 Agent CLI 自己管理，Host 只存 command/args 与 UI 偏好；② 用户自备（BYOK）的翻译 / 版面 / embedding Key 明文存本机 `settings.json`（Unix `0600`），`settings_get` 与广播按字符 redact 为 `*`；③ 内置 provider 的网关 Key 在**构建期**编入二进制，只在 Host 进程内使用，绝不写入 `AppSettings`，因此既进不了 `settings.json` 也进不了 webview——但已发布二进制里的内嵌 Key 对拿到安装包的人仍可提取，网关只能限制损失面，详见 [builtin-provider.md](builtin-provider.md)。
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

本地原子写共用 core `fs::atomic_write[_with]`：通过 `tempfile` 独占创建同目录临时文件，再原子替换目标；写入或替换失败返回错误，保留原目标并清理本次临时文件，不退化为直接截断。默认使用短唯一名称且以 `.tmp` 结尾，避免并发共用 staging、长文件名溢出，并保持同步扫描排除规则。Wiki 自定义的 UUID 临时文件名与 `.agentero-rename-` watcher 标记保留；若名称已存在则报错，不覆盖其他写者的 staging。

普通文件保留 Unix `0666 & umask` 创建行为，settings / sync 凭据和 CLI 配置使用 `0600`。`sync_file` 可选在替换前同步文件内容（CLI 开启），不承诺父目录 rename 的断电持久性。Doctor alias repair 与引用侧写入的 FSEvents 特例仍保留原地写，见 [doctor.md](doctor.md)。

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
| 研究上下文 | [context.md](context.md) |
| 知乎接入（内置 Agent / 开放平台） | [zhihu.md](zhihu.md) |
| 远程 Vault | [remote.md](remote.md) |
| 云同步（S3 / WebDAV / Git） | [sync.md](sync.md) |
| 搜索 | [search.md](search.md) |
| 设置 | [settings.md](settings.md) |
| 本地桌面应用检测 | [desktop-apps.md](desktop-apps.md) |
| 翻译 | [translate.md](translate.md) |
| 实时 TeX 预览（rtex） | [rtex.md](rtex.md) |
| LaTeX 编译 / Recipe / SyncTeX | [latex.md](latex.md) |
| 内置 Provider（构建期凭证） | [builtin-provider.md](builtin-provider.md) |
| 日志 | [logging.md](logging.md) |
| 遥测 | [telemetry.md](telemetry.md) |
| 使用记录 | [usage.md](usage.md) |
| 决策层 | [decision.md](decision.md) |
| CLI | [cli.md](cli.md) |
| API 全表 | [api.md](api.md) |

## 开发插件

[开发插件宿主（M0）](plugins.md)：桌面 debug 构建的显式目录加载、独立 QuickJS 进程、受限只读 API 与窗口/Vault 作用域清理。

## 本地插件

[本地插件系统](plugins.md)：安装、按 Vault 授权、进程隔离、受控数据 API、命令/菜单/事件、设置及私有存储。

Word 官方插件兼容原型见 [word.md](word.md)：macOS 与 Windows 均为正文引文；Windows 尚未做真实 Word 验收。
