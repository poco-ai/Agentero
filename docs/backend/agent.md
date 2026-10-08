# Agent（ACP Host）

Agentero 作为 **ACP Client**，stdio JSON-RPC 连接用户本机或远端 Agent（BYOA，不托管模型 Key）。

## 协议与运行时

- Crate：`agent-client-protocol`（及 Codex 的 npm ACP 适配器进程）。
- ACP `initialize` 在 run / warm / 历史 list / load 四处统一最多等待 30 秒（设置页
  探针同样保留 30 秒总预算），覆盖 BYOA 冷启动；其余 session RPC 保持 15 秒预算。
- 会话 `cwd` = 当前 Vault 根（远程则为远端 Vault 根）。run / warm / list / load
  统一由 `agent_spawn_cwd()` 选择路径，并在内部调用 `core::process::windows_shell_path` 归一；history
  不再二次归一。Windows 把 canonicalize 出的 `\\?\D:\...` 还原为 `D:\...`，避免 Agent
  转交给 MSYS2 shell（Git Bash）时 `mktemp` / `cd` 报 ENOENT；扩展 UNC
  （`\\?\UNC\...`）与 SSH 的 POSIX 路径保持不变。详见
  [bug_fix/hermes-terminal-pending-msys2-hang.md](../bug_fix/hermes-terminal-pending-msys2-hang.md)。
- **Unix 本地 Agent 先经 shell 切到 Vault 或 scratch，再 exec**：ACP stdio
  spawn 无 cwd 字段，Finder 启动的 macOS GUI 进程 cwd 是 `/`，不能让 Agent 将其作为启动
  工作区并触发无关 TCC 弹窗（#570）。无模板例外——`dsh --profile acp` 也把启动 cwd
  作为默认 workspace root，同样需要包装。
- 本地 Vault 路径缺失或无效时，`agent_spawn_cwd()` 用 `agent_scratch_dir()`
  （`…/agentero/agent-cwd`）兜底；数据目录不可写时改用系统临时目录下的
  `agentero/agent-cwd` 专用子目录，两处均无法创建则在启动前明确报错，不回落到进程 cwd
  或整个临时目录。**Unix 探针**也复用该入口：本地用
  scratch，远端沿用目标自己的 Vault；SSH 路径不在本机检查。local-sim 新建连接前验证
  目录存在，失效时明确报错，不悄悄切到 scratch。
- **Windows 保留既有 cwd 策略**：仅 Pi / Custom 的 run / warm / list / load 使用 `cmd /D /C`
  切换目录，探针不增加 cwd 包装。原生 `.exe` 直启；npm 等 `.cmd` / `.bat` shim 经显式
  `cmd /D /S /C` 执行。UNC Vault 不推广 `cd /d` 包装。
- **Windows ACP 进程树归宿主管理**：run / warm / probe / history 共用 `acp/process.rs`，
  通过 `windows-spawn` 的 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建进程时原子绑定独立的
  Job Object，并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。Job handle 不向子进程继承，
  连接结束/取消时终止整个 Job；宿主被强杀或崩溃时由内核回收该 Job 中的进程树。
  Job 创建或绑定失败直接报启动错误，不退回无保护的启动路径。
  `ExitRequested` / `Exit` 同步关闭 warm 池并终止所有 ACP Job（含预热中、已借出及冷连接），
  不依赖 Tauri static async runtime 的析构。
- Windows Pi / Custom 包装的 cwd 与完整 Agent 命令通过环境变量展开，cwd 始终携带双引号，
  防止无空格路径中的括号等 CMD 元字符被当作语法；盘符扩展前缀再幂等剥除一次（#458）。
  该旧包装仍不支持 UNC cwd，不能将其他模板保持直启等同于所有 Windows Agent 都支持 UNC。
- **Login-shell 环境注入**：本地 ACP agent 启动时会合并当前进程环境变量、用户 login-shell
  环境变量（`SHELL -lic 'env -0'`）以及 `AgentDescriptor.env`。这样 macOS/Linux 上从
  GUI 启动 Agentero 也能读到 `.zshrc` / `.bashrc` 里 `export` 的 `OPENAI_API_KEY`、
  `OPENAI_BASE_URL` 等变量；`AgentDescriptor.env` 优先级最高，可覆盖 shell 值（#478）。
- 统一接口：OpenCode、Hermes、Claude ACP、Codex ACP、Antigravity ACP、Qoder、Grok、Pi、Dsh（DeepSeek Harness）、Kimi Code、ZCode、MiniMax Code、MiMo Code、自定义 `command`/`args`/`env`。自定义项不探测安装器，保存后按同一 stdio 路径拉起；前端把参数字符串按空白拆开。设置表单用 `agent.form.hint` 说明这一约定。
- Dsh：umbrella CLI `@deepseek-ai/dsh`（npm，需 0.1.2+）内置 ACP profile——
  `dsh --profile acp` 以 ACP stdio 服务，首次启动从内置模板自动初始化 profile
  （`$DSH_HOME/profiles/acp`），无需手写 `cordis.yml` 或受管 launcher 目录。
  - 旧的独立包方案（`@deepseek-ai/dsh-acp-demo` 固定 `0.1.1-rc.2` + App 管理目录
    `~/.agentero/dsh-acp`）已废弃：上游停止发布该包（配套插件已发到 `0.1.5-rc.2`
    而 demo 停更，锁步 prerelease semver 无法混搭），uninstall 仍会清理该遗留目录。
  - 安装/更新走 `npm i -g @deepseek-ai/dsh@latest`（Unix `--prefix "$HOME/.local"`），
    检测/版本对比用 `dsh --version` vs npm latest，与其他 npm 模板一致。
  - 会话：当前版本声明 `sessionCapabilities` 的 `close`/`list`/`resume`，多轮续聊
    走标准 resume 路径，连接也可进入 warm 池。
  - API Key：官方 CLI 的分层 env（`~/.dsh/.env` 等）由 `dsh` 自身加载，ACP
    profile 同样受益；也可在注册项 env 中 export `DEEPSEEK_API_KEY`。
- Kimi Code：原生 ACP（`kimi acp`）。官方 installer（`code.kimi.com/kimi-code/install.sh`）
  是单二进制、默认装入 `~/.kimi-code` 并写 PATH 进 shell rc；npm 包
  `@moonshot-ai/kimi-code`（需 Node 22.19+）作回退。`kimi upgrade` 是交互式的，静默
  `update` 重跑幂等的官方 installer。登录在终端完成（`kimi` → `/login`，OAuth 或
  Moonshot API key），skill 走 slash mention。
- MiniMax Code：原生 ACP（`mcode acp`）。npm 包 `@minimax-ai/code`（需 Node 22.19+
  或 24+）安装后提供 `mcode`，detect/ACP 入口同二进制，静默 install/update 走
  `npm install --global @minimax-ai/code@latest --ignore-scripts=false
  --include=optional --allow-scripts=@minimax-ai/code,better-sqlite3
  --registry https://registry.npmjs.org/ --foreground-scripts`，登录命令为
  `mcode login`，skill 走 slash mention。除 npm 全局目录外，Windows 官方安装器的
  `%USERPROFILE%\.minimax-code`（`mcode.cmd`）及 POSIX 的
  `~/.minimax-code/bin` 也会被 GUI 扫描，即使应用启动时没有继承新开的终端 PATH。
- MiMo Code：Xiaomi 的 OpenCode fork，原生 ACP（`mimo acp`）。npm 包 `mimocode`
  （bin `mimo`，需 Node 22+），install/update 走 `npm i -g mimocode`（Unix
  `--prefix "$HOME/.local"`），uninstall 走 `npm uninstall -g mimocode`；detect/ACP
  入口同二进制，登录在 CLI 内完成（`mimo providers`，即 opencode auth login 流程）。
- Qoder CLI：原生 ACP（`qodercli --acp`）。官方 installer（`https://qoder.com/install`，
  Windows PowerShell 为 `irm https://qoder.com/install.ps1 | iex`）安装原生 `qodercli`；
  npm 包 `@qoder-ai/qodercli`（需 Node 20+）作回退。静默 update 优先 `qodercli update`，
  失败再重跑官方 installer。卸载会 `npm uninstall -g @qoder-ai/qodercli`，并删除官方脚本写入的
  `~/.qoder/bin/qodercli`、`~/.qoder/entry` 和 `~/.local/bin/qodercli`（只删这个链接；Windows 同位置
  再试 `qodercli.exe` / `qodercli.cmd`）。没有 npm 时仍删除这些路径。不删除 `~/.qoder` 里的会话和登录，
  不改 shell rc，也不处理 Homebrew cask。登录在终端完成（`qodercli login`）。
- Antigravity ACP：Google 官方 ACP server，安装和更新从 ACP Registry 的 manifest
  读取当前版本及平台压缩包，不保留旧版本回退。压缩包解压到 Agentero 管理目录，并保留
  `agy_acp_server` 与 `localharness_external`；macOS Intel 没有官方构建，因此不提供该预设。
  Linux 启动时附带官方要求的 `--uid=` 参数。Registry 不可用或当前平台没有构建时直接报错；
  远程主机不提供 shell 安装命令。
- ZCode：host CLI 无原生 ACP，走社区适配器 `zcode-acp-server server`（桥接无头
  `zcode app-server --stdio`，声明 `session/load` 续聊）。zcode CLI 内置在 ZCode
  桌面应用中、通常不在 PATH 上，适配器会自动发现桌面应用内置 CLI；若装在其他盘符或
  更深层目录，可将 `ZCODE_BIN` 设为实际的 `zcode.cjs` 路径。凭据直接复用 `~/.zcode`
  的桌面登录——无需额外 API key。Catalog 将桌面
  CLI 与 ACP 适配器分层探测：桌面版可从 PATH 的 `zcode` 或应用内置的 `zcode.cjs`
  识别；只有两层齐备才会自动注册并允许 initialize，缺少适配器时显示安装 ACP。
  `zcode-acp-server`（npm 安装，需 Node 22+）是唯一由 Agentero 管理的组件，静默
  install/update 走 npm（Windows 加 `--ignore-scripts` 跳过包内不兼容 cmd 的通知脚本；
  Unix 侧装入 `~/.local` 前缀）；卸载只移除该适配器，不删除
  ZCode 桌面应用、登录或 `~/.zcode` 数据。
  - spawn 时 Host 注入环境变量（注册项 env 可覆盖）：`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`
    指向 `~/.zcode/v2/runtime/provider/*/*/endpoint-*/zcode-builtin.json` 中最新一份——
    缺少它内置 CLI 的 provider 层不启动（backend dead）；同时注入
    `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（`~/.zcode/v2/provider_config.json`），两变量
    齐备 CLI 才原样使用注入表，否则会改道自同步副本并使适配器的 provider 注册作废
    （zcode-acp#202，0.42.4 起适配器自身注入同组变量）；`ZCODE_BIN` 选用最新可读的
    remote-assets 或桌面应用 `zcode.cjs`，不再依赖已从较新 app-server 移除的
    `workspace/updateProviderRegistry` 标记，避免启动时直接关闭 ACP transport。
    均不存在时回落适配器默认发现逻辑。注入仅在**本地** spawn 生效：SSH 远端 Vault 不做
    该注入（本地发现的路径对远端无意义），远端沿用适配器自身的发现逻辑，上述坑在
    远端同样存在；Windows 上注入的候选根为 `%LOCALAPPDATA%\Programs\ZCode`、
    `%APPDATA%\ZCode` 缓存、`C:\Program Files\ZCode`，以及系统盘根目录下一级自定义目录中的
    `ZCode\resources\glm\zcode.cjs`（例如 `C:\Sofware\ZCode`）；并在可解析时额外注入 `ZCODE_NODE`（适配器
    在 Windows 上解析 Node 不可靠）。
- Pi：无原生 ACP，走社区适配器 `pi-acp`（内部 spawn `pi --mode rpc`）；detect 用 host `pi`、
  ACP 入口用 `pi-acp`。pi 的 skill 以 `/skill:<name>` 暴露，故 Agentero 不发 `/<name>`
  mention，只注入 `SKILL.md` 正文。
- Pi 启动横幅：`pi-acp` 在 `session/new` 后把 pi 的启动信息（`pi vX.Y.Z` +
  `## Context` / `## Skills` / `## Extensions` 清单）当作普通 agent message 推送。Host
  在本轮首个 message chunk 上识别该横幅并丢弃，不写入内容缓冲、不发 `agent:stream`，
  避免它出现在回答之前。
- **内置 ACP 适配器（bundled 兜底层）**：`@agentclientprotocol/claude-agent-acp` 与
  `@agentclientprotocol/codex-acp` 的纯 JS 依赖树（平台二进制裁掉，~39MB 未压缩）作为应用
  资源随包分发，离线开箱即用。Host CLI（`claude` / `codex`）**永不内置**，仍由用户 PATH
  或 lifecycle 安装。
  - Staging：`scripts/prepare-adapters.mjs`（版本 pin 在脚本顶部常量；`pnpm adapters:stage`，
    已挂入 `beforeDevCommand` / `beforeBuildCommand`），临时目录系统 npm
    `--omit=optional --omit=dev --ignore-scripts` 安装到共享单树
    `src-tauri/adapters/node_modules/` + `manifest.json`（id/package/version/entry/nodeMajor）；
    护栏：无 symlink / 原生二进制、单文件 ≤5MB、总量 ≤80MB（`AGENTERO_ADAPTER_MAX_MB` 可调）。
    该目录进 `.gitignore`，pin 不经 pnpm-lock（对应用是惰性数据）。
  - CI：Rust `quality` / `agentero-tests` 任务各自准备 Node 22 并执行
    `node scripts/prepare-adapters.mjs`；直接运行 Cargo 不触发 Tauri 前置命令，
    TypeScript 任务的 staging 产物也不会跨 runner 共享。`cli-tests` 不依赖这些资源。
    Rust 任务只需 Node/npm，`setup-node` 显式关闭包管理器自动缓存，避免根据
    `package.json` 的 `packageManager` 字段调用未安装的 pnpm。
  - 运行时（`registry/bundled.rs`）：`init` 在 app setup 时定位资源根（打包
    `Resources/adapters`；dev 回退源码树），`adapter_at` 读 manifest。解析顺序全局唯一：
    **PATH/lifecycle 安装的适配器永远优先**，`resolve_command` 命中即走原路径，miss 才回落
    内置层。
  - Spawn（`acp/client.rs plan_local_launch`）：内置层为 `node <abs>/dist/index.js
    [descriptor args…]`，node 从合并后的 agent 环境（含 login-shell PATH）解析；Unix 的
    `cd <vault> && exec` 包装（#570）自动覆盖 node 命令。裁剪后的适配器通过注入 env 找到
    host CLI——claude 适配器 `CLAUDE_CODE_EXECUTABLE`、codex 适配器 `CODEX_PATH`——均
    `or_insert`，用户在注册项 env 里显式配置的值永远优先。
    Windows 下传给 Node 的入口脚本参数先经 `windows_shell_path` 去除本地盘符路径的
    `\\?\` 前缀，避免安装包资源路径触发 Node 的 `EISDIR` 并在 ACP 握手前退出；
    详见 [Windows 内置 ACP 启动失败](../bug_fix/windows-bundled-acp-node-path.md)。
  - Node 门槛：claude-agent-acp 需 Node ≥22（manifest `nodeMajor`）；node 缺失或版本不足
    时该层静默关闭（`bundled_spawnable` = false），catalog 的 `last_probe_error` 显示
    `node_blocker_message` 提示，安装按钮回归 npm 路径。
  - Lifecycle 跳过（`registry/lifecycle.rs`）：`bundled_tier_active`（PATH 无适配器且内置层
    可 spawn）时 install/update 只装/升级 host，不再 npm 安装适配器；PATH 装上适配器后自动
    恢复双装语义。uninstall 不受影响（npm 卸载只作用于 PATH 安装）。
  - Catalog / registry：PATH 中的完整适配器优先；内置层仅在适配器、合格 Node 和 host CLI 均可用时计入 `acpCommandAvailable` / `available`。host 使用启动时的合并环境解析，显式 `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH` 优先且必须可执行；无效覆盖不回退其他 host。`binaryAvailable` / `resolvedPath` 同步反映该 host。
    缺少依赖时不自动注册，已有注册及默认 ID 保留，但当前 Missing / unavailable 优先于历史探测成功，引导和聊天不能因旧注册记录重新放行。`acpBundled` / `acpBundledVersion` 仅表示资源来源（Settings「内置」徽标），不表示 Agent 已安装。远程（SSH）无内置层，行为不变。
  - **macOS 打包陷阱**：`tauri.macos.conf.json` 的 `bundle.resources` 会整体覆盖主 conf，
    必须同步包含 `adapters/**/*`，否则 macOS 包静默丢掉内置层。
- 设置页会将 ACP 探测中的认证错误（如 `invalid_grant` / `failed to authenticate` /
  `authentication required` / `not logged in`）
  显示为「未登录」，其他握手或进程错误仍显示为「ACP 失败」。
- 「登录」按钮（`doctor_open_agent_login_terminal`）在确认式终端里执行模板
  `login_command`；写入脚本前先把命令首个可执行文件解析为绝对路径（用注册 Agent 的合并
  env / login-shell PATH），避免 `bash -lc` 看不到 zsh 的 `~/.local/bin` 而报
  `command not found`（#686）。终端只打印命令、等回车确认后才真正执行。
- 「终端」按钮（`doctor_open_agent_cli_terminal`，仅已安装 Agent 行显示，位于「升级」与
  「卸载」之间）**直接**在系统默认终端启动该 Agent 的交互式 CLI（无需回车确认）：命令取
  模板的交互式 CLI（`registry::interactive_cli`，通常等同 `detect_command`，如 `claude` /
  `codex` / `opencode`；Antigravity 为独立的 `agy` CLI 而非受管目录里的
  `agy_acp_server.par` ACP server；Dsh 需显式 profile，使用 shipped 的 `dsh --profile tui`）；
  ZCode 只有 ACP 适配器、无面向用户的 CLI，故不显示该按钮。二进制解析逻辑与登录按钮共用
  （注册 Agent 合并 env / login-shell PATH，#686）。
- 后台熔断（`AgentWarmGate`）：`agent_warm` / `agent_list_sessions` 失败后进入
  120s 冷却，冷却期内直接返回上次错误、不再 spawn；成功或用户消息
  （`agent_run_once`）成功后清除。详见
  [bug_fix/gemini-login-browser-loop.md](../bug_fix/gemini-login-browser-loop.md)。

```text
spawn 用户配置的 agent
  → ACP initialize（读 loadSession / sessionCapabilities.resume）
  → session/new  或  继续：resume 优先，否则 session/load（Grok 仅 load）
  → available_commands_update → `agent:commands`
  → build_prompt（workflow + 可选 agentPersonalPrompt）
  → session/prompt → 流式 agent:stream
  → 权限请求 → 前端（ask 模式）
  → 完成（含 providerSessionId）/ 失败
```

流式 chunk 合并（`runtime/stream.rs`）：agent 通常每秒推 20–100 个小 chunk，
逐条 emit 会让 webview 每 token 重渲染一次（Windows 卡顿主因）。Host 用
~40ms 窗口合并连续同 kind 的文本 chunk 再发 `agent:stream`；kind 切换
（message ↔ thought）、tool/plan 等有序事件、`agent:completed` / `agent:failed`
之前都会先 flush，保证顺序与文本无损。`agent:tool` 的 `input`/`output` 超过
32KB 时截断为「头部 + truncated 标记」（前端只做预览渲染）。

ACP `terminal` 能力：Host 在 initialize 时声明 `terminal: true`，并本地实现
`terminal/create`、`terminal/output`、`terminal/release`、`terminal/wait_for_exit`、
`terminal/kill`。每个 ACP 连接持有独立的 `AcpTerminalManager`，按 `TerminalId`
管理子进程；每个 terminal 由单独任务独占 `Child`，`wait_for_exit` 不占 manager
锁，`kill` / `release` 通过控制通道保持可用。ACP 消息分发本身是串行的，因此
wait / kill / release 在分发时先获取或移除句柄，再经 `connection.spawn` 完成响应，
避免等待退出时堵住同连接后续请求。`terminal/output` 只快照当前缓冲区，
不会等待进程退出；输出按 `outputByteLimit` 从头部截断并保证 UTF-8 字符边界。该能力
让 Kimi Code 等需要执行 shell 命令的 Agent 可以在 Vault 工作目录下运行命令并
读取结果。

run / warm / list / load / probe 共用 `agentero_acp_builder!`（name + terminal
handler）；各入口自行挂 notification / permission 回调。

**warm 与空会话**：模型列表来自 Session Setup 的 `configOptions`（协议不在
`initialize` 提供），故 warm 仍需 `session/new`。连接在池中复用，空闲 TTL 为 10 分钟。
切换 warm 目标会取消旧的未完成 setup、回收不匹配的空闲 slot；已借出的连接继续服务正在执行的
prompt，结束后仍受 TTL 与退出清理约束。setup 总预算为 60 秒，超时或请求 future 被取消会
取消后台任务，禁止迟到发布；错误/超时返回前等待任务完成回收。
slot 替换、evict 和 shutdown 均有独立取消 token，不依赖 slot 是否还在池中。
若 Agent 声明 `sessionCapabilities.delete`，未使用的空会话在 teardown 时尝试删除；
取消清理最多允许 1 秒，之后无论 RPC 是否响应均丢弃连接并终止进程树。
旧版本已产生的孤儿不属于新 Job，升级不会自动按进程名杀掉其他宿主的 Agent；需一次性确认
路径与归属后清理。远端 SSH Agent 的宿主外进程不受本机 Windows Job 约束。

Kimi Code ACP 会把 `Bash`/`Glob`/`Grep` 等工具实现为 `terminal/create`。[当前实现](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/acp/tools.py)
会把完整 shell 文本放进 `command`；Host 对可解析的可执行文件继续按 `command + args`
直接 spawn，对无法解析且没有 `args` 的命令在 Windows 用 PowerShell、Unix 用
`/bin/sh -c` 执行，以兼容 `pwd`、`echo ...` 等 shell 命令；请求没有显式 `cwd`
时使用当前 ACP session 的 Vault cwd。若 Host 没有声明 `terminal` 能力，或 Kimi Code 版本过旧，这些工具会
直接失败并报 `ACP runtime only supports interactive Bash tool processes`。
此外 Kimi Code 的权限请求目前只返回通用 `"bash"` 字符串（[MoonshotAI/kimi-code#800](https://github.com/MoonshotAI/kimi-code/issues/800)），不会给出具体命令，因此 Agentero 默认的 Restricted 策略会拒绝、Ask 模式也只能看到 `bash`，需要用户在 Kimi 侧或 Agentero 侧开启自动批准（YOLO）才能静默执行。

多轮续聊必须传 **provider session id**（不是 Agentero runtime id）。Grok Build ACP
声明 `loadSession: true`、**不**声明 `resume`；对 Grok 调用 `session/resume` 会
`Method not found`，Host 应改走 `session/load`。

暖连接上发 `session/prompt` 若得到 `connection is no longer running` /
`failed to send outgoing request`，说明这一轮还没送到 Agent。Host 把这次失败
当成 prompt 之前的错误：丢掉这条连接，换新进程，再用已有 provider session id
走 `session/load` 重发同一条 prompt。下一轮如果没有可恢复的 provider session，
或上一轮已经失败，前端会把屏幕上已有的对话附进 prompt，避免新会话丢掉上文。

生成中取消时，只要 provider session 已创建或本轮正在恢复，取消结果仍携带 `providerSessionId`。前端保留该 ID，并写回视觉批注 mark，使下一条消息和重启后的 pin 续聊继续同一会话；在 `session/new` 返回前取消时尚无可恢复的 provider session。

`session/load` 会把历史以 `SessionNotification` 回放。Host 在
`session/prompt` 之前 **suppress** 回放中的 stream/tool/plan（不 `agent:stream`、
不写入本轮 content buffer），避免第二轮气泡开头重复上一轮回答；usage /
commands / config 仍可在 load 期间转发。

`agent_load_session` 在 `session/load` 返回后等待回放通知**静默**（200ms 无新
通知即返回，最长仍封顶 800ms），替代此前的固定 800ms sleep；回放通常在
response 前/后很快推完，空会话与短会话因此显著更快（#271）。

回放聚合（`ReplayBuilder`）会丢弃 Agent 侧的合成占位文本：Claude Code 在
turn 未产生回复（如被中断）时会往 transcript 里拼接合成 assistant 消息
（"No response requested."、"[Request interrupted by user]" 等），
`claude-agent-acp` 等适配器在 `session/load` 回放时原样转发。这些占位不是
真实回答，Host 在聚合历史行时按整段精确匹配过滤，避免被当作 Agent 回复渲染
（#411）。

`agent_list_sessions` 必须**跟随 `nextCursor` 翻页**。codex-acp 按全局时间窗口分
页、再在每页内部按 `cwd` 过滤，因此属于当前 Vault 的会话会散落在多页里，中间
夹着大量「空页但仍有 nextCursor」的页。只取第一页会让 Codex 历史只剩少数几条、
甚至完全为空（#338）。Host 在单条 ACP 连接内走完 cursor，按 `sessionId` 去重，
并受三重封顶保护：5s 预算、200 页、500 条；因未走完而中断时把 cursor 一并返回。
cursor 不再推进（`next == prev`）时视为走完，避免死循环。

## 命令（摘要）

| Command | 说明 |
|---|---|
| `agent_probe` / `agent_warm` | 探测与预热 |
| `agent_run_once` | 发起一轮；`sessionId` 时按能力 resume 或 load；可选 `images[]`（base64 + mime）→ ACP `ContentBlock::Image` |
| `agent_list_sessions` / `agent_load_session` | 会话历史 |
| `agent_list_skills` | Vault skill 列表 |
| `agent_respond_permission` | 回答权限请求 |
| `agent_respond_elicitation` | 回答 form elicitation（Codex `request_user_input`） |
| `agent_respond_ask_user` | 回答 Grok `_x.ai/ask_user_question` |
| `agent_run_tool_lifecycle` | 静默安装/升级/卸载 catalog CLI（及 Claude/Codex ACP 适配器）；Antigravity 例外走官方 ACP Registry 的本地受管安装器；内置适配器兜底层活跃（PATH 无适配器且可 spawn）时 install/update 只刷新 host、跳过适配器 npm 安装（见上方「内置 ACP 适配器」）；本机 lifecycle 串行执行，设置页在对应 Agent 行内展示安装 / 扫描 / 探测进度（#250），Windows 使用唯一临时 `.bat` 并按 UTF-8/GBK 解码错误输出；安装失败会将 npm 缓存目录 EPERM 转成可操作的缓存迁移提示；npm 不在 PATH 导致安装失败（Windows `'npm' is not recognized...` / Unix `command not found`）时 Toast 附带「一键安装 Node.js」动作，复用后台安装通道（见 [doctor.md](doctor.md)）；受管安装探测到系统 npm 缓存不可写时自动注入独立缓存目录（`npm_config_cache`），可写的缓存不动；Windows 探测 `.exe` 时校验 PE 头，避免把文本 shim 当作 16 位程序执行；`uninstall` 做 best-effort npm 卸载 + 受管目录删除（不改 shell rc），成功后联动删除 catalog 注册项；见 [api.md](api.md) 与 [#225](https://github.com/poco-ai/Agentero/issues/225) |
| `agent_check_catalog_updates` | PATH scan + 版本对比：本地 `detect --version` vs npm latest；写入 `installedVersion` / `latestVersion` / `updateAvailable`。设置页「升级」仅在 `updateAvailable === true` 时显示；hermes 等无稳定 npm 源或探测失败时不显示。不塞进同步 `agent_scan_catalog`（避免 Doctor / 切换器打网络） |
| `agent_tool_lifecycle_supported` / `agent_tool_install_commands` / `agent_tool_uninstall_info` | 是否支持静默安装；平台手动安装文案；卸载清理项清单（确认对话框展示） |

ACP slash command 不是独立的 `session/compact` RPC。Host 转发 Agent 广播的
`available_commands_update`；前端提交命令时设置 `isAcpCommand`，Host 跳过
Agentero prompt envelope、skill/context 注入，并将原始 `/command` 作为
`session/prompt` 发送到当前 provider session。

## 权限

全局 `agentPermissionMode`，前端经 `runOnce({ permissionMode })` 下发（优先字段；
旧 `autoApprove` 仅 Host 侧兼容读取）：

| 模式 | 行为 |
|---|---|
| `restricted` | 默认；收紧写/敏感操作 |
| `ask` | `agent:permission-request` → 用户选择 → `agent_respond_permission` |
| `auto` | 自动批准策略项 |

## Elicitation（不稳定协议）

- Host 依赖 `agent-client-protocol` feature `unstable_elicitation`。
- `initialize` 声明 `elicitation.form`，否则 codex-acp 对 `request_user_input` 直接返回空 answers。
- 收到 `elicitation/create` → 事件 `agent:elicitation-request` → 前端表单 → `agent_respond_elicitation`。

## 结构化提问（多 harness）

ACP **没有**统一的 ask-user tool 规范：各 harness 的字段名、挂载点（tool / elicitation / ext method）都不一样。Agentero 作为 ACP Client 做三件事：

1. **打开交互能力**：`initialize` 声明 `elicitation.form`（依赖 crate feature `unstable_elicitation`）；否则 Codex 等对 `request_user_input` 会直接空答。
2. **Client adapter 归一**：把不同 rawInput / 事件解析成同一套 `AskUserQuestion` 页（`parseAskUserQuestions` 等），前端只渲染一张表。
3. **Harness 特例**：OpenCode spawn 时注入 `OPENCODE_ENABLE_QUESTION_TOOL=1`；Grok 的 `_x.ai/ask_user_question` 由 Host JSON-RPC 处理（`acp/ask_user.rs`），再经 `agent:ask-user-request` / `agent_respond_ask_user` 与前端对齐；tool 镜像与 ext 去重。

| Harness | 形态 | 回答通路 |
|---|---|---|
| Codex | tool `variant: AskUserQuestion` 或 elicitation form | tool → 提升到 **底部问卷** → 下一用户轮；elicitation → `agent_respond_elicitation` |
| Claude | tool `questions[]`（含 Other 伴生页合并） | 同 tool 提升 → 下一用户轮 |
| OpenCode | tool `question` → `questions[]` | 同 tool 提升；spawn **默认 env** `OPENCODE_ENABLE_QUESTION_TOOL=1`；turn 阻塞时 cancel+drain 立刻送出答案 |
| Grok | ext method `_x.ai/ask_user_question` | Host → `agent:ask-user-request` → `agent_respond_ask_user`；与 tool 镜像去重 |

**UI 约定**：可交互表单只在 **`AgentAskUserSurface`（底部问卷）**；与 free-text composer **互斥**；transcript tool 卡不嵌选项。优先级 elicitation > Grok ext > tool 提升。

详见 [frontend/agent.md](../frontend/agent.md)。

## 工作流与 Skill

- workflow：`summary` / `qa` / `related_work` 等（面板 chips 映射）。
- `translate`：**不套 envelope**（无 `## Sources`、无 CLI 政策、不注入回答语言与个人偏好）。翻译 prompt 自己已指定目标语言并要求「只返回译文」，envelope 会与之冲突。
- Skill：Claude 倾向 `/id`；其它注入 `SKILL.md` 文本（`SkillMentionStyle`）。激活语法**只由 Host 判定**（`skill_mention_style` + `paper_reader_skill_line`）；前端不得重复推断，否则同一条 prompt 的两半会互相矛盾。
- paper-reader：写 NOTES + `paper_set_is_read`；前端任务条编排。
- Host `build_prompt` envelope **只**负责：本轮 workflow 角色、回答语言、个人偏好、`User request`（`paper_reader` 另带激活句）。**不**再塞引用格式、CLI 政策、论文阅读顺序，也**不**在 free/qa 等 workflow 里重复 skill-follow-hint（激活靠 `skill_activation_prefix` + 注入的 `SKILL.md`；cwd 为 vault 根时 Agent 自载 `AGENTS.md`）。
- 引用约定（`AGENTS.md` / `paper-reader`）：**阅读**可用 TeX/`PAPER.md`，citation **href 优先本地 PDF + fragment**；笔记用 `[[papers/<id>/NOTES]]`；不加外层 `([…])`、不用文末 `## Sources`。路径含空格时写成 `%20`，或用 `<>` 包住目标。前端负责 pill 渲染、`.tex`→PDF 回退、百分号解码，以及残留 `blocked` 标签的显示兜底。Host `agent_resolve_citation`：`#figure=N` 在 caption 任意位置匹配 `Fig./Figure N`；`#section=N` 认阿拉伯与 IEEE 罗马章节号（如 `3`↔`III.`），纯数字不走模糊 overlap；失败时前端按 fragment 类型 Toast（短分类 + source）。
- 自由模型选择：`preferred_model_id` 可指向 ACP catalog 外的任意模型 id；Warm / Run 时始终尝试 `session/set_config_option`，失败不阻断会话。

## 模型协商

- `session/new`（及 config 更新）中的 `SessionConfigOption`（category=Model 或 name 回退）解析为 `agent:models`。
- 若 `current_value` 不在 selector 选项中（第三方网关 / cc-switch 等只改默认 model、目录仍是官方列表），Host **注入**该 current id，避免 UI 丢失。
- `preferred_model_id`（warm / run_once）在与 current 不同时 **始终尝试** `session/set_config_option`，不要求 id 已在上报列表中；失败仅 debug 日志，不阻断会话。
- Codex `collaboration_mode`（Default / Plan 等）解析为 `agent:collaboration`；`collaboration_mode_id` 在选项内且与 current 不同时尝试 `session/set_config_option`。UI 称「模式」。Plan 才能用 `request_user_input`。不解析 / 不暴露 ACP `category: mode` 沙箱档。
- 推理强度：识别 `category: thought_level`（兼容 id `reasoning_effort` / `effort`），转为 `agent:effort`。默认值和支持的档位由 Agent/适配器决定，ACP 不规定 low/high 枚举或跨会话持久化；前端保存用户选择；面板无已存选择时传 `preferHighestReasoningEffort: true`，Host 在模型和模式协商完成后选择最高可识别档位，覆盖 warm 未完成就发送的首轮。显式 `reasoningEffort` 优先；未知档位无法排序时不覆盖 Agent 当前值，其他调用者缺省不开启此策略。`run_once` 在 new/resume/load 后、prompt 前应用 `reasoningEffort`。先完成模型和模式切换、读取完整 `configOptions`，再仅对仍在列表中且与 current 不同的档位调用 `session/set_config_option`；不支持时沿用 Agent 当前值。参见 [ACP Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options)。
- Fast 开关（`fast-mode` model_config 选项）与上述一致：仅当会话当前值与请求值不同时才发 `session/set_config_option`，未变化的配置不再每轮重复下发（#271）。

## User-Agent（中转站亲和）

部分中转站用 `User-Agent` 做客户端亲和（new-api Codex 通道常见 `codex-cli/<version>`；Claude 侧常见 `claude-cli/*` / `claude-code/*`）。

Agentero 是 ACP **Client**：模型 HTTP **不**经 Host 转发，因此只能在 **spawn ACP 子进程时** 注入 env/config（与 bb 等 Host 一致），不能像 cc-switch 本地代理那样中途改头。

- 设置 → Agent → **User-Agent**（预设下拉 + 可手填）+ **Codex Provider id**（可选）。
- Host 在 registry snapshot 时按模板注入：
  - 所有模板：`AGENTERO_USER_AGENT=<value>`
  - `codex-acp` / `custom`：`CODEX_CONFIG.model_providers.<id>.http_headers.User-Agent`
  - `claude-acp`：`ANTHROPIC_CUSTOM_HEADERS` 中 upsert `User-Agent: …` 行
- Codex Provider 目标：显式列表；否则 `CODEX_CONFIG` 已有 keys、`MODEL_PROVIDER`、或回退 `openai`。
- 远程 SSH 转发：`AGENTERO_USER_AGENT` / `CODEX_CONFIG` / `MODEL_PROVIDER` / `ANTHROPIC_CUSTOM_HEADERS`。
- 命令：`agent_set_user_agent`；`agent_scan_catalog` 回传当前值。

说明：是否生效取决于底层 Agent 是否认上述 env/config；OpenCode/Grok 目前仅带 `AGENTERO_USER_AGENT`（多数忽略）。

**new-api 侧（源码）在做什么：**

- 读的是 **客户端请求** 的 `User-Agent`（`c.Request.UserAgent()`），不是 model id。
- 通道亲和规则可选 `user_agent_include`：子串匹配（大小写不敏感）；**默认规则该项为 nil = 不按 UA 过滤**。
- Codex 默认亲和规则还匹配路径 `/v1/responses`、模型 `^gpt-.*$`，并把客户端的 `User-Agent`、`Originator`、`Session_id` 等 **透传** 到上游。
- new-api **自己** 调上游 Codex 模型列表时会设 `User-Agent: codex-cli/<version>`（`service/codex_models.go`）——那是网关出站，不是你的客户端。

因此：若限制来自「亲和规则要求 UA 含 `codex-cli`」或上游看透传 UA，我们的 spawn 注入 **有机会** 解决；若还校验其它 Codex 专有头/路径/鉴权形态，仅改 UA **不够**。

## 注册表（非模型 BYOK）

配置「如何启动本机 Agent」：id、name、template、command、args、env、默认 id、可选 User-Agent。  
持久化在应用配置目录；**不**要求填写模型 API Key。

## 远程

远程 Vault 时在 **SSH 远端** 启动 Agent。见 [remote.md](remote.md)。远程 agent catalog 的扫描/探测/安装命令属 agent 域（`registry/remote.rs` + `commands/remote.rs`），复用 `agent::models` / `probe_agent` / `templates`；agent 域不直接依赖 `integration::remote`，而是经反转 trait `agent::remote_host::{RemoteAgentHosts, RemoteAgentLaunch}`（由 remote 域 `RemoteRegistry` / `RemoteSession` 实现，app 启动时注册为 State）走 SSH。命令壳与 bridge RPC 共用 `agent::service` 门面。

## 代码

`src-tauri/src/features/agent/`  
前端：[../frontend/agent.md](../frontend/agent.md)
