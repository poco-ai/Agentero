# 侧栏收起时卸载分隔条，展开后无法再调整宽度（#1163）

## 范围与现象

拖动左栏（Vault 边栏）右缘的分隔条向左直到收起，或拖动右栏（笔记 / Agent 双列）左缘的分隔条直到收起；再点标题栏对应按钮展开后，分隔条拖不动，两栏宽度无法调整。重启、或改用按钮收起再展开后恢复。UI 其他交互正常，是布局状态失效。

## 原因

`src/App.tsx` 原来按收起状态条件渲染分隔条：

```tsx
{sidebarCollapsed ? null : <ResizableHandle … />}
{rightSidebarOpen ? <ResizableHandle … /> : null}
```

而「收起」恰好可以由拖动这条分隔条本身触发：两个 `ResizablePanel` 都是 `collapsible` + `collapsedSize={0}`，把栏拖到 minSize 以下会塌缩到 0，`onResize` 随即写入 `sidebarCollapsed` / `rightSidebarOpen`。等于在拖拽过程中把正在拖的 `Separator` DOM 节点删掉。

`react-resizable-panels@4.12.2` 在拖拽途中卸载 Separator 后会保留不同步的布局；之后再展开走的 imperative API（`hooks/use-shell-layout.ts` 里 `setLeftCollapsed` / `setRightCollapsed` 的 `panel.expand(); panel.resize(targetPx)`）在折叠面板上静默失败（上游 #774，4.15.0 修复）。展开逻辑里的 `try/catch` 也吞掉了错误，所以宽度停在 0、重新挂载的分隔条同样拖不动。

## 修复

两处分隔条都改为常驻渲染，收起时用布局无关的方式隐藏：

- `className={cn(collapsed && "pointer-events-none w-0 opacity-0")}`：`w-0` 不占宽度（经 `cn` 的 tailwind-merge 覆盖 `w-px`），`opacity-0` 隐藏 1px 线，`pointer-events-none` 让 `::after` 的 5px 命中区也不拦截点击；
- `disabled={collapsed}`：库跳过该 Separator 的命中检测与键盘调整，并从 tab 序列移除。

不升级 `react-resizable-panels`：本修复不依赖 4.15.0，避免锁文件与其它面板（写作分栏、Agent 输入区拖高、TexProjectView）一起回归；如需可另开改动单独升级。

## 回归验证

用同一套 `react-resizable-panels@4.12.2`，在 Chromium 里按 App 的相同结构（`collapsible` + `collapsedSize={0}` + `onResize` 把 ≤1px 记为收起）对两种写法做了「拖到收起 → 点展开 → 再拖」序列：

| 写法 | 收起后 | 点展开 | 再拖 80px |
|---|---|---|---|
| 收起时卸载 Separator | 宽度 0，Separator 已不在 DOM | 宽度仍为 0，Separator 不再挂载 | 无法拖拽 |
| 常驻 + 收起时隐藏/disabled | 宽度 0，Separator 仍在 DOM | 恢复 200px | 拖到 280px |

桌面端仍需按以下步骤复验（当前环境没有构建产物，未启动 `pnpm tauri dev`）：

1. 左栏：把分隔条拖到完全收起 → 点标题栏侧栏开关展开 → 再拖：宽度恢复且可调整；多次重复仍可用。
2. 右栏（笔记 / Agent 双列）：同样步骤；展开后双击分隔条仍能重置宽度。
3. 布局记忆：拖到收起不写入宽度（< 80px 不记录），展开恢复最后一次宽度；切预设、重启后仍正确。
4. 收起状态下点击栏边缘不误触、不与正文点击抢命中区。

静态检查：`pnpm typecheck`、`pnpm deps:check`、`pnpm lint:ts`，以及 `test/shell-layout-restore.test.ts`、`test/layout-persist.test.ts`。
