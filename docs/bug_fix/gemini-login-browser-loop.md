# Windows 上 Gemini CLI 反复弹浏览器登录

## 现象

Windows 11 安装 exe 后，打开 Chat 面板 / 设置页时应用不断拉起系统浏览器，跳转 Gemini（Google OAuth）登录页，且登录始终无法完成。

## 根因

三个因素叠加成死循环：

1. **Gemini CLI 自带浏览器 OAuth**：`gemini --experimental-acp` 收到 `new_session` 时，若本机无缓存凭据（`~/.gemini/oauth_creds.json`），会自行打开浏览器登录并阻塞等待回调。
2. **15s 超时 + KillOnDrop**：Host 侧 `ACP_TIMEOUT = 15s`（`src-tauri/src/features/agent/acp.rs`）超时后连接 drop，`agent-client-protocol` 的 KillOnDrop 杀掉 gemini 子进程——等待 OAuth 回调的 localhost server 一并死掉，用户在浏览器完成授权也写不回凭据。
3. **多个自动 spawn 触发点**：Chat 面板挂载预热（`agent_warm`）、历史加载（`agent_list_sessions`）、设置页模型下拉、vaultPath 变化重跑，每次都 spawn 新 gemini 进程 → 每次都再弹一个登录页。Windows 上子进程以 `CREATE_NO_WINDOW` 启动，用户看不到 CLI 输出，只看到浏览器被反复拉起。

## 修复

1. **注入 `NO_BROWSER=true`**（`acp.rs` `to_acp_agent_local`）：Gemini 模板 spawn 时注入该环境变量（用户显式配置则不覆盖），Gemini CLI 不再拉起浏览器；登录须在终端运行 `gemini` 完成（符合 BYOA 设计）。
2. **后台熔断 `AgentWarmGate`**（`runtime/control.rs`，app state）：`agent_warm` / `agent_list_sessions` 失败后记录该 agent，120s 冷却期内直接返回上次错误、不再 spawn；这两个命令成功、或用户消息（`agent_run_once`）成功后清除记录。

## 经验

- 后台自动 spawn 的子进程必须有失败熔断，否则任何"启动即失败"的 CLI 都会被面板挂载、状态变化等触发点反复拉起。
- 集成第三方 CLI 时要确认其隐式交互行为（浏览器 OAuth、TTY 提示等），无头 spawn 场景需显式禁用。
