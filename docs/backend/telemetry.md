# 遥测（PostHog）

匿名产品分析：仅上报应用版本与设备级信息，用于版本采用率、平台分布、会话时长统计。代码在 `src-tauri/src/core/telemetry/`，仅桌面端编译。

## 开关语义

三层门控，任一不满足即整体 no-op：

1. **编译期**：构建时环境变量 `AGENTERO_POSTHOG_KEY` 注入 PostHog Project API Key；未设置（或为空）时功能完全禁用——本地 / 开源构建默认不上报。
   - Key 来源（`build.rs` 的 `forward_posthog_key()`）：显式环境变量优先；否则回退读仓库根 `.env`（gitignored）。
   - 官方发布：`release.yml` 的 tauri-action 步骤从 GitHub Secret `POSTHOG_KEY` 注入；secret 缺失时为空串，遥测编译为 no-op。
   - Ingestion host 使用 posthog-rs 默认 `https://us.i.posthog.com`（US 项目）；换 EU / 自建需改用 `ClientOptionsBuilder().host(...)`。
2. **构建类型**：debug 构建（`cfg!(debug_assertions)`，含 `pnpm tauri dev`）不上报，避免开发数据污染。
3. **用户设置**：`AppSettings.telemetry_enabled`（前端 `telemetryEnabled`，默认 `true`），在 设置 → 通用 → 隐私 中关闭，**下次启动生效**。这是唯一的上报开关——本地活动记录（[usage.md](usage.md)）已无独立开关，始终写盘，仅上报受本开关约束。

## 事件与字段

`distinct_id` 为持久化在 XDG 配置目录 `telemetry_id` 文件中的随机 UUID（`install_id()`），不含任何身份信息。

### `app started`（启动时，setup 后 spawn_blocking 发送）

| 属性 | 来源 |
|---|---|
| `app_version` | `env!("CARGO_PKG_VERSION")` |
| `os_name` / `os_version` | `os_info` |
| `arch` | `std::env::consts::ARCH` |
| `device_model` | macOS `sysctl hw.model` / Linux DMI / Windows 注册表（best-effort，可空） |
| `locale` | `AppSettings.locale` |
| `timezone` | 本地 UTC 偏移（如 `+08:00`） |
| `tauri_version` | `tauri::VERSION` |
| `installed_agents` | 已注册 Agent 的 template id 数组（如 `["claude-acp","gemini"]`，排序去重；`AgentRegistry::telemetry_summary()`，只读注册表、无 PATH 探测） |
| `custom_agent_count` | 已注册的自定义 Agent 数量（不含名称/命令） |
| `$session_id` | 本次运行生成的 UUID（PostHog 保留属性，Sessions 口径依赖它） |

Person 属性：`$set` → `app_version` / `os_name` / `os_version` / `arch` / `device_model` / `installed_agents` / `custom_agent_count`；`$set_once` → `first_app_version`。`installed_agents` 随每次启动更新，可直接在 PostHog 按 Agent 过滤 / 分群。

### `app exited`（`RunEvent::Exit` 回调中发送并 flush）

`$session_id`、`session_duration_ms`、`app_version`。

`app started` / `app exited` 与本机 [usage.md](usage.md) 同源：`Telemetry::start` / `shutdown` **始终**写入本地 `app.started` / `app.exited`（本地记录无开关），在 `telemetryEnabled` 且 release + 有 key 时再发 PostHog。出站事件名保持空格形式，以免断历史。

### 行为事件投影（`Telemetry::capture_activity`）

前端行为事件经 `activity_record_events` 落本地库后，Host 用 `usage::telemetry_projection` 把**登记的 kind** 投影成脱敏 PostHog 事件（非移动端；`telemetryEnabled` 关或无 key 时整体 no-op）。投影**只**携带 `kind`→事件名、`facet` / `status` / `qty`（均由 `usage/record.rs::project_extra` 分桶/截断/白名单产出）与分桶后的 `dur_bucket`，外加 `distinct_id` / `$session_id` / `app_version`。未登记的 kind 一律不发（安全默认）。

| kind | 事件名 | 出站属性 |
|---|---|---|
| `paper.open` / `note.open` | `paper_opened` / `note_opened` | `facet`(mode) |
| `paper.session` | `paper_session` | `dur_bucket`（仅 ≥10s） |
| `asset.download` | `asset_downloaded` | `facet`(asset/pdf/tex) |
| `paper.import` | `paper_imported` | `facet`(source 桶) |
| `search.query` | `search_performed` | `qty`(hits)，**无检索词** |
| `agent.run` | `agent_run` | `facet`(workflow) |
| `skill.install` | `skill_installed` | `facet`(sourceKind)、`qty`(count)，**无 skill 名** |
| `paper.tag` | `paper_tagged` | `facet`(op)、`qty`(tagCount) |
| `paper.read` | `paper_read_set` | `facet`(via/isRead) |
| `vault.open` | `vault_opened` | —（无 path） |
| `onboarding.complete` | `onboarding_completed` | — |

不投影：`paper.focus` / `paper.blur`、`paper.edit-meta`，以及尚未接线的 kind。

**DAU 口径**：不设心跳事件。DAU = 当天产生任意上述行为事件或 `app started` 的 unique `distinct_id`。桌面常驻应用只要当天有真实操作即计入；完全零操作的一天不计（可接受）。

**Sessions 口径**：出站事件统一携带 PostHog 保留属性 `$session_id`（每次启动生成的新 UUID，随所有事件发送），PostHog 的 Sessions insight / Trends "Sessions" 指标据此聚合。本地 usage 库的 extra 字段仍为 `session_id`，两者互不影响。

## 隐私边界

- 不含 Vault 路径、文件名、论文标题、DOI、检索词原文、划词/译文/批注正文、Skill URL/名称。
- Agent 只上报已知 template id（如 `claude-acp`）与自定义 Agent 的数量；不含 Agent 名称、命令、参数、env 等配置。
- 上报失败只记日志，绝不影响启动与退出。
- 使用 `posthog-rs` blocking client：`capture()` 非阻塞（后台批量发送），退出回调中同步 `flush()`。
