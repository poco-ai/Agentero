# Dsh 重启后标题变成 ID、正文无法恢复

## 原因

截图中的正文错误是 `session/load: Method not found`，不是删除成功或日志丢失
的证明。官方 Dsh ACP 桥声明 `sessionCapabilities.list` / `resume`，但没有
`loadSession`，也未注册 `session/load`。`session/resume` 只恢复模型上下文，
不会回放 UI 正文；`session/list` 又不提供标题。

Agentero 的 transcript 原本仅保存在进程内，重启后从 ACP 回放恢复。历史
打开及后台标题补全都调用 `agent_load_session`，Host 之前未检查能力便发送
`session/load`，因此同一问题既使正文报错，又使标题只能回退 UUID 前缀。

依据：官方 npm `@deepseek-ai/dsh-acp@0.2.0-rc.2` 的初始化与 RPC 注册源码，
以及上游 [Discussion #6393](https://github.com/deepseek-ai/deepseek-harness/discussions/6393)。
不能据截图断言用户磁盘中的会话文件一定完整；恢复仍依赖实际落盘日志。

## 修复

- Host 先检查 `loadSession`，有能力时继续原有 ACP 回放。
- 本机 Dsh 缺少能力时，使用启动时相同的合并环境解析 `DSH_HOME`，只读其
  `sessions/<project>/<uuid>/session[.vN].jsonl[.zstd]`。不创建新历史数据库、
  不重写、修复或迁移原日志。
- 核对 UUID、header、workspace 和连续 seq；读取最新已提交的 v2–v4 格式，
  支持多个追加 Zstd frame，解压后限制 64 MiB。损坏、歧义、旧版 packed
  格式与未来格式明确报错，避免用较旧 generation 静默覆盖新内容。
- 复用 `ReplayBuilder` 恢复用户 / Assistant 文字、推理和工具记录，以及
  `session/title`；排除插件注入的 user context。现有标题补全链路可重新从
  首条用户消息推导和缓存标题。续聊仍走官方 `session/resume`。

兼容范围仅为本机 Dsh 的标准 JSONL 存储。远端、profile 自定义的 persistence
root、v0/v1、未来格式和图片附件不保证恢复；不会扫描不相关数据目录。

## 验证

- Windows 单元测试覆盖压缩多轮、文字 / 推理 / 工具记录、标题、最新
  generation、错误 Vault、非法 session id、未知版本、损坏文件与环境路径。
- 手工集成测试使用隔离 DSH_HOME 和已准备依赖的官方 ACP profile。通过
  官方 Session 与物理 codec 校验后生成 v4 日志，使用多个 Zstd frame。
  `official_dsh_history_survives_fresh_processes` 从官方桥列出该会话，并在两次
  独立 ACP 进程中恢复相同标题和四行多轮正文，不调用模型 API。
- 集成测试为 opt-in，需要 `AGENTERO_DSH_HISTORY_NODE`、`ENTRY`、`HOME`、
  `CWD` 环境变量指定隔离 fixture；默认单测不下载或启动外部 Agent。

此验证覆盖 Host 历史加载与进程重建；不等价于完整 GUI 重启测试，也不覆盖
首次 profile 下载或真实模型推理。
