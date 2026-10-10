# 新手引导（First-run Onboarding）

首次运行的设置向导，Raycast 风格的全窗口多步流程，主窗口渲染。

## 触发时机

- **自动**：主窗口（Tauri 桌面）首次启动，且 `settings.onboardingDone === false`、无已打开 Vault、无最近 Vault 记录时，覆盖层自动打开。老用户升级因已有 Vault/最近记录不会误弹。
- **手动**：设置侧栏 →「快速配置向导」。设置窗口通过 Tauri 事件 `onboarding:request`（`src/lib/onboarding/api.ts`）广播，主窗口 `OnboardingRoot` 监听后强制打开。打开操作不写设置，也不重置 `onboardingDone`；进入向导后，各步骤仍按用户操作保存配置。

完成任一收尾动作（创建 Vault / 从 Zotero 导入 / 完成 / 关闭）都会把 `onboardingDone` 置 `true`（随 XDG `settings.json` 持久化，Host `AppSettings` 必须保留该字段），此后不再自动弹出。

## 功能导引（Feature tour）

Onboarding 关闭、Vault 首次打开后，`useFeatureTour` 用 driver.js 高亮侧栏 / 论文库 / Cool Papers / 魔棒 / 阅读记笔记 / 工作区 / 全文翻译 / Cool Paper 笔记抓取 / Agent / 标题栏。`featureTourDone === false` 且引导向导已关闭时自动开始；完成或跳过写入 `featureTourDone: true`。设置侧栏可手动重放（`onboarding:tour`）。

`useFeatureTour` 订阅 `onboardingStore.open`，确保在 onboarding 覆盖层仍在显示时不提前启动，避免高亮层与向导覆盖层竞争。

## 步骤

每个步骤头部显示标题 + 一句人话说明（`<id>.title` / `<id>.desc`，welcome 除外）。

| 步骤 | id | 内容 | 复用 |
|---|---|---|---|
| 欢迎 | `welcome` | 品牌 + 价值主张 + 特性 | — |
| 外观 | `theme` | 明暗模式 + tweakcn 配色主题即时预览 | `patchSettings` + `applyUiTheme` / `next-themes` |
| 网络 | `proxy` | 配置应用级网络代理，并运行「问题诊断 → 网络连通性」同一组 probe | `saveSettingsAsync` / `doctorCheckNetwork` |
| Agent | `agent` | 扫描本机 ACP Agent、安装可托管 Agent、探测、设默认（可跳过）；安装期间卡片显示 `agent-lifecycle:progress` 进度与阶段，并提供取消（X）按钮静默中止安装。下方另列**本地桌面应用**（ChatGPT / 千问办公 / WorkBuddy）：不支持 ACP，已装高亮、未装灰度，均标注「暂不支持」，不可选 | `scanCatalog` / `probeCatalogAgent` / `ensureCatalogAgent` / `useAgentToolLifecycle` / `probeDesktopApps` |
| 翻译 | `translate` | 选择「用自己的翻译 API」或「内置免费翻译」，选前者则填 Key 并测试 | `probeCommercialMtProvider` |
| 图表公式 | `layout` | 选择「配置云端服务」或「本地免费模型」，选前者则填 Key 并测试 | `probeLayoutProvider` |
| 收尾 | `vault` | 创建 Vault / 从 Zotero 导入 / 稍后再说 | `createNewVault()` / `migrateZoteroFromWelcome()`（`src/lib/vault/actions.ts`） |

Agent 的可选性由当前依赖是否可用决定（`acpCommandAvailable`）；内置 ACP 适配器不能代替所需的 Agent CLI，保留历史注册、默认项或成功探测记录不代表当前可用。

流程状态机用 **@stepperize/react**（`defineStepper` + `useStepper`），定义见 `src/components/onboarding/flow.ts`；纯线性、无分支跳转。

> **与内置 provider 的未对齐**：`translate` 与 `layout` 两步早于内置 provider，只提供「填自己的 Key」与「用免费引擎 / 本地模型」的二选一，没有「Agentero 内置」这一档。`translate-step.tsx` 的「用系统默认」按内置可用性解析 provider（与 Host 的 `default_translate_provider()` 一致），所以一路点过引导不会丢掉内置默认；缺的只是把内置作为显式选项呈现。引导步的改造登记在 [`../backend/builtin-provider.md`](../backend/builtin-provider.md) §限制与后续。

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
