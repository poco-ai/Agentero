# Windows ACP 孤儿进程累积

## 现象与原因

Windows 上 ACP 适配器在应用退出、warm setup 超时和连接替换后可能留在后台，
重复启动造成内存累积。退出回调原先只停止 Connector / MCP / Bridge 等服务，
没有清理 ACP；Tauri static async runtime 在进程退出时不保证析构其任务，
不能只依赖 SDK 的 `ChildGuard::drop`。

当前锁定的 ACP SDK 1.3.0 在 Unix 终止进程组，但 Windows 仅 kill 直接子进程，
无法回收 launcher 后面的 Agent 及其后代。`warm_agent` 的 60 秒 timeout 原先
仅限制接收 setup 结果，后台任务仍可迟到发布进池。

## 修复

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

## 回归验证

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
