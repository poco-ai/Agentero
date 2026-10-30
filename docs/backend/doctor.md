# Vault Doctor

Doctor 聚合本地 Vault 的只读完整性检查，并为论文别名、双链与视觉批注格式提供**显式确认**的安全修复。

## 检查范围

`DoctorReport` 包含五组结果：

1. Vault 目录结构（`papers/`、`notes/`、`.agentero/`）；
2. `.agentero/catalog.sqlite` 是否存在且 schema 与当前版本一致；
3. Catalog 中是否存在重复行：同一 `id` 出现在多条记录，或同一 `path` 出现多次（后者为 schema 完整性校验）；
4. 与桌面导航共用 `WikiIndex::check_links` 的双链语义结果；
5. Catalog 中每篇 `papers/**/NOTES.md` 的 frontmatter aliases；
6. `papers/**/marks/*.json` 视觉批注格式（旧版 `agent-trace` → `visual` v2）。

一次检查不会创建目录、迁移 Catalog 或修改 Markdown；Catalog 以只读 SQLite connection 打开。

一篇论文笔记至少要有两个按 Wiki resolver 规则归一化后仍不同的非空 alias。Doctor 保留现有自定义 aliases，并提出可编辑的标题 alias 与确定性短 alias：

- 优先使用冒号或破折号前的有效短标题；
- 英文标题使用去掉常见连接词后的首字母缩写；
- 中文标题无可靠短标题时使用「第一作者 + 年份」；
- 冲突时依次追加年份、第一作者；仍冲突则只报告、默认不选。

重复的正式标题只告警，不修改 Catalog；编辑标题 alias 也不会回写 Catalog。

## 安全修复

### Catalog 重复行

`doctor_fix_catalog_duplicates` / CLI `agentero doctor fix catalog-duplicates`：

- 对每组重复 `id`，按「路径存在磁盘 > `updated_at` 最新 > 路径最短 > 字典序最小」保留一条 canonical 记录，删除其余行；
- 对重复 `path`（schema 完整性校验），保留 `updated_at` 最新的一条；
- 返回 `removedRows`、`removedPaths`、`keptPaths`；
- 桌面端在 Doctor 设置页的 Catalog 区显示「去重」按钮。

### 论文 aliases

`doctor_apply_aliases` 只接受当前 Catalog 行对应的 `NOTES.md`。批量写入前会：

- 拒绝主窗口报告的未保存编辑路径；
- 校验诊断时的 SHA-256 内容哈希；
- 拒绝复杂、异常或无法精确定位的 YAML；
- 先规划全部文件，再**原地写入**（不改 path / 文件名，只改 frontmatter）；
- 任一写入失败时按规划内容回滚本批已写文件。

不使用 tmp+rename 式原子替换：那样会被 Vault 文件监听器当成「不完整改名」，误报外部改名未修复链接。

#### 忽略（持久化）

用户可在设置页对单篇或已勾选论文选择 **忽略** 别名检查。忽略列表落在 Vault 本地 `.agentero/doctor.json` 的 `ignoredAliasPaths`（相对 `papers/**/NOTES.md` 路径）：

- 再诊断时这些路径不再计入别名错误 / 修复候选，也不使 `aliases.ok` 为 false；
- `DoctorReport.aliases.ignoredPaths` 返回仍不完整且仍被忽略的路径，供 UI 恢复；
- 已补齐至少两个 distinct aliases 的笔记会自动从活跃忽略展示中消失（列表条目可在写盘时保留，无害）；
- `doctor_ignore_aliases` 以 `ignore: true|false` 增删路径。

### 双链语义

1. **探测** `doctor_plan_wikilinks`  
   - 对 unresolved 边做唯一高置信匹配（path / stem / alias 近邻、heading/block 近邻）→ `layer=deterministic`（默认勾选）  
   - 无法唯一匹配时仍输出可编辑候选项 → `layer=manual`（默认不勾选，绿色区可手改）  
   - 每条 suggestion 含 `rangeStart/End`、`expected`、`expectedHash`、`linePrefix` / `lineSuffix`（整行上下文）  
2. **UI 列表**：git 风格整行展示，核心变更居中高亮，按容器宽度窗口化前后文  
3. **Agent 协作（不自动跑）**：探测后展示可复制提示词（随 UI 语言 en/zh）；「在 Agent 中打开」关闭设置窗、打开主窗 Agent 并预填 composer；Agent 应先给计划、等用户确认再改文件  
4. **修复** `doctor_apply_wikilinks`：用户勾选后原地写入选中 range；脏路径 / 哈希 / 重叠 range 预检，失败回滚  

设置页流程：探测 → 建议列表（全选 / 修复）→ 下方 Agent 提示词（复制或打开 Agent）。

### 视觉批注格式

扫描 `papers/**/marks/*.json`（跳过 `annotations.json`）。对 `kind: agent-trace` 或扁平 agent 字段的旧格式给出候选：

- `doctor_apply_visual_marks` / CLI `doctor fix visual-marks`：改写为 `kind: visual` v2，agent 字段嵌套进 `agent` 对象；**保留 id 与 `image.path`**
- 幂等：已是嵌套 v2 的跳过
- 脏路径（打开中的 mark）拒绝写入

读路径（桌面）始终 dual-read v1/v2，不依赖 Doctor 也能打开旧 Vault。

## Host / Agent 诊断

除 Vault Doctor 外，设置页诊断还有三个 **host 级**检查（不依赖 Vault）：

### 主机运行环境（`doctor_check_host`）

`agent/doctor.rs` `diagnose_host`：在 Agent 实际使用的合并环境（`effective_local_agent_env`，PATH 按 descriptor → 进程 → login shell → 常见 GUI 缺失目录顺序合并）里检查：

- `node` / `npm`：解析路径 + `--version`（5s 超时），状态 `available / missing / unusable`；
- `npm prefix -g`：追加进环境 PATH 后再查 node（覆盖 npm 全局安装但 GUI PATH 缺失的场景）。
- Windows：探测子进程一律带 `CREATE_NO_WINDOW`（`diagnostic_command` 统一收口）。应用是 GUI 子系统二进制，缺该标志时 Windows 会给每个控制台子进程新建可见控制台——表现为每次打开/刷新问题诊断，每探测一个工具就多一个黑窗（标题即该工具路径，两个 hermes 条目就是两个黑窗）。

Codex 登录状态不再放在主机运行环境；改由 Agent 卡片第三行展示（见下）。

`node` 或 `npm` 任一不可用时，该分区显示「一键安装 Node.js」按钮（`doctor_install_node`）：Windows 走 `winget install OpenJS.NodeJS.LTS --silent`，macOS 走 `brew install node`（npm 随 Node 一起装，没有独立的 npm 安装包）；Linux 无单一包管理器且需要 sudo，返回 `no-package-manager`，UI 提示手动安装。

- **后台任务**：安装走与 Agent lifecycle 同一套进度/取消通道——调用方传入 `taskId` 后，Host 通过 `agent-lifecycle:progress` 事件报告进度，取消复用 `agent_lifecycle_cancel`（协作式取消，丢掉安装子进程；Windows 上同时关闭 Job，结束 `cmd` / `npm` 拉起的后代）。前端 `src/lib/doctor/install-node.ts` 把它包成后台任务行（`kind: nodeInstall`），多分钟的下载不再阻塞调用方 UI。
- **安装后 PATH**：Windows 安装后合并注册表中的机器 + 用户 PATH 重新探测；`core::process::discover` 的 `WIN_ABS_BIN_DIRS` 额外列出 `C:\Program Files\nodejs`，使已运行的应用无需重启即可解析到新装的 npm。
- **错误恢复**：Agent 安装/更新因 npm 不在 PATH 失败时（Windows `'npm' is not recognized...` / Unix `command not found` / Host 的 `npm is not available on PATH`），Toast 附带同一「安装 Node.js」动作按钮。
- **Agent 页提醒**：Settings → Agent 打开时复用同一检测（`src/hooks/use-host-node-status.ts`，仅本地 Vault；SSH 远端不检查本机环境）。node/npm 不可用时页首显示紧凑提示，带「一键安装 Node.js」（同一后台任务）与跳转「问题诊断」的入口；安装成功后广播 `agentero:host-node-installed`，已挂载的 Agent 页重新探测并重扫目录，不做轮询。
- **生命周期守卫**：`src/lib/doctor/node-guidance.ts` 判定动作是否真的经 npm/Node——`adapterDistinct`（Claude / Codex / Pi / ZCode 的独立 ACP 适配器由 npm 安装、由 Node 执行）、`acpBundled`（随包分发的 JS 适配器），以及 npm-only 的生命周期：`dsh` / `minimax-code` / `mimo-code`（所有平台都走 `npm i -g`）与 Windows 上的 `opencode`（无原生安装器）。node/npm 缺失时这些安装/升级不再启动注定失败的静默任务，改弹 Toast 引导先装 Node.js；卸载始终不拦（恢复路径），带平台原生安装器的 Agent（Hermes / Qoder / Qoder CN / Kimi / Grok / Antigravity 等）保持原行为——它们的 npm 兜底失败仍走上面的 npm-missing 恢复。首次 `doctor_check_host` 尚未返回时，生命周期入口会先等待这次探测再判定，避免抢在结果前启动 npm 任务。Unix 安装子进程与 doctor / ACP spawn 使用同一套 PATH 合并顺序（login shell + 进程 + nvm / fnm / Homebrew / 用户 bin），Doctor 能解析到的 npm 在静默安装里同样可见。注意 Codex 自身虽有官方二进制安装器，Agentero 的 Codex 接入依赖 npm 的 `codex-acp` 适配器，因此 Node.js 仍是必需项。

### Agent ACP 连通性（`doctor_check_agents`）

`agent/doctor_agents.rs` `diagnose_agents`：对 registry 中**每个已注册 Agent**（含 custom）重新执行 ACP initialize 探测（不发 prompt），并分类失败原因。每个诊断额外收集卡片三行字段：

| 行 | 字段 | 来源 |
|---|---|---|
| Agent 位置 · 版本 | `agentPath` / `agentVersion` | 模板 `detect_command` 的路径 + `--version` |
| ACP 位置 · 版本 | `resolvedPath` / `acpVersion` | ACP `command` 的路径 + `--version`（不是协议版本）；Claude / Codex 的内置适配器不探测，该行不展示（`resolvedPath` / `acpVersion` 为 null），只剩 Agent 行与登录状态 |
| 登录状态 | `authStatus` | Codex 先查 `codex-acp cli login status`；未报告已登录时再通过同一适配器的 Codex app-server `account/read` 查询 `requiresOpenaiAuth` 与 `account`：自定义 provider 无须 OpenAI 登录时为不适用，需要登录且无账号时为未登录。app-server 查询失败时，CLI 的“未登录”仅作未知状态；其它 Agent 由 ACP 探测结果推导（成功→已登录，`not-logged-in`→未登录，命令缺失→不适用，其余→未知） |

- 编排：先 `scan_catalog()`（把 PATH 上已装但未落盘的目录 Agent 自动注册，避免必须先打开设置 → Agent）；再 `snapshot()` 一次（内部已刷新命令可用性）；`buffered(3)` 限流并行探测；`!available` 的 Agent 不 spawn，直接按 `last_error` 合成「命令缺失」结果（镜像 `agent_probe` 快路径）；
- 写回：每个结果 `apply_probe_result` 持久化到 registry，结束后 `emit_registry_changed`，Agent 目录页同步刷新；成功时清除该 Agent 的 warm-gate 熔断，失败**不**记录新熔断（Doctor 是用户主动重试，应无视 120s 冷却）；
- 分类（`classify_acp_error`，按序匹配原始错误文本）：

| 分类 | 匹配模式（示例） | 典型原因 |
|---|---|---|
| `command-missing` | `not found on PATH`、`No such file or directory (os error 2)` | CLI 未安装或 GUI PATH 缺失 |
| `not-logged-in` | `not logged in`、`invalid_grant`、`authentication required` 等（与前端 `isAgentAuthFailure` 一致；优先于协议类，auth 错误常被包进 `initialize failed:`） | Agent 未登录 / token 过期 |
| `timeout` | `timed out` | 冷启动慢、代理/网络问题 |
| `spawn-failed` | `failed to start`、`Permission denied (os error 13)`、`(os error 193)` | 权限或无效可执行文件 |
| `protocol-failed` | `initialize failed`、`no initialize response`、`method not found` | ACP adapter 版本/实现问题 |
| `unknown` | 兜底 | 展示原始错误 |

hint 文案不在 wire 类型里，前端按分类映射 `doctor.agent.hints.*` i18n key。探测不随设置窗关闭而取消，由 30s initialize 超时兜底。

### 网络连通性（`doctor_check_network`）

`system/network/mod.rs` `diagnose_network`：按当前应用的全局代理设置（`effective_proxy_url`），并行探测六个常用站点/论文源：

| 端点 | 探测 URL |
|---|---|
| Baidu | `https://www.baidu.com/` |
| Google | `https://www.google.com/generate_204` |
| Google Scholar | `https://scholar.google.com/` |
| GitHub | `https://api.github.com/` |
| arXiv | `https://export.arxiv.org/api/query?id_list=1706.03762&max_results=1` |
| Semantic Scholar | `https://api.semanticscholar.org/graph/v1/paper/ARXIV:1706.03762?fields=title` |

- 8s 超时，`buffered(6)` 并行探测，按固定顺序返回；
- 使用 `BROWSER_USER_AGENT` 与 `DEFAULT_REDIRECT_LIMIT`，与导入/下载流程的 HTTP 客户端行为一致；
- 任何 HTTP 响应（1xx–5xx）都算 `reachable`，仅 transport 失败（DNS、连接、TLS、代理错误、超时）标记为 `timeout` / `unreachable`；
- 返回每个端点的状态码、耗时与当前生效代理，方便判断代理是否生效。

## 入口

- 桌面：设置 → 知识库诊断；远程 Vault 当前显示不可用。
- CLI：`agentero doctor`、`agentero doctor fix aliases`、`agentero doctor fix visual-marks`、`agentero doctor fix catalog-duplicates`、`agentero -y doctor fix …`（CLI 诊断同样尊重 `.agentero/doctor.json` 忽略列表）。
- Host：`doctor_check`、`doctor_apply_aliases`、`doctor_ignore_aliases`、`doctor_set_dirty_paths`、`doctor_plan_wikilinks`、`doctor_apply_wikilinks`、`doctor_apply_visual_marks`、`doctor_fix_catalog_duplicates`；host 级：`doctor_check_host`、`doctor_check_agents`、`doctor_check_network`。

代码：`src-tauri/src/features/vault/doctor/`（聚合入口）、`src-tauri/src/features/markdown/wiki/doctor.rs`（双链修复）、`src-tauri/src/features/pdf/marks/doctor.rs`（视觉批注修复）、`src-tauri/src/features/agent/doctor.rs`（主机运行环境）、`src-tauri/src/features/agent/doctor_agents.rs`（Agent ACP 诊断）、`src-tauri/src/features/system/network/`（网络连通性）、`src/lib/doctor/`、`src/components/settings/panes/doctor-pane.tsx`。
