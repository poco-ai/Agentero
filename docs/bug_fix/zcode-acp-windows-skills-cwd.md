# Windows 上 Zcode 索引不到 Vault 的 `.agents/skills`

**状态**：已修复

**影响面**：Windows 本地 Zcode ACP 的技能列表与会话工作区

**相关代码**：

- `src-tauri/src/features/agent/acp/client.rs` — `windows_process_cwd_template`、`windows_launch_command`
- `src-tauri/src/features/agent/registry/templates.rs` — Zcode 启动参数 `zcode-acp-server server`

## 1. 问题现象

Windows 上用 Zcode ACP 打开含 `.agents/skills` 的 Vault 时，适配器列不出这些 skill。同一 Vault 在 Unix 上可以索引到。

## 2. 根因

`zcode-acp-server server` 是 serve 模式。该模式在 `session/new` 里丢掉客户端传来的 cwd，工作区和技能扫描都用进程自己的 cwd：

- 会话工作区：`server.serveMode ? process.cwd() : sanitizeClientCwd(params.cwd)`
- 技能索引：`path.join(process.cwd(), ".agents", "skills")`

ACP stdio 没有子进程 cwd 字段。Unix 启动前已经 `cd` 到 Vault。Windows 原先只给 Pi / Custom 套 `cmd /D /C`，Zcode 继承 Tauri 进程的目录（安装目录或 `C:\`），因此扫不到 Vault 里的 `.agents/skills`。

在 Vault 下再做 `.zcode/skills` 目录链接不能解决：这个适配器的技能索引不读项目级 `.zcode/skills`。

## 3. 解决方案

Windows 会话启动（run / warm / list / load）把 Zcode 纳入与 Pi / Custom 相同的包装：

```text
cmd /D /C "cd /d %AGENTERO_AGENT_CWD% && %AGENTERO_AGENT_COMMAND%"
```

`server` 参数放在 `AGENTERO_AGENT_COMMAND` 里，不能在包装时丢掉，否则适配器会打开 TUI 而不是 ACP。探针仍不包装。其余模板保持直启。

## 4. 验收建议

1. Windows 上打开含 `.agents/skills/<id>/SKILL.md` 的 Vault，选择 Zcode 开一轮会话。
2. 技能列表里出现该 skill。
3. 设置页探针没有外层 `cmd`。

## 5. 边界

- UNC Vault 上 `cd /d` 仍然失败，Zcode 与 Pi / Custom 一样起不来。不要为了 UNC 把包装扩到其他模板。
- Windows ACP SDK 只结束直接子进程。包了一层 `cmd` 之后，超时清理杀的是 `cmd`，`zcode-acp-server` 可能残留。这与现有 Pi / Custom 限制相同，由 [#774](https://github.com/poco-ai/Agentero/issues/774) 跟踪。
- 用户级 `~/.zcode/skills` 与 `~/.agents/skills` 不依赖 Vault cwd，本次不改。
