# 新手引导（First-run Onboarding）

首次运行的设置向导，Raycast 风格的全窗口多步流程，主窗口渲染。

## 触发时机

- **自动**：主窗口（Tauri 桌面）首次启动，且 `settings.onboardingDone === false`、无已打开 Vault、无最近 Vault 记录时，覆盖层自动打开。老用户升级因已有 Vault/最近记录不会误弹。
- **手动**：设置 → 关于 → 首次运行引导 →「重新打开引导向导」。设置窗口通过 Tauri 事件 `onboarding:request`（`src/lib/onboarding/api.ts`）广播，主窗口 `OnboardingRoot` 监听后强制打开。

完成任一收尾动作（创建 Vault / 从 Zotero 导入 / 完成 / 关闭）都会把 `onboardingDone` 置 `true`（随 XDG `settings.json` 持久化，Host `AppSettings` 必须保留该字段），此后不再自动弹出。

## 功能导引（Feature tour）

Vault 首次打开后，`useFeatureTour` 用 driver.js 高亮侧栏 / 魔棒 / 工作区 / Agent / 标题栏。`featureTourDone === false` 时自动开始；完成或跳过写入 `featureTourDone: true`。设置侧栏可手动重放（`onboarding:tour`）。

## 步骤

每个步骤头部显示标题 + 一句人话说明（`<id>.title` / `<id>.desc`，welcome 除外）。

| 步骤 | id | 内容 | 复用 |
|---|---|---|---|
| 欢迎 | `welcome` | 品牌 + 价值主张 + 特性 | — |
| 外观 | `theme` | 明暗模式 + tweakcn 配色主题即时预览 | `patchSettings` + `applyUiTheme` / `next-themes` |
| Agent | `agent` | 扫描本机 ACP Agent、安装可托管 Agent、探测、设默认（可跳过）；安装期间卡片显示 `agent-lifecycle:progress` 进度与阶段，并提供取消（X）按钮静默中止安装 | `scanCatalog` / `probeCatalogAgent` / `ensureCatalogAgent` / `useAgentToolLifecycle` |
| 翻译 | `translate` | 选择「用自己的翻译 API」或「内置免费翻译」，选前者则填 Key 并测试 | `probeCommercialMtProvider` |
| 图表公式 | `layout` | 选择「配置云端服务」或「本地免费模型」，选前者则填 Key 并测试 | `probeLayoutProvider` |
| 收尾 | `vault` | 创建 Vault / 从 Zotero 导入 / 稍后再说 | `createNewVault()` / `migrateZoteroFromWelcome()`（`src/lib/vault/actions.ts`） |

流程状态机用 **@stepperize/react**（`defineStepper` + `useStepper`），定义见 `src/components/onboarding/flow.ts`；纯线性、无分支跳转。

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
