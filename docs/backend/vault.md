# Vault 文件系统

## 职责

打开/创建 Vault；读写文本与二进制；目录树；回收站；文件监听；终端打开。本地或远程 session（远程见 [remote.md](remote.md)）。

## 初始化

```text
用户选择目录（dialog）
  → vault_create / 打开已有
  → papers/ notes/ plans/ .agents/skills/ AGENTS.md
  → notes/ 下三篇本地化新手教程（缺失时才写入）
  → .agentero/catalog.sqlite
  → 前端加载树（Create 后自动打开 notes/01 ...）
```

- 模板：`templates/vault/`。
- 教程模板按 UI 语言存放在 `templates/vault/notes/en/` 或
  `templates/vault/notes/zh-CN/`，写入 Vault 时统一展开到 `notes/` 根目录；
  不覆盖用户已编辑的同名文件。
- `vault_create` 返回的 `openPath` 为首篇教程路径；若教程已存在则回退到 `AGENTS.md`。
- 每次打开会补种缺失的 bundled skills；第一方 `SKILL.md` 仅通过 frontmatter 整数 `version` 安全升级（盘上版本低于模板则覆盖并 toast）。无 `version`、同版本或更高版本的文件保持原样；返回值的 `updated` 列出本次安全升级路径。

## 文件树

| Command | 说明 |
|---|---|
| `vault_tree_build` | 本地一次 IPC 整树 |
| `vault_tree_children` | 懒加载（如 `source/`） |
| `vault_file_fingerprint` | Host 内统一计算本地/远端文件 SHA-256；大 PDF bytes 不跨 IPC |
| `vault_write_text_atomic` | 本地/远端同目录临时文件 + rename，失败保留旧目标并清理临时文件 |
| 路径读写 | `path_read_text` / `path_write_text` / `path_mkdir` / 移动等 |

规则：产品目录全量递归；`source/` 与其它根子目录懒加载；忽略 `.git`/`node_modules`/…  
前端：[../frontend/vault-tree.md](../frontend/vault-tree.md)。

`vault_file_fingerprint` 与 `vault_write_text_atomic` 是后台工作流使用的 Host-owned
边界：调用者只能提供严格 Vault 相对路径。前者只向 WebView 返回
`{ path, size, mtime, hash }`，后者只接收 UTF-8 内容，不暴露临时文件路径。远端由
`remote:<sessionId>` 解析到现有 `VaultFs`；本地会 canonicalize Vault 根和目标父目录，
阻止绝对路径、`..`、UNC/drive prefix 与 symlink 逃逸。

## 回收站

| Command | 说明 |
|---|---|
| `path_trash` | 移入 `.agentero/.trash/`（含 catalog 快照） |
| `path_list_trash` | 列表 |
| `path_restore_item` | 恢复 |
| `path_purge_item` / `path_purge_trash` | 永久删除 / 清空 |

## 文件监听

- Host `notify` → `vault:file-changed`。
- 前端：打开 md 自动重载（有未存则提示）；结构变化局部刷树。
- 代码：`features/watcher/`、`src/lib/vault/fs-watch.ts`。

## Capabilities（摘要）

`src-tauri/capabilities/default.json`：`fs:*` 读写/dir、`dialog`、`opener`（含 reveal）、scope 覆盖 `$HOME/**` 等用户可选目录。

## 其它

- `path_open_in_terminal`：系统默认终端。
- 多窗口：`window_new`、`settings_window_open`、`viva_window_open`。

## 代码

`features/vault/` · `trash/` · `watcher/` · `terminal/` · `window/`
