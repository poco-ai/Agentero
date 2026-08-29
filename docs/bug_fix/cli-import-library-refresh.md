# CLI 导入后文件树论文标题不刷新

**影响面**：应用打开本地 Vault 时，从外部 `agentero` CLI 导入论文。

## 现象

应用保持打开，使用 CLI 导入文献后，左侧文件树能看到新论文目录，但论文行先显示目录 ID。只有重新打开论文库 / Vault 后，才显示 Catalog 中的论文标题。

## 原因

- 文件树论文行通过 `paperMetaByRelPath` 从 Library store 取标题、作者、年份等元数据。
- CLI 是外部进程，会写入 `papers/...` 和 `.agentero/catalog.sqlite`。
- Host watcher 旧逻辑过滤了整个 `.agentero/`，前端收不到 Catalog SQLite 变更。
- `useVaultFileEvents` 对外部结构变更只刷新文件树，不刷新 Library；因此新目录出现了，但 Catalog 元数据仍是旧缓存，标签只能回退到目录名 / ID。

## 修复

- watcher 放行 `.agentero/catalog.sqlite`、`catalog.sqlite-wal`、`catalog.sqlite-shm`、`catalog.sqlite-journal`，继续过滤其它 `.agentero/` 内部文件。
- 前端文件事件识别 Catalog 存储变更或 `papers/` 下结构变更后，触发 `scheduleLibraryRefresh()`。
- `scheduleLibraryRefresh()` 后台去抖执行 `paper_list`，不显示 Library loading 状态，避免批量 CLI 导入时闪烁。

## 验证

- `cargo test --manifest-path src-tauri/Cargo.toml --lib features::watcher`
- `pnpm exec tsc --noEmit`

手动预期：应用打开 Vault 后运行 `agentero --json -v <vault> import id <arxiv-or-doi>`，新论文行应自动从目录 ID 更新为标题/作者，无需重开论文库。

## 后续清理

- 前端 `isCatalogStoragePath`（catalog.sqlite 事件分支）已在后续清理中删除：Host watcher 忽略所有 `.agentero/` 路径，该分支收不到事件，属死代码。
- CLI 导入触发 Library 刷新的主路径是结构事件（`payloadAffectsLibrary` 检测 `papers/` 下的新增/删除/重命名），不依赖 catalog.sqlite 文件事件。
