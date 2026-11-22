# Agentero 开发约定

## 项目

- Agentero 是本地优先的科研桌面应用。React 在 `src/`，Tauri Host 在 `src-tauri/`，共享逻辑在 `crates/agentero-core/`，无头 CLI 在 `cli/`。用 `pnpm install` 安装依赖，再用 `pnpm tauri dev` 启动开发版。
- Vault 中的 Markdown 和源文件以文件为准，论文结构化元数据以 `.agentero/catalog.sqlite` 为准。路径统一用 `joinVaultPath` 并归一分隔符，尤其是 Windows 扩展路径和拖入文件。
- 操作入口、数据行为或兼容范围的变化影响用户时，再补充说明。内部改动和一次性排查无需另写文档。

## 实现与兼容

- 小范围修改，优先复用上游公开接口。`src/components/ui/` 保持通用，业务状态、IPC 和渲染放在业务目录。升级组件时先检查上游能否替代补丁。陌生领域先查适用的开源实现。
- 在 UI 修改的过程中尽量少加入无关的、非必须的i18n 文案，如果能用icon表达，就不要加额外的描述。操作失败用 `notifyError` Toast，不在侧栏 header 挂常驻错误条。UI 优先使用上游现成组件及公开组合接口。能复用的窗口和组件不要新创。可以使用 `apple-design` skill 对于修改 UI 进行调整。
- 用户文案用 `t()`，同步 `en` 和 `zh-CN`。优先使用能表达操作的图标。一般操作失败用 `notifyError` 提示；有专门错误状态的流程在对应任务中呈现。
- 桌面窗口命令用 async。保留原生窗口装饰、`dragDropEnabled` 和 macOS 主线程 `setCollectionBehavior`。Windows 唤起顺序为 unminimize → show → set_focus；子进程用 `CREATE_NO_WINDOW`，安装走 npm/PowerShell，Unix 路径与 Cargo `cfg` 保持一致。缩放对齐用 rem。
- `PdfEngineHost` 和 `EditorDndProvider` 放在 StrictMode 外。验收安装包时，用包内 CLI 和 PDFium 实际读取 PDF，再核对签名和更新清单。

## 工作区契约

- Dockview 固定为 7.0.4，挂载后决定有哪些面板、怎么排列以及焦点在哪。store 只保存快照。命令先定策略，再调用 Dockview。挂载前只记录意图。同步结束后要补发当前活动面板和可见面板。激活事件不得按 `origin` 过滤，`onWillMutateLayout` 不调用 `preventDefault`。
- 区分资源（Vault 加载代加路径）、视图（`createViewId()`）、窗口（Tauri label）和会话（label 加 Vault）。新面板路径放 `params.path`，角色放 `params.pane`；重命名保留 id，路径形旧 id 仍可恢复。资源与 blob URL 按引用计数，译文用正文视图 id 配对。文档窗 label 用 `doc-` 加路径 UTF-8 字节 SHA-256 的前 16 位，功能窗用 `feature-{view}`。
- 主窗口的布局键是 `agentero-open-tabs::{label}::{vault}`，值为 Dockview JSON。独立文档和功能窗不写该快照，旧全局键只迁移一次。侧栏宽度走 `react-resizable-panels`，写作的 TeX 和 PDF 同属一个项目面板。
- 键盘关闭走 `closeTab`，只允许已注册的 Markdown 源码草稿否决。移窗先打开目标并等待接受，失败或约 8 秒超时保留源视图；接受后用 `tabsAfterMovedView` 和 `removePanel` 提交。移出论文时 NOTES 留在源窗；普通关闭正文时成对关闭。Library、Trash、Zen 不能移窗。
- 阅读配对由 `readingColumnAnchors` 和 `readingPairCloseIds` 决定；布局及阅读切换走 `applyLayoutMode`，退出取消最大化后重放预设。笔记预设不动左栏，保留 `Ctrl+M` 的阅读模式记忆和独立的沉浸全屏。

## 数据与服务

- 主窗口只在 `vault:opened` 持有 Vault，弹出窗成功打开后持有，离开时释放。Agent 订阅按窗口建立，`pagehide` 才退订。移窗先监听、发 ready、交接一次快照，收到对应 ack 后才重绑事件。
- Agent 会话恢复同时考虑消息、来源和产物。CLI 和 MCP 的共享操作看 `crates/agentero-core/src/ops/` 的清单与执行层；读取全文、写入、联网授权在实际操作层执行。
- 同步写入要保留并发修改和冲突副本，发布失败后要能恢复。测试要覆盖远端提交前后，以及应用同步结果到本地失败的情况。
- 修改导出的 IPC 命令、类型、事件或 Rust 文档注释时，用 `AGENTERO_UPDATE_BINDINGS=1 cargo test -p agentero export_typescript_bindings` 更新 `src/lib/core/bindings.ts`。新事件同步 `registered_event_names()` 和导出列表。

## 验证与提交

- 按范围运行检查。前端依赖变化跑 `pnpm typecheck` 和 `pnpm deps:check`；IPC 跑 `cargo test -p agentero export_typescript_bindings` 和 `cargo test -p agentero app::events_contract`；界面用 `pnpm tauri dev` 走真实流程。用户站用 `uvx --with mkdocs-material==9.7.1 mkdocs build --strict`。
- 行为改动写有针对性的测试。新增测试默认本地验证后移除，除非用户要求保留。已有的数据、迁移、删除、路径与 IPC 回归测试随行为维护。纯文案和样式无需新增测试。
- 修改 `templates/` 下受版本管理的 Skill 或 AGENTS 时同步版本。改动完成后按目的分开提交，使用无 emoji 的 Conventional Commits，按需引用关联 Issue。
- UI 和功能 PR 在正文附前后对比，新功能附 10–60 秒演示。验收媒体放 PR 正文；用户教程使用演示数据实拍，压缩后可提交到 `docs/assets/screenshots/`。
