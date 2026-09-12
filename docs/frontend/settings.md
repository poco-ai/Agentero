# 设置与主题

## 设置窗口

- 独立原生单例：`settings_window_open` + `?window=settings` → `SettingsNativeRoot`。
- macOS Overlay 标题栏 + 交通灯；Windows/Linux 系统原生边框。标题栏与侧栏共用 `--sidebar` 材质（macOS 标题栏 `backdrop-blur`；`prefers-reduced-transparency` 下实色）。
- 开/关：`⌘,`、菜单、齿轮；`Esc` / 标题栏 X 关闭。
- 不查询或展示本机 hostname / OS 身份。
- 保存：`settings_set` → 广播 `settings:changed` 跨窗口同步。
- 落盘：XDG `$XDG_CONFIG_HOME/agentero/settings.json`。
- 加载策略：设置 webview 不加载完整 `App`，也不加载 PDF 引擎与 KaTeX（二者随 `App` 动态 import）。各分区 pane 按 `lazy()` 分 chunk；**当前分区**的 pane 与外壳并行预热（`preloadSettingsPane`），避免窗口刚可交互时才去拉 pane 而卡一下；其余分区首次访问才加载，已访问的保持挂载。
- 通用页的「网络代理」是 Host 级配置，启用后用于 Host 创建的 HTTP(S)/SOCKS 请求，并同步注入本地与远端 Agent 进程的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`。旧版 Settings → Agent 的代理配置会在首次启动时迁移。

### UI 约定（System Settings 风格）

共用件在 `src/components/settings/settings-layout.tsx`：

| 元件 | 约定 |
|---|---|
| `PageTitle` | Title 3：`text-base` + `font-semibold`（字距/行高走字号阶梯 token） |
| `SettingsSectionLabel` | Callout 大写小标题：`text-xs` + `font-medium` + muted（避免 `text-caption` 被 twMerge 与 `text-muted-*` 互斥吃掉） |
| `SettingsGroup` / `settingsCardClassName` | 圆角 inset 卡片：`rounded-xl`、淡边框、极轻阴影 |
| `SettingsRow` / `settingsRowClassName` | Body 行：`text-sm` 常规字重、`min-h-10`、柔和行间分隔 |
| `HelpLabel` | 可键盘聚焦的 `?` 按钮（Tooltip），按压有微缩反馈 |

侧栏（`SettingsContent`）：

- 材质：`bg-sidebar` / `border-sidebar-border`；选中项滑动高亮（`sidebar-primary`）+ `font-medium`；按压 `scale(0.98)`；方向键在导航项间移动。
- 内容区：`overscroll-y-contain`；切换分区平滑滚回顶部（尊重 `prefers-reduced-motion`）；pane 进入短时 opacity 交叉淡入。
- 主题预览卡：选中 inset ring + 按压缩放；slider 带 `aria-valuetext`。

## 主要分类

| 分类 | 内容示例 |
|---|---|
| 通用 | Translator URL、EasyScholar Key（输入后点确定保存并探测，色点显示可用/不可用/未配置；留空则禁用。配置后可在 Library 表头 Tags 列一键为当前范围内全部论文获取 `#easyscholar:` 命名空间的分区/影响因子标签）、Connector 开关、**MCP server** 开关（loopback Streamable HTTP，默认关；同区块可填 ChatGPT Secure MCP Tunnel 的 Runtime API key / Tunnel ID 并一键起停，接 ChatGPT 见 [用 MCP 连接外部 Agent](../usage/mcp.md)）、**广场开关**（`plazaEnabled`，默认开；关闭后侧栏隐藏且不挂载广场面板）、网络代理、**GitHub 镜像**（Skill 导入直连失败时的 URL 前缀回退，见 [backend/skill-import.md](../backend/skill-import.md)）、文件树标签/排序、打开行为（`autoOpenPaperNotes` 默认开，关闭后打开论文只开 PDF/HTML、不自动分屏 NOTES；`replaceCurrentTabOnOpenPaper` 默认关，开启后打开新论文会先关闭当前标签页）、笔记导出默认水印、隐私（PostHog `telemetryEnabled` 控制是否上报；本机 `usage.sqlite` 记录始终开启、可一键清除） |
| Appearance | 明暗、`uiTheme`、`uiScale`；界面/正文/等宽字体；Markdown 字号 / 行距 / 工具栏 |
| Agent | 目录两层检测（Agent CLI / ACP）、未装「安装」/ 缺 ACP「安装 ACP」/ **有可静默升到的新版本时**「升级」（本地 `--version` 对比 npm latest 或 dsh pin；探测中/失败/hermes 等无法判定时不显示）、已安装或已注册行「卸载」（Trash 按钮 → 确认对话框展示 logo 与清理项：npm 全局包、受管目录，或仅注册项）、安装 / 升级进行中行内显示阶段进度条与取消（X）按钮（点击静默中止安装子进程，不弹错误）、默认 Agent、权限模式、自动精读、可选 **User-Agent**（Codex 中转亲和）、个人提示词、划词提问 Agent、**Embedding 端点**（arXiv 每日推荐用；`source` 在「Agentero 内置」与「自定义接口」之间切换，选内置时隐藏 Base URL / API Key / Model 三个输入框以及探测色点和 Test 按钮——凭证来自构建期注入，见 [../backend/builtin-provider.md](../backend/builtin-provider.md)） |
| 翻译 | 默认服务选择（含**内置 provider** `agentero`：无凭证卡片、无探测色点，可用性来自 Host `builtin_provider_status`；构建未注入 key 时禁用，当前已选中则仍留在列表里）、商用 API 配置、语言与 Agent 座 |
| 同步 | S3 兼容云同步配置、顶部常见服务商 logo 打开官方配置指南、自动同步、同步范围逐类开关；标题旁色点显示未连接 / 已连接 / 同步中 / 错误，标题右侧放置连接 / 保存 / 立即同步主操作，底部仅保留解绑 |
| 知识库诊断 | 主机运行环境 / 网络连通性 / Agent ACP 连通性 / Vault / Catalog / 双链 / 论文 aliases / 视觉批注格式；本地 Vault 可确认批量修复 |
| 关于 | 版本信息与应用更新、CLI 安装/卸载（状态行由结构化字段推导并全部走 i18n，不直接展示后端英文 message；安装/卸载失败 Toast 带真实错误原因；安装成功后展示可复制的验证命令 `agentero(-cli) --version`，Windows 额外说明已自动加入用户 PATH、开新终端即可、无需重启；应用更新重启后 main window 启动时自动把已安装 CLI 同步到新版本，成功静默、失败 Toast，见 [docs/backend/cli.md](../backend/cli.md)）、「打开日志文件夹」与「清理日志」（`appLogDir()` / Host `logs_clear`，见 [backend/logging.md](../backend/logging.md)）；标题右侧「Star us on GitHub」打开仓库 |

知识库诊断页调用 Host 的只读 Doctor 报告。检查项各自作为小标题（带一行检测说明），标题行右侧显示 icon + 问题数；模块间用非通栏次要分隔线。列表过长时（双链 / 别名 / 视觉批注）`max-h` 内滚动。视觉批注一节可将旧版 `agent-trace` mark 一键升级为 `visual` v2。

- **主机运行环境**（`doctor_check_host`）：提示性检查 Node.js / npm 可用性（路径与版本）；不依赖 Vault，未打开 Vault 时也显示。不再展示 Codex 登录状态。检查失败时错误写在该分区卡片内，不弹 Toast。
- **网络连通性**（`doctor_check_network`）：按当前全局代理设置并行探测 Baidu / Google / Google Scholar / GitHub / arXiv / Semantic Scholar；一行一个端点，左侧状态点，右侧显示耗时或失败原因；失败时在行内展示原始错误与修复提示。不依赖 Vault，未打开 Vault 时也显示。独立加载，探测期间刷新按钮禁用。
- **Agent ACP 连通性**（`doctor_check_agents`）：探测前先 `scan_catalog` 自动注册 PATH 上已装的目录 Agent（不必先打开设置 → Agent）；再对每个已注册 Agent 执行 ACP initialize 并写回 registry（Agent 目录页同步刷新）。每个 Agent 以卡片展示：版本在上、路径在下（Agent / ACP / 登录）；失败按原因分类并给出 hint；错误写在卡片内不弹 Toast。探测中显示 shimmer。最长约 30s/Agent，独立加载；探测期间刷新按钮禁用。

- **论文别名**：勾选与编辑标题/短 alias，标题行「修复」→ 确认后批量写入 frontmatter（不改 path）。单行「忽略」或「忽略所选」把路径写入 Vault `.agentero/doctor.json`，下次诊断不再报错；列表底部可恢复。
- **双链语义**：
  1. 「探测」→ 自动建议（默认勾选）+ 可手改候选项（默认不勾选）；
  2. 每条 git 风格整行 diff：核心变更居中高亮，按设置窗宽度窗口化前后文；
  3. 标题行「全选 / 修复」应用选中项；
  4. 下方 Agent 提示词（随 UI 语言 en/zh）：复制，或「在 Agent 中打开」（关设置、打开主窗 Agent 并预填 composer）。

主窗口把未保存的 Markdown 路径同步到 Host，因此独立设置 Webview 发起修复时仍能在任何写入前拒绝脏文件。远程 Vault 首版只显示不可用。

相关代码：`src/lib/doctor/`、`src/lib/agent/composer-seed.ts`。诊断页外壳 `src/components/settings/panes/doctor-pane.tsx` 只做报告拉取与分区编排，各检查项在同目录拆分：`doctor-host-runtime-section.tsx`、`doctor-network-section.tsx`、`doctor-agent-section.tsx`、`doctor-vault-catalog-sections.tsx`、`doctor-wikilink-section.tsx`、`doctor-alias-section.tsx`、`doctor-visual-marks-section.tsx`；共用展示件（小标题、问题行、git 风格 diff）在 `doctor-sections.tsx`，整行 diff 的文本测量与窗口化在 `doctor-line-fit.ts`（单测 `test/doctor-line-fit.test.ts`）。

## 应用更新

- 正式桌面构建的主窗口会在启动后异步检查一次稳定版更新，不阻塞首屏或 Vault 初始化；检查失败只记日志。
- 设置 → 关于可手动检查。发现新版后显示版本和 Release notes，用户点击「安装并重启」后才下载、验证、安装并重启；不会静默替换应用。
- 发现新版后标题栏右上角常驻「新版本」标签按钮（绿色胶囊 tag，`src/components/shell/update-indicator.tsx`），点击直接下载安装并重启；下载/安装中显示 spinner 与进度文案，安装完成前不消失。
- 安装前会重新拉取一次远端 manifest（`refreshStaleUpdate`）：应用长期驻留导致缓存的 Update 落后于最新 Release 时，直接改装最新版；re-check 失败（离线等）则回退安装缓存清单，不会因此中断（#481）。
- 更新包由 Tauri Updater 使用内置公钥验证签名，并根据当前系统/架构从 GitHub Release 的 `latest.json` 选择产物。
- 更新检查与下载复用通用页的「网络代理」设置（`src/lib/update/service.ts` 在每次检查时读取，下载沿用检查时的代理）：Updater 插件自带 HTTP 客户端，不走 Host `core::http::client_builder`，因此必须显式传入。该客户端只支持 HTTP(S) 代理，SOCKS 代理需另配 HTTP 端口。
- 浏览器预览、`pnpm tauri dev`、移动端不检查更新；设置页会说明该限制。
- 只有 GitHub **已发布**的稳定版 Release 可作为更新源；Draft 和 prerelease 不会推送给普通稳定版用户。

## 主题

- `uiTheme` 默认 `default`（内置外观）：Apple 系统灰材质——冷灰低饱和中性色（oklch hue ≈260），侧栏略重于画布、卡片抬起；`--brand` / `--highlight` 保留彩色强调。覆盖见 `src/index.css` `:root` / `.dark`。
- 外观设置中的配色主题以紧凑预览网格展示背景、卡片、主色和强调色；点击预览项即可应用主题。
- 36 个 tweakcn 预设：`src/themes/tweakcn.json`；`src/lib/ui/theme.ts` 注入 CSS 变量。
- 刷新主题数据：`node scripts/fetch-tweakcn-themes.mjs`。
- 可访问性：`prefers-reduced-transparency` 下标题栏 / Library 表头退回实色；`prefers-contrast: more` 加深边框。
- `uiScale`：80%–150% 五档，改 `html` font-size（基数仍为 **16×scale**，与编辑器字号/行距正交；不把根字号改成 13，以免 rem 间距在 Windows 125% 等缩放下整体被压扁）。
- 字号阶梯（Apple UI 光学字阶，见 `src/index.css` `@theme`；`body` 默认 `text-sm`，PaneHeader / 侧栏 / 底栏 / 顶栏 / Dock / 库表 / Agent chrome 共用）。每档是 **字号 + 行高 + 字距** 一组，不是只改 size：
  - `text-caption` → **11px**（Caption；行高 1.35，字距 +0.012em；chip / 密集元数据；禁止再写 9/10px）
  - `text-xs` → **12px**（Callout；行高 1.35，字距 +0.006em；次要控件、快捷键）
  - `text-sm` → **13px**（Body；行高 ≈1.385，字距 0；主 chrome）
  - `text-base` → **15px**（Title 3；行高 1.25，字距 −0.012em；设置/对话框标题）
  - `text-lg` → **17px**（Title 2；行高 1.2，字距 −0.018em；欢迎页等大标题）
- 字重：正文 `font-normal`（400）；强调用 `font-medium`（510）/ `font-semibold`（590）；chrome 少用 `font-bold`。可变字体（SF Pro / Geist）吃得到中间档，Segoe 等会落到最近可用字重。
- 圆角基值 `--radius`：**0.5rem（8px）**；PaneHeader / Dock 页签栏高度：**2.25rem（h-9）**。
- 字体（Appearance → Fonts，对齐 Obsidian 三分法）：
  - `interfaceFontFamily`：界面 chrome（`--font-sans` / `--font-heading`）。
  - `textFontFamily`：Markdown/笔记正文（仅编辑器根节点）。
  - `monoFontFamily`：代码块与 `font-mono`（`--font-mono`）。
  - 取值：空 = **系统 UI**（macOS SF Pro / Windows Segoe UI + 雅黑等 CJK 回退）；`system` 同义；`geist` = 打包 Geist Variable；`serif` / `mono` = 内置栈；其余 = 系统字体族名。
  - 等宽默认含 Cascadia Mono / Consolas，照顾 Windows。
  - 选择器：Popover + 搜索；Host `list_system_fonts`（fontdb）枚举本机字体。
- Markdown 编辑器（Appearance → Markdown editor）：
  - `editorFontSize`：12–20 px（默认 14，阅读区可略大于 chrome）。
  - `editorLineHeight`：1.4–2.0（步长 0.1，默认 1.6）。
- `batchImportConcurrency`：魔棒批量导入及后续资源下载的并发上限，范围 1–10，默认 5。
- `paperNoteMode`：新导入论文 NOTES.md 壳的初始化方式，四档：
  - `standard`（默认）：aliases + `# 标题` + 摘要引用块（zh-CN 机翻，失败省略）。
  - `title-only`：aliases + `# 标题`，不写摘要。
  - `blank`：仅 aliases frontmatter。
  - `custom`：渲染 vault 内 `.agentero/templates/NOTES.md`（变量 `{{title}} {{authors}} {{year}} {{date}} {{abstract}} {{arxiv_id}} {{doi}} {{url}} {{id}}`，`{{abstract}}` 为原文不翻译，未知变量原样保留；模板缺失回退 standard）。选中该项时显示模板路径与「生成起始模板」按钮（`notes_template_seed`，仅当模板不存在时写入）。
  - 所有模式产物都保证含 aliases frontmatter；只影响新导入，不改存量笔记。

## Embedding 批次大小

设置 → Agent → Embedding 模型提供「批次大小」数字输入框，默认 **64**，内置和自定义接口均可调整。填写正整数后失焦或按 Enter 保存；无效输入恢复为已保存的值。遇到 embedding 接口单批最多 8 条的错误时，改为 **8**，再刷新 arXiv Daily。

## i18n

- 用户文案一律 `t()` / `react-i18next`；en 源语言，同步 `zh-CN`。
- 词条：`src/i18n/locales/`。
- Appearance → Language：`applyLocale` 在设置窗本地立即切语种（设置 webview 不挂 `useAppBootstrap`）；`settings:changed` 广播时各窗口 `subscribeSettings` 也会再应用一次，主窗另经 bootstrap 同步原生菜单。

## 代码

- UI：`src/components/settings/`
- 状态：`src/lib/settings/`
- 更新服务：`src/lib/update/`
