# 答辩总结页底栏按钮叠层

**状态**：已修复  
**日期**：2026-08-14  
**范围**：答辩间总结页 `EndedAct` 底栏

## 现象

保存转写后点击「生成评价」，底栏「打开转写」黑胶囊与「正在生成评价…」灰胶囊叠在一起：黑按钮右缘出现月牙形色块，评价二字重影。

## 根因

底栏是一行 `justify-center` 的 `rounded-full` Button。共享 Button 在按下时 `scale-[0.94]`，并过渡 `transform`。点击「生成评价」后按钮立刻 `disabled`（`pointer-events-none` 可能卡住 `:active`），文案从「生成评价」拉长为「正在生成评价…」，整行因 `justify-center` 左移。WKWebView 会把缩放后的圆角层重复画到相邻黑胶囊上。

## 修复

1. 底栏允许换行，加大间距，每个胶囊 `isolate` + `overflow-hidden`，并关掉按下缩放。
2. 评价进行中不再用 disabled 幽灵按钮，改为 `aria-live` 状态字，避免再出现一层灰胶囊去叠主操作。

## 验证

- `pnpm exec vitest run test/voice-defense-ended-act.test.ts`
- 总结页保存转写后点「生成评价」：黑胶囊与状态字并排，无月牙、无重影。
