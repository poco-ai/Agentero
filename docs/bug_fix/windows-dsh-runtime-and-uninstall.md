# Windows Dsh 静默退出与 npm 卸载目录不匹配

## ACP 静默退出

2026-10-09，在 Windows 隔离目录安装官方 `@deepseek-ai/dsh@0.2.0-rc.2`，
使用官方 Node 22.6.0 Windows x64 可执行文件（经发布 SHA-256 校验）：

- `node22 lib/bin.js --version`：exit 0，stdout / stderr 均为空。
- Node 24.14.0 执行相同入口：exit 0，输出 `0.2.0-rc.2`。
- 标准 npm `dsh.cmd` 同目录放置旧 `node.exe` 后，即使 PATH 上是 Node 24，
  shim 仍优先使用旧 Node，复现同样的静默退出。
- 通过 Agentero 实际 Windows ACP 传输源码发送 `initialize`，得到
  `Incoming transport closed`，错误数据中的 method 为 `initialize`。

官方包入口使用 `if (import.meta.main) await runCli()`；旧 Node 上该属性为
`undefined`，因此 CLI 入口被跳过。这不是仅升级 ACP adapter 能解决的问题。
该属性从 Node 22.18 / 24.2 开始提供，见 [Node 文档](https://nodejs.org/api/esm.html#importmetamain)。
项目 Dsh 模板使用更保守的最低版本 22.19。

修复：仅对标准 Windows npm Dsh shim，校验官方包名和包内 JS bin 入口，
直接选择兼容 Node 运行入口并保留原有 `--profile acp` 参数。优先合并的
Agent PATH，再尝试同目录 Node；运行时能力探测最多等待 5 秒。
无兼容 Node 时返回明确升级提示。自定义 / 桌面命令不作 npm 重写。

修复后的源码启动计划绕过同目录 Node 22.6，实际握手成功，agent name 为
`deepseek-harness-acp`。测试只发送初始化请求，没有模型 prompt。
首次隔离 profile 引导曾超过 50 秒；完整握手验证预先复用了隔离副本中的
官方 npm 依赖，因此不代表全新安装的下载 / 首次引导时延已解决。

## 卸载 prefix 不匹配

另一个隔离副本中，将 Dsh 安装到 prefix A，使用 prefix B 的 npm 执行
`npm uninstall -g @deepseek-ai/dsh`：exit 0，显示 up to date，但 A 中
`dsh.cmd` 和包目录均保留。该情况能造成「点删除没有变化」，但尚不能确认
截图用户的卸载异常就是这一原因，也没有证据将其归因于代理。

修复：从实际 Dsh shim 旁的官方 npm package manifest 判定所属 prefix，
通过子进程环境变量 `npm_config_prefix` 指定卸载位置，避免将路径拼入批处理
命令；即使 JS 入口损坏，仍可定位卸载归属。之后复查 PATH，若另一个 npm
安装或桌面管理的 launcher 仍存在则返回明确错误，保留注册项。

使用实际源码解析出的 prefix 重试后，npm 移除了对应 shim 和包，另一个
隔离安装保持存在。用户 Dsh profile / 凭证目录不在清理范围内。
