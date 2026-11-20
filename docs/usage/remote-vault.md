# 打开远程 Vault

远程 Vault 将论文和笔记保存在服务器上，你可以用本地 Agentero 浏览和编辑。Agent 也在服务器运行。

## 连接前准备

- 使用 macOS 或 Linux 客户端；Windows 客户端目前不能打开远程 Vault。
- 确保可以 SSH 登录服务器，当前用户能读写远程 Vault。
- 服务器的非交互 SSH 环境需要 `python3` 和标准库 `sqlite3` 模块，用于读取一致的 Catalog 快照。
- 要使用 Agent 时，先在服务器安装并登录相应 ACP Agent。

## 连接

1. 在欢迎页或 Vault 切换菜单选择 **Open Remote Vault**。
2. 填写 SSH 用户、主机、端口和远程 Vault 的绝对路径，选择可用的 SSH 认证方式。
3. 连接后等待文件树加载，确认 Library 和论文目录出现。

连接后可以浏览文件、阅读 PDF、编辑笔记、导入论文和使用远程 Agent。PDF 等大文件可能暂存在本机用于预览；远程目录仍是数据来源。

## 使用与排查

远程 Vault 按单写者设计：不要同时让多个 Agentero 客户端、远程 Agent 和外部同步程序修改同一个库。远端文件变化不会实时推送，Agent 结束、保存或重新展开目录时应用会按需检查；需要时可手动刷新文件树，重新加载远程 Catalog。若提示 WAL 尚在，先关闭远端数据库连接，再重新打开 Vault。

连接失败时，先在本机终端测试 `ssh user@host`，检查服务器端口、Vault 绝对路径及权限。找不到 Agent 时，确认它已在服务器登录，且命令在非交互 SSH 的 PATH 中可用；也可以在 Agent 设置中填写绝对路径。
