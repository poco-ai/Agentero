# CLI（`agentero`）

Headless Vault / Catalog / Wiki 接口；**不含** BYOA / paper-reader。

## 位置

- 目录：`cli/`（crate `agentero-cli`）
- path 依赖 `agentero-core`（**不**依赖 `agentero_lib`，依赖树无 tauri/wry/tao）：`features::{vault,catalog,import,wiki,zotero,feeds,translate,doctor,trash,pdf_locate,open_request}` + 顶层 `{error,fs}`
- 可选同版本 CLI 安装（不随桌面安装包打入，减小体积 [#285](https://github.com/poco-ai/Agentero/issues/285)；open/deep-link 仍见 [#165](https://github.com/poco-ai/Agentero/issues/165) / [#166](https://github.com/poco-ai/Agentero/issues/166)）
  - 设置 → 关于：**安装 CLI** 从 GitHub Release 下载与 App **同版本** 的 `agentero-cli-{ver}-{triple}` 归档，校验 `.sha256` 后写入用户目录并创建 PATH shim。POSIX 写 `~/.local/bin/agentero` 软链（不静默改 shell rc）；Windows 写 `agentero-cli.cmd` 并**自动把安装目录加入用户 PATH**（`HKCU\Environment`，广播 `WM_SETTINGCHANGE`，无需重启，新开终端即可用 `agentero-cli`）。下载 404 的错误文案会带上完整资产 URL（含宿主 triple），架构/版本不匹配时自解释；`CliInstallStatus.commandName` 供前端按平台展示验证命令
  - 独立 CLI 归档仍随每次 Release 发布，供无桌面的 headless 机器使用；macOS 亦可通过 Homebrew tap `poco-ai/agentero` 安装 headless CLI
  - **更新后自动同步**：应用内更新只替换 GUI 包；更新重启后的新进程在 main window 启动时检测已安装 shim（`installed && !shimCurrent`，见 `syncInstalledCliWithApp`），自动重新下载同版本 CLI 并刷新 shim（Host 按编译期 App 版本下载校验，旧进程无法预装新版 CLI，故只能在新进程里同步）。成功静默，失败 `notifyError` Toast；dev 环境与未安装 CLI 时跳过

## 命令组

| 组 | 用途 |
|---|---|
| `open` | 在桌面 App 打开本地目录为 Vault（`agentero open <PATH>`；简写 `agentero <PATH>`） |
| `vault` | create / list 等 |
| `describe` | Agent 自省：策展型 op 目录与单 op 的 input/output/errors/examples（机器契约真源） |
| `paper` | list/get、tag list/set/add/rm、move、download/parse… |
| `import` | 标识符入库 |
| `export` | 导出 |
| `doctor` | Vault 结构与 Catalog 诊断；含 wikilink 检查与 aliases / 视觉批注 / catalog 去重修复 |
| `layout` | 侧栏同构版面索引：`list` / `get`（figure / table / algorithm / formula / section） |
| `mark` | 阅读标注：`list` / `get` / `add`（`--quote` 文字锚点或 `--region` 区域锚点）/ `update` / `delete` |
| `translate` | 免费机器翻译纯文本（无需 API Key，不读桌面 settings） |

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
| `section` | 章节 / 段落标题，实时从 `source/layout.json` 的 `kind=header` 区域合并 |

无 `layout-index.json` 时返回 `layout_index_missing`（提示先在 App 打开论文跑版面分析）。

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
# 桌面安装包不内置 CLI（已移除 `externalBin`，安装目录不会出现占位 agentero-cli.exe）；
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

`agentero vault create <PATH>` 会把 Vault 绝对路径记录到 `~/.config/agentero/config.toml` 的 `known_vaults` 数组中（去重追加）。`agentero vault list` 可列出这些已知 Vault，并标出当前 `default_vault`：

```bash
agentero vault list
agentero vault list --json
```

该配置与 GUI 设置隔离，可直接编辑 `config.toml`：

```toml
default_vault = "/Users/philfan/l/paper"
known_vaults = ["/Users/philfan/l/paper", "/Users/philfan/l/video-acc"]
```

## 论文导入

`import id` 通过标识符（arXiv ID / DOI / URL / 标题等）解析元数据并创建论文单元，同时尝试下载 PDF / arXiv TeX 等资源。默认放到 `papers/` 下，可用 `--parent` 指定 vault 内的父目录：

```bash
# 默认 parent = papers
agentero import id 1706.03762 --json

# 放到指定分类目录（不存在时会自动创建）
agentero import id 1706.03762 --parent papers/nlp --json
```

`--parent` 是 **vault-relative** 的父目录，最终论文目录名由 resolver 根据论文 ID 决定，不是完全自定义路径。导入成功后会返回 `path`、`id`、`title` 以及 `pdf` / `tex` / `paperMd` 等资源旗标。

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

### 从命令行打开桌面 App

```bash
agentero open ~/research
agentero ~/research    # 路径简写（已知子命令名优先）
agentero .             # 当前目录
```

CLI 通过 `agentero://open?path=…` 深链唤起已安装的桌面 App；无参数时仍打印 help，不会隐式打开最近 Vault。

### 系统外壳集成（右键「用 Agentero 打开」）

除 CLI 外，文件夹也可以直接从系统外壳作为 Vault 打开。两条路径最终都走
`features::open_request::collect_open_args`（GUI argv 支持 `agentero://` URL 与**裸目录路径**，裸路径对空格、`&`、`%`、中文路径无损）：

- **Windows 资源管理器**：NSIS 安装钩子（`src-tauri/nsis/hooks.nsh`，经 `bundle.windows.nsis.installerHooks` 引入）在 `Software\Classes\Directory\shell` 与 `Directory\Background\shell` 下写入 `OpenWithAgentero` 条目，命令为 `"$INSTDIR\agentero.exe" "%1"`；卸载时仅清理指向本安装位置的条目。Win11 新式菜单中条目位于「显示更多选项」。
- **macOS 访达**：Finder 对目录没有「打开方式」，改用 Quick Action。桌面 App 启动时自动安装/刷新 `~/Library/Services/Open with Agentero.workflow`（`features::finder_service`，shell 动作直接调用当前 App 二进制并传裸路径）；用户显式移除后写入配置标记（`finder-service.removed`），启动时不再自动恢复。设置 → 关于 提供安装/更新/移除入口；App 移动位置后状态显示为过期，可一键更新。

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
