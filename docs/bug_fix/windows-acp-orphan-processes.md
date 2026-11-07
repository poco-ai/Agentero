# Windows ACP 孤儿进程累积

## 当前状态（2026-11-07）

`964d03434` / `0692a4c28` 曾重新接入本地 Windows Job 管理及其说明；收到 macOS
兼容性回归反馈后再次撤回，恢复既有 SDK 启动路径。尚未定位 macOS 回归原因，不能据此
断言是 SDK 上游问题。当前先保持兼容性，Windows 进程树残留仍按下述已知限制跟踪。

为恢复 Windows ACP 启动兼容性，已定向回退 `5f841360` 引入的自定义 Windows
`windows-spawn` / Job transport，所有平台恢复使用 `agent-client-protocol::AcpAgent`。
预热超时取消、目标切换回收、阻止迟到发布和退出关闭 warm 池仍保留。

回退原因：[#772](https://github.com/poco-ai/Agentero/issues/772) 报告 Windows 11 / 0.11.8
的 OpenCode ACP 启动报 `Internal error`，底层为
``environment variable name must not contain `=` ``。`windows-spawn 0.1.0` 会拒绝显式设置
名称含 `=` 的变量，而 `build_child_env()` 会读取并重设当前进程环境。Windows 可能包含
`=C:` / `=D:` 等盘符当前目录条目，Rust 会读出这些名称；报错机器上的具体变量尚未确认。
反馈中通过过滤名称含 `=` 的环境变量再启动应用可恢复 OpenCode，与上述链路一致。
SDK 使用标准库进程启动路径，兼容这些 Windows 特殊条目。回归用例
`sdk_launch_accepts_windows_drive_env_and_batch_shims` 覆盖特殊名称及带空格路径/参数的 `.cmd`。

**已知限制仍存在**：SDK 1.3.0 在 Windows 只结束直接子进程，launcher 后代可能残留；
宿主崩溃/强杀及正常退出时未析构的连接也没有完整进程树清理保证。
由 [#774](https://github.com/poco-ai/Agentero/issues/774) 跟踪，后续评估 SDK 的 Windows
进程树回收能力；不按进程名批量杀进程。以下保留原始修复设计和历史验证记录。

## 现象与原因

Windows 上 ACP 适配器在应用退出、warm setup 超时和连接替换后可能留在后台，
重复启动造成内存累积。退出回调原先只停止 Connector / MCP / Bridge 等服务，
没有清理 ACP；Tauri static async runtime 在进程退出时不保证析构其任务，
不能只依赖 SDK 的 `ChildGuard::drop`。

当前锁定的 ACP SDK 1.3.0 在 Unix 终止进程组，但 Windows 仅 kill 直接子进程，
无法回收 launcher 后面的 Agent 及其后代。`warm_agent` 的 60 秒 timeout 原先
仅限制接收 setup 结果，后台任务仍可迟到发布进池。

## 历史修复（Job transport 已回退）

- Windows 的所有 ACP 入口共用 `acp/process.rs`，继续使用 SDK 的 `Lines` JSON-RPC
  transport，启动由 `windows-spawn` 管理。每个连接拥有独立 Job，通过
  `PROC_THREAD_ATTRIBUTE_JOB_LIST` 原子绑定进程，并启用 kill-on-close。
  非继承 Job handle 由宿主持有，连接结束/取消主动终止 Job，崩溃/强杀由内核兜底。
  避免先 spawn 再 AssignProcess 的竞态，Job 绑定失败不启动无保护进程。
- `ExitRequested` / `Exit` 同步 shutdown warm 池和 Windows ACP Job 注册表，
  覆盖正在 setup、在池中、已借出及冷连接；shutdown 幂等并阻止退出后的新启动。
- warm 注册取消 token 及任务身份；setup 超时、失败或等待方取消均回收后台连接。
  slot 替换和 evict 先通知 keepalive，再触发取消；留给空会话删除最多 1 秒，
  随后强制丢弃连接，不让挂起 RPC 阻止回收。任务结束按身份移除 slot，避免旧任务删除新 slot。
- warm 切换目标取消旧的 pending setup 并回收不匹配的 idle slot；已借出的连接继续
  服务当前 prompt。主动取消跳过 AgentWarmGate 的失败熔断，避免 Vault 切换触发 120 秒冷却。

Job 机制见 [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)，
原子创建机制见 [Create a process in a Job](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812)。
日常运行边界见 [Agent 后端文档](../backend/agent.md)。

## 原修复的回归验证（历史记录）

```powershell
cargo check -p agentero --lib
cargo test -p agentero --lib features::agent::acp::process::windows::tests -- --nocapture
cargo test -p agentero --lib features::agent::session::pool::slot_map_tests
cargo test -p agentero --lib features::agent::session::warm::tests
```

Windows 测试创建真实的 PowerShell → CMD → ping 进程树，持有进程 handle 防止 PID
复用影响判断，验证 guard drop、连接 task abort、static runtime 场景的显式 shutdown
以及宿主强杀。另验证 stdio initialize/关闭和带空格路径/参数的 `.cmd` shim。
warm 池测试覆盖 pending setup 替换、已借出连接保留及 shutdown 后的迟到启动。
warm setup 测试用虚拟时间覆盖 60 秒超时取消并等待后台回收，以及等待方被取消后继续回收后台连接。
`exit_host_fixture` 是由父测试单独启动的辅助宿主，默认 ignored。

旧版本已留下的进程不属于新 Job；升级后不会自动按名称清扫其他应用启动的同名 Agent，
历史残留需确认路径与归属后一次性清理。远端 SSH 宿主上的 Agent 不由本机 Windows Job 管理。
