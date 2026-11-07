# Windows ACP 孤儿进程累积

## 当前修复（2026-11-07）

Windows 本地 ACP 恢复每连接独立 Job，并修正环境继承边界；不再等待 SDK 提供进程树能力。
所有本地 warm / prompt / probe / history 入口统一使用 `acp/process.rs`，协议仍复用 SDK
`Lines`。Unix 和 SSH 仍使用 SDK `AcpAgent`，远端宿主进程管理不在本次范围内。

### 避免再次触发 #772

此前 `5f841360` 的 Job transport 曾因启动兼容回归撤回：
[#772](https://github.com/poco-ai/Agentero/issues/772) 报告 Windows 11 / 0.11.8
的 OpenCode ACP 启动报 `Internal error`，底层为
``environment variable name must not contain `=` ``。`windows-spawn 0.1.0` 会拒绝显式设置
名称含 `=` 的变量，而 `build_child_env()` 会读取并重设当前进程环境。Windows 可能包含
`=C:` / `=D:` 等盘符当前目录条目，Rust 会读出这些名称；报错机器上的具体变量尚未确认。
反馈中通过过滤名称含 `=` 的环境变量再启动应用可恢复 OpenCode，与上述链路一致。
当前不调用 `env_clear`：`windows-spawn` 直接读取原生环境块；应用仅显式设置与当前环境不同
的新增项或覆盖项。未变化的隐藏条目直接继承，不假定原反馈中的具体变量一定是盘符条目。
普通变量继续按现有优先级覆盖，非法配置名称仍由启动器拒绝。
这不是从宿主环境中删除特殊变量，也不修改用户系统环境。
独立测试宿主注入真实 `=Z:` 和 `=ExitCode` 原生条目，重放完整环境后验证原生 `.exe` 仍能读取这些条目、
继承带空格 cwd，并收到普通变量覆盖；另测 `.cmd` 的带空格路径/参数及非法名称拒绝。

## 现象与原因

Windows 上 ACP 适配器在应用退出、warm setup 超时和连接替换后可能留在后台，
重复启动造成内存累积。退出回调原先只停止 Connector / MCP / Bridge 等服务，
没有清理 ACP；Tauri static async runtime 在进程退出时不保证析构其任务，
不能只依赖 SDK 的 `ChildGuard::drop`。

当前锁定的 ACP SDK 1.3.0 在 Unix 终止进程组，但 Windows 仅 kill 直接子进程，
无法回收 launcher 后面的 Agent 及其后代。`warm_agent` 的 60 秒 timeout 原先
仅限制接收 setup 结果，后台任务仍可迟到发布进池。

## 生命周期边界（#774）

- Windows 的所有本地 ACP 入口共用 `acp/process.rs`，继续使用 SDK 的 `Lines` JSON-RPC
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
复用影响判断，验证 guard drop（连续三轮）、连接 task abort、static runtime 场景的显式 shutdown
以及宿主强杀。另验证 stdio initialize/关闭、原生 `.exe` 的环境继承和带空格路径/参数的 `.cmd` shim。
warm 池测试覆盖 pending setup 替换、已借出连接保留及 shutdown 后的迟到启动。
warm setup 测试用虚拟时间覆盖 60 秒超时取消并等待后台回收，以及等待方被取消后继续回收后台连接。
`exit_host_fixture` 及两个环境 fixture 是由父测试单独启动的辅助宿主，默认 ignored。

采用 [windows-spawn](https://github.com/P4suta/windows-spawn) 的原子 Job 创建及 handle 管理，
而非复制 Win32 启动实现。SDK 1.3.0 仅提供普通 spawn，创建后再绑定 Job 会留下宿主强杀的竞态；
因此本地 Windows 启动边界单独管理，待上游具备等价能力后再评估收敛。

验收范围是该连接直接创建且继承 Job 归属的进程树。通过系统服务、计划任务或既有外部守护进程
另行创建的进程不属于该 Job；不能据此保证所有 Agent 的外部服务都随连接退出。

旧版本已留下的进程不属于新 Job；升级后不会自动按名称清扫其他应用启动的同名 Agent，
历史残留需确认路径与归属后一次性清理。远端 SSH 宿主上的 Agent 不由本机 Windows Job 管理。
