# 参考文献解析（Citation Parsing）

> 状态：**M1 + M2 + M3(PDF 内交互) + 反向引用发现 已实现**（M1：Host `features/refs/` — L1 在线 S2/Crossref + L2 本地 bib/bbl/thebibliography + sidecar + 库内匹配，命令契约见 [api.md](api.md) `paper_refs_parse` / `paper_refs_list`；M2：右侧栏 References tab 引用卡片，见 [../frontend/shell.md](../frontend/shell.md)；M3：PDF Link annotation 覆盖层 — 点击 GoTo 跳页 / URI 外链、hover 引用锚文本显示元数据预览并联动引用卡片高亮；反向引用发现：`library_citing_scan`，见 §7）。剩余草稿：卡片 → PDF 反向 hover 高亮、Agent `#` 提及。

## 1. 背景与现状

- arXiv 入库时 e-print 已完整解压到 `{paper}/source/`（`src-tauri/src/features/import/assets.rs` `unpack_arxiv_eprint`），其中**天然包含 `.bbl`、偶有 `.bib`**。
- 非 arXiv PDF 入库后由 liteparse 生成 `PAPER.md`（`src-tauri/src/features/paper/analyze/parse/mod.rs`），References 段以纯文本存在，`extract_links: true` 已开启。
- catalog（v3）没有 references 存储，仅有标量 `citation_count`。
- PDF 查看器（EmbedPDF / PDFium）已加载页内 Link annotation，文中 citation 点击可跳转；`goToPage` 与 destination 解析（`src/lib/pdf/bookmark.ts`）已有基础。
- 右侧栏新增 tab 的三处扩展点：`src/lib/shell/ui-store.ts`、`src/components/shell/title-bar.tsx`、`src/components/shell/right-sidebar.tsx`。
- Agent composer 的 context chip 是 vault 相对路径字符串（`src/lib/agent/composer-state.ts`），拖拽走 `dataTransfer text/plain`。

## 2. 解析策略：按来源分层

优先级（产品决策）：**在线 API 最高 → 本地 bib/bbl 兜底 → 文本层切分最后**。逐层 fallback，取第一个成功的；首版实现 L1 + L2。

### L1 — 在线 API：Semantic Scholar / Crossref（最高优先级，首版实现）

- 条件：论文有 DOI 或 arXiv id（catalog 已有字段），且网络可用。
- **Semantic Scholar Graph API** `paper/{DOI|arXiv:id}/references` 首选：一次拿到全部结构化条目（title / authors / year / venue / externalIds），零文本解析。免费；无 key 走共享池，设置里可选填 S2 API key（1 req/s）。
- **Crossref** `works/{doi}` 的 `reference` 字段备选（免费、无需注册；请求带 `mailto` + User-Agent 进 polite pool）；出版商公开率约 60–70%，字段可能只有 raw string。
- 本地限速（~1 req/s）+ 结果缓存进 sidecar；离线或两者皆空 → 落到 L2。
- 设置 → 通用：**在线引用解析开关**（默认开，与魔棒查询同网络域）；GROBID 等外部服务不引入。

### L2 — arXiv 本地：解析 `.bib` / `.bbl` / `thebibliography`（离线兜底，首版实现）

- `source/**/*.bib`：标准 BibTeX，brace-aware 字段读取，直接得到 key、title、author、year、venue、doi。
- **`source/**/*.bbl`**：arXiv e-print 里 `.bbl` 出现率远高于 `.bib`。`\bibitem{key} ...` 半结构化：按 `\bibitem` 切分，剥 TeX 命令（`\newblock`、`\emph`、`{}`），raw 文本必存 + 正则尽力提取 year / arXiv id / DOI / URL。
- 主 `.tex` 内联 `\begin{thebibliography}`：与 `.bbl` 同一解析器。
- 正文 `\cite{}` 系列命令扫描建立 key → 文中位置映射。
- 与 L1 的合并：L1 成功时 L2 仍提供 **cite key → 文中位置** 与编号顺序（S2 返回顺序不保证与文中编号一致）；条目元数据以 L1 为准，按 DOI / arXiv id / 归一化标题对齐合并。

### L3 — 纯 PDF：文本层切分（最后兜底，延后实现）

回答「PDF 转 Markdown 解析，还是直接解析 PDF？」——**两者结合，各取所长**：

- PDF 对参考文献**没有语义结构**，可提取的只有文本层；「直接解析 PDF」拿不到比 liteparse 文本更多的元数据。元数据解析统一走文本层（liteparse word-boxes 输出；`PAPER.md` 仅作回退语料）。
- PDF 独有的价值是 **Link annotation（GoTo 内部链接）与坐标**：文中 `[12]` 的锚点用于**交互跳转与 hover**（§4），不用于元数据提取。
- 做法：定位 References / Bibliography 标题段 → 按编号模式（`[1]` / `1.` / 悬挂缩进的 author-year）切分条目 → 每条保留 raw string，正则提取 year / DOI / arXiv id / URL；title 不强行猜。
- raw string 可逐条经 Crossref `query.bibliographic` 匹配富化（限速，随 L3 一起延后）。

## 3. 持久化

- **事实来源：`{paper}/source/agentero-cite.json` sidecar**，可重建、可删除、不碰用户文件——这同时回答「没有 bib 文件时的持久化」：L1 在线结果与 L3 的 raw + 尽力字段都写入 sidecar，重开应用不重解析、不重复请求 API（fingerprint 判断；`source` 字段记 `s2 | crossref | bib | bbl | tex | pdf-text`）。
- 库内匹配（`localMatch`）：DOI → arXiv id → 归一化 title+author+year，只查本地 catalog。
- **catalog 建 `paper_refs` 索引表**推迟到需要大规模跨论文查询 / 被引统计时再评估，避免双写；MVP 单论文 sidecar 足够。
- 导出：右键论文提供 **导出 references.bib**（本地 BibTeX 序列化 sidecar 条目），非默认落盘。

## 4. 文中 citation 交互与引用侧栏

交互契约如下，本文补充卡片形态与联动细节：

- **卡片保持简洁**，单卡仅含：
  - `[12]` 编号徽标 + 标题（两行截断；无标题时显示 raw 前两行）；
  - 第二行：首作者 et al. · 年份 · venue；
  - 角标：DOI / arXiv 外链徽标、**已入库**标记（点击打开库内论文）；未入库 hover 出 **导入**（走 `paper_commit` 管线；注意不**自动**导入，此处为用户显式点击）。
- **打开论文时自动解析**：论文标签页加载后，前台会在后台自动调用 `paper_refs_parse(force=false)`；若 sidecar 已存在且 fingerprint 未变则直接命中缓存，否则开始 L1/L2 解析。解析结果写入 `{paper}/source/agentero-cite.json`，PDF 查看器和 References 侧栏共享同一结果，无需用户先点开侧栏再点击「Parse references」。
- **hover 预览与联动**：hover 文中 citation anchor → 显示编号、标题、作者、年份、venue 和已入库状态；同时发布 hover marker，侧栏对应卡片高亮并 `scrollIntoView`。预览内放大镜打开 References 侧栏。引用识别只接受数字引用或作者-年份形式，并排除 Figure、Section、Table、Equation 等内部交叉引用；未能识别的链接只保留点击导航。
- **反向联动（待实现）**：hover 引用卡片 → PDF 高亮 anchors。
- **点击**：文中 citation 点击跳 References 条目；卡片点击跳第一个 anchor。
- PAPER.md 视图（无 PDF 时的回退）：编辑器装饰插件把 `[12]`、`[3, 7]` 渲染为可点击 token，纯展示装饰、不改写 Markdown 源文本；点击/hover 复用同一事件。

## 5. Agent 集成

后续可扩展 `@` 菜单 Citations 分组与卡片拖拽；本文补充两个 delta：

### `#` 编号提及

- composer 输入 `#` 触发引用提及（与 `@` 文件提及并列）：候选为**当前聚焦论文**的 citations，`#12` 直接匹配编号，也可按标题子串过滤；chip 展示 `#12 标题…`。
- 状态：`AgentComposerState` 增加 `mentionedRefs: { paperPath: string; citationId: string }[]`（`mentionedPaths` 不动）。

### prompt 注入

- 已入库（有 `localMatch`）的 ref 并入 `contextPaths`（Agent 直接读库内笔记/正文），chip / prompt 行为与文件 chip 同构。
- 未入库的 ref 在现有 context 路径列表后追加结构化文本块：

  ```
  Referenced citations:
  - [12] {title}. {authors}. {year}. {venue}. DOI: {doi}
  ```

- 拖拽：卡片 `dataTransfer text/plain`——已入库拖出 vault 相对路径；未入库拖出 `agentero:ref:{paperPath}#{citationId}` 令牌，composer 识别后转为 ref chip。

## 6. 分期

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M1（首版） | **L1 在线（S2 / Crossref）+ L2 本地（含 `.bbl`）** + sidecar 写入 + 库内匹配 + 在线开关设置 | 已实现 |
| M2 | Paper Content 侧栏 Citations 卡片 + hover/click 双向联动 | 已实现 PDF→预览/卡片单向联动 |
| M3 | Agent：`@` 分组 + 拖拽 + **`#` 编号提及** + prompt 注入 | 部分实现 |
| M5 | L3 文本层切分 + Crossref raw string 富化 + references.bib 导出 + 未入库一键导入 | 延后 |

## 7. 反向引用发现（谁引用了我的库）

> 状态：**已实现**（Host `features/refs/citing.rs`，命令 `library_citing_scan`，入口在文件树 Library 节点右键）。

方向与本文其余部分**相反**：不是「这篇论文引了谁」，而是「库里的论文被哪些**新论文**引用了、且这些新论文还没入库」。和 M5 的「未入库一键导入」不是同一件事——那个是正向引用的批量版。

### 7.1 数据源：只能用 Semantic Scholar

OpenAlex 的引用图几乎不含 arXiv 预印本之间的引用边。实测同一个 53 篇 vault：2026 年的 37 篇里只有 1 篇在 OpenAlex 有任何引用记录，按文件夹扫 7/10 返回 0；唯一非零的那个文件夹全是跨领域噪音（引用者是结直肠疾病 transformer、嵌段共聚物乳液），因为该文件夹装的是 Attention/GPT-3/BERT/ResNet/Adam 这些经典。

同一批论文在 S2 有数据：

| 论文 | OpenAlex `cited_by` | S2 `citationCount` |
| --- | --- | --- |
| DFlash (2602.06036) | 0 | 70 |
| Dynamic Early Exit (2504.15895) | 1 | 216 |
| Your LLM Knows the Future (2507.11851) | 0 | 40 |

S2 的接口形状本身不适合批量（`citations` 端点无日期过滤、无排序、`offset+limit < 10000` 硬顶、每篇一个请求），靠两步绕开：

1. 一个 `POST /paper/batch` 请求拿全库 `citationCount` + SPECTER2 向量（≤500 ids/请求）
2. 只对合格种子逐篇 `GET /paper/{id}/citations`，`limit=1000`，8 路并发

8 路并发实测比串行快 4.6 倍且无持续 429。53 篇 vault 全扫 **40 个请求 / 约 50 秒 / 免费无 key**。

### 7.2 三层过滤

| 层 | 手段 | 额外请求 |
| --- | --- | --- |
| L0 | 跳过被引 > 2000 的经典种子（噪音源头）、被引为 0 的种子；候选按时间窗、已入库（DOI/arXiv 双路 + arXiv DOI 别名）、无可导入标识过滤 | 0 |
| L1 | IDF 加权重叠 `Σ 1/log10(种子被引 + 10)`——引 Attention（18.9 万）权重 0.19，引刚发的新论文权重 1.0 | 0 |
| L2 | SPECTER2 语义门槛：**先减背景均值再算余弦**（裸余弦全挤在 0.80–0.96，绝对阈值无区分度），取「对我任意一篇的 max-sim」而非质心相似度（库是多主题的），阈值用「我自己论文 leave-one-out max-sim 的 p10」自校准 | 1–2 |

L2 方案实测对比（阈值统一取自己论文 p10）：

| 方案 | 同主题池通过 | GPT-3 引用者噪音池 | ResNet 引用者噪音池 |
| --- | --- | --- | --- |
| 裸余弦 → 质心 | 62% | 6% | 0% |
| 中心化余弦 → 质心 | 57% | 9% | 0% |
| **中心化 max-sim → 任一篇** | **80%** | **3%** | **0%** |

### 7.3 排序与预算

过门槛后按 `0.65·(w/wmax) + 0.35·(sim/smax)` 排序，取前 150 做 MMR（λ=0.7）多样化，最终截到预算 20 条。

**用固定预算而不是 A/B/C 分级阈值**：预算直接控制用户要看的条数，且省掉按文件夹调阈值——实测阈值会在 0.238~0.597 间漂移。MMR 的作用是防止 20 条被单一方向占满（实测把 Tool 方向的覆盖从 1 条提到 3 条，代价是挤掉 4 条同质论文）。

### 7.4 缓存与增量

`.agentero/citing-scan.json`（参照 `features/vault/doctor/mod.rs` 的 `DOCTOR_STATE_REL` 先例）存每个种子的 `s2Id` / `citationCount` / `fetchedAt` / 引用者元数据，外加上次结果供 UI 直接复用。下次扫描先用 1 个 batch 请求拿最新 `citationCount`，**只重抓被引数变化的种子**，稳态约 10 秒。SPECTER2 向量不落盘（每次 1–2 个请求重取），避免几 MB 的 JSON。

写入是普通 `fs::write` 而非 tmp+rename，原因同 `write_sidecar`：rename 会被 vault watcher 报成「未验证重命名」。缓存可重建，不值得为原子性换这个噪音。

### 7.5 生命周期与进度

前端 `enqueueBackgroundTask` 建任务行（`discoverCitingPapers`，`src/lib/paper/library-actions.ts`），把任务 id 作为 `taskId` 传给命令，Host 用它做两件事：

- **进度**：抓取阶段按完成数 emit `background-task:progress`（带 `currentCount`/`totalCount`），面板显示「引用 · 12/38」。只有带计数的阶段才 emit——没有计数的阶段会掉进面板的字节格式化分支
- **取消**：每个种子请求前轮询 `core::background_tasks::is_cancelled`，命中即返回且不写缓存；命令出口无条件 `finish()` 清标记，否则残留的取消标记会秒杀下一个复用该 id 的任务

库级 I/O 互斥复用 `libraryStore.ioBusy`。结果属于扫描时那个 vault，完成回调比对 `getVaultPath()` 不一致就不弹窗。

### 7.6 实测（53 篇 vault）

`53 篇 → 38 个种子`（跳过 5 篇经典、9 篇未被引、1 篇无标识）`→ 1163 篇引用者 → L0 后 445 → 过语义门槛 319 → 展示 20`，自校准阈值 0.376。头部候选是 DeLS-Spec（引用库内 6 篇）、Bastion（5）、DominoTree / D-cut / D²SD（各 4），无跨领域噪音。

## 8. 风险与开放问题

- L1 依赖外部服务可用性与限速（S2 共享池很挤）：失败必须静默落 L2，不弹错误；缓存进 sidecar 避免重复请求。
- S2 references 顺序与文中 `[n]` 编号可能不一致：编号真相来自 L2 的 bbl/tex 顺序或 L3 文本；纯 L1（无 TeX 的 DOI 论文，M1 阶段无 L3）时卡片可暂无编号、仅按 API 顺序列出。
- `.bbl` 格式方差大（各 bst 输出不同），按「raw 必存、字段尽力」设计，不追求完美解析。
- 双栏 / 断词 PDF 的 L3 切分质量有限；raw 卡片兜底 + Crossref 富化补救（均在 M4）。
- EmbedPDF 封装下 PDFium link/text bbox API 可用性需先 spike。
- author-year 引用样式（`(Smith et al., 2020)`）的文中匹配难于数字编号，首版允许 `unresolved` 降级。
- i18n：新增文案先登记 `en` 再同步 `zh-CN`。
