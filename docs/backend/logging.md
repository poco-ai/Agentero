# 运行日志

| 层 | 实现 |
|---|---|
| Host | `tauri-plugin-log` + `log`；`crates/agentero-core/src/log_util.rs` |
| 前端 | `src/lib/core/logger.ts` |
| CLI | `env_logger` |

- 与用户 Toast / `ApiResult` **分层**：日志不替代错误 UX。
- 关键操作记录 op start/end。
- 前端启动：`main.tsx` 在 `op start/end frontend_boot` 之间输出 `boot stage=<阶段> ms=<累计>`（entry / settings / theme / i18n / 模块加载）。计时基准是 `performance.now()`，即从页面导航开始，因此包含 HTML 与入口模块本身的加载；多窗口时用末尾的 `window=main|settings` 区分。dev 环境的 Webview console 日志桥接异步附加，不阻塞启动链。
- 全局异常：`main.tsx` 监听 `window` 的 `error` 与 `unhandledrejection` 事件，将未捕获的前端运行时报错与未处理 Promise 拒绝路由至 Host logger，便于排查界面未预期崩溃或白屏/黑屏问题。
- 日志目录由插件约定（Windows 为 `%LOCALAPPDATA%\<identifier>\logs\agentero.log`；macOS 为 `~/Library/Logs/<identifier>/`）。Release 版本默认最高输出 `Info`，不输出 `Debug`/`Trace`。
- 文件轮转策略：单文件 2 MB，最多保留 5 个近期文件（当前 + 4 个归档），避免日志无限累积。
- Settings → About「运行日志」提供：
  - **打开日志文件夹**：`appLogDir()` + opener `openPath`，便于报错时上传日志。
  - **清理日志**：Host `logs_clear` 删除目录内 `agentero*.log`（含轮转归档）；当前仍被 logger 占用的 `agentero.log` 删除失败时改为截断为空，返回清理的文件数。
- 设了 `AGENTERO_PERF_TRACE` 时，同一条 `OpTimer` 会再写一行 JSON 到该文件。前端 span 走 `PERF {json}` 日志，由 Host 追加进同一个文件。用法见 [性能测试轨迹](../test/performance.md)。
