# 生命周期事件系统（Lifecycle Events）

> 状态：已落地（批次 1–4 + 生命期作用域）。目标：把散落在启动链、导入链、打开链里的硬编码副作用，统一为"语义事件 + 注册式 handler"，并统一全项目事件命名规范。

## 背景（改造前的状态）

生命周期点在代码里已经存在，但全是硬编码顺序调用：

| 生命周期点 | 现状位置 | 问题 |
|---|---|---|
| 应用启动 | `src/main.tsx` `boot()` + `src/hooks/use-app-bootstrap.ts` | 串行硬编码，加新任务需改源头 |
| 导入论文后处理 | `src/lib/paper/import-actions.ts`（refreshTree → rebuildWiki → refreshLibrary → track → openPaper → enqueue jobs） | 最长的隐式生命周期链 |
| 打开论文 | `src/lib/workspace/actions.ts` `openPaper`/`openTab` | 无挂载点 |
| 事件机制 | 60+ 处 Tauri emit，前端 listen 分散在各 hooks | 只有单向"技术事件"，缺语义完成事件（如 paper:imported） |

## 命名规范

1. **格式**：`domain:event-name`，全 kebab-case，单冒号分隔；域名用单个单词（`job:`，不用 `job-center:`）。
2. **按语义分三类**：
   - **事实事件**（生命周期核心，动词过去式）：`paper:imported`、`vault:opened` —— "某事已发生"，唯一的 hook 挂载点
   - **进度流**：`xxx:progress` —— 仅 UI 反馈，不是 hook 点
   - **请求/指令**：`xxx:request` —— 需要响应方，不属于生命周期
3. **payload**：统一 envelope `{ vaultId, timestamp, ...data }`；paper 相关必带 `paperId`。
4. **Tauri wire 事件名 = lifecycle 事件名**，不做两套映射。
5. **前端 API**：`lifecycle.on('paper:imported', handler)`；事件类型集中定义于 `LifecycleEventMap`（单一事实来源）。
6. **事件分两类**（`events.ts` 在类型层面区分）：
   - **Scoped（有生命期）**：目前只有 `vault:opened`。handler 可返回 teardown；用 `lifecycle.emitScoped()` 开启作用域，它**同步**返回 release 函数，直接交给 React effect 的 cleanup。
   - **Fact（一次性事实）**：其余全部。用 `lifecycle.emit()`；返回值被忽略（TS 对 `void` 返回类型的赋值规则宽松，编译器拦不住，靠约定与 bus 行为保证）。

### 历史违规与清理

- ✅ `settings_window_closed` / `feature_window_closed`（snake_case 无前缀）→ `window:closed`，payload `{ kind: "settings" | "feature", view? }`
- ✅ 菜单裸 id 事件（`open_vault`、`toggle_sidebar` 等）→ `menu:invoked`，payload `{ action }`
- `job:changed` 保留为内部状态机事件，对外暴露派生的 `job:completed` / `job:failed`

## 事件清单

⭐ = 第一批（有明确消费者，现有硬编码链可迁移）；○ = 预留，有需求再加。

### app / window

| 事件 | 时机 |
|---|---|
| ⭐ `app:ready` | 前端 bootstrap 完成（store 已在 `boot()` 种子化、restored vault 校验 settle 后）。已预埋 emit、暂无消费者 |
| ⏸ `app:will-quit` | **延后**。从 `RunEvent::Exit` 发前端事件修不了真实需求（退出前 flush debounce 写盘）：那时 webview 已销毁，写盘是异步 invoke。正确做法是 `WindowEvent::CloseRequested` → `api.prevent_close()` → emit → 等前端 ack → `window.destroy()`，属独立特性。Rust 侧 teardown 已直接放在 run closure 里 |
| ⭐ `window:closed` | 子窗口销毁（Host `on_window_event(Destroyed)`）。payload `{ kind: "settings" \| "feature", view? }`。消费者：settings 回写 ui store、feature popout 清 `featurePoppedOut` |

### vault

| 事件 | 时机 |
|---|---|
| ⭐ `vault:opened` | **scoped**。打开/切换 vault（refreshTree、refreshLibrary、seedVaultSkills、job reconcile 挂载点）；其 teardown 负责各 store 的 vault 级清理与 `vault_release` |
| ○ `vault:created` | 新建 vault |
| ✅ ~~`vault:closed`~~ | **不再需要**，由 `vault:opened` 的作用域 teardown 承担 |
| 保留 `vault:file-changed` | watcher 文件变更（已符合规范） |

### paper（论文对象）

| 事件 | 时机 |
|---|---|
| ⭐ `paper:imported` | `paper_commit` 成功（catalog 已写入、NOTES 已建）。四条导入路径（魔棒 / 本地 PDF / Zotero / Connector）统一发；`paper_download_assets` 为孤儿文件夹补建 catalog 行时也发 |
| ⭐ `paper:assets-ready` | PDF 下载 / LaTeX 解压 / PAPER.md 生成完成（异步，与 imported 分离） |
| ⭐ `paper:renamed` | 后台元数据识别落地：占位目录改名为规范 id（`outcome=renamed`，含 wiki 链接重写清单）或并入已有条目（`outcome=merged`）。前端 handler 抑制 watcher 外部 rename 修复、remap 打开 tab、定向刷新树/库 |
| ○ `paper:deleted` / `paper:moved` / `paper:tags-changed` / `paper:metadata-updated` | 对象变更 |

### reader（阅读会话，前端本地事件）

| 事件 | 时机 |
|---|---|
| ⭐ `paper:opened` | openPaper/openTab 完成（layout enqueue、activity 打点挂载点）。已预埋 emit、暂无消费者 |
| ○ `paper:closed` | 关 tab |
| ○ `mark:created` / `mark:deleted` | 标注增删 |
| ○ `translation:completed` | 翻译完成 |

### note / wiki

| 事件 | 时机 |
|---|---|
| ○ `note:saved` | NOTES.md 持久化 |
| ○ `wiki:rebuilt` | 双链索引重建完成 |

### job（横切汇聚点）

| 事件 | 时机 |
|---|---|
| ⭐ `job:completed` / `job:failed` | 由 `job:changed` 状态机单点派生，payload 带 `JobKind`（ParseRefs / ParseBody / LayoutAnalyze / LayoutTranslate / DownloadAssets / PageCount / WikiReindex）。已预埋 emit、暂无消费者 |

### 已符合规范、直接纳入

`settings:changed`、`connector:item-saved`、`agent:completed`、`agent:failed`、`agent:registry-changed`（Host 在 probe / 安装 / 增删 / 改默认后广播，Agent 面板防抖刷新切换器）、`sync:state`（后续可补 `sync:completed`）、`mcp:status` / `mcp:tunnel-status`。

## 架构设计

```text
Rust 关键节点 ──emit──▶ Tauri wire 事件 ──┐
                                          ├──▶ src/lib/lifecycle/（typed bus）──▶ 注册 handler
前端本地动作（openTab 等）──emit──────────┘
```

- **`src/lib/lifecycle/`**：
  - `events.ts`：`LifecycleEventMap` 类型定义（事件名 → payload 类型），以及 `ScopedLifecycleEvent` / `FactLifecycleEvent` 的划分
  - `bus.ts`：极简 typed emitter（`on` / `emit` / `emitScoped`，无第三方依赖）
  - `tauri-bridge.ts`：集中 `listen()` wire 事件并转发进 bus；在 bootstrap 初始化一次
  - `register.ts`：**唯一**的 handler 注册处
- **Rust 端不做 observer 抽象**：仅在关键节点（`paper_commit` 后、jobs 状态机单点、assets 完成后）直接 emit 语义事件；当前只有前端一个消费者，不过度设计。
- **顺序约束显式化**：handler 按注册顺序串行 await，不引入优先级系统，靠注册文件内的显式顺序表达。（注：openPaper 直接用导入结果里的绝对路径打开，不依赖 refreshLibrary 完成。）

### 生命期作用域（scoped events）

`vault:opened` 的 handler 可以返回 teardown，"打开时做什么"和"关闭时撤销什么"因此写在同一个闭包里 —— 这正是 `useEffect` 的形状，也是此前 `vault:closed` 长期停在"预留"的根因：接口里没有地方写它。

关键决策：**作用域由 emitter 持有，不由 bus 从"重复 emit"推断**。

`emitScoped()` 同步返回 release 函数，`use-app-bootstrap.ts` 把它直接当作 effect cleanup 返回。于是 vault→vault 切换、vault→null 关闭、组件卸载三种情况都由 React 自身的语义免费覆盖。若改成"再次 emit 即销毁上一次"，有三个必然缺口：

1. `vaultPath` 为 null 的分支不 emit，切到"无 vault"时 teardown 永不执行
2. `validateRestoredVault` 校验失败时直接 `setVaultPath(null)`，同上
3. **StrictMode 会用相同 payload 触发两次 effect**，变成 setup→teardown→setup，而那次 teardown 打在**当前活跃**的 vault 上（会掐断正在用的 remote 会话）

其余语义：

- teardown 按**注册逆序**执行（栈式，与 React 一致）
- scoped 事件的 setup/teardown **按事件串行化**：setup 是异步的，快速连切两次 vault 否则会让旧作用域的 teardown 与新作用域的 setup 交错
- 作用域在 setup 排到队之前就被 release（StrictMode 挂载即卸载）时**直接跳过 setup**，而不是做完再撤销
- 注册项以记录对象为身份，同一个 handler 注册两次可独立注销
- handler 与 teardown 抛错只记日志，不中断其余项

### 订阅 Tauri 事件的约定

一律用 `listenSafe()`（`src/lib/core/tauri-events.ts`）或组件内的 `useTauriEvent()`，**不要**手写 `let off; void (async () => { off = await listen(...) })(); return () => off?.()`：`listen()` 需要一次 Host 往返，在它 resolve 前 dispose 会让 `off` 仍是 undefined，清理成为空操作、监听器永久泄漏 —— StrictMode 每次开发挂载都会命中。非 Tauri wire 的 promise 式订阅（bridge、workspace-broadcast）用 `toSafeDisposer()`。

## 落地批次

1. ✅ **前端 lifecycle 模块**：types + bus + bridge，bootstrap 接入
2. ✅ **Rust 语义事件**：`paper:imported`、`paper:assets-ready`、`job:completed/failed` 派生
3. ✅ **迁移硬编码链**：`vault:opened`（bootstrap）、`paper:imported` 后处理（import-actions）、`paper:opened`（openTab）
4. ✅ **命名清理**：`window:closed`、`menu:invoked`
5. ✅ **生命期作用域与 teardown**：
   - bus 支持返回 cleanup 的 scoped handler + `emitScoped`
   - `listenSafe` / `useTauriEvent`，替掉全部 20 处 leaky 订阅
   - bootstrap：store 种子移入 `boot()`（不再在 render 期做副作用）、JobCenter 订阅补 disposer、`app:ready` 等校验 settle、`window:closed` 收进 bus
   - 各 store 的 vault 级 clear + `vault_release`（驱逐 Host catalog 连接）
   - 退出时 `BridgeController::stop()`
6. 后续（本稿不含）：hook 表用户可配置（settings / `.agentero/`），动作接 JobCenter 执行

## 非目标

- 不做 Rust 内部 plugin/observer trait
- 不做用户可配置 hook（等事件层稳定后另立设计）
- 不改 `xxx:progress` / `xxx:request` 类事件的既有语义
- 不为"零消费者"而新增事件。`paper:moved` / `paper:deleted` 曾被考虑用来归一各处 `refreshTree → refreshLibrary → rebuildWiki` 尾巴，实测那些差异是**有意的**：调过 `syncMovedPaths` 的路径（move / rename / 外部重命名修复）已增量更新链接并 bump 了 revision，不需要全量重建；未调的路径（trash / restore / paste / drop）才需要。归一反而会加上多余的重建。
- 退出前 flush debounce 写盘不走事件层，见上文 `app:will-quit`
