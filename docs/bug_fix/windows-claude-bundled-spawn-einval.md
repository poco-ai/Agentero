# Windows 内置 Claude ACP 的 spawnEINVAL

## 触发与根因

用户通过 npm 安装 Claude Code，PATH 只有 `claude.cmd`，未安装独立的
`claude-agent-acp` 时，Agentero 会使用内置适配器。旧实现将 `claude.cmd` 的绝对路径
注入 `CLAUDE_CODE_EXECUTABLE`。Claude SDK 把该路径当作原生可执行文件直接 spawn，
于是 `session/new` 返回 `Internal error: { details: "spawnEINVAL" }`。

Node 的 [2024-04-10 安全更新](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)
明确禁止未开启 shell 时直接 spawn Windows `.cmd` / `.bat`。内置适配器要求 Node ≥22，
因此不能依赖旧 Node 的行为。

## 修复

- 校验放在内置 Claude host 解析层，不改变其他命令的 PATHEXT 发现规则。
- 原生 `.exe` 保持直启；npm shim 优先解析邻接的
  `node_modules/@anthropic-ai/claude-code/bin/claude.exe`（新版 npm 包，校验 PE），
  否则解析 `node_modules/@anthropic-ai/claude-code/cli.js`，由 Claude SDK 通过 Node 启动。
- 显式 `CLAUDE_CODE_EXECUTABLE` 优先，但 shim 也必须转换；无效覆盖不回退 PATH。
- 缺少可启动入口时，启动规划和注册可用性检查共用错误提示，要求修复 npm 安装、
  使用 Claude 原生安装器，或配置存在的 `claude.exe` / `cli.js`。
- 不解析或执行 shim 内容，不开启 shell，不关闭 Node 的安全修复。
- PATH 安装的完整 ACP 适配器仍优先，远端 SSH 入口保持原有行为。

## 验证

回归用例覆盖带空格的 npm 目录、`.cmd` / `.bat` / `.ps1` 和大小写扩展名、
显式 shim 转换、原生 `.exe` 优先、显式 JS 覆盖、入口缺失时的提前失败，以及
PATH ACP 适配器优先级；包含 Windows `\\?\` 本地路径转换。

Windows 独立测试 harness 编译实际发现、host 解析、启动规划和可用性函数及其回归用例，
13 项全部通过。打包 SDK 0.3.274 的 spawn hook 验证其为 JS 入口选择 Node；真实 Node
子进程执行含空格路径的脚本成功，而直接启动 `.cmd` 复现 `EINVAL`。

使用官方 npm 包 Claude Code 2.1.74 和打包 ACP 适配器运行真实 stdio JSON-RPC：
旧 `.cmd` 注入在 `session/new` 返回 `spawn EINVAL`；改为实际包内 `cli.js` 后创建
会话成功，返回 3 个配置选项。本机原生 Claude Code 2.1.119 创建会话也成功。
测试在临时空目录中运行，不发送模型提问；模型联网回复不在本次验证范围内。
