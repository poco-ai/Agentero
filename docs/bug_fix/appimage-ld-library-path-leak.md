# AppImage 的 LD_LIBRARY_PATH 泄漏导致系统 Node 无法运行（#1002）

**状态**：已修复

## 问题

用 Linux AppImage 启动 Agentero 后：

- Settings → Agent 顶部提示「需要 Node.js」，系统终端里 `node -v` 正常；
- Dsh / Kimi Code / Codex 等 Node 型 ACP 在 spawn 阶段失败；
- Claude 的内置适配器被判定为「无 ACP」；
- 从 Agentero「在终端中打开」的终端里启动 Node 工具，同样报错。

## 根因

AppImage 运行时会把自身挂载目录的库路径注入进程环境：

```bash
tr '\0' '\n' < /proc/$(pgrep -n agentero)/environ | grep LD_LIBRARY_PATH
# /tmp/.mount_.../usr/lib:/tmp/.mount_.../usr/lib/aarch64-linux-gnu:...
```

Agentero 又把这份环境原样传给 ACP、Doctor 子进程、npm 安装器、MCP tunnel 和
系统终端。发行版自带的 `node` 启动时会优先加载 AppImage 里的旧 `libffi` /
`libbrotli`，于是动态链接阶段就失败：

```text
node: /tmp/.mount_.../usr/lib/libffi.so.8:
version `LIBFFI_CALL_PLAN_8.4' not found (required by node)
```

这不是用户没装 Node，也不是 Node 版本太旧。只覆盖 `libffi` 还会继续撞上
`BrotliDecoderAttachDictionary`，说明是整组宿主库被遮蔽。

## 修复

**统一清理子进程环境**（`crates/agentero-core/src/process`）

- 新增 `strip_appimage_library_env`：只在检测到 AppImage 运行时标记
  （`APPIMAGE` / `APPDIR`）时移除 `LD_LIBRARY_PATH` 和 `LD_PRELOAD`。
  deb / rpm / Homebrew 安装以及用户自己设置的 loader 变量不受影响。
- 新增 `SanitizeAppImageEnv` trait，同时覆盖 `std::process::Command` 和
  `tokio::process::Command`，由调用方显式清理继承环境。

**接入所有外部子进程**

- ACP：`build_child_env` 在合并 process / login-shell / descriptor 环境后清理，
  login shell 无法再把它带回来。
- Doctor：`run_command` / installer / Codex app-server 统一用清理后的环境。
- Agent lifecycle：npm / curl 安装器启动前清理。
- MCP tunnel：`run` 与 health probe 清理。
- 终端：系统终端（默认与 preset）以及 ACP `terminal/create` 清理。
- Node 探测：`node_major_of`、`node_meets`、npm 版本探测、Dsh 兼容性检查清理。

**让不可用状态可诊断**

- `diagnose_tool` 在 `--version` 退出失败时，把 stdout/stderr 第一行放进
  `HostToolDiagnostic.detail`，不再只显示退出码。
- `node_blocker_message` 区分「未安装」「无法启动」「版本过低」；无法启动时
  不再提示安装 Node。
- Settings → Agent 的 Node 提示区分 `missing` 与 `unusable`：
  `unusable` 隐藏「安装 Node.js」，改为引导打开问题诊断。
- 内置 ACP 适配器存在、host CLI 存在但 ACP 不可用时，行内 badge 显示
  「Node 无法运行」而不是「无 ACP」，具体错误仍在 tooltip。

## 验证

- 单元测试覆盖 AppImage 环境下剥离 loader 变量、非 AppImage 环境保留用户变量。
- 在 AppImage 内启动 ACP / Doctor / 终端时，子进程环境不再包含
  `LD_LIBRARY_PATH` / `LD_PRELOAD`，系统 Node 可正常执行。
- Settings → Agent 中 Node 状态恢复「可用」，Node 型 ACP 可重新探测。
