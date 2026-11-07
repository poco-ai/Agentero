# 应用设置（Host）

| Command | 说明 |
|---|---|
| `settings_get` | 读全部设置 |
| `settings_set` | 合并写入并广播 `settings:changed` |

- 路径：`$XDG_CONFIG_HOME/agentero/settings.json`（macOS 通常 `~/.config/agentero/`）。同目录的 `plugins.json` 不是 `AppSettings` 的字段：`schemaVersion` 1，`plugins` 是尚未解释的 JSON 数组（缺文件时为空），未知键保留，启动时不读取，设置页没有插件开关。见 [plugin-api.md](../development/plugin-api.md)。
- `telemetryEnabled`：是否把行为事件脱敏投影到 PostHog（见 [telemetry.md](telemetry.md)）。本地 `usage.sqlite` 记录始终开启、无开关。
- `plazaEnabled`：是否显示并加载广场（默认开）。关闭后侧栏不渲染广场节点，已开的广场 tab 关闭，且不挂载 `PlazaView`（含站点代理 iframe / 订阅轮询）。
- `plazaHiddenSources`：被隐藏的广场来源 id 列表（默认空）。侧栏广场子行按此过滤；右键广场父节点逐条勾选显隐。
- `mcpEnabled` / `mcpPort`：内置 loopback Streamable HTTP MCP server 开关与端口（默认关、8765）。
- `mcpTunnelId` / `mcpTunnelApiKey`：ChatGPT Secure MCP Tunnel 凭据；key 与 translate API key 同样走 mask/keep-previous，不回流 WebView。
- `onboardingDone` / `featureTourDone`：首次运行向导与 Vault 打开后的功能导引是否已完成（默认 `false`）。前端完成/跳过后写入；Host schema 必须保留这两个字段，否则 `settings_set` 会静默丢掉，下次启动再次弹出（#398）。
- `wikiEmbedFontSize` / `markdownMaxWidth`：双链嵌入正文字号（12–20，默认 13）和 Markdown 编辑列最大宽度（`0` 或 640 / 720 / 800 / 960 / 1120，默认 `0` 全宽）。Host schema 必须保留这两个字段，否则保存时会丢掉，下次启动回到默认值（#733）。
- 网络代理（`networkProxyEnabled` / `networkProxyUrl`）：作用于 Host 全部 reqwest 客户端（广场站点代理、订阅、检索、翻译、模型下载）与 Agent 流量。**开关关闭时自动回退 Windows 系统代理**（读注册表 `Internet Settings` 的 `ProxyEnable`/`ProxyServer`，30s TTL 缓存以跟随代理软件开关）。reqwest 0.12 的 `system-proxy` feature 已有 Windows/macOS 检测，但不提供将选中 URL 导出给子进程的公开接口；本项目保留动态检测与统一优先级，URL 校验、代理连接交给上游 `Proxy::all`，不额外开启 feature 改变 macOS / 分协议路由策略。`network_system_proxy` 命令暴露检测结果：更新器插件用它做代理回退，设置页在开关关闭时显示“检测到系统代理”。共享 HTTP client 与缓存键使用同一代理快照，避免设置更新时标错缓存。
- 机构代理（`institutionProxyType` / `institutionProxyPrefix` / `institutionProxyCookie`）：付费文献 PDF 兜底，OA 链路全未命中时经机构网关重写请求。`institutionProxyType` 取 `ezproxy`（查询透传 `{prefix}{urlencode(target)}`，裸域名自动补 `/login?url=`）或 `wengine`（网瑞达路径式 `/https/{AES-128-CTR(host)}/{path}`，浙大等）；空前缀禁用。设置页提供常见院校快速填充、独立网页登录；新 Cookie 通过 PDF 探测后自动保存并关窗，关窗后设置页再自动探测一次。每天最多自动探测一次已配置凭据，明确认证失效时提醒更新。见 [academic-search-apis.md](academic-search-apis.md)。该三字段除 Host 设置存储外，headless CLI 启动时也会读取同一份 `settings.json` 并注入进程级下载链（`download::load_institution_proxy_from_settings`），使 CLI 的 `import id` / `paper download` 与桌面行为一致。
- `shortcutOverrides`：按命令 id 保存自定义组合（`key` + 可选 `meta` / `ctrl` / `alt` / `shift`），`null` 禁用，缺省使用默认。旧文件默认空映射；保存、重启与 `settings:changed` 保留配置。macOS 菜单订阅设置，重建加速键；录制期间 `set_menu_shortcut_recording` 暂停菜单，结束录制或窗口销毁后恢复。
- 旧 localStorage 键一次性迁移。
- Agent 注册表等同目录管理。

## 内置 provider 凭证解析

settings 不存内置 provider 的任何凭证；它只在**读取时**把 id `agentero` 解析到构建期注入的凭证（见 [builtin-provider.md](builtin-provider.md)）。

- **`embedding.source`**（`"builtin"` | `"custom"`）：普通 `#[serde(default)]`，空串即「未设置」，**不是**返回 `"builtin"` 的 default fn——否则一个填了 BYOK 端点但没有 `source` 键的旧 `settings.json`，与「用户显式选了内置」无法区分。`normalize()` 里的 `resolve_embedding_source()` 推断：显式值优先 → `baseUrl`/`apiKey`/`model` 任一非空（全 `*` 掩码也算非空）⇒ `custom` → 三项全空时，有编译期 key 的构建 ⇒ `builtin`，无 key 的源码 / dev 构建 ⇒ `custom`。前端浏览器 dev 默认也保持在 `custom`。已填过自定义端点的老用户不会被静默切走。
- **`embedding_config()`**：source 非 `custom` 且 `builtin::available()` 时返回网关三元组；无编译期 key 时穿透到已存值，仍为空则 `None`，让 `recommend.no_embedding` 照常触发。
- **`layout_api_key` / `layout_base_url` / `layout_model`** 在 **getter 层**特判内置 id，这样所有调用方（`body_engines/mod.rs`、`layout/hosted/commands.rs`）自动正确，不必各自加分支。`layout_prompt` / `layout_language` / `layout_is_ocr` / `layout_self_hosted` **不特判** → `None` / `None` / `false` / `false`：提示词由 VLM 引擎按 model id 推导，后三项是 MinerU 专用。
- **`layout_provider_settings_key("agentero")`** 返回 `"agentero"`，只为给 parser 凭证 `HashMap` 一个稳定的键；它不对应任何落盘卡片。
- **`PARSER_BACKENDS` vs `LAYOUT_BACKENDS`**：前者含 `agentero`，后者**不含**。`normalize()` 在每次保存时都会跑并把未列入的 backend 重置为默认值、由 `persist` 写盘，所以白名单就是「选择能否留存」的开关。`default_layout_backend()` 与 `default_parser_backend()` 无条件 `"local"`，包括旧配置未设置 `parserBackend` 的情况；Host 读写仍保留显式设置的有效引擎（#858）。设置页另有内置选项迁移，见 [builtin-provider.md](builtin-provider.md) §版面分析不走内置。`default_translate_provider()` 仍在 `builtin::available()` 时返回 `agentero`。
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
