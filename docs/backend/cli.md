# CLI（`agentero`）

Headless Vault / Catalog / Wiki 接口；**不含** BYOA / paper-reader。

## 位置

- 目录：`cli/`（crate `agentero-cli`）
- path 依赖 `agentero_lib`：`features::{vault,catalog,import,wiki}` + `core::{error,fs}`
- 可选同版本 CLI 安装（不随桌面安装包打入，减小体积 [#285](https://github.com/poco-ai/Agentero/issues/285)；open/deep-link 仍见 [#165](https://github.com/poco-ai/Agentero/issues/165) / [#166](https://github.com/poco-ai/Agentero/issues/166)）
  - 设置 → 关于：**安装 CLI** 从 GitHub Release 下载与 App **同版本** 的 `agentero-cli-{ver}-{triple}` 归档，校验 `.sha256` 后写入用户目录并创建 PATH shim。POSIX 写 `~/.local/bin/agentero` 软链（不静默改 shell rc）；Windows 写 `agentero-cli.cmd` 并**自动把安装目录加入用户 PATH**（`HKCU\Environment`，广播 `WM_SETTINGCHANGE`），新开终端即可用 `agentero-cli`
  - 独立 CLI 归档仍随每次 Release 发布，供无桌面的 headless 机器使用；macOS 亦可通过 Homebrew tap `poco-ai/agentero` 安装 headless CLI

## 命令组

| 组 | 用途 |
|---|---|
| `open` | 在桌面 App 打开本地目录为 Vault（`agentero open <PATH>`；简写 `agentero <PATH>`） |
| `completion` | 生成 / 安装 shell 自动补全（bash / zsh / fish / powershell / elvish） |
| `vault` | create / which / info 等 |
| `tree` | 列树 |
| `paper` | list/get、tag list/set/add/rm、move、download/parse… |
| `trash` | list / restore / purge 本地回收站 |
| `import` | 标识符入库 |
| `export` | 导出 |
| `config` | 配置 |
| `wiki` | 只读双链语义检查 |
| `doctor` | 聚合诊断与显式确认的论文 aliases / 视觉批注格式修复 |
| `layout` | 侧栏同构版面索引：`list` / `get`（figure / table / algorithm / formula） |
| `mark` | 阅读标注：`list` / `get` / `add`（`--quote` 文字锚点或 `--region` 区域锚点）/ `update` / `delete` |
| `translate` | 免费机器翻译纯文本（无需 API Key，不读桌面 settings） |
| `usage` | 本机活动日志：`which` / `timeline` / `summary` / `clear`（XDG `usage.sqlite`） |
| `feed` | 广场订阅：`add` / `list` / `remove`（XDG `feeds.sqlite`，与 UI 共用） |
| `mcp` | 面向外部 AI 客户端的标准输入/输出 MCP 服务：论文入库、论文检索与仅追加式笔记写入 |

稳定 `--json` 输出，供脚本与外部 Agent 组合。JSON 默认 **compact 单行**（省 token），`--pretty` 恢复缩进美化（[#367](https://github.com/poco-ai/Agentero/issues/367)）。

`paper list --json` 默认每行只含 `id/path/title`；用 `--fields year,tags,abstract,…`（逗号分隔、可重复）按需加字段，或 `--full` 输出完整 `PaperRecord`。未知字段报 `usage` 错误并列出合法字段。text 表格输出不受影响。

## MCP：让 ChatGPT 等客户端使用本地 Vault

`agentero mcp` 会在 **stdio** 上运行 Model Context Protocol 服务。该模式的 stdout 只输出 newline-delimited JSON-RPC 消息，适合由支持 stdio MCP 的桌面客户端或本地桥接器启动；不要在同一 stdout 通道中混入 shell 提示、调试输出或普通 CLI JSON。

将命令配置为 MCP server 时，必须传入目标 Vault 的绝对路径，避免客户端在错误的工作目录中解析 Vault。命令名沿用平台安装形式：POSIX 通常为 `agentero`，Windows 安装后的命令为 `agentero-cli`。

```json
{
  "mcpServers": {
    "agentero": {
      "command": "agentero",
      "args": ["--vault", "/absolute/path/to/research-vault", "mcp"]
    }
  }
}
```

| MCP 工具 | 功能 | 写入语义 |
|---|---|---|
| `agentero_import_paper` | 从 arXiv ID、DOI、URL 或其他支持的标识符导入论文 | 复用既有入库与 Catalog 管线，创建论文单元与可用资源 |
| `agentero_list_papers` | 按关键词、标签、阅读状态或 Catalog 状态检索论文 | 只读 |
| `agentero_get_paper` | 读取一篇论文的结构化 metadata 与本地资源可用性 | 只读，不返回论文或笔记全文 |
| `agentero_append_note` | 向论文 `NOTES.md` 写入一段完整 Markdown | **只追加**；绝不替换已有文字；相同内容重复调用会返回成功但不再写入 |

`agentero_append_note` 专为“笔记代写”设计：客户端应先让用户确认目标论文和写入内容，再调用工具。工具返回的业务失败放在 MCP 的 `isError: true` 工具结果中，并保留 Agentero 的稳定错误码，方便模型更正参数或请求用户澄清。

### 版面索引与区域批注（已实现）

侧栏 Figures 同源列表落在 `{paper}/source/layout-index.json`（由桌面版面分析在 merge 后写入；raw 仍为 `source/layout.json`）。

```bash
# 列出图 / 表 / 算法 / 公式（--kind 可重复，OR）
agentero layout list papers/demo --json
agentero layout list papers/demo --kind figure --kind formula --json
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

阅读器侧：打开论文时导入 `annotations.json`，并监听该文件的**外部**变更增量导入，
所以论文开着时跑 CLI 也能在 1~2 秒内看到黄底（见 [frontend/pdf.md](../frontend/pdf.md)）。

```bash
# CLI 以 `default-features = false` 依赖 `agentero_lib`，headless 构建不走 tauri-build，无需 externalBin 占位。
# 但桌面 `pnpm tauri dev` / `pnpm tauri build` 仍要求 src-tauri/binaries 存在，首次/干净树需先占位：
pnpm cli:bundle:stub   # 或 pnpm cli:bundle
cargo build -p agentero-cli
cargo run -p agentero-cli -- vault which --json
cargo run -p agentero-cli -- wiki check papers/demo/NOTES.md --json
cargo run -p agentero-cli -- doctor --json
cargo run -p agentero-cli -- layout list papers/demo --json
cargo run -p agentero-cli -- completion zsh
cargo test -p agentero-cli
```

## 论文与 Tag

Tag 写入支持桌面端相同的 8 色后缀格式：

```bash
agentero paper tag add papers/demo "survey:blue"
agentero paper tag set papers/demo "nlp:green" "must-read:orange"
```

只有合法颜色后缀会被解析为颜色；例如 `owner:alice` 仍是普通 Tag 名称。

`@zotero:` 是 Connector 内部标签，默认不参与论文列表筛选和 Tag 汇总；需要包含它们时传 `--all`：

```bash
agentero paper list --tag topic
agentero paper list --tag "@zotero:imported" --all
agentero paper tag list --all
```

`paper delete` 默认移入可恢复回收站；明确传 `--files` 才会物理删除。回收站操作：

```bash
agentero trash list
agentero trash restore <batch-id> <stored>
agentero -y trash purge <batch-id> <stored>
agentero -y trash purge
```

论文移动会更新文件夹和 Catalog 路径。目标父目录不存在时会自动创建；目标已存在或路径逃出 `papers/` 时失败且不改 Catalog：

```bash
agentero paper move papers/inbox/demo papers/archive
# 目标父目录可尚未存在：
agentero paper move papers/inbox/demo papers/new-shelf
```

### 从命令行打开桌面 App

```bash
agentero open ~/research
agentero ~/research    # 路径简写（已知子命令名优先）
agentero .             # 当前目录
```

CLI 通过 `agentero://open?path=…` 深链唤起已安装的桌面 App；无参数时仍打印 help，不会隐式打开最近 Vault。

## Shell 自动补全

`agentero completion <SHELL>` 向 stdout 打印补全脚本（始终是原始脚本，即使带了 `--json`）。`--install` 把脚本写入用户目录，**不**改 shell rc。

```bash
# 打印脚本
agentero completion zsh
agentero completion bash
agentero completion fish

# 写入用户补全目录（不改 rc）
agentero completion zsh --install
agentero completion bash --install
agentero completion fish --install
```

| Shell | `--install` 路径 | 是否自动加载 |
|---|---|---|
| bash | `~/.local/share/bash-completion/completions/agentero` | bash-completion 2.8+ 会自动加载 |
| zsh | `~/.zfunc/_agentero` | 需把 `~/.zfunc` 加进 `fpath` 后 `compinit` |
| fish | `~/.config/fish/completions/agentero.fish` | 自动 |
| powershell | `~/.config/powershell/Completions/agentero-cli.ps1` | 需在 `$PROFILE` 里 `.` source |
| elvish | `~/.config/elvish/lib/agentero.elv` | 需在 `rc.elv` 里 `use agentero` |

zsh 若尚未配置 `fpath`，在 `~/.zshrc` 加：

```zsh
fpath=(~/.zfunc $fpath)
autoload -Uz compinit && compinit
```

Windows 安装后命令名是 `agentero-cli`，可显式指定：

```powershell
agentero-cli completion powershell --install --bin-name agentero-cli
```

补全会带上子命令、全局 flag，以及已声明的枚举值（如 `layout --kind`、`mark --mark-color`）。路径参数带 `ValueHint`，由 shell 按目录/文件补全。

## 双链检查

`agentero wiki check [<source>] --json` 使用桌面端导航、嵌入、反链和重命名事务共用的 `WikiIndex` resolver，不维护第二套正则解析器。

- 不传 `source`：检查整个 Vault。
- 传 Markdown 文件：只检查该文件，适合 paper-reader 写入后的局部验收。
- 传目录：检查该目录下的 Markdown。
- 输入必须是 Vault 相对路径；命令只读，不创建目标或重写来源。
- 派生正文 `PAPER.md` 保留为可链接目标和标题来源，但不作为出链来源参与检查。
- 全部解析成功时退出码为 0；发现 `missing`、`ambiguous`、`invalidFragment` 时返回非零，错误码为 `wikilink_check_failed`，报告位于 `error.details`。
- 批注双链 `[[target@id]]` / `[[target#@id]]`：按 path 解析 target，并校验 id 形态；**不**读取 `marks/` 判断 id 是否仍存在（与桌面 resolve 一致）。

报告包含 `checkedFiles`、四类状态计数，以及每个问题的 `source`、`line`、`targetRaw`、`syntax`、`embed`、`targetPath?`、`candidates` 和 `context?`。指定单文件作用域后，Vault 中其它历史坏链不会影响本次验收。

## Doctor

`agentero doctor` 只读聚合 Vault 结构、Catalog schema、双链语义、Catalog 论文 `NOTES.md` aliases，以及 `papers/**/marks/*.json` 视觉批注格式；任一错误/待修项存在时返回 `doctor_issues` 和非零退出码。诊断会尊重设置页写入的 `.agentero/doctor.json` 别名忽略列表（这些路径不计入别名错误）。

`agentero doctor fix aliases` 在 TTY 中逐篇展示已有 alias，并允许编辑生成的标题 alias / 短 alias，最后进行一次批量确认。`-y` 接受全部安全默认值；`--json` 从不提示，未同时传 `-y` 时返回 `needs_confirmation`。修复会保留已有自定义 aliases，以内容哈希做竞态检查，并作为一个可回滚批次写入。

`agentero doctor fix visual-marks -y` 将旧版 `kind: agent-trace`（扁平 agent 字段）迁移为 `kind: visual` v2（可选嵌套 `agent`），幂等；不改 id 与裁剪图路径。详见 [doctor.md](doctor.md)。

Skill 种子：`templates/vault/.agents/skills/agentero-cli/`，含两个平台变体——`SKILL.md`（POSIX，命令 `agentero`）与 `SKILL-windows.md`（Windows，命令 `agentero-cli`、PowerShell/cmd 语法）。播种时按宿主平台选择变体写入同一个 skill id，skill 目录不随平台变化。
