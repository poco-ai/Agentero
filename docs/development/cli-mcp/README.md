# Agentero CLI 与 MCP 接口设计

本文记录 CLI 与 MCP 的设计依据和验收场景。终端用法见 [CLI 使用说明](../../backend/cli.md)，外部客户端配置见 [MCP 使用说明](../../usage/mcp.md)。运行时的命令解析、帮助和工具清单读取同一份[命令目录](https://github.com/poco-ai/agentero/blob/main/crates/agentero-core/src/ops/cli.json)和[工具定义](https://github.com/poco-ai/agentero/blob/main/crates/agentero-core/src/ops/mcp.json)。

[逐级 CLI 帮助](./cli-reference.md) · [MCP 工具表与调用示例](./mcp-reference.md) · [全部工具的机器可读 schema](https://github.com/poco-ai/agentero/blob/main/crates/agentero-core/src/ops/mcp.json) · [在终端翻阅帮助](./preview.py)

## 从研究者的一次操作开始

你正在读两篇论文，想核对它们使用的 batch size。先判断自己已知什么。

| 手里已有的信息 | 输入 | 得到的下一步 |
|---|---|---|
| 作者、题名、标签、阅读状态 | `agentero paper list --query Atlas --state unread` | 馆藏论文 ID、路径、题名和版本 |
| 一个想在原文找到的说法 | `agentero search "batch size" --in papers/atlas --in papers/orion` | 每条命中都有摘录、来源、位置、版本、可直接使用的 `cite` |
| 一篇论文及页码 | `agentero read papers/atlas --page 8` | 第八个物理页的原文与引用；页码有据可查 |
| 某条搜索命中的引用 | `agentero read "$cite"` | 该命中周围的原文；`agentero app open "$cite"` 在桌面跳回出处 |
| 图、表或公式的位置 | `agentero paper regions papers/atlas --kind table` | 可传给 `read --region` 或 `annotation add --cite` 的区域或引用 |
| 论文间的引用问题 | `agentero paper relations papers/atlas --direction cited-by` | 本地引用缓存中引用该论文的记录与匹配依据 |

找到最相关的一条出处后，可以直接在终端展开。需要显示页码、做批量筛选或保留查询游标的程序可以选择 `--json`。

```sh
agentero search "batch size" --in papers/atlas --limit 1 --plain |
  agentero read - --max-chars 1800
```

一个桌面 Agent 同样可以把实际写好的文件交还给用户。`agentero file write outputs/comparison.md --input ./comparison.md` 返回文件版本，随后 `agentero app present outputs/comparison.md` 返回聊天产物卡片。Markdown 和 PDF 按桌面已有查看器预览；没有对应查看器的类型提供打开文件的动作。普通终端用 `app open` 即可打开同一产物。

## 完整命令地图

共 14 个根入口（含 `help`）、71 项可调用操作（含 `help`）、88 张帮助页（含根与中间分组）。以下用花括号表示下一层；每个名字在 [CLI 参考](./cli-reference.md) 都有自己的帮助、参数与示例。

```text
search
read
paper {list, get, import {id, pdf, bib}, discover, export, update, tag {list, add, remove, set}, note {append, replace, fetch}, relations, regions, download, extract, analyze, link, copy}
file {list, write, move, remove, trash {list, restore, purge}}
annotation {list, get, add, update, remove}
table {query, upsert, patch}
feed {list, add, refresh, item {list, mark}, remove}
translate
vault {list, info, create, check, repair}
sync {status, connect {s3, webdav, git}, test, run, disconnect}
app {open, views, split, close, window, present}
delegate {targets, run, result, cancel}
mcp {serve, tools}
help
```

## 哪些规则来自 clig.dev

| 指南 | 在 Agentero 里的具体决定 |
|---|---|
| 帮助靠近操作，给出实际例子，缺参提示下一步 | 裸 `agentero` 与裸分组显示短帮助；`-h`、`--help` 和 `help <path>` 显示完整页；`help <path> --json` 提供对应子树。未知命令提示最接近名称，始终由用户选择执行。[Help](https://clig.dev/#help) |
| 资源与动作的排列保持一致，优先清晰的名字 | 命令族采用单数资源 + 动词，如 `paper get`、`file move`。高频且能一句话解释的跨资源任务直接用 `search`、`read`、`translate`。`get` 返回结构，`read` 返回可引用内容，`open` 会改变桌面焦点。[Subcommands](https://clig.dev/#subcommands) |
| 明确的位置参数和可发现的长选项，支持标准输入 | `paper get PAPER` 的目标放位置参数；范围和可选行为用 `--in`、`--page`。多行或二进制输入支持 `--input -`；参数含前导连字符时可用 `--` 结束选项解析。[Arguments and flags](https://clig.dev/#arguments-and-flags) |
| 输出既能让人阅读，也便于组合 | TTY 显示简短表格和下一步；脚本用 `--json`。结果到 stdout，进度与诊断到 stderr；支持 `NO_COLOR`。参考文献导出、文本读取和翻译可直接重定向。[Output](https://clig.dev/#output) |
| 只在终端提问；失败要告诉用户如何恢复 | 无 TTY、`--json` 或 `--no-input` 都禁用交互；需要的确认或参数缺失立即失败。高风险操作支持显式确认、可行的预览或版本前置条件。[Interactivity](https://clig.dev/#interactivity) · [Errors](https://clig.dev/#errors) |

单数资源名、命令数量、默认页长、错误码和 MCP 权限划分是本项目的设计决定。MCP 的工具发现、schema、结构化输出与错误语义参考其官方协议。[MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

## CLI 公共契约

**第一次使用。** 裸根命令或裸命令组打印用途、常用示例和继续查看完整帮助的命令，退出 0。显式帮助在读取配置、打开 Vault、访问网络或申请写锁之前处理。对已识别命令，把 `-h` 补到一条缺参甚至参数无效的命令上也能看到完整帮助，例如 `agentero file remove drafts/a --bogus -h`。独立的 `--` 结束选项解析，之后的 `-h` 可以是文件名。未知命令退出 2，只建议最接近的拼写。根帮助列出在线文档及反馈地址，叶命令的示例放在参数表之前。[Help](https://clig.dev/#help) · [Subcommands](https://clig.dev/#subcommands)

**把终端输出作为下一条命令的输入。** `search --plain` 每行一个不透明的 cite URI，`paper list --plain` 每行一个单行论文 ID。两者均为 UTF-8、以 LF 分隔，无标题、颜色、省略号和进度行，只输出本次请求的结果页；空集合产生零字节并退出 0。`--plain` 仅这两项支持，和 `--json` 同时出现时退出 2。`read -` 从 stdin 到 EOF 接收一个非空来源标识，接受末尾 LF/CRLF；零项返回 `source_not_found`（3），多项返回 `expected_one_source`（2），提示在上游加 `--limit 1`。TTY 上直接输 `read -` 时提示传入来源或连接管道并退出 2。在 Bash/zsh 中，需要保留上游错误的脚本可使用 `set -o pipefail` 并分别检查各段退出状态。[Output](https://clig.dev/#output) · [Arguments and flags](https://clig.dev/#arguments-and-flags)

**选择工作区。** 普通终端按 `--vault`、`AGENTERO_VAULT`、当前目录最近的 Vault 祖先依次选择。仍未选定时，需库的操作返回 `vault_required`，并建议 `vault list`；`help`、`--version`、`vault list/create`、`feed`、`translate`、在线发现等可以在库外工作。桌面托管的 CLI 使用宿主绑定的 Vault。用户传入其它库不能改变当前回合的授权。`file` 命令的路径相对 Vault 根，`--input`、`--output` 与本地导入路径相对调用进程当前目录。路径含空格正常引用，Windows 接受原生路径，输出的库内路径统一用 `/`。

**身份。** `paper` 参数接受唯一馆藏 ID 或库内目录，同一标识匹配多个目录返回候选。`source` 可是论文、目录、UTF-8 文件或不透明引用 URI；显式库内路径优先按路径解析，引用包含库标识和定位信息。`app close/split` 使用 `app views` 返回的面板 ID；窗口参数使用 Tauri label。Markdown 行号、PDF 物理页码和命中序号均从 1 起。矩形坐标归一化至页面，可选的 `box` 顺序为 `[x,y,width,height]`，原点在未旋转页面左上角。材料没有页定位时返回行号、章节或区域标识。

**输出及错误。** 默认文本查询显示紧凑表格；自动模式按输出流分别检测 TTY。重定向的结果不使用分页器或 ANSI 控制字符。`read` 和 `translate` 默认 stdout 为可重定向的正文；位置与截断提示在终端的 stderr。`--json` 成功时 stdout 仅一个 UTF-8 JSON 对象及换行，`paper export --json` 把内容放进 `content`；显式输出到文件时只回 `path`、格式与数量。单项失败时 stdout 为空，stderr 给出错误；JSON 模式错误为 `{"error":{"code":"…","message":"…","details":{},"hint":"…"}}`。明确标为批处理的导入、订阅刷新或同步可以部分完成，stdout 保留逐项结果，stderr 给总体失败。`--quiet` 只去掉进度。`NO_COLOR` 或管道让 auto 关闭颜色，显式 `--color` 的优先级更高。全局参数可在子命令前后出现，重定向诊断用 `2>`。`mcp serve --transport stdio` 的 stdout 始终属于协议，日志与就绪提示只到 stderr。

| 退出码 | 调用者应怎样处理 |
|---|---|
| 0 | 成功，包括空集合、已经存在的幂等结果、显式请求帮助 |
| 1 | 操作失败、诊断发现问题或批次有失败项，见具体错误码 |
| 2 | 参数、缺失输入或命令语法错误，查当前级帮助 |
| 3 | 已知类型的目标找不到；`missing_layout` 给出 `paper analyze` 下一步 |
| 4 | 版本冲突、名称歧义、目标已存在或引用已过期，按候选或新版本处理 |
| 5 | 超出授权、库未授予或需要显式确认 |
| 6 | 所需宿主、服务、网络或锁暂不可用；`details.retryable` 告知可否重试 |
| 130 | 用户中断；长任务报告已经提交的项，正常收尾后返回 |

**错误后的下一步。** 人类模式的第一行说明动作、目标和原因，第二行给出可以执行的恢复步骤。读过期引用时提示以原检索词重新 `search`；条件写入返回 `revision_conflict` 时提供读取该对象的命令，保留原文件内容。JSON 模式下进度默认关闭；单次失败或批次部分成功时，stderr 只写一个可解析的错误对象。部分成功的批次退出 1，stdout 同时保留逐项结果；调用者据此只重试失败项。错误提示和示例不打印凭据。[Errors](https://clig.dev/#errors)

**取消与恢复。** 正在导入、分析或同步时，第一次 Ctrl-C 立即在交互终端的 stderr 告知正在停止，停止领取下一项，给当前原子步骤有限的收尾时间。第二次 Ctrl-C 或收尾超时可立即退出；已提交的项可按自然键或请求 ID 查询，下一次运行检查未完成的移动和同步记录。调用方关闭输出管道时，纯查询停止生成后续结果。取消本地 `delegate result --wait` 只结束等待，远端任务由 `delegate cancel JOB` 显式取消。[Signals and control characters](https://clig.dev/#signals-and-control-characters) · [Robustness](https://clig.dev/#robustness)

**分页和预算。** 列表返回 `items` 与 `next_cursor`。原文返回 `truncated`、`next_cursor`、`revision`、`evidence`，实际内容随类型为 `text`、`entries`、`metadata` 或 `regions`。重复原条件并带 `--cursor` 读取下一段，游标绑定库、查询、读取范围和索引/资源版本；条件改变返回 `invalid_cursor`，版本失效返回 `stale_cursor`。按引用读取发现原文已变，返回 `stale_citation` 与重新定位入口。省略分页的列表操作在帮助中有明确结果类型。`max-chars` 为单次输出预算；托管回合与外部 MCP 可施加更小的总预算，后端返回真实截断标记。当调用者无权继续读取时，`next_cursor` 为 null。

**输入和修改。** 重复的选项按出现顺序收集；示例中的 `--tag a --tag b` 与 `--kind figure --kind table` 的交并规则分别见命令。布尔开关默认关闭。`--input -` 显式读取 stdin，TTY 中没有内容参数不会无限等待。`if_revision` 绑定具体对象，不能把论文题录版本用作 NOTES.md 版本。读缺失笔记返回空内容及 `revision="missing"`，可以据此首次创建。终端单次写入可以省略请求 ID，由 CLI 生成；希望跨进程可靠重试时显式传入。MCP 对需要幂等的追加、批注创建和表格写入要求调用者提供请求 ID。幂等键在库、操作、调用者和目标内校验，先检查同键回执再检查版本，内容变化报 `idempotency_conflict`。单一文件写入以临时文件换名；表格一批全成或全败。跨库移动记录源/目标操作进度，目标验证成功才清理源，重试可收敛。回收站是删除的第一目的地，按回收 ID 恢复或显式永久清除。禁止通过通用文件命令直接改 Catalog、批注/版面索引、已存在的表及锁定实验记录。

**机器输入示例。** `table upsert --input` 读 `{"rows":[{"id":"trial-0003","fields":{"split":"test","score":0.9}}]}`，每批 1–200 行。新增行 ID 使用 ASCII 字母开头的字母数字前缀、连字符和至少四位数字，如 `trial-0003`。更新旧行时直接使用查询结果中的 ID。`table patch --input` 读 `{"cells":[{"id":"trial-0003","field":"split","value":"test"}]}`，每批 1–1000 格。普通字段值为 JSON 标量。`sync connect s3 --credentials-input` 接受 `{"access_key":"…","secret_key":"…","session_token":"…"}`（session token 可选），WebDAV 接受 `{"password":"…"}`。不提供文件时从系统凭据存储取值，交互终端可以隐藏输入；自动化用受保护的文件或 stdin 注入凭据。`--profile` 与 `--embedding-profile` 选择本机已配置的服务、端点和模型；密钥不出现在参数、帮助示例或结果中。

## 删除 agentero-context 后的执行路径

| 场景 | 执行路径 | 需要保留的产品行为 |
|---|---|---|
| 独立终端或能执行 shell 的本机 Agent | CLI → typed Rust 操作 → Vault / Catalog | 显式选择库，可完全 headless 搜、读、写、导入与导出；桌面专属命令清楚报需要宿主 |
| 侧栏或 Zen 中有 shell 的 Agent | 宿主给当前回合配置 CLI 可执行路径与短期回合句柄 → CLI → 核心服务 | 授权材料、预算、实际使用的出处、取消、过期和 Zotero/PDF 定位按回合隔离。搜索和读取以相同的引用格式供消息回跳 |
| 仅能收发提示的 Agent | 宿主在发送前用相同核心按预算预取 | 可带初始选区与少量证据，无法自主多轮调用；UI 明示当前能力 |
| 外部 MCP 客户端 | stdio 或 loopback HTTP → 唯一公开 MCP 服务 → 同一核心 | 一套 tools/list，按该连接的授权过滤；可独立使用，无需启动桌面或嵌套执行 CLI |
| SSH 委派 | 本机 `delegate` → 已连接的桌面 SSH 宿主 → 远端任务 | target/job 的生命周期与研究数据工具分开。远端执行器只使用远端可用的 CLI 与授权；已有纯提示场景能执行到哪一步需按 harness 实测 |

会话 MCP 的三项业务整体落到 `search`、`read`、`paper relations`。专用 stdio worker、ACP 注入和重复工具定义可以删除。远端委派原有的专用注入也可在支持 shell 的 harness 改用 `delegate` 四项；它与对外库访问是两个不同用例。桌面建议随包分发同版本 CLI，用户是否把命令加入全局 PATH 与桌面能否读论文各自独立。grant 由宿主签发及校验，宿主向它启动的 CLI 传入不可伪造的短期句柄，核心在每次读写及续读时验证回合、Vault、来源与预算，完成、取消和切库时撤销句柄；它约束 Agentero 业务调用，任意 shell 的文件系统隔离仍取决于 harness 自身。产物卡片同样用回合绑定，进程 PID、当前窗口焦点或最近一次打开的库都不能充当归属依据。

长驻 ACP 进程的环境变量属于进程生命周期。侧栏与 Zen 同时工作时，宿主要按会话隔离 CLI 启动环境，并在每个回合绑定或撤销当前句柄。若 harness 只能在启动时注入环境，且无法把每次调用归到唯一在途回合，就为该回合创建独立执行环境；权限指纹变化时重新绑定。来源清单由核心记录实际返回给模型的证据，桌面按回合读取回执；仅在提示里提及过、搜索未命中或读取失败的材料不能算作已引用。

## 实施顺序与验收

1. **先做一条能跑通的研究链。** 在 `agentero-core` 复用现有 context 搜索、读取和关系服务，定义 PaperRef、EvidenceRef、Locator、Revision、Cursor 及领域错误。先实现 `paper list/get`、`search`、`read` 和桌面 `app open CITE`，随后用 `paper regions/relations` 扩展同一条证据链。验收用两篇有同名章节的论文、一份只有 PDF 的论文和普通笔记，完成“找到引文 → 读准确页 → 桌面回跳”，包括材料变更、空命中、无版面及范围外目标。
2. **让 CLI 和 MCP 共享参数与业务处理。** Clap 专管终端语法与 stdin；MCP 适配器专管 schema、权限、协议响应。以共享 Rust DTO 和能力表生成帮助索引及 MCP schema，通过适配器直接调同一操作。把仍在 MCP crate 中的文件、笔记和分页读取业务下沉。在同一临时 Vault 验证相同输入产生同一数据、错误与写后状态，另测外部未授权全文时经文件、搜索游标和布局路径都遵守限额。
3. **补齐科研写入及运维。** 依次实现笔记与批注、表格与文件回收、导入导出、发现、订阅、同步和诊断；最后接桌面视图、产物与委派。验收包含重复追加、并发覆盖、丢失响应后重放、锁定实验记录、批次部分失败、跨库移动中断、Windows 路径，以及重启后回收恢复。
4. **替换桌面会话接入。** 随包 CLI、回合授权、证据使用回执和可点击出处一起交付，侧栏与两个并行 Zen 会话都走实际 harness。验证没有外部 MCP 监听、首次离线启动、路径含空格、切 Vault、续聊、取消以及无 shell 模式。验证后移除 `agentero-context` 的进程入口、工具注册、启动参数、ACP 挂载与专用提示，更新 bundled skill。独立 SSH 委派按实际支持的 harness 验收。
5. **发布前校验用户看到的合同。** 递归执行正式二进制 `--help`；校验实际 tools/list 与 schema，校验 CLI/MCP 成功、业务错误、权限和非 TTY 管道；按改动运行 core/CLI/MCP 定向测试及真实桌面流程。涉及 Tauri IPC、事件或前端依赖时，按仓库要求生成 bindings、做事件登记与前端依赖检查。

### 首个可交付切片

先交付一条研究者可以独立完成的短路径。CLI 支持 `paper list/get`、`search`、`read`，桌面支持 `app open CITE`。同一阶段交付对应的 MCP 检索和读取入口，用同一份临时 Vault 对照验证。随后接入区域与引用关系。直到两条调用路径和桌面回跳都通过，才切换侧栏和 Zen 的会话工具。

| 验收场景 | 可观察的通过条件 |
|---|---|
| 首次使用与命令拼写 | 在空目录、断网、没有配置时，根和叶帮助都能显示。给删除命令附加无效业务选项与 `-h`，退出 0，Vault 无写入。误拼命令退出 2，并给下一步。 |
| 从论文找到证据 | 两篇论文包含相同术语，但第二篇的匹配位置没有物理页码。搜索到的每个 cite 都能展开至相应位置；桌面分别打开实际 PDF 页或文本行。 |
| 终端、管道与重定向 | 用真实 PTY 与单独捕获的 stdout/stderr 各跑一次。对零、一、两条命中分别验证 `read -` 的退出码；把 JSON 输出交给解析器，检查 stderr 错误对象和普通文本换行。 |
| CLI 与 MCP 等价 | 对相同授权分别用 `--page 2-3,8` 和 `pages:[2,3,8]` 读取，对比页序、原文、引用及截断。传入倒序区间、越界页和无全文授权时不返回正文。 |
| 写入被打断 | 批量导入完成首项后发送 SIGINT，凭实际回执或馆藏重新执行；首项不重复、后续项能继续。表格条件写入遇到竞争时返回当前版本，数据仍可读取。 |
| 删除专用 MCP | 关闭外部 MCP、离线启动桌面，在两个 Zen 会话中分别阅读不同论文。切库或取消后旧句柄失效，来源进入各自的消息。对支持的系统验证随包 CLI 的定位和启动。 |

文档试读器可以离线浏览设计示例。实际命令请在仓库根目录运行 `cargo run -p agentero-cli -- read --help`。

可复用的源码入口包括 [CLI 入口](https://github.com/poco-ai/agentero/blob/main/cli/src/main.rs)、[MCP 路由](https://github.com/poco-ai/agentero/blob/main/crates/agentero-mcp/src/operations/mod.rs)、[证据服务](https://github.com/poco-ai/agentero/blob/main/crates/agentero-core/src/features/evidence/mod.rs) 与 [SSH 委派边界](../A2A.md)。
