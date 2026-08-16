# 答辩间「入场答辩」点击无反应

准备页已就绪、账号已连接，点击「入场答辩」没有进通话。

## 第一轮（openRef）

`beginVoiceStart` 用 `openRef.current` 判断答辩间是否打开。该 ref 一度只在 `openDialog` / `handleOpenChange` 里手写同步，lease 清理 effect 的 unmount 还会把它打成 `false`。HMR、StrictMode 重挂时 React 仍保留 `open === true`（提纲还在），ref 却是 `false`，门闩直接 `return null`。

**修法**：渲染时按 `phaseRef` 的方式把 `openRef.current = open`；lease 清理不再改 `openRef`。入场时写 `[viva] session_start_requested`，挡住时带上 `blocked=true`。

**结果**：日志证明点击已经进入处理函数（`session_start_requested ready=true connected=true`，且没有 `blocked=true`），但仍然没有 `session_connected`、也没有切到连接中。openRef 不是当晚的阻断点。

## 第二轮（确认路径静默失败）

入场实际顺序是：`startWithPreparedMaterial` → `confirmDefensePreparation` → `startVoice`（`setPhase("connecting")` 在若干门闩之后）。失败只走 Sonner Toast，答辩间原生窗口标题栏会把 Toast 顶偏/挡住，准备页按钮仍显示「入场答辩」。

确认阶段有两道比准备页更严的门：

1. **当场重算材料指纹**。`assertSnapshotFresh` 用当前 `title` / `metadata` / `selections` 再哈希。主窗口后到的选区交接或论文 metadata 刷新会改 hash，但选中的文件路径没变，准备页仍显示「入场答辩」而不是「更新」。失败文案是 `PreparationStaleError`（`paper metadata or selections`），catch 只 Toast「无法确认答辩材料」，不把 React 态标成 stale。
2. **残留 preparation runtime**。准备完成后若本地还挂着已结束的 child session id，或 `runtimeStates` 里留着空闲条目，`confirm` 会抛 `preparation ACP runtime is still active`，`startVoice` 还会被 `hasActiveDefensePreparations()`（map 非空即挡）拦住，即使 Host 上那些 ACP 会话早已 `finish`。

## 修法

- 入场确认只写编辑过的提纲，**不再当场重算快照**（路径级过期/改选已由准备页挡住）。`skipSnapshotFreshness`。
- 确认前丢掉 Host 已结束的残留 child；空闲 runtime 注销。Host 仍 active 的 child 继续拒绝。
- `startVoice` 只挡 **仍在跑的 child** 和评价任务，不挡「map 里还有一条已完成的准备记录」。
- 失败写 `[viva] session_start_failed reason=...`，并在底栏按钮上方显示错误，不再只依赖 Toast。

## 第三轮（独立窗口跑着过期 bundle）

答辩间是原生 `viva` Webview，`viva_window_open` 对已存在窗口只 focus、不 reload。Vite HMR 打不进这个第二窗口。23:46 的点击仍是 `session_start_requested` 且没有 `session_start_failed` / `path=immediate`，说明用户点的还是 23:19 加载的旧 JS：入场仍 `await confirm`（含重哈希），失败 Toast 被标题栏挡住。

## 修法（第三轮）

- 入场 **先连 Voice**，提纲确认改后台 `force`（跳过指纹和残留 ACP 门闩）。
- `windowMode` 下 Voice 门闩不再依赖 React `open`。
- 曾考虑开发模式 focus 时 `location.reload()`，后撤回（会误杀进行中的会话）。验证必须彻底关掉答辩间窗口再打开。
- `dialog_opened enter=immediate` / `session_start_requested path=immediate` 用来确认新代码已加载。

## 第四轮（入场仍被门闩在切页面前吞掉）

23:59 日志已有 `path=immediate`，但没有 `step=voice` / `session_start_failed` / `session_connected`。点击在 `startVoice` 里 `await isAgentWorkflowActive` 之后若 `isCurrent` 为假会**静默 return**，页面停在准备页。开发态 lease cleanup 若因 callback 身份变化重跑，也会 `invalidate` 掉正在启动的会话。

## 修法（第四轮）

- `startVoice` 第一件事就是 `setPhase("connecting")`，不再先等 Host workflow / 残留 child。
- 连接失败一律进错误页，不再因 `openRef` 静默吞掉。
- lease 清理只在卸载时运行。

## 第五轮（切页必须发生在 startVoice 之前）

00:13 日志已有 `path=immediate`，仍没有 `step=voice` / `session_start_failed` / `session_connected` / Host `voice_session_create`。连接中 UI 只在 `phase !== "prepare"` 时渲染，而 `setPhase("connecting")` 藏在 `startVoice` 里。`path=immediate` 之后、`startVoice` 之前任何 return，准备页都毫无变化。答辩间是第二个 Webview，Vite HMR 打不进去；第四轮改动很可能从未在用户点击的窗口里跑过。

**修法**

- 材料校验通过后，点击处理函数**同步** `setPhase("connecting")` 并打 `step=connecting`，再 `begin` / 后台 confirm / `startVoice`。`begin` 失败进错误页，禁止静默停在准备页。
- 抽出 `planPreparedDefenseEnter`：ready brief 的下一拍就是 `connecting`，可单测，不依赖 hook 里的 await 顺序。
- 准备页显式入场可接管「有 lease、无 Voice client」的卡死锁；真会话（有 client）不抢。
- `windowMode` 关窗失败时保持 `openRef === true`，成功后再打成 `false`。不要靠 focus 时 `location.reload()`。

验证：彻底关掉答辩间窗口再打开。同一秒日志应有 `path=immediate` → `step=connecting` → `step=voice` → `voice_session_create`（或错误页 + `session_start_failed`）。

## 第六轮（卡在「正在进入答辩间」）

第五轮之后点击会切到连接中（`step=connecting`），但 08:56 实机没有 `step=voice` / Host 建会话。`void confirmDefensePreparation(...)` 仍会先执行 confirm 到第一个 await；若这段同步工作卡住，`startVoice` 根本不会被调用，页面一直停在连接中。

**修法**

- `runPreparedDefenseEnter`：先调用 `startVoice`（同步前缀含 `step=voice`），再后台 confirm。
- 连接超过 45 秒仍停在 connecting 则进错误页（`startTimeout`），不再无限转圈。
- Voice 客户端补 `step=config` / `step=mic` / `step=session` 日志，区分卡在配置、麦克风还是建会话。

## 第七轮（`crypto.randomUUID` 非法调用）

09:06 日志已有 `path=immediate` → `step=connecting`，同一秒 `session_start_failed reason=start_threw`，没有 `step=lease` / `step=voice`。点击已切到连接中，但 `beginVoiceStart` 同步抛错，立刻进错误页。失败日志当时只写 `reason`，看不到 message。

`VoiceStartGate.begin` 默认 lease 写成了 `(input.nextLeaseId ?? crypto.randomUUID)()`。`??` 取出的是方法引用，再 `()` 等于把 `randomUUID` 当裸函数调用。WebKit / Tauri WKWebView 要求 `this` 必须是 `Crypto`，于是抛 `Illegal invocation`。现有单测都传入 `nextLeaseId`，默认路径从未跑过。

**修法**

- 改成 `input.nextLeaseId?.() ?? crypto.randomUUID()`，保持方法调用。
- 单测补一条不传 `nextLeaseId` 的路径。
- `session_start_failed` 带上 `message`。

验证：彻底关掉答辩间窗口再打开。同一秒日志应有 `step=connecting` → `step=lease` → `step=voice`，而不是 `start_threw`。

