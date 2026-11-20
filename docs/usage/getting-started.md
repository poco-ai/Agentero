# 安装与首次使用

## 安装 Agentero

从 [发布页](https://github.com/poco-ai/agentero/releases)下载适合你的系统和处理器的安装包。首次使用不需要安装 Zotero 或 Agent。

| 系统 | 要求 |
| --- | --- |
| macOS | 12.0 或更新版本 |
| Windows | 选择 x64 或 ARM64 安装包 |
| Linux | Ubuntu 22.04 或更新版本，需 webkit2gtk 4.1 |

macOS 也可以使用 Homebrew 安装：

```bash
brew tap poco-ai/agentero
brew install --cask agentero
```

Linux 安装 `.deb` 时如果提示缺少 `libwebkit2gtk-4.1-0`，请升级系统或尝试发布页的 AppImage。

## 创建或打开 Vault

Vault 是保存论文、笔记和其他资料的文件夹。

1. 启动 Agentero，在欢迎页选择 **Create Vault**。
2. 选择一个长期保存资料的位置，例如文稿目录中的研究文件夹。
3. 等待文件树和 Library 加载完成。

已有资料时，选择 **Open Vault** 并打开对应目录。已有 Zotero 文库也可以从欢迎页选择迁移，见[导入和管理论文](import-papers.md#zotero)。

新建 Vault 中的 `notes/` 包含入门笔记。它们是普通 Markdown 文件，可以编辑或删除；删除后不会自动恢复。

## 认识工作台

![工作台中的文件树、论文和 Agent 面板](../assets/agent.png)

- **左侧文件树**：浏览 Vault，打开 Library 和回收站，使用魔棒导入论文。
- **中间工作区**：打开论文、PDF 和笔记。打开论文时，默认左侧显示正文，右侧显示 `NOTES.md`。
- **右侧面板**：按需打开 Agent、批注、References 或 Figures。
- **左下角任务区**：查看导入、下载等后台任务的进度。

可以用标题栏的 Layout 菜单调整布局。在设置的快捷键页面可以查看和修改按键。

## 数据在哪里

Vault 是普通文件夹，PDF 和 Markdown 笔记可用其他工具打开。论文笔记保存在 `papers/<paper>/NOTES.md`，PDF 标注保存在同一论文目录的 `marks/` 中，不会写入原始 PDF。Library 的论文集合和元数据保存在 `.agentero/catalog.sqlite`；请通过 Agentero 修改元数据，不要手动编辑数据库。

建议定期备份整个 Vault，包括 `.agentero/catalog.sqlite`。如果 PDF 通过软链接放在 Vault 外，还需要单独备份链接目标。

## 遇到问题

**已有论文没有出现在 Library？** 右键文件树中的 `papers/`，选择 **重新扫描 papers/**；空库也可以使用中央的扫描按钮。

**自动更新失败？** 检查网络和设置中的代理，重试更新；也可以从[发布页](https://github.com/poco-ai/agentero/releases)下载最新安装包。

接下来可以[导入论文](import-papers.md)，然后[阅读和标注](read-and-organize.md)。
