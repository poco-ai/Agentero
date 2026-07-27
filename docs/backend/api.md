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
| `agent:stream` | Agent 流式输出 | `{ sessionId, chunk, kind: "message" \| "thought" }`（`thought` = reasoning） |
| `agent:tool` | Agent tool call 创建/更新 | `{ sessionId, toolCallId, title?, kind?, status?, input?, output?, full? }` |
| `agent:plan` | ACP 执行计划 | `{ sessionId, entries: { content, status, priority }[] }` |
| `agent:usage` | 上下文 token 用量 | `{ sessionId, used, size }` |
| `agent:models` | Agent 上报可用模型 | `{ sessionId, agentId, configId, currentId, models: { id, name, group? }[] }` |
| `agent:effort` | ACP 上报 reasoning effort 选项 | `{ sessionId, agentId, configId, currentId, efforts: { id, name, description? }[] }` |
| `agent:fast-mode` | ACP 上报 Fast 开关状态 | `{ sessionId, agentId, configId, enabled }` |
| `agent:completed` | Agent 回答完成 | `{ sessionId, messageId, content, reasoning?, sources, stopReason? }` |
| `agent:failed` | Agent 调用失败 | `{ sessionId, error }` |
| `agent:permission-request` | 权限「每次询问」档：ACP 权限请求转交用户 | `{ requestId, sessionId, title, kind?, paths, options: { optionId, name, kind }[] }` |
| `background-task:progress` | 下载任务的实际字节进度 | `{ taskId, phase, downloadedBytes, totalBytes?, progress? }`；无 `Content-Length` 时 `progress` 为空 |

#### `agent_warm`

打开 Chat 时后台预热 provider（不发用户 prompt）。所有 provider（含 Codex）通过 ACP `initialize` + `session/new` 获取配置（模型、effort 等经 `SessionConfigOption` 协商）。

- **参数**

```ts
{
  agentId?: string;
  vaultPath?: string;
  modelId?: string; // preferred ACP model config value
}
```

- **返回** `WarmResult`：`{ agentId, ok, models?, usageUsed?, usageSize?, error? }`

## 3. Host 层 Tauri invoke API

### 3.1 Vault 与窗口

> **实现状态（V0.1）**  
>
> - 已实现：`vault_create`、`vault_ensure`（snake_case invoke 名）、`vault_allow_fs_scope`、`vault_tree_build` / `vault_tree_children`、`path_open_in_terminal`、`path_trash`（+ `path_list_trash` / `path_restore_item` / `path_purge_item` / `path_purge_trash`）、`window_new`、`set_locale`。  
> - 打开 Vault / 最近列表：当前主要由前端 `plugin-fs` + `localStorage`/`sessionStorage` 完成；本地树加载走 Host `vault_tree_build`（一次 IPC）；打开或恢复时会调用 `vault_ensure` 补种缺失 bundled skills。Host 侧 `vault:open` / `vault:recent` 仍为规划契约。  
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
    openPath: string;  // 建议首开，如 AGENTS.md
  };
}
```

- **行为**
  - 确保目录存在；脚手架 `papers/`、`notes/`、`plans/`、`.agentero/`、**`.agents/`**、**`.agents/skills/`**。
  - 初始化 `.agentero/catalog.sqlite`（schema 当前版本，含 Translator 元数据列）。详见 [`catalog.md`](catalog.md)。
  - 写入默认 `AGENTS.md`（若不存在）。
  - 写入 **`.agents/README.md`**（若不存在；内容来自仓库 `templates/vault/.agents/`）。
  - 种子 **bundled skills**（已存在则跳过）：`paper-reader`、`agentero-cli`、`idea-evaluator`、`deep-research`（后两者含 `references/`，来自 [Supervisor-Skills](https://github.com/HKUSTDial/Supervisor-Skills)，**CC BY-NC-SA 4.0**；另写 `skills/README.md` 与 `LICENSE-Supervisor-Skills.txt`）。
  - **不**创建根级 `PAPERS.md` / `library.bib`；**不**覆盖已有 `AGENTS.md` / `.agents/**`。
  - 最近列表由前端在成功打开后写入 `localStorage`（`agentero-recent-vaults`）。

#### `vault_ensure`（已实现）

幂等脚手架 / 同步缺失 bundled skills（Host `ensure_vault`，与 `vault_create` 同一实现）。**打开或恢复 Vault 时**前端调用，以便应用更新后把**新增** skill 写入 `.agents/skills/`。

- **参数**

```ts
{
  path: string; // 本地绝对路径
}
```

- **返回**：同 `vault_create`（`ApiResult<CreateVaultResult>`；`created` 仅含本次新建的相对路径）。

- **策略**
  - **只补缺失**：目录 / `AGENTS.md` / 模板里有而盘上没有的 skill 文件。
  - **从不覆盖**：用户改过的 `SKILL.md` 或 references 保持原样。
  - 应用升级新增的 skill（如后续模板里加的 id）会在下次打开 Vault 时自动出现。
  - 前端：若 `created` 含 `.agents/skills/<id>/…`，右上角 success toast（`vault.skillsSeeded`）提示新增 skill 名称；无新增则不打扰。

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
};
```

- **语义**（Rust `features/vault/tree.rs`，与 `src/lib/vault/tree.ts` 的远端路径保持一致）：
  - eager 根（`papers/` / `notes/` / `plans/` / `.agents/`）全量递归；其它根目录列一层，子目录 `childrenPending`。
  - **论文文件夹内的 `source/`**（含 `metadata.json` / `NOTES.md` / `PAPER.md` 任一 marker 的目录）不再递归 —— arXiv e-print 解压产物动辄上百文件，标记 `childrenPending` 懒加载。
  - 忽略名（`.git` / `.venv` / `node_modules` / `*.egg-info` / 其它 dot 名，白名单 `.agents` / `.env.example`）与深度上限 12 同前端规则。
  - 排序仍在前端（`sortNodes`，locale 感知）。
- **局部刷新**：`vault:file-changed`（非 `modify`）携带的路径经 `collectTreeRefreshTargets`（`src/lib/vault/tree.ts`）映射到已加载的最近祖先目录节点，防抖 400ms 后仅对这些目录调 `vault_tree_children` 打补丁；根级变化 / 目标过多（>8）/ 无路径信息时回退整树 `vault_tree_build`。

#### 远程 Vault（SSH/SFTP，MVP 已实现）

设计见 [`remote.md`](remote.md)。前端伪路径 `remote:<sessionId>`；文件权威在远端。

| Command | 说明 |
|---|---|
| `remote_connect` | `{ host, user?, remotePath }` → `RemoteSessionInfo`（含 `vaultHandle`、`caps`） |
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
| `remote_vault_ensure` | `{ sessionId }` → 通过 SFTP 补种缺失 bundled skills，不覆盖远端用户文件 |
| `host_identity` | 本机 hostname + `os`（macos/windows/linux）/ 设置 Host 徽章 |
| `remote_host_identity` | 远端 `uname -s` → `os` 家族（Host 徽章系统图标） |

Host 还支持 `__local_sim__` host（本机目录当远端，单测/开发用）。

**远程超时与保活**：SSH/SFTP 建连、SFTP subsystem 启动和远端根目录校验默认最多 15 秒；每次 SFTP 文件操作默认最多 30 秒。SSH 使用 `ServerAliveInterval=30` 和 `ServerAliveCountMax=3`，约 90 秒无响应后判定连接失效。远端 `uname`/`which` 探测最多 30 秒；远端 ACP Agent 仅限制 15 秒建连，不限制正常运行时长。当前不自动重连、不重放写操作，详见 [`remote.md`](remote.md) §2.1。

**入库入口与远程 Vault**：

| 入口 | Command | 远程 `remote:…` |
|---|---|---|
| 魔棒标识符 | `lookup_import_batch` | ✅ staging → SFTP → catalog PUT |
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
  - Capability 覆盖 `main` 与 `agentero-*`（见 `src-tauri/capabilities/default.json`）。
  - 菜单点击由 Host 直接调用，不经过前端 event 往返（Host 内用 `tauri::async_runtime::spawn` 调用）。
  - **必须是 `async` command**：同步 command 在主线程、且处于调用方 webview 的 IPC 回调内执行，Windows 上从那里 build webview 会卡死（wry 进入嵌套消息循环等 WebView2 controller 回调，而该回调要等当前处理器返回），新窗口表现为空白且无法关闭。

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
  - macOS 使用 Overlay 标题栏与原生交通灯；Windows / Linux 使用系统原生窗口边框（OS 自绘标题栏与 caption 按钮）。
  - 窗口关闭时 Host 向所有窗口 `emit("settings_window_closed", ())`，便于主窗口同步 Settings 打开状态（实现 `⌘,` _toggle_）；建窗失败时也会 emit 一次，避免 toggle 卡在“已打开”。
  - 与 `window_new` 同理，**必须是 `async` command**。

#### `fs_watch_start` / `fs_watch_stop`（已实现）

按窗口启停 Vault 文件系统监听（Rust `notify` 递归监听），用于外部编辑器 / Agent 写盘后自动重载编辑器与文件树。

- **`fs_watch_start`**
  - **参数**：`{ vaultPath: string }`
  - **返回**：`Result<(), String>`
  - **行为**：为当前窗口（label）启动递归监听；若该窗口已有监听则先停止再重建。命中变更时按窗口 `emit_to` 发送 `vault:file-changed`（去抖 ~300ms，过滤 `.agentero/`、`.git/`、`node_modules/`）。只有 `notify` 的单事件 `RenameMode::Both`、恰有两条不同路径且均未被过滤时，payload 才带按顺序排列的 `rename.from` / `rename.to`；其它 rename 事件只用于刷新，绝不能授权改写 Vault 内容。
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
  - 校验 Vault 结构（至少存在 `papers/`、`notes/`、`plans/`；确保 `.agentero/catalog.sqlite` 可打开或可初始化）。
  - 打开 catalog、执行 schema migration；若存在历史 `papers/*/metadata.json` 且 catalog 为空则导入（见 catalog 迁移）。
  - 文件监听由前端打开 Vault 后调用 `fs_watch_start`（已落地；见上），非本命令内隐式启动。
  - 返回完整文件树。

#### `vault:close`（规划）

关闭当前 Vault。

- **参数**：无
- **返回**：`{ ok: true; data: null }`
- **行为**：停止文件监听，释放资源，不删除数据。

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

### 3.3 arXiv 入库

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
  - 创建 paper 文件夹（默认 `papers/<id>/`，允许 `papers/<org>/…/<id>/`）与 `source/`；**元数据写入 catalog**（`path` = 该文件夹；不写默认 `metadata.json`）。
  - 下载 LaTeX source、PDF、HTML 到 `source/`。
  - 无 tex 源或需要可读结构化正文时，生成 `papers/<id>/PAPER.md`。
  - 调用 Agent 生成 `papers/<id>/NOTES.md`。
  - **不**自动更新根级 `PAPERS.md` / `library.bib`（需要时由用户触发 `catalog:export_*`）。

```

### 3.4 本地 PDF 入库

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
    provider?: string;       // bing (default) | youdao | huoshanweb | tencenttransmart | googleapi | google | libre
    freeBaseUrl?: string | null; // libre 必填
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
| `connector:item-saved` | `{ path, id, title, deduped, sessionId }` — 前端刷新树/Library 并 `openPaper` |
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
    concurrency?: number;           // 最大并发入库数，默认 3，范围 1–10
  }
  ```

- **返回**：

  ```ts
  {
    ok: true;
    data: {
      imported: LookupImportResult[];
      skipped: { raw: string; kind: string; value: string; reason: 'duplicate_in_batch' | 'already_in_library' }[];
      errors: string[];
    }
  }
  ```

  其中 `LookupImportResult` 为单条入库结果（含 `paperDir`、`path`、`id`、`title`、`usedTranslator`、`translatorBaseUrl`、`pdf?`、`tex?`、`paperMd?`、`assetMessages?`）。
- **单条行为**：Translator 优先；失败且输入为 arXiv 时回退 export.arxiv.org；**catalog upsert**（权威）+ 写 `NOTES.md` 壳（摘要块优先经免费 MT 译为中文，失败则保留原文；catalog 中 `abstract` 仍为原文）；`metadata.json` 为 catalog 投影同步；**始终下载 PDF**；**arXiv 另下载 e-print 并解压 LaTeX** 到 `source/`；下载后若**无 TeX 且有 PDF 且无 `PAPER.md`**，用 **liteparse** 生成 `PAPER.md` 并更新 `body_source` / `body_quality`。
- **行为**：
  1. 逐条解析 `texts`；未识别则加入 `errors`。
  2. 按规范化 value 去重（arXiv 去 version、DOI 小写等）；batch 内重复 → `skipped.reason = 'duplicate_in_batch'`。
  3. 查 catalog：`arxiv_id` / `doi` / `isbn` / `pmid` / `id` 已存在 → `skipped.reason = 'already_in_library'`。
  4. 其余以 `concurrency`（默认 3，范围 1–10）为上限并发调 `import_by_identifier_with_progress`，共用 `taskId`；单条失败继续，错误加入 `errors`。并发上限可在 **Settings → General → Batch import concurrency** 调整。
  5. 前端收到 `imported` 后刷新树 / Library / wiki，并对其中仍缺资源的 paper 逐个入下载队列，每篇一个独立的 `download` 后台任务，按并发上限排队执行。**不**自动连跑 paper-reader。

#### `paper_download_assets`

为已有 paper 文件夹补下载缺失的 PDF（及 arXiv LaTeX）。用于文件树单篇 Download，以及 Library 行「下载全部缺失」。下载后若无 TeX，同样尝试生成 `PAPER.md`。

- **参数**（invoke 字段名 `args`）：

  ```ts
  {
    vaultPath: string;
    path: string; // Vault 相对 paper 文件夹，如 papers/1706.03762
    taskId?: string; // 前端后台任务 id，用于接收 background-task:progress
  }
  ```

- **返回**：`{ ok: true; data: { pdf: boolean; tex: boolean; paperMd: boolean; messages: string[] } }`
- **行为**：读 catalog 取 `pdf_url` / `arxiv_id` / `doi`；已有对应文件则跳过；PDF → `{paper}/{id}.pdf`（论文根目录）；arXiv e-print TeX → 解压进 `source/`；无 TeX + 有 PDF + 无 `PAPER.md` → liteparse → `PAPER.md`。下载客户端使用**浏览器 UA**（绕开部分出版商 403）；若直链/arXiv 候选都失败且有 `doi`，再查 **Crossref** 取直链 / OA PDF 兜底。打开 paper 预览时若无本地 PDF 也会自动调用本命令（失败则回退远程 `pdf_url`）。当传入 `taskId` 且响应提供 `Content-Length` 时，通过 `background-task:progress` 按实际已接收字节数推送百分比；无法得知总大小时只推送不确定进度。

#### `background_task_cancel`

请求取消一个前端后台任务。参数为 `{ taskId: string }`；下载任务会中止当前读取流，批量任务和 Agent 工作流在协作取消点停止。取消是尽力而为，不回滚已经写入的文件。

#### `paper_stage_import_file`

将「无绝对路径」的 OS 拖放 PDF（macOS WKWebView 常无 `File.path`）以 base64 写入 `~/.agentero/import-tmp/`，返回绝对路径供 `paper_import_local_pdf` 使用。

- **参数**（`args`）：`{ fileName: string; contentBase64: string }`
- **返回**：`{ ok: true; data: { path: string } }`

#### `paper_import_local_pdf`

把本地 PDF 导入为 paper 文件夹（复制 + catalog + liteparse），**无网络查询**。入口：魔棒弹层原生 PDF 选择器；或将 PDF **拖到左侧树 `papers/` 组织夹** → metadata 确认对话框后再导入。

- **参数**（invoke 字段名 `args`）：

  ```ts
  {
    vaultPath: string;
    parentDir: string;   // Vault 相对，如 papers 或 papers/nlp
    filePaths?: string[]; // 仅路径（无 overrides）时用；`entries` 非空时忽略
    entries?: Array<{    // 推荐：路径 + 可选 metadata（确认对话框）
      filePath: string;
      title?: string;
      authors?: string[];
      year?: number;
      id?: string;       // 文件夹 slug 偏好；Host 仍会做 -2/-3 去重
    }>;
  }
  ```

- **返回**：`{ ok: true; data: { papers: LookupImportResult[]; errors: string[] } }`（`errors` 为 `"<文件>: <原因>"`；仅当**全部**失败才整体 `ok:false`）。
- **行为**：每个 PDF → 标题/id 优先用 `entries` 覆盖，否则文件名 stem；复制到 `{slug}.pdf`；写 `NOTES.md` 壳 + catalog（type `pdf`，可含 authors/year）；无 TeX → liteparse `PAPER.md`。不覆盖已存在文件夹（slug 去重）。

> **无 TeX 正文生成**：对无本地 TeX 的 paper，`paper_download_assets` / 魔棒入库在下载后自动用 liteparse 从 PDF 生成 `{paper}/PAPER.md` 并写 catalog `body_source` / `body_quality`；不再有独立的 `paper_parse_body` command（**Zap 图标**现用于 paper-reader 精读）。

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
- **行为**：有 TeX 时解析 TeX/Bib 并用 PDF bbox 做定位；无 TeX 时使用 liteparse。不得覆盖原始 PDF、TeX/Bib、`NOTES.md` 或 `PAPER.md`。完整 schema 见 [`../development/pdf-analysis.md`](../development/pdf-analysis.md)。

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
- **注意**：`/export` **要求 body 为 Zotero items 数组**，不是 Agentero `PaperMetadata` 蛇形字段；转换在 Host `zotero_io::paper_record_to_zotero_item`。

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
- **说明**：UI 预览链接从此接口读取；`metadata.json` 仅作同步投影。

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

扫描 `papers/` 磁盘目录，用每个 paper 文件夹的 `metadata.json`（catalog 投影）**重建 / 补齐 catalog 行**——找回“盘上有、catalog 无”的论文（外部拷入，或历史删除顺序 bug 丢失的行）。幂等。

- **参数**（invoke 字段名 `args`）：`{ vaultPath: string }`。
- **返回**：`{ ok: true; data: { count: number } }`（重新导入的 paper 数）。
- **行为**：递归遍历 `papers/`，遇含 `metadata.json` 的文件夹即为 paper 叶子；反序列化时**回填** `path`（投影省略），`upsert` 进 catalog。不删行、不改磁盘文件。
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

更新 catalog 中单篇论文的 **`is_read`**（是否已完成 paper-reader 精读）。成功后同步 `metadata.json` 投影。

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

整表替换 catalog 中单篇论文的 **`tags`**（`tags_json`）。成功后同步 `metadata.json` 投影。

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
- **CLI**：`agentero paper tag set|add|rm <ref> …`（`set` 整表替换，`--clear` 清空；CLI 仅传裸名称，不设色）；`paper list --tag` 筛选；`paper tag list` 汇总。见 [`cli.md`](cli.md)。

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

通用 ACP provider 创建或恢复会话并发送 prompt。所有 provider（含 Codex）统一使用 ACP `session/new` 或 `session/resume` 管理会话；历史经 `session/list` + `session/load` 获取。

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
  template?: 'opencode' | 'gemini' | 'claude-acp' | 'codex-acp' | 'qodercli' | 'custom';
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

删除注册项（不卸载用户本机 CLI）。

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

#### `agent_open_install_terminal`（已实现）

打开系统终端，展示指定 catalog 模板的 **安装命令**，并 **等待用户按 Enter（Windows：任意键）后才执行**。不静默安装；UI 不得传入任意 shell——仅允许模板内置的 `install_command`。

- **参数**：`{ templateId: string }`（如 `claude-acp`）
- **返回**：`{ ok: true; data: null }`
- **行为**
  - 查找内置模板的 `installCommand`；无则报错。
  - 写入临时脚本 → 打开系统默认终端运行该脚本（打印命令 → 确认 → 执行 → 提示回到 Settings 点 Refresh）。
  - Claude：`npm i -g @agentclientprotocol/claude-agent-acp`（需本机已装 Claude Code 与 npm）。
- **Catalog 扫描字段**（`agent_scan_catalog`）：`detect` 对 Claude 使用 `claude`；`command` 仍为 `claude-agent-acp`。当 `binaryAvailable && !acpCommandAvailable && installCommand` 时 `offerInstall: true`。

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
  workflow?: 'summary' | 'qa' | 'related_work' | 'free'; // 默认 'free'
  target?: string; // workflow 为 summary/qa/related_work 时的目标文件路径
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

Windows：未设 `XDG_CONFIG_HOME` 时回退 `%APPDATA%/agentero/`。旧版 macOS 路径 `~/Library/Application Support/agentero/` 在首次启动时 **best-effort 复制** 到 XDG 路径。

#### `settings_get`（已实现）

- **返回**（`ApiResult`）：`{ settings: AppSettings, path: string, existed: boolean }`
- `existed === false` 时前端可将遗留 `localStorage` 的 `agentero-settings` 一次性写入并清除。

#### `settings_set`（已实现）

- **参数**：`{ settings: AppSettings }`（camelCase，与前端 `src/lib/settings` 同构）
- **返回**：规范化后的 `AppSettings`（写盘 + 更新 Host 内存）
- **事件**：保存成功后向**所有窗口** `emit("settings:changed", AppSettings)`（规范化后的快照）。前端 `initSettingsSync()`（`src/lib/settings`）监听该事件更新各窗口内存缓存并通知订阅者（`subscribeSettings`），保证各窗口的设置实时一致。
- **链接改名策略**：`autoUpdateInternalLinks` 为 `"ask"`（默认）或 `"always"`；未知值规范化为 `"ask"`。它只控制可信**本地外部** rename 的 repair，Agentero 发起的显式 rename/move 始终走单次事务预检，remote Vault 不自动修复。

> 设置文件绝对路径已包含在 `settings_get` 返回的 `path` 字段中（About / 诊断用），无独立 command。

UI 入口见 `settings_window_open`：Settings 现为独立原生单例窗口，`?window=settings` 路由由 `src/main.tsx` 分支渲染。

实现：`src-tauri/src/features/settings/`（`mod.rs` + `commands.rs`）、`core/paths.rs`、`src-tauri/src/features/window/commands.rs`。

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

原生菜单项点击后 Host 通过 `emit(id, ())` 广播，前端在 `src/App.tsx` 监听。事件名（id）稳定、不随语言变化；仅菜单显示文案随 `set_locale` 本地化。

| 事件名 | 菜单项 | 快捷键 | 说明 |
|---|---|---|---|
| `settings` | Settings… | `⌘,` | 前端监听，打开 App 内设置浮层 |
| `new_window` | New Window | `⌘N` | **Host 直接** `window_new`，不 emit 给前端 |
| `open_vault` | Open Vault… | `⌘O` | 前端监听 |
| `create_vault` | Create Vault… | `⇧⌘N` | 前端监听 |
| `refresh_tree` | Refresh File Tree | `⌘R` | 前端监听 |
| `close_tab_or_window` | Close | `⌘W` | 前端监听：有文档 tab 时关闭当前 tab；无 tab 时 `getCurrentWindow().close()`。**不要**用 PredefinedMenuItem::CloseWindow（会独占 `⌘W`） |
| `toggle_sidebar` | Toggle Sidebar | `⌥⌘S` | 前端监听（左栏 collapsible；与右栏隔离） |
| `toggle_chat` | Toggle Chat | `⌘L` | 前端监听（右栏 collapsible 常驻；勿条件卸载 Panel） |

前端快捷键（非菜单 emit，见 `src/lib/shell/shortcuts.ts` / `docs/frontend/shell.md` §3.1）：`⌥⌘R` 在 Finder 中显示、`⌥⌘T` 在终端中打开、`⌘←` 折叠选中文件夹、`⇧⌘←` 折叠文件树至默认（仅 `papers/` 展开）、`⌘⌫` 删除选中树项、`⇧⌘I` 魔棒、`⌥⌘←/→` 切换文档标签。`⌘W` 亦可由渲染层 `shortcuts.ts` 直接匹配（与菜单同源逻辑，防抖避免双触发）。

## 3.x Headless CLI（对照）

> 完整语义见 [`cli.md`](cli.md)。CLI **不**走 Tauri invoke，直接 path 依赖 `agentero_lib::services`（无 BYOA）。

| CLI | Host service / command 锚点 |
|---|---|
| `vault create` | `services::vault::create_vault` / `vault_create`（与 GUI `vault_ensure` 同幂等实现） |
| `vault which\|info\|check\|use` | CLI 自管解析 + catalog `ensure_catalog` / `schema_version` |
| `tree` | 磁盘扫描（非 Library 虚拟节点） |
| `paper list\|get\|paths\|delete\|set-read\|tag list\|set\|add\|rm` | `catalog::papers::*`（含 `set_tags` / `list_all_tags`）/ `paper_*` |
| `paper list --tag` / `--query` 含 tags | CLI 侧过滤（读 `list_all`）；Host `paper_list` 仍全量 |
| `paper download\|parse` | `lookup::download_paper_assets` / `pdf_parse::parse_paper_body` |
| `import id\|bib` | `lookup::import_by_identifier` / `import_catalog` |
| `export bib` | `lookup::export_catalog`（`-o`/`--out` 写文件；全局格式用 `--json`） |
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
| ≤0.2.1 | 全局 Dockview 等已发布能力见功能文档；Host 侧一般无需新 paper API。见 [`../frontend/workspace.md`](../frontend/workspace.md)。 |
| 0.6 | 引用关系：`citation:*` 或 catalog 扩展表（cites / cited_by 缓存）、远程元数据补全、文内引用解析；与 `graph:*` 双链 API 并存。 |
| V0.x | 魔棒 `lookup:*` + 本机 Translator Runtime（见 [`paper-import.md`](paper-import.md)）。 |

后续扩展：

- `importer:import` 统一来源入口。
- `lookup:*` 与 PDF prepare 共用元数据管道。
- `citation:fetch` / `citation:list_neighbors`（名称待定）：引用/被引邻域与缓存刷新（路线图 0.6）。
- ~~`search:full_text`~~ → 已用 walk 式 `vault_search`（命令面板）；FTS5 / PDF 正文层仍可替换增强。
- `reader:annotations`（历史规划；划词标注现为前端 `marks/*.json`，不经 Host command）。
- `sync:*` 多设备同步（远期）。