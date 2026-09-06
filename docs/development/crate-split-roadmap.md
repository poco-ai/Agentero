# Crate 拆分路线图（agentero-core）

状态：**Phase 1 / Phase 2 已落地**。本文记录已完成的模块边界、留守域及耦合原因、事件抽象方案与后续步骤。

## 目标

- `agentero-core`（`crates/agentero-core/`）：tauri 无关的基座 + 数据域服务，desktop Host 与 headless CLI 共用一份实现。
- `agentero`（`src-tauri/`，lib 名 `agentero_lib`）：Tauri 壳 —— `#[tauri::command]`、JobCenter、watcher、agent、integration、窗口装配。
- `agentero-cli`（`cli/`）：**只依赖 `agentero-core`**，依赖树中不再出现 `agentero` / `tauri` / `wry` / `tao`。

## Phase 1（已完成）：tauri 无关基座

`agentero_core` 顶层 13 个模块：`cancel`、`blocking`、`error`、`frontmatter`、`fs`、`http`、`install_dirs`、`log_util`、`paths`、`process`、`remote`、`sqlite`、`time`、`usage`（存储层）。`src-tauri/src/core/mod.rs` 以 `pub use agentero_core::{…}` 桥接，全仓 `crate::core::X` 路径零改动。

## Phase 2（已完成）：CLI 消费的数据域迁入 core

`agentero_core::features::*` 镜像 Host 的语义树。core 侧保留扁平别名（`features::catalog` 等）供 headless CLI 与迁入代码使用；Host 侧别名已在重构中删除，调用方统一走语义路径 `crate::features::<domain>::<module>`：

| core 模块 | 内容 |
|---|---|
| `features::paper::catalog`（别名 `features::catalog`） | catalog.sqlite schema、papers 存取、sidecar、`move_paper_under` |
| `features::paper::capabilities` | `probe_paper_caps` / `CapsCache` / 本地 pdf·tex·PAPER.md 探测 |
| `features::paper::import`（别名 `features::import`） | 魔棒入库主管线：`import_by_identifier*`、`download_paper_assets*`、`import_local_pdfs`、`paper_import::paper_commit`、assets 下载、batch/map/parse/resolver、skill、title_search、api_mapper |
| `features::paper::import::sources::zotero`（core 别名 `features::zotero`） | codec（NOTES ↔ Zotero HTML）、io（Translator `/export` `/import`）——tauri-free；Host 侧 `db`/`commands`/`sync/` 见留守域表 |
| `features::paper::scholar_api` | arXiv / Crossref / OpenAlex / S2 / Unpaywall / EasyScholar / Translator 客户端与评分 |
| `features::paper::analyze::parse`（别名 `features::import::pdf_parse`） | liteparse worker、`parse_paper_body`、`run_pdf_locate`、probe/render、engine 框架（trait + 注册表 + 本地引擎） |
| `features::paper::analyze::refs`（别名 `features::refs`) | 引用解析（bbl/bib/latex/online/citing）与 `agentero-cite.json` sidecar |
| `features::paper::discovery::feeds`（别名 `features::feeds`） | 广场订阅（RSS/Atom/JSON Feed + 正文抽取） |
| `features::vault` | Vault 创建（模板/技能内嵌）、路径服务、tree |
| `features::vault::{doctor,rename,trash}` | 诊断聚合、双链重命名事务、回收站 |
| `features::markdown::wiki`（别名 `features::wiki`） | 双链索引、解析、cache、rename、doctor、embed/extract/frontmatter |
| `features::pdf::locate` | 划词定位 + marks 标注存储（annotations） |
| `features::pdf::marks` | 阅读标注 activity / doctor |
| `features::translate` | 翻译 provider（free MT + LLM） |
| `features::lifecycle` | paper 事实事件（`paper:imported` / `paper:assets-ready` / `paper:renamed`）的 payload 与 emit 入口 |
| `features::open_request` | deep-link/CLI open-request 的解析、校验与请求文件读写 |
| `app_handle` | `AppHandle` + `HostHooks`：宿主回调抽象（见下） |

Host 侧桥接策略：原目录留 `mod.rs` 薄壳（`pub use agentero_core::…::*;` + 本地 desktop 子模块），`commands.rs` 等 tauri 壳留守原位；显式定义项遮蔽 glob（如 desktop 版 `refs::spawn_parse_after_import`）。

### 事件抽象（Phase 2 引入，窄面）

`agentero_core::app_handle::HostHooks`：

- `emit(event, payload_json)` —— lifecycle paper 事件、`job:progress`（批量导入 / 资产下载节流进度）。
- `spawn_parse_body_after_assets` / `spawn_parse_after_import`（返回 `true` 表示宿主接管调度）/ `spawn_recognize_metadata` —— JobCenter 跟随任务。

desktop 在 `src-tauri/src/core/app_handle.rs` 用 `TauriHostHooks(tauri::AppHandle)` 实现，`wrap(&app)` 生成 core `AppHandle`；命令壳/JobCenter/Connector/MCP/Remote 在调用迁移后的服务时包一层。headless（CLI）传 `None` → 全部 no-op，与迁移前 `cfg(not(desktop))` 行为一致（refs 的 tokio 直跑 fallback 保留）。

parse 引擎同理：远端引擎（MinerU/Paddle/OpenAI-compatible，依赖 `layout::hosted` 与设置库）留守 `features/paper/analyze/body_engines/`，经 core 的 `register_engine` / `set_provider_resolver` 注册表接入 `engine_for` 派发；注册发生在 `refresh_parser_config`（启动 + settings 变更时）。

## 留守域及耦合原因

| 留守模块 | 耦合点 |
|---|---|
| `features/jobs`（JobCenter） | `tauri::AppHandle` state、`tauri::async_runtime::spawn`、job 事件 emit |
| `features/agent`、`cli_install` | ACP 子进程 + tauri shell/state/事件，全 desktop |
| `features/vault/watcher`、`markdown/search`、`pdf/export`、`system/settings`、`paper::catalog::commands`（paper_move） | notify/AppHandle/tauri command/settings store |
| `features/paper/import`：`commands`、`job_runners`、`remote_ops`、`recognize/{chain_resolve,pdf_recognize,apply}` | tauri command/State、JobCenter、AppHandle 事件 |
| `features/paper/zotero`：`db`、`commands`、`sync/` | `tauri::AppHandle`（jobs spawn）、Channel IPC |
| `features/paper/analyze/layout`（hosted/model_assets）、`body_engines` | settings store 凭据、模型资产下载任务、tauri command |
| `features/paper/discovery`：`coolpapers`、`recommend`、`proxy/{mod,arxiv,modelscope}` | tauri command / `tauri::http` 站点代理 |
| `markdown/wiki`：`commands`、`heading_rename` | tauri State（`WikiIndexState` manage）、watcher 协同 |
| `features/lifecycle` desktop 部分 | `job:completed/failed` 依赖 JobSnapshot |
| `core/telemetry`、`core/usage::commands`、`app/open_request` desktop 部分 | posthog-rs、tauri command、fs scope/窗口聚焦 |
| `integration/*`（connector、mcp、remote、bridge、sync） | axum/rmcp/openssh/tauri runtime，全 desktop |
| `app/*`（handlers、window、menu、finder_service…） | Tauri 装配 |

## 下一步（Phase 3 建议）

1. **事件抽象扩展**：把 `HostHooks` 泛化为完整宿主面（vault:open-request、connector、job 事件、window 聚焦），消灭 `wrap()` 手工转换点；命令壳统一在入口构造一次 core `AppHandle`。
2. **留守域瘦身**：`jobs`（JobCenter 调度核心可下沉，tauri spawn/emit 走 hooks）、`discovery/proxy`（`tauri::http` → 纯 axum/hyper 内核）、`heading_rename`（watcher 协同改回调）。
3. **core 内路径扁平化**（可选）：`agentero_core::features::X` → `agentero_core::X`，与 Phase 1 顶层模块风格统一；Host 桥接不受影响。
4. **reqwest 双版本对齐**：锁文件中同时存在 `reqwest 0.12.28`（agentero-core / agentero 直接使用）与 `reqwest 0.13.4`（传递依赖引入，如 rmcp 等）。两份 TLS/连接池栈增大包体与审计面；待依赖链（rmcp / tauri 生态）稳定后统一到一个大版本，core 与 Host 必须同步升级以避免 feature 漂移。
5. **src-tauri 依赖清理**（保守未删）：迁移后 `feed-rs`、`dom_smoothie`、`pulldown-cmark`、`bitflags` 在 `src-tauri/src` 已无直接引用，可在确认无 build 脚本/宏隐式依赖后从 `src-tauri/Cargo.toml` 移除。
6. **iOS/Android 目标**：core 的 `not(ios/android)` 门（parse/locate/liteparse）与 Host 侧模块 cfg 门需保持同步；mobile 构建恢复时验证 remote bridge 路径。

## 验收快照（Phase 2 完成时）

- `cargo tree -p agentero-core | grep -icE "tauri|wry|tao"` → 0
- `cargo tree -p agentero-cli | grep -icE "tauri|wry|tao|agentero "` → 0（不再依赖 `agentero_lib`）
- `cargo test --workspace`：745 通过（agentero 365 + core 351 + cli 29），与拆分前总数守恒
- `src/lib/core/bindings.ts`、`src/`（前端）、`app/handlers.rs` 零 diff
- `src-tauri/src` 的 `cfg(feature = "desktop")` 门：124 → 93（迁移代码中的无意义门已清理）
