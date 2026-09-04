# 使用记录（XDG usage.sqlite）

设备本地活动日志：打开论文、下载、入库、搜索、Agent、翻译等。**不在 Vault 内**，不随远程 catalog 镜像，也不进文件监听。

## 位置

`$XDG_DATA_HOME/agentero/usage.sqlite`

| 平台 | 未设 env 时的默认 |
|---|---|
| macOS / Linux | `~/.local/share/agentero/usage.sqlite` |
| Windows | `%APPDATA%\agentero\usage.sqlite`（`dirs::data_dir`） |

代码：`src-tauri/src/core/usage/`。前端入口 `src/lib/activity/track.ts`（`track()` 缓冲批量上报）。

## 开关

本地活动记录**始终开启**、无独立开关：`activity_record_events` 无条件写库。是否投影到 PostHog 由 `telemetryEnabled` 单独控制（见 [telemetry.md](telemetry.md)）。

设置页可一键清除全部记录。

## 数据模型（schema v1）

四张表，职责分开。WAL + `busy_timeout` + `foreign_keys`。

```text
usage_vaults     本机见过的 Vault（按绝对路径去重）
usage_events     情节：append-only 原始动作
usage_daily      语义：按日聚合，给 Profile / Memory 用
usage_memories   声明：用户确认过的短句（P3，先建表不写）
```

查询约定：

| 问题 | 读哪张 |
|---|---|
| 这篇最近做了什么 | `usage_events` 按 `paper_path` / `path` |
| 近 30 天最投入的论文 | `usage_daily` `SUM(dur_ms)` group by `paper_path` |
| 翻译 / 批注 / Agent 习惯 | `usage_daily` group by `kind, facet` |
| 用户确认的偏好短句 | `usage_memories` |

### `usage_vaults`

| 列 | 含义 |
|---|---|
| `path` UNIQUE | 打开时的绝对路径 |
| `created_at` / `last_seen` | 首次 / 最近一条事件的 ts |

写入事件时 upsert。Vault 换盘路径后会变成新行；不跨设备合并。

### `usage_events`

一条用户意图动作。热路径字段升列，其余进 `extra`。

| 列 | 类型 | 含义 |
|---|---|---|
| `ts` | TEXT RFC3339 UTC | 发生时间 |
| `vault` | TEXT | 当时的 Vault 绝对路径（可空：引导完成等） |
| `kind` | TEXT | `domain.action`，见下 |
| `path` | TEXT | Vault 相对路径（打开的文件或论文夹） |
| `paper_path` | TEXT | **推导**：`papers/<id>/…` → `papers/<id>`，供「这篇论文」聚合 |
| `mode` | TEXT | 视图：`pdf` / `html` / `markdown` |
| `facet` | TEXT | **推导**：该 kind 下用来分组的类别（workflow、source、mark type…） |
| `status` | TEXT | `ok` / `fail` / `cancel`，缺省视为成功 |
| `dur_ms` | INTEGER | 停留 / 耗时 |
| `qty` | INTEGER | 数量：hits、region 数、tag 数、字数… |
| `extra` | TEXT JSON | 低频字段；可含本地检索词、skill id。**不**出站 |

`paper_path` / `facet` / `qty` / `status` 由 Host 在写入时从 `path` + `mode` + `extra` 抽出，调用方不必也不该自己填。

### `usage_daily`

与事件同一事务 upsert。画像只扫这张表。

```sql
PRIMARY KEY (day, vault, kind, paper_path, facet)
```

| 列 | 含义 |
|---|---|
| `day` | 本地日期 `YYYY-MM-DD`（取自 `ts` 前 10 位，UTC） |
| `paper_path` | 无论文时退回 `path`，再空则 `''` |
| `facet` | 无则 `''` |
| `count` / `dur_ms` / `qty` | 累加 |

### `usage_memories`

| 列 | 含义 |
|---|---|
| `text` | 短句 |
| `source` | `user` / `derived` |
| `enabled` | 关了不注入 |
| `vault` | 可空：全局偏好 |

首版不写入。周回顾 skill 提议、设置页确认后再用。

### `kind` 与 `facet` 对照

| `kind` | `facet` 来源 | `qty` 来源 | `extra` 可留 |
|---|---|---|---|
| `paper.open` / `note.open` | `mode` | — | — |
| `paper.focus` / `blur` / `session` | — | — | — |
| `paper.import` | `extra.source` | — | — |
| `asset.download` | `asset` 或 pdf/tex 布尔 | — | 资源旗标 |
| `search.query` | — | `hits` | **`q` 仅本地** |
| `agent.run` | `workflow` | `skillCount` | — |
| `translate.*` | `providerFamily` 或 `provider` | `chars` / `regionCount` | — |
| `layout.analyze` | `trigger` | `region_count` | `backend` |
| `skill.install` / `skill.use` | `sourceKind` | 安装个数 | `skill_id[]` 仅本地 |
| `mark.*` | `type`（highlight/comment/ask/…） | — | — |
| `paper.tag` | `op` | `tagCount` | 标签名仅本地 |
| `paper.read` | `via` 或 `isRead` | — | — |
| `refs.*` | `trigger` | — | — |
| `zotero.*` | `direction` / `source` | 条数 | — |
| `vault.open` / `onboarding.complete` | — | — | — |
| `app.started` / `app.exited` | `app_version` | 退出时 `dur_ms` = 会话时长 | 设备级字段；无 Vault 路径。与 PostHog `app started` / `app exited` 同源 |

内容载荷（划词原文、译文、批注正文、论文标题）**不入库**。

### 保留与改名

- 打开库时 prune：事件 180 天，日聚合 2 年。
- `paper_move` / `wiki_move` 成功后改写 `path` 与 `paper_path` 前缀。
- `usage_clear` 清事件 + 日聚合 + memories；指定 vault 时保留其它库。

## 命令

| Command | 说明 |
|---|---|
| `activity_record_events` | 批量写入（前端缓冲后调用） |
| `usage_list` | 按 vault / kind / path（含 paper_path）/ since 倒序列出 |
| `usage_summary` | 按 kind 计数 |
| `usage_clear` | 清空全部或指定 vault |

## CLI

```bash
agentero usage which --json
agentero usage timeline --days 30 --json
agentero usage summary --days 30 --json
agentero usage timeline --kind paper.open --path papers/xxx --json
agentero usage clear -y          # 当前 --vault
agentero usage clear --all -y    # 本机全部
```

未加 `--all-vaults` 时 timeline / summary 过滤当前 Vault。

## 前端漏斗

`track(kind, payload)` 是唯一入口。5s / 满 50 条 / 窗口 blur 刷新。同一 `(kind, path, mode)` 1s 去重。

已接线：`paper.open` / `note.open` / `paper.focus|blur|session`、`asset.download`、`paper.import`、`skill.install`、`search.query`、`agent.run`、`paper.tag`、`paper.read`、`vault.open`、`onboarding.complete`。  
`app.started` / `app.exited` 由 Host `Telemetry::start` / `shutdown` 写入，不走前端 `track()`。

翻译、版面、批注等其余 kind 已登记，漏斗按 [`../development/usage-analytics.md`](../development/usage-analytics.md) 继续接。

## 隐私

- 本地可含路径与搜索词；不上传。
- PostHog 仍只走 `core/telemetry` 的匿名启动/退出，本库不直接出站。投影只用 `kind` + `facet` + 桶，不用 `path` / `extra.q`。
