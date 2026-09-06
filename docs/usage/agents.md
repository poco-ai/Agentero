# 接入 Agent

Agentero 使用 **BYOA**（Bring Your Own Agent）：Agent 由你安装和登录，Agentero 负责把当前 Vault 的上下文交给它，并展示结果。应用**不**捆绑模型，也**不**要求你在 Agentero 内填写模型 API Key。

## 支持方式

通过 [Agent Client Protocol](https://agentclientprotocol.com/)（ACP）接入。常见选项：

- Claude ACP
- Codex（经 ACP 适配器）
- OpenCode、Antigravity、Qoder、Grok、Kimi Code 等兼容 ACP 的 CLI
- [GenericAgent ACP](genericagent-acp.md)
- 自定义 `command` / `args` / `env`

请先按对应 Agent 的官方说明完成安装和登录。

若要把当前 Vault 接到 ChatGPT 或其它 MCP 客户端（不走应用内 ACP 面板），见 [用 MCP 连接外部 Agent](mcp.md)。

### 暂不直接支持的 Agent

以下桌面应用目前**不能**直接作为 Agentero 的内嵌 Agent 使用：

| 应用 | 当前状态 | 说明 |
|---|---|---|
| **OpenAI Codex 桌面版** | 不支持 | Agentero 通过 ACP 接入的是 **Codex CLI**（命令行版）+ `@agentclientprotocol/codex-acp` 适配器；独立的 Codex 桌面 App 未暴露可被 Agentero 连接的 ACP/MCP 接口。 |
| **WorkBuddy（腾讯）** | 不支持 | Agentero 当前没有 WorkBuddy 的 ACP 适配模板；即使 WorkBuddy 支持 ACP，也需要额外适配才能接入。 |

如果你希望这些应用操作 Vault，可参考：

- **Codex**：安装 Codex CLI 并通过 `codex-acp` 接入（见上表）。
- **WorkBuddy**：暂无可行接入方式；如 WorkBuddy 后续提供兼容 ACP 的 CLI/bridge，可尝试「自定义 `command` / `args` / `env`」，但未经官方测试。

## 添加 Agent

1. 打开 **Settings**（`⌘,`）。
2. 如本机网络需要代理，在 **Settings → General → Network proxy** 配置；该配置同时用于论文、翻译、引用等 Host 请求和 Agent 对话。
3. 进入 **Agent**。
4. 查看自动探测结果，或新增自定义 Agent。
5. 检查可执行文件路径与参数。
6. 选择默认 Agent。
7. 发起一次测试对话，确认能访问当前 Vault。

若终端里能跑、应用内探测不到：图形应用的 PATH 可能与 shell 不同，请填写**绝对路径**。远程 Vault 时，Agent 装在**服务器**上，见 [打开远程 Vault](remote-vault.md)。

## 卸载 Agent

1. 打开 **Settings → Agent**，在已安装或已注册的 Agent 行点 **Trash** 按钮。
2. 确认对话框展示该 Agent 的 logo 与将要执行的清理项：
   - Agentero 静默安装的 npm 全局包（如 `opencode-ai`、`@anthropic-ai/claude-code` 等）逐个 `npm uninstall -g`；
   - Agentero 管理的目录（dsh 的 `~/.agentero/dsh-acp`、Kimi Code 的 `~/.kimi-code`）整体删除。
3. 确认后行内显示卸载进度，完成后注册项一并移除，行回到「未安装」状态。

清理范围与保留项：

- **不清理**：官方安装器或 Homebrew 安装的 CLI、shell 配置中官方 installer 写入的 PATH 行、Agent 会话历史。这些无法可靠定位或属于用户数据，均保留。
- **仅移除注册项**：对没有可管理卸载路径的 Agent（如 Hermes、纯 PATH 探测到的 CLI），对话框会注明只删 Agentero 注册项，磁盘文件不动。
- **自定义 Agent**：走同一确认对话框，但只移除注册项（自定义 Agent 的二进制由用户自管）。

## 使用 Skill

Agentero 的 Skill 是放在 Vault `.agents/skills/<name>/` 下的 prompt 包，含 `SKILL.md` 与可选的 `scripts/`、`references/`、`assets/`。

### 安装 Skill

1. 复制 GitHub Skill 链接，或 `npx skills add <repo> --skill <name>` 文本。
2. 打开魔棒（`⇧⌘I`）并粘贴。
3. 在弹出的选择窗口中勾选要安装的 Skill；已安装的会标记出来，不会被覆盖。
4. 确认后 Skill 写入 `.agents/skills/<name>/`，即可在 Agent 工作流中使用。

Skill 来源不受 Agentero 审计，安装第三方 Skill 等于引入外部指令，请自行判断信任度。

### 运行 Skill

在 Agent 面板 Composer 中按 Agent 约定触发：Claude 用 `/skill-id`，其他 Agent 由 `SKILL.md` 自动注入。具体写法见 Skill 自身的 `SKILL.md`。

## 第一次对话

1. 打开一篇论文（默认 PDF | NOTES 分屏）。
2. 打开右侧 **Agent** 面板。
3. 直接提问，或点空状态建议 chips（Summarize、Ask library、Draft Related Work 等）。
4. 当前论文默认加入上下文（可 X 移除）；也可用 `@` 提及路径，或从文件树拖入。
5. 运行中仍可继续输入：后续消息进队列，当前回复结束后自动发送。
6. 若 Agent 改了笔记，在统一 Diff 中选择 Keep 或 Revert。

可选：**个人偏好提示词**（Settings → Agent → `agentPersonalPrompt`）会注入工作流 envelope；留空则不注入。

## 权限模式

Settings → Agent → 全局权限模式（对所有 Agent 生效，非 per-provider YOLO）：

| 模式 | 适合场景 |
|---|---|
| 受限（默认） | 限制写入与敏感操作 |
| 每次询问 | 每个权限请求弹窗确认 |
| 自动批准 | 已信任 Agent 与 Vault，追求连续效率 |

建议第一次用 **每次询问**，确认行为后再切换。

## 让 Agent 精读论文

前提：本地 PDF，且有 TeX 或 `PAPER.md` 等可读正文。

### 手动精读

1. 文件树中找到资源齐全且未读（`is_read === false`）的论文。
2. 点击论文行上的 **Zap**。
3. 等待左下角后台任务完成。
4. 打开 `NOTES.md` 检查结果。

### 自动精读

Settings → Agent 开启 **自动精读**（`autoPaperReader`，默认关）。魔棒入库或单篇 Download 资源就绪后可自动启动。**批量**导入 / 批量 Download **不会**连跑精读。

## 常见问题

### 探测失败

确认命令已安装、当前用户可在终端执行，并在设置中填正确路径。Node 全局安装时检查全局 bin 是否在应用 PATH 中。

### 能回答但不能写 NOTES.md

检查权限模式与工作目录。远程 Vault 上 Agent 必须以远端 Vault 根为 cwd。

### 不想让 Agent 改笔记

用受限模式，或在每次询问时拒绝写入。写入后可走 Diff 审阅。

### 消息发不出去 / 输入法

中文等输入法组字时按 Enter 不应误发送；若仍异常，请更新到最新版本。

## 下一步

- [阅读、标注与整理](read-and-organize.md)（划词提问与翻译）
- [打开远程 Vault](remote-vault.md)
