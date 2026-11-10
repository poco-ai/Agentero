# 本地桌面应用检测

Agent 设置页与 Onboarding 的「本地桌面应用」区块列出若干**不支持直接 ACP 接入** 的流行 AI 桌面端 App（ChatGPT、千问办公 / QwenWork、腾讯 WorkBuddy、Dsh 桌面版）。它们装了也不会作为桌面 GUI 出现在 Agent 目录里，这个区块向用户解释原因；设置页允许直接打开。

四个 App 的 GUI 都不说 ACP，但**都自带一个会说 ACP 的 CLI**，Agentero 直接复用该 CLI 接入（见下文「应用包内置 CLI」）：ChatGPT → Codex、WorkBuddy → CodeBuddy、千问办公 / QwenWork → Qoder CN、Dsh 桌面版 → Dsh。因此这个区块不再标注「暂不支持」，而是统一标注「自带 CLI，可接入」；对应 Agent 出现在上方 CLI 目录里，并在卡片上带「桌面内置」标记。

Dsh 桌面版与 Dsh CLI 使用独立 ID：桌面应用为 `dsh-desktop`，名称显示「Dsh 桌面版 / Dsh Desktop」，已安装时标注「暂不支持」；CLI 模板仍为 `dsh`，通过 `dsh --profile acp` 接入。桌面应用的检测不以 npm `dsh.cmd`、Node 或 `~/.dsh` 用户数据目录作为安装依据。

## 应用包内置 CLI

桌面端只在「用户没自己装 CLI」时作为兜底，PATH 安装永远优先。四个已知来源：

| App | macOS 内置 CLI | Agent 模板 |
|---|---|---|
| ChatGPT | `ChatGPT.app/Contents/Resources/codex-cli/bin/codex` | `codex-acp` |
| WorkBuddy | `WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`（`@genie/agent-cli`，bin 名 `codebuddy` / `codebuddy-code` / `cbc`） | `codebuddy` |
| 千问办公 / QwenWork | `QwenWork.app` / `QwenWorkCN.app` 的 `Contents/Resources/bin/qoderclicn` | `qoder-cn` |
| Dsh 桌面版 | `DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` | `dsh` |

Codex / Dsh 走 `crates/agentero-core/src/process/desktop_cli.rs` 的目录注入（把应用包内的 bin 目录以低优先级追加到 PATH）；Qoder / CodeBuddy 走 `features/system/desktop_apps::bundled_cli()` 的按名解析（Claude/Codex 之外的模板没有同名二进制，只能按名映射）。两者共用同一个判据——真实可执行文件，不做目录名字猜测。

千问办公有两个发行版，包名与 bundle id 不同（2026-11-10 实测，**均为挂载官方 DMG 检查**，国际版未安装到本机）：

| 发行版 | `.app` 包名 | bundle id | 内置 CLI |
|---|---|---|---|
| 国际版 QwenWork 1.4.0 | `QwenWork.app` | `com.qwenwork.desktop.mac` | `Contents/Resources/bin/qoderclicn`（1.1.71） |
| 大陆版 千问办公 2.0.0 | `QwenWorkCN.app` | `cn.qwenwork.desktop.mac` | `Contents/Resources/bin/qoderclicn`（1.1.71） |

两个发行版当前内置的都是**大陆版**引擎，判定依据（三项独立证据）：

1. 国际版包内的 `app-update.yml` 更新源是 `https://static.qoder.com.cn/qwen-work-cn/releases`，即直接复用大陆构建产物；
2. 两边 `qoderclicn --version` 都是 `1.1.71`（sha256 不同：国际版包内 `87dbe7f2…`、大陆版 `48d37c58…`，属同版本的两次构建）；
3. `qoderclicn --acp` 的 `initialize` 返回 `agentInfo = {name: "qoder-cli-cn", title: "Qoder CLI CN"}`。

因此只有 `qoder-cn` 模板会回退到它。`qodercli`（国际版）模板只认 PATH 上用户自己装的 `qodercli`，不会拿这份引擎顶替——它连的是大陆服务，混用会把国际账号接到错误的区域。`bundled_cli("qodercli")` 仍保留 `qodercli` 分支，等国际版将来真的自带国际引擎时无需改代码。

解析顺序是 **PATH 优先**：PATH 上存在同名 CLI 时用用户自己装的，只有缺失时才回退到应用包内的绝对路径。启动、目录扫描、可用性判断共用同一个解析函数（`acp::client::resolve_acp_entry`），避免出现「显示已安装但拉起失败」。

`CatalogEntry.resolved_path` 指向应用包内时，CLI 卡片会显示「桌面内置」徽标（前端 `isDesktopBundledCliPath()` 判定，Settings 与 Onboarding 共用）。

交互式 CLI（终端里 `qodercn login`、`codebuddy login`）仍按 PATH 解析，不指向应用包内的二进制——登录和版本升级需要用户自己装的完整 CLI。

## 定位

- **只读展示**：这些 App 不实现 Agent Client Protocol，Host 无法以 ACP 与之通信，因此不进注册表。
- **本地优先**：只检查本机安装痕迹，不读账号、不发网络请求。
- **尽力而为**：可能漏报（便携版、非标准路径、Spotlight 关闭、多用户），UI 必须有兜底（未装即灰度）。检测只作提示，不驱动任何必须步骤。

## 命令

| 命令 | 说明 |
|---|---|
| `desktop_apps_probe` | 返回 `DesktopAppStatus[]`（`id` / `installed` / 可选 `path`），顺序固定 ChatGPT → QwenWork → WorkBuddy → Dsh Desktop。 |
| `desktop_app_open(id)` | 启动已安装的 App。 |

均走 `Result<ApiResult<T>, String>`（specta `typedError`）；探测里的 Spotlight 查询会 spawn `mdfind`，故经 `core::blocking::run_blocking` 移出 UI 线程。

## 检测方式（macOS）

1. 直接探测 `/Applications/<name>.app` 与 `~/Applications/<name>.app`（用户可能装在个人目录）。
2. `mdfind "kMDItemCFBundleIdentifier == '<id>'"` 兜住被移动的 App（ChatGPT 新版 `com.openai.codex` / 旧版 `com.openai.chat`，千问办公大陆版 `cn.qwenwork.desktop.mac`）。
3. `mdfind "kMDItemFSName == '<name>.app'"` 文件名兜底。千问办公按 `QwenWork` / `QwenWorkCN` / `千问办公` 三个名字探测——大陆版官方 DMG 装出来的是 `QwenWorkCN.app`（`CFBundleName` 也是 `QwenWorkCN`），漏掉它会误报「未安装」。

**刻意不做**：扫描 `~/Library` 或 `~/.<app>` 残留目录。已卸载但留下日志/数据的 App 会因此被误判为「已安装」（WorkBuddy 卸载后仍留 `~/.workbuddy-ai` 等，是典型反例）。可靠判据只有真实 `.app` bundle 与系统注册信息。

## 检测方式（Windows）

1. ChatGPT：直接读取当前用户的 AppModel `Repository\Packages` 安装注册，支持 `OpenAI.ChatGPT-Desktop`、`OpenAI.ChatGPT` 与新版仍使用的 `OpenAI.Codex` 包标识。读取 `AppxManifest.xml`，校验注册的 UI Application、实际 `ChatGPT.exe` 与包标识；不以 `%LOCALAPPDATA%\Packages` 残留目录判定安装。
2. 千问办公 / QwenWork、WorkBuddy：读取 HKCU / HKLM 的 32 位与 64 位 `Uninstall` 注册表视图，匹配 `DisplayName`。从 `DisplayIcon`、`InstallLocation` 或 Inno `UninstallString` 所在目录定位应用；卸载程序本身不会作为启动目标。
3. 补充读取 `App Paths` 与 WorkBuddy 的 `workbuddy` 协议命令，再检查 `%LOCALAPPDATA%\Programs` / `%ProgramFiles%` / `%ProgramFiles(x86)%` 下的已知安装目录。

Dsh 桌面版复用以上 Win32 探针，按官方安装包的 `DeepSeek Harness` 产品名匹配卸载表，解析 `DeepSeek Harness.exe`；同时支持 `App Paths`、`dsh` 协议和标准安装目录。macOS 按 `DeepSeek Harness.app` 检测，尚未真机验证。产品名与协议来自[官方桌面打包配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/scripts/electron-builder-config.mjs)。

Dsh 补充验证（2026-10-09）：隔离 Windows 注册表用例确认已安装桌面 exe 能命中，单独的 `dsh.cmd` / `.dsh` 目录及失效安装记录不会误报。本机未安装官方桌面包，尚未验证它的真实安装与打开流程；Settings / Onboarding 窗口视觉验收仍待完成。

所有路径均要求对应应用的原生 `.exe` 存在且通过共享进程层的 PE 文件头校验。空目录、失效注册表记录、卸载残留以及 `.workbuddy-ai` 等用户数据目录不会使行高亮。探测不启动 PowerShell / winget，不读取账号数据。

## 打开

`desktop_app_open` 优先 `open <resolved .app path>`，未解析到路径时回退 `open -a <name>`。ChatGPT 新版同时注册 `codex://` scheme，后续如需带参深链可在此扩展。

Windows 在打开前重新检测安装：MSIX 用 `explorer.exe shell:AppsFolder\<PackageFamilyName>!<AppId>` 激活注册的 UI 入口；原生桌面应用直接启动解析到的 `.exe`，无需 shell。后台启动隐藏控制台窗口，不执行注册表中的完整命令串。

## 平台

支持 macOS 与 Windows。Linux 仍返回 `installed=false`，待实现 `.desktop` / Flatpak / Snap 安装探针并在 Linux 真机验证。

Windows 回归覆盖中文名称、含空格路径、图标索引、卸载表来源、Inno 目录回退、App Paths、协议、失效记录、缓存残留，以及 MSIX 注册的 UI 入口和非 UI helper 区分。测试使用隔离的 HKCU 测试键，不修改真实安装记录。

Windows 本机验证（2026-10-08）：对同一台已安装 `OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0` 的机器运行修改前后的后端源码，ChatGPT 从 `installed=false` 变为 `true`，返回实际 `app\ChatGPT.exe`，MSIX 打开调用成功。一次三应用探测约 24 ms（非性能基准）。本机未安装千问办公 / WorkBuddy，其安装和卸载场景仅由隔离注册表回归覆盖；尚未做这两个产品的真实安装测试，也未做 Settings / Onboarding 窗口视觉验收。

## 代码

- 检测：`src-tauri/src/features/system/desktop_apps/`
- 前端：`src/components/settings/desktop-apps-rows.tsx`、`src/lib/system/desktop-apps.ts`
