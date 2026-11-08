# macOS 首次精读时弹出 Music / iCloud / Desktop / Downloads 权限

**状态**：已修复（本地 Agent 进程 cwd 不再回落到 `/`）  
**Issue**：#570  
**影响面**：macOS 上所有本地 ACP Agent 的启动阶段；首次使用最明显  
**相关代码**：

- `src-tauri/src/features/agent/acp/client.rs` — `to_acp_agent_local`（Unix cwd 包装；Dsh 自管 cwd，Windows 保留既有策略）
- `crates/agentero-core/src/paths.rs` — `agent_scratch_dir`
- `src-tauri/src/features/agent/session/{run,warm}.rs`、`service.rs`、`acp/probe.rs` — cwd 兜底

## 1. 问题现象

macOS 上首次让 Agent 精读一篇文献并生成笔记时，系统连续弹出多条 TCC 权限请求：

- 「访问 Apple Music、你的音乐和视频活动及媒体资料库」
- 「访问 iCloud 云盘中的文件」
- 「访问下载文件夹 / 桌面文件夹」
- 「访问其他 App 的数据」

一次给一个，用户点完一个又来一个。用户会误以为 Agentero 索取与功能无关的权限。

## 2. 根因

macOS 按「负责进程（responsible process）」归属 TCC 弹窗。Agentero 从
LaunchServices（Finder / Dock / Quick Action）启动时，**进程当前工作目录是 `/`**。
ACP stdio 传输没有 cwd 字段：`NewSessionRequest.cwd` 只告诉 Agent 会话目录，
子进程的 OS-level cwd 仍继承父进程，于是 Agent 以 `/` 作为工作目录启动。

部分 Agent CLI（Codex / Grok / Pi 等）在启动阶段会以「进程 cwd」为工作区做扫描/索引。
从 `/` 递归会进入 `/Users/<user>`，依次触达 `Music`、`Desktop`、`Downloads`、
`Library/Application Support/<其它 App>`、`Library/CloudStorage`（iCloud / OneDrive），
于是对应 TCC 服务被逐个请求——`kTCCServiceMediaLibrary`、
`kTCCServiceSystemPolicyDesktopFolder`、`kTCCServiceFileProviderDomain`、
`kTCCServiceSystemPolicyAppData` 等。

早期 `needs_local_cwd_shell_wrap()` 只对 `Pi` / `Custom` 生效（见
[pi-acp-vault-cwd.md](pi-acp-vault-cwd.md)），其余模板即使会话 cwd 正确，进程 cwd 仍是 `/`。

## 3. 解决方案

1. **Unix 本地 Agent 切到 Vault**：`to_acp_agent_local` 在已知 cwd 时做
   `/bin/sh -c "cd … && exec …"` 包装，不再只限 Pi / 自定义。Dsh 例外：其内置 launcher
   已先切到自己的工作目录，直接保留原命令与参数，不再套外层 shell。
2. **无本地 Vault 上下文时用私有目录兜底**：`run` / `warm` / `list` / `load` 与 Unix 探针
   复用 `agent_spawn_cwd()`；本地 Vault 缺失或无效时取 `agent_scratch_dir()`
   （`…/agentero/agent-cwd`，按需创建）。数据目录不可写时只尝试系统临时目录下的
   `agentero/agent-cwd` 专用子目录；两处均无法创建则在启动前返回包含失败路径的错误，
   不回落到进程 cwd 或整个临时目录。远端保留自身 Vault 路径；
   local-sim 路径失效时在新建连接前明确报错，而非执行后才出现 shell/ACP 错误。
3. **Windows 不把包装扩到其余模板**：会话包装停在 Pi / Custom / Zcode，探针保持直启。
   Zcode 纳入是因为 `server` 模式只认进程 cwd，见
   [zcode-acp-windows-skills-cwd.md](zcode-acp-windows-skills-cwd.md)。
   Windows 没有此 macOS TCC 问题，而 ACP SDK 只强杀直接子进程；再给其他模板加 CMD
   会妨碍原生 Agent 的超时清理，也会让 UNC Vault 被 `cd /d` 拒绝。

## 4. 验收建议

1. macOS 上从一个非 home 目录（例如从 Finder 双击 `.app`）启动 Agentero，打开 Vault。
2. 让 Agent 精读一篇文献并生成笔记。
3. 期望：不再出现 Music / iCloud / Desktop / Downloads 的无关权限弹窗；访问 Vault
   所在卷（如 iCloud / OneDrive）本身仍可能按需请求，属正常。
4. 检查 `~/Library/Application Support/com.apple.TCC/TCC.db` 的 `access` 表，
   确认 Agentero 不再新增 `kTCCServiceMediaLibrary` / `SystemPolicyDesktopFolder` 等条目。

回归测试通过临时文件阻断目录创建，覆盖数据目录优先及复用、专用临时子目录兜底、
两处均不可用时返回错误；不依赖修改全局环境变量或真实目录权限。

## 5. 边界

- 该包装只作用于本地 Agent；SSH 远程 Agent 由 `remote_agent_shell_command` 处理。
- Vault 本身位于云盘（iCloud / OneDrive / CloudStorage）时，读写 Vault 触发
  `kTCCServiceFileProviderDomain` 是预期行为，不在此修复范围。
- Dsh 不套外层 shell，服务进程仍由自带 launcher 切到管理目录后启动。
- Windows 上 Pi / Custom / Zcode 包装的 UNC 限制，以及自带 launcher 的进程树清理限制，仍未解决。
  Windows 发布前需检查探针超时后原生 `.exe` 不残留，并单独记录 shim / launcher 的后代进程；
  不能以 Unix 的进程组测试代替 Windows 实机验收。
