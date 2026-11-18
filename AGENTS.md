# AGENTS.md

## 项目概览

Agentero 是一个基于 Tauri 2 + React 19 的本地优先科研工作台，产品是桌面端应用。Vault 中笔记与源文件以 Markdown/文件为准，论文结构化 metadata 以 `.agentero/catalog.sqlite` 为准。离开应用后数据仍可被外部工具读取。

架构总览：[docs/architecture.md](docs/architecture.md)

## 窗口与布局

长文在 [docs/frontend/workspace.md](docs/frontend/workspace.md) 和 [docs/frontend/shell.md](docs/frontend/shell.md)。这里是必须遵守的契约。Dockview 保持 7.0.4，不引入第二套布局库。

四种身份不要混用：

- **资源**：Vault 加载代（只在 `activateVault` 递增的 `treeLoadGeneration`）加归一化路径。不可变字节和 `blob:` URL 按引用计数。草稿和排版引擎文档不是资源。
- **视图**：Dockview 面板 id。新建文件、论文、笔记、拆分和译文用 `createViewId()`（`view-` + UUID）。路径只放在 `params.path`，角色放在 `params.pane`（缺省是正文，`split` / `translation` 是额外视图）。同一路径再次打开只聚焦正文视图；额外视图只来自 `⌘\` 拆分或译文。重命名保持 id。不要把路径写回 id，也不要解析 `view-` id 得到路径。旧布局里的路径形 id（含 `/`、盘符、虚拟标签、`::pane-`、`::translation`）仍按原 id 恢复。
- **窗口**：Tauri label。只负责宿主、去重和 Vault 持有，不拥有编辑状态。文档窗 label 是 `doc-` 加路径 UTF-8 字节 SHA-256 的前 16 位十六进制。功能窗是 `feature-{view}`。
- **会话**：label + Vault 路径。值只有 Dockview `toJSON()`，键是 `agentero-open-tabs::{label}::{vault}`。左右栏和 Agent 宽度仍在 `agentero.shellLayout.v1`，论文 / 笔记比例仍在 `agentero.notesSplitRatio.v1`。文档窗和功能窗不读写这份 JSON。旧的全局键 `agentero-open-tabs` 只由主窗口采纳一次。

布局权威：

- Dockview 就绪后，它是几何、成员和焦点的唯一权威。zustand 里的 `dockLayout` 只是保存快照。
- 命令先做策略，再调用 Dockview。Dock 还没挂载时记住意图，不要另建一套布局状态。
- 活动标签、可见面板和几何快照只从 Dockview 事件发布。`syncingRef` 会吞掉编程修改期间的激活和移除事件，同步结束必须补发当前活动面板和可见面板。
- 不要用 `origin === "api"` 过滤激活。`origin` 只用来识别用户关闭。`onWillMutateLayout` 不能 `preventDefault`。
- 侧栏和 Agent 宽度继续用 `react-resizable-panels`。写作项目里的 TeX 源码和 PDF 是面板内部的 `TexProjectView`，不是 Dockview 分栏。

关闭、移动和阅读：

- 关闭前的保存否决只覆盖已注册的 Markdown 源码模式。Plate、CodeMirror 不能否决关闭。`closeUnderPath`、关闭广场和清空 Vault 不加新的保存门。标签条 Delete / Backspace 必须在捕获阶段走进 `closeTab`，不能先 `panel.api.close()`。
- 移到新窗口：准备（源 label + 被点的视图 id；路径只给目标去重）→ 打开（失败则源视图留下；同路径已有文档窗只聚焦，不改模式）→ 目标接受（`window-created` 不是接受；目标有未保存草稿则拒绝）→ 用 `tabsAfterMovedView` + `removePanel` 提交，不走 `closeTab`。约 8 秒超时，迟到的接受忽略。被点的视图离开，论文 NOTES 留在源窗口。窗口内关闭正文时，正文的 NOTES 仍一起关闭。Library、Trash、Zen 不能移出；Plaza 可以。
- 标准双列只由 `readingColumnAnchors` 判断，成对关闭只由 `readingPairCloseIds` 计算并由 `closeTab` 执行。预设和进入、退出阅读都走 `applyLayoutMode`。笔记预设不动左栏。`Ctrl+M` 仍进入并记住阅读模式。退出阅读是取消最大化再重放预设，不是 `fromJSON`。

跨视图配对和 Agent：

- 双栏句子高亮、版面镜像、链接和滚动同步要认正文视图 id。译文栏用 `findTranslationSourceId` 找回正文；`::translation` 后缀只作为旧 id 的后备。不要再靠把路径或后缀写进面板 id 来配对。
- Agent 监听按窗口订阅，面板卸载不退订，只有 `pagehide` 退订。功能窗交接是：先监听再发 ready，源窗口发一份快照，收到对应 ack 后才 `agentRebindEventWindow`。没有 ack 就不改绑。不要恢复四次延迟广播。
- 主窗口只在 `vault:opened` 持有 Vault。`activateVault` 不调用 `vaultHold`。弹出窗在打开成功后持有，离开时释放。

平台补丁保持不变：新窗口命令必须 async；macOS 第二窗口在主线程 `setCollectionBehavior`；Windows 唤起顺序是 unminimize → show → set_focus；原生窗口装饰；`CREATE_NO_WINDOW`；`dragDropEnabled`；`PdfEngineHost` / `EditorDndProvider` 放在 StrictMode 外。沉浸全屏不并进这套布局。Windows 多窗口这次没有复验，不要写成已经验证。

## 开发规则

- 优先做小而聚焦的改动，能用少的修改解决问题就不要增加复杂度。高内聚、低耦合。如果系统有额外冗余可以提示用户进行重构
- 测试遵循下方「测试与验证」规则：针对行为改动编写并运行专门的单元测试，新增测试默认仅用于本地验证，不提交仓库。
- 尽可能能复用能力，避免重复造轮子。
- UI 优先使用上游现成组件及公开组合接口。`src/components/ui/` 的上游基础组件保持通用、可升级，不混入 ACP、Vault、PDF、业务 store、IPC 或项目专用文案；业务状态、数据转换和科研渲染放在对应业务目录，通过 props、children、hook 或 renderer 组合。升级前对比上游源码，优先删除已被上游覆盖的补丁；确需定制时说明能力缺口并保留必要回归验证。不要为减少依赖而重写成熟能力，也不要保留只有转发作用的旧兼容层。
- 对不熟悉的功能或技术领域，动手实现前先在 GitHub 搜索相关开源项目，对比实现思路、适用场景和限制，优先复用成熟能力；确认现有方案不适合后再自行实现，并简要说明参考项目与取舍。
- 在 UI 修改的过程中尽量少加入无关的、非必须的i18n 文案，如果能用icon表达，就不要加额外的描述。操作失败用 `notifyError` Toast，不在侧栏 header 挂常驻错误条。
- 国际化（i18n）：所有面向用户文案必须经 `t()` 走 `react-i18next`。en 源语言 → 同步 `zh-CN`（`src/i18n/locales/`）。
- IPC 契约（bindings.ts）：修改 `#[tauri::command]` 签名、事件 payload、或任何进入 bindings 的 Rust 类型——**包括文档注释，注释也导出参与比对**——后，必须重新生成并一并提交 `src/lib/core/bindings.ts`：`AGENTERO_UPDATE_BINDINGS=1 cargo test -p agentero export_typescript_bindings`（不带环境变量则只读校验，CI 会用它挡漂移）。详见 [docs/backend/api.md](docs/backend/api.md) §2.6。
- IPC / 事件改动提交前，运行 `cargo test -p agentero export_typescript_bindings` 和 `cargo test -p agentero app::events_contract`。新增或重命名事件须同步事件类型、`events_contract.rs` 的 `registered_event_names()` 和 `bindings_test.rs` 的导出列表；bindings 生成通过不代表事件登记检查通过。
- 前端模块依赖改动（import / re-export，包括 i18n、settings、service 之间的引用）提交前，除 `pnpm typecheck` 外必须运行 `pnpm deps:check`；类型检查和单元测试不能替代循环依赖检查。按改动范围在提交前执行这些检查，不要求每次编辑都跑全套 CI。
- 如果修改了 Template 下的 Skill 和 AGENTS.md ，需要对应更新版本号。
- 修改后需同步更新相关文档，bug_fix文档只在这个问题对之后其他项目开发或者这个bug有利用价值的时候才写。
- 修改完成后，把当次相关的改动按照 commit 部分的要求提交。

## 测试与验证

- 功能或逻辑修复需要编写并运行有针对性的单元测试，覆盖本次改动的关键行为、失败路径与必要边界；复用现有测试和 helper，不为每个函数、分支或文件机械补齐测试。纯文档、格式与无行为变化的样式调整不新增单元测试。
- **新增单元测试默认不提交仓库**，包括独立测试文件、fixture、快照和 Rust 模块内新增的 `#[cfg(test)]` 用例。它们用于本地验证；临时文件优先放在已忽略的 `tmp/` 下，若测试框架要求放在正常测试目录或源码模块内，提交前只移除本次新增的临时测试，并复核最终 diff。不得把验证专用 helper、依赖或测试入口留在生产代码中。
- 只有用户明确要求长期保留时，才提交新增回归测试；说明它防止的具体故障、现有测试为何不足，以及运行成本。不要主动把一次性排查、复现脚本或性能探针加入默认 CI。
- 已提交的高价值回归与契约测试继续维护，尤其是数据持久化与迁移、删除/覆盖、跨平台路径、IPC bindings 与事件登记；行为变更时同步更新相关断言。新增测试不提交不等于跳过既有检查，也不授权批量删除既有测试。
- 不写仅匹配源码字符串/正则、锁定 className/样式值/组件顺序、重复类型检查或上游库行为、以及用大量 mock 重演实现的测试。确需验证静态契约时，明确契约及其实际故障风险；UI 布局和桌面交互用真实应用流程验证。
- 提交前按改动范围运行最小必要检查及相关既有测试；遵守上方 IPC 与依赖检查要求。CI 变慢先区分安装、编译、测试收集和实际执行耗时，按故障风险、重复覆盖与维护成本评估删减，不以测试数量或覆盖率为目标。
- 完成后向用户说明验证场景、执行命令与结果，以及新增单元测试仅作本地验证、未提交仓库；无法完成的验证明确说明原因。详细组织方式见 [测试文档](docs/test/index.md)。

## Windows 注意事项

- **路径**：禁止手拼 `${vault}/${rel}`，统一走 `joinVaultPath` 并归一分隔符；混用 `/` `\` 在 `\\?\` 前缀下报 ERROR_INVALID_NAME（#181），拖入文件路径也要归一后再去重。
- **新窗口**：同步 `#[tauri::command]` 里 build WebviewWindow 会在 WebView2 嵌套消息循环死锁（白屏、关不掉），必须用 async command。
- **窗口装饰**：统一用原生 decorations；React 自绘标题栏按钮在 Settings 等子窗口拿不到 IPC 权限。
- **子进程/安装**：Windows 只走 npm/PowerShell 安装路径，Unix 脚本用 `cfg(not(windows))` gate；注意 `CREATE_NO_WINDOW` 与 `.exe` 命令名。
- **cfg 门控**：Cargo target cfg（如 `cfg(all(unix, ...))`）必须与代码侧 gate 对齐，否则 Windows release 编译失败。
- **UI 缩放**：Windows 125% 等非整数 DPR 会放大 px/rem 混用误差，对齐类样式用 rem。

## Commit

- 提交信息必须符合 [Conventional Commits](https://www.conventionalcommits.org/) 规范。
- 一次提交只做一件事，避免混合多个 unrelated changes。
- 如果有多个 unrelated changes，`git commit --only -m "msg" -- <path1> <path2>` 使用只提交指定路径的改动
- commit message 不可以有emoji
- 如果库当中有对应的 issue，则在提交信息中引用（如 `Fix #123`）；解决了该 issue 则关闭；部分解决则在 issue 区评论。
- 解决 Issue 之后，把解决的方法评论在 issue 中

## PR

- 不要把截图、GIF、录屏提交进仓库（不要进入 git 历史 / PR diff）。
- UI / 功能改动必须在 PR 正文附「之前 / 之后」对比；涉及窄窗口等特殊布局时补充对应尺寸。
- `feat` 必须在 PR 正文附 10–60 秒短视频或 GIF，演示「入口 → 关键操作 → 结果」。
- 媒体放在 PR 描述中：网页创建/编辑时拖入，或使用 `gh pr create --attach` / `gh pr edit --attach`。文件由 GitHub 托管，不进入 Git 历史。

## 常用命令

日常开发、界面验证和打包都走桌面端。

桌面端：

```bash
pnpm install
pnpm tauri dev      # 启动桌面应用（前端 + Rust Host）
pnpm tauri build    # 打包桌面安装包
```

检查与格式化：

```bash
pnpm lint
pnpm format
```

Headless CLI 与共享基础 crate（仓库根 workspace）：

```bash
cargo build -p agentero-cli
cargo run -p agentero-cli -- vault list --json
cargo test -p agentero-cli
cargo test -p agentero-core   # tauri 无关基础层（crates/agentero-core）
```

完成实现前运行最小必要验证。UI 改动用 `pnpm tauri dev` 启动桌面应用，检查对应流程。

## 文档地图

| 层 | 技术栈 | 关键能力 | 入口 |
|---|---|---|---|
| 前端 | React 19、TypeScript、Tailwind CSS 4、shadcn/ui、AI Elements | zustand 按域状态管理、Plate Markdown 编辑器、EmbedPDF 渲染、Dockview 多面板工作区 | [docs/frontend/](docs/frontend/index.md) |
| Host | Rust、Tauri 2、feature-first 布局 | 文件系统与 Vault 树、Catalog SQLite、Wiki 双链索引、ACP Client、本地文件监听、可选 loopback MCP | [docs/backend/](docs/backend/index.md) |
| CLI | Rust、`agentero` bin | headless Vault/Catalog 操作、论文标签管理、BibTeX 导入导出 | [docs/backend/cli.md](docs/backend/cli.md) |

| 分类 | 内容 | 路径 |
|---|---|---|
| **架构** | 整体架构、工作台布局、核心工作流、数据流 | [docs/architecture.md](docs/architecture.md) |
| **前端** | 壳、工作区、文件树、论文库、入库、Markdown、PDF、Agent、双链、翻译、设置 | [docs/frontend/](docs/frontend/index.md) |
| **后端** | 数据模型、Catalog、Vault、入库、Connector、Wiki、Agent、远程、搜索、日志、CLI、API | [docs/backend/](docs/backend/index.md) |
| **教程** | 快速上手、导入论文、阅读整理、接入 Agent、Zotero | [docs/usage/](docs/usage/index.md) |
| **开发** | 未实现草稿与设计记录 | [docs/development/](docs/development/index.md) |
| **测试** | 测试策略、发布 Checklist | [docs/test/](docs/test/index.md) |
| **Bug 复盘** | 会再次踩中的约束；一次性事故不留 | [docs/bug_fix/](docs/bug_fix/) |

约定：已实现按功能写在 `docs/frontend/` / `docs/backend/`；未实现草稿在 `docs/development/`。
