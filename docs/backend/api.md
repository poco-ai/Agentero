# Agentero / notemd 后端 API 规范


## 1. 分层定位

```text
Frontend (React)
       │ Tauri invoke / event
       ▼
Host (Tauri + Rust)
```

- **Frontend ↔ Host**：`invoke('namespace:command')` 请求响应，配合 Tauri event 做进度/流式推送。
- Host 对所有 provider（含 Codex）统一作为 **ACP Client**；Codex 经 `@agentclientprotocol/codex-acp` 适配器接入标准 ACP 协议。Frontend 只面对下方 `agent:*` 命令与事件，**不** 直接暴露底层 RPC 细节。

## 2. 通用约定

### 2.1 命名规范

- Tauri command：`namespace:verb`（全小写，冒号分隔命名空间）。
  - 规划契约多用 `namespace:verb`（如 `vault:open`）；已落地的 invoke 名以 `src-tauri` 为准（如 `vault_create`、`vault_ensure`、`window_new`、`graph_get_graph`）。

### 2.2 参数与返回

- 所有请求统一通过对象传参。
- 返回结构：
  - 成功：`{ "ok": true, "data": T }`
  - 失败：`{ "ok": false, "error": { "code": "...", "message": "...", "details"?: {} } }`
- 流式结果通过 Tauri event 推送，不占用返回通道。

### 2.3 路径表示

- Vault 内路径统一使用相对路径（UNIX 风格 `/`），以 Vault root 为基准。
  - 例：`papers/1706.03762/NOTES.md`、`notes/transformer.md`。
- Host 负责把相对路径解析为本地绝对路径，并校验路径白名单。

### 2.4 事件约定

Host 通过 Tauri event 向前端推送事件。文件系统、任务和菜单事件可广播；`agent:*` 事件必须由 Host 使用 `emit_to` 定向到发起 `agent_run_once` 或 `agent_warm` 的 WebviewWindow，前端也必须通过当前 WebviewWindow 注册 listener。发射与监听两端使用相同窗口 label，避免多窗口之间串流、误消费终态或覆盖 Composer 配置。

| 事件名 | 触发时机 | payload 关键字段 |
|---|---|---|
| `vault:file-changed`（已实现） | Vault 内文件被外部/Agent 改动（Host `notify` 监听，按窗口 `emit_to` 定向） | `{ paths: string[], kind: 'create' \| 'modify' \| 'remove' \| 'rename' \| 'other', rename?: { from: string; to: string } }`（绝对路径；`.agentero/`、`.git/`、`node_modules/` 已过滤；`rename` 仅表示单个可信 old/new 配对） |
| `arxiv:progress` | arXiv 入库进度更新 | `{ job_id: string, stage: string, progress?: number, message?: string }` |
| `arxiv:completed` | 入库完成 | `{ job_id: string, paper: Paper, created_paths: string[] }` |
| `arxiv:failed` | 入库失败 | `{ job_id: string, error: AppError }` |
| `pdf:progress` | 本地 PDF 入库进度更新 | `{ job_id: string, stage: string, progress?: number, message?: string }` |
| `pdf:completed` | PDF 入库完成 | `{ job_id: string, paper: Paper, created_paths: string[] }` |
| `pdf:failed` | PDF 入库失败 | `{ job_id: string, error: AppError }` |
| `agent:stream` | Agent 流式输出 | `{ sessionId, chunk, kind: "message" \| "thought" }`（`thought` = reasoning）；Host 按 ~40ms 窗口合并连续同 kind chunk 再 emit（kind 切换、tool/plan、完成/失败前先 flush 保序），payload 结构不变 |
| `agent:tool` | Agent tool call 创建/更新 | `{ sessionId, toolCallId, title?, kind?, status?, input?, output?, full? }`；`input`/`output` 超过 32KB 时 Host 截断为「头部 + truncated 标记」字符串（前端仅做预览展示） |
| `agent:plan` | ACP 执行计划 | `{ sessionId, entries: { content, status, priority }[] }` |
| `agent:usage` | 上下文 token 用量 | `{ sessionId, used, size }` |
| `agent:session-info` | ACP `session_info_update` 通知：Agent 推送会话元数据（标题/最近活动时间） | `{ sessionId, agentId, providerSessionId?, title?, updatedAt? }`；仅当 title/updatedAt 至少一个非空时 emit，前端按 sessionId 或 providerSessionId 匹配会话记录并更新标题 |
| `agent:models` | Agent 上报可用模型 | `{ sessionId, agentId, configId, currentId, models: { id, name, group? }[] }`；`currentId` 若不在 selector 目录中会被 Host 注入到 `models`（第三方 / 网关默认模型） |
| `agent:collaboration` | 会话模式（UI「模式」；Codex `collaboration_mode` Default/Plan） | `{ sessionId, agentId, configId, currentId, modes: { id, name, description? }[] }`（无上报则不 emit；UI 仅显示 name） |
| `agent:effort` | ACP 上报 reasoning effort 选项 | `{ sessionId, agentId, configId, currentId, efforts: { id, name, description? }[] }` |
| `agent:fast-mode` | ACP 上报 Fast 开关状态 | `{ sessionId, agentId, configId, enabled }` |
| `agent:completed` | Agent 回答完成 | `{ sessionId, messageId, content, reasoning?, sources, stopReason? }` |
| `agent:failed` | Agent 调用失败 | `{ sessionId, error }` |
| `agent:permission-request` | 权限「每次询问」档：ACP 权限请求转交用户 | `{ requestId, sessionId, title, kind?, paths, options: { optionId, name, kind }[] }` |
| `agent:elicitation-request` | form elicitation（Codex request_user_input） | `{ requestId, sessionId, message, toolCallId?, fields: { id, title, description?, required, kind, options[] }[] }` |
| `agent:ask-user-request` | Grok `_x.ai/ask_user_question` | `{ requestId, sessionId, toolCallId?, mode, questions: { question, options[{label,description?}], multiSelect, allowOther }[] }` |
| `background-task:progress` | 下载/解析任务进度 | `{ taskId, phase, downloadedBytes, totalBytes?, progress? }`；下载阶段的字节进度由前端聚合为总体进度（PDF 映射到 0–50%，TeX 映射到 50–100%），解析阶段显示为处理中，任务完成时为 100%。Host 对字节级进度做节流：百分比变化 ≥1 个点或距上次 emit ≥100ms 才发事件，下载完成时必发最终值 |
| `paper:imported`（已实现） | `paper_commit` 成功（catalog 已写入、NOTES 已建）；本地与远程导入路径统一发；`paper_download_assets` 为孤儿文件夹补建 catalog 行时也发 | `{ vaultId, paperId, timestamp }`（`vaultId` 为 vault 根路径，远程为 `remote:<sessionId>`） |
| `paper:assets-ready`（已实现） | 论文资产就绪：同步下载完成 / 本地 PDF 拷贝完成 / `DownloadAssets` job 成功 | `{ vaultId, paperId, timestamp }` |
| `job:completed`（已实现） | job 状态机真实迁移到 `Succeeded` 时由 `job:changed` 单点派生 | `{ jobId, kind, paperId?, timestamp }` |
| `job:failed`（已实现） | job 状态机真实迁移到 `Failed` 时由 `job:changed` 单点派生 | `{ jobId, kind, paperId?, error?, timestamp }` |
| `window:closed`（已实现） | 子窗口销毁（`on_window_event(Destroyed)`）。经 lifecycle bridge 转发进前端 bus，消费者集中在 `lifecycle/register.ts` | `{ kind: 'settings' \| 'feature', view? }`（无 `timestamp`） |

#### `agent_warm`

打开 Chat 时后台预热 provider（不发用户 prompt）。所有 provider（含 Codex）通过 ACP `initialize` + `session/new` 获取配置（模型、effort 等经 `SessionConfigOption` 协商）。

- **参数**

```ts
{
  agentId?: string;
  vaultPath?: string;
  modelId?: string; // preferred ACP model config value
  collaborationModeId?: string; // preferred session mode (default / plan)
}
```

- **返回** `WarmResult`：`{ agentId, ok, models?, usageUsed?, usageSize?, error? }`

### 2.5 执行线程约定（重 IO command 必须 async）

- 同步 `#[tauri::command]` 在主线程内执行；Windows 主线程即 UI 消息泵，重 IO 同步 command 执行期间整窗冻结。
- **重 IO command（扫盘、SQLite、全库索引、字体/大文件读取等）必须写成 `async fn`**，阻塞体统一用 `core::blocking::run_blocking`（内部 `tauri::async_runtime::spawn_blocking`）移出调用线程；对外返回 JSON 结构不变，前端 invoke 透明。
- 使用 `State<'_, T>` 的 async command 受 Tauri 限制必须返回 `Result`（惯例 `Result<ApiResult<T>, String>`，恒为 `Ok(...)`）。`std::sync::Mutex` guard 不能跨 `await`：把「拿锁 + 干活」整体放进 `run_blocking` 闭包，State 先 clone 出可 `Send + 'static` 的 Arc 句柄（如 `WikiIndexState::handle()`、`CapsCache`、`ExternalRenameRepairStore`）。
- 已按此约定改造：`vault_*`（create/ensure/tree_build/tree_children）、`wiki_*` 全部、`graph_*`、`vault_search`、`paper_*`（catalog）、`usage_*`/`activity_record_events`、`zotero_sync`/`zotero_scan`、`doctor_*`（除纯内存的 `doctor_set_dirty_paths`）、`list_system_fonts`（另有进程级缓存）、`export_system_cjk_font`、`paper_stage_import_file`、`paper_refs_list`、`connector_set_enabled`/`connector_set_port`（bind 改真 async，不再 `block_on`）。

## 3. Host 层 Tauri invoke API

### 3.1 Vault 与窗口

> **实现状态（V0.1）**  
>
> - 已实现：`vault_create`、`vault_ensure`（snake_case invoke 名）、`vault_allow_fs_scope`、`vault_tree_build` / `vault_tree_children`、`path_open_in_terminal`、`path_trash`（+ `path_list_trash` / `path_restore_item` / `path_purge_item` / `path_purge_trash`）、`window_new`、`set_locale`。  
> - 打开 Vault / 最近列表：当前主要由前端 `plugin-fs` + `localStorage`/`sessionStorage` 完成；本地树加载走 Host `vault_tree_build`（一次 IPC）；打开或恢复时会调用 `vault_ensure` 补种 bundled skills，并按 frontmatter `version` 安全升级未定制的第一方 Skill。Host 侧 `vault:open` / `vault:recent` 仍为规划契约。
> - 实际 command 注册见 `src-tauri/src/lib.rs`。

#### `vault_create`（已实现）

创建并初始化一个 Vault（前端 dialog 选路径后 `invoke("vault_create", { path })`）。

- **参数**

```ts
{
  path: string; // 本地绝对路径
}
```

- **返回**（`ApiResult<CreateVaultResult>`）

```ts
{
  ok: true;
  data: {
    path: string;
    created: string[]; // 创建的目录/文件相对路径列表
    updated: string[]; // frontmatter version 更低后安全升级的第一方 Skill
    openPath: string;  // 建议首开，如 AGENTS.md
  };
}
```

- **行为**
  - 确保目录存在；脚手架 `papers/`、`notes/`、`.agentero/`、**`.agents/`**、**`.agents/skills/`**。
  - 初始化 `.agentero/catalog.sqlite`（schema 当前版本，含 Translator 元数据列）。详见 [`catalog.md`](catalog.md)。
  - 写入默认 `AGENTS.md`（若不存在）。
  - 写入 **`.agents/README.md`**（若不存在；内容来自仓库 `templates/vault/.agents/`）。
  - 种子 **bundled skills**：`paper-reader`、`author-lookup`、`agentero-cli`、`vault-normalizer`、`idea-evaluator`、`deep-research`（后两者含 `references/`，来自 [Supervisor-Skills](https://github.com/HKUSTDial/Supervisor-Skills)，**CC BY-NC-SA 4.0**；另写 `skills/README.md` 与 `LICENSE-Supervisor-Skills.txt`）。
  - **不**创建根级 `PAPERS.md` / `library.bib`；已有第一方 `SKILL.md` 按 frontmatter 整数 `version` 升级（见 `vault_ensure`）；用户去掉/抬高 `version` 的修改与其它 `.agents/**` 文件保持原样。
  - 最近列表由前端在成功打开后写入 `localStorage`（`agentero-recent-vaults`）。

#### `vault_ensure`（已实现）

幂等脚手架 / 同步 bundled skills（Host `ensure_vault`，与 `vault_create` 同一实现）。**打开或恢复 Vault 时**前端调用，以便应用更新后补充新 Skill，并安全升级未定制的第一方 Skill。

- **参数**

```ts
{
  path: string; // 本地绝对路径
}
```

- **返回**：同 `vault_create`（`ApiResult<CreateVaultResult>`；`created` 仅含本次新建路径，`updated` 仅含本次安全升级路径）。

- **策略**
  - **补缺失**：目录 / `AGENTS.md` / 模板里有而盘上没有的 skill 文件。
  - **安全升级**（第一方 `SKILL.md`）：盘上 frontmatter 整数 `version` **低于** 模板 → 写入新版（后续升级只需 bump `version`）。同版本 / 更高版本 / 无 `version` → **不**覆盖。
  - **保留定制**：去掉或抬高 `version` 后的用户 `SKILL.md`、第三方 Skill 和 references 保持原样。
  - 应用升级新增的 skill（如后续模板里加的 id）会在下次打开 Vault 时自动出现。
  - 前端：`created` 与 `updated` 分别触发新增/升级 success toast；均为空时不打扰。

#### `vault_allow_fs_scope`（已实现）

把本地 Vault 目录加入 `tauri-plugin-fs` 的**运行时 scope**（`fs_scope().allow_directory(path, recursive=true)`）。

- **参数**：`{ path: string }`（本地绝对路径）。**返回**：`ApiResult<null>`。
- **动机**：静态 scope 仅允许 `$HOME/**` / `$DOCUMENT/**` / `$DESKTOP/**` / `$DOWNLOAD/**`（`capabilities/default.json`）。dialog 选目录时 Tauri 会为该目录授予运行时 scope，但**不持久化**；重启后恢复位于上述根之外的 Vault（如 `D:\…`）会让每次 `plugin-fs` 调用（`readDir` / `readTextFile` / `exists`）报 **`forbidden path`**，直到再次用 dialog 打开。
- **调用点**：前端 `ensureLocalFsScope(root)`（`src/lib/vault`，按根去重、并发共享同一 grant、幂等）在**任何 `plugin-fs` 读之前**调用 —— `loadVaultTree`、`loadTabResources`（恢复的标签页与树并发加载）、启动时校验恢复路径是否存在的 effect。远端 handle / 非 Tauri 环境为 no-op。

#### `vault_tree_build` / `vault_tree_children`（已实现）

本地文件树由 Host **一次 IPC** 构建（此前前端用 `plugin-fs readDir` 逐目录串行递归，目录数 = IPC 往返数）。远端 Vault 仍走 `remote_list` 的 TS 递归。

- **`vault_tree_build`**：`{ vaultPath: string }` → `ApiResult<VaultTreeNode[]>`，一次递归 walk 返回整棵树。
- **`vault_tree_children`**：`{ vaultPath: string, dirPath: string }` → `ApiResult<VaultTreeNode[]>`，列出单个目录的子节点；用于懒展开与 watcher 触发的**按路径局部刷新**。`dirPath` 必须在 Vault 内，否则报错。

```ts
type VaultTreeNode = {
  name: string;
  path: string;              // 绝对路径（前端映射为 FileNode，id = path）
  kind: "file" | "directory";
  children?: VaultTreeNode[];
  childrenPending?: boolean; // 懒目录：未列出，展开时经 vault_tree_children 加载
  hasTex?: boolean;          // 仅论文 source/ 懒壳：磁盘上是否存在 .tex/.ltx
};
```

- **语义**（Rust `features/vault/tree.rs`，与 `src/lib/vault/tree.ts` 的远端路径保持一致）：
  - eager 根（`papers/` / `notes/` / `.agents/`）全量递归；其它根目录列一层，子目录 `childrenPending`。
  - **论文文件夹内的 `source/`**（含 `metadata.json` / `NOTES.md` / `PAPER.md` 任一 marker 的目录）不再递归 —— arXiv e-print 解压产物动辄上百文件，标记 `childrenPending` 懒加载；这里的 marker 只用于 Host 判断 `source/` 是否懒加载，不单独决定前端是否把目录识别为论文。前端论文识别会优先保留含嵌套论文的组织目录，并在已有论文路径列表时按该列表归属文件。壳上附带 `hasTex`，供前端 Download 判定（`paperAssetDownloadReasons`）识别被懒加载藏住的 TeX；探测复用按论文目录键控的 `CapsCache`（watcher 对能力相关文件失效缓存），避免每次整树构建都递归 walk 每篇论文的 `source/`（NTFS 上尤其昂贵）。
  - 忽略名（`.git` / `.venv` / `node_modules` / `*.egg-info` / 其它 dot 名，白名单 `.agents` / `.env.example`）与深度上限 12 同前端规则。
  - 排序仍在前端（`sortNodes`，locale 感知）。
- **局部刷新**：`vault:file-changed`（非 `modify`）携带的路径经 `collectTreeRefreshTargets`（`src/lib/vault/tree.ts`）映射到已加载的最近祖先目录节点，防抖 400ms 后仅对这些目录调 `vault_tree_children` 打补丁；根级变化 / 目标过多（>8）/ 无路径信息时回退整树 `vault_tree_build`。

#### 远程 Vault（SSH/SFTP，MVP 已实现）

设计见 [`remote.md`](remote.md)。前端伪路径 `remote:<sessionId>`；文件权威在远端。

| Command | 说明 |
|---|---|
| `remote_connect` | `{ host, user?, remotePath }` → `RemoteSessionInfo`（含 `vaultHandle`、`caps`） |
| `remote_ssh_config_hosts` | `()` → `[{ alias, user?, hostname?, port? }]`，解析 `~/.ssh/config`（含 `Include`），供连接对话框联想 |
| `remote_disconnect` | flush catalog + 拆会话 |
| `remote_list` | 列目录 |
| `remote_read_text` / `remote_write_text` / `remote_write_bytes` | 读写 |
| `remote_mkdir` / `remote_remove` | 建目录 / 删除（可 recursive） |
| `remote_paper_list` / `remote_paper_get` | catalog 工作副本 |
| `remote_paper_rescan` / `remote_paper_set_tags` / `remote_paper_set_is_read` | mutation 后 PUT 远端 |
| `remote_cache_file` | PDF 等缓存到本机 ephemeral 路径（mtime 键 + LRU 2 GiB） |
| `remote_cache_stats` | `{ sessionId? }` → `{ bytes, files, root, maxBytes }`（无 session 则汇总全部） |
| `remote_cache_clear` | `{ sessionId? }` → `{ freedBytes }` 清除 blob 缓存 |
| `remote_agent_scan` | 目录模板 + 远端 PATH 扫描 → `CatalogEntry[]`（设置页远端 Agent） |
| `remote_agent_probe` | `{ sessionId, templateId }` → 远端 ACP `initialize`（应用 Agent 代理 env） |
| `remote_agent_open_install_terminal` | 本机终端确认后 `ssh -t` 在远端执行模板 `install_command`（如 Claude ACP 适配器） |
| `remote_vault_ensure` | `{ sessionId }` → 通过 SFTP 补种 bundled skills，并按相同 frontmatter `version` 规则安全升级第一方 Skill |

Host 还支持 `__local_sim__` host（本机目录当远端，单测/开发用）。

**远程超时与保活**：SSH/SFTP 建连、SFTP subsystem 启动和远端根目录校验默认最多 15 秒；每次 SFTP 文件操作默认最多 30 秒。SSH 使用 `ServerAliveInterval=30` 和 `ServerAliveCountMax=3`，约 90 秒无响应后判定连接失效。远端 Agent `which` 探测最多 30 秒；远端 ACP Agent 仅限制 15 秒建连，不限制正常运行时长。当前不自动重连、不重放写操作，详见 [`remote.md`](remote.md) §2.1。

**入库入口与远程 Vault**：

| 入口 | Command | 远程 `remote:…` |
|---|---|---|
| 魔棒标识符 | `lookup_import_batch` | ✅ staging → SFTP → catalog PUT |
| 魔棒 Skill 导入 | `skill_install` / `skill_discard` | ❌ 仅本地 Vault |
| 补资源 Download | `paper_download_assets` | ✅ |
| 本地 PDF | `paper_import_local_pdf` | ✅ 本机选 PDF → 上传远端 |
| Bib/RIS 库导入 | `paper_import` | ✅ Translator → 上传远端 |
| Zotero 桌面迁移 | `zotero_migrate` | ❌ 仅本地路径 |
| Zotero Connector | HTTP `saveItems` / `saveAttachment` | ✅ 绑定 `remote:<sessionId>`；stage → SFTP → catalog PUT |
| CLI import | `agentero import` | ❌ 仅本地 vault 路径 |
| 回收站 | `path_trash` / `path_list_trash` / restore / purge | ✅ 经 `trash_bridge` 写远端 `.agentero/.trash/` |

返回的 `paperDir`（远程）为 `remote:<sessionId>/papers/…`。

Agent：`agent_run_once` / `agent_warm` 在 vault 为 `remote:…` 时经 SSH `bash -lc` 启动远端 ACP（含 Codex，经 `codex-acp` 适配器）。

#### `path_open_in_terminal`（已实现）

在系统默认终端中打开本地路径（文件树右键 / `⌥⌘T`「在终端中打开」）。

- **参数**

```ts
{
  path: string; // 本地绝对路径
}
```

- **返回**（`ApiResult<{ cwd: string }>`）
  - 成功时 `cwd` 为实际作为终端工作目录打开的绝对路径。
- **行为**
  - 路径为**目录**时：`cwd` = 该目录。
  - 路径为**文件**时：`cwd` = 父目录。
  - 路径不存在或无法解析父目录时返回错误。
  - 平台：
    - macOS：`open -a Terminal <cwd>`
    - Windows：优先 `wt -d <cwd>`，失败则 `cmd /K cd /d …`
    - Linux：`xdg-terminal-exec` → `$TERMINAL` → 常见终端（gnome-terminal / konsole / …）→ `x-terminal-emulator`

#### `path_trash`

可恢复删除：把项移入 Vault 回收站 `.agentero/.trash/<batchId>/`（带 `manifest.json` 记录原路径与被删 catalog 行快照），而非物理删除。**前端不弹 Undo toast**——用户从文件树虚拟节点 `agentero:trash` 打开的**中间栏回收站视图**（`RecycleBinView`）浏览 / 恢复 / 永久删除；**清空**在侧栏回收站节点右键菜单；恢复走 `path_restore_item`（按项）。

- **`path_trash` 参数**

```ts
{
  vaultPath: string;
  rels: string[]; // 待删除的 Vault 相对路径
}
```

- **`path_trash` 返回**（`ApiResult<{ batchId: string; count: number }>`）
  - `batchId` 标识批次（浏览/恢复用）；`count` 为实际移入回收站的项数。
  - `papers/` 下的项：**先移文件**，再快照并删除 catalog 行（含嵌套 paper），避免幽灵 catalog。
  - 跳过空 / 含 `..` / `.agentero` / `papers` 根 / 不存在的路径。

#### `path_list_trash` / `path_restore_item` / `path_purge_item` / `path_purge_trash`

回收站浏览：中间栏 `RecycleBinView`（虚拟 tab `agentero:trash`）用这些命令列出 / 恢复 / 永久删除已删项。

- **`path_list_trash`**（`{ vaultPath }` → `ApiResult<TrashEntry[]>`）：展平所有批次为逐项条目 `{ id, batchId, stored, rel, name, deletedAt, isDir }`，按删除时间倒序。
- **`path_restore_item`**（`{ vaultPath, batchId, stored }` → `ApiResult<{ rel: string }>`）：把单项移回原位并 `upsert` 恢复其 catalog 行；原路径已占用则报错；批次清空后删除批次目录。
- **`path_purge_item`**（`{ vaultPath, batchId, stored }` → `ApiResult<null>`）：永久删除单项（不可恢复）。
- **`path_purge_trash`**（`{ vaultPath }` → `ApiResult<null>`）：清空整个回收站（不可恢复）。

#### `window_new`（已实现）

打开一个新的 Agentero 窗口（菜单 **File → New Window** / `⌘N`）。

- **参数**：无
- **返回**：`Result<(), String>`
- **行为**
  - 创建 label 为 `agentero-<uuid>` 的 Webview 窗口，URL 带 `?fresh=1`（不自动恢复上次 Vault）。
  - 窗口尺寸 / macOS overlay 标题栏与主窗口一致。
  - 窗口初始隐藏，由全局 page-load hook 在页面加载完成后显示；首个 React commit 前显示静态启动壳。
  - Capability 覆盖 `main` 与 `agentero-*`（见 `src-tauri/capabilities/default.json`）。
  - 菜单点击由 Host 直接调用，不经过前端 event 往返（Host 内用 `tauri::async_runtime::spawn` 调用）。
  - **必须是 `async` command**：同步 command 在主线程、且处于调用方 webview 的 IPC 回调内执行，Windows 上从那里 build webview 会卡死（wry 进入嵌套消息循环等 WebView2 controller 回调，而该回调要等当前处理器返回），新窗口表现为空白且无法关闭。

#### `feature_window_open`（已实现）

打开（或聚焦）右侧功能视图的 **单例** 原生窗口（Agent / Backlinks / Annotations / References）。

- **参数**

```ts
{
  view: "agent" | "backlinks" | "annotations" | "references";
  vaultPath?: string | null;
  activePath?: string | null;   // initial follow-active path for the popout
  paperTitle?: string | null;
  title?: string | null;        // localized OS window caption from frontend t()
}
```

- **返回**：`Result<(), String>`
- **行为**
  - label 为 `feature-{view}`；已存在则 `set_focus`。
  - URL：`index.html?window=feature&view=…&vault_path=…&active_path=…&paper_title=…`（轻量 Feature 根，不加载完整 App Dock）。
  - 窗口关闭时 Host 向所有窗口 `emit("window:closed", { kind: "feature", view })`。
  - **必须是 `async` command**（同 `window_new`）。

#### `feature_window_close`（已实现）

关闭指定功能单例窗（不存在则 no-op）。

- **参数**：`{ view: "agent" | "backlinks" | "annotations" | "references" }`
- **返回**：`Result<(), String>`

#### `doc_window_open`（已实现）

打开（或聚焦）单个文档的原生窗口。

- **参数**

```ts
{
  path: string;           // absolute vault file / paper path
  mode?: string | null;   // pdf | html | markdown | image …
  vaultPath?: string | null;
  title?: string | null;  // localized OS caption; falls back to file basename
}
```

- **返回**：`Result<(), String>`
- **行为**
  - label 为 `doc-` + path 的 sha256 前 16 hex；同 path 再开则聚焦。
  - URL：`index.html?window=doc&path=…&mode=…&vault_path=…`。
  - **必须是 `async` command**。

#### `settings_window_open`（已实现）

打开 Settings 原生单例窗口（菜单 **Agentero → Settings…** / `⌘,` / 标题栏齿轮）。

- **参数**

```ts
{
  section: "general" | "appearance" | "agent" | "translate" | "keyboard" | "about";
  vaultPath?: string | null; // 当前 Vault 路径，用于远端 Agent 页上下文
}
```

- **返回**：`Result<(), String>`
- **行为**
  - 若 label 为 `settings` 的窗口已存在，则将其聚焦并返回；否则新建。
  - URL 带 `?window=settings&section=...&vault_path=...`，由 `src/main.tsx` 分支渲染轻量 Settings 页面（不加载完整 `App`）。
  - 新窗口初始隐藏，由全局 page-load hook 在页面加载完成后显示；首个 React commit 前显示静态启动壳。
  - macOS 使用 Overlay 标题栏与原生交通灯；Windows / Linux 使用系统原生窗口边框（OS 自绘标题栏与 caption 按钮）。
  - 窗口关闭时 Host 向所有窗口 `emit("window:closed", { kind: "settings" })`，便于主窗口同步 Settings 打开状态（实现 `⌘,` _toggle_）；建窗失败时也会 emit 一次，避免 toggle 卡在“已打开”。
  - 与 `window_new` 同理，**必须是 `async` command**。

#### `fs_watch_start` / `fs_watch_stop`（已实现）

按窗口启停 Vault 文件系统监听（Rust `notify` 递归监听），用于外部编辑器 / Agent 写盘后自动重载编辑器与文件树。

- **`fs_watch_start`**
  - **参数**：`{ vaultPath: string }`
  - **返回**：`Result<(), String>`
  - **行为**：为当前窗口（label）启动递归监听；若该窗口已有监听则先停止再重建。命中变更时按窗口 `emit_to` 发送 `vault:file-changed`（去抖 ~300ms，过滤 `.agentero/` 内部文件、`.git/`、`node_modules/`；但放行 `.agentero/catalog.sqlite` 及 SQLite sidecar，供前端刷新 Library 元数据）。只有 `notify` 的单事件 `RenameMode::Both`、恰有两条不同路径且均未被过滤时，payload 才带按顺序排列的 `rename.from` / `rename.to`；其它 rename 事件只用于刷新，绝不能授权改写 Vault 内容。前端只将 Markdown、PDF、受支持图片或疑似目录的 rename 交给双链修复/警告；带明确非目标扩展名的 sidecar / 临时文件仅执行常规工作区刷新。
- **`fs_watch_stop`**
  - **参数**：无
  - **返回**：`Result<(), String>`
  - **行为**：停止并释放当前窗口的监听（无监听时 no-op）。窗口 `Destroyed` 时 Host 亦自动停止，避免线程泄漏。
- **前端**：`src/lib/vault/fs-watch.ts` 封装 `startVaultWatch` / `stopVaultWatch`；`App.tsx` 随 `vaultPath` 生命周期启停，并监听 `vault:file-changed`。

#### `vault:open`（规划）

打开一个已存在的 Vault。

- **参数**

```ts
{
  path: string;
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    vault: VaultInfo;
    tree: FileNode[];
  };
}
```

- **行为**
  - 校验 Vault 结构（至少存在 `papers/`、`notes/`；确保 `.agentero/catalog.sqlite` 可打开或可初始化）。
  - 打开 catalog、执行 schema migration；若存在历史 `papers/*/metadata.json` 且 catalog 为空则导入（见 catalog 迁移）。
  - 文件监听由前端打开 Vault 后调用 `fs_watch_start`（已落地；见上），非本命令内隐式启动。
  - 返回完整文件树。

#### `vault_release`

释放 Host 侧为某个 vault 持有的资源。前端在释放 `vault:opened` 作用域时调用（remote handle 跳过）。

- **参数**：`{ path: string }`
- **返回**：`{ ok: true; data: null }`
- **行为**：驱逐该 vault 的 catalog 连接缓存条目。该缓存是进程级、按 vault 根路径索引的，此前唯一的驱逐路径是 `with_catalog` 发现数据库文件消失，因此一次会话中访问过的每个 vault 都会把 SQLite 句柄与 WAL 留到进程退出。对正在进行的 catalog 操作安全：它们持有连接的 `Arc` 克隆，这里只移除缓存条目。
- **不负责**：文件监听。`fs_watch_start` 本身就会替换该窗口的既有 watcher，窗口销毁时由 Host 的 `on_window_event(Destroyed)` 停止。
- **没有 `vault:close` 命令**：vault 的生命期由前端 `vault:opened` 作用域的 teardown 表达，见 [../development/lifecycle-events.md](../development/lifecycle-events.md)。

#### `vault:recent`（规划；前端已临时实现）

获取最近打开的 Vault 列表。

- **规划返回**

```ts
{
  ok: true;
  data: {
    vaults: RecentVault[];
  };
}
```

- **当前实现**：渲染层 `getRecentVaults()` / `rememberRecentVault()` 读写 `localStorage` 键 `agentero-recent-vaults`（MRU，最多 8 条）。后续迁 Host / Tauri Store 时保持该语义。

#### `vault:info`（规划）

获取当前 Vault 元信息。

- **参数**：无
- **返回**

```ts
{
  ok: true;
  data: VaultInfo;
}
```

### 3.2 文件操作

#### `file:read_text`

读取文本文件内容。

- **参数**

```ts
{
  path: string; // Vault 相对路径
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    path: string;
    content: string;
    mtime: number; // 毫秒时间戳
  };
}
```

#### `file:write_text`

写入文本文件。

- **参数**

```ts
{
  path: string;
  content: string;
  create_dirs?: boolean; // 默认 true
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    path: string;
    mtime: number;
  };
}
```

- **行为**
  - 写入时先写临时文件，再原子重命名。
  - 触发 `fs:changed` 事件。

#### `file:list`

列出指定目录下的文件树节点。

- **参数**

```ts
{
  path?: string; // Vault 相对路径，空字符串表示 root
  depth?: number; // 默认 1，-1 表示无限
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    nodes: FileNode[];
  };
}
```

#### `file:create`

创建新文件或目录。

- **参数**

```ts
{
  path: string;
  type: 'file' | 'directory';
  content?: string; // 仅 type='file' 有效
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    path: string;
  };
}
```

#### `file:delete`

删除文件或目录。

- **参数**

```ts
{
  path: string;
  recursive?: boolean; // 默认 false
}
```

- **返回**：`{ ok: true; data: null }`

- **风险**：删除操作不可逆，前端需二次确认。

#### `file:resolve_asset_url`

将 Vault 内资源文件转换为前端可安全加载的 URL。

- **参数**

```ts
{
  path: string; // 如 papers/1706.03762/assets/figure.pdf
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    url: string; // tauri convertFileSrc 后的安全 URL
  };
}
```

### 3.3 arXiv 入库（规划命令）

> 当前未以独立 `arxiv:*` 命令实现。arXiv 输入统一走 §3.6 的 `lookup_import_batch`（含 arXiv Atom fallback）。下列命令保留为后续统一 importer 的参考契约。

#### `arxiv:classify_input`

对用户输入进行分类与意图解析。

- **参数**

```ts
{
  input: string;
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    kind: 'exact_id' | 'url' | 'keyword' | 'topic' | 'description';
    normalized_id?: string; // 当 kind 为 exact_id/url 时
    query?: string; // 当 kind 为 keyword/topic/description 时，整理后的查询串
  };
}
```

#### `arxiv:search_candidates`

检索 arXiv 候选论文。

- **参数**

```ts
{
  query: string;
  max_results?: number; // 默认 10
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    candidates: ArxivCandidate[];
  };
}
```

- **行为**
  - 模糊输入调用 Agent 检索，Agent 可访问 arXiv API。
  - 返回候选包含标题、作者、年份、arXiv ID、摘要片段、推荐理由。

#### `arxiv:import`

启动 arXiv 论文入库任务。

- **参数**

```ts
{
  arxiv_id: string;
  options?: {
    generate_paper_md?: boolean; // 是否强制生成 PAPER.md
    overwrite?: boolean; // 是否覆盖已有目录，默认 false
  };
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    job_id: string;
  };
}
```

- **行为**
  - 异步任务，通过 `arxiv:progress` / `arxiv:completed` / `arxiv:failed` 事件推送结果。
  - 创建 paper 文件夹（默认 `papers/<id>/`，允许 `papers/<org>/…/<id>/`）与 `source/`；**元数据写入 catalog**（`path` = 该文件夹）。
  - 下载 LaTeX source、PDF、HTML 到 `source/`。
  - 无 tex 源或需要可读结构化正文时，生成 `papers/<id>/PAPER.md`。
  - 调用 Agent 生成 `papers/<id>/NOTES.md`。
  - **不**自动更新根级 `PAPERS.md` / `library.bib`（需要时由用户触发 `catalog:export_*`）。

```

### 3.4 本地 PDF 入库（规划命令）

> 当前未以独立 `pdf:*` 命令实现。本地 PDF 统一走 §3.6 的 `paper_import_local_pdf`（后台自动识别元数据，无确认对话框）。下列命令保留为后续统一 importer 的参考契约。

本地 PDF 通过统一 Importer 接入，与 arXiv 共用 `papers/<id>/` 输出结构。入库分两步：先解析并混合获取元数据供用户确认，再正式入库。

#### `pdf:prepare`

对本地 PDF 做轻量解析并混合获取候选元数据，供入库前确认，不落盘。

- **参数**

```ts
{
  paths: string[]; // 本地 PDF 绝对路径，可批量
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    drafts: PdfMetadataDraft[]; // 每篇一个候选元数据草稿
  };
}
```

- **行为**
  - 复制 PDF 到临时目录，提取首页文本并识别 DOI / arXiv ID。
  - 命中标识符时查询 Crossref / arXiv 获取权威元数据；未命中或失败时由 Agent 从正文抽取候选。
  - 生成建议 citekey，并标记与已入库论文的重复情况。

#### `pdf:import`

根据用户确认后的元数据正式入库。

- **参数**

```ts
{
  items: {
    tmp_id: string;             // 对应 pdf:prepare 返回的草稿
    metadata: PdfMetadataDraft; // 用户校对后的元数据
  }[];
  options?: {
    parser?: 'auto' | 'liteparse' | 'mineru'; // 默认 auto：配置并启用则 mineru，否则 liteparse
    overwrite?: boolean;        // 默认 false
  };
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    job_id: string;
  };
}
```

- **行为**
  - 异步任务，通过 `pdf:progress` / `pdf:completed` / `pdf:failed` 事件推送结果。
  - 生成 citekey，落位 `papers/<citekey>/`，**metadata 写入 catalog**（`type=pdf`）。
  - 原始 PDF 存入 `source/`；用选定 `PdfParser` 全文解析生成 `PAPER.md`（PDF 来源必生成）与 `assets/`，`body_source` / `body_quality` 写入 catalog。
  - 调用 Agent 生成 `NOTES.md`。
  - **不**自动写 `PAPERS.md` / `library.bib`。
  - 使用云端 MinerU 前需前端已获用户同意（PDF 将上传第三方）。

```

### 3.5 翻译服务

应用级文本翻译（**非**文献元数据 Translator）。前端 `src/lib/translate/`；设置 → Translate。Agent 路径走 `agent_run_once`。详见 [`../frontend/translate.md`](../frontend/translate.md)。

#### `translate_text`

- **参数**（invoke 字段名 `args`）：
  ```ts
  {
    text: string;
    sourceLang?: string;     // default "auto"
    targetLang: string;      // e.g. "zh-CN" | "en"
    provider?: string;       // tencenttransmart (default) | huoshanweb | deeplx | googleapi | google | deepl | azure | googleCloud | openaiCompatible
    apiKey?: string | null;  // 商用 BYOK；可省略或传同长度 "*" 掩码，Host 从 settings 注入真实密钥
    baseUrl?: string | null; // 商用 provider endpoint override（可选）
    region?: string | null;  // azure 必填
    model?: string | null;   // openaiCompatible 必填
    timeoutMs?: number | null;   // optional; clamped 1s–30s server-side (default 30s); settings probe uses 5000
  }
  ```

- **返回**：`{ ok: true; data: { text: string; provider: string } }`
- **约束**：单次约 ≤ 5000 字符（CNKI ≤800）；默认超时约 30s。无付费 API Key；免费引擎为非官方网页接口。设置页打开默认服务下拉时，对全部免费引擎并行 probe（`timeoutMs=5000`，不含 Agent）。

### 3.5b Zotero Connector 兼容服务

**目标**：Host 在本机 `127.0.0.1:23119` 兼容 [Zotero Connector HTTP Server](https://www.zotero.org/support/dev/client_coding/connector_http_server)，使官方浏览器扩展把保存请求写入当前 Vault。

- **HTTP 契约、安全模型、实现 vs 缺口总表**：见 [`connector.md`](connector.md) **§4.5**（权威）。
- **与魔棒关系**：元数据映射复用 `map_zotero_item`；入口不同（插件 vs ⇧⌘I）。
- **设置**：`connectorEnabled` 默认 `false`；与 Zotero 桌面端 **端口互斥**。
- **实现**：`services/connector/`、`commands/connector.rs`、`src/lib/paper/import/connector.ts`。
- **已挂 HTTP**：`ping`、`saveItems`、`sessionProgress`、`attachmentProgress`、`getSelectedCollection`（含子文件夹 targets）、`updateSession`、`delaySync`、`saveAttachment`、`saveSnapshot`、`saveSingleFile`；另有 `detect`、`savePage`、`selectItems`、`getTranslators`、`proxies` 的安全降级兼容路由。

#### `connector_get_status`

- **返回**：`{ ok: true; data: ConnectorStatus }`

  ```ts
  type ConnectorStatus = {
    enabled: boolean;
    listening: boolean;
    port: number;                 // 23119
    boundAddress: string | null;  // "127.0.0.1:23119"
    lastError: string | null;
    vaultPath: string | null;
    parentDir: string;            // default "papers"
  };
  ```

#### `connector_set_enabled`

- **参数**（`args`）：`{ enabled: boolean }`
- **返回**：`{ ok: true; data: ConnectorStatus }`（bind 失败时 `listening=false` 且 `lastError` 有文案）

#### `connector_set_vault`

- **参数**（`args`）：`{ vaultPath: string | null }`
- **返回**：`{ ok: true; data: null }`
- **说明**：保存目标 Vault；无 Vault 时 HTTP `saveItems` 返回 503。

#### `connector_set_parent_dir`

- **参数**（`args`）：`{ parentDir: string }` — `papers` 或 `papers/…` 组织文件夹
- **返回**：`{ ok: true; data: null }`
- **说明**：默认保存位置；前端 Library 作用域会同步；插件 `getSelectedCollection.targets` 列出全部组织子文件夹（`L1` / `Dpapers/…`）。

#### Events

| 事件 | payload |
|---|---|
| `connector:status` | `ConnectorStatus` |
| `connector:item-saved` | `{ path, id, title, deduped, sessionId }` — 新条目在附件成功/失败终结且 latest target 移动完成后仅发一次；`path` 已稳定，前端刷新树/Library 并 `openPaper` |
| `connector:error` | `{ message, sessionId? }` |
| `connector:progress` | `{ key, sessionId, path, title, status, progress, detail, error? }` — 映射到左下角后台任务条 |

### 3.5c 全库搜索

命令面板（`⌘K` / `⌘P`）“In contents”层的后端。walk Vault 内 `*.md`（跳过 `.` 隐藏 / `node_modules` / `source`），多词 **AND**，返回 标题 + 片段 + 行号 + 评分。**无索引**（始终新鲜；结构上可后续换 FTS5）。论文 quick-open（标题/作者）在前端对内存 `libraryPapers` 完成，不走本命令。

#### `vault_search`

- **参数**（invoke 字段名 `args`）：

  ```ts
  {
    vaultPath: string;
    query: string;      // 空白分词，全部命中（AND）
    limit?: number;     // 默认 60，clamp 1–200
  }
  ```

- **返回**：`{ ok: true; data: { hits: SearchHit[]; truncated: boolean } }`

  ```ts
  type SearchHit = {
    path: string;         // Vault 相对 md，如 papers/x/NOTES.md
    paperPath?: string;   // 命中在 papers/… 下时的论文文件夹
    title: string;        // 首个 H1，或文件名
    snippet: string;      // 首个命中行片段
    line: number;         // 1-based 命中行号（0=未知）
    score: number;
  };
  ```

- **行为**：读文件（>2MB 跳过）；标题优先取 `#` H1；片段居中于首个命中词；评分 = 标题命中（+50/词）+ 正文出现次数（每词封顶 20）+ NOTES/PAPER.md 加成；按 score 降序、path 升序；截断到 `limit`。命中 `papers/<x>/…` 时 `paperPath=papers/<x>`，供 UI 打开论文而非裸文件。

### 3.6 魔棒 / 标识符入库

**交互**：侧边栏魔棒 → 粘贴链接/编号 → Host `lookup_import_batch` → Translator → 写 paper 文件夹。  
详见 [`paper-import.md`](paper-import.md)。

**Translator 默认地址**：`https://translator.philfan.cn`（设置 `translatorBaseUrl` 可改）。  
`POST {base}/search` 或 `/web`，body 为 plain text。

#### `lookup_import_batch`（魔棒批量入库）

- **参数**（invoke 字段名 `args`）：

  ```ts
  {
    vaultPath: string;
    parentDir: string;              // "papers" | "papers/nlp"
    texts: string[];                // 拆分后的原始 token 数组
    translatorBaseUrl?: string;     // 来自设置，默认 https://translator.philfan.cn
    taskId?: string;                // 前端后台任务 id；单条进度聚合在该任务下
    concurrency?: number;           // 最大并发入库数，默认 5，范围 1–10
  }
  ```

- **返回**：

  ```ts
  {
    ok: true;
    data: {
      imported: LookupImportResult[];
      skills: SkillImportResult[];
      skillCandidates: SkillDiscovery[];
      searchCandidates: { query: string; candidates: PaperSearchCandidate[] }[];
      skipped: { raw: string; kind: string; value: string; reason: 'duplicate_in_batch' | 'already_in_library' }[];
      errors: string[];
    }
  }
  ```

  其中 `LookupImportResult` 为单条入库结果（含 `paperDir`、`path`、`id`、`title`、`usedTranslator`、`translatorBaseUrl`、`pdf?`、`tex?`、`paperMd?`、`assetMessages?`）。
  `skills` 为魔棒直接安装的 Skill（当前仅当来源含 `--skill` 等明确过滤且候选唯一时可能非空）；`skillCandidates` 为需要前端弹窗确认的候选列表，见下方 `skill_install` / `skill_discard`。
  `searchCandidates` 为标题/关键词搜索结果（见 [`identifier-lookup.md` § 标题搜索回退](identifier-lookup.md)）；`PaperSearchCandidate` 含 `title`、`authors`、`year?`、`venue?`、`doi?`、`arxivId?`、`citationCount?`、`url?`、`identifier`、`source`（`'s2' | 'arxiv'`）。`identifier` 是用户选中后回填给本命令的文本，因此**不存在**没有 DOI/arXiv ID 的候选。
- **单条行为**：Translator 优先；失败且输入为 arXiv 时回退 export.arxiv.org；**catalog upsert**（权威）+ 写 `NOTES.md` 壳（摘要块优先经免费 MT 译为中文，失败则保留原文；catalog 中 `abstract` 仍为原文）；`metadata.json` 为 catalog 投影同步；**始终下载 PDF**；**arXiv 另下载 e-print 并解压 LaTeX** 到 `source/`。导入命令本身**不**再内联生成 `PAPER.md`；前端会在导入完成后对无 TeX 且有 PDF 的 paper 独立入队 `paper_parse_body` 后台任务，生成 `PAPER.md` 并更新 `body_source` / `body_quality`。
  当 `texts` 某条被识别为 Skill 来源（`skill` kind：GitHub URL、`npx skills add …`、`github:`、`skills.sh`）时，该条进入 Skill 解析管线，不写入 catalog/papers。
- **行为**：
  1. 逐条解析 `texts`；单 token 未识别、或多 token 中有任一 token 未识别 → 该条整体作为标题/关键词查询进入 `searchCandidates`（无结果或搜索失败才加入 `errors`）；Skill 来源进入 `skillCandidates`（或唯一命中时直接入 `skills`）。空格分隔且**每个** token 都是标识符时展开为多条。
  2. 按规范化 value 去重（arXiv 去 version、DOI 小写等）；batch 内重复 → `skipped.reason = 'duplicate_in_batch'`。
  3. 查 catalog：`arxiv_id` / `doi` / `isbn` / `pmid` / `id` 已存在 → `skipped.reason = 'already_in_library'`。
  4. 其余以 `concurrency`（默认 5，范围 1–10）为上限并发调 `import_by_identifier_with_progress`，共用 `taskId`；单条失败继续，错误加入 `errors`。并发上限可在 **Settings → General → Batch import concurrency** 调整。
  5. 前端收到 `imported` / `skills` / `skillCandidates` 后刷新树 / Library / wiki，并对其中仍缺资源的 paper 逐个入下载队列，每篇一个独立的 `download` 后台任务，按并发上限排队执行。**不**自动连跑 paper-reader。若存在 `skillCandidates`，前端打开选择弹窗；用户取消时调用 `skill_discard` 清理临时 discovery。若存在 `searchCandidates`，前端打开单选弹窗；确认后把候选的 `identifier` 重新提交本命令，取消则直接丢弃（无 Host 侧临时态）。

#### `skill_install`

安装由 `lookup_import_batch` 发现的一次性 Skill 候选。

- **参数**（invoke 字段名 `args`）：

  ```ts
  {
    vaultPath: string;
    discoveryId: string;      // lookup_import_batch 返回的 SkillDiscovery.discoveryId
    selectedNames: string[];  // 用户勾选的候选 Skill 名称
  }
  ```

- **返回**：`{ ok: true; data: SkillImportResult[] }`，每项含 `name`、`description`、`path`、 `source`、`skipped`（已存在时跳过）。
- **行为**：从临时 discovery 解压 GitHub tarball，将选中 Skill 目录复制到 `.agents/skills/<name>/`，并写入 `agentero-skill.json` 来源记录。已存在目录**不覆盖**。安装完成后由前端 `refreshTree`。
- **限制**：仅本地 Vault；远程 Vault 应在 `lookup_import_batch` 阶段直接拒绝。

#### `skill_discard`

取消/关闭 Skill 选择窗口时调用，删除 `lookup_import_batch` 创建的临时 discovery 包。

- **参数**：`{ discoveryId: string }`
- **返回**：`{ ok: true; data: null }`
- **行为**：删除临时目录与归档；不触碰 `.agents/skills/`。

#### `paper_download_assets`

为已有 paper 文件夹补下载缺失的 PDF（及 arXiv LaTeX）。用于文件树单篇 Download，以及 Library 行「下载全部缺失」。下载完成后前端会独立入队 `paper_parse_body` 后台任务生成 `PAPER.md`（若该 paper 无 TeX 且有 PDF）。

- **参数**（invoke 字段名 `args`）：

  ```ts
  {
    vaultPath: string;
    path: string; // Vault 相对 paper 文件夹，如 papers/1706.03762
    taskId?: string; // 前端后台任务 id，用于接收 background-task:progress
  }
  ```

- **返回**：`{ ok: true; data: { pdf: boolean; tex: boolean; paperMd: boolean; messages: string[] } }`
- **行为**：读 catalog 取 `pdf_url` / `arxiv_id` / `doi`；已有对应文件则跳过；PDF → `{paper}/{id}.pdf`（论文根目录）；arXiv e-print TeX → 解压进 `source/`；无 TeX + 有 PDF + 无 `PAPER.md` → liteparse → `PAPER.md`。下载客户端使用**浏览器 UA**（绕开部分出版商 403）；若直链/arXiv 候选都失败且有 `doi`，再查 **Crossref** 取直链 / OA PDF 兜底。打开 paper 预览时若无本地 PDF 也会自动调用本命令（失败则回退远程 `pdf_url`）。当传入 `taskId` 时，通过 `background-task:progress` 推送下载字节与 `parse` 阶段；liteparse 在可终止的子进程中运行，任务取消时立即终止，120 秒超时后保留已经下载的 PDF，并在结果 `messages` 中说明未生成 `PAPER.md`。

#### `background_task_cancel`

请求取消一个前端后台任务。参数为 `{ taskId: string }`；下载任务会中止当前读取流，批量任务和 Agent 工作流在协作取消点停止。取消是尽力而为，不回滚已经写入的文件。

#### `paper_stage_import_file`

将「无绝对路径」的 OS 拖放 PDF（macOS WKWebView 常无 `File.path`）以 base64 写入 `~/.agentero/import-tmp/`，返回绝对路径供 `paper_import_local_pdf` 使用。

- **参数**（`args`）：`{ fileName: string; contentBase64: string }`
- **返回**：`{ ok: true; data: { path: string } }`

#### `paper_import_local_pdf`

把本地 PDF 导入为 paper 文件夹（复制 + catalog + liteparse）。入口：魔棒弹层原生 PDF 选择器；或将 PDF **拖到左侧树 `papers/` 组织夹 / Library 表** → 直接后台导入（无确认对话框，元数据由识别链路自动补全）。

- **参数**（invoke 字段名 `args`）：

  ```ts
  {
    vaultPath: string;
    parentDir: string;   // Vault 相对，如 papers 或 papers/nlp
    filePaths?: string[]; // 仅路径（无 overrides）时用；`entries` 非空时忽略
    entries?: Array<{    // 路径 + 可选 metadata 覆盖（覆盖识别结果，记 meta_source=manual）
      filePath: string;
      title?: string;
      authors?: string[];
      year?: number;
      doi?: string;
      arxivId?: string;
      extra?: {          // 结构化字段覆盖
        publication?; volume?; issue?; pages?; publisher?;
        issn?; language?; date?; abstract?
      };
    }>;
    taskId?: string;      // 后台任务 id，用于显示 parse 阶段
    translatorBaseUrl?: string; // 后台识别时的标识符解析
  }
  ```

- **返回**：`{ ok: true; data: { papers: LookupImportResult[]; errors: string[] } }`（`errors` 为 `"<文件>: <原因>"`；仅当**全部**失败才整体 `ok:false`）。
- **行为**：每个 PDF → 标题优先用 `entries` 覆盖，否则文件名 stem；文件夹 id 按 arXiv ID slug → DOI slug → 文件名 stem 派生（与标识符导入命名一致，Host 仍做 `-2`/`-3` 去重）；带 `doi`/`arxivId`/`extra` 的 entries 记 `meta_source=manual`；无覆盖元数据的 entries（UI 默认路径）内联跑识别链路（见 [paper-import.md](paper-import.md) § PDF 元数据识别），命中则用解析出的元数据与标识符 slug 命名（`meta_source=recognize`），失败退回文件名 stem。复制到 `{slug}.pdf`；写 `NOTES.md` 壳 + catalog。导入任务本身**不**再等待 liteparse；前端会在导入完成后独立入队 `paper_parse_body` 后台任务生成 `PAPER.md`（无 TeX 且有 PDF 时）。不覆盖已存在文件夹（slug 去重）。

#### `paper_resolve_identifier`

把 DOI / arXiv id 解析为元数据（不入库）。支撑编辑元数据的刷新按钮。

- **参数**（invoke 字段名 `args`）：`{ text: string; translatorBaseUrl?: string }`
- **返回**：`{ ok: true; data: PaperMeta }`（snake_case，与 `paper_get` 行同构）。
- **链路**：输入是 DOI / arXiv / URL 时先走标识符解析（Translator → Crossref / arXiv Atom），再用 Semantic Scholar `publicationVenue.name` 补空缺或截断的会议名；自由文本才走 title search。仓储名（`arXiv` / `CoRR`）不当作有效 publication。详见 [academic-search-apis.md](academic-search-apis.md) §2.5。

#### `paper_parse_body`

把 paper 文件夹下的本地 PDF 解析为 `PAPER.md`。引擎由 `settings.layout.parserBackend` 决定（默认本地 liteparse 隔离子进程；可选 `mineru` / `paddle` / `openaiCompatible` 云端引擎，失败自动回退本地，见 [paper-import.md](paper-import.md) § 正文解析引擎）。可作为独立后台任务调用；已有 `PAPER.md` 且无 `force` 时直接跳过。

- **参数**（invoke 字段名 `args`）：

  ```ts
  {
    vaultPath: string;   // 本地 vault 根目录，或 remote:<sessionId>
    path: string;        // vault-relative paper folder
    force?: boolean;     // 默认 false；true 时覆盖已有 PAPER.md
    taskId?: string;     // 前端后台任务 id，用于取消
  }
  ```

- **返回**：`{ ok: true; data: { paperMd: boolean; bodySource?: string; bodyQuality?: string; error?: string; messages: string[] } }`
- **行为**：
  - 有本地 TeX 时跳过（认为 TeX 更干净）。
  - 无 PDF 时跳过。
  - 无 `PAPER.md` 或 `force=true` 时，用选定引擎生成 `{paper}/PAPER.md`。
  - 写 catalog `body_source`（`pdf`/`ocr`/`mineru`/`paddle`/`vlm`）与 `body_quality`（`high`/`medium`/`low`）。
  - 远程 vault 在 `session.work_root` 解析后上传 `PAPER.md` 并 push catalog mirror。
  - 本地解析最长等待 120 秒（VLM 渲染 300 秒、云端任务 10 分钟 deadline）；取消任务会 kill 当前 liteparse 子进程或中断云端轮询。
  - **`error` 只在真正失败时出现**（解析失败 / 正文为空 / 写 `PAPER.md` 失败），跳过与取消不算失败；云端引擎失败自动回退本地并把原因写进 `messages`。JobCenter 的 `parseBody` job 见到 `error` 会标记 `Failed` 并把它作为失败原因，任务面板因此能展示真实原因（例如找不到 PDFium 动态库）；否则标记 `Succeeded`。
  - liteparse 依赖运行时 `dlopen` 的 PDFium，随安装包分发，见 [paper-import.md](paper-import.md) § PDFium 随包分发。

> **正文生成时机**：魔棒 / 本地 PDF 导入 / 下载资产 / Library 导入 / Zotero 迁移 / 打开论文时，前端检查到该 paper 有 PDF、无 TeX、无 `PAPER.md`，就会入队 `paper_parse_body` 作为独立后台任务。原 `paper_download_assets` / 魔棒入库命令不再内联等待解析完成。

#### `paper_analyze_pdf`（规划中）

为本地 paper PDF 生成可重建的引用与插图 sidecar。首版不支持远程 Vault，不自动联网补全库外引用。

- **参数**：

  ```ts
  {
    vaultPath: string;
    path: string;
    force?: boolean;
    taskId?: string;
  }
  ```

- **返回**：

  ```ts
  {
    mode: "tex" | "pdf";
    citePath: string;
    figuresPath: string;
    figuresDir: string;
    citationCount: number;
    figureCount: number;
    messages: string[];
  }
  ```

- **落盘**：`{paper}/source/agentero-cite.json`、`{paper}/source/agentero-figures.json`、`{paper}/source/agentero-figures/*.png`。
- **行为**：有 TeX 时解析 TeX/Bib 并用 PDF bbox 做定位；无 TeX 时使用 liteparse。不得覆盖原始 PDF、TeX/Bib、`NOTES.md` 或 `PAPER.md`。Sidecar schema 待补充独立文档。

#### `paper_export`

导出 catalog 全文：Host 将每行转为 **Zotero API JSON item**，组成 **JSON 数组**，再 `POST {translatorBaseUrl}/export?format=…`（`Content-Type: application/json`）。

- **参数**（`args`）：

  ```ts
  {
    vaultPath: string;
    format?: string;              // 默认 "bibtex"；亦支持 biblatex/ris/csljson/csv/…
    translatorBaseUrl?: string;
  }
  ```

- **返回**：`{ ok: true; data: { format, content, count, filename } }`
- **注意**：`/export` **要求 body 为 Zotero items 数组**，不是 Agentero `PaperMetadata` 蛇形字段；转换在 Host `zotero::io::paper_record_to_zotero_item`。

#### `paper_import`

导入 BibTeX / RIS 等：`POST {translatorBaseUrl}/import`（`Content-Type: text/plain`）→ Zotero items 数组 → map + catalog upsert + paper 壳 + 默认下载资源。

- **参数**（`args`）：

  ```ts
  {
    vaultPath: string;
    content: string;              // 文件全文
    parentDir?: string;           // 默认 "papers"
    translatorBaseUrl?: string;
  }
  ```

- **返回**：`{ ok: true; data: { imported, skipped, paths, titles, errors } }`
- **行为**：已存在同 path 的 paper（有 NOTES 或 catalog 行）→ **skip**，不覆盖 `NOTES.md`。

#### `paper_refs_parse`

解析一篇论文的参考文献并写入可重建 sidecar `{paper}/source/agentero-cite.json`。优先级：在线结构化（Semantic Scholar `paper/{id}/references` → Crossref `works/{doi}.reference`）→ 本地 `source/*.bbl` / `*.bib` / 内联 `thebibliography`。本地条目提供编号顺序与 raw 文本，在线条目按 DOI / arXiv / 标题对齐后覆盖元数据；解析后按 DOI → arXiv → 归一化标题匹配库内论文写入 `localMatch`。输入指纹（DOI/arXiv + bib/bbl/tex 文件清单）未变时直接返回缓存，不重复请求 API。

- **参数**（`args`）：

  ```ts
  {
    vaultPath: string;
    path: string;                 // paper 文件夹 Vault 相对路径
    force?: boolean;              // 忽略指纹强制重解析
  }
  ```

- **返回**：`{ ok: true; data: CiteSidecar }`，其中：

  ```ts
  type CiteSidecar = {
    schemaVersion: number;        // 1
    source: { mode: string; generatedAt: string; fingerprint: string };
    citations: Array<{
      id: string;                 // "cite-{key}" 或 "ref-{n}"
      rawKey?: string;
      display?: string;           // "[12]"（仅本地书目顺序可知时）
      raw?: string;               // 原始条目文本（bbl/tex 来源必有）
      metadata: { title?; authors?; year?; venue?; doi?; arxivId?; url? };
      localMatch?: { paperPath: string; matchBy: "doi" | "arxiv" | "title" };
      source: string;             // "bbl" | "bib" | "tex" | "s2" | "crossref" | "bbl+s2" | …
      status: "resolved" | "unresolved";
    }>;
    messages: string[];
  };
  ```

- **行为**：无参考文献不算错误（空 sidecar 也落盘并记录指纹）；魔棒入库与单篇 Download 完成后 Host 自动后台触发（失败仅记日志）。远程 Vault 不支持。

#### `paper_refs_list`

读取已存在的引用 sidecar；未解析过返回 `data: null`。

- **参数**（`args`）：`{ vaultPath: string; path: string }`
- **返回**：`{ ok: true; data: CiteSidecar | null }`

#### `library_citing_scan`

**反向**引用发现：扫描全库，找出引用了库内论文、但**还没入库**的新论文。与本组其余命令方向相反，且**只能来自在线 API**（本地 TeX/`.bbl` 不含反向引用）。数据源为 Semantic Scholar；OpenAlex 的引用图几乎不含 arXiv 预印本之间的边，不可用。详见 [`citation-parsing.md`](citation-parsing.md) §7。

- **参数**（`args`）：

  ```ts
  {
    vaultPath: string;
    /** 前端后台任务 id：既路由进度事件，也承载取消 */
    taskId?: string | null;
    /** 引用论文多新才算「新」，默认 183 */
    sinceDays?: number | null;
    /** 返回的候选上限，默认 20 */
    budget?: number | null;
    /** 忽略缓存的引用页，重抓全部种子 */
    force?: boolean;
  }
  ```

- **返回**：`{ ok: true; data: CitingScanResult }`，其中：

  ```ts
  type CitingScanResult = {
    generatedAt: string;
    sinceDate: string;          // YYYY-MM-DD
    libraryTotal: number;
    seedsTotal: number;         // 合格种子（在 S2、被引 1..=2000）
    seedsFetched: number;       // 本次真正走网络的（其余命中缓存）
    skippedMegaCited: number;   // 被引 > 2000 的经典：引用者是跨领域噪音
    skippedUncited: number;
    skippedUnknown: number;     // 无标识，或 S2 不认识
    rawCiting: number;
    afterFilters: number;       // L0 之后
    gatePassed: number;         // 过语义门槛之后
    similarityThreshold?: number;
    candidates: Array<{
      s2Id: string;
      title: string;
      date: string;
      arxivId?: string;
      doi?: string;
      identifier: string;       // `arXiv:{id}` 或裸 DOI，可直接喂批量入库
      citedByMine: string[];    // 库内被引论文的 Vault 相对路径
      weight: number;           // IDF 加权重叠
      similarity?: number;
      citationCount: number;
      oaPdfUrl?: string;
    }>;
    cancelled: boolean;
    messages: string[];
  };
  ```

- **行为**
  - 一个 `paper/batch` 请求拿全库 `citationCount` + SPECTER2 向量，再对合格种子 8 路并发拉 `citations`。
  - 三层过滤：L0 硬过滤（跳过高被引经典种子；候选按时间窗 / 已入库 / 无可导入标识剔除）→ L1 IDF 加权重叠 → L2 中心化 SPECTER2 max-sim 门槛（阈值由库自身 leave-one-out p10 自校准）。
  - 排序后经 MMR 多样化截到 `budget`，避免结果被单一方向占满。
  - 结果与每个种子的引用页写入 `.agentero/citing-scan.json`；下次扫描只重抓 `citationCount` 变化的种子。
  - `taskId` 非空时：抓取阶段 emit `background-task:progress`（带 `currentCount`/`totalCount`），并在每个种子请求前检查取消。取消返回 `cancelled: true` 且不写缓存。

### 3.6 论文

论文**集合与元数据**存于 `.agentero/catalog.sqlite`；本组命令读写 catalog，并附带 Vault 相对路径字段。详见 [`catalog.md`](catalog.md)、[`data-model.md`](data-model.md)。

#### `paper_get`

从 **catalog.sqlite** 读取单篇论文元数据（权威来源）。

- **参数**（invoke 字段名 `args`）：

```ts
{
  vaultPath: string;
  /** paper 文件夹 Vault 相对路径（主键），如 papers/nlp/1706.03762 */
  path?: string;
  /** 或按逻辑 id 查询 */
  id?: string;
}
```

- **返回**：`{ ok: true; data: PaperMetadata }`（含 `pdf_url` / `html_url` / `arxiv_id` 等）；未找到则 `ok: false`。
- **说明**：UI 预览链接从此接口读取；catalog 为唯一权威。

#### `paper:get`（扩展规划）

获取单篇论文完整数据（catalog 行 + 路径附件信息）。

- **参数**

```ts
{
  /** paper 文件夹 Vault 相对路径（主键），如 papers/nlp/1706.03762 */
  path?: string;
  /** 逻辑 id（arXiv / citekey）；多 path 命中时返回列表或报歧义（实现可选） */
  id?: string;
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    paper: Paper;
  };
}
```

#### `paper_list`

列出当前 Vault 中已入库的全部论文（**读 catalog**，不扫盘拼表）。供前端 **论文库表格**（Library 虚拟节点 / vault home）。

- **参数**（invoke 字段名 `args`）：

```ts
{
  vaultPath: string;
}
```

- **返回**：`{ ok: true; data: PaperMetadata[] }`（数组元素含 `path`、`title`、`authors`、`year`、`type`、标识符与远程 URL 等）。
- **前端**：`src/lib/paper/api.ts` → `listPapers`；UI 侧本地表头排序（不经由本命令传 sort 参数）。
- **说明**：当前无 filter/pagination；扩展筛选/FTS 仍可用规划契约 `paper:list`（见下）。

#### `paper_rescan`

扫描 `papers/` 磁盘目录，用每个 paper 文件夹的 `NOTES.md`（标记文件）**重建 / 补齐 catalog 行**——找回”盘上有、catalog 无”的论文（外部拷入，或历史删除顺序 bug 丢失的行）。幂等。

- **参数**（invoke 字段名 `args`）：`{ vaultPath: string }`。
- **返回**：`{ ok: true; data: { count: number } }`（重新导入的 paper 数）。
- **行为**：递归遍历 `papers/`，遇含 `NOTES.md` 的文件夹即为 paper 叶子；创建最小化 paper 记录并 `upsert` 进 catalog。不删行、不改磁盘文件。
- **前端**：`src/lib/paper/api.ts` → `rescanPapers`；论文库空态「重新扫描 papers/」按钮。

> **Catalog 行删除**：不再有独立的 `paper_delete` command；删除走 `path_trash`（`trashPaths`），catalog 行随回收站快照清理（底层 `papers::delete_under_path`，CLI `agentero paper rm` 亦复用）。

#### `paper_move`

把 paper 文件夹 / `papers/` 下组织目录（或文件）移动到另一 `papers/` 目录：通过共享的链接感知事务执行磁盘 `fs::rename`（**不覆盖**已存在目标）、已解析内链改写与 catalog path 前缀更新。

- **参数**（invoke 字段名 `args`）：

```ts
{
  vaultPath: string;
  /** 要移动的 Vault 相对路径（paper / 组织目录 / 文件） */
  fromRel: string;
  /** 目标父目录（`papers` 或 `papers/` 下），Vault 相对 */
  destParentRel: string;
}
```

- **返回**：`{ ok: true; data: { newRel: string, linkUpdate: WikiRenameResult } }`（移动后的新相对路径与链接事务结果）。
- **校验**：目标须在 `papers/` 下；拒绝移入自身 / 子孙；目标已存在、相关编辑器仍有未保存内容、或任一计划来源 hash 已变化时中止。
- **SQL**：`UPDATE papers SET path = ?to || substr(path, len(?from)+1) WHERE path = ?from OR path LIKE '{from}/%'`（字符级 substr，兼容非 ASCII 目录名）。
- **单测**：`papers.rs::move_under_path`（叶子 + 组织目录下多行前缀改写）。
- **前端**：`src/lib/paper/api.ts` → `movePaperFolder`；文件树多选批量移动（`MovePapersDialog`）。

#### `paper_set_is_read`

更新 catalog 中单篇论文的 **`is_read`**（是否已完成 paper-reader 精读）。

- **参数**（invoke 字段名 `args`）：

```ts
{
  vaultPath: string;
  /** paper 文件夹 Vault 相对路径 */
  path: string;
  isRead: boolean;
}
```

- **返回**：`{ ok: true; data: PaperMetadata }`（更新后的整行）。
- **前端**：`src/lib/paper/api.ts` → `setPaperIsRead`；paper-reader 工作流成功结束后置 `true`。
- **说明**：与 `status`（入库态）无关；默认 `false`。触发路径：
  - **自动**：魔棒 `lookup_import_batch`（单条）/ 单篇 `paper_download_assets` 成功且资源就绪时，前端 `maybeAutoRunPaperReader`（批量导入/批量 Download 不连跑）。
  - **手动**：文件树在「资源齐全且 `is_read === false`」时显示 **Zap** 图标。
  - 实现：`src/lib/paper/reader.ts`（进度 `kind=paperRead`；可与 lookup/download 任务衔接）；skill 触发按当前默认 Agent 的 `SkillMentionStyle`。

#### `paper_set_tags`

整表替换 catalog 中单篇论文的 **`tags`**（`tags_json`）。

- **参数**（invoke 字段名 `args`）：

```ts
{
  vaultPath: string;
  /** paper 文件夹 Vault 相对路径 */
  path: string;
  /**
   * 完整标签列表（非增量 patch）。
   * 元素可为裸字符串（无色）或 `{ name: string; color?: TagColorId }`。
   * `color` 为 Apple 风格预置 id：`red` | `orange` | `yellow` | `green` |
   * `teal` | `blue` | `indigo` | `purple`；非法 / 空则视为无色。
   */
  tags: Array<string | { name: string; color?: string }>;
}
```

- **返回**：`{ ok: true; data: PaperMetadata }`（更新后的整行；`tags` 序列化：无色为字符串，有色为 `{name,color}`）。
- **规范化**：trim 空白；丢弃空串；大小写不敏感去重（保留首次出现的写法与颜色；同名后续项仅在先无色时补色）；`color` 白名单校验。
- **前端**：`src/lib/paper/api.ts` → `setPaperTags`；Paper Info 增删 + 色盘；Library 染色 chip + 筛选；`src/lib/ui/tag-colors.ts`。
- **CLI**：`agentero paper tag set|add|rm <ref> …`（`set` 整表替换，`--clear` 清空；支持 `name:color`，颜色为 Apple 8 色 id）；`paper list --tag` 默认隐藏 `@zotero:` / `@arxiv:` 内部标签，`--all` 包含全部标签；`paper tag list` 同样支持 `--all`。另有 `paper move` 与 `trash list|restore|purge`。见 [`cli.md`](cli.md)。

#### `paper:list`（扩展规划）

带过滤与分页的列表（尚未实现；现网用 `paper_list`）。

- **参数**

```ts
{
  vaultPath: string;
  status?: ('pending' | 'importing' | 'completed' | 'failed')[];
  tag?: string;
  year?: number;
  type?: string;
  query?: string; // title/abstract/authors 子串或后续 FTS
  limit?: number;
  offset?: number;
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    papers: Paper[];
    total: number;
  };
}
```

#### `paper:update`

更新 catalog 中已有论文的元数据字段（标题、标签、URL 等）。不覆盖 `NOTES.md`。

- **参数**

```ts
{
  path: string; // paper 文件夹路径（主键）
  patch: Partial<PaperMetadata>; // 不允许改 path
}
```

- **返回**：`{ ok: true; data: { paper: Paper } }`

### 3.6.1 Catalog 导出

根级 `PAPERS.md` / `library.bib` **默认不存在**；需要时显式导出。完整约定见 [`catalog.md`](catalog.md)。

#### `catalog:export_papers_md`

从 `papers` 表生成 Markdown 索引表（历史 `PAPERS.md` 形态）。

- **参数**

```ts
{
  vault_path: string;
  /** 若提供则写入路径（绝对或 Vault 相对）；否则仅返回 content */
  dest_path?: string;
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    content: string;
    written_path?: string;
  };
}
```

#### `catalog:export_bibtex`

从 catalog 生成 BibTeX 汇总（历史 `library.bib` 形态）。

- **参数 / 返回**：同 `catalog:export_papers_md`（`content` 为 BibTeX 文本）。

### 3.7 Agent 工作流（ACP Client + BYOA）

Host 作为 ACP Client：按注册表 spawn 用户本机 Agent（`cwd` = 当前 Vault），通过 stdio JSON-RPC 会话。**不** 内置 agent 二进制；**不** 在 config 中要求模型 API Key。

#### `agent_run_once`

通用 ACP provider 创建或恢复会话并发送 prompt。`sessionId` 省略时走 `session/new`；提供时按 agent 能力选择恢复方式：`sessionCapabilities.resume` → `session/resume`，否则若 `loadSession` → `session/load`（Grok Build 实测仅支持 load，不支持 resume）。历史列表经 `session/list` + `session/load` 获取。

- **参数**

```ts
{
  agentId?: string;
  sessionId?: string; // ACP session id for resuming a prior session; omit to create new
  prompt: string;
  vaultPath?: string;
  workflow?: string;
  target?: string;
  modelId?: string;
  collaborationModeId?: string; // 会话模式 default / plan（Plan 下可用 request_user_input）
  reasoningEffort?: string; // 仅写入当前 ACP 会话声明的 thought_level 选项
  fastMode?: boolean; // 仅写入当前 ACP 会话声明的 fast model_config 选项
  skillIds?: string[]; // 已发现的本机 SKILL.md id，最多 5 个
  autoApprove?: boolean; // 默认 false；true 时选择 ACP 返回的第一个权限选项
  permissionMode?: string; // "restricted" | "ask" | "auto"；"ask" 时每个 ACP 权限请求转交用户（agent:permission-request）
  responseLanguage?: string; // 强制回答/笔记语言（如 zh-CN）；省略或 auto 时不注入
  personalPrompt?: string; // 用户个人偏好提示词；省略或空时不注入
  hideFromChatHistory?: boolean; // 默认 false；true 时不写入 Vault Codex 会话索引（精读 / PDF 划词提问等）
}
```

- **返回**：`{ ok: true, data: { sessionId, messageId, agentId } }`

- **`hideFromChatHistory`**：为 `true` 时，该次运行不记入会话历史（`agent_list_sessions` 不列出）；前端 Agent 面板也不会把这类流式事件并入对话记录。用于 **paper-reader 精读**、**PDF 划词提问** 等非 Composer 发起的运行。Composer 对话保持默认 `false`。

- **技能上下文**：`agent_list_skills` 列出 `~/.agents/skills`、`${CODEX_HOME:-~/.codex}/skills`、`~/.claude/skills` 和当前 Vault `.agents/skills`。运行时重新解析 id，只读取 `SKILL.md`，单个文件上限 64 KiB，最多加载 5 个。
- **技能提及按 provider 分流**（`SkillMentionStyle`，见 Host `skills.rs`）：
  - **Claude ACP** → `/skill-id` 前缀 + 注入正文；
  - **其它（含 Codex）** → 仅注入正文（`skill:id` 标签），prompt 明确写明不要依赖 `$`/`/` 运行时命令。
  - Composer 的 `$` 仅是 Agentero UI 选 skill 的方式，不等于每个 Agent 的运行时语法。

- **权限策略**：设置 → Agent 提供全局「权限模式」，对所有 Agent 生效，并在每次运行中通过 `permissionMode` 传入：
  - `restricted`（默认）：取消所有 ACP 权限请求；
  - `ask`（每次询问）：每个权限请求经 `agent:permission-request` 事件转交前端，用户点选后由 `agent_respond_permission` 回传（超时 5 分钟未应答则取消）；
  - `auto`（自动批准）：选择第一个 AllowOnce 选项（等价旧 `autoApprove: true`）。

- **回答语言**：设置 → Agent 提供全局「回答语言」（自动 / English / 简体中文，独立于界面语言）。前端 `runOnce` 统一读取该设置并透传 `responseLanguage`；Host 在 `build_prompt`（`prompts.rs`）为所有 workflow 追加一句语言指令，`auto` 时不注入。
- **个人偏好提示词**：设置 → Agent 多行文本（`agentPersonalPrompt`，默认空）。非空时前端 `runOnce` 透传 `personalPrompt`；Host 在 `build_prompt` system envelope 追加 `User preference instructions` 块（所有 workflow）。留空不注入；Chat 展示剥离 envelope，不出现在对话记录。

- **能力边界**：所有 provider（含 Codex）根据 ACP `SessionConfigOption` 协商模型目录、reasoning effort 与 Fast 等能力。`ProbeResult` 含 `sessionCapabilities` 字段。Composer 只为当前 provider 已声明的能力显示对应控件。

#### `agent_respond_permission`

应答「每次询问」档下的 ACP 权限请求（`agent:permission-request`）。

- **参数**：`{ request: { requestId: string; optionId: string | null } }`（`optionId = null` 表示取消）
- **返回**：`{ ok: true, data: { resolved: boolean } }`（`resolved=false` 表示请求已超时/不存在）

#### `agent_list_sessions`

列出当前 Vault 的 Agent 会话历史（所有 provider 统一）。Host 通过 ACP `session/list` 获取会话列表，按最近活跃时间排序。`hideFromChatHistory` 的后台运行不出现在列表中。

```ts
{ agentId?: string; vaultPath?: string }
// -> { ok: true, data: { sessions: AgentSessionInfo[] } }
```

#### `agent_load_session`

按 ACP session id 恢复对话显示。Host 通过 ACP `session/load` 回放历史通知，并按 `messageId` 边界重建**多轮** user / agent 行：agent 行携带有序 `parts`（`reasoning` / `text` / `tool` / `plan`，工具卡按 `ToolCall`/`ToolCallUpdate` 合并）与从正文 `## Sources` 重新解析的 `sources`（引用 UI 恢复渲染）；会话标题取自回放的 `SessionInfoUpdate`。思考时长协议无时间戳、不持久化，恢复后统一显示"思考过程"。**用户轮**在前端经 `stripPromptEnvelopeForDisplay` 去掉 Host 系统信封，只显示人类原文。所有 provider 统一走此命令。

```ts
{ agentId?: string; sessionId: string; vaultPath?: string }
// -> { ok: true, data: { sessionId; title?: string | null; lines: AcpHistoryLine[] } }
// AcpHistoryLine: { id; kind: "user" | "agent"; text; reasoning?; parts?: AcpHistoryPart[]; sources?: string[] }
```

#### `agent_list_skills`

列出可由 Composer `$` 提及的本机技能。

- **参数**：`{ vaultPath?: string }`
- **返回**：`{ ok: true, data: { id, name, description }[] }`

#### `agent:list_agents`

列出已注册 Agent 及其探测状态。

- **参数**：无
- **返回**

```ts
{
  ok: true;
  data: {
    agents: AgentDescriptor[];
    default_id: string | null;
  };
}
```

#### `agent:upsert_agent`

新增或更新一条 Agent 注册项。

- **参数**

```ts
{
  id?: string; // 省略则新建
  name: string;
  template?: 'opencode' | 'openclaw' | 'gemini' | 'hermes' | 'claude-acp' | 'codex-acp' | 'qodercli' | 'grok-build' | 'pi' | 'dsh' | 'kimi-code' | 'custom';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  set_default?: boolean;
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    agent: AgentDescriptor;
  };
}
```

#### `agent:remove_agent`

删除注册项（**不**卸载用户本机 CLI、不动 shell 配置）。设置页「卸载」按钮做彻底清理时走 `agent_run_tool_lifecycle` 的 `uninstall`（成功后会联动删除 catalog 注册项）；仅想移除注册项的 UI 场景仍用本命令。

- **参数**：`{ id: string }`
- **返回**：`{ ok: true; data: null }`

#### `agent:discover`

对 PATH / 已配置绝对路径做可执行文件探测，更新 `available` 状态。

- **参数**：`{ id?: string }` // 省略则探测全部
- **返回**

```ts
{
  ok: true;
  data: {
    agents: AgentDescriptor[];
  };
}
```

#### `agent_run_tool_lifecycle`（已实现，[#225](https://github.com/poco-ai/Agentero/issues/225)）

**静默**安装、升级或卸载 catalog Agent CLI（需要时一并装/卸 ACP 适配器）。不弹终端、不写临时确认脚本；命令由 Host 按平台拼装，UI 不得传入任意 shell。

> 已取代旧的 `agent_open_install_terminal`（打开系统终端、Enter 确认后再装）。远端仍用 `remote_agent_open_install_terminal`（SSH 确认安装）。

- **参数**：`{ templateId: string, action: "install" | "update" | "uninstall", taskId?: string }`
  - 支持的 `templateId`：`opencode` · `openclaw` · `claude-acp` · `codex-acp` · `gemini` · `hermes` · `grok-build` · `pi` · `dsh` · `kimi-code`（不含 `qodercli` / `custom`）
  - `taskId` 来自设置页 Agent 行内安装进度条；用于匹配 Host progress tick 与接收协作取消信号。
- **返回**：`{ ok: true; data: null }` 或错误（stderr/stdout 末尾若干行）
- **行为**
  - `install`：未装 host 时走官方 installer（POSIX curl→临时文件再 bash，非 `curl|bash`）或 npm；Claude/Codex/Pi 在 host 已存在但 ACP 缺失时只装适配器；两者都缺则 host && adapter；Hermes 走官方 installer；OpenClaw 走 npm。Pi 无原生 ACP，ACP 入口是社区适配器 `pi-acp`（detect 用 host `pi`）；host 与 adapter 两层都走 npm，因为 `pi.dev/install.sh` 是交互式 TUI installer，不能静默执行。Dsh 是目录级 npm 项目安装：Host 先在 `~/.agentero/dsh-acp` 写入默认 `cordis.yml` 与最小 `package.json`（已存在则不覆盖），再 `npm i` 固定版本的 `dsh-acp-demo` + 插件栈；launcher、home npm 根或 PATH 已有入口时 `install` 跳过下载，`update` 仍刷新 launcher 副本。Kimi Code 优先官方 installer（`code.kimi.com`，单二进制装入 `~/.kimi-code`），失败回退 `npm i -g @moonshot-ai/kimi-code`。
  - `update`：优先 `tool update` / 官方链，失败再 npm；Codex 固定 npm（避免假成功）；OpenClaw 使用 `openclaw update --yes` 后 fallback npm；Pi 使用 `pi update --self` 后 fallback npm；Windows 上 OpenCode 不用交互式 `upgrade`。Kimi 的 `kimi upgrade` 是交互式，静默 update 直接重跑官方 installer（幂等）。
  - `uninstall`：镜像安装矩阵做 best-effort 清理（先 `resolve_command("npm")` 预检，缺失即报错而非假成功）——npm 全局包逐个 `npm uninstall -g`（unix 上适配器带 `--prefix "$HOME/.local"`，与安装一致）；dsh 删除受管目录 `~/.agentero/dsh-acp`，kimi-code 在 npm 卸载后删除 `~/.kimi-code`（Windows 为 `%USERPROFILE%\.kimi-code`）；**不改 shell rc**（官方 installer 写入的 PATH 行保留）、不处理官方脚本/brew 安装的 CLI（无法可靠定位）。Hermes 无 npm 包/受管目录 → 仅移除注册项（不跑命令）。成功后同命令联动删除该模板的 catalog 注册项（`catalog-{templateId}`，或 command+args 匹配），避免二进制已删而注册项残留；phase 用 `agent-lifecycle-uninstall` 推送进度。
  - 本机 lifecycle 全局串行执行，避免多个 npm 全局安装/升级任务并发抢锁或互相覆盖临时脚本；设置页在对应 Agent 卡片内展示安装 / 扫描 / 探测阶段进度（#250）。
  - 安装子进程运行期间，Host 以 `agent-lifecycle:progress` 推送 `agent-lifecycle-*` phase tick，供设置页行内进度条消费，避免快捷下载脚本长时间停在无进度状态。
  - 若传入 `taskId`，等待 lifecycle 锁和执行安装子进程时会检查 `background_task_cancel`；取消是尽力而为，不回滚已完成的包管理器写入。
  - macOS/Linux：注入 login shell 的 `PATH`（GUI 窄 PATH）。
  - Windows：写唯一临时 `.bat` + `CREATE_NO_WINDOW` + `call` 前缀；安装进程 PATH 合并 npm/pnpm/WinGet/Scoop shim；批处理切到 UTF-8，错误输出按 UTF-8 优先、GBK 回退解码。
  - 在 `spawn_blocking` 中执行，避免卡住 async runtime。
- **实现**：`src-tauri/src/features/agent/tool_lifecycle.rs`
- **Catalog 两层检测**（`agent_scan_catalog` / 远端 scan）：
  - **Agent**：`binaryAvailable`（`detect_command`，如 `claude` / `codex` / `opencode` / `openclaw` / `hermes` / `kimi`）
  - **ACP**：`acpCommandAvailable`（`command`，如 `claude-agent-acp`；原生 ACP 时与 Agent 同二进制）
  - `adapterDistinct`：host 与 ACP 入口不同
  - `canInstall`：本机支持静默安装
  - `offerInstall`：Agent 已装但 ACP 缺失 → 设置页「安装 ACP」
  - Agent 未装且 `canInstall` → 设置页「安装」
  - dsh 例外：`binaryAvailable` 与 `acpCommandAvailable` 同源——launcher 目录、home npm 根或 PATH 的 `dsh-acp-demo` 入口，`detect_command`（node）不参与判定。
  - 另回传 `userAgent` / `userAgentProviderIds`（见下）

#### `agent_set_user_agent`（已实现）

可选 HTTP User-Agent，注入 Codex ACP 出站请求（中转站 Codex 亲和）。

- **参数**：`{ userAgent: string; userAgentProviderIds: string }`（`userAgent` 空 = 关闭；`userAgentProviderIds` 为逗号分隔 provider id，空 = 自动）
- **返回**：`{ userAgent, userAgentProviderIds }`
- **行为**：见 [agent.md § User-Agent](agent.md)

#### `agent_tool_lifecycle_supported`（已实现）

- **参数**：`{ templateId: string }`
- **返回**：`{ ok: true; data: boolean }`

#### `agent_tool_install_commands`（已实现）

平台相关的一键手动安装文案（复制用，无副作用）。

- **参数**：无
- **返回**：`{ ok: true; data: string }`

#### `agent_tool_uninstall_info`（已实现）

返回某模板「彻底卸载」将执行的清理项清单，供设置页确认对话框展示。无副作用的纯查询；与 `agent_run_tool_lifecycle` 的 `uninstall` 矩阵一致。

- **参数**：`{ templateId: string }`
- **返回**：`{ ok: true; data: UninstallInfo | null }`（`null` = 无可管理卸载，仅注册项移除，如 `hermes` / `qodercli` / `custom`）

```ts
interface UninstallInfo {
  npmCommands: string[]; // 完整 `npm uninstall -g ...` 命令串（含 prefix）
  dirs: string[]; // 将 remove_dir_all 的受管目录
}
```

#### `agent:list_sessions`

列出当前 Vault 中的 Agent 会话。

- **参数**：无
- **返回**

```ts
{
  ok: true;
  data: {
    sessions: AgentSession[];
  };
}
```

#### `agent:create_session`

创建新的 Agent 会话（按需 spawn ACP 子进程）。

- **参数**

```ts
{
  name?: string;
  agent_id?: string; // 默认 agent.default_id
  workflow?: 'summary' | 'qa' | 'related_work' | 'free';
  context_paths?: string[]; // 预加载的 Vault 相对路径
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    session: AgentSession;
  };
}
```

- **行为**
  - 使用注册表中的 `command` / `args` / `env` spawn Agent，`cwd` = Vault root。
  - 加载工作流 prompt 模板与 `AGENTS.md` 作为系统约束。
  - 若 command 不可用，返回可诊断错误（含探测信息），不静默使用其他 agent。

#### `agent:send_prompt`

向指定会话发送 prompt。

- **参数**

```ts
{
  session_id: string;
  prompt: string;
  workflow?: 'summary' | 'qa' | 'related_work' | 'paper_reader' | 'translate' | 'free'; // 默认 'free'
  target?: string; // workflow 为 summary/qa/related_work/paper_reader 时的目标文件路径
  stream?: boolean; // 默认 true
  write_target?: string; // 可选：输出写入目标文件相对路径，需用户确认
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    session_id: string;
    message_id: string;
  };
}
```

- **行为**
  - 若 `stream=true`，通过 `agent:stream` 事件推送增量内容。
  - 权限请求通过 `agent:permission_request` 推送，前端调用 `agent:respond_permission` 应答。
  - 完成时推送 `agent:completed` 事件，包含读取过的文件路径列表。
  - 若指定 `write_target`，输出先写入临时草稿，不直接覆盖目标。

#### `agent:respond_permission`

应答权限请求。

- **参数**

```ts
{
  session_id: string;
  request_id: string;
  allow: boolean;
  remember?: 'session' | 'once'; // 默认 'once'
}
```

- **返回**：`{ ok: true; data: null }`

#### `agent:accept_draft`

将 Agent 生成的临时草稿写入正式文件。

- **参数**

```ts
{
  session_id: string;
  message_id: string;
  target: string;
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    path: string;
    mtime: number;
  };
}
```

- **行为**
  - 将临时文件移动到目标路径。
  - 若目标文件已存在且包含用户手写内容，默认合并或提示冲突。

#### `agent:close_session`

关闭 Agent 会话（结束 ACP 连接并可终止子进程）。

- **参数**

```ts
{
  session_id: string;
}
```

- **返回**：`{ ok: true; data: null }`

### 3.8 双链与图谱

> 产品与索引设计见 **`docs/backend/wiki.md`**。下列为已实现的 Host 接口。

#### `graph_get_backlinks`

获取某个文件的反链列表。若当前 Vault 尚未索引会先全量重建。

- **参数**

```ts
{
  vaultPath: string;
  path: string; // 绝对路径或 Vault 相对路径
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    path: string; // 规范化后的 Vault 相对路径
    backlinks: ResolvedLink[];
  };
}
```

`ResolvedLink` 保留 occurrence 的 `source`、`targetRaw`、`syntax`、`embed`、`displayText?`、typed `fragment?`、`sourceRange`、`fragmentRange?`、`line`、`context?`，并返回 `status`（`resolved` / `missing` / `ambiguous` / `invalidFragment`）、`targetPath?` 与 `candidates?`。`fragmentRange` 仅覆盖 `#` 后的 heading/block 正文，供显式标题事务精确改写；反链和出链以 occurrence 为单位，不能由 Graph 去重结果反推。

#### `wiki_get_outgoing`

获取一个 Markdown 文件显式写出的全部出链 occurrence，包括可诊断但不可跳转的缺失、歧义和无效 fragment。

```ts
{ vaultPath: string; path: string }
// => { ok: true; data: { path: string; outgoing: ResolvedLink[] } }
```

#### `wiki_resolve`

以来源路径上下文解析一个内链文本。生产 UI 使用该接口，而不是复制 Rust resolver。

```ts
{
  vaultPath: string;
  sourcePath: string;
  linkText: string;
  syntax?: "wikilink" | "markdown"; // 默认 wikilink
}
// => { ok: true; data: { link: ResolvedLink } }
```

`syntax: "markdown"` 将 destination 按来源目录优先解析；若 `..` 会离开 Vault，返回 `missing`，不会降级匹配 Vault 根或同名文件。

#### `wiki_embed_read`

解析一个 `![[...]]` 并读取只读投影。目标和 fragment 完全复用 `wiki_resolve` 的语义；前端不自行猜测文件、标题或 block。

```ts
{
  vaultPath: string;
  sourcePath: string;
  linkText: string; // 不含外层 ![[ ]]
}
// => {
//   ok: true;
//   data: {
//     link: ResolvedLink;
//     contentKind?: "markdown" | "image" | "pdf" | "unsupported";
//     content?: string; // 仅 Markdown 全文、标题区段或 block 投影
//   }
// }
```

- `link` 始终返回规范解析状态；`missing`、`ambiguous`、`invalidFragment` 不读取猜测目标。
- Markdown heading 投影包含命中的 heading，并持续到下一个同级或更高层级 heading；block 投影只返回索引命中的 block 行。
- 图片与 PDF 只返回类型和规范目标路径，前端通过本地文件字节加载既有图片/PDF 组件。
- Canvas、音视频、远程 URL 及其它未支持类型返回 `unsupported`。

#### `wiki_search`

返回可写入的文件、heading 和 block 候选；候选带规范路径与 `insertText`，重名场景由 UI 显示路径供用户选择。

```ts
{ vaultPath: string; query: string }
// => { ok: true; data: WikiSearchCandidate[] }
```

#### `wiki_move`

对本地 Vault 的普通文件或目录执行链接感知 rename/move。Host 先重建改名前的索引快照，只重写明确解析到 `fromRel` 或其子路径的 occurrence，再移动主路径；Markdown link 会按最终来源位置重新相对化。

```ts
{
  vaultPath: string;
  fromRel: string;
  toRel: string;
  dirtyPaths?: string[];
}
// => { ok: true; data: WikiRenameResult }
```

`WikiRenameResult` 为 `{ movedPath, updatedSources, skipped: { path, reason }[], rollback }`，其中 `rollback` 为 `notNeeded`、`completed` 或 `manualRecoveryRequired`。冲突、未保存编辑、来源内容已变、目标已存在或失败回滚均返回错误；remote Vault 不通过该本地命令执行。

#### `wiki_rename_heading`

显式重命名一个本地、可写且已保存 Markdown 文档中的标题，并同步所有已解析到该标题或受影响后代的 heading fragment。普通编辑与 autosave 不调用此命令。

```ts
{
  vaultPath: string;
  path: string;
  headingPath: string[];
  headingLine: number;
  expectedContent: string;
  newText: string;
  dirtyPaths?: string[];
}
// => {
//   ok: true;
//   data: {
//     path: string;
//     oldPath: string[];
//     newPath: string[];
//     updatedSources: string[];
//     rollback: "not-needed" | "completed" | "manual-recovery-required";
//   }
// }
```

Host 以 `expectedContent + headingPath + headingLine` 复核保存态标题身份，只改写 occurrence 的精确 `fragmentRange`。Wikilink、嵌入、Vault-local Markdown link、同文件 fragment 与多级 heading path 均走同一事务；文件目标、alias、Markdown label 和周围正文保持不变。dirty source、stale content、标题缺失、新标题无效/歧义或重叠编辑会在写入前失败；失败返回 `{ code, rollback, paths? }` 结构化 details，其中 `unsavedEdits` 的 `paths` 只列出本次事务实际会改写的未保存 Vault 相对路径。

#### `wiki_external_rename_preview`

为已由 Finder、Obsidian 或 Agent 完成的**可信本地外部 rename**创建只读 repair candidate。调用方传入 watcher 的 old/new Vault 相对路径与当前 dirty path；Host 必须仍持有改名前索引，且验证旧路径已不存在、新路径存在后才返回 candidate。

```ts
{ vaultPath: string; fromRel: string; toRel: string; dirtyPaths?: string[] }
// => { ok: true; data: { candidateId, from, to, affectedSources, skipped } }
```

该命令不写 Markdown、不移动主文件；候选用于 `ask` 的确认界面，也可由 `always` 在前端策略允许时直接交给 apply。preview 失败保持零写入；后续 apply 失败以 `error.details.rollback` 说明是否写入并完成回滚或需要人工恢复。审阅 Dialog 显示 old/new path、已知影响和可处理错误。

#### `wiki_apply_external_rename_repair`

执行一个先前 preview 的 candidate。执行前再次验证 dirty path、所有来源内容 hash，以及外部 rename 仍保持旧路径不存在 / 新路径存在；只写入计划中的 Markdown occurrence，绝不反向移动主文件或目录。

```ts
{ vaultPath: string; candidateId: string; dirtyPaths?: string[] }
// => { ok: true; data: WikiRenameResult }
```

失败会移除无效 candidate；仅未保存编辑错误保留 candidate，允许用户先处理编辑后重试。执行失败响应的 `error.details` 为 `{ code: WikiRenameErrorCode, rollback: "not-needed" | "completed" | "manual-recovery-required", paths?: string[] }`；`unsavedEdits` 会返回实际阻塞事务的 Vault 相对路径，调用方仅在 `rollback === "not-needed"` 时可表述为零写入。

#### `graph_get_graph`

获取全量或局部 wikilink 图谱。数据来自内存索引（必要时 `ensure_vault` 先 rebuild）。  
设计见 **`docs/backend/wiki.md` §4.6 / §6.3**。

- **参数**

```ts
{
  vaultPath: string;
  /** 中心节点：Vault 相对路径或绝对路径；省略 / 空 = 全图 */
  center?: string | null;
  /** 邻域跳数；仅当 center 有效时生效。默认 2。全图时忽略。 */
  depth?: number | null;
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    nodes: GraphNode[]; // { id, label, type, path? }
    edges: GraphEdge[]; // { id, source, target, targetRaw? }
    /** 实际用作中心的规范化路径；全图时为 null */
    center: string | null;
    depth: number;
  };
}
```

- **节点折叠**：`papers/<id>/NOTES.md` 与同目录其它文件 **合并为一个节点** `papers/<id>`。
- **节点 `label`**：paper 用 catalog `papers.title`；其它节点用文件名（去扩展名）。
- **节点 `type`**

| type | 规则 |
|---|---|
| `paper` | 折叠后的 `papers/<id>` |
| `note` | `notes/…` 或其它 md |
| `index` | 根级 `AGENTS.md` 及用户导出的索引类 md 等 |
| `stub` | 未解析目标（id 形如 `stub:<raw>`） |

- **边**：有向，`source` / `target` 为折叠后节点 id；折叠后的自环丢弃。
- **邻域**：无向 BFS（出边 + 入边）从 `center` 扩展至多 `depth` 跳，再裁剪 edges。

#### `graph_rebuild`

校验当前 Vault 的版本化 Wiki snapshot；完全命中时恢复内存索引，否则全量扫描 Vault target 文件、重建索引并 best-effort 覆盖 snapshot。缓存位于应用 cache 目录，不写入 Vault 或 `.agentero/catalog.sqlite`。

- **参数**

```ts
{
  vaultPath: string;
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    indexedFiles: number;
    edges: number;
    nodes: number;
  };
}
```

#### `wiki_cache_rebuild`

内部诊断命令。删除当前 Vault 的派生 Wiki snapshot，再从 Vault 文件冷重建并写入新 snapshot；删除或写 cache 失败不改变 Markdown 事实来源。

```ts
{ vaultPath: string }
// => {
//   ok: true;
//   data: { indexedFiles: number; edges: number; nodes: number }
// }
```

snapshot 保存所有 Wiki target 的 size+mtime stat 指纹（不读文件内容），以及 documents 与 resolved occurrences。schema/parser version、Vault identity 或 snapshot integrity hash 不匹配时丢弃旧 snapshot 并冷重建；指纹部分不一致时增量重建（只重新解析变化的 Markdown，未变文件复用缓存解析结果，链接解析全量重跑）；cache 写失败只记录 warning，内存 rebuild 仍成功。

### 3.8b Vault Doctor

#### `doctor_check`

- 参数：`{ vaultPath }`（本地 Vault 绝对路径）。
- 返回：`DoctorReport`，含 `vault`、`catalog`、`wikilinks`、`aliases` 四组。
- 只读：Catalog 以 read-only connection 打开；不会迁移 schema 或改写 Markdown。

#### `doctor_apply_aliases`

- 参数：`{ vaultPath, changes, dirtyPaths? }`；每条 change 含 `path`、可编辑的 `titleAlias` / `shortAlias` 与诊断时 `expectedHash`。
- 仅接受 Catalog paper 对应的 `papers/**/NOTES.md`。
- 批量预检脏路径、哈希、alias 冲突与 YAML 安全范围；全部通过后**原地写入** frontmatter（不改 path），失败按规划内容回滚。不使用 tmp+rename，以免被 watcher 误报为外部改名。

#### `doctor_ignore_aliases`

- 参数：`{ vaultPath, paths, ignore }`。`paths` 为 Vault 相对 `papers/**/NOTES.md`；`ignore: true` 写入忽略列表，`false` 从列表移除。
- 落盘：`.agentero/doctor.json` 的 `ignoredAliasPaths`。
- 返回：更新后的 `DoctorVaultState`（`{ ignoredAliasPaths }`）。
- 随后 `doctor_check` 不再把这些路径算作别名错误；报告中的 `aliases.ignoredPaths` 列出仍不完整且仍被忽略的路径。

#### `doctor_plan_wikilinks`

- 参数：`{ vaultPath }`。
- 返回：`{ suggestions, residuals }`。  
  - `suggestions`：可勾选修复项（`deterministic` 默认勾选，`manual` 默认可手改）；含 `rangeStart/End`、`expected`、`expectedHash`、`suggestedReplacement`、`linePrefix` / `lineSuffix`。  
  - `residuals`：与 manual 对应的结构化详情（供设置页生成 Agent 提示词），不单独渲染列表。

#### `doctor_apply_wikilinks`

- 参数：`{ vaultPath, changes, dirtyPaths? }`；每条 change 含 `source`、`rangeStart/End`、`expected`、`replacement`、`expectedHash`。
- 只改链接 target/fragment 的字节范围；脏路径 / 哈希 / 重叠 range 预检；原地写入，失败回滚。

设置页对 Agent 采用 **提示词 handoff**（复制 / 打开 Agent 预填 composer），不在 Doctor 内批量调用模型。

#### `doctor_set_dirty_paths`

主窗口向 Host 镜像当前 Vault 的未保存 Markdown 相对路径，供独立 Settings Webview 发起修复时做全批次写前拒绝。它只维护进程内保护状态，不落盘。

详见 [doctor.md](doctor.md)。

### 3.9 配置

#### `config:get`

获取应用配置。

- **参数**

```ts
{
  key: string;
}
```

- **返回**

```ts
{
  ok: true;
  data: {
    key: string;
    value: unknown;
  };
}
```

#### `config:set`

设置应用配置。

- **参数**

```ts
{
  key: string;
  value: unknown;
}
```

- **返回**：`{ ok: true; data: null }`

- **常用 key**
  - `agent.enabled`：Agent 总开关，默认 `true`。
  - `agent.default_id`：默认 Agent 注册 id；无可用 agent 时为 `null`。
  - `agent.agents`：Agent 注册表数组（`id` / `name` / `template` / `command` / `args` / `env`）。**不** 包含模型 API Key 字段。
  - `parser.pdf.backend`：PDF 解析后端，`liteparse`（默认）或 `mineru`。
  - `parser.mineru.api_key`：云端 MinerU API Key（产品侧 BYOK，与 Agent 密钥分离）。
  - `parser.mineru.enabled`：是否启用云端 MinerU，默认 `false`。
  - `recent_vaults`：最近 Vault 列表（Host 维护，前端一般只读）。

### 3.10 应用设置（XDG）

应用 UI 设置与 Agent 注册表落在 **XDG 配置目录**（非 Vault、非 `localStorage`）：

| 文件 | 路径 |
|---|---|
| 应用设置 | `$XDG_CONFIG_HOME/agentero/settings.json`（未设 env 时 Unix：`~/.config/agentero/settings.json`） |
| Agent 注册表 | `$XDG_CONFIG_HOME/agentero/agents.json` |
| 使用记录 | `$XDG_DATA_HOME/agentero/usage.sqlite`（见 [usage.md](usage.md)） |
| 版面 ONNX | `$XDG_CACHE_HOME/agentero/models/pp-doclayoutv3.onnx`（见下节） |

Windows：未设 `XDG_CONFIG_HOME` 时回退 `%APPDATA%/agentero/`。旧版 macOS 路径 `~/Library/Application Support/agentero/` 在首次启动时 **best-effort 复制** 到 XDG 路径。

### 3.10.1 版面模型（PP-DocLayoutV3）

- **路径**：`$XDG_CACHE_HOME/agentero/models/pp-doclayoutv3.onnx`
- **启动**：`setup` 在代理配置后 `spawn_background_download`（固定 task id `layout-model`）
- **下载源**：ModelScope（`greatv/oar-ocr`）优先，失败则 HuggingFace EmbedPDF `model_fp16.onnx`
- **代理**：走 Host 全局 `core::http::client_builder`（与设置 Network proxy 一致）
- **协议**：`agentero-model` URI scheme 把本地文件喂给 `onnxruntime-web`
- **后台任务**：
  - `emit("layout-model:task", { taskId, status, progress, detail, error, source })`
  - `emit("background-task:progress", { taskId: "layout-model", phase: "layout-model", … })`
  - 取消：`background_task_cancel` + task id `layout-model`

#### `layout_model_status`（已实现）

- **返回** `ApiResult<LayoutModelStatus>`：`{ ready, path, sizeBytes, source, fileName }`

#### `layout_model_ensure`（已实现）

- **参数**：`{ progressTaskId?: string }`（来自 `enqueueBackgroundTask` 的 id）
- **返回**：`LayoutModelStatus`；未就绪则下载（进程锁；支持取消与字节进度）

### 3.10.2 版面解析后端（本地 ONNX / 远程 Provider）

`settings.json` 新增 `layout` 段（camelCase，`settings_get` / `settings_set` 同构）：

```jsonc
{
  "layout": {
    "backend": "local", // "local"（默认，ONNX）| "paddle"（AI Studio 异步任务）| "mineru"（MinerU 云 API）
    "parserBackend": "local", // PAPER.md 正文解析引擎："local"（默认）| "paddle" | "mineru" | "openaiCompatible"
    "providerConfigs": {
      "paddle": { "apiKey": "***", "baseUrl": "", "model": "", "prompt": "", "language": "", "isOcr": false },
      "mineru": { "apiKey": "***", "baseUrl": "", "model": "", "prompt": "", "language": "ch", "isOcr": false }, // baseUrl 空 → 官方 https://mineru.net
      "openaiCompatible": { "apiKey": "***", "baseUrl": "", "model": "", "prompt": "", "language": "", "isOcr": false } // baseUrl 空 → https://api.siliconflow.cn/v1
    }
  }
}
```

- `apiKey` 与翻译 BYOK 同一套掩码机制：`settings_get` 返回 `*` 掩码，`settings_set` 收到掩码时保留已存密钥。Paddle key 在 AI Studio 访问令牌页获取；MinerU token 在 mineru.net API 管理页获取；OpenAI 兼容 key 在服务商控制台获取（如硅基流动，前端 `LAYOUT_PROVIDER_DOCS_URLS`）。
- `baseUrl` 为可选端点覆盖：paddle 端点固定（不支持覆盖）；mineru 支持覆盖且强制 https（loopback `http://localhost` 等除外）；openaiCompatible 默认硅基流动。
- `model` 供正文解析引擎使用：openaiCompatible 预设 `PaddlePaddle/PaddleOCR-VL-1.5` / `deepseek-ai/DeepSeek-OCR`（空 → 前者）；paddle 正文预设 `PaddleOCR-VL-1.6` / `PaddleOCR-VL-1.5`（空 → 前者；版面分析固定用 `PP-StructureV3`，不读该字段）。
- `prompt` 仅 openaiCompatible 使用：OCR 提示词覆盖，空 → 按 model id 自动选择。注意 `PaddleOCR-VL` 只接受固定任务提示词，自定义提示词请配指令型 VLM（详见 [paper-import.md](paper-import.md) § 正文解析引擎）。
- `language` 仅 mineru 使用：OCR 语言包（API `language` 参数，顶层字段）。白名单校验（`ch` / `en` / `japan` / `korean` 等 16 个语言包，含仅 Host 侧保留的 `ch_server`），未知值回落 `ch`；UI 只提供「中英文」（`ch`，默认，涵盖简体/繁体/混排）与「纯英文」（`en`）。
- `isOcr` 仅 mineru 使用：强制对所有页面执行 OCR（API `files[].is_ocr`）。默认 `false`，由 MinerU 按文本层自动判断；扫描件文本层缺失/乱码时开启。
- `parserBackend` 与版面 `backend` 独立选择，但共用 `providerConfigs` 凭据池；正文引擎详见 [paper-import.md](paper-import.md) § 正文解析引擎。
- 设置 UI：Settings →「版面解析 / Layout」（版面后端由前端 `LAYOUT_PROVIDERS`、正文引擎由 `PARSER_PROVIDERS` 注册表驱动；所有远程 provider 平铺为配置卡，`mergeProviderCards` 按 provider 合并、按 `requiresApiKey` / `supportsBaseUrl` / `supportsModel` / `supportsPrompt` / `supportsLanguage` / `supportsOcr` 显隐 API Key / Base URL / Model / Prompt / 语言 / 强制 OCR 输入 + 连通性测试；Model / Base URL 空值时预填引擎默认值，语言预填 `ch`（中英文）。两个 backend 下拉只提供本地 + 已配置（apiKey 非空）的 provider）。

#### `layout_remote_analyze_pdf`（已实现）

整份 PDF 的 **异步** 远程解析（无同步逐页接口），按 `provider` 分发到对应 engine：

- **参数**：`{ args: { provider?, pdfBase64, fileName?, apiKey?, requestId? } }`
  - `provider`：`"paddle"` | `"mineru"`，缺省 `"paddle"`（向后兼容）；未知 provider 返回错误。
  - `apiKey` 为空 / 掩码时由 Host 从设置注入（WebView 不持有明文）；`baseUrl` 一律由 Host 从设置读取。
  - `requestId` 用于并行任务把 `layout-remote:progress` 对回调用方。
- **Paddle 流程**：multipart 提交任务 `POST /api/v2/ocr/jobs`（`model: PP-StructureV3`，`Authorization: bearer <token>`，端点固定 `https://paddleocr.aistudio-app.com`）→ 每 3s 轮询 `GET /api/v2/ocr/jobs/{jobId}`（总时限 10 分钟）→ 完成后下载 `resultUrl.jsonUrl`（JSONL）并提取每页 `prunedResult.layout_det_res.boxes`。
- **MinerU 流程**：`POST {base}/api/v4/file-urls/batch` 申请预签名上传 URL → `PUT` 上传 PDF 字节 → 每 3s 轮询 `GET {base}/api/v4/extract-results/batch/{batchId}`（总时限 10 分钟）→ 下载结果 zip，解析 `*content_list.json`（bbox 为 0–1000 归一化，Host 换算回页面像素）+ 中间结果（每页尺寸；条目名按候选匹配：旧版 `*middle.json` / `middle.json`，云端 v4 为 `layout.json`），label 映射到与 PP-DocLayoutV3 统一的词表。不受信 zip 设下载（256 MB）与单条目解压（128 MB）上限；候选条目缺失时报错并列出 zip 实际 entries。
- **进度**：轮询期间 emit `layout-remote:progress`，payload `{ phase, extractedPages, totalPages, requestId? }`（phase：`uploading` / `pending` / `running` / `downloading` / `done`）。
- **并发**：`settings.layout.backend` 为远程 provider 时 JobCenter `layoutAnalyze` **无并发上限**（远端排队）；本地 ONNX 仍 cap=1。
- **返回**：`{ pages: [{ boxes: [{ clsId, label, score, coordinate }], widthPx, heightPx }] }`；渲染像素尺寸优先取服务端报告（Paddle：`dataInfo` / `inputImage` JPEG 头；MinerU：中间结果 `middle.json` / `layout.json` 页尺寸），缺失为 `null`（前端按 200 DPI 估算）。
- **超时 / 代理**：单请求 120s；走 Host 全局代理（`core::http::client_builder`）。
- 实现：`src-tauri/src/features/layout_remote/`（`commands.rs` 命令壳 + `engine.rs` `RemoteLayoutEngine` trait / 注册 + `paddle.rs` + `mineru.rs`）；前端 `src/lib/pdf/layout/paddle.ts`（IPC 封装）+ `providers.ts`（`LAYOUT_PROVIDERS` 注册表）。

#### `layout_remote_probe`（已实现）

- **参数**：`{ args: { provider?, imageBase64, apiKey? } }`（`provider` 缺省 `"paddle"`）
- **行为**：按 provider 走各自最小请求验证端点 + token（paddle 提交一张小图任务返回 `{ jobId }`；mineru 调 `file-urls/batch` 空列表验证鉴权；openaiCompatible 调 `GET {base}/models` 验证 key）。走 Host（无 WebView CORS 限制、遵循代理），供设置页 / Onboarding「测试连接」使用。

#### `settings_get`（已实现）

- **返回**（`ApiResult`）：`{ settings: AppSettings, path: string, existed: boolean }`
- `existed === false` 时前端可将遗留 `localStorage` 的 `agentero-settings` 一次性写入并清除。

#### `settings_set`（已实现）

- **参数**：`{ settings: AppSettings }`（camelCase，与前端 `src/lib/settings` 同构）
- **返回**：规范化后的 `AppSettings`（写盘 + 更新 Host 内存）
- **事件**：保存成功后向**所有窗口** `emit("settings:changed", AppSettings)`（规范化后的快照）。前端 `initSettingsSync()`（`src/lib/settings`）监听该事件更新各窗口内存缓存并通知订阅者（`subscribeSettings`），保证各窗口的设置实时一致。
- `networkProxyEnabled` / `networkProxyUrl` 是 Host 级网络代理配置；启用后所有 Host
  创建的 reqwest HTTP(S)/SOCKS 请求和本地/远端 Agent 进程的代理环境使用该配置。
- **链接改名策略**：`autoUpdateInternalLinks` 为 `"ask"`（默认）或 `"always"`；未知值规范化为 `"ask"`。它只控制可信**本地外部** rename 的 repair，Agentero 发起的显式 rename/move 始终走单次事务预检，remote Vault 不自动修复。

> 设置文件绝对路径已包含在 `settings_get` 返回的 `path` 字段中（About / 诊断用），无独立 command。

UI 入口见 `settings_window_open`：Settings 现为独立原生单例窗口，`?window=settings` 路由由 `src/main.tsx` 分支渲染。

实现：`src-tauri/src/features/settings/`（`mod.rs` + `commands.rs`）、`core/paths.rs`、`src-tauri/src/features/window/commands.rs`。

### 3.10.3 使用记录（XDG `usage.sqlite`）

设备本地活动日志，**不在 Vault 内**。schema v2、列定义与 `kind`/`facet` 对照见 [usage.md](usage.md)。本地记录始终开启（无开关）；非移动端还会按 `telemetry_projection` 白名单把登记的 kind 脱敏投影到 PostHog（受 `telemetryEnabled` 约束，见 [telemetry.md](telemetry.md)）。

#### `activity_record_events`（已实现）

前端 `track()` 缓冲后批量写入。Host 从 `path` / `mode` / `extra` 推导 `paper_path`、`facet`、`qty`、`status`，并同事务 upsert `usage_daily` / `usage_vaults`；写库前先把登记的 kind 脱敏转发到 PostHog。

- **参数**（`args`）：`{ events: ActivityRecord[] }`
- **`ActivityRecord`**：`{ ts?, vault?, kind, path?, mode?, durMs?, extra? }`。调用方不要自己填 `paper_path` / `facet` / `qty` / `status`。
- **返回**：写入条数（`number`）。空数组为 `0`。单批上限 200。
- **说明**：浏览器预览（非 Tauri）前端短路为 `0`。

#### `usage_list`（已实现）

按时间倒序列出事件。`path` 同时匹配 `path` 与 `paper_path` 前缀。

- **参数**（`args`）：`{ vault?, kind?, path?, since?, limit? }`。`limit` 默认 100。
- **返回**：`UsageEvent[]`（含 `paperPath` / `facet` / `status` / `qty`）。

#### `usage_summary`（已实现）

按 `kind` 聚合 `count` 与 `dur_ms`。

- **参数**（`args`）：`{ vault?, since? }`
- **返回**：`{ kind, count, durMs }[]`

#### `usage_clear`（已实现）

清空事件、日聚合与 memories。指定 `vault` 时只清该库，其它 Vault 保留。

- **参数**（`args`）：`{ vault? }`
- **返回**：删除的事件条数。

CLI 对照：`agentero usage which|timeline|summary|clear`（见 [cli.md](cli.md)）。前端入口：`src/lib/activity/`。

### 3.10.4 广场订阅（XDG `feeds.sqlite`）

用户 RSS / Atom / JSON Feed 订阅与条目缓存。**不写 catalog / Vault**。规格见 [../development/plaza-feeds.md](../development/plaza-feeds.md)。

| Command | 说明 |
|---|---|
| `feeds_list` | 订阅列表（置顶在前） |
| `feeds_add` | 添加（HTML 自动发现 + 首拉） |
| `feeds_remove` / `feeds_rename` | 删除 / 改显示名 |
| `feeds_set_pinned` | `{ id, pinned }` 钉到列表最上 |
| `feeds_refresh` | `{ id?, staleOnly? }` 拉源 |
| `feeds_items` | 时间线；`filter`: all / paper / other |
| `feeds_mark_imported` | 标记本机已入库 |
| `feeds_resolve_body` | 打开详情时抓全文 → Markdown |

### 3.10.5 广场 arXiv 推荐（catalog `embed_cache` / `arxiv_rec_state`）

用 Vault 论文库摘要当语料，对当天 arXiv 新论文做 embedding 相似度 + 时间衰减排序。规格见 [../development/plaza.md](../development/plaza.md) §3.4。

| Command | 说明 |
|---|---|
| `recommend_arxiv` | `{ vaultPath, categories?, topN?, force? }` → 排序结果。`categories` 缺省取上次运行、再缺省取 `cs.AI/cs.CL/cs.LG/cs.CV/stat.ML`；`topN` 默认 20（clamp 1–100） |
| `recommend_arxiv_last` | `{ vaultPath }` → 上次结果或 `null`，只读不算 |

- **陈旧短路**：非 `force` 且 `computed_at` 为当天、分类集合一致时，直接返回存量，不发任何网络请求。所以 `vault:opened` 的预热调用通常是零成本的。
- **缓存**：`embed_cache(text_hash, model, dim, vector)` 按 sha256(title+abstract)+model 存小端 f32 向量，语料只 embed 一次；`arxiv_rec_state` 单行存上次运行。均在 catalog schema v6。
- **凭据**：读设置 `embedding`（Base URL / API Key / Model），`POST {baseUrl}/embeddings`。
- **结构化错误**（前端转空态）：`recommend.no_embedding` 未配置端点、`recommend.empty_corpus` 库里没摘要、`recommend.no_candidates` 分类下无新论文。

前端入口：`src/lib/recommend/`。

### 3.11 界面与本地化（UI / i18n）

#### `set_locale`（已实现）

渲染层在语言偏好变化时通知 Host 按新 locale 重建原生应用菜单（macOS 菜单栏）。

- **参数**

```ts
{
  locale: string; // 解析后的具体 locale，如 "en" | "zh-CN"
}
```

- **返回**：`Result<(), String>`（成功为 `()`，失败返回错误信息字符串）。
- **说明**：locale 偏好存于 XDG `settings.json`（`settings_get` / `settings_set`）。Host 启动时以英文兜底构建菜单；前端在 `ensureSettingsLoaded` 后及每次语言切换时调用 `set_locale` 同步。实现见 `src-tauri/src/lib.rs`（`build_menu` + `set_locale`）与 `src-tauri/src/i18n.rs`（菜单词条）。

#### 菜单事件

原生菜单项点击后 Host 通过 `emit("menu:invoked", { action: id })` 广播（`new_window` 除外），前端在 `src/hooks/use-native-menu-events.ts` 单监听按 `action` 分发。action（菜单 id）稳定、不随语言变化；仅菜单显示文案随 `set_locale` 本地化。

| action | 菜单项 | 快捷键 | 说明 |
|---|---|---|---|
| `settings` | Settings… | `⌘,` | 前端监听，打开 App 内设置浮层 |
| `new_window` | New Window | `⌘N` | **Host 直接** `window_new`，不 emit 给前端 |
| `open_vault` | Open Vault… | `⌘O` | 前端监听 |
| `create_vault` | Create Vault… | `⇧⌘N` | 前端监听 |
| `refresh_tree` | Refresh File Tree | `⌘R` | 前端监听 |
| `close_tab_or_window` | Close | `⌘W` | 前端监听：有文档 tab 时关闭当前 tab；无 tab 时 `getCurrentWindow().close()`。**不要**用 PredefinedMenuItem::CloseWindow（会独占 `⌘W`） |
| `toggle_sidebar` | Toggle Sidebar | `⌥⌘S` | 前端监听（左栏 collapsible；与右栏隔离） |
| `split_pane` | Split Pane Right | `⌘\` | 前端监听：向右新增 Dockview pane，论文默认打开 NOTES，否则复制当前 pane |
| `toggle_chat` | Toggle Chat | `⌘L` | 前端监听（右栏 collapsible 常驻；勿条件卸载 Panel） |

前端快捷键（非菜单 emit，见 `src/lib/shell/shortcuts.ts` / `docs/frontend/shell.md` §3.1）：`⌥⌘R` 在 Finder 中显示、`⌥⌘T` 在终端中打开、`⌘←` 折叠选中文件夹、`⇧⌘←` 折叠文件树至默认（仅 `papers/` 展开）、`⌘⌫` 删除选中树项、`⇧⌘I` 魔棒、`⌥⌘←/→` 切换文档标签。`⌘W` 亦可由渲染层 `shortcuts.ts` 直接匹配（与菜单同源逻辑，防抖避免双触发）。

## 3.x Headless CLI（对照）

> 完整语义见 [`cli.md`](cli.md)。CLI **不**走 Tauri invoke，直接 path 依赖 `agentero_lib::services`（无 BYOA）。

| CLI | Host service / command 锚点 |
|---|---|
| `open` / `<PATH>` | 深链唤起桌面 App（`agentero://open?path=…`） |
| `vault create` | `services::vault::create_vault` / `vault_create`（与 GUI `vault_ensure` 同幂等实现） |
| `vault which\|info\|check\|use` | CLI 自管解析 + catalog `ensure_catalog` / `schema_version` |
| `tree` | 磁盘扫描（非 Library 虚拟节点） |
| `paper list\|get\|paths\|delete\|set-read\|tag list\|set\|add\|rm` | `catalog::papers::*`（含 `set_tags` / `list_all_tags`）/ `paper_*` |
| `paper list --tag` / `--query` 含 tags | CLI 侧过滤（读 `list_all`）；Host `paper_list` 仍全量 |
| `paper move` | 文件夹 + Catalog 路径同步 |
| `paper download\|parse` | `lookup::download_paper_assets` / `pdf_parse::parse_paper_body` |
| `trash list\|restore\|purge` | `path_list_trash` / `path_restore_item` / `path_purge_*` |
| `import id\|bib` | `lookup::import_by_identifier` / `import_catalog` |
| `export bib` | `lookup::export_catalog`（`-o`/`--out` 写文件；全局格式用 `--json`） |
| `wiki check` | 只读双链语义检查（`WikiIndex`） |
| `doctor` / `doctor fix` | 聚合诊断与 aliases / visual-marks 修复 |
| `layout list\|get` | `{paper}/source/layout-index.json` |
| `mark list\|get\|add\|delete` | `{paper}/marks/`（区域锚点优先） |
| `usage which\|timeline\|summary\|clear` | XDG `usage.sqlite`（`activity_record_events` / `usage_*`） |
| `config show\|set` | `~/.config/agentero/config.toml`（与 GUI 隔离） |

构建：`cargo build -p agentero-cli` → bin `agentero`。

## 4. 数据模型

完整类型定义见 `docs/backend/data-model.md`。API 中涉及的核心类型包括：

- `VaultInfo` / `RecentVault`
- `FileNode`
- `Paper` / `PaperMetadata`
- `Highlight`
- `ArxivCandidate` / `ArxivImportResult`
- `PdfMetadataDraft` / `PdfImportResult`
- `AgentDescriptor` / `AgentSession` / `AgentResult`
- `GraphNode` / `GraphEdge` / `Backlink`
- `AppError`

## 5. 版本与演进

| 版本 | API 重点 |
|---|---|
| V0.1 | 实现 `vault:*`、`file:*`、`config:*`。 |
| V0.2 | 增加 `arxiv:*`、`paper:*` 命令与异步任务事件；定义 `Paper` 数据结构。 |
| V0.3 | ACP Client + BYOA：会话与流式事件；`permissionMode`（`restricted`/`ask`/`auto`）+ `agent_respond_permission` / `agent:permission-request`；面板 workflow（`summary`/`qa`/`related_work`）；`paper_set_is_read` + paper-reader（可选自动/手动）。 |
| V0.4 | `graph:*`（双链 / 反链 / 图谱）；前端文件变更防抖 `graph_rebuild`。 |
| V0.5 | 抽象 importer，落地 arxiv 与本地 PDF；新增 `pdf:*` 命令与可插拔 `PdfParser`（liteparse 默认 + 云端 MinerU）。 |
| ≤0.5.0 | 全局 Dockview、视觉批注、版面分析、公式解析卡、阅读热力条、Zotero collection tree 迁移、Agent 自动安装/升级、自由模型选择等已发布能力见功能文档；Host 侧一般无需新 paper API。见 [`../frontend/workspace.md`](../frontend/workspace.md)。 |
| 0.6 | 引用关系：`paper_refs_*`（近邻图节点 `role=center\|reference\|citedBy` + stub）；XDG `usage.sqlite`（`activity_record_events` / `usage_*`）；论文 `attachments/` 进文件树。可选 catalog `paper_refs` 表 / Connected Papers 邻域加深仍待做；与 `graph:*` 双链 API 并存。 |
| V0.x | 魔棒 `lookup:*` + 本机 Translator Runtime（见 [`paper-import.md`](paper-import.md)）。 |

后续扩展：

- `importer:import` 统一来源入口。
- `lookup:*` 与 PDF prepare 共用元数据管道。
- ~~`citation:list_neighbors`~~ → 参考文献解析与库内匹配通过 `paper_refs_list` 提供；全库 cites/cited_by 持久缓存仍可加深。
- ~~`search:full_text`~~ → 已用 walk 式 `vault_search`（命令面板）；FTS5 / PDF 正文层仍可替换增强。
- `reader:annotations`（历史规划；划词标注现为前端 `marks/*.json`，不经 Host command）。
- `sync:*` 多设备同步（远期）。
