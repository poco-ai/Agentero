# 参与贡献

感谢关注 Agentero！无论是 Issue、文档还是代码 PR，都欢迎。本文介绍参与贡献需要遵守的流程与检查要求。

> 面向 Agent 与开发者的仓库级开发约定见 [AGENTS.md](AGENTS.md)，与本文互补；两者冲突时以更严格者为准。

## 开始之前

- **功能修改请先开 Issue 讨论**：新功能、交互调整、涉及数据模型或协议的改动，请先通过[功能建议](https://github.com/poco-ai/Agentero/issues/new?template=feature_request.yml)模板描述问题场景与期望方案，与维护者对齐范围后再动手，避免做完发现方向不符。较大的想法请先开 issue 对齐。
- **Bug 修复**可以直接进行：建议先通过[Bug 反馈](https://github.com/poco-ai/Agentero/issues/new?template=bug_report.yml)附上可复现步骤，并在 PR 中引用对应 issue（`Closes #123`）。
- 文档、翻译、明显的小修正可直接提 PR。

## 开发环境

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 22 | 与 CI 一致 |
| pnpm | 11.5.3 | `corepack enable` 后自动使用 |
| Rust | stable | 需包含 `rustfmt` 与 `clippy` 组件 |
| 平台依赖 | — | Linux 需 `webkit2gtk 4.1`（Ubuntu 22.04+）；Windows 需 WebView2；macOS 需 Xcode Command Line Tools |

```bash
git clone https://github.com/poco-ai/agentero.git
cd agentero
pnpm install    # 自动通过 husky 安装 Git hooks
```

常用命令：

```bash
pnpm tauri dev     # 桌面应用（推荐）
pnpm dev           # 仅前端预览（无原生 Vault / Agent 后端）
pnpm test          # 前端 vitest
pnpm lint          # biome check + cargo clippy
pnpm typecheck     # tsc --noEmit
cargo test -p agentero-core -p agentero-cli   # Rust 基础层与 CLI 测试
cargo test -p agentero                        # 应用层测试
```

桌面 `cargo test -p agentero` 与 `cargo clippy --workspace` 需要先执行 `pnpm plugin-worker:stage`，把 sidecar 放到 `src-tauri/binaries/`，否则 `tauri-build` 会因缺少 `externalBin` 失败，与缺少 `src-tauri/pdfium` 相同。

Windows 上 `liteparse` 会拉起 `tesseract-rs`，有两个第三方坑，仓库修不了：

- Visual Studio 的 Debug 构建会产出 `tesseract*d.lib`，crate 按发行版名字去找，于是 `cargo test` / `cargo clippy --all-targets` 链接失败。在 VS Developer Prompt 里编，或先用 release 把库编出来一次，再跑 debug；CI 的 Windows 测试任务因此直接使用 release profile。
- tessdata 下载超时是 30 秒，失败后会留下空的 `eng.traineddata`。之后的构建会一直复用这个空文件。删掉缓存里的空文件再下。

仓库分为三层：`src/`（React 前端）、`src-tauri/`（Tauri 2 桌面 Host）、`crates/agentero-core` 与 `cli/`（Tauri 无关的基础层与无头 CLI）。改动了哪层，就跑对应层的检查。

## 提交前：本地必须通过 pre-commit

仓库启用了 **husky + lint-staged**，每次 `git commit` 都会自动检查暂存文件：

- `*.{ts,tsx,js,jsx,json,jsonc,css,html,md}` → `biome check --write`
- `src-tauri/**/*.rs` → `cargo fmt --all` + `cargo clippy -D warnings`

要求：

1. 首次克隆后先运行 `pnpm install`，确保 hooks 已安装生效。
2. 如果 hook 自动修复了文件，请重新 `git add` 后再提交；如果 hook 报错，请修复后再提交。
3. **不要使用 `--no-verify` 跳过检查**。CI 会运行同样的检查，跳过只会把问题推迟到 PR 上。

此外，提交前请至少本地验证与改动对应的部分：

```bash
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p agentero-core -p agentero-cli
```

## 提交规范（Conventional Commits）

- 提交信息使用英文，遵循 [Conventional Commits](https://www.conventionalcommits.org/)，如 `feat(pdf): ...`、`fix(agent): ...`，type 与 scope 要准确。
- 一次提交只做一件事；不相关的改动分开提交。
- 标题不带 emoji；相关 issue 用 `Closes #123`（会关闭）或 `Refs #123`（仅关联）引用。

## PR 要求

1. Fork 后从 `main` 拉功能分支，保持改动小而聚焦。
2. 按模板填写 PR，**以下为硬性要求**：
   - **UI / 功能改动必须附截图**：先创建不含图片的 PR，再在 **PR 评论区**上传「之前 / 之后」前后对比；涉及窄窗口等特殊布局时补充对应尺寸的截图。PR 正文可链接到该评论。
   - **`feat` 必须附 Demo**：在 **PR 评论区**上传 10–60 秒短视频或 GIF，演示「入口 → 关键操作 → 结果」主路径。
   - 完全没有界面变化时，在评论里写「无」，不附图片，并且不要勾选 `ui` 类型。
   - 截图、GIF、录屏不得提交进仓库，也不要放进 PR diff 或 PR 描述正文。
3. **CI 必须全绿**。PR 与 `main` 的 push 会触发 [ci.yml](.github/workflows/ci.yml)，未通过的 PR 不会进入 review。

媒体上传方式与 [AGENTS.md 的 PR 约定](AGENTS.md#pr)一致：在网页的 **PR 评论框**拖入文件；或使用 `gh` ≥ 2.99.0：

```bash
gh pr comment <number> --body "之前 / 之后" \
  --attach './before.png#之前' \
  --attach './after.png#之后'
```

Demo 同样通过评论区上传。文件由 GitHub 托管，不进入 Git 历史。`gh` 低于 2.99.0 时使用网页评论框，不要改用 `gh pr create --attach` / `gh pr edit --attach`，也不要将媒体文件提交进仓库。

| CI 任务 | 内容 | 本地等价命令 |
| --- | --- | --- |
| TypeScript quality | `biome ci .`、`pnpm typecheck`、`pnpm deps:check`、adapter staging | `pnpm lint:ts && pnpm typecheck && pnpm deps:check` |
| TypeScript test | vitest 两分片 | `pnpm test` |
| Rust quality | `cargo fmt --check`、`cargo clippy -D warnings`（macOS 与 Windows） | `pnpm lint:rs` |
| Rust tests | `cargo test -p agentero -p agentero-plugin-host` / `-p agentero-core -p agentero-cli`（macOS 与 Windows） | 同左 |

## 代码与 UI 约定（摘要）

完整约定见 [AGENTS.md](AGENTS.md)，特别注意：

- 面向用户的文案必须经 `t()` 走 react-i18next，en 源语言需同步 `zh-CN`（`src/i18n/locales/`）；能用 icon 表达就不加额外文案。
- 优先小而聚焦的改动，复用已有能力；不加没有实际意义的测试用例。
- 操作失败用 `notifyError` Toast 提示，不在界面挂常驻错误条。
- Windows 兼容（路径分隔符、DPR 缩放、子进程、cfg 门控等）有专门注意事项，见 AGENTS.md。
- 改动涉及已实现功能时，同步更新 `docs/` 下相关文档，并检查 Roadmap / Todo。
- 修改 `templates/` 下的 Skill 与 AGENTS.md 时需同步更新版本号。

## 使用 AI 辅助开发

**本项目支持并欢迎使用 AI 工具辅助开发**，同时要求：

- 提交前请实际阅读并理解全部改动，你需要对 PR 中的每一行代码负责，AI 生成不降低验收标准。
- 确保改动通过本地 pre-commit 与对应检查，并手动验证功能主路径；AI 声称「测试通过」不算通过。
- 遵守与人类贡献者相同的流程：功能先开 issue 讨论、Conventional Commits、PR 模板的截图与 Demo 要求。
- 鼓励让 AI 先调研仓库结构与既有实现，优先复用已有能力，而不是重新造轮子（仓库约定可参考 AGENTS.md 与 `docs/`）。

## Issue 模板

- [Bug 反馈](https://github.com/poco-ai/Agentero/issues/new?template=bug_report.yml)：请提供可复现步骤、期望/实际行为、环境信息与日志。
- [功能建议](https://github.com/poco-ai/Agentero/issues/new?template=feature_request.yml)：请描述问题或场景、期望方案与替代方案。

## License

提交即表示你同意自己的改动以 [MIT License](LICENSE) 随本项目发布。
