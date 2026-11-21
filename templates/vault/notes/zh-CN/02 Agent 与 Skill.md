# Agent 与 Skill

先在电脑上安装并登录支持 ACP 的 Agent，再到 Agentero 里连接。这种接入方式也叫 **BYOA**（Bring Your Own Agent）。用已登录的 Agent 对话时，Agentero 会把问题和随消息发送的资料交给它，无需在 Agentero 里再填一遍模型 API Key。

## Agent 面板

点右上角的侧边栏按钮，或按 `⌘+L`，打开 **Agent** 面板。

打开论文时，当前论文会自动加入 Agent 上下文。你可以：

- 直接输入问题。
- 用 `@` 提及 Vault 中的任意路径。
- 输入 `/` 查找 Agent 提供的命令。
- 把文件树中的文件或文件夹拖进输入框，随问题一起发给 Agent。
- 在 PDF 中选中文本或批注并发送给 Agent。

Agent 回复时也可以接着写。后续消息会排队，等这条回复结束再自动发送。

## Skill

### 使用 Skill

在对话框输入 `$`，从列表里选择已安装的 Skill。

### 修改 Skill

直接编辑对应的 `SKILL.md`。

### 新增 Skill

在 `.agents/skills/` 下新建文件夹并放入 `SKILL.md`。

也可以把 Skill 的链接粘贴到魔棒里，让 Agentero 下载并安装。

### 内置 Skill

内置 Skill 包括：

- `paper-reader` — 精读论文并写入 `NOTES.md`。
- `agentero-cli` — 通过 CLI 执行 Vault 操作。
- `vault-normalizer` — 将现有研究目录整理为 Agentero Vault 布局。
- `deep-research` — 多轮研究并带引用。
- `idea-evaluator` — 多角度评估研究想法。

### 案例1：精读论文

先确认论文有本地 PDF，以及可读的 TeX 源码或 `PAPER.md`。

- **手动精读**：在未读论文行点击 **精读图标**。
- **自动精读**：在设置 → Agent 开启 **入库后自动精读**（默认关闭）。

精读结果写入该论文的 `NOTES.md`，完成后论文标记为已读。

## 设置

### 添加 Agent

1. 打开 **设置**（`⌘,`）。
2. 进入 **Agent**。
3. 选择自动探测到的 Agent，或新增自定义 Agent。
4. 如果应用探测不到，填写可执行文件的**绝对路径**。
5. 选择默认 Agent。
6. 发起一次测试对话。

### 不直接支持的 Agent

以下桌面应用目前**不能**直接作为 Agentero 内嵌 Agent 使用：

- **OpenAI Codex 桌面版**：Agentero 通过 ACP 接入的是 **Codex CLI**（命令行版）+ `@agentclientprotocol/codex-acp` 适配器；独立的 Codex 桌面 App 未暴露可被 Agentero 连接的接口。
- **WorkBuddy（腾讯）**：Agentero 当前没有 WorkBuddy 的 ACP 适配模板，不能直接接入。

如需使用 Codex，请安装 Codex CLI 后通过 `codex-acp` 接入；WorkBuddy 暂无可行接入方式。

## 问题解决

### Q1: 发现不了 Agent

先确认电脑上装了这个 Agent，然后检查它的可执行文件是否在系统 `PATH` 中。也可以在 **设置** → **Agent** 里用绝对路径手动添加。

### Q2：Agent 无法连接或使用网络

在 **设置** → **通用** 中检查代理设置。

## 下一步

- [[01 论文导入与管理]]
- [[03 Markdown 与双链]]
