# 接入 Agent

连接 Agent 后，你可以在阅读论文时提问、整理资料或修改笔记。Agentero 通过 ACP 连接已安装并登录的 Agent；Agent 的模型账号和 API Key 由 Agent 自己管理。

## 添加 Agent

![Agent 设置中的默认 Agent 和安装状态](../assets/agent-setting.png)

1. 按所选 Agent 的官方说明安装并登录。Agentero 支持 Claude ACP、Codex（通过 ACP 适配器）、Cursor Agent、OpenCode 等兼容 ACP 的命令行工具，也可以添加自定义 Agent。
2. 打开 **设置 → Agent**，查看自动探测结果，或添加自定义 Agent。
3. 检查命令和参数，选择默认 Agent，然后在 Agent 面板发一条消息测试。

部分桌面应用自带 CLI，例如 ChatGPT 自带 Codex、WorkBuddy 自带 CodeBuddy。Agentero 可以通过这些 CLI 接入，设置中会显示「桌面内置」。应用本身并非 ACP Agent。

自定义 Agent 的命令必须是 ACP 服务或 ACP bridge。Agentero 从当前 Vault 根目录启动它；脚本和解释器建议使用绝对路径，因为桌面应用的 PATH 可能与终端不同。GenericAgent 的配置示例见[接入 GenericAgent ACP](genericagent-acp.md)。

远程 Vault 使用服务器上安装的 Agent，见[打开远程 Vault](remote-vault.md)。如果想让外部客户端访问 Vault，见 [MCP 指南](mcp.md)。

## 开始对话

1. 打开一篇论文，再打开右侧 **Agent** 面板。
2. 输入问题。当前论文默认加入上下文；可移除它，也可以用 `@` 提及文件或从文件树拖入文件。
3. Agent 修改笔记后，在 Diff 中检查更改，选择保留或撤销。

回复进行时可以继续输入，后续消息会排队发送。**设置 → Agent** 中还可以填写个人偏好提示词，留空则不注入。

## 权限与精读

在 **设置 → Agent** 中选择全局权限模式：受限、每次询问或自动批准。初次使用时可选择每次询问，检查 Agent 请求的操作。

要精读论文，在文件树中点击符合条件的未读论文旁的精读图标，等待后台任务完成后检查 `NOTES.md`。精读需要本地 PDF，以及 TeX、`PAPER.md` 等可读正文。设置中的自动精读默认关闭；开启后，魔棒入库或单篇下载完成时可自动启动，批量导入或批量下载不会逐篇自动精读。精读 Agent 和模型可在设置中单独指定。

## 使用 Skill

Skill 保存在 Vault 的 `.agents/skills/<name>/`，入口是 `SKILL.md`。可以复制 GitHub Skill 链接或 `npx skills add <repo> --skill <name>`，打开魔棒粘贴，在选择窗口确认安装。已安装的 Skill 不会被覆盖。

在 Agent 对话中按所用 Agent 的方式调用 Skill。第三方 Skill 包含外部指令，安装前请判断来源是否可信。Claude Code 检测到后，Agentero 会在没有现有 `.claude/skills` 目录时为它创建指向 Vault Skill 目录的链接；Pi 则需要先信任 Vault 才会加载项目 Skill。

## 常见问题

- **找不到 Agent**：确认命令已安装并登录；终端可用但应用探测不到时，尝试在设置中填写绝对路径。
- **无法修改笔记**：检查权限模式。远程 Vault 还需要确认 Agent 在服务器上运行，并能访问 Vault。
- **不希望修改笔记**：使用受限或每次询问模式；收到写入请求时可以拒绝。
- **精读使用了不想要的模型**：在设置的「精读论文」中指定 Agent 和模型；留空时跟随默认 Agent 及其模型选择。

可在设置的 Agent 行中卸载或移除注册项。确认对话框会列出清理范围；自定义 Agent 只移除注册项，其程序由用户管理。
