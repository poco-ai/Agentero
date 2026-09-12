# 应用设置（Host）

| Command | 说明 |
|---|---|
| `settings_get` | 读全部设置 |
| `settings_set` | 合并写入并广播 `settings:changed` |

- 路径：`$XDG_CONFIG_HOME/agentero/settings.json`（macOS 通常 `~/.config/agentero/`）。
- `telemetryEnabled`：是否把行为事件脱敏投影到 PostHog（见 [telemetry.md](telemetry.md)）。本地 `usage.sqlite` 记录始终开启、无开关。
- `plazaEnabled`：是否显示并加载广场（默认开）。关闭后侧栏不渲染广场节点，已开的广场 tab 关闭，且不挂载 `PlazaView`（含站点代理 iframe / 订阅轮询）。
- `plazaHiddenSources`：被隐藏的广场来源 id 列表（默认空）。侧栏广场子行按此过滤；右键广场父节点逐条勾选显隐。
- `mcpEnabled` / `mcpPort`：内置 loopback Streamable HTTP MCP server 开关与端口（默认关、8765）。
- `mcpTunnelId` / `mcpTunnelApiKey`：ChatGPT Secure MCP Tunnel 凭据；key 与 translate API key 同样走 mask/keep-previous，不回流 WebView。
- `onboardingDone` / `featureTourDone`：首次运行向导与 Vault 打开后的功能导引是否已完成（默认 `false`）。前端完成/跳过后写入；Host schema 必须保留这两个字段，否则 `settings_set` 会静默丢掉，下次启动再次弹出（#398）。
- 网络代理（`networkProxyEnabled` / `networkProxyUrl`）：作用于 Host 全部 reqwest 客户端（广场站点代理、订阅、检索、翻译、模型下载）与 Agent 流量。**开关关闭时自动回退 Windows 系统代理**（读注册表 `Internet Settings` 的 `ProxyEnable`/`ProxyServer`，30s TTL 缓存以跟随代理软件开关）；reqwest 默认不读 Windows 系统代理，此回退避免“浏览器能开、应用内页面打不开”的割裂。`network_system_proxy` 命令暴露检测结果：更新器插件用它做代理回退，设置页在开关关闭时显示“检测到系统代理”。
- GitHub 镜像（`githubMirrorEnabled` / `githubMirrorBaseUrl`）：Skill 导入专用 URL 前缀回退（直连 `api.github.com` / `codeload.github.com` 失败后再试 `{base}/https://…`）。默认关；`githubMirrorBaseUrl` 只能从内建预设列表中选取，不再允许用户填写自定义地址。与网络代理正交。见 [skill-import.md](skill-import.md)。
- 旧 localStorage 键一次性迁移。
- Agent 注册表等同目录管理。

## 内置 provider 凭证解析

settings 不存内置 provider 的任何凭证；它只在**读取时**把 id `agentero` 解析到构建期注入的凭证（见 [builtin-provider.md](builtin-provider.md)）。

- **`embedding.source`**（`"builtin"` | `"custom"`）：普通 `#[serde(default)]`，空串即「未设置」，**不是**返回 `"builtin"` 的 default fn——否则一个填了 BYOK 端点但没有 `source` 键的旧 `settings.json`，与「用户显式选了内置」无法区分。`normalize()` 里的 `resolve_embedding_source()` 推断：显式值优先 → `baseUrl`/`apiKey`/`model` 任一非空（全 `*` 掩码也算非空）⇒ `custom` → 三项全空 ⇒ `builtin`。该规则必须与前端 `normalizeEmbeddingSettings` **逐条一致**（它在 Host load、legacy 迁移、每次保存、`settings_set` 回显、`settings:changed` 时都会跑）。已填过自定义端点的老用户不会被静默切走。
- **`embedding.batchSize`**：每次 embedding 请求的最大输入条数，默认 **64**；旧配置缺少该字段时同样使用 64，0 在 Host 归一化时回退到 64。设置 → Agent → Embedding 模型中可填写正整数，内置和自定义来源均生效；例如接口单批上限为 8 时设为 **8**，保存后刷新 arXiv Daily。
- **`embedding_config()`**：返回 `(base_url, api_key, model, batch_size)`；source 非 `custom` 且 `builtin::available()` 时凭据取自内置网关，否则使用已存值，缺少端点配置则 `None`，让 `recommend.no_embedding` 照常触发。批次大小始终取自用户设置。
- **`layout_api_key` / `layout_base_url` / `layout_model`** 在 **getter 层**特判内置 id，这样所有调用方（`body_engines/mod.rs`、`layout/hosted/commands.rs`）自动正确，不必各自加分支。`layout_prompt` / `layout_language` / `layout_is_ocr` **不特判** → `None` / `None` / `false`：提示词由 VLM 引擎按 model id 推导，后两项是 MinerU 专用。
- **`layout_provider_settings_key("agentero")`** 返回 `"agentero"`，只为给 parser 凭证 `HashMap` 一个稳定的键；它不对应任何落盘卡片。
- **`PARSER_BACKENDS` vs `LAYOUT_BACKENDS`**：前者含 `agentero`，后者**不含**。`normalize()` 在每次保存时都会跑并把未列入的 backend 重置为默认值、由 `persist` 写盘，所以白名单就是「选择能否留存」的开关。`default_layout_backend()` 无条件 `"local"`；`default_translate_provider()` 与 `default_parser_backend()` 在 `builtin::available()` 时返回 `agentero`。
- **新装默认值由 Rust 决定**：没有 `settings.json` 时 `read_file` 返回 `AppSettings::default()`，走的是上面的 `default_*()`。前端 TS 的 defaults 只在浏览器 dev（不可能有 key）里生效，因此刻意保持在非内置值上，两边不需要一致。
- **key 收敛**：`normalize_layout_provider_configs` 的 `PROVIDERS` 白名单是 `["paddle", "mineru", "openaiCompatible"]` + `retain`，任何 `agentero` 卡片都会在保存时被丢弃，所以编译进去的 key 不可能被写进 `settings.json`（有测试断言）。

## 耦合契约（schema 无关配置层）

settings 只提供读/写/持久化/广播能力，**不 import 任何域 feature**（出边仅 `core/*`）：

- `settings_set` 只做：proxy 校验 → `store.set`（merge 密钥/normalize/原子落盘）→ 广播 `settings:changed`。
- 域侧反应通过 `AppSettingsStore::subscribe` 在 app 装配（`app/mod.rs` setup）注册，`set` 成功后以 redacted 快照触发（模式同 P2-12 JobCenter runner 注册制）：
  - agent：`set_proxy`（网络代理同步）
  - import：`refresh_parser_config`（正文解析引擎凭据快照，桌面端）
  - connector：`set_port`（端口变更重绑监听）
  - mcp：`set_port` + translator / note-mode 快照（端口变更重绑监听；端口变化时自动停掉内置 ChatGPT tunnel，用户需再点 Start）
  - tunnel：与 MCP 同域，但凭据从 settings store 原值读取（不通过 redacted 快照传递），启动/停止由 `mcp_tunnel_start` / `mcp_tunnel_stop` 命令驱动
  - jobs：`apply_layout_backend` + `apply_import_concurrency` + `drain_and_spawn`（layout / 导入并发上限）
- 反序列化期需要的域默认值（如 `DEFAULT_CONNECTOR_PORT`）定义在 settings，由属主域 re-export（方向 `connector → settings`，不成环）。
- **一处反向例外**：`BUILTIN_PROVIDER_ID` 由 settings `pub use agentero_core::features::translate::BUILTIN_PROVIDER_ID`，方向是 `settings → translate`（与上一条相反），目的是让 Host 不再手打这个字面量。它是纯常量、没有函数调用，因此不成环。另外 settings 会调 `crate::features::system::builtin`（`available()` / `api_key()` / `status()`）——那是 `system` 域内的兄弟模块，不是跨域出边。

前端：[../frontend/settings.md](../frontend/settings.md)  
代码：`src-tauri/src/features/system/settings/`
