# Vault 文件系统

## 职责

打开/创建 Vault；读写文本与二进制；目录树；回收站；文件监听；终端打开。本地或远程 session（远程见 [remote.md](remote.md)）。

桌面命令与 Vault session 的路径参数校验共用 `app/command_util.rs::vault_path_arg`：去除首尾空白并拒绝空路径，再由各调用方执行对应的解析与访问检查。

## 初始化

```text
用户选择目录（dialog）
  → vault_create / 打开已有
  → papers/ notes/ data/ thesis/ .agents/skills/ AGENTS.md
  → notes/ 下三篇本地化新手教程（缺失时才写入）
  → thesis/ 缺失时写入 LaTeX 起手稿 thesis/main.tex
  → .agentero/catalog.sqlite
  → 检测到 claude CLI 时：.claude/skills → ../.agents/skills
  → 前端加载树（Create 后自动打开 notes/01 ...）
```

- 模板：`templates/vault/`。
- 教程模板按 UI 语言存放在 `templates/vault/notes/en/` 或
  `templates/vault/notes/zh-CN/`，写入 Vault 时统一展开到 `notes/` 根目录；
  不覆盖用户已编辑的同名文件。
- `vault_create` 返回的 `openPath` 为首篇教程路径；若教程已存在则回退到 `AGENTS.md`。
- 每次打开会补种缺失的 bundled skills；第一方 `SKILL.md` 仅通过 frontmatter 整数 `version` 安全升级（盘上版本低于模板则覆盖并 toast）。无 `version`、同版本或更高版本的文件保持原样；返回值的 `updated` 列出本次安全升级路径。
- Claude Code 只读项目内 `.claude/skills/`，不认 `.agents/skills/`：探测到 `claude` CLI 且 Vault 内没有 `.claude/skills` 时，创建一条目录链接 `.claude/skills → ../.agents/skills`（`agent_links.rs`），新增/删除 Skill 自动同步。用户自有的 `.claude/skills`（真实目录）保持原样，best-effort 失败只记日志、不影响脚手架。选整目录链接而非逐 Skill 链接：Claude Code 的 loader 用 `readdirSync` + `dirent.isDirectory()` 过滤，逐 Skill 的符号链接目录会被当作普通条目跳过。

## 关闭 / 切换

没有 `vault_close` 命令。vault 的生命期由前端 `vault:opened` 作用域的 teardown 表达（见 [../architecture.md](../architecture.md) 的「生命周期」）：

```text
切换 / 关闭 vault
  → 释放 vault:opened 作用域
  → 各 store 的 vault 级 clear（catalog 行、wiki 重命名流程、
     agent 会话、标注、layout 结果、相关弹窗）
  → vault_release 解除本窗口持有（setup 时的 vault_hold 注册）；
     仅当该 vault 不再被任何窗口持有时，app::vault_session 执行全局释放：
     取消该 vault 的 JobCenter 任务、清 paper caps cache、驱逐该 vault 的
     catalog 连接缓存条目
```

同一 vault 可被多个窗口同时打开，释放序列因此按窗口持有计数收敛；窗口销毁由 `on_window_event(Destroyed)` 兜底清理该窗口的全部持有。

文件监听不需要显式停止：`fs_watch_start` 会替换该窗口的既有 watcher，窗口销毁时由 `on_window_event(Destroyed)` 停止。

## 文件树

| Command | 说明 |
|---|---|
| `vault_tree_build` | 本地一次 IPC 整树 |
| `vault_tree_children` | 懒加载（如 `source/`） |
| 路径读写 | `path_read_text` / `path_write_text` / `path_mkdir` / 移动等 |

规则：产品目录全量递归；`source/` 与其它根子目录懒加载；忽略 `.git`/`node_modules`/…  
前端：[../frontend/vault-tree.md](../frontend/vault-tree.md)。

## 回收站

| Command | 说明 |
|---|---|
| `path_trash` | 移入 `.agentero/.trash/`（含 catalog 快照） |
| `path_list_trash` | 列表（论文项带快照标题 `title`，UI 显示标题而非目录名 ID） |
| `path_restore_item` | 恢复 |
| `path_purge_item` / `path_purge_trash` | 永久删除 / 清空 |

本地与远端 `path_trash` 共用 core `plan_trash` 和同一 `manifest.json` 结构；文件移动仍各自执行，远端 catalog 发布仍在 trash bridge 末尾。论文目录已经不在磁盘上时，删除仍清掉对应 catalog 行（以及同一 id、目录同样缺失的重复行），库列表不再留下「本地无 PDF」的空条目；这种删除没有回收站项。本地 `path_trash` 成功后会取消被删论文的全部排队/运行中 JobCenter 任务（`JobCenter::cancel_for_paper`），避免已删论文继续下载 / 解析。

回收 manifest 在第一次移动前原子保存，逐项记录 `prepared` / `trashed` / `restoring`；旧 manifest 默认 `trashed`。恢复先验证目标冲突，再保存恢复意图。首次移回前先将 manifest 中的 Catalog 快照原子写入回收目录内的 sidecar，使文件监听器在恢复后的 Catalog 插入失败时也能读到最新 metadata；重试已移回项不重写 sidecar。Catalog 中尚未 prune 的缺失子论文目录只跳过 sidecar 写入和上传，不创建目录；其他 IO 错误继续中止恢复。文件已经移回但 Catalog 或远端发布失败时，重试只补缺失的 Catalog 行，不覆盖已恢复后编辑的 metadata。未移动的 prepared 项不显示为已删除文件；恢复可跳过它。批量/单项恢复均在 Catalog 发布成功后才移除对应恢复记录。

远端 manifest 使用临时文件 + rename，不回退到截断写；回收/恢复同样只使用 rename。跨文件系统移动或服务器不支持替换 rename 时明确失败，保留原文件与已有 manifest，不采用可能留下半份目标的 copy+remove。恢复协议处理单次操作中断，不提供并行操作同一回收批次的事务隔离。


## 文件监听

- Host `notify` → `vault:file-changed`。
- Host 空闲时阻塞等待 FS 事件（无定期空转）；有变更时再做约 300ms trailing debounce。停止 watcher 时 drop 原生监听以唤醒阻塞线程。
- 前端：打开 md 自动重载（有未存则提示）；结构变化局部刷树。窗口隐藏/失焦时缓冲 `vault:file-changed`，回到前台再按序 flush；树 / wiki / Library 的去抖在后台会拉长。
- 代码：`features/vault/watcher/`、`src/lib/vault/fs-watch.ts`、`src/lib/vault/file-change-gate.ts`、`src/lib/vault/shell-activity.ts`。

## Capabilities（摘要）

`src-tauri/capabilities/default.json`：`fs:*` 读写/dir、`dialog`、`opener`（含 reveal）、scope 覆盖 `$HOME/**` 等用户可选目录。

## 其它

- `path_open_in_terminal`：用户在「设置 → 通用 → 系统 → 终端应用」选定的终端（`terminalApp`，留空 = 系统默认；macOS 支持 Terminal / iTerm2 / Otty，Windows 支持 Windows Terminal / PowerShell / CMD，Linux 按 PATH 探测常见终端）；所选终端未安装或启动失败时回退到系统默认并不报错。目录自身 / 文件父目录。Windows 复用 `core::process::windows_shell_path` 去掉本地盘符路径的 `\\?\` 前缀，Windows Terminal 的 `-d` 与 CMD 的进程工作目录使用同一结果；CMD 通过隐藏的 `start` 启动进程创建独立交互控制台，不再拼接 `cd` 命令，也不继承桌面应用的关闭 / 重定向输入输出句柄。
- 多窗口：`window_new`、`settings_window_open`。

## 代码

`features/vault/` · `app/vault_session/` · `app/terminal/` · `app/window/`
