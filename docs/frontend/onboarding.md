# 新手引导（First-run Onboarding）

首次运行的设置向导，Raycast 风格的全窗口多步流程，主窗口渲染。

## 触发时机

- **自动**：主窗口（Tauri 桌面）首次启动，且 `settings.onboardingDone === false`、无已打开 Vault、无最近 Vault 记录时，覆盖层自动打开。老用户升级因已有 Vault/最近记录不会误弹。
- **手动**：设置侧栏 →「快速配置向导」。设置窗口通过 Tauri 事件 `onboarding:request`（`src/lib/onboarding/api.ts`）广播，主窗口 `OnboardingRoot` 监听后强制打开。打开操作不写设置，也不重置 `onboardingDone`；进入向导后，各步骤仍按用户操作保存配置。

完成任一收尾动作（创建 Vault / 从 Zotero 导入 / 完成 / 关闭）都会把 `onboardingDone` 置 `true`（随 XDG `settings.json` 持久化，Host `AppSettings` 必须保留该字段），此后不再自动弹出。

## 功能导引（Feature tour）

功能导览分两段：空库先认识侧栏、论文库、Cool Papers、导入、工作区、Agent 和标题栏；首次打开已入库的 PDF 后，再介绍 PDF、分屏 NOTES.md、全文翻译、Cool Paper 笔记、批注与划词翻译。每段最后给出可执行的下一步。阅读段会打开分屏笔记，但不会替用户执行翻译、抓取笔记或联网补全。

新建 Vault 后显示「知识库已准备好」，提供导入论文、从 Zotero 导入、先看看工作区三个选择。`vaultSetupPending` 覆盖创建与收尾选择；Dialog 关闭并释放焦点后才打开下一入口。导览同时等待 Zotero、命令面板、设置及其他可见模态关闭；运行中出现模态则先暂停，关闭后继续，不通过提高 z-index 争夺交互。

每段要求目标全部可见，缺少目标就等待后续挂载，不再静默删除步骤。阶段与步数保存在用户本地 `agentero-feature-tour-progress-v2`；仅明确点击最后一步的完成按钮才完成该段，两段都完成后才写入 Host 的 `featureTourDone: true`。关闭按钮或 Esc 暂停本次自动导览，下次启动续上；模态中断自动恢复。设置侧栏的重放操作重置两段进度（`onboarding:tour`）。

## 步骤

每个步骤头部显示标题 + 一句人话说明（`<id>.title` / `<id>.desc`，welcome 除外）。

| 步骤 | id | 内容 | 复用 |
|---|---|---|---|
| 欢迎 | `welcome` | 品牌 + 价值主张 + 特性 | — |
| 外观 | `theme` | 明暗模式 + tweakcn 配色主题即时预览 | `patchSettings` + `applyUiTheme` / `next-themes` |
| 网络 | `proxy` | 配置应用级网络代理，并运行「问题诊断 → 网络连通性」同一组 probe | `saveSettingsAsync` / `doctorCheckNetwork` |
| Agent | `agent` | 扫描本机 ACP Agent、安装可托管 Agent、探测、设默认（可跳过）；安装期间卡片显示 `agent-lifecycle:progress` 进度与阶段，并提供取消（X）按钮静默中止安装。CLI 目录**之后**另列**本地桌面应用**（ChatGPT / 千问办公 / WorkBuddy / Dsh 桌面版）：GUI 本身不支持 ACP，已装高亮、未装灰度，不可选；四项统一标注「自带 CLI，可接入」（Agentero 复用各自应用包里的 Codex / CodeBuddy / Qoder CN / Dsh）。卡片用 `auto-rows-fr` + `h-full` 保证已装/未装高度一致 | `scanCatalog` / `probeCatalogAgent` / `ensureCatalogAgent` / `useAgentToolLifecycle` / `probeDesktopApps` / `isDesktopBundledCliPath` |
| 翻译 | `translate` | 选择「用自己的翻译 API」或「内置免费翻译」，选前者则填 Key 并测试 | `probeCommercialMtProvider` |
| 图表公式 | `layout` | 选择「配置云端服务」或「本地免费模型」，选前者则填 Key 并测试 | `probeLayoutProvider` |
| 收尾 | `vault` | 创建 Vault → 选择导入论文 / 从 Zotero 导入 / 先看看工作区 | `createNewVault()` / `migrateZoteroFromWelcome()`（`src/lib/vault/actions.ts`） |

Agent 的可选性由当前依赖是否可用决定（`acpCommandAvailable`）；内置 ACP 适配器不能代替所需的 Agent CLI，保留历史注册、默认项或成功探测记录不代表当前可用。

流程状态机用 **@stepperize/react**（`defineStepper` + `useStepper`），定义见 `src/components/onboarding/flow.ts`；步骤顺序固定，向导从网络设置直接进入 Agent 扫描，不再单独要求安装系统 Node/npm；具体 Agent 的运行依赖由扫描与探测结果判断。

> **翻译默认值**：`translate-step.tsx` 的默认选项使用 `DEFAULT_TRANSLATE_SETTINGS.provider`（`tencenttransmart`），与 Host 新装默认值一致，不依赖内置 key（#857）。文案中的「内置免费翻译」指此免费引擎，不是 `agentero` provider；文案与步骤交互的后续调整由 #856 跟踪。

## 结构

- `src/components/onboarding/flow.ts` — `defineStepper` 步骤定义。
- `src/components/onboarding/onboarding-root.tsx` — 全屏覆盖层（`fixed z-40`，低于 Radix Dialog/Select 的 `z-50`，保证向导内的下拉可弹出）、头部品牌 + 步骤圆点、底部 上一步 / 下一步 / 完成，`motion` 步骤切换动画。
- `src/components/onboarding/steps/*` — 各步骤组件。
- `src/components/onboarding/onboarding-store.ts` — 手动重开的 `forceOpen` 标志（zustand vanilla）。
- `src/lib/onboarding/api.ts` — 跨窗口 `onboarding:request` 事件。
- `src/lib/settings/*` — `AppSettings.onboardingDone` / `featureTourDone`（默认 `false`）。Host `src-tauri/src/features/system/settings/mod.rs` 必须同步这两个 camelCase 字段，否则落盘后丢失。

## i18n

独立命名空间 `onboarding`：`src/i18n/locales/{en,zh-CN}/onboarding.json`。

相关代码：`src/components/onboarding/`、`src/lib/onboarding/api.ts`。
