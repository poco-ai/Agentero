# 笔记公式定界符不被识别：`\[…\]` 显示为源文本、单行 `$$…$$` 只能行内渲染

## 范围与现象

同一个根因的两个触发形态，分别由 #1162 和 #1171 记录：

- **#1162**：笔记里写独占一行的单行 `$$\frac{a}{b} \tag{1.1}$$`，渲染成红色等宽源码，KaTeX 报 `\tag works only in display equations`；不含 `\tag` 的单行 `$$…$$` 能显示，但字号变小、不居中——被当成行内公式。真实笔记（97 KB 讲义、101 个单行 `$$…$$`、其中 43 个含 `\tag`）几乎整篇公式失效。
- **#1171**：Cool Papers（Kimi 解析）拉取的论文 `NOTES.md` 用 LaTeX 的 `\[ … \]` 写行间公式，编辑器把整块当普通段落显示（`\tilde`、`\quad`、`\phi` 原样可见）；`\( … \)` 行内写法退化成纯文本 `(x)`。更糟的是，在这类笔记里做任意编辑触发自动保存后，`\[…\]` 会被重新序列化成残缺形式（`\[E=mc^2\]` → `\[E=mc^2]`，多行块变成 `\[\` + 换行 + …），已落盘内容再也无法匹配定界符。

两条 issue 的触发语法不同，但都发生在**笔记 Markdown → Plate 的反序列化管线**：Agent 消息路径一直支持这些写法。

## 原因

1. `remark-math@6.0.0` 只有 `$` / `$$` 语法。`\[…\]`、`\(…\)` 在 mdast 层是纯文本（CommonMark 还会把 `\[` 当转义吃掉反斜杠），`remarkMath` 不产生 `math` / `inlineMath` 节点。
2. remark-math 只把**单独成行**的 `$$` 认成块级围栏；单行 `$$…$$` 解析为 `inlineMath`，`@platejs/markdown` 映射成 `inline_equation`，`src/components/editor/nodes/block/equation-node.tsx` 给它的 `inlineKatexOptions.displayMode = false`，KaTeX 因此拒绝只在 display 数学里合法的 `\tag`。
3. 仓库已有 `normalizeMarkdownMath`（`src/lib/markdown/math-normalize.ts`），支持 `\[…\]` / `\(…\)` 并把单行块公式重排成围栏，但调用点只有 Agent 消息路径 `src/lib/agent/message-markdown.ts`。笔记入口 `prepareMarkdownForDeserialize` 完全没有数学定界符归一化；插件裁剪的 `source.includes("$")` 让纯 `\[` 笔记连 `remarkMath` 都不挂载。
4. 不归一化时，反序列化把未知定界符当文本，序列化再按普通文本重写，造成 #1171 里的破坏性回写。

## 修复

- `math-normalize.ts` 新增 `normalizeNoteMarkdownMath`，只做三种定界符形态：
  - 独占一行的单行 `$$…$$` → 多行 `$$` 围栏（块级 `equation` 节点，display 模式，`\tag` 可用）；
  - `\[…\]` → 块级 `$$` 围栏；`\(…\)` → `$…$`；
  - 夹在句子中间的 `$$…$$` 保持行内（围栏不能出现在段落行内）。
- 归一化先算出代码区域（``` 与 `~~~` 围栏、引用块内围栏、未闭合围栏、行内代码）的字符区间，与这些区间重叠的改写直接放弃，避免把代码里的定界符字样改成公式；代码围栏的闭合围栏允许比开启围栏更长。已有 `$` / `$$` 公式原样保留，函数幂等。
- 有意**不复用** `normalizeMarkdownMath` 的 Agent 专用改写（裸命令包裹、`\newcommand` 展开、`\label` 编号）：笔记会回写磁盘，不能因为打开一次就改写无关内容。
- 归一化放在 `prepareMarkdownForDeserialize` 最前面，位于 `escapeUnclosedBlockMath`、MDX 花括号/尖括号转义和 remark 插件嗅探之前，因此笔记打开、源码切回渲染、外部改盘重载、Markdown 粘贴、`![[…]]` 嵌入、导出 PDF/PNG、PDF 批注这些共用入口一起生效；新产生的 `$` 也能让插件嗅探挂上 `remarkMath`。
- 引用块里的公式围栏（`> $$` 各行）现在也被 `BLOCK_MATH_FENCE` 识别，`escapeStrayMdxBraces` / `escapeStrayLessThan` 不再把公式里的 `{` / `<` 实体化（否则 KaTeX 会解析失败）。这同时修好了此前就存在的 `> $$…$$` 花括号损坏。
- 保存时公式按 Plate 的序列化写成规范 `$$` 围栏（单行 `$$x$$` 与 `\[x\]` 都会落盘为三行围栏），不再产生 #1171 里的残缺回写。

已知限制：未闭合的 `\[` 仍是普通文本；4 空格缩进代码块尚未纳入代码区间识别，其中的定界符会被当正文处理；#1171 中已经被旧版本破坏成 `\[\` / `]` 的落盘内容不再匹配定界符，需要重新拉取或手改。

## 回归验证

- 本地临时 vitest（按约定不提交）：
  - `normalizeNoteMarkdownMath` 的三种定界符、独占一行判定、代码围栏（``` / `~~~` / 行内代码）、`\\[5pt]` 不误改、幂等、blockquote 前缀、CRLF、空定界符；
  - 真实管线（`prepareMarkdownForDeserialize` + `deserializeMarkdownBody`）：单行 `$$…$$` 得到顶层 `equation` 且 `katex.renderToString(…, { displayMode: true })` 接受 `\tag`；`\[…\]` → `equation`；`\(…\)` → `inline_equation`；代码块内的定界符保持字面量；序列化 round-trip 得到 `$$\n…\n$$`。
- 既有测试：`test/markdown-deserialize.test.ts` 中「`\(...\)` 是普通文本」的断言随行为更新为 `inline_equation`；`test/math-normalize.test.ts`、`test/editor-inline-math.test.ts`、`test/markdown-serialize.test.ts`、`test/title-math.test.ts` 保持通过；前端全量 `pnpm vitest run` 通过。
