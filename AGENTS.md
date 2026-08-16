# AGENTS.md

## 项目概览

Agentero 是一个基于 Tauri 2 + React 19 的本地优先科研工作台。Vault 中笔记与源文件以 Markdown/文件为准，论文结构化 metadata 以 `.agentero/catalog.sqlite` 为准。离开应用后数据仍可被外部工具读取。

**核心能力：**

- **论文库**：Catalog SQLite 管理论文集合，支持表头排序/选列/标签筛选、BibTeX 导出
- **魔棒入库**：通过 URL/arXiv ID/DOI 一键导入论文，自动下载 PDF、解压 LaTeX 源码
- **PDF 阅读与标注**：分屏阅读（左 PDF/右笔记），划词高亮/批注/翻译/提问，大纲与页码导航
- **Agent 工作流**：BYOA 接入本机 ACP Agent，支持论文总结/问答/精读，选区上下文与 @ 提及
- **Markdown 编辑**：Plate 编辑器，双链 `[[...]]`、Obsidian Callout、嵌套标题引用、内嵌图片管理
- **Zotero Connector**：兼容官方浏览器扩展，一键保存文献到当前 Vault

架构总览：[docs/architecture.md](docs/architecture.md)

## 技术速览

| 层 | 技术栈 | 关键能力 | 入口 |
|---|---|---|---|
| 前端 | React 19、TypeScript、Tailwind CSS 4、shadcn/ui、AI Elements | zustand 按域状态管理、Plate Markdown 编辑器、EmbedPDF 渲染、Dockview 多面板工作区 | [docs/frontend/](docs/frontend/index.md) |
| Host | Rust、Tauri 2、feature-first 布局 | 文件系统与 Vault 树、Catalog SQLite、Wiki 双链索引、ACP Client、本地文件监听 | [docs/backend/](docs/backend/index.md) |
| CLI | Rust、`agentero` bin | headless Vault/Catalog 操作、论文标签管理、BibTeX 导入导出 | [docs/backend/cli.md](docs/backend/cli.md) |

## 开发规则

- 优先做小而聚焦的改动，避免无关重构。
- 保持 local-first：不要引入私有存储作为事实来源。
- 高内聚、低耦合。
- 能复用能力，避免重复造轮子。
- 未经明确确认，不要覆盖用户手写的 Vault 文件。
- 编辑或生成 Markdown 时保留 Obsidian 兼容的双链文本（`[[...]]`）。
- Agent 集成采用 BYOA：Agentero 只配置如何启动本机 ACP-compatible Agent，不要求用户在 Agentero 内填写模型 API Key。
- UI 保持简约：图标按钮必须有可访问名称和 Tooltip；避免常驻解释文案。操作失败用 `notifyError` Toast，不在侧栏 header 挂常驻错误条。
- 国际化（i18n）：所有面向用户文案必须经 `t()` 走 `react-i18next`。en 源语言 → 同步 `zh-CN`（`src/i18n/locales/`）。详见 [docs/frontend/shell.md](docs/frontend/shell.md)。
- 修改后需同步更新相关文档，并检查 Roadmap 和 Todo。
- 如果修改了 Template 下的 Skill，需要对应更新版本号。

## 常用命令

```bash
pnpm install
pnpm dev
pnpm tauri dev
pnpm build
pnpm lint
pnpm format
pnpm tauri build

# Headless CLI（仓库根 workspace）
cargo build -p agentero-cli
cargo run -p agentero-cli -- vault which --json
cargo test -p agentero-cli
```

完成实现前运行最小必要验证。UI 改动优先启动应用检查对应流程。

## 文档地图

| 分类 | 内容 | 路径 |
|---|---|---|
| **架构** | 整体架构、工作台布局、核心工作流、数据流 | [docs/architecture.md](docs/architecture.md) |
| **前端** | 壳、工作区、文件树、论文库、入库、Markdown、PDF、Agent、双链、翻译、设置 | [docs/frontend/](docs/frontend/index.md) |
| **后端** | 数据模型、Catalog、Vault、入库、Connector、Wiki、Agent、远程、搜索、日志、CLI、API | [docs/backend/](docs/backend/index.md) |
| **教程** | 快速上手、导入论文、阅读整理、接入 Agent、Zotero | [docs/usage/](docs/usage/index.md) |
| **开发** | 路线图、TODO、设计记录 | [docs/development/](docs/development/index.md) |
| **测试** | 测试策略、发布 Checklist | [docs/test/](docs/test/index.md) |
| **Bug 复盘** | 历史 Bug 分析（不删除）；答辩间见 [docs/bug_fix/voice-defense/](docs/bug_fix/voice-defense/) | [docs/bug_fix/](docs/bug_fix/) |

约定：已实现按功能写在 `docs/frontend/` / `docs/backend/`；未实现草稿在 `docs/development/`。

## 文档站与发布

- 文档站使用 [MkDocs](https://www.mkdocs.org/) 与 Material for MkDocs 主题。
- `.github/workflows/docs.yml` 仅在 `main` 的文档相关变更后构建并部署到 `gh-pages` 分支。

## Commit

- 提交信息必须符合 [Conventional Commits](https://www.conventionalcommits.org/) 规范。
- 一次提交只做一件事，避免混合多个 unrelated changes。
- 项目级 Agent Skill：`.agents/skills/bump/SKILL.md` 定义版本升级流程；`.agents/skills/commit/SKILL.md` 定义按逻辑拆分当前改动并提交的流程。
- `bump` Skill 只更新并校验版本来源，默认不创建 commit、tag 或 push。
- `commit` Skill 必须保留用户已有改动，按目的精确暂存，检查相关文档，并只创建本地 Conventional Commit。
- 如果库当中有对应的 issue，则在提交信息中引用（如 `Fix #123`）；解决了该 issue 则关闭；部分解决则在 issue 区评论。
