# Pi ACP 启动时未使用 Vault 工作目录

**状态**：已修复（#570 扩展 Unix 包装；Windows 会话包装 Pi / Custom / Zcode，探针直启）

**Issue**：#441（#570 扩展）

**影响面**：使用 Pi Agent 时的工作目录、论文/文件查找；以及 Unix 本地 Agent 的启动 cwd

**相关代码**：

- `src-tauri/src/features/agent/acp/client.rs` — `to_acp_agent_local`、`local_launch_command`、`windows_launch_command`
- `crates/agentero-core/src/paths.rs` — `agent_scratch_dir`（无 Vault 时的安全 cwd）

## 1. 问题现象

在 Windows 上配置 Pi Agent（`pi-acp` 社区适配器）后，每次启动 Agent 提问，Pi 都会去 `C:\` 或系统默认目录查找论文/项目文件，而不是当前 Vault 目录。用户观察到 Pi 似乎“没有注入工作路径”。

## 2. 根因

ACP 的 `NewSessionRequest` 携带 `cwd` 字段，用于告知 Agent 当前会话所属项目目录。但是：

1. `agent-client-protocol` 的 `McpServerStdio` 没有 `cwd` 字段，无法直接设置子进程的 OS-level 工作目录。
2. Pi 本身没有原生 ACP 模式，`pi-acp` 适配器负责把 ACP 消息转给 `pi --mode rpc`。该适配器可能没有把 ACP 的 `cwd` 同步成 `pi` 子进程的工作目录。
3. 因此 `pi` 启动后继承的是父进程（Tauri 应用）的 cwd，在 Windows 上往往是应用安装目录或 `C:\`，导致它去错误位置查找论文。

## 3. 解决方案

对需要注入进程 cwd 的模板，先由 shell 切到 Vault；Unix 再 `exec` 真正的 Agent。包装范围按平台区分，避免为 macOS TCC 修复引入 Windows 启动回归。

### 3.1 包装范围

最初只对 `Pi` / `Custom` 做 shell `cd` 包装。但即使 Agent 正确处理 ACP `NewSessionRequest.cwd`，
它的**进程 cwd** 仍是 Agentero 的 cwd——macOS 上经 LaunchServices 启动的 GUI 进程 cwd 是 `/`，
Agent 启动阶段按进程 cwd 扫描就会遍历整个文件系统（#570，见
[macos-tcc-folder-prompts.md](macos-tcc-folder-prompts.md)）。因此 Unix 本地模板在已知 cwd
时都包装，**Dsh 除外**（自带 launcher 已先切工作目录）。Windows 会话启动包装 Pi / Custom，
以及 Zcode（`zcode-acp-server server` 忽略 ACP cwd，见
[zcode-acp-windows-skills-cwd.md](zcode-acp-windows-skills-cwd.md)）。探针维持直接启动；
不把其他模板变为 `cmd.exe` 的子进程。策略集中在 ACP client，
不再由 `AgentTemplate` 模型持有。

### 3.2 Unix 包装

```text
/bin/sh -c "cd '<vault>' && exec '<command>' '<arg1>' '<arg2>' ..."
```

使用单引号包装每个 token，嵌入的单引号用 `'"'"'` 转义。

### 3.3 Windows 包装（Pi / Custom / Zcode 会话启动）

```text
cmd /D /C "cd /d %AGENTERO_AGENT_CWD% && %AGENTERO_AGENT_COMMAND%"
```

- `AGENTERO_AGENT_CWD` 环境变量携带已加双引号的 Vault 路径，避免 Rust argv 转义破坏内层引号。
- 完整命令通过 `AGENTERO_AGENT_COMMAND` 传递；Pi / Custom / Zcode 共用这层包装，不为其余模板再套 CMD。
- CMD 不支持 UNC 工作目录。Pi / Custom / Zcode 在 UNC Vault 上同样无法 `cd /d`；不要把包装扩到其他模板。

### 3.4 调用点

所有已知 Vault cwd 的本地启动路径都传入 `cwd`（统一由 `agent_spawn_cwd()` 决定）：

- `run_once` — 用户发送 prompt 时
- `warm_agent` — 聊天面板预热
- `list_acp_sessions` — 列出可恢复会话
- `load_acp_session` — 加载历史会话

以上入口在 Vault 路径缺失/无效时用 `agent_scratch_dir()`（`…/agentero/agent-cwd`）兜底，
数据目录不可写时使用系统临时目录下的 `agentero/agent-cwd` 专用子目录，两处均无法创建
则明确报错，不再回落到进程 cwd 或整个临时目录。Unix 的 `probe_agent` 无本地 Vault
上下文，因此使用 scratch；远端沿用
自身 Vault 路径。Windows 探针不传进程 cwd，保持原有直启语义。local-sim 新建连接前验证
Vault 目录存在，路径失效时明确报错；不在本机检查 SSH 路径。

## 4. 验收建议

1. 在 Windows 上打开一个 Vault，选择 Pi Agent 发送与论文相关的提问。
2. 观察 Pi 的查找/读取路径，确认它落在当前 Vault 目录下，而不是 `C:\` 或应用安装目录。
3. 在 macOS/Linux 上重复，确认 Pi 同样以 Vault 为工作目录。
4. macOS/Linux 上其他 ACP Agent（Codex、Claude ACP、Kimi Code、Grok 等）进程 cwd 同样落在
   Vault；Dsh 仍在 launcher 目录启动。Windows 上 Pi / Custom / Zcode 的会话启动有外层 CMD，
   探针与其余模板没有。

## 5. 边界

- 该包装只作用于本地 Agent；SSH 远程 Agent 已在 `remote_agent_shell_command` 中通过 `cd` 处理工作目录。
- Dsh 自己管理 launcher 目录，直接保留原命令与参数；不依赖 Windows 双层 CMD 的嵌套引号或变量展开。
- Windows ACP SDK 只强杀直接子进程；现有 Pi / Custom / Zcode / npm shim / Dsh 自带 launcher 的后代进程
  清理不在本次补齐。统一原生 cwd 与进程树清理前，不把 shell 包装扩到其余模板。Zcode 已纳入，
  因为它的 serve 模式丢弃 ACP cwd。
- 若 `pi-acp` 未来原生支持 ACP `cwd`，仍需分别验证会话目录与启动时进程目录。
