# 接入 GenericAgent ACP

[GenericAgent](https://github.com/lsdefine/GenericAgent) 提供 ACP bridge，可以作为 Agentero 的自定义 Agent 使用。先按其官方说明安装 GenericAgent、配置 `mykey.py` 和模型，再打开目标 Vault。

## 配置

1. 在 **设置 → Agent** 中添加自定义 Agent。
2. 命令填写 GenericAgent 环境中 Python 解释器的绝对路径。
3. 参数填写 `frontends/genericagent_acp_bridge.py` 的绝对路径，按需追加 `--llm-no` 和 `--root-dir`。
4. 可设置环境变量 `PYTHONUNBUFFERED=1`，然后保存。
5. 在 Agent 面板选择 GenericAgent，发送「请列出当前 Vault 根目录下的文件」测试连接。

例如，将以下路径替换为本机的实际路径：

```text
command: /path/to/GenericAgent/.venv/bin/python
args:    /path/to/GenericAgent/frontends/genericagent_acp_bridge.py --llm-no 0
```

Agentero 从 Vault 根目录启动自定义 Agent，因此不要使用相对的脚本路径。`--llm-no` 从 0 开始，选择 `mykey.py` 中的模型配置；`--root-dir` 可指定 GenericAgent 工作根目录。

## 限制和排查

现有 bridge 未启用图片、音频和 MCP 输入，终端也不适合运行 `vim`、`nano` 等交互式程序。会话数据保存在 GenericAgent 的 `{root-dir}/temp/acp_sessions/`，更换目录时不会自动迁移。

启动失败时，检查 Python 和脚本的绝对路径、`mykey.py`、模型凭据和网络；也可以在终端手动运行 bridge 查看报错。通用设置见[接入 Agent](agents.md)。
