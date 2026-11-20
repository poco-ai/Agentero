# Agentero CLI

独立归档的入口是 `agentero`。桌面 Agent 直接使用同版本随包程序，可以离线工作。桌面设置安装终端命令时，先将 CLI 与 PDFium 放入用户数据目录 `Agentero/cli/v-<版本>/`，再创建指向这里的启动器（macOS/Linux 为 `agentero`，Windows 为 `agentero-cli`）。桌面正式版启动时会自动对齐终端命令的版本，显式卸载后保留退出选择。移动桌面应用后，终端命令仍能读取 PDF。卸载终端命令会清理受管缓存，桌面继续使用随包程序。

开发时用 `cargo run -p agentero-cli -- <命令>`，或运行 `target/debug/agentero-cli`。macOS 全新 checkout 直接执行桌面 Cargo 检查前，须先用 `node scripts/prepare-bundled-cli.mjs` 暂存本机架构 sidecar；`pnpm tauri dev` 和 `pnpm tauri build` 会连同其他桌面资源自动准备。

## 命令与帮助

`agentero` 显示根帮助，`agentero paper` 显示该分组的命令。每一级支持 `-h`、`--help` 和 `help <命令路径>`。`agentero help paper note --json` 给出该子树的操作、参数、示例和结果类型。所有帮助页由与命令解析器相同的目录生成。[逐级命令参考](../development/cli-mcp/cli-reference.md) · [机器可读命令目录](../../crates/agentero-core/src/ops/cli.json)

| 命令 | 用途 |
| --- | --- |
| `search`、`read` | 在论文及本地材料中查找证据，按引用、物理页、章节或区块读取原文 |
| `paper` | 题录查询、导入导出、标签、论文笔记、引用关系、下载与版面分析 |
| `file` | 列目录、写入、移动和回收文件，查看、恢复或清理回收站 |
| `annotation` | 对 PDF 原文、区域或引用添加高亮、提问与翻译，读取和修改已有批注 |
| `table` | 查询本地表格、按行写入、按单元格更新 |
| `feed`、`translate` | 管理全局订阅和条目，翻译文本 |
| `vault`、`sync` | 创建和检查库，预览修复，连接、检查和同步存储 |
| `app`、`delegate` | 操作真实桌面视图，在活跃的 Agent 回合中呈现产物，调用可用的委派目标 |
| `mcp` | 启动受权限约束的研究工具服务，或列出当前授权下的工具 |

## 一个本地研究流程

```sh
agentero vault create ./study --name study
cd study
agentero paper import pdf ../example.pdf --no-recognize
agentero paper list --plain
agentero search "sample size" --limit 1 --plain | agentero read -
```

`paper list` 选题录，`search` 返回带位置和版本的出处，`read` 展开原文。页码从 1 开始。搜索得到的 `cite` 可直接传给 `read` 和桌面的 `app open`。文件或索引发生变化后，重新检索可获得新引用。

Vault 解析顺序为 `--vault <名称或目录>`、`AGENTERO_VAULT`、当前目录最近的库祖先。`file` 的目标路径相对库根，`--input`、`--output` 与导入文件相对终端当前目录。Vault 内的原文件和 SQLite 题录与桌面共用。`feed` 使用账户本机的订阅数据库。

## 脚本与写入

```sh
agentero --vault study file write notes/design.md --input ./design.md --json
agentero --vault study file remove notes/design.md --dry-run
agentero --vault study file trash list --json
```

- `--json` 将成功的结果对象写到 stdout。单个操作失败时，stderr 含有 `error.code`、`message`、`details`、`hint`，进程以非零状态结束。批量操作可以返回已完成及失败项，再以非零状态结束。
- `search --plain` 和 `paper list --plain` 每行输出一个引用或 ID。`read -` 从 stdin 接受单条来源。正文可用 `--input -` 输入。
- 显式覆盖使用先前读取的 `revision` 与 `--if-revision`。支持追加或批量写入的操作可传 `--request-id`，重试时沿用原值。普通删除进入回收站，`file trash purge` 永久清理单项，非交互调用须传 `--yes`。
- `--quiet` 关闭进度，`--no-input` 关闭提问。`--color auto|always|never` 控制终端配色。退出状态 1 表示操作失败，2 表示参数错误，3 表示目标缺失，4 表示冲突，5 表示权限或确认问题，6 表示宿主或服务暂不可用，130 表示中断。

`paper download --refresh` 会先暂存新下载的文件并核对原文件的内容哈希。普通导入、手工添加或已编辑的资产没有匹配的下载记录时，保留原文件并返回冲突。`paper extract --refresh` 对用户编辑过的 PAPER.md 也会返回冲突。

S3 和 WebDAV 的 `--credentials-input <文件或 ->` 只读取凭据信封，S3 使用 `access_key`、`secret_key` 和可选的 `session_token`，WebDAV 使用 `password`。Git 复用系统凭据管理器或 SSH agent。远程版面分析的 `--page` 选择要保留的页，服务提供方可能收到整份 PDF。

省略 `--credentials-input` 时，CLI 在系统凭据存储中查询 service `app.agentero.sync`。account 是无空格的 JSON 字符串数组，例如 `["s3","https://s3.us-east-1.amazonaws.com","papers"]` 或 `["webdav","https://dav.example.org/research","alice"]`。端点去掉末尾的斜线。条目的密码值使用与 `--credentials-input` 相同的 JSON 格式。Git 继续使用系统 Git 凭据。系统存储中没有对应条目时，CLI 可复用同一目标已有的本地绑定。连接测试成功后，CLI 将有效绑定保存到与桌面同步引擎共用的 `sync.json`（Unix 文件权限 0600）；系统凭据条目保持由用户管理。

本机配置文件 `config.toml` 的 `[translation_profiles.<name>]` 表接受 `provider`、`base_url`、`model`、`api_key`、`region`。远程版面分析从 `[layout_profiles.<name>]` 读取 `provider`、`base_url`、`api_key` 与 `self_hosted`。使用 `--profile <name>` 选择。

## CLI 与 MCP

本地 CLI 使用同一套研究操作处理题录、文件、证据、批注和表格。MCP 将获准的研究操作投影成带 JSON Schema 的工具，库路径由服务端解析。CLI 还可使用本机文件输入、桌面宿主、同步和其他交互功能。使用 `agentero mcp tools --help` 查看权限，`agentero mcp tools --allow-vault ./study --json` 查看实际提供的工具。[MCP 参考](../development/cli-mcp/mcp-reference.md)

桌面 Agent 在活跃回合中使用宿主发放的授权。选择范围内的搜索、阅读和引用关系由宿主检查。`app present` 接收工作区内真实存在的产物路径，桌面据此显示文件卡片。桌面程序负责应用窗口、视图和委派的状态。
