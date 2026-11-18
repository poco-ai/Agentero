# 遥测（PostHog）

匿名产品分析：仅上报应用版本与设备级信息，用于版本采用率、平台分布、会话时长统计。代码在 `src-tauri/src/core/telemetry/`，仅桌面端编译。启动载荷由 app 层组装为 `TelemetryStartContext`（settings 快照 + `AgentRegistry::telemetry_summary()` 匿名摘要）注入 `Telemetry::start`，`core::telemetry` 不反向依赖 features 层。

## 开关语义

三层门控，任一不满足即整体 no-op：

1. **编译期**：构建时环境变量 `AGENTERO_POSTHOG_KEY` 注入 PostHog Project API Key；未设置（或为空）时功能完全禁用——本地 / 开源构建默认不上报。
   - Key 来源（`build.rs` 的 `forward_build_env()`，同时转发 `AGENTERO_BUILTIN_*`，见 [builtin-provider.md](builtin-provider.md)）：显式环境变量优先；否则回退读仓库根 `.env`（gitignored）。
   - 官方发布：`release.yml` 的 tauri-action 步骤从 GitHub Secret `POSTHOG_KEY` 注入；secret 缺失时为空串，遥测编译为 no-op。
   - Ingestion host 使用 posthog-rs 默认 `https://us.i.posthog.com`（US 项目）；换 EU / 自建需改用 `ClientOptionsBuilder().host(...)`。
2. **构建类型**：debug 构建（`cfg!(debug_assertions)`，含 `pnpm tauri dev`）不上报，避免开发数据污染。
3. **用户设置**：`AppSettings.telemetry_enabled`（前端 `telemetryEnabled`，默认 `true`），在 设置 → 通用 → 隐私 中关闭，**下次启动生效**。这是唯一的上报开关——本地活动记录（[usage.md](usage.md)）已无独立开关，始终写盘，仅上报受本开关约束。应用内反馈不走这三层门控，见下一节。

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
| `installed_agents` | 已注册 Agent 的 template id 数组（如 `["claude-acp","pi"]`，排序去重；`AgentRegistry::telemetry_summary()`，只读注册表、无 PATH 探测） |
| `custom_agent_count` | 已注册的自定义 Agent 数量（不含名称/命令） |
| `$session_id` | 本次运行生成的 UUID（PostHog 保留属性，Sessions 口径依赖它） |

> Windows 的 `device_model` 走 `reg query`，该子进程必须带 `CREATE_NO_WINDOW`。发布版是 GUI 子系统二进制，缺这个 flag 时 Windows 会为它分配可见控制台窗口，表现为每次启动都在首帧前闪一下黑窗（`app started` 在 setup 后 `spawn_blocking` 发送，与窗口首帧时间上重叠）。

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
| `agent.usage` | `agent_usage` | `facet`(workflow)、`token_bucket`（`<1k` / `1-10k` / `10-100k` / `100k+`），无精确 token |
| `activity.view` | `activity_viewed` | — |
| `skill.install` | `skill_installed` | `facet`(sourceKind)、`qty`(count)，**无 skill 名** |
| `paper.tag` | `paper_tagged` | `facet`(op)、`qty`(tagCount) |
| `paper.read` | `paper_read_set` | `facet`(via/isRead) |
| `vault.open` | `vault_opened` | —（无 path） |
| `onboarding.complete` | `onboarding_completed` | — |

不投影：`paper.focus` / `paper.blur`、`paper.edit-meta`，以及尚未接线的 kind。

**DAU 口径**：不设心跳事件。DAU = 当天产生任意上述行为事件或 `app started` 的 unique `distinct_id`。桌面常驻应用只要当天有真实操作即计入；完全零操作的一天不计（可接受）。

**Sessions 口径**：出站事件统一携带 PostHog 保留属性 `$session_id`（每次启动生成的新 UUID，随所有事件发送），PostHog 的 Sessions insight / Trends "Sessions" 指标据此聚合。本地 usage 库的 extra 字段仍为 `session_id`，两者互不影响。

## 应用内反馈

设置 → 关于里的「反馈」是用户主动提交，和上面的匿名遥测分开。

- **何时发送**：点发送就发。debug 构建（含 `pnpm tauri dev`）和关闭 `telemetryEnabled` 都会发送。没有编译进 `AGENTERO_POSTHOG_KEY` 的构建不发送，关于页仍显示入口，提交时提示当前版本无法发送。
- **内容**：用户选择的类型（`bug` / `idea`）、描述、可选邮箱，外加 `app_version` / `os_name` / `os_version` / `arch` / `locale`。不附带 Vault 路径、文件名、论文标题或日志。描述最长 4000 字，邮箱最长 200 且不能换行。`distinct_id` 仍用 `telemetry_id`。
- **落到哪里**：四个问卷 id 都编译进去时，事件名是 `survey sent`，出现在 PostHog Surveys。缺任何一个时，事件名是 `feedback submitted`，在 Activity 里按这个名字筛选。后一种计入产品分析的每月事件额度，前一种计入 Surveys 的每月回复额度。
- **问卷 id**（都可选，空串等同未设置）：`AGENTERO_POSTHOG_SURVEY_ID`、`AGENTERO_POSTHOG_SURVEY_KIND_ID`、`AGENTERO_POSTHOG_SURVEY_MESSAGE_ID`、`AGENTERO_POSTHOG_SURVEY_CONTACT_ID`。和 key 一样经 `build.rs` 转发，本地可写在仓库根 `.env`。官方发布从 GitHub Secret `POSTHOG_SURVEY_ID` / `POSTHOG_SURVEY_KIND_ID` / `POSTHOG_SURVEY_MESSAGE_ID` / `POSTHOG_SURVEY_CONTACT_ID` 注入；secret 缺失时构建照常，反馈走 `feedback submitted`。

在 PostHog 建一份 **API** 问卷（关掉 partial responses），题目按这个顺序：

1. 单选，选项必须正好是 `bug` 和 `idea`
2. 开放题，对应描述
3. 可选开放题，对应邮箱

把问卷 id 和三道题的 id 填进上面四个变量后重新构建。Host 随事件带上的题目标题是 `Kind` / `Message` / `Contact`，归并按题目 id，不按标题。

## 隐私边界

- 不含 Vault 路径、文件名、论文标题、DOI、检索词原文、划词/译文/批注正文、Skill URL/名称。
- Agent 只上报已知 template id（如 `claude-acp`）与自定义 Agent 的数量；不含 Agent 名称、命令、参数、env 等配置。
- 上报失败只记日志，绝不影响启动与退出。
- 使用 `posthog-rs` blocking client：`capture()` 非阻塞（后台批量发送），退出回调中同步 `flush()`。
