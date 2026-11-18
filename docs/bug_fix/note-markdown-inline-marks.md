# 笔记与 Agent 回复的高亮 / 下划线（#1168 / #1170）

## 现象

Agentero 0.16.2 的反馈里，Markdown 的高亮与下划线出现三类互相独立的问题：

1. 模型回复里的 `<u>已有标签</u>`、`<mark>细胞注释</mark>` 原样显示成标签文本（#1168）。
2. 笔记里的 `==高亮==` 只在编辑器里逐字输入时有效；写在磁盘上的 `==高亮==` 打开后是字面量，保存后行首还会变成 `\==高亮==`（#1168 / #1170）。
3. 笔记编辑器内部：相邻的 `<mark>a</mark><u>b</u>` 保存后合并成 `<mark>ab</mark>`（下划线被静默吞掉，磁盘源文件被改写）；`__下划线__` 输入得到粗体；中文后 `前面==高亮==` 不触发输入规则（#1170）。

## 根因

| 链路 | 根因 |
|---|---|
| Streamdown 渲染面（Agent 回复 / PDF 问答 / 批注卡 / Plaza） | Streamdown 2.5.0 默认管线没有 `rehype-raw`，把 mdast `html` 节点替换成文本，`<u>` / `<mark>` 因此变成字面文本 |
| 磁盘 `==高亮==` | remark 管线没有 `==` 的解析插件；Plate 的 `HighlightRules` 只是输入规则。序列化时纯文本行首的 `=` 会被 `mdast-util-to-markdown` 的 `unsafe` 规则转义成 `\==` |
| 相邻高亮 + 下划线合并 | `@platejs/markdown@53.2.2` 的 `mergeTexts` 只比较 mdast `type`；高亮与下划线都序列化为 `mdxJsxTextElement`，于是被合并成一棵子树，后者的 `name` 被丢弃 |
| `__下划线__` 变粗体 | `UnderlineRules` 与 `BoldRules({variant:"_"})` 的 trigger / start 相同，粗体插件先注册先命中，下划线规则永远不可达 |
| 中文后 `==` 不触发 | `createMarkInputRule` 的 `getMarkMatch` 要求开符号前是行首或空白（`isPreviousCharacterEmpty`），且闭合前不允许空格 |
| MDX 回退降级 | 整篇 MDX 解析失败时会改用无 MDX 管线；此时受支持的内联标签是 raw `html` 节点，Plate 默认规则把它压成文本，下一次保存再转义 |

## 修复

- **序列化合并**（数据正确性，最优先）：用仓库已有的 `pnpm patchedDependencies` 机制给 `@platejs/markdown@53.2.2` 打补丁，backport 上游 `sameContainer`：`mdxJsxTextElement` / `mdxJsxFlowElement` 只有在 `name` 与 `attributes` 都相同时才允许合并。注意 npm 上最新的 53.5.3 仍带未修复的 `mergeTexts`，不能靠升级解决；上游修复后应删补丁并升级。
- **统一高亮语法**：磁盘上 `<mark>` 是规范写法（Plate 默认序列化），`==文字==` 作为等价输入被解析：新增 remark pass 把 text 节点里的 `==…==` 转成 mdast `mark`，再映射为高亮 mark。这样打开 `==高亮==` 即高亮，保存写回 `<mark>高亮</mark>`，不再产生 `\==`。边界遵循 markdown-it-mark：分隔符恰好两个 `=`，内容首尾不能是空白，但两侧字符不限（所以中文无空格也可用）。
- **Streamdown 渲染面**：给 `MarkdownSurface` 传 `allowedTags={{ u: [], mark: [] }}`，打开 Streamdown 自带的 raw → sanitize → harden 管线（默认 schema 已含 `sub` / `sup` / `kbd`），脚本仍被剥离、未知标签降级为文本。同一组件用 remark transformer 把 `==…==` 改写成 `<mark>`，所有渲染面（Agent 回复、页内问答、译文卡、批注卡、Plaza 详情）保持一致。
- **输入规则**：删除不可达的 `UnderlineRules`（`__` 按 CommonMark 是粗体，下划线统一 `<u>` / 工具栏 / `Ctrl+U`）；用 `matchDelimitedInline` 写自定义 `==` 规则，去掉前导空白限制但保留「内容首尾不能是空白」。注释编辑器 kit 同步删除不可达规则。
- **源码模式**：高亮按钮改写 `<mark>…</mark>`，与 WYSIWYG 保存的写法一致，切换视图不再换语法。
- **MDX 回退**：回退管线追加 remark pass，把 `<u>/<mark>/<sub>/<sup>/<kbd>` 的 raw html 兄弟节点包成真正的 mdast mark，`<br>` 转成硬换行；格式错误或不支持的标签保持字面量，不再把整篇内联标记降级成会被转义的文本。

## 约束与回归点

- 高亮 / 下划线 mark 的磁盘写法是 `<mark>` / `<u>`；`==` 只作为输入兼容，落盘会归一化。`<mark>` 与 `<u>` 相邻时必须是两个节点，不能被合并。
- `==` 扫描按单个 text 节点进行，`==a *b* c==` 这种跨强调节点的内容不会高亮（保留字面量）；混排内容用 `<mark>`。`==a===` 这类更长的 `=` run 不作为分隔符。
- Streamdown 开启 raw 管线后，默认 sanitize schema 内的其它标签（`b` / `div` 等）也会渲染而不是被剥成文本；脚本、表单、事件属性和未知标签仍被剥离。
- 不能用「升级依赖」替代 `sameContainer` 补丁：上游 npm 版本还没带该修复，升级后必须重新核对 `mergeTexts`。
- 验证方式：`==高亮==` 解析 / 保存 / 重开稳定；`<mark>a</mark><u>b</u>` 双向不合并；`前面==高亮==` 逐字输入触发、`==高亮 ==` 不触发；`__x__` 是粗体；Agent 回复 SSR 里 `<u>` / `<mark>` / `==x==` 渲染且 `<script>` 被剥离；MDX 回退用例 `<mark>good</mark> and <callout a=>x</callout>` 恢复 `good` 的高亮。
