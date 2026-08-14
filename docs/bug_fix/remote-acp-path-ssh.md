# 远端 ACP：BatchMode SSH PATH / 安装 / 探测

**状态**：已修复（PATH 引导 + 探测候选路径 + 远端 Install ACP 引号 + 代理注入）  
**影响面**：远程 Vault 设置 → Agent；远端 BYOA `agent_warm` / `agent_run_once` / `remote_agent_probe`  
**相关代码**：

- `src-tauri/src/services/remote/agent_exec.rs` — `REMOTE_PATH_BOOTSTRAP`、`remote_which`、`remote_agent_shell_command`
- `src-tauri/src/services/remote/agent_catalog.rs` — scan / probe、缺适配器错误文案
- `src-tauri/src/services/terminal.rs` — `open_terminal_confirm_remote_install`（SSH 安装引号）
- `src-tauri/src/services/agent/templates.rs` — Claude 安装命令（用户 prefix）
- `src-tauri/src/services/agent/acp.rs` — 远端 spawn 注入 proxy env
- `src/components/settings/settings-content.tsx` / `agent-pane.tsx` — 远端 Agent 页：代理、Install ACP
- 设计总览：[`../backend/remote.md`](../backend/remote.md) §5 / §11

---

## 1. 问题现象

1. **交互式 `ssh` 里** `command -v claude-agent-acp` 有路径（如 Linuxbrew），**设置 → Agent（远端）** 仍显示未安装 / ACP 失败 / adapter missing。
2. 点 **Install ACP** 后终端只打印 `npm` 的 Usage 帮助，安装命令未真正执行。
3. 远端 Agent 页没有代理开关；本机开代理后远端 probe 仍超时（或误以为不需要代理）。
4. 用户误以为「装了 Claude Code = 装了 ACP」。

---

## 2. 根因

### 2.1 非交互 SSH 的 PATH ≠ 交互终端 PATH（主因）

Agentero 探测 / 启动远端 Agent 使用：

```bash
ssh -T -o BatchMode=yes <host> 'bash -lc "…"'
```

特点：

| 项 | 交互 `ssh host` | Agentero BatchMode |
|----|-----------------|-------------------|
| TTY | 有 | 无（`-T`） |
| 是否交互 | 是 | 否 |
| PATH | 常含 brew/nvm（`.bashrc` 交互段） | 常为「瘦」login PATH |

许多机器在 `~/.bashrc` 里：

```bash
case $- in *i*) ;; *) return;; esac   # 非交互直接 return
# … 之后才有 eval "$(brew shellenv)"
```

于是 **Linuxbrew** 下的全局 npm bin：

```text
/home/linuxbrew/.linuxbrew/bin/claude-agent-acp
```

在交互 shell 可见，在 BatchMode `command -v` 下不可见。  
这不是「没用用户 PATH」，而是 **同一用户、非交互会话拿到的 PATH 更短**。

实测（BatchMode）PATH 可能类似：

```text
~/.cargo/bin:/usr/local/bin:/usr/bin:…
# 无 /home/linuxbrew/.linuxbrew/bin
```

同时文件已存在：`test -x /home/linuxbrew/.linuxbrew/bin/claude-agent-acp` → OK。

### 2.2 `claude` ≠ `claude-agent-acp`

| 探测项 | 含义 |
|--------|------|
| `detect_command` = `claude` | Claude Code 主机 CLI（「已安装」徽章） |
| `command` = `claude-agent-acp` | ACP 入口（协议 initialize / Chat） |

只装 Claude Code、未装 `@agentclientprotocol/claude-agent-acp` 时：本机/远端都会 **installed + adapter missing**。

### 2.3 远端 Install 脚本 SSH 引号错误（已修）

错误写法：

```bash
ssh -t host -- bash -lc "$CMD"
# 远端再分词后 -c 只吃到 "npm"，其余参数丢失 → 打印 npm Usage
```

正确：本地用 `printf '%q'` 把整段命令作为 **一个** `-c` 脚本：

```bash
ssh -t "$DEST" "bash -lc $(printf '%q' "$CMD")"
```

### 2.4 系统 `npm i -g` 与权限

系统 npm `prefix=/usr` 时，无 root 的 `npm i -g` 易失败。应使用用户可写 prefix，例如：

```bash
npm i -g @agentclientprotocol/claude-agent-acp --prefix "$HOME/.local"
npm i -g @agentclientprotocol/codex-acp --prefix "$HOME/.local"
```

本机设置页打开的 ACP 安装终端也遵循同一策略；否则系统 npm 的
`/usr/local` prefix 会使无 root 用户在安装 Codex adapter 时收到 `EACCES`。

### 2.5 代理

本机 Settings 代理原先只注入 **本机** agent 子进程 env；远端 `ssh … exec agent` **未**转发 `HTTP_PROXY`。  
且代理 URL 必须从 **服务器** 可达（服务器上的 `127.0.0.1:7890` ≠ 本机代理）。

---

## 3. 解决方案（已落地）

### 3.1 `REMOTE_PATH_BOOTSTRAP`

在远端 `bash -lc` 脚本前统一：

- 把 `~/.local/bin`、`/home/linuxbrew/.linuxbrew/bin`、cargo/npm 等目录 **prepend 到 PATH**
- 若存在 brew，尝试 `eval "$(brew shellenv)"`

用于：`remote_which`、`remote_agent_shell_command`（probe / warm / run）。

### 3.2 `remote_which` 绝对路径回退

`command -v` 失败时再扫候选绝对路径（含 linuxbrew、nvm、`npm prefix -g`/bin）。

### 3.3 远端 Install ACP

- `remote_agent_open_install_terminal`：本机终端确认 → `ssh -t` 在远端执行模板 `install_command`
- Claude 默认安装命令改为带 `--prefix "$HOME/.local"`
- UI：与本地一致显示 **ACP adapter missing** + **Install ACP**

### 3.4 远端代理

- 设置远端 Agent 页展示与本地共用的 proxy 开关/URL
- probe / spawn 时在远端 `export HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`
- UI 提示：地址须从服务器可达

### 3.5 探测错误文案

有 `claude`、无 `claude-agent-acp` 时，明确提示安装适配器（含 install 命令），而非笼统「not found」。

---

## 4. 运维注意点（排障清单）

1. **先在 BatchMode 下验证**（与 Agentero 一致），不要只看交互终端：

   ```bash
   ssh -T -o BatchMode=yes <host> 'bash -lc "command -v claude-agent-acp; echo PATH=$PATH"'
   ```

2. 若文件在 brew 下但上面找不到，确认：

   ```bash
   ls -la /home/linuxbrew/.linuxbrew/bin/claude-agent-acp
   ```

   Agentero 新版本应能通过 PATH bootstrap / 绝对路径扫到。

3. **推荐** 在远端 `~/.profile` 或非交互也会执行的配置中加入（且不要被「仅交互」return 挡掉）：

   ```bash
   eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
   ```

4. 安装后应用内 **Refresh**；改代理后会 force 再 probe。

5. Codex 现已通过 ACP 适配器（`codex-acp`）支持纯 SSH。

---

## 5. 参考

- OpenSSH 非交互与 login shell：`bash -lc`、无 TTY
- Linuxbrew 路径：`/home/linuxbrew/.linuxbrew`
- 产品设计：[`remote.md`](../backend/remote.md) §5 远端 BYOA、§11 风险（nvm/PATH）
- API：`remote_agent_scan` / `remote_agent_probe` / `remote_agent_open_install_terminal`（[`api.md`](../backend/api.md)）
