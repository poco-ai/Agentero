# 输入法组字时 Enter 误发送（IME composition race）

**状态**：已修复（`isComposing` + `keyCode 229` + compositionend 宽限）  
**影响面**：Agent Composer、消息编辑重发、PDF 批注内联编辑器、划词提问输入、魔棒入库输入框（#457）  
**相关代码**：

- `src/lib/core/ime.ts` — `isImeKeyboardEvent`、`IME_KEY_CODE`（229）、`IME_COMPOSITION_END_GRACE_MS`
- `src/hooks/use-ime-guard.ts` — composition 状态 + 确认键宽限
- `src/components/agent/composer/prompt-input.tsx` — `PromptInputTextarea` Enter 提交守卫
- `src/components/agent/use-agent-panel.ts` — `@`/`$` 菜单 Enter、消息编辑重发
- `src/components/viewer/pdf-ask/annotation-editor.tsx` — 批注 Enter 保存
- `src/components/sidebar/vault-sidebar-header.tsx` — 魔棒标题搜索 Enter 提交守卫
- `test/ime.test.ts` — 单元测试

---

## 1. 问题现象

在 Agent 输入框（或其它用 Enter 提交的文本框）里用**中文 / 日文 / 韩文等输入法**打字时：

1. 拼音或组字候选尚未确认上屏；
2. 用户按 **Enter** 本意是**确认候选**；
3. 应用却立刻把当前内容当作消息**发送**出去。

用户侧观感：输入法还没结束，消息已经发出去了。

常见英文叫法：**IME composition race** / **Enter during composition**。

---

## 2. 根因

### 2.1 Enter 在组字中的语义

IME 组字期间，`Enter` 的默认语义是**确认当前候选并上屏**，不是「提交表单 / 发送消息」。  
应用在 `keydown` 里无条件对 `Enter` 调用 `requestSubmit()` 或业务发送逻辑，就会抢在输入法之前（或与之竞态）触发提交。

### 2.2 仅检查 `isComposing` 不够

常见写法：

```ts
if (e.key === "Enter") {
  if (e.nativeEvent.isComposing) return;
  form.requestSubmit();
}
```

在多数浏览器上组字过程中 `isComposing === true` 可以挡住提交。但在 **macOS + 部分 IME / WebView（含 Tauri）** 上，确认候选时常出现：

```text
compositionend   →  isComposing 已变为 false
keydown Enter    →  处理器仍把这次 Enter 当成「发送」
```

即 **`compositionend` 先于确认键的 `keydown`**。此时 React 状态里的 `isComposing` 和 `event.nativeEvent.isComposing` 可能都已是 `false`，单靠该标志会漏判。

### 2.3 遗留信号 `keyCode === 229`

浏览器在 IME 处理按键时，历史上会把 `keyCode` / `which` 设为 **229**（`IME_KEY_CODE`）。  
确认键有时仍带 229，可作为补充信号；不能单独依赖，需与 composition 状态、宽限一起用。

### 2.4 外部 `onKeyDown` 顺序

`PromptInputTextarea` 原先先调用外部 `onKeyDown`（如 Agent `@` / `$` 菜单），再判断 IME。  
菜单若在组字确认时抢 `Enter` 做「选中提及」，同样会误操作。修复后：**先** IME 守卫，再交给外部 handler / 内部 submit。

---

## 3. 解决方案

### 3.1 共享检测与宽限

| API | 作用 |
|---|---|
| `isImeKeyboardEvent(event)` | `isComposing`（自身或 `nativeEvent`）或 `keyCode`/`which` === 229 |
| `IME_COMPOSITION_END_GRACE_MS`（约 100ms） | `compositionend` 后短窗口内仍视为「刚确认候选」，忽略 Enter 提交 |
| `useImeGuard()` | 维护 composition 状态 + 宽限时间戳；提供 `isBlockedByIme` 与 `compositionProps` |

### 3.2 接入点

| 位置 | 行为 |
|---|---|
| `PromptInputTextarea` | 组字 / 229 / 宽限内 **不** `requestSubmit`；Enter 在外部 handler **之前**拦截 |
| Agent `@` / `$` 菜单 | Enter 选择前 `isImeKeyboardEvent` |
| 用户消息编辑重发 | `useImeGuard`；组字中 Enter 不重发 |
| PDF 批注编辑器 | 同上；组字中 Enter 不保存 |
| 魔棒入库输入框（#457） | `useImeGuard`；组字中 Enter 不触发标题搜索/导入 |

### 3.3 预期交互

1. 组字中按 Enter → 仅确认输入法候选，**不发送**。  
2. 候选已上屏、未在组字 → Enter 照常发送（`Shift+Enter` 仍换行）。  
3. 宽限极短，正常连按两次 Enter（确认后再发）仍可用。

---

## 4. 验收建议

1. Agent Composer：中文输入法组字中按 Enter，只上屏、不发送；再按一次 Enter 才发送。  
2. 打开 `@` 菜单时组字确认，不误选路径；`$` 技能菜单同理。  
3. 编辑已发送用户消息：组字中 Enter 不触发重发。  
4. PDF 批注内联编辑器：组字中 Enter 不保存。  
5. 魔棒入库：中文输入法组字中按 Enter，只上屏、不触发标题搜索；再按一次 Enter 才提交。  
6. 英文 / 无 IME 场景：Enter 发送、`Shift+Enter` 换行不变。  
7. `pnpm exec vitest run test/ime.test.ts` 通过。

---

## 5. 边界

- 宽限约 100ms：过短可能在极慢机器上仍误发；过长会拖慢「确认后立刻再按 Enter 发送」。当前值覆盖常见 macOS IME。  
- 菜单 handler 不挂 composition 事件时，主要依赖 `isComposing` / 229；完整宽限由持有 `compositionProps` 的 textarea（如 PromptInput）负责。  
- 其它自定义 `onKeyDown` 若自行处理 Enter，也应调用 `isImeKeyboardEvent` 或 `useImeGuard`，勿只抄 `!e.nativeEvent.isComposing`。  
- 本修复不改变 ACP 发送协议，只约束前端快捷键语义。

---

## 6. 参考

- UI 约定（Composer Enter / 换行）：[`../frontend/shell.md`](../frontend/shell.md) §3.2  
- AI Elements Prompt Input：[`../frontend/components.md`](../frontend/components.md)  
- MDN：[`KeyboardEvent.isComposing`](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing)、[`compositionend`](https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionend_event)  
