# 使用记录、Memory 与产品分析

> 状态：**P0 存储已落地**（XDG `usage.sqlite` schema v2 + `track()` + CLI `usage`），漏斗与画像仍按本文推进。关联 [\#239](https://github.com/poco-ai/Agentero/issues/239)。实现契约见 [`../backend/usage.md`](../backend/usage.md)。
> 相关：[`../backend/catalog.md`](../backend/catalog.md)、[`../backend/agent.md`](../backend/agent.md)、[`../backend/telemetry.md`](../backend/telemetry.md)、[`../backend/translate.md`](../backend/translate.md)、[`../backend/skill-import.md`](../backend/skill-import.md)、[`../frontend/pdf.md`](../frontend/pdf.md)、[`../frontend/pdf-layout-analysis.md`](../frontend/pdf-layout-analysis.md)、[`plaza.md`](plaza.md)

## 1. 目标与非目标

Issue 三条诉求 + 产品分析，落在同一条 Activity 总线上：

| # | 诉求 | 本文对应 |
|---|---|---|
| 1 | 记录浏览 / 下载 / 阅读，以及翻译、版面、Skill、批注等操作 | §3 事件模型 + §4 存储 |
| 2 | 让 Agent 拿到用户操作习惯 | §5 Memory + §6 Agent 接入 |
| 3 | 基于额外 context 做总结、推荐 | §7 上层功能 |
| 4 | 部分行为投影到 PostHog | §3.4 Registry + §8 隐私 |

**目标**

- 本地记录**用户意图动作**的时间线（何时、对哪篇、用什么方式），形成可查询画像。
- BYOA Agent 以「被动注入 + 主动查询」获得习惯 context。
- 同一条事件按白名单投影到 PostHog，做功能采用率，不含论文身份与正文。
- 在画像之上提供继续阅读 / 周回顾 / 库内推荐。

**非目标（首版）**

- 不做 embedding / 向量库。
- 不把检索词、论文标题、划词原文、译文、批注正文、Skill 仓库 URL 发给 PostHog。
- 不跨设备同步使用记录。
- 不自动抽取 ChatGPT 式「记忆短句」（P3 需用户确认）。
- 不记录纯 UI 噪音（缩放、大纲展开、滚动、命令面板打开）。

## 2. 现状盘点

| 能力 | 现状 | 复用方式 |
|---|---|---|
| PostHog | `core/telemetry`：仅 `app started` / `app exited`；无私有 `capture()` | 扩 `Telemetry::capture`，业务禁止直连 |
| Catalog SQLite | `SCHEMA_VERSION` + 迁移；`is_read` / `added_at`；无 opened_at | 复用迁移范式；不共用库 |
| 阅读产物 | `marks/`、`reading-heatmap`、`reading-position` | 空间分布仍派生；**动作时间线另记事件** |
| 翻译 | `runTranslate` + 划词 mark + `layout-translate.json` | 在消费方记 1 次会话，不在每块 MT 调用上打点 |
| 版面 | `enqueuePaperLayoutAnalysis` / `run-analysis`；sidecar 可重建 | 只记真实分析，跳过 cache hit 静默载入 |
| Skill 导入 | `lookup_import_batch` → `confirmSkillImport` → `skill_install` | 确认安装后记一条 |
| 批注 | 高亮走 `annotations.json`；ask/translate/visual 走 `marks/<id>.json` | 在用户提交处打点，不在防抖导出处 |
| 已有 recents | `@` MRU、最近 Vault、`reading-position` | 首版并存 |
| Agent 上下文 | `agentPersonalPrompt` + `AGENTS.md` + 会话 chip | 无习惯 Memory；见 §5 |

## 3. 事件模型

### 3.1 原则：记动作，不记内容

旧草案「能从产物派生的一律不记」对**空间热力**仍然成立，但对 **Memory / 产品分析** 不够：

| 产物能回答 | 产物答不好 |
|---|---|
| 这篇有没有高亮、译过哪一段 | 何时开始密集翻译、用哪个 provider |
| `layout.json` 是否存在 | 是入库自动跑的还是用户点了「重新分析」 |
| `.agents/skills/pptx` 在不在 | 什么时候从 GitHub 装的、装了几个 |
| `is_read` | 是人点的还是 paper-reader 写的 |

因此：

1. **事件 = 用户意图动作的时间线**（kind + 类别字段 + 可选 path）。
2. **不把动作内容写入事件**（划词原文、译文、批注正文、检索词对 PostHog 禁用；本地仅 `search.query` 保留 `q`）。
3. **空间分布继续从产物派生**（`reading-heatmap`）。删掉一条高亮不会改写历史事件——「用过这个功能」仍在。
4. **自动后台任务要降噪**：版面 cache hit、全文翻译的逐 region `runTranslate`、EmbedPDF 标注防抖回写，都不单独成事件。

### 3.2 统一总线

```text
UI / Host 动作
      │
      ▼
 track(kind, payload)          ← 唯一入口
      │
      ▼
 Event Registry                ← 本地 schema + PostHog 投影白名单
      │
      ├──────────────┬─────────────────┐
      ▼              ▼                 ▼
 LocalSink      TelemetrySink     UsageProfile
 usage.sqlite   PostHog 投影      Agent / 继续阅读
```

前端缓冲：5s / window blur / beforeunload / 满 50 条 → `activity_record_events`。同一 `(kind, path, mode)` 1s 去重。Host 一事务写本地（schema v2）。`app.started` / `app.exited` 由 `Telemetry::start` / `shutdown` 直写本地，不走 `track()`。其它 kind 的 PostHog 投影（`Telemetry::capture_activity`）**已接线**：写本地前按白名单脱敏转发。

业务代码禁止直接 `posthog_rs::Event` 或手写 `INSERT usage_events`。

### 3.3 事件表

#### A. 阅读与库（#239 原范围）

| `kind` | 本地载荷 | PostHog | 漏斗 |
|---|---|---|---|
| `paper.open` / `note.open` | `path`, `mode` | `paper_opened` / `note_opened`：`mode` | `openTab` |
| `paper.focus` / `paper.blur` | `path`, `dur_ms` | **不上报** | `handleActivePanelChange` / `closeTab` |
| `paper.session` | `path`, `dur_ms` | `paper_session`：`dur_bucket`（仅 ≥10s） | blur 结算 |
| `asset.download` | `path`, `asset` | `asset_downloaded`：`asset` | `downloadPaperAssetsAction` |
| `paper.import` | `path`, `source` | `paper_imported`：`source` | 入库 action |
| `search.query` | `q`, `hits` | `search_performed`：`hits_bucket`（无 `q`） | `vault/search.ts` |
| `agent.run` | `workflow`, `path?` | `agent_run`：`workflow` | `runOnce` |

停留用 focus/blur 配对。单段上限 30min；window blur 立刻结算。

#### B. 翻译

`runTranslate` 是执行引擎，**不是**埋点漏斗：版面全文翻译会对每个 region 调一次，若在此处打点会爆炸。

| `kind` | 本地载荷 | PostHog | 漏斗 |
|---|---|---|---|
| `translate.selection` | `path`, `provider`, `target_lang`, `chars`, `auto` | `translate_ran`：`surface=selection`, `provider_family`, `target_lang`, `chars_bucket` | `use-pdf-selection-translate` 一次划词结束 |
| `translate.layout` | `path`, `scope`(doc\|page), `provider`, `target_lang`, `region_count`, `ok_count` | `translate_ran`：`surface=layout`, `scope`, `provider_family`, `target_lang`, `region_bucket` | `use-pdf-layout-translate` **整次** doc/page 任务结束（不是每块） |

- `provider_family`：`free` / `commercial` / `agent`。本地可存具体 `provider` id（`deepl` / `tencent`…）；PostHog 只传 family，避免把商用配置当画像。
- 不记原文、译文。
- `auto=true` 仅当「划词自动翻译」触发；手动点菜单为 `false`。
- 停止 / 清除覆盖层不记成功事件；可记 `translate.layout` + `ok_count` 反映部分完成。

#### C. 版面分析

| `kind` | 本地载荷 | PostHog | 漏斗 |
|---|---|---|---|
| `layout.analyze` | `path`, `trigger`(import\|open\|manual), `backend`(onnx\|paddle\|mineru), `cache`(miss\|force), `region_count`, `dur_ms` | `layout_analyzed`：`trigger`, `backend`, `cache`, `dur_bucket` | `run-analysis` / headless executor **实际跑模型成功后** |

**跳过**：sidecar cache hit 的静默 JSON→侧栏（打开论文时的常态）。那不是用户动作，会淹没画像。

用户点 Figures「分析 / 重新分析」：

- 有 sidecar 且非 force → 只是再归并，**不记**（与打开时相同）。
- 无缓存或内部 `force` → 记 `cache=miss|force`。

#### D. Skill 导入

| `kind` | 本地载荷 | PostHog | 漏斗 |
|---|---|---|---|
| `skill.install` | `skill_id[]`, `source_kind`(github\|npx\|skills_sh), `installed`, `skipped` | `skill_installed`：`source_kind`, `count_bucket` | `confirmSkillImport` 任务成功 |

- 一次确认装多个 → **一条**事件，带数量。
- 本地可存 `skill_id`（给 Agent：「你装过 pptx」）。
- PostHog **不传** owner/repo、URL、skill 名。
- 仅发现、用户取消 → 不记。远程 Vault 禁用安装，无事件。

#### E. 批注 / 划词产物

| `kind` | 本地载荷 | PostHog | 漏斗 |
|---|---|---|---|
| `mark.create` | `path`, `type`(highlight\|comment\|ask\|translate\|visual), `source`(selection\|region\|formula), `page?` | `mark_created`：`type`, `source` | 见下 |
| `mark.update` | `path`, `type` | 不上报（编辑备注噪音） | 改 comment / 续写 ask |
| `mark.delete` | `path`, `type` | `mark_deleted`：`type` | 删除 pin / 高亮 |

**漏斗必须在用户提交，禁止挂在防抖导出上：**

| type | 写入 | 打点处 |
|---|---|---|
| `highlight` / `comment` | `marks/annotations.json`（`saveAnnotationItems` 会整表回写） | 划词菜单「高亮 / 批注」确认、批注编辑器首次保存；对 annotations 做 **id diff**，只对新增 id 打 `create` |
| `ask` | `marks/<id>.json` | 划词「提问」提交，或选区 chip **发送后**落盘对话卡（与现有 ask 卡同一路径） |
| `translate`（划词卡） | `marks/<id>.json` | 与 `translate.selection` **成对**：一次划词既有翻译会话，也有 mark 落盘。允许两条，kind 不同 |
| `visual` | `marks/<id>.json` + `assets/` | 视觉批注编辑器「保存」；仅草稿不记 |

`ask` / 带 Agent 的 `visual` 另外会走 `agent.run`。两条都记：一条是「做了批注」，一条是「叫了 Agent」。

不记：quote、comment 正文、裁剪图、公式符号表内容。

#### F. 其它高信号动作（「等」的首版清单）

只收**有明确漏斗、对习惯或采用率有用**的。滚动 / 缩放 / 大纲 / 命令面板开合排除。

| `kind` | 本地载荷 | PostHog | 漏斗 |
|---|---|---|---|
| `paper.tag` | `path`, `op`(set\|add\|rm), `tags?` | `paper_tagged`：`op`, `tag_count_bucket` | `paper_set_tags` 前端 action |
| `paper.read` | `path`, `is_read`, `via`(user\|paper_reader) | `paper_read_set`：`is_read`, `via` | `paper_set_is_read` |
| `refs.parse` | `path`, `trigger`(auto\|manual) | `refs_parsed`：`trigger` | `paper_refs_parse` 成功 |
| `refs.import` | `path`（目标论文） | `refs_imported` | References 卡「入库」 |
| `zotero.save` | `count` | `zotero_saved`：`count_bucket` | Connector `saveItems` 提交成功 |
| `vault.open` | （无 path 出站） | `vault_opened` | 打开 / 切换 Vault |
| `onboarding.complete` | — | `onboarding_completed` | 向导最后一步 |

标签名可进本地（喂 `tagAffinity`）；PostHog 只传操作类型与数量桶。

### 3.4 Registry 形状

```ts
'translate.selection': {
  local: { path: 'string', provider: 'string', target_lang: 'string', chars: 'number', auto: 'boolean' },
  posthog: {
    name: 'translate_ran',
    props: ['surface', 'provider_family', 'target_lang', 'chars_bucket'],
    map: { surface: () => 'selection', provider_family: fromProvider, chars_bucket: bucketChars },
  },
},
'layout.analyze': {
  local: { path: 'string', trigger: 'import'|'open'|'manual', backend: 'onnx'|'paddle'|'mineru', cache: 'miss'|'force', region_count: 'number', dur_ms: 'number' },
  posthog: { name: 'layout_analyzed', props: ['trigger', 'backend', 'cache', 'dur_bucket'] },
},
```

没登记的 kind 不能发出。新增事件先改 Registry，再在漏斗调用 `track()`。

### 3.5 候选事件（未纳入 P0）

首版故意不收下面这些。按「值 / 噪音 / 隐私」分成三档，需要时再进 Registry。

#### 建议下一波（P1，对 Memory 或采用率都有用）

| `kind` | 为什么值得 | 漏斗 | PostHog 投影 |
|---|---|---|---|
| `library.export` / `library.import` | 文献工作流是否闭环 | `exportLibraryToFile` / `importLibraryFromFile` | `format`（bibtex/ris/…）、`count_bucket` |
| `library.rescan` | Doctor/盘漂是否被用 | `rescanLibraryPapers` | `added_bucket` |
| `paper.parse` | liteparse 是否在补正文 | `enqueuePaperPdfParse` **成功写出 PAPER.md**（跳过 cache） | `trigger`(import\|manual) |
| `paper.reader` | 精读触发面 | `runPaperReaderWorkflow` 开始；与 `agent.run`+`paper.read` 互补 | `via`(zap\|auto) |
| `skill.use` | 装了不等于用了 | Composer 提交时 `skillIds` | `count_bucket`（无 skill 名出站） |
| `agent.session` | 续聊 vs 新开 | 新建草稿 / `loadSession` | `op`(new\|load\|cancel) |
| `agent.fail` | 产品质量 | `agent:failed` | `workflow`（无错误正文） |
| `note.export` | 笔记离开应用 | Markdown 导出 PDF/PNG | `format` |
| `note.format` | 编辑习惯 | 右键「整理 Markdown」 | 仅计数 |
| `wiki.follow` | 双链是否在被走 | `navigateWiki` | 不上报 path |
| `refs.graph.click` | 引用图是否驱动打开 | Graph 节点点击 | `node`(paper\|stub) |
| `zotero.sync` | 双向同步采用 | `zotero_sync` 成功 | `direction`/`count_bucket` |
| `zotero.migrate` | 欢迎页迁移 | `migrateZoteroFromWelcome` | `count_bucket` |
| `vault.create` | 激活漏斗 | `vault_create` | 仅计数 |
| `command.run` | 哪些命令真有人用 | 命令面板 `run()` | `command_id`（稳定 id，如 `settings.open`） |
| `doctor.run` / `doctor.fix` | 诊断是否被用 | Doctor pane | `section`（alias\|wiki\|visual） |
| `update.install` | 版本采纳 | 关于页「安装并重启」 | `from_version` 已在 person |

`skill.use` 对 Memory 比 `skill.install` 更重要：画像应说「常用 pptx」，而不是「曾经装过」。

#### 可后置（有信号，但漏斗散或和已有事件重叠）

| `kind` | 备注 |
|---|---|
| `import.fail` | 魔棒失败原因类别（识别失败 / 超时 / 限流），无 URL |
| `asset.download.fail` | 与成功对称，看补下健康度 |
| `search.surface` | 把 `search.query` 拆成 palette / library / vault；首版一个 kind 即可 |
| `library.scope` | 进入文件夹作用域；弱信号 |
| `file.create` / `file.rename` / `file.move` / `file.trash` / `file.restore` | 组织习惯；和 `paper.import`/`paper.tag` 部分重叠 |
| `workspace.split` / `note.split` | 分屏是否为核心读法 |
| `window.new` | 多窗采用 |
| `pdf.find` | ⌘F；采用率有用，对 Memory 弱 |
| `pdf.outline` / `pdf.immersive` / `pdf.page_theme` | 阅读 chrome |
| `citation.goto` | 文中引用跳页 / 外链 |
| `layout.figure.focus` | 侧栏点开图/表 |
| `agent.permission` | ask 模式回应；`option_kind` |
| `agent.ask_user` | 结构化问卷提交/取消 |
| `agent.model` / `agent.mode` | 换模型、Plan/Default；出站只传是否第三方，不传 model id |
| `agent.context` | `@` / 选区固定 / 图片附件；易噪，应用「每轮发送时汇总」而不是每次点 chip |
| `agent.install` | 设置页安装/升级/卸载 CLI | `op` + `template` |
| `settings.change` | 只传 **allowlist 键名**（`telemetryEnabled`、`uiTheme`、`translate.provider`…），永不传值 |
| `onboarding.step` | 比只记 complete 更能看流失；P0 有 complete 即可 |
| `remote.open` / `bridge.pair` | 远程 / iOS 采用；移动端本身无 PostHog |
| `cli.invoke` | `agentero` 子命令名；看 Agent 是否真走 CLI |

#### 明确不记

| 动作 | 原因 |
|---|---|
| 滚动、缩放、翻页、大纲展开 | 高频、无意图 |
| 命令面板 / 设置窗 **打开** | 打开 ≠ 使用 |
| Markdown 自动保存、每次按键 | 爆炸 |
| EmbedPDF 标注防抖导出、layout cache hit、逐 region `runTranslate` | 机器回声 |
| citation hover、公式 dwell 未点开 | 试探不是动作 |
| 剪贴板复制、Finder / 终端打开 | OS chrome |
| 错误 toast 原文、Agent 回复正文、检索词出站 | 隐私 |
| 主题预览 hover、列宽拖拽 | 无分析价值 |

判定口诀：**有明确提交/成功边界、一天不会上百次、对「习惯」或「这功能有没有人用」有增量** 才进 Registry。

## 4. 存储

### 4.1 `$XDG_DATA_HOME/agentero/usage.sqlite`

**P0 已落地。** 不放进 Vault、也不放进 `catalog.sqlite`：远程会镜像 catalog；使用记录是设备本地事实。一台机器上的多个 Vault 用 `vault` 列（绝对路径）区分。

路径、列定义与 `kind`↔`facet` 对照见 [`../backend/usage.md`](../backend/usage.md)（schema v1）。

```sql
usage_vaults    -- 本机 Vault 身份（path UNIQUE）
usage_events    -- append-only：ts, vault, kind, path, paper_path, mode, facet, status, dur_ms, qty, extra
usage_daily     -- PRIMARY KEY (day, vault, kind, paper_path, facet)
usage_memories  -- 声明式短句（P3 再写）
```

`paper_path` / `facet` / `qty` 由 Host 写入时从 path + extra 抽出，画像只读 `usage_daily`。WAL + `busy_timeout` + `foreign_keys`。

### 4.2 路径与忽略

- `paper_move` 成功后 `usage_rename_path`。
- 必须忽略：wiki / search / watcher（catalog 故意不忽略；usage 必须忽略）/ remote catalog 镜像。
- 保留期：事件 180 天；日聚合 2 年。`usage_clear()` + 设置页清除。

## 5. Memory

没有第四套「ChatGPT Memory」库。三层：

| 层 | 是什么 | 持久化 | 注入 |
|---|---|---|---|
| 情节 | `usage_events` | usage.sqlite | CLI 按需 |
| 语义 | `UsageProfile` | 由 daily 算出 | `build_prompt` |
| 声明 | `agentPersonalPrompt`（已有）+ 可选 `usage_memories` | settings / sqlite | 现有 preference 块 |
| 工作 | 当前论文 / `@` / 选区 | 会话 | 已有，不动 |

### 5.1 UsageProfile（≤800 tokens）

| 字段 | 算法 |
|---|---|
| `topPapers` | `Σ dur_ms × 0.5^(age/14)` Top 8 + title/tags |
| `continueReading` | 未读 + 有 `reading-position`，按最后 focus |
| `stalled` | 已下载未 open，或 focus < 60s 且 ≥7 天未碰 |
| `tagAffinity` | catalog tags + 本地 `paper.tag` 事件 |
| `rhythm` | 3h 桶、日均、本周 vs 上周 |
| `agentUsage` | workflow 次数 |
| `toolAffinity` | **新增**：翻译 / 版面 / 批注 / Skill 的频次与近况 |

`toolAffinity` 示例：

```json
{
  "translate": { "selection": 24, "layout": 3, "providerFamily": "free", "targetLang": "zh-CN" },
  "layout": { "analyzed": 11, "manual": 2, "backend": "onnx" },
  "marks": { "highlight": 40, "comment": 8, "ask": 12, "visual": 6, "translate": 20 },
  "skills": { "installed": ["pptx", "frontend-design"], "lastAt": "2026-08-10" }
}
```

半衰期 14 天。超出 800 tokens 先截 `topPapers`，再截 `skills.installed`。

### 5.2 注入语气

画像是**观察，不是指令**。`agentPersonalPrompt` 仍是「必须遵守」。

```
<user_usage_profile>
近 30 天：日均 42min，活跃 21:00-24:00。
主要方向：diffusion 38% · 3D 22%
在读：[[Flow Matching]]（p12/24，2 天前）
工具：划词翻译较多（免费 MT → zh-CN）；视觉批注 6；提问 12
已装 Skill：pptx、frontend-design
搁置：[[NeRF Survey]]（下载 12 天未打开）
</user_usage_profile>
```

| workflow | 注入 |
|---|---|
| `summary` / `qa` / `free` / `related_work` | 是 |
| `paper_reader` | 否（忠于原文） |
| ACP slash（`isAcpCommand`） | 否（本就跳过 envelope） |

细节走 CLI，不塞 prompt。已落地：

```bash
agentero usage which --json
agentero usage summary --days 30 --json
agentero usage timeline --path papers/xxx --json
```

`usage top` / `usage tools` 仍是规划，画像未做前先用 `timeline` + `summary`。

### 5.3 声明式记忆（P3）

周回顾 skill **提议**短句 → 设置页确认 → `usage_memories`。不自动写入。可删。关本地开关则不注入。

## 6. Agent 接入

与 §5.2 相同：`prompts.rs::build_prompt` 在 `personal_preference_directive` 旁加可选块；Host 在组装时读 Profile（不要让前端把画像塞进 `personalPrompt`）。

内置 skill `templates/vault/.agents/skills/usage-reviewer/SKILL.md`（`version: 1`）：何时用 CLI、周回顾写 `notes/Reviews/YYYY-WW.md`、推荐必须给「因为你在读 X」、不改用户手写笔记。

## 7. 上层功能

- **继续阅读**：Library 顶栏 `continueReading` 前 3 + `stalled` 前 2。
- **周回顾**：手动触发，不自动跑 Agent。
- **库内推荐 v0**：双链邻居 ∪ 同标签未读 ∪ 已入库参考文献；plaza 管库外。

## 8. 隐私与开关

| 开关 | 默认 | 含义 |
|---|---|---|
| `telemetryEnabled` | true（已有） | 投影行为事件到 PostHog（下次启动生效） |

本地记录始终开启、无开关：行为事件恒写 `usage.sqlite`（生成画像、注入 Agent、供 CLI 查询）。是否上报 PostHog 由 `telemetryEnabled` 单独控制；关闭后本地照常记录，仅停止投影。可一键清除本地记录。`Telemetry::capture_activity` 投影**已接线**。

PostHog 硬约束：无路径、标题、paper id、DOI、检索词、划词/译文/批注正文、Skill URL/名称、Vault 路径。已有 `app started` / `app exited` 保留；新事件用 `object_verb`。

设置 → 隐私：`telemetryEnabled` 开关 +「清除使用记录」；文案写明本地检索词与 Skill id 不出站。

iOS / TestFlight 仍无遥测。debug / 无 key 构建不上报。

## 9. 分期

| 阶段 | 内容 | 可验证 |
|---|---|---|
| **P0** | Registry + `track()` + usage.sqlite v2 + 双开关 + CLI `usage which\|timeline\|summary\|clear` | **已落地**（漏斗见 [usage.md](../backend/usage.md)「前端漏斗」；翻译 / 版面 / 批注尚未接线） |
| **P0 余** | 补翻译 / 版面 / 批注漏斗；`Telemetry::capture_activity` 投影 | 已接线行为事件投影（[telemetry.md](../backend/telemetry.md) 映射表）；关 `telemetryEnabled` 停投影但本地照记；cache hit 与逐 region 翻译不刷屏；翻译 / 版面 / 批注漏斗仍待接线 |
| **P1** | Profile（含 `toolAffinity`）+ 继续阅读 | 顶栏能跳对页 |
| **P2** | `build_prompt` 注入（CLI 查询面已有） | 问答能提到工具习惯；关本地后注入消失 |
| **P3** | usage-reviewer、周回顾、推荐、可选 memories | `Reviews/YYYY-WW.md` |

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 漏斗挂错层（`runTranslate` / `saveAnnotationItems`）导致事件爆炸 | 消费方打点；高亮用 id diff；layout 跳过 cache hit |
| 翻译双记（`translate.selection` + `mark.create`） | 允许，语义不同；Profile 分别统计 |
| 用户觉得被监视 | 双开关 + 清除 + 文档写明本地 / 出站边界 |
| prompt 被工具习惯撑爆 | 800 token 硬顶；Skill 列表截断 |
| usage.sqlite 触发 watcher | §4.2 忽略列表逐项确认 |
| 与 heatmap 重复 | heatmap 继续只读产物；事件不存坐标 |

## 11. 文档落点

- 本文（草案）：`docs/development/usage-analytics.md`
- 实现后：`docs/backend/usage.md` + 同步 `telemetry.md` / `data-model.md` / `agent.md` / `cli.md` / `remote.md` / `library.md` / `roadmap.md` + `todo.md`
