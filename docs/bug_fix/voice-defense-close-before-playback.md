# 开场失败页关闭无响应

**状态**：已修复  
**日期**：2026-08-14  
**范围**：答辩间错误页与 Viva 原生窗口关闭处理

## 现象

委员会未按要求说出开场语句时，页面显示「委员未按要求开始答辩，请重试」。此时点击错误页的「关闭」或系统关闭按钮，窗口不会立即消失。

## 根因

存在两个独立问题：

1. 关闭逻辑用“是否已有字幕”判断是否进入总结页。开场门控期间的回执/非规范字幕虽然会被客户端拦截，不代表委员会已经开始播放，但仍触发了异步会话收尾。
2. Tauri 2 的 JavaScript `onCloseRequested` 在回调未阻止关闭时会内部调用 `window.destroy()`。项目 capability 只授权了 `core:window:allow-close`，遗漏 `core:window:allow-destroy`，所以一旦注册该监听，准备页、错误页和总结页的系统关闭都会在最终销毁阶段被权限拒绝。

## 修复

关闭判定统一使用 `startedAtRef`：只有委员会播放真正启用后，通话或错误才进入总结页；播放开始前的连接状态、字幕和开场错误直接关闭窗口并释放会话。中心按钮与系统关闭按钮共用同一判定函数。

同时为受限窗口集合补充 `core:window:allow-destroy`，并让用户已经明确点击的应用内关闭操作直接调用 `destroy()`，避免再次进入 `onCloseRequested`。系统红色关闭按钮仍通过监听器判断是否需要保留已开始的会话。

## 验证

- `pnpm exec vitest run test/voice-defense-close.test.ts test/voice-defense-timing.test.ts test/voice-defense-client.test.ts test/voice-defense-ended-act.test.ts test/voice-defense-protocol.test.ts`
- `pnpm exec biome check src/components/agent/use-voice-defense.ts src/lib/voice-defense/timing.ts test/voice-defense-close.test.ts`
- `pnpm exec tsc --noEmit`
- 准备页点击 macOS 系统红色关闭按钮：Viva 窗口立即销毁，主窗口保留
