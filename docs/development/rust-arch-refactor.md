# Rust 端架构重构计划（2026-09）

状态：**进行中** —— P0 未开始。

来源：三轮架构评审（模型交叉 + 16 个审计/核实 sub-agent，2026-09-06）。文中所有关键论断均已逐条核实，含文件行号证据；被推翻的论断也已记录，避免后续重复调研或误信。

## 使用方式

- 完成一项就把 `- [ ]` 改成 `- [x]`，并在该项末尾追加 commit hash（如 `✅ abc1234`）。
- 阶段内任务尽量相互独立；标注 ⛓ 的任务存在前置依赖，先完成被依赖项。
- 任意时刻可暂停：每个任务自含「问题 / 证据 / 做法 / 验收」，新会话读本文档即可恢复上下文，无需重新调研。
- 发现计划与代码现实不符时（重构过程中代码会漂移），直接更新对应条目并注明日期，不要留着过期信息。

## 一句话诊断

分层的"形"已就位（core/host 分离、依赖方向经核实为零违规：`features → integration` 0 引用、`agentero-core → tauri` 0 引用），但每个抽象都有"逃生舱口"——`VaultFs` 只有 remote 用、JobCenter 只有 paper 用、错误编码只有 1.4% 在用。**本轮重构的性质是收敛平行实现，不是清理垃圾。**

## 核实裁决记录（先读这个，防止重复调研）

### 已确认的重大问题

| # | 论断 | 关键证据 |
|---|---|---|
| V1 | **远端 catalog 推送丢数据（WAL）**：push 只读主文件字节，全仓库 0 次 checkpoint；push 紧跟 commit 且缓存连接存活 → **首次修改即丢**；disconnect 删 work 目录连 WAL 一起删 → 永久丢失 | `core/sqlite.rs:16`（强制 WAL）、`catalog/schema.rs:155`（进程级缓存连接）、`remote/catalog_mirror.rs:116`（裸 `fs::read`）、`remote/session.rs:88`（删 work 目录）；唯一 roundtrip 测试 `#[ignore]` |
| V2 | VaultFs 双轨制：`dyn VaultFs` 13 处全在 `integration/remote/**`，features 0 使用；`LocalFs` 生产实例仅 1 处（local-sim） | `core/fs/mod.rs:27`、`remote/session.rs:120` |
| V3 | remote 分支共 **28 处 / 10 文件**（23 处 `parse_remote_handle` 调用 + 5 处裸 `"remote:"` 比较） | 分布：trash×5、import×4、connector×11、jobs×1、zotero×1、launch×1、mcp×1、sync×1 |
| V4 | `remote_*` 命令 21 个（remote/commands.rs 18 + agent 3），其中**真孪生 5 个**：`remote_paper_{get,list,set_tags,set_is_read,rescan}` ↔ `paper_*` | `app/handlers.rs:155-175` |
| V5 | 3 个 `Remote*Ops` trait 无本地实现，调用点 `if remote { ops } else { 直调 }` | `RemoteImportOps`（features/paper/import/remote_ops.rs:22）、`RemoteTrashOps`（features/vault/trash/remote_ops.rs:17）、`RemoteAgentHosts`（features/agent/remote_host.rs:57） |
| V6 | trash 整体复制分叉：结构体、校验函数、5 个操作全部重写，仅共享结果类型与 catalog 行助手 | core `vault/trash/mod.rs` vs `remote/trash_bridge.rs`（自带头注释"Semantics match local"） |
| V7 | CLI move 只动文件+SQL，不处理双链；桌面走重命名事务（双链重写+脏文件拒绝+回滚）。CLI 移动后链接种留在盘上，修复依赖桌面端开着且手动确认 | core `catalog/mod.rs:66` vs src-tauri `catalog/commands.rs:578`（`run_local_rename_transaction`）；CLI 入口 `cli/src/commands/paper.rs:689` |
| V8 | caps 误判 attachments：附件 PDF 可成主 PDF（read_dir 顺序不定，可能抢在 source/ 前）；附件 `.tex` 置 `has_tex` 压制 ParseBody。与 AGENTS.md attachments 约定冲突 | `core/paper/capabilities.rs:146,148` |
| V9 | 本地/远端 rescan marker 不同：本地 `NOTES.md∨metadata.json`；远端另加 `highlights.md`/`PAPER.md`/`source|assets|marks` 目录 + 从 NOTES 刮标题 + 恒刷 `updated_at` | `catalog/papers.rs:811` vs `remote/commands.rs:581-613` |
| V10 | `set_tags`/`set_is_read`/`add_tags`/`remove_tags` 均为读全行→改→全行 upsert，两次独立拿锁，并发覆盖窗口 | `catalog/papers.rs:1001-1056` |
| V11 | sidecar 尽力写：DB 写成功后投影失败仅 log | `papers.rs:391-395`、`sidecar.rs:14-33` |
| V12 | MinerU 双重提取：正文引擎与版面引擎各自 fresh client+batch，零共享；JobCenter 去重键含 kind 标签注定抓不住；两 job 确实同时入队 | `body_engines/mineru.rs:22`、`layout/hosted/mineru.rs:409,465,476`；fingerprint `jobs/mod.rs:61-62` |
| V13 | sync 注销泄漏：`try_begin`/`end` 无 abort 防护（全仓库无 Drop/scopeguard 兜底），scheduler abort 跳过 `end()` → 直到重启永远 "sync already running" | `sync/commands.rs:211,229`、`sync/scheduler.rs:53` |
| V14 | gate 超时泄漏：三个 gate 的 pending map 只在 `resolve()` 删除，300s 超时路径不清理（晚到回答优雅返回 `resolved:false`，不崩） | `runtime/gates.rs:24,71,115`、`acp/interaction.rs:345,388,448` |
| V15 | bridge 事件缺口：`agent:ask-user-request` / `agent:elicitation-request` **不在**转发列表，但回答端 RPC 存在 → 移动端这两个 RPC 是死代码，300s 自动取消。`agent:permission-request` 已转发（无缺口） | `bridge/host.rs:41-49`（转发表）、`host.rs:964-985`（回答端） |
| V16 | 远端 agent 终端本机执行：SSH run 的 `terminal/create` 无条件走本机 `tokio::process::Command`，无远端 executor | `session/run.rs:244,356`、`acp/terminal.rs:124` |
| V17 | runtime 绑死 WebviewWindow：`accept_run_once` 首参 `&WebviewWindow` 仅用作事件目标；bridge 被迫狩猎窗口 + `listen_any` 窃听 | `agent/service.rs:140,198`、`bridge/host.rs:938-941,79-104` |
| V18 | Agent 命令绕过 service：`agent_warm` 内联整套编排；`agent_probe` 近乎逐字复制 `service::probe_catalog`；lifecycle 无 service 包装 | `commands/session.rs:122-183`、`commands/registry.rs:156-178` |
| V19 | 连接装配重复 **5 处**（非 4）：probe/warm/run/history×2，builder+terminal handler+deny-permission+connect_with 样板复制，无共享装配助手 | `acp/probe.rs:37`、`session/warm.rs:78`、`session/run.rs:353`、`session/history.rs:70,411` |
| V20 | PATH 无缓存全量重扫：每次 `agent_run_once` 对**每个**注册 agent 跑 `probe_command`（遍历 nvm/brew/scoop），阻塞 tokio 线程；`upsert`/`discover` 还持锁扫描 | `registry/store.rs:160,341`、`core/process/discover.rs`（零 memoization） |
| V21 | 取消=Ok+字符串：run.rs 恰 9 处 `select!`，取消返回 `Ok` + `stop_reason:"cancelled"` 硬编码 | `session/run.rs:502-768`、`acp/client.rs:266` |
| V22 | `is_ssh()`/`is_local_sim()` flag 泄漏 4 处（比原报告多 2 处） | `remote_host.rs:23,25`、`acp/client.rs:169`、`registry/remote.rs:121,158,211`、`commands/remote.rs:137`、`remote/launch.rs:75` |
| V23 | IPC 包络三态 95 / 94 / **7**（`set_locale` 曾被漏计）；成因是 State-borrow 变通，文档自认 | `integration/remote/commands.rs:1-4`；前端 3 个 unwrap helper（`src/lib/core/ipc.ts`） |
| V24 | fs scope 由渲染层授予：`vault_allow_fs_scope` 命令对任意非空路径 `allow_directory(&p, true)` 递归授予，无 canonicalize/白名单/活跃 vault 校验（host 侧 `handle_open_dir` 反而会先 canonicalize） | `app/vault_session/fs_scope.rs:30`、`vault_session/mod.rs:6-14` |
| V25 | 注册表双份：handlers.rs 191 vs bindings_test.rs 191 手工对齐；`bridge_status` 桌面/iOS 同名不同签名 → iOS 5 个命令整体排除在 bindings.ts 外（cfg 互斥故无运行时遮蔽） | `app/bindings_test.rs:11-13` |
| V26 | `events_contract.rs` 1248 行 + 手写 Rust 源码扫描器；42 事件（`:360` 的"43"注释过期）；57 个 emit 点 | `app/events_contract.rs:905-915` |
| V27 | OpTimer 覆盖 50/196 命令；jobs 全部 20 个命令、agent、feeds、catalog 大部无计时 | `core/log_util.rs` |
| V28 | jobs/mod.rs 2845 行；JobKind 14 变体（严格 paper 11 + LibraryIo 边缘）；并发上限 9/14 硬编码字面量；**发现 3 个死变体**：`LayoutTranslate`/`PageCount`/`WikiReindex` 无 runner 无 enqueue | `features/jobs/mod.rs:35-50,417-442` |
| V29 | 7 套进度机制 / 6 套取消机制并存（bridge progress 甚至裸 `&str`；三个同形结构体靠注释同步） | 详见 P3 任务清单 |
| V30 | JobCenter 无持久化，崩溃丢队列 | `jobs/mod.rs:247-266`（无 Serialize） |
| V31 | `probe_command` 薄重复包装（函数体逐字节相同，均委托同一 core `resolve_command`；测试不同）；`spawn_parse_after_import` 5 处定义（1 trait 声明+1 impl+1 固有方法+2 自由函数） | `core/process/discover.rs:150` vs `agent/registry/discovery.rs:9`；`core/app_handle.rs:29,69`、`host_hooks.rs:27`、refs 两处 |
| V32 | 错误分类学空壳：`AppError::message` 937 处 vs `domain` 13 处；3 处靠嗅探文本决策（CLI 子串退出码、`VaultFs::exists` grep "not found"、connector `contains("SESSION_EXISTS")`） | `cli/src/error.rs:107-133`、`core/fs/mod.rs:44-62`、`connector/server.rs:329` |
| V33 | 存储管道四套写法：4 种 SQLite 连接策略 / 4 套迁移梯子；mirror 连接无 busy_timeout；`CatalogMirror::open` 生产零调用 | `usage/schema.rs:116`、`feeds/mod.rs:524`、`wiki/cache.rs:302`（DELETE 模式）、`catalog_mirror.rs:96-102` |
| V34 | 失效依赖 UI 活性：watcher 只向 webview 发事件，由 React 回调 Host 命令触发重建；多窗口重复重建；headless 写入无 Host 侧对账 | `features/vault/watcher/mod.rs:104-112`、`App.tsx:288-305` |
| V35 | 远端 work-root 连接永不清退：`vault_release` 按本地路径 canonical 匹配，`remote:<id>` 永不命中；disconnect 也不清；远端 session 的 sidecar 写进临时 work 目录而非远端 vault | `app/vault_session/lifecycle.rs:34`、`remote/session.rs:88` |
| V36 | core/host 边界：src-tauri 14 处 glob 重导出；core 12 个扁平别名且**自用 ~150 处**（src-tauri 侧反而语义路径 83 处/33 文件、扁平 0 处）；`#[path]` 重挂载恰 2 处（cli_install、open_request） | `core/features/mod.rs:16-31`、`src-tauri/features/mod.rs:12-13,21-22` |
| V37 | 两个下载器互补残缺（**非**重复实现）：install/download.rs 有 sha256+解包+chmod 无多源回退无进度无取消；model_assets 有多源回退+节流+取消无校验和。两者都已有 `.partial`+rename（不会留损坏产物） | `agent/install/download.rs`、`layout/model_assets/mod.rs:21,193-243` |
| V38 | Zotero 两个家：core codec+io 1189 行（tauri-free）vs host db.rs 1651 + sync 1352；db.rs 是事实上的 paper source 却无 trait（手工拼 Zotero API JSON 喂 `map_zotero_item_to_record`） | `features/paper/zotero/db.rs:1-6,390` |
| V39 | settings 直读 6 模块/10 处（非传闻的 8 features）：paper/import×4、body_engines、layout/hosted、recommend×2、translate、mcp | 详见 P5 |
| V40 | acp/ 层不纯：import `AgentEventEmitter` 并直接发 UI 事件（一跳之隔，无直接 tauri:: import） | `acp/updates.rs:7,407-422`、`acp/interaction.rs:5-6,334-437` |

### 已推翻 / 修正的论断（不要再按原说法执行）

| 原论断 | 裁决 |
|---|---|
| `parse_remote_handle` 38 处/11 文件 | 真实 **28 处/10 文件**（38 是含 import/测试的总文本行数） |
| `layout_backend_source` 直读 settings | **REFUTED**——注入闭包模式，settings 读取在装配层（`app/mod.rs:187`），这是**好设计，应推广而非移除** |
| "core::cancel 只有 JobCenter 用" | **方向反了**：JobCenter 是 probe 提供方，消费者是 core 深处的 import/pdf-parse/scholar/citing |
| enqueue 112 处 | 文本 112，其中 78 处测试、11 处内部委托，**真实外部调用 23 处** |
| "recommend/coolpapers/search/recognize 因 settings 滞留 host（等 ConfigProvider）" | **大部分不成立**：四者主体（807+860+373+1416 行）今天就是 tauri-free 且 settings-free，settings 读取全在 commands 壳；recognize 的接缝早已以函数参数存在。直接搬即可，**ConfigProvider 不做** |
| import-tmp 永不清理 | REFUTED：前端 `cleanupImportTempPaths` finally 清理；仅崩溃孤儿无 host 清扫（降级为可选任务） |
| glob 17 处 / 别名 11 个 / 事件 43 个 | 精确值 **14 / 12 / 42** |
| OpTimer "20/39 文件" | 50/196 命令；文件口径 20/**40** |

---

## P0 · 正确性修复（立即做，独立小 PR，互不依赖）

> 全部是核实过的真 bug。每项一个 PR，改完即可发布，不等重构。

- [ ] **P0-1 远端 catalog WAL 推送修复**（V1）
  - 做法：`CatalogMirror::push` 读字节前对 work 库执行 `PRAGMA wal_checkpoint(TRUNCATE)`；或推送走专用短连连接（开→checkpoint→读→关）。推荐后者：顺带修 V35 的连接清退。
  - 验收：用 `LocalFs` 复刻 write→push→pull roundtrip 进 CI（非 ignore）；远端 `set_tags` 后 pull 回读一致。
  - 参考：`session.rs:449` 的 `#[ignore]` 冒烟测试就是会被此 bug 打败的用例，改造它。

- [ ] **P0-2 sync 注销 RAII 防护**（V13）
  - 做法：`try_begin` 返回 guard（Drop 兜底 `end()`），`perform_sync` 持有；abort 时 Drop 保证注销。
  - 验收：scheduler abort 后同 vault 可再次 `sync_now`；`sync_get_status` 不再永久 `running:true`。

- [ ] **P0-3 gate 超时清理 pending**（V14）
  - 做法：`interaction.rs` 三处超时分支补 `gate.remove(&id)`（gates 增加 remove 公有方法）。
  - 验收：超时后三个 map 归零；晚到回答仍优雅 `resolved:false`。

- [ ] **P0-4 bridge 转发补 2 事件**（V15）
  - 做法：`FORWARDED_AGENT_EVENTS`（`bridge/host.rs:41-49`）加入 `agent:ask-user-request`、`agent:elicitation-request`。payload 已带 sessionId，过滤器天然兼容，两行改动。
  - 验收：移动端发起 agent run 后能收到并回答 ask-user / elicitation。

- [ ] **P0-5 caps 排除 attachments/**（V8）
  - 做法：`probe_paper_caps` 二趟子目录扫描跳过 `attachments/`（PDF 与 tex 均不计数）；对齐 AGENTS.md 论文单元约定。
  - 验收：`attachments/supplementary.pdf` 不再成为 `pdf_path`；`attachments/x.tex` 不再置 `has_tex`；补两个单测锁定行为。
  - 注意：老 Vault 兼容——若历史数据曾把主 PDF 放 attachments（需查证），保留一次迁移探测或 doctor 检查。

- [ ] **P0-6 fs_scope 加固**（V24）
  - 做法：`vault_allow_fs_scope` 执行前 canonicalize + 存在性校验；与当前已打开 vault（`vault_session` 状态）做前缀断言后才授予。
  - 验收：渲染层传任意路径（如 `/`）不再扩大 scope；正常打开 vault 流程不回归。

- [ ] **P0-7 tag/is_read 单事务化**（V10）
  - 做法：`set_tags`/`set_is_read`/`add_tags`/`remove_tags` 改为单条 `UPDATE papers SET tags_json=?…WHERE path=?`（tags 解析/规范化后整体写回），去掉 get→upsert 全行覆盖。
  - 验收：并发写不同字段不互相覆盖；返回值仍为完整 `PaperRecord`（可 SELECT 回读）。

- [ ] **P0-8 杂项小修**
  - [ ] 远端 work-root 连接清退：`RemoteRegistry::disconnect` 调 `evict_catalog_conn(work_root)`（V35）
  - [ ] `events_contract.rs:360` "43" 过期注释改 42
  - [ ] 删除 JobKind 3 个死变体 `LayoutTranslate`/`PageCount`/`WikiReindex`（V28；确认 bindings 再生成后 TS 侧无引用）

---

## P1 · IPC 契约统一（机械高收益，为后续铺路）

- [ ] **P1-1 单一命令注册表**（V25）
  - 做法：tauri-specta `Builder` 同时产出运行时 `invoke_handler` 与 bindings.ts；删 `handlers.rs` 与 `bindings_test.rs` 的双份手工清单。iOS 分支用独立 builder 保持干净。
  - 前置子项：`bridge_status` 改名解冲突
    - [ ] iOS 侧 `bridge_status` → `bridge_client_status`（`bridge/client_commands.rs:46`），前端 iOS 调用点同步改名
    - [ ] iOS 5 个命令纳入 bindings.ts（解除 `bindings_test.rs:8-13` 排除）
  - 验收：`pnpm tauri dev` 全命令可调；bindings.ts 再生成 diff 仅含预期变化；加一个新命令只改一处。

- [ ] **P1-2 包络统一为 `ApiResult<T>`**（V23）
  - 做法：94 个 `Result<ApiResult<T>, String>` 命令改用 `State<'_, Arc<T>>` + clone 消 borrow 变通；7 个 `Result<(), String>`（menu/window/watcher）改 `ApiResult<()>`。前端删 `callApiResult`/`callResult`，只留 `callApi`。
  - 验收：196 命令单一返回形态；前端 3 helper → 1；bindings.ts 类型收敛。

- [ ] **P1-3 命令包装宏**（V27）
  - 做法：`macro_rules!`（展开为真实 fn，tauri-specta 兼容）统一：`#[tauri::command]` + `#[specta::specta]` + OpTimer（`stringify!` 自动命名）+ `finish_result` 错误映射 + 可选 blocking 标志走 `run_blocking`。
  - 验收：OpTimer 50/196 → 全覆盖；先迁 jobs/commands.rs（20 命令零计时的最大户）验证宏形态，再批量。

- [ ] **P1-4 路径 newtype**（V24 关联）
  - 做法：`VaultPath`/`PaperRelPath` 实现 `Deserialize`，归一化 + 拒 `..` + 分隔符统一在一处；命令 args 从 `vault_path: String` 渐进换类型（56 个 args 结构，机械替换）；合并两份 `vault_path_arg`；14 处手搓 `trim_matches('/').replace('\\',"/")` 替换为 `sanitize_vault_rel`。
  - 验收：`set_tags` 等带 rel-path 入参的命令无法注入 `..`；Windows 混合分隔符场景单测通过。

- [ ] **P1-5 重复定义收敛**（V31）
  - [ ] 删 `agent/registry/discovery.rs:9` 的 `probe_command` 薄包装，调用点直用 core 版
  - [ ] `spawn_parse_after_import` 5 处定义收敛：trait 默认实现 + 桌面覆盖保留，删 2 个自由函数重复

- [ ] **P1-6 错误语义构造器**（V32）
  - 做法：`AppError` 增加 `not_found(what)` / `conflict` / `cancelled` / `invalid_arg` 构造器（稳定 snake_case code，wire 格式不变，渐进迁移）；改掉 3 处嗅探：
    - [ ] CLI 退出码改按 `code()` 映射（`cli/src/error.rs:107-133`）
    - [ ] `VaultFs::exists` 默认实现改按错误 code 判断 NotFound（`core/fs/mod.rs:44-62`，Ambiguous 分支返回 Err 而非 false）
    - [ ] connector `SESSION_EXISTS` 改 `AppError::conflict` code（`connector/server.rs:329`）
  - 验收：三处嗅探单测改为 code 断言；新命令错误天然带 code。

---

## P2 · trait Vault 统一双轨（核心战役，按切片推进）

> 目标：`Vault` 端口 + `CommitSink` 统一本地/远端；消 28 处分支、3 个 Remote*Ops、trash 分叉、rescan 分叉、4 份 commit 拷贝、5 个孪生命令。前置：P0-1（先把数据丢修了再动结构）。

- [ ] **P2-1 VaultTarget 分发收敛**（V3/V5）
  - 做法：仿 agent 侧已有的 `resolve_target()` 模式（`agent/service.rs:173`），在 core 建 `VaultTarget`（`Local(PathBuf)` / `Remote(session)`）+ `resolve_target(vault_path)` 单一入口；28 处 if-remote 分支改为模式匹配调用。
  - 验收：`parse_remote_handle` 生产调用点归零（或仅剩 resolve_target 内部 1 处）；行为不变。

- [ ] **P2-2 trash 统一**（V6，最安全先行者）
  - 做法：core trash 五操作参数化 `fs: &dyn VaultFs`（语义已对齐，纯机械）；`trash_bridge.rs` 降为远端 session 组装 + `catalog.push` 钩子；补齐差异项（远端 restore 的 best-effort mkdir 保留为策略）。
  - 验收：`trash_bridge.rs` 删至 ~100 行组装层；本地/远端 trash 行为单测同表驱动。

- [ ] **P2-3 rescan marker 统一**（V9）
  - 做法：抽 `paper_marker(dir) -> bool` + 收编规则到 core 一处；本地/远端共用；远端"NOTES 刮标题"与"恒刷 updated_at"作为远端策略参数保留或删除（倾向删除，向本地语义对齐）。
  - 验收：同一目录结构本地/远端 rescan 结果一致；现有两边测试合并为参数化测试。

- [ ] **P2-4 CommitSink 统一提交内核**（4 份拷贝 → 1）
  - 现状四份：core `paper_commit`（权威内核）、`remote/paper_commit.rs:38`（无去重/回滚/事件）、connector item remote（`connector/import.rs:151-199`，catalog/上传顺序还与前者相反）、connector standalone remote（`import.rs:664-718`）；外加 Zotero migrate 自拼第 5 份（`zotero/db.rs:470`，无回滚无事件）。
  - 做法：
    - [ ] `remote_paper_commit` 补齐与本地内核相同的策略面（`DedupePolicy` / `RemoteAssetsPolicy` / `events: bool` / staging RAII 回滚）
    - [ ] connector 两份远端拷贝改为 `connector_paper_meta` + 一次 `remote_paper_commit` 调用（connector 15s 超时契约用 `push_catalog: false` + 事后显式 push 表达，API 已支持）
    - [ ] Zotero migrate 接入 `paper_commit`（`PaperCommitOptions` 增 `source_metadata`/`linkage`/`skip_assets` 可选项），migrate 特有的 collection 迁移/幂等回填留在外层
    - [ ] 统一 `paper:imported` 事件进内核（远端 payload 的 `vault_id` 编码 `remote:<sid>/<path>`），删 command 层 2 处手工补发
    - [ ] 统一 ID 分配碰撞域：`unique_remote_paper_path` 补查镜像 catalog（本地版已是"目录存在 OR catalog 有行"）
  - 验收：四/五条路径入库行为一致（失败回滚、事件、去重、ID 后缀）；净删 ≥300 行。

- [ ] **P2-5 孪生命令合并**（V4）
  - 做法：`remote_paper_{get,list,set_tags,set_is_read,rescan}` 并入 `paper_*` 按 `VaultTarget` 分发（前端已在传 `remote:<id>` handle）；前端删 `isRemoteVaultHandle()` 分派层，改消费 `FsCaps`（bindings 已序列化、前端零消费——V 确认）。
  - 验收：5 个 `remote_paper_*` 命令删除；前端 paper API 层单路径；`remote_list/read/write/mkdir/remove/write_bytes` 6 个 FS 命令保留（镜像的是前端 fs 插件，非孪生，不动）。

- [ ] **P2-6 Remote*Ops 退役**（V5）
  - 做法：`VaultTarget` 覆盖 import/trash 能力后，`RemoteImportOps`/`RemoteTrashOps` 删除；`RemoteAgentHosts` 保留（agent 侧的 `resolve_target` 模式已验证良好，等 P5-5 ExecutionTarget 时再评估合并）。
  - 验收：features 对 integration 的倒置仍为零直接依赖（保持铁律）。

---

## P3 · Jobs 去业务化 + 进度/取消统一

> 原则：**不为拆而拆 2845 行**；先去业务化 + 迁 platform，体积自然缓解。新 layer：`src-tauri/src/platform/`（features → platform → core，反向禁止）。

- [ ] **P3-1 迁移 + 分层**
  - [ ] `features/jobs/` → `platform/jobs/`（含 commands 壳评估：壳留 features 或随迁，倾向随迁）
  - [ ] `features/system/settings` 存储层 → `platform/settings/`（commands 壳留守，修"8 个 feature 依赖 settings"的倒置观感；实际直读仅 6 模块/10 处，随 P5 收敛）
  - 验收：依赖方向 features → platform → core 无反向（加一个 cargo-deny 或 grep CI 检查）。

- [ ] **P3-2 JobKind 注册化**（V28）
  - 做法：JobKind 退化为稳定字符串 ID + `JobSpec { id, concurrency, exec_host, fingerprint }` 注册表（注册机制已有：`register_runner` `app/mod.rs:181-186`）；**推广 `set_layout_backend_source` 注入模式**（核实确认为好设计）。
  - 搬迁：`job_reconcile_paper`/`job_reconcile_vault`/`job_papers_needing_assets`/`validate_job_paper`/`spawn_parse_body_after_assets`/`spawn_recognize_metadata` → `features/paper/backfill/`。
  - 验收：新增一种 job 只需在所属 feature 注册，不改 platform 代码；jobs/mod.rs 显著缩量。

- [ ] **P3-3 进度统一 `ProgressPayload { phase, done, total, unit }`**（V29，7 → 1）
  - 收编顺序（按风险从低到高）：
    - [ ] sync engine `Progress<'a> = &dyn Fn(&str, usize, usize)`（`sync/engine.rs:65`）
    - [ ] zotero sync `impl Fn(usize, usize, &str)`（注意参数序相反，`zotero/sync/mod.rs:73`）
    - [ ] agent lifecycle 安装器 750ms 节流 emit（`registry/lifecycle.rs:841,898`，合成百分比 `5+elapsed*2` 一并删）
    - [ ] connector `connector:progress`（保留 wire 协议不变，内部载荷统一）
    - [ ] bridge `bridge:progress`（裸 `&str` → 结构体，iOS 侧同步）
    - [ ] 三个同形结构体合并（`AssetDownloadProgress` / `CitingScanProgress` / model_assets `ProgressEvent`，靠注释同步的字段对齐改为单一类型）
  - 验收：进度载荷类型数 7 → 1；前端 job 面板对所有来源显示一致。

- [ ] **P3-4 取消统一**（V29，6 族 → 2）
  - 保留：JobCenter per-job `CancellationToken`（唯一 tokio_util 用户）+ `core::cancel` probe（**方向是对的**：JobCenter 提供探针、core 消费）。
  - [ ] agent lifecycle cancel set 并入 job token
  - [ ] agent gates oneshot 超时并入统一取消语义（保留 300s 预算）
  - 验收：`is_task_cancelled` 单一注册表；liteparse/terminal 的 kill 逻辑不变（已良好）。

- [ ] **P3-5 JobCenter 最小持久化**（V30）
  - 做法：job 队列入 `usage.sqlite` 同款轻量 SQLite（或独立 jobs.sqlite），崩溃重启后未完成 job 标记 interrupted 可重入。
  - 验收：进程 kill 后重启，队列可见且可重跑；正常路径零额外 IO（变更时写）。

---

## P4 · 横切基础设施（与 P2/P3 并行推进）

- [ ] **P4-1 sqlite 统一入口**（V33）
  - [ ] `core::sqlite` 升级为唯一连接入口：`Db` 注册表（Catalog/Usage/Feeds/WikiCache/Mirror），统一 busy_timeout、按逻辑库声明 journal mode（wiki cache 保持 DELETE 需有注释理由）
  - [ ] mirror 连接补 PRAGMA（busy_timeout；journal 随 P0-1 决策）
  - [ ] 统一迁移 runner：`migrate(conn, DbId, &[Migration])` 事务化 + 统一 duplicate-column 容忍 + 统一 future-version 报错（4 套梯子：catalog/usage/feeds/wiki-cache 各自手搓）
  - 验收：新增一个数据库只写 DDL + Migration 列表；现有迁移行为有快照测试锁定。

- [ ] **P4-2 LoopbackServer 泛型**
  - 做法：抽 `LoopbackServer<S>`（端口配置、bind-await、oneshot shutdown、状态快照、状态事件常量）；MCP 与 Connector 两个 controller（结构相同的 ~250 行）迁移，各留 Router/领域状态。
  - 顺带：connector `AddrInUse` 的硬编码中文提示改 error kind（i18n 走前端）。
  - 验收：两 controller 删至各自领域逻辑；端口冲突行为一致。

- [ ] **P4-3 process supervisor**（以 MCP tunnel 的 generation-counter 模式为模板，全仓库最佳实现）
  - [ ] `core::process::supervisor`：`SpawnSpec { cmd, args, env, stdio, windows_flags, timeout, cancel, on_progress }`，async + sync-stop 双入口
  - [ ] 迁移：agent lifecycle 安装器（std 100ms 轮询）、PDF worker、`agent_exec::remote_which`
  - 不迁：ACP 子进程（外部 crate 管）、terminal（已教科书级）
  - 验收：子进程生命周期模式 4 → 2（supervisor + terminal）。

- [ ] **P4-4 SSH 选项统一**
  - 做法：`remote::ssh_cli_opts()` 单一 `-o` 参数向量 + SessionBuilder 调优（现 3 套：SftpFs 15s+ServerAlive、remote_which 15s+ServerAlive、agent tunnel **30s 无 ServerAlive 可挂死**）；`SSH_CONNECT_TIMEOUT` 定义两遍合一。
  - 验收：agent tunnel SSH 获得心跳；常量单一来源。

- [ ] **P4-5 Host 侧 VaultEventBus**（V34）
  - 做法：tokio broadcast channel；watcher/sync/connector/import/remote session 发布；订阅者：wiki 索引调度、caps 失效、catalog 对账；单一桥转发所有窗口。
  - 验收：多窗口打开同 vault 只重建一次索引；renderer 不在场时 headless 写入（CLI/agent 子进程）也能触发 Host 对账；React hook 只剩纯视图反应。

- [ ] **P4-6 事件 payload 公有化**（V26）
  - 做法：所有 emit payload 改公有命名结构体（derive specta::Type），删 `events_contract.rs` 的手写镜像与 ~500 行源码扫描器（编译器接管不变量）；bridge host 的 `listen_any`+JSON 重解析暂保留（解耦合理，profile 出现热点再改 typed tap）。
  - 验收：events_contract.rs 缩至事件名常量表 + 少量形状测试；payload 漂移在编译期暴露。

- [ ] **P4-7 错误 code 全面化**（V32 续 P1-6）
  - 做法：高频文件机会主义迁移（bridge/host、mineru、parse、translate 是 message() 大户）；`ErrorBody.details` 去掉 `#[specta(skip)]` 补进 TS 类型（前端 wiki rename 恢复路径已依赖 details，手工 RuntimeErrorBody 可删）。
  - 验收：`AppError::message` 新增调用为零（grep CI 或 clippy 检查）；zh-CN 错误 toast 可按 code 映射（前端 `translateHostError`，缺 key 回退原文）。

---

## P5 · Paper 域与 Agent 域

### Paper

- [ ] **P5-1 PaperUnit / PaperLayout 领域类型**（P0-5 的架构化版本）
  - 做法：统一回答"论文根在哪 / 文件属于哪篇论文 / 主 PDF 是什么 / 哪些是正文源 / 哪些是支撑材料"；树、rescan、Doctor、CapsCache、同步消费同一分类；保留老 Vault 兼容探测。
  - 验收：caps 分类逻辑单点；新增资产类型或改目录布局只改一处。

- [ ] **P5-2 move/trash/restore 用例统一**（V7）
  - 做法：CLI move 接入 `run_local_rename_transaction`（或显式 headless 降级：移动 + 输出"存在 stale 双链，运行 doctor 修复"提示）；`commit_paper`/`move_paper`/`trash_paths`/`restore_item` 形成带预检/操作计划/补偿规则的用例层，各入口只做参数转换与自身策略（connector 时限、zotero linkage、桌面脏文件信息）。
  - 验收：CLI 与桌面移动后双链状态一致（测试同表驱动）。

- [ ] **P5-3 解析调度收敛 PaperPreparation**
  - 现状 11 处入队点（paper_commit、core download、DownloadAssets runner、recognize 完成、reconcile×4、jobs spawn helper、桌面 refs、remote bridge）；且 `parse_app` 从下载进度上下文的 `app` 字段偷取（`paper_import/mod.rs:224-228`），`Deferred` 策略硬编码 None 抑制调度。
  - 做法：`PaperPreparation` 依据最终身份/已有资产/缺失产物/入口策略生成任务计划；commit/download/recognize 返回明确结果由用例安排后续；`HostHooks` 的业务 spawn 回调逐步退场。
  - 验收：入队点 11 → ≤3；"识别完成路径稳定后再解析"与"connector 附件齐再处理"成为显式策略字段。

- [ ] **P5-4 DocumentExtraction 共享提取**（V12）
  - 做法：MinerU 正文+版面共享一次 provider 执行与原始产物（复用键：PDF 内容摘要+服务地址+模型+选项）；先合并进行中的相同请求，再做可重建缓存；按消费者管理取消；Paddle 不同模型保持独立执行。
  - 验收：同一 PDF 双引擎场景只上传/计费一次。

- [ ] **P5-5 settings 直读收敛**（V39）
  - 做法：6 模块/10 处直读改为 job 参数注入或既有 subscribe 反应（paper/import 的 4 处优先，runner 收 `NoteShellMode`/backend 作为参数）。
  - 验收：features 对 `AppSettingsStore` 的 State 依赖清零（settings 壳与装配层除外）。

### Agent

- [ ] **P5-6 service 单一入口**（V18）
  - [ ] `agent_warm` 编排下沉 `service::warm`（对齐 run_once/list_sessions 模式）
  - [ ] `agent_probe` 改调 `service::probe_catalog`，删逐字复制的内联版
  - [ ] lifecycle 补 service 包装（`run_lifecycle`/`cancel_lifecycle`）
  - 验收：commands 层只剩参数转换；service.rs 成为唯一编排者。

- [ ] **P5-7 AgentCtx 聚合 + 连接装配收敛**（V19）
  - [ ] 5 个分散 managed state（Registry/RunController/WarmGate/3 gates）聚合为 `AgentCtx` 按域分组，命令签名从 7 个 State 参数降为 1-2 个
  - [ ] 5 处连接装配抽 `agent_connection::build(spec) -> Client`（builder+terminal handler+deny-permission+connect_with 样板）
  - 验收：新增 agent 命令不再手拼 5 个 State；装配点 5 → 1。

- [ ] **P5-8 runtime 与窗口解耦**（V17）
  - 做法：`RunEventSink` trait（`emit(event, payload)`），窗口实现（emit_to webview）与 bridge 实现（直接进转发通道）各自适配；`accept_run_once` 去 `WebviewWindow` 参数；bridge 删 `get_webview_window("main")` 狩猎与 `listen_any` 窃听。
  - 验收：无桌面窗口（headless/仅移动端连接）可运行 agent；事件路由由调用方身份决定。

- [ ] **P5-9 ExecutionTarget 统一执行环境**（V16/V22）
  - 做法：`ExecutionTarget` 同时决定主进程启动（本地 spawn / ssh stdio）、cwd、terminal executor、声明的 ACP capabilities；远端 run 的 `terminal/create` 走 SSH exec 或明确返回 unsupported；删 `is_ssh()`/`is_local_sim()` 4 处调用点分支（改多态）。
  - 验收：远端 agent 的终端命令在远端执行（或明确报不支持）；flag 分支归零。

- [ ] **P5-10 agent 杂项**
  - [ ] PATH 探测缓存（TTL 或 registry 快照）+ `spawn_blocking`，消 `agent_run_once` 全量重扫（V20）
  - [ ] 取消改 typed error（`AppError::cancelled`，P1-6 构造器）替代 `Ok + stop_reason:"cancelled"`（V21）
  - [ ] acp/ 层纯化：`updates.rs`/`interaction.rs` 的 UI emit 经由注入的事件口而非直接持 `AgentEventEmitter`（为后续抽独立 acp crate 铺路）（V40）

---

## P6 · core/host 收尾（纯机械，最后做）

- [ ] **P6-1 别名与 glob 清理**（V36）
  - [ ] 删 core `features/mod.rs` 12 个扁平别名；core 内部 ~150 处自用迁移到语义路径（`crate::features::catalog` → `crate::features::paper::catalog` 等，rg 可机械替换）
  - [ ] src-tauri 14 处 `pub use …::*` glob 改具名模块重导出（`pub use agentero_core::features::vault as svc;`）或显式清单
  - 验收：任一符号 grep 只有一个规范路径；core 的 pub 面不再无差别暴露给 host。

- [ ] **P6-2 物理搬运归位**
  - [ ] `app/open_request/` → `features/open_request/`（app/ 只留 desktop 命令壳）
  - [ ] `features::cli_install`（`#[path]` 挂载自 `agent/install/`）独立目录或并入 `system/`；消磁盘位置与模块身份不一致
  - 验收：全仓库 `#[path]` 重挂载数 2 → 0。

- [ ] **P6-3 tauri-free 模块下沉 core**（核实：**无需 ConfigProvider**，settings 读取都在 commands 壳）
  - [ ] `features/markdown/search`（373 行，已 tauri-free 且零 settings）
  - [ ] `features/paper/import/recognize`（1416 行，配置已以函数参数存在，仅需去 desktop cfg gate）
  - [ ] `features/paper/discovery/recommend` mod（807 行）
  - [ ] `features/paper/discovery/coolpapers` mod+page（860 行；`proxy.rs` 绑 tauri URI scheme，留守）
  - 验收：~3.4k LOC 回归 core；CLI 可直接消费（recommend/recognize 接入 headless 命令为可选后续）。

- [ ] **P6-4 下载器合并 `core::asset::ensure_asset()`**（V37）
  - 做法：合并两者互补特性（sha256 校验+解包+chmod+多源回退+节流进度+取消），保持 `.partial`+rename 原子性；`core/fs/store.rs::atomic_write` 不适用流式大文件，新写流式变体。
  - 验收：agent 安装与模型下载共用一个模块；两个旧文件删除。

---

## 明确不做（防止 scope creep）

1. **不为拆而拆 jobs/mod.rs**——去业务化 + 迁 platform 后体积自然缓解。
2. **不统一三个 wire 协议**（ACP 外部版本化 / bridge E2EE 二进制帧 / connector REST）——强行统一零收益，只抽 `rpc::PendingTable` 级别的关联机制（已并入 P4-3/4 范围外，需要时单独立项）。
3. **不引入 ConfigProvider trait**——核实证明四个"滞留"模块本就 tauri-free，直接搬（P6-3）。
4. **不动**：`core::http` 客户端工厂、`HostHooks` 倒置缝、settings 订阅反应模式、MCP tunnel 监督者、ACP terminal 管理、`core/time.rs`、`run_blocking` 纪律、`set_layout_backend_source` 注入模式（这些是全仓库最佳实践，是其他统一工作的模板）。
5. **不做 crate 三拆**（infra/domain 分离）——待 P2-P6 业务边界收敛后按 `docs/development/crate-split-roadmap.md` Phase 3 另行评估。

## 进度总览

| 阶段 | 主题 | 任务数 | 状态 |
|---|---|---|---|
| P0 | 正确性修复 | 8 | 未开始 |
| P1 | IPC 契约统一 | 6 | 未开始 |
| P2 | trait Vault 统一 | 6 | 未开始 |
| P3 | Jobs 去业务化 | 5 | 未开始 |
| P4 | 横切基础设施 | 7 | 未开始 |
| P5 | Paper 域 + Agent 域 | 10 | 未开始 |
| P6 | core/host 收尾 | 4 | 未开始 |

推进节奏建议：P0 全部 → P1-1/P1-2 → P2-1/P2-2（trash 最安全）→ 其余按需并行。P0 与任何阶段可穿插。
