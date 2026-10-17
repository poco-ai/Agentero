# 笔记滚动条拖动卡顿（TOC observer 每个 scroll 事件重建）

**状态**：已修复（`@platejs/toc@53.0.0` 仓库内 patch，observer 长生命周期 + rAF 合并的 diff 重挂）  
**影响面**：长笔记（NOTES）面板的滚动条拖动、TOC 平滑滚动；三面板（PDF + 笔记 + 对话）同开时最明显  
**相关代码**：

- `patches/@platejs__toc@53.0.0.patch` — 改动 `@platejs/toc` 的 `useContentObserver` / `useContentController`
- `pnpm-workspace.yaml` — `patchedDependencies` 登记
- `vite.config.ts` — 显式**不把** `@platejs/toc` 加进 `optimizeDeps.exclude`（原因见 §4.3）
- `src/components/editor/overlays/toc-sidebar.tsx` — `queryTocHeadings` 三层缓存（本次未改）
- `test/editor-toc-observer.test.ts` — observer 复用 / diff 重挂 / activeId 回归测试
- 文档：`docs/frontend/markdown.md` §限制与后续、本文件

---

## 1. 问题现象

长笔记里拖动**竖直滚动条 thumb** 时「一拖就卡、拖不动」，改用滚轮反而顺一些；TOC 平滑滚动同样掉帧。只开笔记面板时基本无感，三面板同开时最重。

「拖动卡、滚轮不卡」是 macOS WebKit 的固有差异：滚轮滚动交给合成线程推进，主线程再忙画面照走；而 `::-webkit-scrollbar` 样式让 overlay 滚动条退化成 classic 可拖 thumb，**拖拽在主线程逐 pointer 事件同步推进**。因此 scroll 事件上的任何主线程成本都会直接体现在 thumb 跟手上。

---

## 2. 根因

`@platejs/toc@53.0.0` 把 scroll 事件接成了「整表重建」的信号，两个 hook 合起来构成回环：

```text
scroll 事件（拖动 thumb 时逐 pointer 事件到达）
 └─ useContentController 的 scroll 监听
      └─ setStatus(Date.now())          ← React state 更新
           ├─ useContentController 消费者重渲染
           │    └─ TocSidebar 整个按钮列表 reconcile
           └─ useContentObserver 的 effect deps 含 status
                └─ disconnect() + new IntersectionObserver(...)
                     └─ headingList.forEach:
                          NodeApi.get(editor, path)
                          editor.api.toDOMNode(node)
                          observer.observe(element)   ← 每个标题各一次
```

即**每个 scroll 事件**：一次 React 状态更新 + 整棵 TOC 重渲染 + 一次 IO 构造与销毁 + 每个标题一次 `NodeApi.get` + `toDOMNode` + `observe`。长笔记下约 2–5ms/事件，且与滚动距离无关——所以滚动条拖得越慢，掉帧的单次成本一分不少。

需要 `status` 这个「踢一脚」的原因本身是合理的：Slate 在结构编辑后可能重挂块的 DOM 节点，observer 需要重新挂到新节点上。问题在于它用的是**整表重建**，而不是**按需重挂**。

---

## 3. 修复方案

改 `@platejs/toc` 的两处，语义不变、成本结构改变：

### 3.1 observer 改为长生命周期

`useContentObserver` 里 observer 只在 `isObserve` / `isScroll` / `rootMargin` / `editor` / ref 变化时重建（`status` 不再参与），并把已挂载目标记在 `targetsRef`（`Map<headingId, Element>`）里。

### 3.2 滚动只做 diff 重挂，且按 rAF 合并

新增一次「同步目标」：对每个标题解析 `NodeApi.get` + `toDOMNode`，与 `targetsRef` 逐 id 比较——**只有 DOM 节点真的换了**才 `unobserve` 旧节点 + `observe` 新节点。这一步由 hook 自己持有的 scroll 监听触发，并合并到一个 rAF 里，因此：

- scroll 事件不再触发任何 React 状态更新（TOC 不重渲染）；
- 不再构造 / 销毁 IntersectionObserver；
- DOM 节点未变的标题不再被重复 `observe`。

`useContentController` 里 `setStatus(Date.now())` 的 scroll 监听随之删除；`status` 参数保留为可选（`index.d.ts` 标 `status?: number`），外部调用者传了也不报错。

### 3.3 前后对比

| 维度 | 修改前 | 修改后 |
|---|---|---|
| 每 scroll 事件 React 状态更新 | 1 次 | 0 次 |
| 每 scroll 事件 IO 构造 / 销毁 | 1 次 | 0 次 |
| 每 scroll 事件 `observe` 调用 | 每个标题 1 次 | 仅 DOM 节点换过的标题 |
| `NodeApi.get` + `toDOMNode` | 每事件 × 每个标题 | 每帧 1 次 × 每个标题（rAF 合并） |
| DOM 重挂后的重新挂载 | 整表重建 | 按 id diff 精确重挂 |
| `activeId` 追踪 / TOC 自动滚动 | 不变 | 不变 |

---

## 4. 验收

### 4.1 自动化证据

```bash
pnpm exec vitest run test/editor-toc-observer.test.ts
pnpm test
pnpm typecheck
pnpm run lint:ts
pnpm build
git diff --check
```

`test/editor-toc-observer.test.ts` 用 `happy-dom` 挂一棵真的 Plate 编辑器（4 个标题）+ `TocSidebar`，mock `IntersectionObserver` 记录每次构造与 `observe`：

| 用例 | 断言 |
|---|---|
| 挂载 | 每个标题恰好被 `observe` 一次 |
| 20 次 scroll + rAF | observer 数量不变、`observe` 总次数不变、未 `disconnect` |
| DOM 重挂 | 旧节点被 `unobserve`、新节点被 `observe` |
| observer 回调 | `activeId` 仍正确驱动 `#toc_item_active` |
| scroll 后 | `#toc_wrap` 的 HTML 不变（未触发 React 状态更新） |

关键：这几个断言在**未打补丁的 53.0.0 上会失败**（滚动会逐个事件新增 observer 并重复 observe 全部标题），打补丁后通过——即该测试是有效回归护栏，而非同义反复。

### 4.2 手动验收

1. 打开一篇有较多标题的长笔记（或三面板：PDF + 笔记 + 对话同开）。
2. 拖动笔记的竖直滚动条 thumb 上下来回——thumb 应跟手，不出现「拖不动 / 一顿一顿」。
3. 点 TOC 条目平滑跳转，TOC 高亮应正常跟随。
4. 编辑标题、在标题上方插入块，TOC 高亮应继续正确。

### 4.3 patch 生效范围（**不要把 `@platejs/toc` 加进 `optimizeDeps.exclude`**）

一个踩过的坑，留档以免重犯：

`@platejs/toc` 依赖 **只有 CommonJS 构建**的 `react-compiler-runtime`
（`main: dist/index.js`，无 `module` / `exports` / `type: module`），并且用具名导入取它的
`c`：

```js
import { c } from "react-compiler-runtime";
```

CJS→ESM 的具名导出 interop **只有 Vite 的预打包（esbuild）这一步会做**。一旦把
`@platejs/toc` 放进 `optimizeDeps.exclude`，Vite 就会原样把它当源码发给浏览器，
裸的具名导入无法解析，webview 直接报：

```text
Importing binding name 'c' is not found.
```

整个 Markdown 编辑器因此起不来（表现为错误页 / 重试）。

**那 patch 怎么进 `vite dev`？** 靠 pnpm 自己解决：patch 后包被解析到
`node_modules/.pnpm/@platejs+toc@53.0.0_patch_hash=<hash>/…`，预打包读的就是这份已打补丁的副本。
而预打包缓存 key 覆盖 lockfile，patch 内容一变，`pnpm-lock.yaml` 里的
`patch_hash` 就变 → 缓存自动失效。所以**预打包 + patch 是可以共存的**，
不需要 `exclude`。

验证方式（已实测）：

```bash
rm -rf node_modules/.vite
pnpm exec vite --port 5199
# 预打包产物里应含补丁标记，且不应残留 react-compiler-runtime 的裸导入
grep -c unobserve node_modules/.vite/deps/@platejs_toc_react.js          # 期望 1
grep -c 'from "react-compiler-runtime"' node_modules/.vite/deps/@platejs_toc_react.js  # 期望 0
```

生产构建侧同样验证：`pnpm build` 后 `dist/assets/` 中承载 TOC 的 chunk 应含 `unobserve`
（原版从不调用 `unobserve`）。

---

## 5. 边界

- **只修 scroll 这一条信号**：`useTocObserver`（TOC 自动滚动的高亮定位）仍会在 `activeId` 变化时重建它自己那个「单元素」observer——那是切标题才发生的事，不在滚动热路径上，本次不动。
- **rAF 合并带来一帧延迟**：DOM 重挂后的重新挂载最多晚一帧生效。这与原实现「同一事件内同步重建」相比是行为差异，对高亮正确性无影响（observer 回调本身是异步的）。
- **依赖 patch 而非 app 侧重写**：`useTocSideBarState` / `useTocSideBar` 仍由库提供，`toc-sidebar.tsx` 只保留了 `queryTocHeadings` 三层缓存与展示层。避免复制库的状态机（mouseInToc / isObserve / 滚动定位）。
- **升级 `@platejs/toc` 时必须重做 patch**：`pnpm install` 会因补丁上下文不匹配而失败，属于预期内的显式失败，不会静默退回未修复版本。
- **不解决 macOS 上的块级重排**：长笔记滚动时整篇绘制仍走 WebKit（`content-visibility` 在 WebKit 上被刻意关闭，见 [markdown-read-jank-offscreen-blocks.md](markdown-read-jank-offscreen-blocks.md) 与 `src/lib/core/paint-perf.ts`）。本次移除的是 scroll 热路径上的固定 JS 开销，不是绘制成本。

---

## 6. 决议记录

| 议题 | 决议 |
|---|---|
| app 侧重写 hook 还是 patch 上游 | patch 上游；库的状态机（mouseInToc / isObserve / 滚动定位）不值得复制，且缺陷在上游 |
| observer 是否彻底不管 DOM 重挂 | 否；保留重挂能力，但从「整表重建」改为「按 id diff」 |
| scroll 踢一脚仍走 React state 吗 | 否；改由 hook 自己持有 scroll 监听 + rAF 直接调用同步，避免整棵 TOC 重渲染 |
| 是否给 `status` 破坏性改名 | 否；保留为可选参数，类型标 `status?: number`，外部调用不受影响 |
| 是否把 `@platejs/toc` 加进 `optimizeDeps.exclude` | 否；它会让 CJS-only 的 `react-compiler-runtime` 具名导入 `c` 解析失败（见 §4.3）。预打包读的就是 pnpm 的 `patch_hash` 副本，补丁照样生效 |
