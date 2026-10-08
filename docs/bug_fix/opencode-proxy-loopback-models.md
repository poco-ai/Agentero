# 开启网络代理后 OpenCode 模型列表为空（回环流量被代理劫持）

**Issue**：[#638](https://github.com/poco-ai/Agentero/issues/638)（第三条独立根因，与前两次目录合并 / 推送时序修复并列）

## 现象

Settings → 通用 → 网络代理开启（如 Clash `http://127.0.0.1:7890`）后，OpenCode 的模型列表为空：Agent 侧栏模型切换无可选项，`session/new` / `session/list` 全部 `ClientError`。关闭代理开关立即恢复。同一开关下 Claude、Pi 等 agent 不受影响；手动在终端跑 `opencode acp`（无注入）也一切正常。

## 原因

OpenCode 的 ACP 架构在 catalog agent 中独有：`opencode acp` CLI 会 spawn `opencode serve --stdio --port 0` 子进程，然后**经 127.0.0.1 HTTP** 调用它的 API（模型目录来自 `session/new` 的 `configOptions`）。

1. Agentero 的代理开关在 registry snapshot 时给每个 agent 的 env 注入 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（`store::apply_proxy_to_agent`），注入只作用于 snapshot clone，不落盘。
2. OpenCode 内部 SDK client 遵守代理变量 → 对自身 serve 的回环请求被路由进本地代理 → Clash 拒绝转发回环目标（502）→ `ClientError` → `session/new` 100% 失败 → 模型列表为空。
3. serve 的完整初始化是惰性的，由第一个 HTTP 请求触发；被代理劫走的请求永远到不了 serve，所以 app 派生的 serve 日志一直停在 `cli starting`——这是「看似 serve 没启动」假象的来源。
4. macOS 系统 HTTP 代理的例外列表（`ExceptionsList` 已含 `127.0.0.1` / `localhost`）只作用于系统层代理；进程 env 注入绕过了它。

**排障困难的来源**：`ps eww` 在 macOS 上对显式传 env 的子进程显示 0 个环境变量（它显示 execve 快照，且不反映父进程运行时注入），app 进程 env 看起来是「干净」的；手动复刻不带注入所以总能成功。最终在 spawn 路径临时 dump env 才实锤三个代理变量确实进入了 OpenCode 的子进程环境。手动验证：注入代理变量 + `NO_PROXY=127.0.0.1,localhost,::1` 后 `session/new` 0.18s 恢复成功。

上游对应：opencode#31096（bypass HTTP proxy for localhost SDK requests）在当时版本（2.0.18）尚未合入。

## 修复

所有代理注入点在注入三个代理键的同时合并 `NO_PROXY=127.0.0.1,localhost,::1`（用户已有的 `NO_PROXY` 条目保留在前、大小写不敏感去重）。合并逻辑共享为 `models::merge_no_proxy`：

- `registry/store.rs` `apply_proxy_to_agent` — 本地 agent snapshot 注入；
- `registry/remote.rs` `apply_proxy_env` — 远端 catalog probe 描述符（远端机器上的 OpenCode 同样经回环调 serve）；
- `agentero-core` `REMOTE_PROXY_ENV_KEYS` 增加 `NO_PROXY` / `no_proxy` — 本地注入的豁免随代理键一起经 `proxy_env_from_map` 镜像 export 到远端 agent 进程；
- `registry/lifecycle.rs` `apply_proxy_env_to_command` — 安装器子进程（curl/npm/powershell），顺带保护 postinstall 脚本对 localhost 服务的访问。

代理关闭时只清除注入的三个代理键，用户自配的 `NO_PROXY` 原样保留。

## 验证

```bash
cargo test -p agentero --lib      # 603 passed
cargo test -p agentero-core       # 604 passed
```

新增测试：store 注入合并 / 用户条目保留 / 禁用清除（`store.rs`）、远端注入豁免（`remote.rs`）、安装器注入豁免（`lifecycle.rs`）、镜像键收集含 `NO_PROXY`（`agentero-core/remote.rs`）。

Roadmap 与 TODO 已检查：代理注入既有行为的缺陷修复，不新增未完成产品项。
