# 测试

最新合并记录：[阅读器 #1077 接入上游更新](2026-11-12-reader-upstream-merge.md)，覆盖跨页选区、Markdown 批注、原文保留和连续阅读的兼容回归。

当前迁移记录：[上游 0.15.5 阅读器试用](2026-11-10-upstream-reader-trial.md)，安装包验收与历史 0.15.1 / 0.15.4 证据分开记录。

新增 [阅读选区映射验证](2026-11-10-reader-selection-mapping.md)：原生 Windows 开发版中，原文高亮/备注保存重开、译文句子映射及缺少句对时的动作边界；最终安装包验收不由该记录替代。

最新 PDF 回归：[2026-11-10 引用完整性、原文/译文与公式修复](2026-11-10-pdf-citation-formula.md)。此前出版社报告的悬停次数只覆盖加载和目标页，不能代替组合引用逐项验证。

当代码依赖 Vault 路径、Markdown 双链或论文元数据时，测试应优先创建真实的临时 Vault 目录和文件。保持 `src/` 与 `test/` 解耦：应用代码不能 import 测试 fixture 或 helper。

## 发布前验收

产品发布 / 打 tag / 分发安装包前的完整流程与 Checklist：

- **[发布流程](release.md)** — 桌面版与 iPadOS 版的 bump、tag、Release 资产、签名与公证要求。
- **[macOS 签名与公证](macos-signing.md)** — Developer ID、notarytool 与 stapler。
- **[iOS TestFlight](ios-testflight.md)** — iOS 签名、上传、App Store Connect 元数据与审核说明（无登录、配对 Notes）。
- **[发布前测试大纲（Checklist）](release-checklist.md)** — 按功能域（Vault、Library、入库、PDF、Agent、远程、CLI、平台矩阵）勾选；含 5 分钟冒烟与明确非目标说明。

PDF 与连续阅读的真实论文验证见 [15 篇扩展回归](2026-11-08-pdf-reader-regression.md) 和 [8 领域跨领域回归](2026-11-08-pdf-reader-crossfield.md)；后者包含作者年份预览、长文准备复用、[WebKit 异步页状态修复](../bug_fix/pdf-webkit-async-page-state.md)、[文档写入触发开发页刷新](../bug_fix/tailwind-dev-reload.md)及内存持有者取证。历史内存峰值退出仍需复现归因。

[2026-11-09 新样本与内存对照](2026-11-09-pdf-delivery-memory.md) 补充六篇、158 页冷解析 / 边界验证，以及旧前端、当前 PDF、当前阅读模式的同 Host 对照。新增阅读模式有明确内存成本，历史超限原因未确定；历史特殊版式与纯图片页存在重排限制；按最新需求，这两类不再作为本轮交付阻塞项。

[主流出版社补测与内存优化](2026-11-09-pdf-publishers-memory.md) 新增 13 篇、179 页，累计样本为 42 篇、793 页（包含历史边界样本）；记录出版社目标名、引用裁剪、重复文字修复，以及隐藏源页绘制的单变量内存对照。最终 118 次双模式代表悬停与分屏 / 原文定位 / 返回交互完成；源 PDF 的坏目标仍单列，不能推断所有现代论文无损。

[Windows 阅读器试用构建](2026-11-09-windows-reader-trial.md) 记录原生 x64 构建、相关回归、安装包验证与另一台电脑上的持续试用范围。

[Wiley 引用完整性回归](2026-11-10-wiley-citation-completeness.md) 记录新增九篇、770 处原生链接及 1,544 个引用成员的逐项检查；[阅读选区到 PDF 批注](2026-11-10-reader-selection-mapping.md) 记录跨页、原译混合、真实翻译和备注持久化。最终 Windows 包单独按[上游迁移试用报告](2026-11-10-upstream-reader-trial.md)验收。

## 目录结构

```text
test/
├── helpers/
│   └── create-test-vault.ts
├── scripts/
│   └── create-demo-vault.mjs   # 本地 demo / 手工验收用 Vault
└── *.test.ts
```

- `test/helpers/create-test-vault.ts` 用临时目录创建真实文件形态的 Vault。
- `test/scripts/create-demo-vault.mjs` 生成符合 catalog + 嵌套 paper 文件夹约定的 demo Vault（含 `.agentero/catalog.sqlite`，**schema_version = 3**）。
- 测试文件可以从 `src/` import 生产代码，但生产代码不能从 `test/` import。
- 优先在每个测试内声明最小必要 Vault 文件，让测试数据和断言靠近。

### Demo Vault 脚本

```bash
# 默认写到仓库 tmp/agentero-demo-vault
pnpm demo:vault

# ~/Downloads/agentero-demo-vault（嵌套 papers + catalog 样本数据）
pnpm demo:vault:downloads

# 仅 Create Vault 骨架（无样例论文 / 无 loose media）
pnpm demo:vault:empty -- ~/Downloads/agentero-empty-vault

# 校验已有目录
pnpm demo:vault:verify -- ~/Downloads/agentero-demo-vault
```

Demo 完整包内容（`--empty` 除外）：

| 类别 | 路径示例 | 用途 |
|---|---|---|
| 嵌套 paper 单元 | `papers/nlp/transformers/1706.03762/` | Library / NOTES / 双链 |
| paper 根 PDF | `{paper}/{id}.pdf` | 本地优先 PDF 预览 |
| 非 papers PDF | `assets/sample.pdf`、`notes/attachments/reading-list.pdf` | 任意路径 PDF 预览 |
| 图片 | `assets/figures/*.{png,jpg,gif,webp,svg,bmp,ico}` | 中间栏图片预览 |
| Catalog | `.agentero/catalog.sqlite` | schema v3（含 `is_read` / Translator 列）+ 样例 paper 行 |

每次生成会**重建** `catalog.sqlite`（避免重复跑脚本留下旧 schema）。依赖本机 `sqlite3` CLI。

## CI 与提交前检查

提交前的 lint-staged 对暂存的 TypeScript、JavaScript（含 `.mjs` / `.cjs`）等文件运行 `biome check --write`，统一检查格式、lint 与 import 顺序。`pnpm format:ts` 仅格式化，不能代替完整检查。

CI 的 TypeScript quality 任务分别显示发布同步测试、ACP adapter staging、Biome、类型检查和依赖边界检查；测试分片独立运行。Release 复用同一 CI 工作流检查 tag 对应的提交，全部通过后才创建 Draft Release 和构建产物。CI 使用只读仓库权限，并按调用工作流与 ref 隔离 concurrency，避免普通 CI 与 Release 的验证互相取消。

当前桌面 Rust 检查在 macOS 运行；Windows / Linux 桌面完整编译仍由 Release 构建覆盖，尚未加入日常 CI。

## 前端测试

运行 TypeScript 单元测试：

```bash
pnpm test
```

Vitest 适合覆盖纯 TypeScript 逻辑，例如：

- 双链解析与预览链接重写；
- Vault-relative 路径规范化与目标解析；
- settings、shortcuts、metadata、viewer 等 helper。

涉及 DOMPurify 的 HTML 渲染测试使用 `// @vitest-environment jsdom`（如 `paper-title.test.ts`）。DOMPurify 上游不支持 `happy-dom`，不要用 sanitizer mock 替代标签、属性与活动内容的实际过滤验证。

测试 Vault 语义时，创建临时 Vault 目录，不要在 `src/` 中引入全局 mock 数据：

```ts
const vault = await createTestVault({
 "notes/Source.md": "See [[notes/Target]].",
 "notes/Target.md": "# Target",
});

try {
 const files = await vault.listMarkdownFiles();
 // assertions
} finally {
 await vault.cleanup();
}
```

## Rust 测试

在仓库根目录运行 Host、共享基础层与 CLI 测试：

```bash
cargo test -p agentero
cargo test -p agentero-core -p agentero-cli
```

CI 的 `agentero-tests` 任务运行 Host 与 `agentero-plugin-host` 测试，包含真实插件子进程的取消、超时和资源限制；`cli-tests` 任务同时运行 `agentero-core` 与 CLI 自身的测试，并保留 CLI 构建检查。仅测试 Host/CLI 不会执行依赖 crate 的单元测试，因此必须显式选择共享 crate。两个 headless 包复用同一任务的 Rust 构建产物与 PDFium provisioning，不执行桌面 ACP adapter staging；PDFium 的构建与运行时路径由现有 CI provisioning 统一设置。桌面 `cargo test -p agentero` 与 `cargo clippy --workspace` 还要先有 `pnpm plugin-worker:stage` 放进 `src-tauri/binaries/` 的 sidecar，否则 `tauri-build` 会像缺少 `src-tauri/pdfium` 一样失败；`cargo test -p agentero-core -p agentero-cli` 不编译 `agentero`，不需要该文件。

`#[cfg(windows)]` 不会出现在 macOS job 里。`rust-windows`（`windows-latest`）跑同一组任务：quality（`cargo fmt --all --check` 与 `cargo clippy --workspace --all-targets -- -D warnings`）、`agentero-tests`、`cli-tests`。Windows 上 `tesseract-rs` 的 Debug `*d.lib` 和空 `eng.traineddata` 见 [CONTRIBUTING.md](https://github.com/poco-ai/agentero/blob/main/CONTRIBUTING.md)；测试任务因此使用 `--release`，让 CMake 产出并链接与 crate 匹配的库名。

解析器和 resolver 的边界用例可以放在对应 Rust 模块的 `#[cfg(test)]` 中。依赖 Vault 的 graph/index 测试应创建临时目录和文件，不依赖已提交的缓存文件。

子进程测试应在超时范围内等待就绪信号，避免用固定短 sleep 假定启动完成。ACP 终端测试等待 `ready` 输出，同时单独限制每次 output 调用耗时，继续验证运行中的输出读取和取消能力。

给子进程设定截止时间时要避开 Windows PowerShell 冷启动（CLR + 程序集加载）：在满载的 CI runner 上它可能远超 10 秒。不依赖 PowerShell 语义的测试应直接 spawn 快速命令（如 `cmd /C echo`）；必须用 PowerShell 的测试（如终端 stdio 探针）要给出宽裕预算并轮询就绪信号。

定量对比与瓶颈定位用可选的 JSONL 轨迹，不改变默认启动。见 [性能测试轨迹](performance.md)。

## 手动验证

纯逻辑优先用自动化测试覆盖。涉及 UI 或桌面流程时，还需要启动应用检查受影响路径。如果 dev 端口被占用或无法做浏览器/桌面验证，汇报时需要明确说明。

Linux 桌面验收与 Rust 编译不要同时使用同一 `target` 目录。`tauri-build` 会原地复制 bundle resources；若 PDF 已加载 `target/debug/pdfium/libpdfium.so`，另一次 `cargo test` / build 覆盖该文件会破坏进程内的库映射，使 PDFium 在正常退出的 C++ 标准流析构阶段崩溃。先结束编译再启动验收；需要并行时为构建设置独立的 `CARGO_TARGET_DIR`。排查退出崩溃时先确认运行期间资源文件是否被覆盖。

WebKitGTK 自动化验收结束时，通过 `getCurrentWindow().close()` 触发 Tauri 原生关闭，再确认进程退出码。不要先调用 WebDriver 的关闭窗口接口：它会结束网页会话，而应用的关闭保存回调仍需前端执行，随后再关闭 GTK 窗口可能只留下后台进程。

建议用 `pnpm demo:vault` 生成的 Vault 做冒烟：

| 场景 | 预期 |
|---|---|
| 打开 demo vault | catalog 5 篇、Library 可见、tags 可筛 |
| 点 `assets/sample.pdf` / `notes/attachments/*.pdf` | 中间栏 PDF 预览（非 papers 路径） |
| PDF 工具栏：页码 / 底部缩放滑动条 / 大纲 / `⌘F` | 跳页、缩放、书签跳转、命中高亮 |
| PDF 划词 | 平滑蓝色选区 + 操作菜单（高亮/笔记/提问/翻译） |
| 点 `assets/figures/*` 图片 | 中间栏图片预览 |
| Notes / `.md` 中粘贴图片 | 生成 `{mdDir}/assets/*`，正文 `![](./assets/…)`；文件树可见新文件 |
| 选中文档中的图片节点 | 显示 Markdown 源码而非位图；取消选中恢复预览 |
| 删除文档中的图片节点 | 若无其它引用，磁盘 `./assets/` 文件同步删除并刷新树 |
| 文件树删除一项 | 无确认弹窗；项进回收站；Library 下虚拟节点 Trash 打开中间栏可恢复 |
| Library Rescan | 盘上有 catalog 无的 paper 重新出现在表中 |
| 外部编辑器改打开的 `.md` | 应用内编辑器自动重载为磁盘内容 |
| 打开多 tab 后连按 `⌘W` | 无弹层时逐个关 tab；仅剩全库后再按关窗口 |
| 打开设置后 `⌘W` / `Esc` | 先关设置，不关标签 |
| 命令面板 `⌘P` / `⇧⌘P` 打开后再按同键或 `⌘W` | 关闭面板 |
| 触发删除失败 / 无 Vault 操作等 | 右上角 Toast，不出现侧栏 header 错误条 |

## 文档验证

修改 docs 或 `mkdocs.yml` 后运行：

```bash
mkdocs build --strict
```

如果本地未安装 MkDocs，先创建文档环境：

```bash
python3 -m venv .venv-docs
. .venv-docs/bin/activate
pip install mkdocs-material==9.7.1
mkdocs build --strict
```
