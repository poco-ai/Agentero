# Agent 引用来源外部链接在应用内弹出空标签页

**状态**：已修复（外部链接不再渲染为 `<a target="_blank">`，改为按钮并通过 opener 插件打开系统浏览器）
**影响面**：Agent 面板 / 独立 Agent 窗口底部的“引用来源”列表中的外部 HTTP(S) 链接
**相关代码**（当前路径；复盘中的 `Source` 组件已随 shadcn AI 组件迁移移除）：

- `src/components/agent/context-source-links.tsx` — 来源列表：无 `href` 的 action-only 来源用 `Button` 渲染
- `src/components/agent/rendering/agent-citation-link.tsx` — 行内引用 pill；外部 URL 同样交给 opener 打开
- `src/components/agent/chat-transcript.tsx` — 外部 source 不再传 `href`，只保留 `onClick`
- `src/components/shell/right-sidebar.tsx` / `src/components/shell/feature-window-root.tsx` — `handleAgentOpenSource` 统一调用 `openCitation`
- `src/lib/workspace/viewer-actions.ts` / `src/lib/core/open-external.ts` — `openCitation` 对 HTTP(S) 链接调用 `@tauri-apps/plugin-opener` 的 `openUrl`

---

## 1. 问题现象

在 Agent 回复底部展开“引用来源”后：

1. 如果来源里包含外部网络链接（如 `https://arxiv.org/abs/...`）；
2. 点击该链接；
3. 外部浏览器没有打开，应用内部反而弹出一个空白标签页 / Webview 窗口。

GitHub Issue: [#358](https://github.com/poco-ai/Agentero/issues/358)

---

## 2. 根因

### 2.1 `Source` 把外部链接渲染成 `<a target="_blank">`

以下 `Source` 用法与路径属于当时的 AI Elements 实现（`src/components/ai-elements/sources.tsx`，已移除）。`src/components/agent/chat-transcript.tsx` 原来对外部 source 同时传了 `href` 和 `onClick`：

```tsx
<Source
  title={s}
  href={isHttp ? s : undefined}
  onClick={onOpenSource ? () => onOpenSource(s) : undefined}
/>
```

`Source` 组件检测到 `href` 是 `http(s)://` 时，会设置 `target="_blank"`：

```tsx
const isExternal = Boolean(href && /^https?:\/\//i.test(href));
<a
  href={href}
  target={isExternal ? "_blank" : undefined}
  onClick={(event) => {
    if (onClick) {
      event.preventDefault();
      onClick(event);
    }
  }}
>
```

### 2.2 Tauri WebView 对 `_blank` 的默认行为

Tauri 2 的 WebView 默认会把 `target="_blank"` 链接当成“新建 Webview 窗口”请求处理。虽然 JS 中调用了 `event.preventDefault()`，但在 Tauri 层面 `_blank` 的窗口创建行为并不能被前端稳定地完全阻止（参见 [Tauri 维护者说明](https://github.com/tauri-apps/tauri/discussions/11580)）。

### 2.3 `window.open` fallback 也在应用内打开

`handleAgentOpenSource` 对 HTTP(S) 链接调用 `@tauri-apps/plugin-opener` 的 `openUrl()`；一旦 `openUrl()` 失败，catch 分支里的 `window.open(url, "_blank")` 在 Tauri WebView 中同样会在应用内部打开窗口，而不是系统浏览器。

---

## 3. 解决方案

### 3.1 外部来源不再让 `<a>` 带 `href`

在 `chat-transcript.tsx` 中，外部 source 只保留 `onClick`，不传 `href`：

```tsx
<Source
  title={s}
  href={isHttp ? undefined : s}
  onClick={onOpenSource ? () => onOpenSource(s) : undefined}
/>
```

### 3.2 `Source` 组件对 action-only 来源渲染为 `<button>`

当时的修复是：当 `onClick` 存在但 `href` 不存在时，`Source` 渲染为 `<button type="button">`，彻底避免 Tauri 捕获到任何 `target="_blank"` 行为：

```tsx
if (onClick && !href) {
  return (
    <button type="button" onClick={onClick}>
      {content}
    </button>
  );
}
```

本地 Vault 路径仍保留 `<a href>` 语义（只是点击被劫持到 `onOpenSource`，用于在 workspace 中打开论文或文件）。

迁移到 shadcn AI 组件后，等价约束仍在：`context-source-links.tsx` 的来源只渲染 `Button`，点击走 `openCitation`；`agent-citation-link.tsx` 用 `<a>` 承载语义，但 `onClick` 先 `preventDefault()`，HTTP(S) 交给 `openUrl`，不设置 `target="_blank"`。迁移没有恢复该问题。

### 3.3 打开逻辑不变

点击后仍走 `handleAgentOpenSource` → `openCitation`；HTTP(S) 链接最终由 `openExternalUrl` 通过 `@tauri-apps/plugin-opener` 的 `openUrl()` 在系统浏览器中打开。

---

## 4. 验收建议

1. 让 Agent 做一个调研任务，使其回复底部的 Sources 出现外部 HTTP(S) 链接。
2. 点击该外部链接：应在系统默认浏览器中打开对应网页。
3. 应用内部不应再弹出空白标签页 / Webview 窗口。
4. 本地 Vault 路径来源（如 `papers/xxx/NOTES.md`）仍可正常在 workspace 中打开。
5. `pnpm run typecheck` 通过。

---

## 5. 边界

- 该修复只影响 Agent 回复底部的 `Sources` 列表；行内引用（`AgentCitationLink`）渲染为 pill，点击先 `preventDefault()` 再交给 opener，不存在 `_blank` 问题。
- 本地路径仍使用 `<a>` 标签，但不带 `target="_blank"`，因此不会触发 Tauri 新建内部窗口。
- 若未来需要恢复“右键复制外部链接地址”或“中键在新浏览器标签页打开”等原生链接行为，需要改为全局 Rust 层拦截 `_blank`（方案 B），而非在前端保留 `<a target="_blank">`。
