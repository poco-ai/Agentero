# 直接导入 PDF 无法生成 PAPER.md（#303）

**状态**：已修复

## 问题

在**安装包**版本（0.5.5, macOS）里导入本地 PDF，`PAPER.md` 永远生成不出来，界面
只表现为“一直解析中 / 解析失败”。`pnpm tauri dev` 一切正常，所以长期没被发现。

## 根因链路

liteparse 不静态链接 PDFium，而是运行时 `dlopen`。`liteparse-pdfium-sys` 的
build script 把 PDFium 下载到**构建机**的 OS 缓存目录，并把那个绝对路径 bake 成
`PDFIUM_LIB_DIR`。它的运行时搜索顺序是：`PDFIUM_LIB_PATH` → bake 的
`PDFIUM_LIB_DIR` → 自身模块同级 → exe 同级 → 裸库名。

打包产物里这些位置全都没有 dylib：

```
$ ls /Applications/Agentero.app/Contents/MacOS/
agentero  agentero-cli          # 没有 libpdfium.dylib，也没有 Frameworks/
```

`tauri.conf.json` 的 `bundle` 只声明了 `externalBin`，既没有 `resources` 也没有
`macOS.frameworks`；release workflow 也没有 provision PDFium（只有 `ci.yml` 为跑
测试临时下载）。于是在用户机上：

1. `load_default()` 全部候选失败；
2. `liteparse-pdfium/src/library.rs` 用的是
   `.expect("failed to load pdfium shared library")` → **panic，子进程退出码 101**；
3. `run_liteparse_markdown` 用 `Stdio::null()` 丢掉了子进程 stderr，只剩一句
   `read isolated PDF parser response (status ...)`；
4. `run_parse_body_job` 对 `Ok(_)` 一律标记 `Succeeded`，`PaperParseResult.messages`
   被整体丢弃 → 任务面板显示“已完成”，用户完全看不到真实原因。

核心错误（本来只在子进程 stderr 里）：

```text
failed to load pdfium shared library
could not find pdfium shared library
Set PDFIUM_LIB_PATH to the directory containing libpdfium.dylib
```

## 修复

**随包分发 PDFium**

- 新增 `scripts/prepare-pdfium.mjs`（`pnpm pdfium:stage`）：按 target triple 解析
  PDFium 资源，优先用 `PDFIUM_LIB_PATH` / 平台缓存，缺失则从 pdfium-binaries
  release 下载，产物落到 `src-tauri/pdfium/`（gitignore）。macOS 顺带
  `install_name_tool -id @rpath/libpdfium.dylib`。
- `beforeDevCommand` / `beforeBuildCommand` 都会跑 `pnpm pdfium:stage`，因此本地
  与 CI release 都自带，不需要额外 workflow 步骤。
- macOS 走 `bundle.macOS.frameworks` → `Contents/Frameworks/libpdfium.dylib`：
  tauri-bundler 对 `.dylib` 会拷进 Frameworks **并登记为 codesign target**，
  公证不会因为嵌套未签名 Mach-O 被拒。Windows/Linux 走
  `bundle.resources: ["pdfium/*"]`；iOS/Android 清空 `resources`。

**运行时定位**

- `pdf_parse::bundled_pdfium_dir()` 从 `current_exe` 探测 `../Frameworks`、
  `pdfium/`、`../lib/agentero/pdfium`（deb/AppImage）等位置，作为
  `PDFIUM_LIB_PATH` 传给解析子进程；外部已设置该环境变量时不覆盖。

**让真实原因可见**

- 子进程 stderr 重定向到 worker 临时目录的 `stderr.log`（用文件而非管道，取消
  用的 `select!` 循环不会去 drain 管道）；拿不到 response 时把尾部 800 字符拼进
  错误消息。
- `PaperParseResult` 增加 `error: Option<String>`，只在真正失败时设置；跳过
  （有 TeX / 已有 `PAPER.md` / 无 PDF / 已在解析中）与取消都不算失败。
- `run_parse_body_job` 见到 `error` 就把 job 标记 `Failed`，任务面板的错误详情
  因此能显示真实原因；`agentero paper parse` 同样改为返回非零错误。

## 遗留（CLI 归档，已补）

桌面安装包修好之后，**独立 CLI 归档仍然只有可执行文件**。`liteparse-pdfium-sys`
bake 进去的是 GitHub Actions runner 的缓存路径
（`C:\Users\runneradmin\AppData\Local\pdfium-rs\...`），用户机器上不存在。
`paper parse` 的隔离子进程因此在约 30 ms 内 panic，退出码 101，任何没有 TeX 的
PDF 都写不出 `PAPER.md`。

子进程其实就是 `current_exe()` 再拉起自己，并且会继承 `PDFIUM_LIB_PATH`。把
**run-llama `chromium/8058`** 的 `pdfium.dll` 放在 exe 旁边，或把
`PDFIUM_LIB_PATH` 指到那个目录，父进程这条路径是通的。stock PDFium
（bblanchon/pdfium-binaries 等）`LoadLibrary` 能成功，但缺 fork 导出；
`Library::init` 把 `load_default()` 的路径和符号错误丢掉，只留下
`LibraryUnavailable`，所以看起来像「环境变量和 exe 目录都没被搜索」。

修复：

- CLI release 归档带上 `scripts/prepare-pdfium.mjs` 暂存的同一份库，与可执行文件同级。
- 安装 CLI 时解出该库；旧归档没有它时，从当前 App bundle 拷贝。
- worker 在调用 liteparse 之前按绝对路径 `load`。显式路径加载失败会再试 bundle
  里的库，避免一个错误的 `PDFIUM_LIB_PATH` 挡住随包文件。失败信息写进
  response，不再 panic。

## 验证

- `cargo fmt --all`、`cargo clippy -p agentero -p agentero-cli --all-targets`
- `cargo test -p agentero pdf_parse`
- `pnpm tauri build --bundles app` 后 `Contents/Frameworks/libpdfium.dylib` 在位
- 临时移走 `~/Library/Caches/pdfium-rs`（模拟干净机器）后，打包应用导入本地 PDF
  仍能生成 `PAPER.md`
- 把包内 dylib 改名后重试，任务面板出现失败的「解析 PDF 正文」并带真实原因
