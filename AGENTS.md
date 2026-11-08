# AGENTS.md

## 项目概览

Agentero 是一个基于 Tauri 2 + React 19 的本地优先科研工作台，产品是桌面端应用。Vault 中笔记与源文件以 Markdown/文件为准，论文结构化 metadata 以 `.agentero/catalog.sqlite` 为准。离开应用后数据仍可被外部工具读取。

文档将使用 Fumadocs 在仓库内的 `docs/` 从零重建；旧文档可通过 Git 历史查阅。

## 开发规则

- 优先做小而聚焦的改动，能用少的修改解决问题就不要增加复杂度。高内聚、低耦合。如果系统有额外冗余可以提示用户进行重构
- 只加必要的影响性能和功能的测试代码，不加没有实际意义的测试用例。
- 尽可能能复用能力，避免重复造轮子。
- UI 优先使用上游现成组件及公开组合接口。`src/components/ui/` 的上游基础组件保持通用、可升级，不混入 ACP、Vault、PDF、业务 store、IPC 或项目专用文案；业务状态、数据转换和科研渲染放在对应业务目录，通过 props、children、hook 或 renderer 组合。升级前对比上游源码，优先删除已被上游覆盖的补丁；确需定制时说明能力缺口并保留必要回归验证。不要为减少依赖而重写成熟能力，也不要保留只有转发作用的旧兼容层。
- 对不熟悉的功能或技术领域，动手实现前先在 GitHub 搜索相关开源项目，对比实现思路、适用场景和限制，优先复用成熟能力；确认现有方案不适合后再自行实现，并简要说明参考项目与取舍。
- 在 UI 修改的过程中尽量少加入无关的、非必须的i18n 文案，如果能用icon表达，就不要加额外的描述。操作失败用 `notifyError` Toast，不在侧栏 header 挂常驻错误条。
- 国际化（i18n）：所有面向用户文案必须经 `t()` 走 `react-i18next`。en 源语言 → 同步 `zh-CN`（`src/i18n/locales/`）。
- IPC 契约（bindings.ts）：修改 `#[tauri::command]` 签名、事件 payload、或任何进入 bindings 的 Rust 类型——**包括文档注释，注释也导出参与比对**——后，必须重新生成并一并提交 `src/lib/core/bindings.ts`：`AGENTERO_UPDATE_BINDINGS=1 cargo test -p agentero export_typescript_bindings`（不带环境变量则只读校验，CI 会用它挡漂移）。
- 如果修改了 Template 下的 Skill 和 AGENTS.md ，需要对应更新版本号。
- 修改后需同步更新相关文档，并检查 Roadmap 和 Todo。
- 修改完成后，把当次相关的改动按照 commit 部分的要求提交。

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

- 不要把截图、GIF、录屏提交进仓库，也不要放进 PR diff 或 PR 描述正文。不要用 `gh pr create --attach` / `gh pr edit --attach` 把图片写进 PR 正文。
- 需要附图时，先创建不含图片的 PR，再在该 PR 的评论区上传。`gh` ≥ 2.99.0 的 `gh pr comment --attach` 与在评论框拖入图片相同：文件托管在 GitHub（`user-attachments`），不进入 git 历史。

```bash
gh pr comment <number> --body "之前 / 之后" \
  --attach './before.png#之前' \
  --attach './after.png#之后'
```

- UI / 功能改动仍需前后对比；没有界面变化时在评论里写「无」，不要附图片。`feat` 的 Demo 同样用评论区 `--attach` 上传视频或 GIF。
- 本机 `gh` 低于 2.99.0 时，打开该 PR 在网页评论框上传，不要因此把文件提交进仓库。

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

## 文档

`docs/` 预留给新的 Fumadocs 静态文档项目，目前尚未初始化。新内容围绕用户任务组织，以当前产品实际行为为准。
