# 广场订阅（Feeds）— MVP

> 状态：**MVP 已落地**（2026-08-15）  

> 范围：广场下新增一个原生「订阅」面板；本地拉取 RSS / Atom / JSON Feed；论文条目一键入库。  
> 相关：[`plaza.md`](plaza.md)、[`../backend/settings.md`](../backend/settings.md)、[`../backend/identifier-lookup.md`](../backend/identifier-lookup.md)、[`../frontend/vault-tree.md`](../frontend/vault-tree.md)。

## 0. 产品结论

| # | 议题 | 结论 |
|---|---|---|
| Q1 | 和广场其它来源的关系 | **一个**子节点 `agentero:plaza/feeds`，原生 panel（与 Skill 推荐同型）。**不**给每条订阅挂侧栏子节点 |
| Q2 | 和 Folo / RSSHub | **不嵌、不打进包**。Folo 只参考交互；RSSHub / 邮件转 RSS 是用户自备的 URL |
| Q3 | 数据权威 | 订阅与条目缓存走 **XDG**，**不写** catalog、**不写** Vault。入库才进 catalog |
| Q4 | MVP 吃什么 | 用户粘贴的 **http(s) RSS / Atom / JSON Feed**。arXiv 分区给快捷芯片。X / Scholar / `@handle` **不做解析**，空态说明需先有 feed URL |
| Q5 | 呈现 | 轻双栏：左订阅、右时间线。两种卡片：论文卡（入库）/ 短讯卡（打开原文） |
| Q6 | 复用 | 不引第三方 RSS UI。壳抄 `PlazaSkillsView`，列表用已有 `useVirtualizer`，入库走 `importPlazaPaper` / 魔棒，HTML 走 `sanitizeEmbeddedHtml` |

## 1. 动机

广场已有「站点发现」（Cool Papers / ModelScope）和「静态精选」（Skill）。还缺一条 **用户自己的更新流**：别人的 RSS、自己的 Paper List、arXiv 分区日更。

订阅 = 发现流，Library = 已收藏。条目在订阅里浏览；只有点入库才变成论文单元。

四种常见来源在 MVP 里的诚实姿态：

| 用户想订 | MVP | 之后 |
|---|---|---|
| 任意 RSS / Atom（含他人 Paper List） | **粘 URL** | OPML 导入 |
| arXiv 分区日更 | **芯片** → `https://rss.arxiv.org/rss/{cat}` | 自定义 query |
| X 博主 | 空态：请贴已有 RSS（RSSHub / 其它适配器） | 设置里填 RSSHub 实例 + `@handle` 模板 |
| 谷歌学术提醒 | 空态：Scholar Alerts 是邮件，需先转到 RSS | 文档链到邮件转 RSS；不登 Google |

## 2. 信息架构

```
🌐 广场                     agentero:plaza
  ├── Cool Papers
  ├── ModelScope 论文
  ├── Skill 推荐
  └── 📡 订阅               agentero:plaza/feeds     ← 本篇
```

| 项 | 约定 |
|---|---|
| 路径 | `agentero:plaza/feeds`；虚拟，永不落盘 |
| 注册 | `PLAZA_SOURCES` 一条：`id: "feeds"`，`panel: "feeds"`，`url: null` |
| 侧栏 | 与 Skill 推荐相同：单击打开 panel；无删除 / 拖拽 / Finder |
| 图标 | Lucide `Rss`；en **Feeds**；zh-CN **订阅** |

订阅列表**只活在面板左侧**，不膨胀文件树。

## 3. 中间栏

原生 panel，不 iframe。无独立应用顶栏（与 Library / Skill 一致）。

```
┌──────────────┬────────────────────────────────────┐
│ [+ 添加订阅] │  全部 · 论文 · 其它      [刷新]    │
│ ──────────── │                                    │
│ ● 全部       │  ┌──────────────────────────────┐  │
│ ○ cs.LG      │  │ Attention Is All You Need …  │  │
│ ○ weekly     │  │ arXiv · cs.LG · 2h    [入库] │  │
│              │  └──────────────────────────────┘  │
│              │  ┌──────────────────────────────┐  │
│              │  │ Some blog title              │  │
│              │  │ weekly · 4h         打开原文 │  │
│              │  └──────────────────────────────┘  │
└──────────────┴────────────────────────────────────┘
```

| 区域 | 行为 |
|---|---|
| 左栏 | 有订阅后才出现：固定 `w-52`（约 13rem）。「全部」+ 订阅列表；选中过滤右栏。右键：重命名 / 复制 URL / 立即刷新 / 置顶 / **删除**。置顶的源钉在列表最上 |
| 右栏 | 时间倒序。`@tanstack/react-virtual` 窗口化。MVP 不做未读徽章，也**不做**「全部 / 论文 / 其它」顶栏 |
| 顶条 | 有订阅后：全宽输入 + 添加 + 刷新。无订阅：输入与芯片画在中间空态，不占顶栏 |
| 空态（无订阅） | 居中添加框 + arXiv 芯片 + 一句提示；点芯片即订阅 |
| 空态（有订阅无条目） | 「还没有条目，点刷新」或显示该源 `lastError` |
| 分栏 | 不用 `ResizablePanel`（百分比分栏会把左栏挤成一条） |

### 3.1 添加订阅

面板左栏顶部一个输入，或空态里的同一框。

- 吃 **http(s) URL**。
- 可选：失焦 / 提交后若响应是 HTML，读 `<link rel="alternate" type="application/rss+xml|atom+xml|json">`，取第一条真 feed。
- 标题默认用 feed `<title>`；用户可随后重命名。
- **arXiv 芯片**（输入框下方）：`cs.AI` `cs.CL` `cs.LG` `cs.CV` `stat.ML` → `https://rss.arxiv.org/rss/{cat}`。不是新源类型，只是填 URL。
- 重复 URL（归一化后）拒绝并 Toast，不建第二条。
- 添加时先拉源：解析失败或 **0 条条目** 则不写入订阅，前端 Toast（`feeds.empty` / `feeds.fetch`）。

MVP **不做**：`@handle` 展开、OPML、登录态、RSSHub 拼接。

### 3.2 两种卡片

| 卡片 | 判定 | 展示 | 主操作 |
|---|---|---|---|
| **列表卡** | 全部条目 | 标题；「全部」下显示来源+日期，单源下日期与标题同行。摘要去掉 arXiv 编号 / Announce Type | 点卡片进详情；右键菜单另有**加入对话**（整条送进 Agent，见下） |
| **详情** | 同上 | 打开时解析全文（RSS 摘要不够则抓 `item.url` → HTML→Markdown）。整篇是一份 Markdown：`# 标题` + 正文，走 `MessageResponse`。文末 `[...]` 会剥掉。入库 / 打开原文 / **加入对话**在顶栏。正文可划词：**提问**（浮层 Ask 卡，会话内 ephemeral，不写 `marks/`）/ **加入对话**（pin 到 Agent composer）/ 复制 | 返回列表 |

- **整条加入对话（列表层）**：列表卡右键菜单与详情顶栏各有一个「加入对话」，把**整条**条目（标题 + RSS 摘要；条目已解析全文时用全文）pin 成 Agent composer 的选区 chip，不必先打开详情再划词。实现：`src/lib/plaza/feed-chat-selection.ts`（payload 构造）、`plaza-feeds-item.tsx`（两个入口）。与详情页划词 Add to chat 共用 `addSelectionToChat`，chip 同样是 ephemeral、不落 `marks/`；source path 与划词一致（原文 URL → paper URL → 标题 → `feed:<id>`）。

- **划词与 Agent（#421）**：详情正文 DOM 选区后浮出文字按钮 Add to chat / Quick chat（`PlazaSelectionMenu`）。Quick chat 复用 PDF `AskPopover` + 内存 `PdfAskThread`（空 rects），`runOnce({ hideFromChatHistory: true })`，Agent 取自设置里的划词提问席位；关闭即丢，不落盘。Add to chat：`publishSelection({ origin: "markdown" })` → pin → 打开右侧 Agent。实现：`plaza-feeds-item.tsx`、`use-plaza-feed-selection.ts`（Ask 运行生命周期在共享 hook `components/selection/use-selection-ask.ts`，网页论文划词同用，见 [../frontend/web-view.md](../frontend/web-view.md)）、`plaza-selection-menu.tsx`、`lib/plaza/ask-prompt.ts`。
- 入库复用 `importPlazaPaper` / `lookupSubmit`：arXiv 喂 `https://arxiv.org/abs/{id}`；DOI 喂 `https://doi.org/{doi}`。入库不自动打开论文。
- 入库中按钮 busy；成功 Toast + 该行变为「已入库」（本机缓存记 `importedAt`，刷新不丢）。
- 失败 `notifyError`，不在侧栏挂错误条。
- 列表卡摘要只示纯文本 3 行。详情打开时走 `feeds_resolve_body`：已缓存 `bodyMarkdown` 则直接用；否则若 RSS 已是全文（或 arXiv / DOI 落地页）转 Markdown；博客摘要带 `[...]` 或 `paper_url` 为空（可能从落地页 metadata 确认论文身份）则抓原文 HTML，抽 `<article>` / 常见正文容器后 `htmd` 成 Markdown，并顺手解析 `citation_doi` 等回填 `paper_url`。渲染复用 `MessageResponse`（Streamdown + `$…$`）。`\begin{equation}` 等块环境归一成 `$$…$$` 显示公式：抓取侧（`body.rs`）与渲染侧（`math-normalize.ts`）都剥掉 KaTeX 不支持的 `equation` / `multline` / `flalign` 外壳，`align` / `gather` 等保留；环境内的 HTML 残留（`<br />` 换行、实体）在抽取时清理。占位符定宽编号，防 `LATEXBLOCK1` 前缀误替换 `LATEXBLOCK10`。
- 点标题 = 主操作。另给一个外链图标，论文卡也可打开原文。
- 抓原文页用浏览器 UA + cookie store 的 client：部分站点（如 spaces.ac.cn 的 WAF）首访回 403 + Set-Cookie + `window.location` 重定向壳页，`fetch_article` 检测到这类挑战页会带 Cookie 自动重发一次。抓取失败记 `agentero::feeds` warn 日志，回退 RSS 摘要。

不做第三种「提醒卡」、图墙、视频墙、全文阅读栏（经典三栏的第三栏）。

## 4. 数据与存储

两层，都在应用 XDG，**跨 Vault**（人的关注不跟某个课题走）。

| 层 | 路径 | 内容 |
|---|---|---|
| 库 | `$XDG_DATA_HOME/agentero/feeds.sqlite` | 订阅 + 条目缓存 |
| 不进 | `.agentero/catalog.sqlite`、Vault 文件、`settings.json` | — |

macOS 上即 `~/Library/Application Support/agentero/feeds.sqlite`（与 `usage.sqlite` 同一 XDG data 约定，见 [`../backend/usage.md`](../backend/usage.md)）。

**不**把订阅塞进 `AppSettings`：那是 UI 偏好，订阅是用户数据，条目还会涨。

### 4.1 表

```sql
-- 时间戳统一 `core/time.rs::now_rfc3339_millis()`（RFC 3339 毫秒 + Z）；
-- schema v3 已把存量时间列规范化为该格式（字符串 ORDER BY 依赖固定宽度）
CREATE TABLE subscriptions (
  id            TEXT PRIMARY KEY,   -- uuid
  url           TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  added_at      TEXT NOT NULL,      -- RFC 3339
  last_fetched_at TEXT,
  last_error    TEXT,
  etag          TEXT,
  last_modified TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  pinned_at     TEXT
);

CREATE TABLE items (
  id            TEXT PRIMARY KEY,   -- uuid
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  guid          TEXT NOT NULL,      -- feed guid / id / 否则 url
  title         TEXT NOT NULL,
  url           TEXT,               -- 原文
  published_at  TEXT,
  summary_text  TEXT,               -- 剥标签后的短摘要
  content_html  TEXT,               -- 可选，已存未渲染
  paper_url     TEXT,               -- 抽出的 arXiv abs / doi.org，可空
  imported_at   TEXT,               -- 本机入库成功时间，可空
  first_seen_at TEXT NOT NULL,
  body_markdown TEXT,               -- 详情页全文（打开时解析，可空）
  UNIQUE (subscription_id, guid)
);

CREATE INDEX items_timeline ON items (published_at DESC, first_seen_at DESC);
```

- 无 `kind` 列：论文 / 其它由 `paper_url IS NOT NULL` 过滤。
- 每源只保留最近 **200** 条（刷新后按 `published_at` 裁）。够用，避免库膨胀。
- `etag` / `last_modified`：有则带条件请求；304 不当错误。
- schema v4：正文转换（公式清理）变更后迁移清空 `body_markdown` 缓存，下次打开重解析；`paper_url` 保留。

### 4.2 拉取

- 打开面板：刷新「从未拉过」或 `last_fetched_at` 早于 **15 分钟** 的源。
- 面板挂载期间不设后台定时器以外的守护进程；可选：挂载时每 15 分钟再扫一轮，关 tab 停。
- 手动刷新：当前源或全部。
- 全部刷新时并发上限 **4**。
- 单源超时 **20s**，响应体上限 **2 MiB**。
- 只用 http / https。桌面应用**允许**局域网 / localhost（用户可能订本机 FreshRSS）。
- 跟随重定向，但最终 URL 必须仍是 http(s)。
- 走现有 Host HTTP 客户端（含用户配置的网络代理）。
- User-Agent：`Agentero/<version> (feeds)`。
- 解析：Rust [`feed-rs`](https://crates.io/crates/feed-rs)（RSS 0.9–2.0 / Atom / JSON Feed）。

论文线索（写入 `paper_url`，按先匹配先得）：

1. 条目 `url` / `id` / 标题里的 `arxiv.org/abs/{id}` 或 `arXiv:{id}`
2. `doi.org/{doi}` 或 `doi:{doi}`
3. 摘要纯文本里的同上模式（防 HTML 实体）
4. `nature.com/articles/<slug>` 确定性兜底：`<slug>` 即 DOI 后缀（`s41467-026-76837-1` / 旧式 `nature12373`），映射为 `https://doi.org/10.1038/<slug>`；仅限研究论文 slug，新闻页（`d41586-…`）不命中
5. 详情打开抓原文页时，解析 Highwire `citation_doi` → `prism.doi` / `dc.identifier`（剥 `doi:` 前缀）回填 `paper_url`（见 `feeds_resolve_body`）

抽不到就留空，UI 当短讯卡。刷新 upsert 用 `COALESCE(旧值, excluded.paper_url)`：无 DOI 字段的 feed 刷新不会抹掉已回填的 `paper_url`。

## 5. Host API

新 feature：`src-tauri/src/features/feeds/`。命令前缀 `feeds_`。

| Command | 入参 | 出参 | 说明 |
|---|---|---|---|
| `feeds_list` | — | `{ subscriptions: FeedSub[] }` | 含 `lastError` / `lastFetchedAt` / `itemCount` / `pinned`；置顶在前 |
| `feeds_add` | `{ url, title? }` | `FeedSub` | 归一化 URL；必要时做 HTML 自动发现；插入后拉一次 |
| `feeds_remove` | `{ id }` | — | CASCADE 删条目 |
| `feeds_rename` | `{ id, title }` | `FeedSub` | 只改显示名 |
| `feeds_set_pinned` | `{ id, pinned }` | `FeedSub` | 钉到列表最上；再钉的排在已钉的前面 |
| `feeds_refresh` | `{ id?, staleOnly? }` | `{ subscriptions, fetched, failed }` | `id` 空 = 全部（并发 4）；`staleOnly` 只拉超过 15 分钟的源 |
| `feeds_items` | `{ subscriptionId?, filter?: "all"\|"paper"\|"other", limit?, beforePublishedAt?, beforeId? }` | `{ items: FeedItem[] }` | 游标为 `(published_at, id)`；默认 limit 100 |
| `feeds_mark_imported` | `{ id }` | `FeedItem` | 写入 `importedAt`，刷新不丢 |
| `feeds_resolve_body` | `{ id }` | `FeedItem` | 打开详情时解析全文，写入 `bodyMarkdown`；同时从落地页 `<meta>`（`citation_doi` / `prism.doi` / `dc.identifier`）回填 `paperUrl`（已有值不覆盖；`bodyMarkdown` 已缓存则直接返回不重抓） |

`FeedItem` 至少：`id, subscriptionId, subscriptionTitle, title, url, publishedAt, summaryText, paperUrl, importedAt, bodyMarkdown`。`contentHtml` 留给 Host 转 Markdown，卡片不用。

远程 Vault 会话同样可用（不碰 Vault IO）。

错误：单源失败写 `last_error` 并继续；`feeds_add` 的发现/首拉失败不删行。用户可见字符串走 i18n key，Host 回稳定 error code。

## 6. 前端落点

| 区域 | 路径 |
|---|---|
| 来源注册 | `src/lib/plaza/sources.ts` 增 `feeds` + `panel: "feeds"` |
| `PlazaSource.panel` | 现有 `"skills"` 扩成 `"skills" \| "feeds"` |
| 面板 | `src/components/plaza/plaza-feeds-view.tsx`（壳 + 双栏 + 空态） |
| 行 | 同文件或 `plaza-feeds-item.tsx`（论文卡 / 短讯卡） |
| IPC | `src/lib/plaza/feeds.ts` |
| `PlazaView` | `panel === "feeds"` → `PlazaFeedsView` |
| 入库 | 已有 `src/lib/plaza/import.ts`；论文卡组一个 `PlazaImportRequest` |
| i18n | `sidebar:plaza.feeds.*`（en + zh-CN） |
| Host | `src-tauri/src/features/feeds/`（`mod.rs` + `commands.rs` + `parse.rs`） |
| crate | `feed-rs`（Host `Cargo.toml`） |

UI 约束（与广场其它面板一致）：

- 图标按钮有 aria-label + Tooltip。
- 无常驻解释文案；空态那几行是唯一例外。
- 详情正文复用 `MessageResponse`（只当 Markdown 渲染，不当对话件）。不用 Library 表格。
- `prefers-reduced-motion` 下虚拟列表瞬间定位。

## 7. 分阶段（本篇 = MVP）

| 阶段 | 交付 | 验收 |
|---|---|---|
| **M1 壳** | 侧栏「订阅」+ 首页卡 + 空态 + 添加框（先不拉网） | 虚拟 path；i18n；与 Skill 并列 |
| **M2 拉取** | `feeds_*` + `feed-rs` + 双栏时间线 + 刷新 | 订 arXiv `cs.LG` 能看到当日条目 |
| **M3 入库** | `paper_url` 判定 + 论文卡入库 + 已入库态 | 点入库进 Library；不跳走；刷新后仍显示已入库 |
| **M4 发现** | HTML `rel=alternate`；添加失败不丢订阅 | 贴博客首页能订到 feed |

M1–M3 可一次 PR；M4 可同 PR 或紧随。

### 明确不做（MVP）

- 嵌 Folo / 打 RSSHub / 刮 X / 登 Google / 收邮件。
- `@handle`、Scholar query 模板、OPML。
- 未读数、星标、全文搜索、AI 日报、第三栏阅读器。
- 条目写入 catalog 或 Vault。
- 每条订阅一个侧栏节点。
- 播客 enclosure / 播放器（引擎以后可复用，UI 不混）。
- 后台常驻轮询（面板关掉还拉）。
- Vault 级「课题订阅」（以后若做，另库，不和本篇混）。

### 之后（非本篇）

- 设置项 `rsshubBaseUrl` + `@user` → `/twitter/user/{id}`。
- OPML 导入 / 导出。
- 条目抽到论文后的多选入库。
- 每日新论文摘要（Agent）。
- 同一套拉取给未来播客用。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 破损 / 非标 feed | `feed-rs` 容错；失败写 `last_error`，不崩面板 |
| 站点当爬虫挡 | 礼貌 UA、15 min、条件请求、2 MiB 上限 |
| 条目 HTML XSS | 卡片默认纯文本；若渲染 HTML 必须 `sanitizeEmbeddedHtml` |
| arXiv RSS 的 link 走 `rss.arxiv.org/abs/…` | 抽 id 时认这个 host，入库仍喂 `arxiv.org/abs/{id}` |
| 同一论文多个 guid | 入库走现有 catalog 去重；UI「已入库」按本行 `importedAt`，不跨源合并 |
| 远程 / 无网 | 读缓存；刷新失败 Toast + 行内 `last_error` |
| 用户订了超大 feed | 截断 2 MiB + 每源 200 条 |

## 9. 验收清单（实现后）

- [x] 侧栏广场子节点能进「订阅」；path 不落盘。
- [x] 粘 `https://rss.arxiv.org/rss/cs.LG` 后时间线出现当日论文。
- [x] 论文卡入库走魔棒；成功不打开论文；刷新后仍为已入库。
- [x] 无 arXiv/DOI 的博客条目只有「打开原文」。
- [x] 删订阅后条目从时间线消失。
- [x] 关掉订阅 tab 后 Host **不再**拉源。
- [x] en / zh-CN 齐；图标按钮有 Tooltip。
- [x] `feeds.sqlite` 只出现在 XDG data，Vault 与 catalog 无新表。

---

*起草：2026-08-15 — 轻量本地 RSS，广场一个原生节点；X / Scholar 当适配器留到有 URL 之后。*


## 订阅读取状态（已实现）

- 打开应用内详情即标记已读，不推断是否读完整篇；仅打开外部原文不自动标记。
- 已读标题使用灰色、常规字重；信封开合图标和无障碍标签区分已读 / 未读，列表与详情均可手动切换。
- 面板右上角提供「隐藏已读」开关，默认关闭（当前面板状态）。阅读中的详情保持打开，返回列表后已读项不再显示；关闭筛选可找回并恢复未读。
- XDG `feeds.sqlite` v5 新增可空 `items.read_at`，旧缓存默认未读；刷新同一条目不覆盖该字段，和 `imported_at` 独立。沿用每源最多 200 条缓存保留策略，条目被清理后不承诺保留阅读历史。
- `feeds_set_read` 设置 / 清除状态；`feeds_items(filter=unread)` 在分页限制之前筛选，避免最新已读内容遮挡较早未读内容。
- 状态修改失败走 Toast；后台刷新、全文解析与入库返回不应关闭当前详情或覆盖其阅读状态。

## 网页入库入口与后续（#821）

订阅条目右键菜单提供「入库」，详情工具栏也可入库。识别到论文时优先传入 `paperUrl`，普通网页传入来源 URL，复用魔棒 / Translator 链路；解析失败 Toast 提示，不标记已入库。入库中禁用重复操作，成功或命中库内重复后显示「已入库」。入库不会将条目标记已读。该入口不新增正文离线归档能力。普通网页在翻译服务不可用时改为按 URL 和页面元数据入库。后续正文归档及 URL 去重设计见 [webpage-library.md](webpage-library.md)，与读取状态独立交付；未读数、批量标记和跨设备阅读历史不在本次范围。
