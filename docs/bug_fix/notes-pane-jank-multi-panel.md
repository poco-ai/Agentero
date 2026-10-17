# 三面板同开时笔记面板卡顿（滚动 / 输入 / 跳转）

**状态**：P0 已修复（7 项，见 §3）；P1 中的 `@platejs/toc` 每 scroll 重建已在后续单独修复（见 [toc-scroll-observer-rebuild.md](toc-scroll-observer-rebuild.md)），其余遗留登记在 `docs/frontend/markdown.md` §限制与后续
**影响面**：同时打开「论文 PDF + 笔记 + 对话」时，笔记面板的滚动条拖动、输入与站内跳转
**相关代码**：

- `src/components/editor/markdown-editor.tsx` — 滚动探针门控、跳转优先于滚动记忆、编辑器 memo 边界
- `src/components/editor/hooks/use-markdown-persistence.ts` — 自动保存单次序列化
- `src/components/selection/selection-annotation-badges.tsx` — 无选区不挂观察器、去掉逐字符 mutation
- `src/components/agent/hooks/use-agent-session-runtime.ts` — 流式 chunk 按帧合并
- `src/components/agent/use-agent-panel.ts` / `agent-panel.tsx` / `agent-history.tsx` — 面板窄订阅
- `src/lib/workspace/tabs/model.ts` / `src/components/workspace/doc-view.tsx` — tab 身份保持 + 稳定 `onDirtyChange`
- 文档：`docs/frontend/markdown.md`、`docs/frontend/agent.md`

---

## 1. 问题现象

1. 同时挂着论文（PDF）、笔记（Markdown）和对话三个面板时，笔记的竖直滚动条「一拖就卡、拖不动」；改用鼠标滚轮反而好一些；
2. 笔记的编写（打字）有顿挫；
3. 笔记内 / 跨面板跳转不顺，整体不如 Obsidian 跟手；
4. 只开笔记面板时基本无感。

## 2. 根因（按贡献排序）

主线程饱和 + 每条交互路径上的固定开销，与机器无关：

| # | 根因 | 代价 |
|---|---|---|
| 1 | `@platejs/toc` 在每个 scroll 事件 `setStatus(Date.now())`，导致 IntersectionObserver 全量重建（每个标题一次 `NodeApi.get` + `toDOMNode` + `observe`）与 TOC 全量重渲染 | 约 2–5ms/scroll 事件，与滚动距离无关（已单独修复，见 [toc-scroll-observer-rebuild.md](toc-scroll-observer-rebuild.md)） |
| 2 | 对话流式 chunk（~25/s）各自触发一次 store 更新 → 整个 AgentPanel 子树（含 composer）重渲染 | 25 次/s 全面板 reconcile |
| 3 | `AnnotationBadges` 常驻挂 `document.body` 的 `characterData+subtree` MutationObserver，每次按键触发 rAF → `measure()` 沿祖先链 `getComputedStyle` 强制回流 | 每按键一次强制回流（无选区时也在跑） |
| 4 | macOS/WebKit 未启用块级 `content-visibility`（#702），长笔记每次按键整篇重排 | ≈16.5ms/次（4000 块实测） |
| 5 | 自动保存每次做 2 次全文档序列化 + 3 次整文件 IPC，且保存引起的 tab patch 让 `DocView` 的 memo 失效 → Plate 全量协调 | 每次保存 3 次全量 reconcile |
| 6 | `useAgentPanel` 订阅整个 `sessions` 数组（identity 随每个 chunk 变化），memo 形同虚设 | 放大器 |

**为什么「拖动滚动条卡、滚轮不卡」**：macOS WebKit 把滚轮滚动交给合成线程推进，主线程再忙画面照走；而 `::-webkit-scrollbar` 样式让 overlay 滚动条退化成 classic 可拖 thumb，拖拽在主线程逐 pointer 事件同步推进，每个 scroll 事件的 JS 成本（根因 1/3）直接体现在 thumb 跟随上。

## 3. 已落地修复（P0）

1. **滚动探针门控**：`onScrollCapture` 仅在存在 `[[` / slash 候选菜单草稿时才跑补全探针（DOM 读取 + 编辑器树遍历），滚动本身零探针。
2. **AnnotationBadges 门控**：无绑定选区时完全不挂 observer；其余情况去掉 `characterData`（逐字符触发源），scroll 监听改 passive，结构变化 / resize / 滚动仍会重测。
3. **跳转优先于滚动记忆**：`navigationIntent`（`[[note#标题]]` / 块锚 / 划词来源）生效期间，scroll-memory 的挂载恢复让位——此前它的同步 `scrollTop` 写入会取消 smooth 滚动，表现为「跳了又被拉回旧位置」。
4. **流式合帧**：stream chunk 按 session 入缓冲，每动画帧合并为一次 store 更新；tool / plan / complete / fail 前强制 flush 保序；监听器卸载时 flush 残留。
5. **面板窄订阅**：`useAgentPanel` 不再订阅整个 `sessions` 数组（改布尔 selector + `store.subscribe` 镜像 ref），历史弹层自行订阅——流式时只有消息行重渲染。
6. **tab 身份保持 + memo 边界**：`patchTab` 对无变化 patch 返回原数组 / 原 tab（`notesDirty: true → true` 等）；`MarkdownEditor` 按 props memo，`onDirtyChange` 在 `DocView` 内 `useCallback` 固定。
7. **自动保存单次序列化**：写盘前快照 `editor.children` 与 frontmatter 引用，写后按引用相等判断文档是否在写盘期间变动，只有真变了才二次序列化。

## 4. 验证

- `pnpm typecheck`、`pnpm lint:ts`（仅存量 warning）、`pnpm test`（1942 passed）、`pnpm build` 通过；
- `test/tabs.test.ts` 新增 no-op patch 身份保持用例；
- 建议按「release 包 vs dev、单面板 vs 三面板、关 PDF」做主观对比验收（dev 模式另有 StrictMode 双渲染、未压缩模块与 agent Trace 日志放大）。

## 5. 边界与未做

- ~~`@platejs/toc` 的每 scroll 事件 IO 重建~~：已在后续单独修复（`@platejs/toc` 仓库内 patch，见 [toc-scroll-observer-rebuild.md](toc-scroll-observer-rebuild.md)）。本次只通过消除同帧其它开销降低其占比。
- 流式期间窗口不可见时 rAF 暂停，chunk 在缓冲内累积，终局事件（complete/fail）前强制 flush，不丢内容。
- AnnotationBadges 去掉 `characterData` 后，源文本逐字编辑期间徽标位置可能慢一帧校正，由后续 scroll / resize / 结构变化重测兜底。
