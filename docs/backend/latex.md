# LaTeX 编译与项目服务

正式构建由 `src-tauri/src/features/compile/` 实现，继续使用 JobCenter 的 `LatexCompile` 任务。实时预览是独立的 LuaLaTeX 会话，见 [rtex.md](rtex.md)。前端交互见 [../frontend/latex.md](../frontend/latex.md)。

## 模块和契约

| 模块 | 职责 |
|---|---|
| `mod.rs` | 引擎发现、ChkTeX、兼容旧清理命令、任务 runner 注册 |
| `root.rs` | magic root、主文件标记、反向 include 图、subfiles 父文件发现 |
| `project.rs` | 章节与 bibliography 递归扫描、候选主文件、合并 recorder 依赖 |
| `types.rs` | Recipe / Tool / BuildOptions、输出与中间产物路径计算 |
| `runner.rs` | 顺序执行配方、构建日志、进度、取消、结果发布 |
| `diagnostics.rs` | 编译诊断、章节文件栈、跨行警告、`.fls` INPUT 解析 |
| `tools.rs` | SyncTeX、配置产物清理、子进程环境 |

`job_latex_compile_enqueue` 的 `build` 为可选项，旧 `{ engine }` 调用仍有效。它接受 recipe、outDir、auxDir、jobname、force、clean。任务层 `force` 控制已结束任务的去重；`build.force` 才表示强制重建，两者不能混用。

`src/lib/tex/host.ts` 提供前端类型和调用包装。所有新 command 注册在 `app/handlers.rs` 与 `app/bindings_test.rs`；Rust 签名变更后运行：

```bash
AGENTERO_UPDATE_BINDINGS=1 cargo test -p agentero export_typescript_bindings
```

## 构建行为

默认配方通过 latexmk 调用 PDFLaTeX / XeLaTeX / LuaLaTeX，启用 `-file-line-error`、`-synctex=1`、`-recorder`、nonstopmode 和 halt-on-error。普通构建保留 latexmk 增量判断；force 增加 `-g`；clean 先清理可再生产物再重建，保留已有 PDF。

自定义 recipe 是顺序执行的工具列表。每个工具有 command、独立 argv、可选 env 和 cwd；不把 argv 拼成 shell 命令。支持：

| 占位符 | 值 |
|---|---|
| `%DOC%` | 主文件绝对路径，包含 `.tex` |
| `%DOCFILE%` | 主文件名，包含扩展名 |
| `%DIR%` | 主文件目录 |
| `%OUTDIR%` / `%AUXDIR%` | 解析后的输出 / 中间产物目录 |
| `%JOBNAME%` | 产物文件名，不含扩展名 |

相对 cwd、可执行文件、输出参数按同一工具上下文解析。工具环境先展开占位符，再用其 `PATH` 查找命令；相对 `PATH` 条目按工具 cwd 解析，显式 `PATH` 查找失败不回落系统路径。Windows 按大小写不敏感处理 `PATH` / `PATHEXT`。兼容的编译器步骤会接收项目显式输出参数；任意 helper 工具保留原参数。直接 TeX 引擎不支持分离 aux 时明确报错，建议使用 latexmk。

产物路径统一由 `latex_build_artifacts` 计算。PDF 与 `.synctex.gz` 位于输出目录，`.fls` 与 `*.agentero.log` 位于 aux 目录；`*.agentero.log` 保存整条配方的输出，不覆盖引擎自己的 `.log`。自定义工具需要让参数与声明的产物布局一致。

## 日志与诊断

- `compile:log`：jobId、rootPath、line。
- `compile:finished`：jobId、rootPath、success、PDF / log / SyncTeX 路径、dependencies、diagnostics。
- 每条诊断包含 path、1 起始的 line / column、severity、message、source。
- `Missing character:` 记为警告。`Unable to load picture`、未知图片扩展名和 `Package graphics Error` 记为错误。`ERROR -` / `WARN -` 仍归到 Biber。

无 `file:line:` 前缀的警告借助 TeX 日志文件栈恢复章节归属。引擎日志补充 console 未输出的警告。取消既覆盖流式读取，也覆盖 stdout/stderr 关闭后的进程等待；Unix 使用独立进程组，Windows 把 latexmk / chktex / synctex 放进独立 Job Object，关闭句柄时结束启动器及其引擎后代，不再靠 `taskkill /T`。

`.fls` 表示引擎读取的真实文件，但通常没有 BibTeX/Biber 读取的 `.bib`。前端必须保留项目扫描得到的 bibliography 依赖，不能用 recorder 列表直接覆盖。

## 项目与 SyncTeX

`latex_project_inspect(texPath, vaultPath, rootPath?, build?)` 返回主文件、候选根、TeX 文件、BibTeX 文件和实际依赖。显式 root 可用于 standalone subfiles；build 参数决定读取哪份 `.fls`。普通 include 优先按项目编译目录解析，再尝试声明文件目录。

SyncTeX command 调用本机 `synctex`，返回页码、PDF 点坐标或源码文件 / 行 / 列；前端负责缩放与旋转转换，保持与 EmbedPDF 的坐标体系一致。Windows 上路径含非 ASCII 时，`synctex` 的标准输出可能是 UTF-16 或系统 ANSI（中文环境常见 GBK）。`tools.rs` 先识别 UTF-16，再按 UTF-8、GBK 解码，解析失败时才退回有损 UTF-8，避免非 UTF-8 直接报错。

本地 TeX 工具由用户安装。正式构建与 SyncTeX 属于本机桌面能力，不提供远程编译服务。

## 写作项目同步

`writing_sync_project(projectDir, remote, branch)` 在用户点击上传，或按设置在编译后、定时运行。`projectDir` 是一个项目目录，必须位于名为 `thesis` 的书架下（`thesis/<项目>`）；旧 Vault 把主文件直接放在 `thesis/` 时，`thesis/` 本身就是一个项目。仓库根就是项目目录，所以 `git init`、`.gitignore`、提交和推送都只落在这一个项目里，其他项目互不影响，各自绑定自己的远端。`remote` 只接受 `github.com` 上的仓库，并规范成 `https://github.com/<owner>/<repo>.git`。没有 `.git` 时先 `git init`，再补上忽略编译产物和 `*.pdf` 的 `.gitignore`（已有规则不覆盖），把 `origin` 设成这个地址，然后 `git add -A` 并提交。提交说明写的是这次改动的文件名。已配置 `user.name` 时沿用；否则只给这个仓库写本地身份，不改全局 Git 配置。接着 `git fetch`，远端已有提交时把本地改动变基上去；冲突会中止变基，不覆盖任何一边。最后 `git push -u origin HEAD:<branch>`。拉取和推送允许系统弹出 GitHub 登录窗口，应用不保存密码。桌面进程的 PATH 里没有 `git` 时，还会查找常见的 Git for Windows 安装位置。每次调用都带 `safe.directory=*`，避免文稿在 OneDrive 目录下时被 Git 拒绝。Windows 上这些 Git 命令与资料库同步走同一套 Job Object：超时或取消时关掉整个进程树，不留下 `git-remote-https` 一类后代。没有 Git 时返回 `git_missing`，不报成崩溃。

`writing_git_log(projectDir)` 列出这个项目最近的上传，每条带上改过的文件和增删行数；工作区里还没上传的修改放在最前面。`writing_git_diff(projectDir, commit)` 返回这一次的文本差异，`commit` 为 `pending` 时是尚未上传的修改。`writing_git_restore(projectDir, commit)` 只重置这个项目的工作区。没有本地快照目录。

## 验证

```bash
cargo test -p agentero features::compile --lib
cargo test -p agentero app::events_contract --lib
cargo test -p agentero export_typescript_bindings --lib
```

回归覆盖参数注入、cwd 与相对路径、产物推导、章节诊断、配置后的 recorder、SyncTeX、subfiles 和管道关闭后的取消。跨平台发布仍走项目现有 CI。

SyncTeX 的 UTF-16 输出按两个字节的定长数组解码，兼容 CI stable Clippy 的分块检查；编码识别及大小端处理保持不变。
