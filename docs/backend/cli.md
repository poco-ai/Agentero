# CLI（`agentero`）

Headless Vault / Catalog / Wiki 接口；**不含** BYOA / paper-reader。

## 位置

- 目录：`cli/`（crate `agentero-cli`）
- path 依赖 `agentero-core` 与 `agentero-mcp`（**不**依赖 `agentero_lib`，依赖树无 tauri/wry/tao）：`features::{vault,catalog,import,wiki,zotero,feeds,translate,doctor,trash,pdf_locate,open_request,sync}` + 顶层 `{error,fs}`。`agentero mcp serve` 与桌面端共用 `agentero-mcp` 的工具面
- 同版本 CLI 安装（不随桌面安装包打入，减小体积 [#285](https://github.com/poco-ai/Agentero/issues/285)；open/deep-link 仍见 [#165](https://github.com/poco-ai/Agentero/issues/165) / [#166](https://github.com/poco-ai/Agentero/issues/166)）
  - 设置 → 关于：**安装 CLI** 从 GitHub Release 下载与 App **同版本** 的 `agentero-cli-{ver}-{triple}` 归档，校验 `.sha256` 后写入用户目录并创建 PATH shim。POSIX 写 `~/.local/bin/agentero` 软链（不静默改 shell rc）；Windows 写 `agentero-cli.cmd` 并**自动把安装目录加入用户 PATH**（`HKCU\Environment`，广播 `WM_SETTINGCHANGE`，无需重启，新开终端即可用 `agentero-cli`）。下载 404 的错误文案会带上完整资产 URL（含宿主 triple），架构/版本不匹配时自解释；`CliInstallStatus.commandName` 供前端按平台展示验证命令
  - 独立 CLI 归档仍随每次 Release 发布，供无桌面的 headless 机器使用；macOS 亦可通过 Homebrew tap `poco-ai/agentero` 安装 headless CLI
  - **启动自动安装与同步**：main window 启动时，CLI 尚未安装或版本 / shim 已过期（`!shimCurrent`，见 `syncCliWithApp`），自动复用上述同版本下载、校验与 shim 安装流程。应用内更新只替换 GUI 包，CLI 由更新重启后的新进程按编译期 App 版本同步。Release 的桌面包与 CLI 归档独立上传，首次请求暂未命中或网络短暂失败时会在 15 秒、60 秒后重试。设置 → 关于的「卸载 CLI」会写入配置目录的 `cli.removed`，后续启动不再安装；手动安装成功后清除标记。下载期间卸载也会在创建 shim 前再次检查并跳过。成功静默，最终失败 `notifyError` Toast；dev 环境跳过，不覆盖非 Agentero 管理的同名文件。

## 命令组

| 组 | 用途 |
|---|---|
| `open` | 在桌面 App 打开本地目录为 Vault（`agentero open <PATH>`；简写 `agentero <PATH>`） |
| `vault` | create / list 等 |
| `sync` | 云同步（S3/R2、WebDAV、Git）：configure / status / test / now / disconnect，与桌面端共用引擎（见下） |
| `mcp serve` | 前台 Streamable HTTP MCP（loopback）。与桌面端共用工具面，不启动 GUI。见 [mcp.md](mcp.md) |
| `describe` | Agent 自省：策展型 op 目录与单 op 的 input/output/errors/examples（机器契约真源） |
| `paper` | list/get、tag list/set/add/rm、move、open、download/parse、notes fetch… |
| `import` | 标识符入库 |
| `discover` | 查询式发现：按关键词/分类/提交日期窗口抓 arXiv 候选，确定性词法排序（headless、无 embedding key） |
| `export` | 导出 |
| `doctor` | Vault 结构与 Catalog 诊断；含 wikilink 检查与 aliases / 视觉批注 / catalog 去重修复 |
| `layout` | 侧栏同构版面索引：`list` / `get`（figure / table / algorithm / formula / section / paragraph） |
| `mark` | 阅读标注：`list` / `get` / `add`（`--quote` 文字锚点或 `--region` 区域锚点）/ `update` / `delete` |
| `ui` | 桌面工作区/窗口操作：`open`（打开或聚焦文档/文件夹/论文）/ `close`（关闭面板）/ `window`（聚焦原生子窗口）/ `split`（分屏）；均走 `agentero://ui` 深链 + 请求文件 |
| `translate` | 免费机器翻译纯文本（无需 API Key，不读桌面 settings） |
| `table` | 科研表格行操作：`query` / `upsert` / `update-cells`（与桌面网格共用 `*.table.json`） |

稳定 `--json` 输出，供脚本与外部 Agent 组合。JSON 默认 **compact 单行**（省 token），`--pretty` 恢复缩进美化（[#367](https://github.com/poco-ai/Agentero/issues/367)）。

### Agent 自省（`describe`）

Agent 不应背 flag 表；以 curated ops 目录为准（`agentero-core::ops`，与 MCP tool 名对齐）：

```bash
agentero describe --json
agentero describe paper.list --json
agentero describe paper_list --json   # MCP tool 名亦可
```

未知 id 返回 `usage`，并尽量提示相近 op。Skill `agentero-cli`（v16+）按**任务分支**写协议（已知 path 的问答直接读文件；探索才 `paper list`；`describe` 仅在 flag 未知时用；`set-read` 只在 paper-reader / 显式标已读后），细节仍以本命令为准。

`paper list --json` 默认每行只含 `id/path/title`；用 `--fields year,date,tags,abstract,…`（逗号分隔、可重复）按需加字段，或 `--full` 输出完整 `PaperRecord`。未知字段报 `usage` 错误并列出合法字段。text 表格不受 `--fields` 影响，其 DATE 列显示 `date`（缺失时回退 `year`）。

`paper get` / 其它接受 paper ref 的命令：优先 vault-relative **path**。bare **id** 在多 shelf 同 id 时返回 `paper_ambiguous`（`details.candidates` 为可选 path），message 会提示用 path 重试。

### 版面索引与区域批注（已实现）

侧栏 Figures 同源列表落在 `{paper}/source/layout-index.json`（由桌面版面分析在 merge 后写入；raw 仍为 `source/layout.json`）。

```bash
# 列出图 / 表 / 算法 / 公式 / 章节标题（--kind 可重复，OR）
agentero layout list papers/demo --json
agentero layout list papers/demo --kind figure --kind formula --json
# section 从 source/layout.json 的 header 区域实时合并，不写入 layout-index.json
agentero layout list papers/demo --kind section --json
agentero layout list papers/demo --kind paragraph --json
agentero layout get papers/demo '#2.1#p3' --json
agentero layout get  papers/demo figure-3 --json

# 按区域钉批注（bbox 归一，页面尺寸由 PDF 引擎测量）
agentero mark add papers/demo --region figure-3 --comment "核心图" --json
agentero mark add papers/demo --region formula-p3-… --question "推导？" --json
agentero mark list papers/demo --json
agentero mark delete papers/demo <id> -y --json
```

Mark id 是 nanoid，字母表含 `-`，约 1/64 的 id 以 `-` 开头。`mark get` / `mark update` / `mark delete` 的 id 位置参数按 `allow_hyphen_values` 接收，无需 `--` 分隔。

| `--kind`（layout list） | 含义 |
|---|---|
| `figure` | 侧栏插图分区（image + chart） |
| `image` / `chart` / `table` / `algorithm` / `formula` | 精确 kind |
| `section` | 从 `source/layout.json` 枚举章节标题；有明确编号且唯一的章节提供 `anchor` |
| `paragraph` | 编号章节直接所属的正文块，返回 `anchor`、`sectionAnchor`、`paragraphIndex`、`text`、页码与 bbox |

章节与段落查询只需 `source/layout.json`，其他查询仍需 `layout-index.json`。缺少对应文件时明确返回错误，提示先在 App 运行版面分析。

`anchor` 可原样追加到 PDF 路径，例如 `papers/demo/demo.pdf#2.1#p3`。编号先按页码排序；检测到双栏正文的水平间隙且两侧正文在垂直方向重叠时，按通栏块分带，每带先左栏再右栏、栏内从上到下，修正远端解析结果可能存在的 `readingOrder` 左右交错。无双栏证据时保留 `readingOrder`（缺失时用坐标及 id 排序），在置信度筛选前按所属章节计数；子章节独立计数。未编号标题终止上一章节的归属，标题前正文不推测章节。重复编号章节及其段落不提供可用 `anchor`；直接查询歧义锚点返回 `citation_anchor_ambiguous`，不存在返回 `citation_anchor_not_found`。同一解析结果重开保持编号；首版不重建跨页自然段，也不恢复 PDF 替换后的旧锚点。

### 文字高亮 / 批注 / 翻译（已实现）

`--quote` 走 PDF 文字引擎（PDFium，与阅读器 ⌘F 同源）定位，两趟匹配：

1. **严格**：折叠空白、默认忽略大小写，并把印刷体变体折回 ASCII（`’`→`'`、各类破折号→`-`、`ﬁ`/`ﬂ` 连字展开）——Agent 的 quote 抄自 TeX/`PAPER.md`，与排版后的字符不同。
2. **宽松回退**（严格零命中才跑）：再丢掉连字符、空格，以及 PDFium 解码失败的字符（`U+FFFE` 等 noncharacter）。跨行连字符（`token-to-` 换行 `token`）和坏 ToUnicode 字体靠这趟救回。

命中后由 `FPDFText_CountRects` 取每个可视行一个框，经 `bounds_to_viewport` 翻到左上原点再归一。
CLI **不手算坐标**，也不接受外部传入坐标。跨页的句子仍搜不到（逐页搜索）。

```bash
# 高亮；加 --comment 即批注（等价于桌面划词后写评论）
agentero mark add papers/demo --kind highlight --quote "we propose a novel …" \
  --page 3 --comment "核心贡献" --mark-color yellow --json

# 同句多处命中：--page 过滤、--match-index 选第几处、--all 全标
agentero mark add papers/demo --kind highlight --quote "attention" --all --json

# 钉翻译（免费 MT）/ 提问壳
agentero mark add papers/demo --kind translate --quote "…" --to zh-CN --json
agentero mark add papers/demo --kind ask --quote "…" --question "为什么？" --json

# 改评论 / 改颜色
agentero mark update papers/demo <id> --comment "改过的批注" --mark-color green --json

# 纯文本翻译，不落 mark
agentero translate "Hello world" --to zh-CN --json
```

| 落盘 | 内容 |
|---|---|
| `{paper}/marks/annotations.json` | 高亮 / 批注（EmbedPDF annotation 传输格式，页面点坐标；CLI 追加时按 id 去重 + 原子写） |
| `{paper}/marks/<id>.json` | ask / translate（归一 0–1 rects，与桌面划词同一 schema） |

零命中返回 `mark_locate_failed`（业务错误，退出码 1）且**不落盘**——让 Agent 换更独特的
句子重试，而不是写一条没有位置的垃圾 mark。论文无本地 PDF 时返回 `paper_pdf_missing`。

定位跑在与 `PAPER.md` 解析同一套隔离 worker 子进程里（`--agentero-internal-pdf-locate-worker`，
30s 硬超时），PDFium 卡死不会拖住 CLI。翻译只用免费引擎（`translate_text` 的 FREE_PROVIDERS，
zh 目标走并行竞速）；商业 BYOK Key 只在桌面 settings 里，CLI 拿不到也不去读。
内置 provider `agentero` **刻意不在** FREE_PROVIDERS 里，所以 `--provider agentero` 会被拒：
`--provider` 就是拿这个清单门控的，随后又以 `api_key: None` 调用，加进去等于让 CLI 接受一个
它无法认证的 provider。内置凭证只编在桌面 Host 二进制里（见 [builtin-provider.md](builtin-provider.md)）。

阅读器侧：打开论文时导入 `annotations.json`，并监听该文件的**外部**变更增量导入，
所以论文开着时跑 CLI 也能在 1~2 秒内看到黄底（见 [frontend/pdf.md](../frontend/pdf.md)）。

```bash
# CLI 只依赖 agentero-core（tauri 无关），headless 构建不走 tauri-build。
# 桌面安装包不内置 CLI（`externalBin` 只有插件 worker，不含 agentero-cli；安装目录不会出现占位 agentero-cli.exe）；
# 开发机可选跑下面命令把真二进制放进 src-tauri/binaries，让 设置 → 安装 CLI 走本地路径：
pnpm cli:bundle
cargo build -p agentero-cli
cargo run -p agentero-cli -- vault list --json
cargo run -p agentero-cli -- doctor wiki papers/demo/NOTES.md --json
cargo run -p agentero-cli -- doctor --json
cargo run -p agentero-cli -- layout list papers/demo --json
cargo test -p agentero-cli
```

### Vault 列表

`agentero vault create <PATH>` 会把 Vault 绝对路径记录到共享配置目录中的 `agentero/config.toml` 的 `known_vaults` 数组中（去重追加）。路径统一经 core `paths` 解析：优先 `$XDG_CONFIG_HOME`，Unix 默认 `~/.config`，Windows 默认 `%APPDATA%`。`agentero vault list` 可列出这些已知 Vault，并标出当前 `default_vault`：

```bash
agentero vault list
agentero vault list --json
```

该配置与 GUI 设置隔离，可直接编辑 `config.toml`：

```toml
default_vault = "/Users/philfan/l/paper"
known_vaults = ["/Users/philfan/l/paper", "/Users/philfan/l/video-acc"]
```

新位置没有配置时，CLI 会校验并原样复制旧 `~/.config/agentero/config.toml`，保留旧文件；新位置已有文件时始终优先它，迁移不覆盖并发创建的文件。旧 `vaults.md` 列表合并去重并成功原子写入后才删除来源。配置解析或写入失败会返回错误，旧文件保留；保存也保留不认识的 TOML 字段，避免新版配置被旧版 CLI 丢弃。

普通保存复用 core 原子写，使用唯一同目录 `.tmp`、Unix `0600`，替换前同步文件内容；旧位置迁移使用 `tempfile::persist_noclobber` 保证不覆盖已有新配置。原子替换失败不会退化为截断写。

## 科研表格（`table`）

`version` 仍是 `1`。`table query|upsert|update-cells` 与桌面网格共用 `src/lib/research-table/model.ts` 的文件模式，直接改 Vault 里的 `*.table.json`。没有 SQLite 索引，也没有全表搜索。查询按文件中的存储顺序返回，单元格用字段名而不是字段 ID。

```bash
agentero table query data/run.table.json --json
agentero table query data/run.table.json --field 容量 --equals 2.5 --json
agentero table update-cells data/run.table.json --expected-revision 3 \
  --data '{"cells":[{"registryId":"ID-0001","field":"容量","value":2.5}]}' --json
agentero table upsert data/run.table.json --expected-revision 4 --idempotency-key batch-1 \
  --data '{"rows":[{"values":{"样品":"A"}}]}' --json
```

变更正文来自 `--data`，或者在非 TTY 时从 stdin 读取。`expectedRevision` 必须与 `table query` 看到的 `revision` 一致，不一致返回 `revision_conflict`（`details.revision` 为当前修订号）且不写盘。省略 `registryId` 的 `upsert` 追加一行并签发下一个注册编号；已有编号只更新给出的字段。可选 `idempotencyKey`（1–80 个字符、不含空白）在成功写入后记入文件的 `appliedKeys`（最多保留 50 个）。同一个键再次出现时不写盘、不增加 `revision`，返回 `replayed: true`。`file_write` 不能覆盖或追加已有的 `*.table.json`。桌面端保存时如果磁盘内容既不是上次保存的快照、也不是即将写入的正文，已有的字节冲突检查会拒绝覆盖。

## 发现（discover）

`discover arxiv` 是**查询式、无 Vault** 的发现原语，对应「抓当天 arXiv + 关键词排序」：候选来自 arXiv Atom API（`export.arxiv.org/api/query`，按提交日期倒序），用**确定性词法打分**排序——标题命中权重 3、摘要命中权重 1，每个结果带 `matches` 说明命中了哪些词、贡献多少。不需要 embedding 端点或 API key。

```bash
# 关键词 + 分类 + 日期窗口
agentero discover arxiv -k agent -k "world model" -c cs.AI --since 2026-08-01 --until 2026-08-07 --json

# 只看某分类当天最新（无关键词时按提交日期新→旧）
agentero discover arxiv -c cs.LG --top 20 --max-candidates 200 --json
```

| 参数 | 说明 |
|---|---|
| `-k/--keyword` | 主题词或短语，可重复；多词短语按整词匹配（`all:"…"`） |
| `-c/--category` | arXiv 分类（如 `cs.AI`），可重复 |
| `--since` / `--until` | 提交日期窗口（`YYYY-MM-DD`，映射到 `submittedDate`） |
| `--top` | 短名单条数（默认 8） |
| `--max-candidates` | 排序前抓取的候选上限（默认 100，封顶 200） |
| `--out` | 把完整短名单 JSON 写到文件 |
| `--no-dedup` | 关闭「已入库去重」 |
| `--embed-base` / `--embed-model` | 给 OpenAI 兼容 embeddings Base URL + 模型 id，启用**可选**语义加权；key 读 `AGENTERO_EMBEDDING_API_KEY`（不走 argv） |
| `--semantic-weight` | 语义余弦加到词法分的权重（默认 1.0） |

- **至少给一个 `--keyword` 或 `--category`**，否则报 `usage`（只给日期会扫无界切片）。
- 打分默认纯词法、可复现、离线可跑；`matches` 里的 `field` / `count` / `weight` / `contribution` 就是「为什么推它」。
- **已入库去重**：解析到 vault 时，候选里 arXiv id 已在 catalog 的会被**排序前**剔除（`excluded` 计数）；命令仍保持 vault-free——解析不到 vault 就静默跳过去重，只有显式传了无效 `--vault` 才报错。`--no-dedup` 可关闭。
- **可选语义排序**：给了 `--embed-base` + `--embed-model` 后，把关键词的 embedding 与候选 embedding 的余弦按 `--semantic-weight` 加到词法分上（`matches` 里出现 `field: "semantic"` 一项）。端点失败**不报错**，降级为纯词法并在 `semanticError` / 文本末行提示。默认不启用，词法仍是基线。
- 输出是可直接消费的短名单（`_shortlist.json` 的收敛版）；Agent 拿到后自行判断题相关性，再走 `import id` 入库。
- 与桌面广场的 arXiv Daily **不同**：后者是「读我的库 → 今天该读什么」的库画像 embedding 排序，依赖 catalog 与 embedding 端点；本命令是 query-first、零依赖，供 headless / 管线使用。

## 论文导入

`import id` 通过标识符（arXiv ID / DOI / URL / 标题等）解析元数据并创建论文单元，同时尝试下载 PDF / arXiv TeX 等资源。默认放到 `papers/` 下，可用 `--parent` 指定 vault 内的父目录：

```bash
# 默认 parent = papers
agentero import id 1706.03762 --json

# 放到指定分类目录（不存在时会自动创建）
agentero import id 1706.03762 --parent papers/nlp --json
```

`--parent` 是 **vault-relative** 的父目录，最终论文目录名由 resolver 根据论文 ID 决定，不是完全自定义路径。导入成功后会返回 `path`、`id`、`title` 以及 `pdf` / `tex` / `paperMd` 等资源旗标。

付费文献 PDF 兜底：CLI 启动时读取桌面同一份 `settings.json` 的机构代理三字段（`institutionProxyType` / `institutionProxyPrefix` / `institutionProxyCookie`）并注入进程级下载链，因此 `import id` 与 `paper download` 在 OA 链路全未命中时会按桌面配置的 EZProxy/WebVPN 网关重写请求（见 [settings.md](settings.md)）。未配置时保持直连、不带 Cookie。

CLI 没有单独的 Cookie 配置命令；在桌面设置页登录并读取 Cookie 后，CLI 自动复用。无桌面环境时可编辑共享配置文件的上述三字段。

### 导入本地 PDF

`import pdf` 将本地裸 PDF 文件导入 Vault。CLI 默认会同步执行元数据识别（LiteParse probe → Zotero recognizer → DOI/arXiv 权威解析），识别成功后直接以规范 ID（如 bare arXiv ID 或 DOI slug）命名论文目录 `{parent}/{canonical_id}/`，填充真实标题、作者、年份及摘要并写入 `catalog.sqlite` 与 `NOTES.md`。若未识别出权威标识符，则回退至文件名派生元数据。可使用 `--no-recognize` 跳过识别：

```bash
# 导入单篇本地 PDF（默认 parent = papers，自动识别元数据与规范命名）
agentero import pdf /path/to/paper.pdf --json

# 批量导入多篇本地 PDF 到指定分类目录
agentero import pdf paper1.pdf paper2.pdf --parent papers/nlp --json

# 跳过元数据识别，直接以文件名派生元数据入库
agentero import pdf paper.pdf --no-recognize --json
```

支持一次传入多个文件路径；支持相对路径与绝对路径。

## 论文与 Tag

Tag 写入支持桌面端相同的 8 色后缀格式：

```bash
agentero paper tag add papers/demo "survey:blue"
agentero paper tag set papers/demo "nlp:green" "must-read:orange"
```

只有合法颜色后缀会被解析为颜色；例如 `owner:alice` 仍是普通 Tag 名称。

`@zotero:`（Connector）和 `@arxiv:`（arXiv 学科分类，如 `Computer Science - Machine Learning`）是内部标签，默认不参与论文列表筛选和 Tag 汇总；需要包含它们时传 `--all`：

```bash
agentero paper list --tag topic
agentero paper list --tag "@zotero:imported" --all
agentero paper tag list --all
```

`paper delete` 默认移入可恢复回收站（由桌面端管理恢复与清空）；明确传 `--files` 才会物理删除。

### 更新论文元数据（`paper set-meta` / `paper update`）

`paper set-meta`（别名 `update`）用于更新 catalog 中的论文元数据，并同步落盘到该论文目录下的 `metadata.json`。支持修改出版物/期刊会议（`--publication`）、标题（`--title`）、发表日期（`--date`）、DOI（`--doi`）、arXiv ID（`--arxiv-id`）以及作者列表（`--authors`）：

```bash
# 修改论文所属会议/期刊
agentero paper set-meta papers/demo --publication "NeurIPS 2024" --json

# 同时更新出版物、发表日期与 DOI
agentero paper set-meta papers/demo --publication "NeurIPS 2024" --date 2024-12 --doi "10.1234/demo.2024" --json

# 修改标题与作者列表（逗号分隔）
agentero paper set-meta papers/demo --title "New Title" --authors "Alice, Bob, Carol" --json
```

- **持久化机制**：更新操作会实时写入 `catalog.sqlite` 并将 `meta_source` 标记为 `"manual"`，同时原子刷新论文目录下的 `metadata.json`。
- **失效标签清理**：修改 `publication` 时，底层会自动清理历史残留且已不再匹配的 `#easyscholar:` 级别标签。
- 至少需指定一个元数据参数；可通过 `agentero describe paper.set_meta --json` 查看完整契约。

同 Vault 论文移动与桌面、本地 Connector 共用 core 用例：更新文件夹、Catalog/页数路径与已解析的 Wiki 链接；Catalog 提交失败时补偿文件和链接。CLI 为本次操作构建 Wiki 索引，无本进程未保存编辑状态；不能替另一个桌面进程保护未保存内容。移动到当前父目录为成功 no-op。目标父目录不存在时会自动创建；目标已存在或路径逃出 `papers/` 时失败且不改 Catalog：

```bash
agentero paper move papers/inbox/demo papers/archive
# 目标父目录可尚未存在：
agentero paper move papers/inbox/demo papers/new-shelf
```

如果路径以 Vault 根目录开头，则自动识别为跨 Vault 迁移（源 Vault 的 Catalog 记录会被删除并插入到目标 Vault）：

```bash
agentero paper move /path/to/src-vault/papers/inbox/demo /path/to/dst-vault/papers/archive
```

- **文件身份**：论文 id 不随移动改变，目录名、`metadata.json`、PDF/TeX/`marks` 等资产整体迁移；跨 Vault 后目标 Vault 的 Catalog 行沿用同一 id（目标已有同 id 论文时直接失败）。
- **复制/移动语义**：跨 Vault 是移动而非复制。同设备先 `rename`；跨设备回退为复制后删除源目录，复制失败会清理本次创建的目标目录，源 Vault 保持不变，可修正原因后重试。源 Vault 的 `papers/` 下条目在成功后不再存在。
- **桌面同步**：运行中的桌面通过 watcher 与 Catalog 快照跟随。同 Vault 移动把打开中的论文 / NOTES tab、标注与树选中移到新路径；跨 Vault 迁移或外部删除会关闭该论文在源 Vault 的 tab。macOS 的 FSEvents 不保证配对旧/新路径，所以以 Catalog 的 paper id 对比为准，而不是等 rename 事件。桌面未保存的编辑不受保护（该论文目录已整体移走）。

把已有论文加到另一个文件夹或另一个 Vault，源目录保留。路径规则与 `paper move` 相同：

```bash
agentero paper add papers/inbox/demo papers/archive
agentero paper add /path/to/src-vault/papers/inbox/demo /path/to/dst-vault/papers/archive
```

- **同一 Vault**：在目标父目录下建立与源目录同名的目录链接，相对路径指回原论文。`metadata.json`、笔记、PDF 仍是同一份文件。Catalog 不新增行，原路径不变。扫描会跳过这个链接；按链接路径查询时回到原来那条记录。文件树把链接显示为另一个文件夹入口。
- **另一个 Vault**：按真实文件复制论文目录，并在目标 Catalog 写入同一 id 的一行。源若本身是目录链接，复制的是它指向的内容，目标里不留下指回源 Vault 的链接。目标已有同 id 时失败。复制中途失败会删掉本次新建的目标目录。
- **结果**：成功打印 `linked <源> → <目标>` 或 `copied <源> → <目标> (<源 Vault> → <目标 Vault>)`。失败信息同样带上目标路径。`--json` 给出 `mode`（`link` 或 `copy`）、`from`、`newRel`、`fromVault`、`toVault`。
- **限制**：只加一篇论文（目录下要有 `NOTES.md` 或 `metadata.json`），不批量添加整个文件夹。对链接做 `paper delete` / `paper move` 只动链接本身，不删原文件，也不改原 Catalog 行。原论文被移走后链接会失效，这一版不自动改指向。Windows 优先目录软链接；没有创建权限时改用 junction（绝对路径，Vault 换位置后会断）。软链接用相对路径，整个 Vault 一起挪走后仍然有效。

### Cool Papers 笔记（`paper notes fetch`）

把 papers.cool 上的 Kimi 解析追加到论文的 `NOTES.md`，与桌面 NOTES 工具栏的「获取 Cool Paper 笔记」共用 `agentero-core` 实现。追加按内容幂等：同一条解析已在 `NOTES.md` 中时不再重复写入，也不改写手写内容。

```bash
agentero paper notes fetch papers/demo --json
agentero paper notes fetch 1706.03762 --json
```

解析顺序：catalog `sourceUrl`（papers.cool 链接）→ venue catalog id（如 `38818@AAAI`）→ arXiv id → 标题搜索。要求 `{paper}/NOTES.md` 已存在（由 `import` / paper-reader 生成）；未在 papers.cool 命中时返回 `found:false` 且不落盘。首次生成上游解析可能需要数十秒，CLI 同步等待（超时 180s）。

输出 `found` / `appended` / `branch` / `paperId` / `url` / `matchedBy`，可用 `agentero describe paper.notes.fetch --json` 查看完整契约。

### 从命令行打开桌面 App / 工作区

打开整个 Vault：

```bash
agentero open ~/research
agentero ~/research    # 路径简写（已知子命令名优先）
agentero .             # 当前目录
```

CLI 通过 `agentero://open?path=…` 深链唤起已安装的桌面 App；无参数时仍打印 help，不会隐式打开最近 Vault。

#### 工作区操作（`ui`）

`agentero ui` 是 Herdr 式的「窗口管理」面：操作正在运行的桌面工作区，而不是文件系统。所有动作都走同一条投递链——写 `cli-ui-request.json`（Host 每 ~400ms 轮询）→ single-instance socket → `agentero://ui?action=…` 深链 → 必要时拉起 GUI；Host 校验后发 `ui:request` 事件，前端在需要时先切换 Vault，再调用与 UI 相同的打开/关闭原语。

```bash
# 打开或聚焦一个 vault-relative 文档 / 文件夹 / 论文（已开则聚焦同一 tab）
agentero ui open notes/idea.md --json
agentero ui open papers/demo --json

# 关闭某个路径对应的工作区面板（论文会连同 NOTES 一起关）
agentero ui close papers/demo --json

# 打开或聚焦原生子窗口：settings / agent / annotations
agentero ui window agent --json
agentero ui window settings --section layout --json

# 分屏：省略 path 即拆分当前 active pane（等价 ⌘\）；给了 path 则在参考/当前 pane 旁打开
agentero ui split --json
agentero ui split papers/demo --direction below --json
agentero ui split notes/idea.md --direction right --reference papers/demo --json
```

`ui split` 的 `--direction` 取 `right`（默认）/ `left` / `above` / `below` / `within`，`up`/`down` 作为 `above`/`below` 的别名；`--reference` 指定参考 pane（默认当前 active pane），省略 `path` 时走 `splitActivePane()`（论文补 NOTES、TeX 补编译 PDF、否则克隆当前 pane）。

打开**某篇论文**（`ui open` 的论文语义快捷方式）：

```bash
agentero paper open 1706.03762 --json
agentero paper open papers/nlp/attention --json
```

`paper open` 先按优先 path、其次 id 解析论文（与 `paper get` 同一 ref 规则，多 shelf 同 id 时返回 `paper_ambiguous`），再投递 `open-paper` 动作。`AGENTERO_OPEN_DRY_RUN=1` 只校验并打印 `action` / `path` / `window` / `url`，不触达桌面 App（仍会校验路径与窗口名）。

> `ui open/close` 的 path 是 **vault-relative**（与 `openVaultRel` 一致），Vault 由 `--vault` / `AGENTERO_VAULT` / 目录上溯 / 默认 Vault 解析；`ui window` 不需要 Vault。

### 系统外壳集成（右键「用 Agentero 打开」）

除 CLI 外，文件夹也可以直接从系统外壳作为 Vault 打开。两条路径最终都走
`features::open_request::collect_open_args`（GUI argv 支持 `agentero://` URL 与**裸目录路径**，裸路径对空格、`&`、`%`、中文路径无损）：

- **Windows 资源管理器**：NSIS 安装钩子（`src-tauri/nsis/hooks.nsh`，经 `bundle.windows.nsis.installerHooks` 引入）在 `Software\Classes\Directory\shell` 与 `Directory\Background\shell` 下写入 `OpenWithAgentero` 条目，命令为 `"$INSTDIR\agentero.exe" "%1"`；卸载时仅清理指向本安装位置的条目。Win11 新式菜单中条目位于「显示更多选项」。
- **macOS 访达**：Finder 对目录没有「打开方式」，改用 Quick Action。桌面 App 启动时自动安装/刷新 `~/Library/Services/Open with Agentero.workflow`（`features::finder_service`，shell 动作直接调用当前 App 二进制并传裸路径）；用户显式移除后写入配置标记（`finder-service.removed`），启动时不再自动恢复。设置 → 通用 → 系统 提供安装/更新/移除入口；App 移动位置后状态显示为过期，可一键更新。

## 云同步（`sync`）

无桌面环境（服务器等）下的双向 Vault 同步；与桌面端共用 `agentero-core::features::sync` 引擎与 XDG `sync.json` 绑定。S3/WebDAV 的冲突处理（三方合并 + 冲突副本）、条件写降级、断点续传与空转短路语义完全一致；Git 后端走独立的 work-tree 同步（原生 merge、冲突 abort），见 [sync.md](sync.md#git)。

```bash
# 服务器首次接入已有远端库（vault 从未同步过时自动采纳远端 vaultId 完成加入）
agentero vault create ~/papers
AGENTERO_SYNC_ACCESS_KEY=xxx AGENTERO_SYNC_SECRET_KEY=yyy \
  agentero sync configure --vault ~/papers \
    --backend s3 --endpoint https://<account>.r2.cloudflarestorage.com --bucket papers
agentero sync now --vault ~/papers --json      # cron / 助理调用，退出码即成败
agentero sync status --vault ~/papers --json   # lastError 给出上次失败原因
agentero sync test --vault ~/papers --json     # 凭据/桶/条件写连通测试
agentero sync disconnect --vault ~/papers -y   # 解绑（远端数据不动）

# Git：Vault 即 work tree；认证走系统 credential helper / SSH agent
agentero sync configure --vault ~/papers \
  --backend git --git-remote git@github.com:you/papers.git --git-branch main
agentero sync now --vault ~/papers --json
```

- **凭据安全**：secret 不进 argv——flag 只收 endpoint/bucket/prefix 等非敏感字段；secret 来源为 `AGENTERO_SYNC_ACCESS_KEY` / `AGENTERO_SYNC_SECRET_KEY` / `AGENTERO_SYNC_WEBDAV_PASSWORD`、TTY 交互提示（`--json` / 管道下绝不提示），或 `--stdin` 读完整配置 JSON（camelCase，脚本友好，不落 shell history）。所有输出经掩码（`*`），日志与 `remoteIdentity()` 均不含密钥；`sync.json` 以 0600 落盘。
- **并发**：`sync now` 经 `.agentero/sync/lock` 跨进程文件锁与桌面端（及 cron）在同一 Vault 上互斥，冲突时返回 `sync_busy`（退出码 1）；进程崩溃锁自动释放。
- **状态与错误码**：未配置 → `sync_not_configured`；配置非法（缺 secret 等，非交互下无法补提示时错误里附 secret 传入门径）→ `sync_config_invalid`；引擎错误透传 `AppError` 域码。`status` 输出 `configured` / `config`（掩码）/ `lastSyncAt` / `lastVersion` / `lastError`。
- **进度**：`now` 的阶段进度（scan/pull/download/upload/finalize）打 stderr，stdout 始终纯 JSON；text 模式默认显示，`--progress` 在 `--json` 下开启。
- **同步范围**：`configure --exclude pdf,source,attachments` 排除大体积可再生资产（与设置页「同步范围」一致）；笔记、sidecar、marks 永远同步。Git 把同一组排除项写进仓库 `.gitignore`，并取消跟踪。
- **Git**：`--backend git --git-remote <url|path> [--git-branch main]`；不接收 secret flag、不做 TTY 提示，使用系统 Git 凭据。Vault 已有仓库时要求当前分支与 `--git-branch` 一致、`origin` 与配置一致，否则报错。冲突、`.agentero` 被跟踪、历史重写等分别返回 `sync_conflict` / `git_agentero_tracked` / `git_history_rewritten`；推送被非 fast-forward 拒绝会自动重试 fetch+merge+push。

## Doctor

`agentero doctor` 只读聚合 Vault 结构、Catalog schema、双链语义、Catalog 论文 `NOTES.md` aliases，以及 `papers/**/marks/*.json` 视觉批注格式；任一错误/待修项存在时返回 `doctor_issues` 和非零退出码。诊断会尊重设置页写入的 `.agentero/doctor.json` 别名忽略列表（这些路径不计入别名错误）。

### 双链检查

`agentero doctor wiki [<source>] --json` 使用桌面端导航、嵌入、反链和重命名事务共用的 `WikiIndex` resolver，不维护第二套正则解析器。

- 不传 `source`：检查整个 Vault。
- 传 Markdown 文件：只检查该文件，适合 paper-reader 写入后的局部验收。
- 传目录：检查该目录下的 Markdown。
- 输入必须是 Vault 相对路径；命令只读，不创建目标或重写来源。
- 派生正文 `PAPER.md` 保留为可链接目标和标题来源，但不作为出链来源参与检查。
- 全部解析成功时退出码为 0；发现 `missing`、`ambiguous`、`invalidFragment` 时返回非零，错误码为 `wikilink_check_failed`，报告位于 `error.details`。
- 批注双链 `[[target@id]]` / `[[target#@id]]`：按 path 解析 target，并校验 id 形态；**不**读取 `marks/` 判断 id 是否仍存在（与桌面 resolve 一致）。

报告包含 `checkedFiles`、四类状态计数，以及每个问题的 `source`、`line`、`targetRaw`、`syntax`、`embed`、`targetPath?`、`candidates` 和 `context?`。指定单文件作用域后，Vault 中其它历史坏链不会影响本次验收。

### 修复命令

`agentero doctor fix aliases` 在 TTY 中逐篇展示已有 alias，并允许编辑生成的标题 alias / 短 alias，最后进行一次批量确认。`-y` 接受全部安全默认值；`--json` 从不提示，未同时传 `-y` 时返回 `needs_confirmation`。修复会保留已有自定义 aliases，以内容哈希做竞态检查，并作为一个可回滚批次写入。

`agentero doctor fix visual-marks -y` 将旧版 `kind: agent-trace`（扁平 agent 字段）迁移为 `kind: visual` v2（可选嵌套 `agent`），幂等；不改 id 与裁剪图路径。详见 [doctor.md](doctor.md)。

Skill 种子：`templates/vault/.agents/skills/agentero-cli/`，含两个平台变体——`SKILL.md`（POSIX，命令 `agentero`）与 `SKILL-windows.md`（Windows，命令 `agentero-cli`、PowerShell/cmd 语法）。播种时按宿主平台选择变体写入同一个 skill id，skill 目录不随平台变化。
