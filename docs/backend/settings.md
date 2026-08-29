# 应用设置（Host）

| Command | 说明 |
|---|---|
| `settings_get` | 读全部设置 |
| `settings_set` | 合并写入并广播 `settings:changed` |

- 路径：`$XDG_CONFIG_HOME/agentero/settings.json`（macOS 通常 `~/.config/agentero/`）。
- `telemetryEnabled`：是否把行为事件脱敏投影到 PostHog（见 [telemetry.md](telemetry.md)）。本地 `usage.sqlite` 记录始终开启、无开关。
- `plazaEnabled`：是否显示并加载广场（默认开）。关闭后侧栏不渲染广场节点，已开的广场 tab 关闭，且不挂载 `PlazaView`（含站点代理 iframe / 订阅轮询）。
- `plazaHiddenSources`：被隐藏的广场来源 id 列表（默认空）。侧栏子行与广场首页卡片按此过滤；右键来源行隐藏、右键广场父节点逐条切换显隐。
- `mcpEnabled` / `mcpPort`：内置 loopback Streamable HTTP MCP server 开关与端口（默认关、8765）。
- `mcpTunnelId` / `mcpTunnelApiKey`：ChatGPT Secure MCP Tunnel 凭据；key 与 translate API key 同样走 mask/keep-previous，不回流 WebView。
- `onboardingDone` / `featureTourDone`：首次运行向导与 Vault 打开后的功能导引是否已完成（默认 `false`）。前端完成/跳过后写入；Host schema 必须保留这两个字段，否则 `settings_set` 会静默丢掉，下次启动再次弹出（#398）。
- 网络代理（`networkProxyEnabled` / `networkProxyUrl`）：作用于 Host 全部 reqwest 客户端（广场站点代理、订阅、检索、翻译、模型下载）与 Agent 流量。**开关关闭时自动回退 Windows 系统代理**（读注册表 `Internet Settings` 的 `ProxyEnable`/`ProxyServer`，30s TTL 缓存以跟随代理软件开关）；reqwest 默认不读 Windows 系统代理，此回退避免“浏览器能开、应用内页面打不开”的割裂。`network_system_proxy` 命令暴露检测结果：更新器插件用它做代理回退，设置页在开关关闭时显示“检测到系统代理”。
- 旧 localStorage 键一次性迁移。
- Agent 注册表等同目录管理。

## 耦合契约（schema 无关配置层）

settings 只提供读/写/持久化/广播能力，**不 import 任何域 feature**（出边仅 `core/*`）：

- `settings_set` 只做：proxy 校验 → `store.set`（merge 密钥/normalize/原子落盘）→ 广播 `settings:changed`。
- 域侧反应通过 `AppSettingsStore::subscribe` 在 app 装配（`app/mod.rs` setup）注册，`set` 成功后以 redacted 快照触发（模式同 P2-12 JobCenter runner 注册制）：
  - agent：`set_proxy`（网络代理同步）
  - import：`refresh_parser_config`（正文解析引擎凭据快照，桌面端）
  - connector：`set_port`（端口变更重绑监听）
  - mcp：`set_port` + translator / note-mode 快照（端口变更重绑监听；端口变化时自动停掉内置 ChatGPT tunnel，用户需再点 Start）
  - tunnel：与 MCP 同域，但凭据从 settings store 原值读取（不通过 redacted 快照传递），启动/停止由 `mcp_tunnel_start` / `mcp_tunnel_stop` 命令驱动
  - jobs：`apply_layout_backend` + `drain_and_spawn`（layout 并发上限）
- 反序列化期需要的域默认值（如 `DEFAULT_CONNECTOR_PORT`）定义在 settings，由属主域 re-export（方向 `connector → settings`，不成环）。

前端：[../frontend/settings.md](../frontend/settings.md)  
代码：`src-tauri/src/features/settings/`
