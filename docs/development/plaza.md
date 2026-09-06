# 广场（Plaza）— 外部来源发现

> 范围：侧栏虚拟节点 **广场** 及其子来源（Cool Papers / ModelScope 论文 / Skill 推荐 / 订阅 / 播客 / 论文推荐）；中间栏发现流。  
> 相关：[`../frontend/vault-tree.md`](../frontend/vault-tree.md)、[`../backend/paper-import.md`](../backend/paper-import.md)、[`../backend/index.md`](../backend/index.md)。  
> 订阅 MVP（已落地）：[`plaza-feeds.md`](plaza-feeds.md)。  
> 开关：设置 → 通用 → **广场**（`plazaEnabled`，默认开）；关闭后不显示、不加载。
> 单来源显隐：`plazaHiddenSources`（默认空）。右键广场父节点列出全部来源逐条勾选显隐（菜单保持打开可连续操作）；侧栏子行按此过滤。

## 0. 产品结论（2026-07-25，2026-08-14 修订）

| # | 议题 | 结论 |
|---|---|---|
| Q1 | 树位置 | **Library + Recycle Bin 下方、真实 Vault 根目录上方**（已实现） |
| Q2 | Cool Papers 呈现 | **内嵌 iframe + Host 代理协议** `agentero-coolpapers://`（已实现；见 §3.2） |
| Q3 | 入库 | **已实现**：每行注入 `[入库]`，复用现成魔棒（见 §3.2.1） |
| Q4 | P0 范围 | **已交付：广场壳 + Cool Papers 浏览入库 + Skill 推荐 + 订阅 + arXiv Daily**；播客尚未实现 |
| Q5 | ModelScope 论文 | **已实现**：同一代理模式，但站点是 SPA，另有取舍（见 §3.5） |
| Q6 | 订阅 | **已落地**：广场下单一原生节点，本地 RSS/Atom；见 [`plaza-feeds.md`](plaza-feeds.md) |

**已实现落点（2026-08-14）**

| 区域 | 路径 |
|---|---|
| 来源注册表 | `src/lib/plaza/sources.ts`（新增来源 = 一条数组项；`icon` 只存名称键，组件映射在 `src/components/plaza/source-icons.ts`） |
| 中间栏 | `src/components/plaza/plaza-view.tsx`、`plaza-web-frame.tsx`、`plaza-skills-view.tsx` |
| Skill 精选 | `src/lib/plaza/skill-catalog.ts` |
| 入库 | `src/lib/plaza/import.ts`（论文 + Skill 仓库） |
| 侧栏行 | `src/components/sidebar/file-tree/tree-rows.tsx`（`PlazaRow` / `PlazaSourceRow`） |
| Tab kind | `src/lib/workspace/tabs/types.ts` 的 `"plaza"` + `doc-view.tsx` 分支 |
| 站点代理（共享管道） | `src-tauri/src/features/paper/discovery/proxy/mod.rs` |
| 站点代理（各站改写 + 注入） | `src-tauri/src/features/paper/discovery/coolpapers/proxy.rs`、`src-tauri/src/features/paper/discovery/proxy/modelscope.rs` |

> Kimi 解析没有走广场入库，而是作为论文侧的独立能力落在 Markdown 工具栏的
> 「获取 Cool Paper 笔记」按钮上（`paper_coolpapers_notes` → 追加 `NOTES.md`）。
> 解析顺序：`source_url` 上的 papers.cool 链接 → venue 形 catalog id（`38818@AAAI`）
> → arXiv id → 标题（允许搜索结果截断后的长前缀）。

## 1. 产品动机

Agentero 已是 **local-first 论文工作台**（Library + 文件树 + PDF\|NOTES）。用户还需要从 **外部发现流** 找新论文。

**广场** = 「发现入口」集合，与 **Library（已收藏）** 正交：

| | Library | 广场 |
|---|---|---|
| 数据权威 | catalog + Vault 文件 | 外部站点 / 本地启发式；**P0 不写 Vault** |
| 侧栏 | `agentero:library` | `agentero:plaza` + 子来源 |
| 中间栏 | 论文库表格 | 来源专属发现 UI |
| 典型动作 | 打开 / 标签 / 导出 | 浏览发现 + 单条入库 |

来源：

1. **Cool Papers**（[papers.cool](https://papers.cool/)）— P0：内嵌站点浏览。  
2. **ModelScope 论文**（[modelscope.cn/papers](https://modelscope.cn/papers)）— 内嵌站点浏览；魔搭每日读论文带中文摘要与评分。  
3. **Skill 推荐** — 原生面板：按论文阅读 / 写作 / 绘图 / 复现 / 投稿精选 GitHub Skill 仓库；点卡片走魔棒 Skill 导入。  
4. **订阅** — 用户自己的 RSS / Atom / JSON Feed；论文条目入库。见 [`plaza-feeds.md`](plaza-feeds.md)。  
5. **播客** — 占位，后续。  
6. **论文推荐** — P0 v0：基于本地库的轻量推荐列表（无云端上传）。

## 2. 侧栏信息架构

```
📁 VaultName
├── 📚 Library                 agentero:library
├── 🗑️ Recycle Bin             agentero:trash
├── 🌐 广场                     agentero:plaza              ← 可折叠
│   ├── ✨ Cool Papers         agentero:plaza/cool-papers
│   ├── ✨ ModelScope 论文      agentero:plaza/modelscope
│   ├── ✨ Skill 推荐           agentero:plaza/skills
│   ├── 📡 订阅                 agentero:plaza/feeds
│   ├── 🎙️ 播客                 agentero:plaza/podcasts      ← 占位
│   └── 🔭 arXiv Daily            agentero:plaza/arxiv-rec
├── papers/
├── notes/
└── …
```

| 项 | 约定 |
|---|---|
| 路径 | `agentero:plaza`、`agentero:plaza/<sourceId>`；**永不落盘** |
| 位置 | Library 与 Recycle Bin **之下**，真实根目录 **之上** |
| 父节点 | 单击 → 只切换展开/收起（纯虚拟文件夹，无广场首页） |
| 子节点 | 单击 → 对应来源 panel（dockview 虚拟 tab） |
| 右键 | 父节点：列出全部来源逐条勾选显隐（写入 `plazaHiddenSources`，菜单保持打开）；来源行无菜单；无删除/拖拽/Finder |
| 禁用 | 拖入拖出、删除、重命名、终端打开 |

**图标（建议）**

| 节点 | Lucide | en | zh-CN |
|---|---|---|---|
| 广场 | `Globe` | Plaza | 广场 |
| Cool Papers | `Flame` 或自定义标 | Cool Papers | Cool Papers |
| ModelScope 论文 | 自定义标（魔搭 favicon） | ModelScope papers | ModelScope 论文 |
| Skill 推荐 | `Sparkles` | Skill picks | Skill 推荐 |
| 订阅 | `Rss` | Feeds | 订阅 |
| 播客 | `Podcast` | Podcasts | 播客 |
| arXiv Daily | `Telescope` | arXiv Daily | arXiv Daily |

i18n：`sidebar:plaza.*`。

## 3. 中间栏呈现

### 3.1 壳：`PlazaView`

- dockview：`kind: "plaza"`，`path` = 虚拟 URI；同一 path 单实例 `activatePanel`。  
- **无**独立应用顶栏（与 Library 一致）；来源工具条做在内容区内。  
- 父路径 `agentero:plaza` **没有页面**：广场根只是文件树里的虚拟文件夹，单击只切换展开/收起；每个来源面板由子节点各自打开。

### 3.2 Cool Papers（P0，WebView）

**主内容**：内嵌 iframe，经 Host 代理协议 `agentero-coolpapers://localhost`（Windows 为 `http://agentero-coolpapers.localhost`）加载 papers.cool。

| 区域 | 行为 |
|---|---|
| 主体 | 全高 iframe；站点内导航、分区、搜索均由 papers.cool 负责 |
| 顶条（Agentero chrome） | 后退 / 前进 / 重新载入 / 当前路径（只读）/「系统浏览器打开」 |
| 站内链接 | 在 iframe 内直接跳转 |
| 站外链接 | 交给系统浏览器（arxiv.org 等一律拒绝被嵌套） |
| 加载失败 | 代理返回 502 文案 |
| 入库 | 每行 `[入库]`，见 §3.2.1 |

**为什么要代理（`src-tauri/src/features/coolpapers/proxy.rs`）**

papers.cool 给几乎所有链接都加了 `target="_blank"`（单个分区页实测 238 处）。直接跨源嵌套时：

- 链接要么弹出独立窗口、要么静默失效——**点了没反应**；
- 跨源 iframe 的 `location` / `history` 都读不到，**无法实现后退**。

因此改为在 Host 侧以自有 scheme 转发（沿用 `discovery/proxy/arxiv.rs` 的既有模式），同源后即可改写与观测：

- `target="_blank"` → `_self`，站内链接原地跳转；
- **同时改写 `window.open`**。仅改 HTML 不够：cool.js 的所有脚本式跳转都走 `window.open`（搜索、`[REL]` 相关论文、排序、feed、导出收藏、arXiv 日历共 7 处），且多数传 `_blank`；sandbox 去掉 `allow-popups` 后这些调用会被**静默丢弃**，表现为「搜索点了没反应」。补丁在 `<head>` 安装，早于 body 末尾的 cool.js。
- 统一的三档跳转规则（链接与脚本共用）：**站内页面** → 原地 `location.assign`；**Atom feed** → 交系统浏览器（面板里渲染裸 XML 没有意义）；**跨源** → 交系统浏览器。
- feed 与站内 handoff 必须**换算回上游 origin** 再交出去——系统浏览器解析不了我们的私有 scheme（消息用 `externalPath`，由面板对 `homeUrl` 求解）。
- 绝对自链接 `https://papers.cool/…` → `/…`，导航不会掉出代理；
- 注入桥接脚本：`postMessage` 上报每次导航路径（前端据此维护 Back/Forward 栈），并拦截跨源链接交给系统浏览器；
- 上游 origin 在 Rust 侧**硬编码**，避免代理退化成任意 URL 中继（SSRF）。
- **只对完整 HTML 文档注入**（首字节是 `<!doctype` / `<html`）。`togglePdf` / `toggleKimi` 用 XHR 取的是 **同样标着 `text/html` 的片段**——Kimi 解析是裸 `<p class="faq-q">`，`POST /star` 是裸计数——cool.js 直接把响应文本塞进 DOM，一旦注入就会把脚本源码和计数当文本显示出来（现象：点 PDF / Kimi 弹出一段 `<script>…</script>0`）。
- **桥接脚本在嵌套 frame 内自我禁用**。pdf.js viewer 也是完整文档，会被一并注入；那里的 `parent` 是 papers.cool 页面而非应用，消息没人收，且点击拦截会把 PDF 内的链接 `preventDefault` 掉。判定方式：读 `parent.location.href`——面板自身的父窗口是跨源的应用会抛异常，嵌套 frame 的父窗口同源可读。

**其它工程注意**

- 前端不用 iframe 自身 history：一旦跳到第三方源就再次不可读；后退改为「按记录的路径重挂载 iframe」，因此也不会污染应用自身的 session history。
- **只有 后退 / 前进 / 重新载入 可以改变 iframe 的 `key`**（用单独的 `epoch` 计数器）。若把 `key` 挂到「观测到的导航」状态上（如 history 长度 / 游标），站内每次点击都会重挂载并重新加载**挂载时那个旧路径**，表现为「点子页面闪回首页」。venue 尤其明显：`<a onclick="listVenueDetail('AAAI')">` 无 href（只做 show/hide + `pushState('/')`），但其中的年份 / 分组是真链接 `href="/venue/AAAI.2026"`。
- sandbox 去掉 `allow-popups`，确保没有链接能逃到新窗口。
- 与 PDF iframe 一样，拖拽期间置 `pointer-events: none`，否则 dockview 收不到 dragover。
- 远程 Vault 会话下同样可用（广场不依赖 vault 文件 IO）。
- Host 用进程级复用的 HTTP 客户端转发（`core::http::shared_client`），否则每张图 / 每段 JS 都要重新握手代理 TLS，papers.cool 会明显卡。

### 3.2.1 入库（已实现）

代理注入的桥接脚本给每行论文标题追加 `[入库]`，与站点自带的 `[PDF] [Copy] [Kimi] [REL]` 同排。点击后把 `{ id, branch, url, title }` 交给面板，结果回传给该行显示 `[已入库]`。

**分两条路，因为质量不对等：**

| 行类型 | 路线 | 理由 |
|---|---|---|
| arXiv | 现成魔棒，喂 `arxiv.org/abs/{id}` | 原生 arXiv 路径还能多拿 `arxiv_id` 与 LaTeX 源码 |
| 其余（venue） | `paper_coolpapers_import`，读该行自己的 papers.cool 页面 | 不经 Translator；见下 |

**为什么 venue 不走 Translator。** papers.cool 的论文页自带 Highwire `citation_*`（title / authors / abstract / publisher / date，**以及 `citation_pdf_url`**），实测覆盖它聚合的全部 11 种出版商形态。而把出版商 URL 送去 Translator：

- `openreview.net`（COLM / CoRL / ICLR / ICML / MLSYS / NeurIPS / UAI **共 7 个 venue**）抓到的是 Cloudflare 人机验证页，0 作者；
- `ojs.aaai.org`（AAAI）HTTP 500；
- `www.ecva.net`（ECCV）HTTP 300 多选；
- `papers.miccai.org` / `www.ndss-symposium.org` 退化成 `webpage` / `blogPost`；
- **且 11/11 都不返回 PDF 附件。**

也就是说 Translator 那条路「一半站点坏、还全都缺 PDF、又多一跳依赖用户自建服务」，唯一净胜的只有 DOI（当前不填）。详见 [#333](https://github.com/poco-ai/Agentero/issues/333)。

**catalog id 用 papers.cool 原生 id**（如 `36962@AAAI`、`2026.acl-long.1@ACL`）。`allocate_paper_path` 不清洗 id、直接当目录名，`@` `.` 三平台合法。选它而非默认派生链是因为它全局唯一、去重精确；派生链的 `citekey_fallback`（`{姓}{年}{标题首词}`）会撞，而 `DedupePolicy::ByCatalogId` 撞了会**静默当重复吞掉**。代价是同一篇论文日后从 BibTeX / Zotero 进来 id 不同、会重复——已知取舍，原生 id 另存进 `source_url` 保留可追溯性。

**其它约定**

- 复用共享的 `paper_commit`：catalog 插入、NOTES.md 播种、PDF 下载、去重全部沿用，不新增管线。
- `paper_type` 不是 Zotero itemType，取值是 `PaperKind` 枚举（`arxiv` / `pdf` / `html` / `doi` / `other`）；无 DOI 时为 `other`。
- 元数据解析复用 `map_zotero_item_to_record`（先拼一个 Zotero 形状的值），避免第二套字段映射。
- 注入的 `[入库]` **不带 href**，否则会被跨源链接拦截器当外链送去系统浏览器。
- 行是滚动加载的（`loadMorePapers` 追加 `.panel.paper`），除首屏遍历外挂 `MutationObserver`。
- 只做**单条入库**，不提供批量。
- 入库后**不自动打开论文**，否则会把连续浏览的用户拽出面板。
- PDF 没取到时提示「已导入（未取到 PDF）」，不谎报干净成功。

**后续（非 P0）**：批量入库、预览抽屉；DOI 可按需回补（AAAI / IJCAI 的出版商页有 `citation_doi`，`/search` 按 DOI 的元数据质量最高）。

### 3.2.2 Skill 推荐（已实现）

原生面板（不 iframe）。五类：论文阅读 / 论文写作 / 绘图 / 复现 / 投稿。目录写在 `skill-catalog.ts`（静态 star 快照）。点卡片 → `importPlazaSkillRepo` → 魔棒 `lookupSubmit` → 现有 Skill 多选安装框。角上外链单独打开 GitHub。不含 Zotero / 文献库类仓库。

### 3.3 播客（占位）

- 空态文案：订阅源、单集列表与播放将在后续版本提供。  
- 侧栏子节点可点，进入占位页（避免「死链」）。

### 3.4 arXiv Daily（已实现）

**目标**：用 Vault 论文库当「兴趣语料」，对当天 arXiv 新论文排序，给出「今天该读什么」。思路对齐 [zotero-arxiv-daily](https://github.com/TideDra/zotero-arxiv-daily)，但语料是本地 catalog 而非 Zotero 云端。

**管线**（`src-tauri/src/features/recommend/mod.rs`）

| 步骤 | 做法 | 复用 |
|---|---|---|
| 候选 | 逐个分类 GET `https://rss.arxiv.org/rss/<cat>`，按 arXiv id 去重，丢弃空摘要 | `feeds::parse::parse_feed_bytes`（已 `clean_summary_text` + `extract_paper_url`） |
| 语料 | catalog 中有 abstract 的论文，按 `added_at` 倒序，上限 2000 篇 | `papers::list_all_unique_by_id` |
| 向量 | `POST {baseUrl}/embeddings`（batch，OpenAI 兼容），凭据取自设置 → Agent → Embedding | `core::http::client_builder`；请求形状抄 `translate_openai_compatible` |
| 打分 | 归一化后 cosine；语料权重 `w_i = 1/(1+log10(i+1))` 归一化 → `score = Σ sim·w`，降序取 Top-20 | — |

**缓存进 `catalog.sqlite`（schema v6）**，不新建库：

| 表 | 作用 |
|---|---|
| `embed_cache(text_hash, model, dim, vector)` | 摘要向量，key = sha256(title+abstract) + model；**语料只 embed 一次**，之后每天只为新增摘要付费。`vector` 是小端 f32 |
| `arxiv_rec_state(id=1, computed_at, categories_json, results_json)` | 上次运行结果，页面/vault 打开可直接渲染 |

**陈旧判定**：非 `force` 且 `computed_at` 是**当天**且分类集合未变 → 直接返回存量，完全不碰网络。换分类、跨天、或点刷新才重算。

**命令**：`recommend_arxiv`（算，含 stale 短路）、`recommend_arxiv_last`（只读存量）。`AppSettingsStore` 必须在 `.await` 之前读（managed state 不能跨 await）。

**vault 打开自动刷新**：`src/lib/lifecycle/register.ts` 的 `vault:opened` handler 里 fire-and-forget 调 `recommendArxiv`，仅本地 vault。因为命令自身 stale-only + 未配置早退，这里不做任何判断——作用是**预热当天结果**，让面板下次秒开。

**页面**（`src/components/plaza/plaza-arxiv-rec-view.tsx`）

- **header**：分类 chip 多选（默认 `ARXIV_FEED_CHIPS`，与订阅共用常量）+ 上次计算时间 + 刷新按钮。**不进 app settings** —— 分类就是页面状态，持久化在 `arxiv_rec_state`。
- **body**：卡片列表（标题 / arXiv id / 分数 / 摘要三行截断），右上角**阅读**（在应用内打开远程 PDF，不写盘）+ 外链 + 一键入库（走 `lookupSubmit`，与订阅同一条魔棒路线）。
- **空态分三种**并给对应出路：未配置 embedding → 「打开 Agent 设置」按钮；库里没摘要 → 引导先导入论文；分类下无新论文 → 提示换分类。

**取舍**

- 首次或大库的整库 embedding 会慢一次（上千篇），之后靠 `embed_cache` 只增量；候选每天仅数十篇。接受首启一次性成本，换掉「每次都重算」。
- 分类/Top-N 不做设置项：Top-20 是常量，分类留在 header。少一层配置面板。
- 模型换了会导致缓存维度不一致；打分时按维度不匹配记 0 分，不会崩，但建议换模型后点一次刷新。
- **隐私**：摘要会发给用户自己配置的 embedding 端点（BYOK）。未配置则整个功能静默不跑。

### 3.5 ModelScope 论文（已实现）

**主内容**：内嵌 iframe，经 `agentero-modelscope://localhost` 加载 [modelscope.cn/papers](https://modelscope.cn/papers)。顶条 chrome、拖拽护盾、Back / Forward 全部复用 `PlazaWebFrame`，前端只多了 `PLAZA_SOURCES` 一条。

**必须代理**：站点回 `X-Frame-Options: SAMEORIGIN`，直接 iframe 会被拒。代理重建响应时只保留 `Content-Type`，XFO 顺带被丢掉。

**与 Cool Papers 的四处不同（都因为它是 umi 3.5.26 SPA）**

| 差异 | 后果 |
|---|---|
| 列表走 `PUT /api/v1/dolphin/papers`（JSON body，匿名可用） | 代理原本只发 GET 且丢 body，页面会渲染成空壳。请求管道抽到 `discovery/proxy/mod.rs` 并**转发 method + body**（顺带修好 papers.cool 的 `POST /star`）。只转发 `Content-Type` / `Accept` / `Accept-Language`——`Cookie`、`Origin`、`Referer` 一律不带 |
| 外壳资源全是协议相对 `//g.alicdn.com/…`，含 `window.publicPath` | 在自有 scheme 下会解析成 `agentero-modelscope://g.alicdn.com/…`，应用根本不启动。`rewrite_html` 把 `="//` / `='//` / `= "//` 一律改成 `https://`。CDN 资源**不经代理**，否则等于给代理开一批额外上游主机（SSRF 面） |
| 路由是 `history.pushState`，点卡片不产生真实导航 | 桥接必须包装 `pushState` / `replaceState` 并监听 `popstate` 才能上报路径，否则顶条路径和 Back / Forward 永远不动 |
| 页面是 React，被拒绝的点击不能只 `preventDefault` | umi 的 `Link` 自己就会 `preventDefault` 然后照样路由，必须在捕获阶段 `stopImmediatePropagation`，让事件根本到不了 React 根容器 |

**只允许 `/papers*` 原地浏览。** 其余同域路径（`/models`、`/datasets`、`/docs`…）与站外链接一律 handoff 到系统浏览器；同域的走 `externalPath` 换算回上游 origin。登录一族（`/login`、`/register`、`/reset`、`/binding`）是另一套独立应用，本就不该在代理里跑——我们不注入任何登录态（§7）。

**隐藏站点 header**（`header.antd5-layout-header`）。面板是论文流，不是浏览器：全局导航只提供「走出去」的入口，还带登录按钮。隐去之后页面自带的搜索框、`本周热门 / 最新推荐 / 全部论文` 排序 tab 与卡片栅格都还在，面板反而更干净。

**入库**：`/papers/<arxivId>` 本身就是全部所需身份，所以列表卡片和详情页注入的「入库」都只发 `{ id, branch: "arxiv", url: "https://arxiv.org/abs/<id>" }`，直接落到 §3.2.1 的 arXiv 路线（能多拿 `arxiv_id` 与 LaTeX 源码）。**没有新增任何 Rust 入库命令，前端 `import.ts` 零改动。**

两处都是带 Agentero 标的按钮，一眼能认出是我们的动作而不是站点自己的：

- **列表**：绝对定位在卡片右下角，与统计行同高；自带边框/圆角/中性灰底，浅色深色主题都成立。
- **列表**：只装饰真正排布出盒子的卡片（`offsetWidth`/`offsetHeight` 阈值）。零宽的 `/papers/` 锚点会让绝对定位的按钮甩到容器边缘，露在卡片外面。
- **详情页**：插在站点那排 `arXiv 原文 / PDF / Git` 的最左侧，并**在运行时借用 `arXiv 原文` 的 className**，所以尺寸与外观完全一致。定位靠那颗 arXiv favicon（`img[src*="arxiv.org"]`）——那排的类名是哈希的、文案是本地化的，图标 src 两者都不是。
- **图标**：品牌标缩到只剩那副铜色眼镜。完整的插画式 logo 在 14px（站点图标尺寸）下糊成一团。
- **必须在链接拦截器之前注册点击处理并整体吞掉事件**——卡片按钮就长在卡片自己的 `<a>` 里面，否则入库的同时会被路由带走。
- 文案挂在子 `span.agentero-import-label` 上，落态只改它，图标与借来的结构不会被 `textContent` 抹掉。
- 站点的 Emotion 类名（`acss-*`）每次发版重新哈希，**只能**用 `header.antd5-layout-header`、`a[href^="/papers/"]`、arXiv favicon 这类结构化钩子。
- React 重渲染会抹掉注入节点，`MutationObserver` 挂 `document.body` 补回来（debounce 100ms，避免自触发抖动）。
- 回执按 `data-paper-id` 遍历匹配：arXiv id 带 `.`，不能用 id 选择器。

## 4. 与其它模块

| 模块 | 关系 |
|---|---|
| Library | arXiv Daily 读 `paper_list` 当语料；缓存表 `embed_cache` / `arxiv_rec_state` 落在 catalog（schema v6），不动 `papers` 表 |
| 魔棒 / 入库 | **已复用** `lookup_import_batch`：喂上游 URL，见 §3.2.1。订阅论文卡走同一条 |
| 订阅 | 独立 XDG `feeds.sqlite`，不进 catalog；见 [`plaza-feeds.md`](plaza-feeds.md) |
| PDF\|NOTES | 推荐打开本地论文时走现有阅读布局 |
| Agent | 订阅详情与 arXiv Daily 远程 PDF 均支持划词提问 / 加入对话（#421；远程 ephemeral，不写 `marks/`） |
| 命令面板 | P1：`Plaza: Cool Papers` 等 |

## 5. 虚拟路径与类型草图

```ts
export const PLAZA_VIRTUAL_PATH = "agentero:plaza";

export const PLAZA_SOURCE_PATHS = {
  coolPapers: "agentero:plaza/cool-papers",
  podcasts: "agentero:plaza/podcasts",
  recommend: "agentero:plaza/recommend",
} as const;

export function isPlazaVirtualPath(path: string | null | undefined): boolean {
  return Boolean(path?.startsWith("agentero:plaza"));
}
```

DocTab：`kind: "plaza"`（或 `file` + mode `plaza` + path 虚拟 URI——实现时与 Library/Trash 对齐选一种，**推荐独立 kind** 便于 `DocView` 分支）。

## 6. 分阶段

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P0a 壳** | 侧栏广场 + 三子节点；`PlazaView` 按来源路由 | 虚拟 path 不写盘；i18n；折叠位置正确 |
| **P0b Cool Papers** | WebView 浏览 papers.cool + 导航 chrome + 外链 | 可分区浏览站点；失败可恢复 |
| **P0c arXiv Daily** | embedding 相似度 + 时间衰减排序 + 一键入库（已交付） | 配好 embedding 后有排序结果；未配置有引导空态 |
| **P0d 播客** | 占位页 | 可进入、文案清晰 |
| **P1** | 入库（解析 arXiv / 魔棒管线）、预览抽屉、批量加入 Library | 与魔棒语义一致 |
| **P2** | 播客实体、Agent 推荐、命令面板、@ 广场条目 | — |
| **订阅 MVP** | 原生面板 + 本地 RSS + 论文入库 | 见 [`plaza-feeds.md`](plaza-feeds.md) M1–M4 |

## 7. 明确不做（P0）

- 广场 → Vault **批量入库**（单条已实现，见 §3.2.1）。  
- 把 feed 写入 catalog（订阅条目缓存走 XDG，见 [`plaza-feeds.md`](plaza-feeds.md)）。  
- 播客播放器。订阅管理见 [`plaza-feeds.md`](plaza-feeds.md)，不进本篇原 P0。  
- 云端协同过滤，或把本地库上传到 Agentero 自有服务。arXiv Daily 只把摘要发给**用户自己配置的** BYOK embedding 端点；未配置则整个功能不跑。  
- 注入脚本只做导航上报与 `[入库]`；**不注入任何凭据 / API Key / 登录态**。

## 8. 实现落点（编码时）

| 区域 | 路径 |
|---|---|
| 设计 | `docs/development/plaza.md`（本文，UI 规范也在此，`docs/frontend/shell.md` 没有广场小节） |
| 虚拟 path | `src/lib/plaza/sources.ts` |
| 文件树 | `src/components/sidebar/file-tree/` |
| 中间栏 | `src/components/plaza/*` + `doc-view` |
| 站点内嵌 | `src/components/plaza/plaza-web-frame.tsx`（代理 iframe，两个站点来源共用；没有 Tauri 子 webview 封装） |
| arXiv Daily | `src-tauri/src/features/recommend/`（管线 + 命令）、`src/lib/recommend/index.ts`、`src/components/plaza/plaza-arxiv-rec-view.tsx`；缓存表见 `catalog/schema.rs` v6 |
| 订阅 | [`plaza-feeds.md`](plaza-feeds.md) §6 |
| i18n | `sidebar` / 独立 `plaza` ns |
| Roadmap / Todo | 增加「广场 P0」条目 |

## 9. 风险与后续确认点

| 风险 | 缓解 |
|---|---|
| 站点改版 / 禁止嵌入 | 代理已丢弃 `X-Frame-Options`；仍失败则把该来源降级为 `embedOrigin: null` + 「系统浏览器打开」 |
| ModelScope 换 API 形状或 header 类名 | 只依赖结构化钩子（`antd5-*`、`a[href^="/papers/"]`）；列表接口变了表现为空列表，代理无需改动 |
| alicdn 资源的 CORS | `crossorigin="anonymous"` 的几个脚本需要上游回 `*`；被拦时兜底是在 `rewrite_html` 里去掉 `crossorigin`（无 `integrity`，降级为经典脚本） |
| WebView 体积与内存 | 仅在对应 plaza panel 挂载；关 tab 销毁 |
| 推荐过冷启动 | 空态文案；阈值（如 &lt; 3 篇不估标签组） |

**仍可再确认（非阻塞 P0a）**：

- Cool Papers 默认落地 URL（首页 vs 某默认分区如 `cs.AI`）。  
- 推荐 v0 是否显示「打开过的非 paper 笔记」——默认 **否**，仅 paper 单元。

---

*修订：2026-07-25 — 采纳 WebView、不做入库、P0 含推荐 v0、树位置在 Library/Trash 下。*
*修订：2026-08-14 — 改为代理协议嵌入；壳 + Cool Papers 浏览 + 单条入库已落地；推荐 / 播客未实现。*
*修订：2026-08-15 — 新增 ModelScope 论文来源；请求管道抽到 `discovery/proxy/mod.rs` 并转发 method + body。*  
*修订：2026-08-15 — 订阅列为广场来源，规格拆到 [`plaza-feeds.md`](plaza-feeds.md)。*  
*修订：2026-08-15 — 订阅 MVP 落地（XDG `feeds.sqlite` + 原生双栏 + 论文入库）。*  
*修订：2026-08-21 — arXiv 推荐落地（embedding + 时间衰减；缓存进 catalog schema v6；`vault:opened` 预热）。*