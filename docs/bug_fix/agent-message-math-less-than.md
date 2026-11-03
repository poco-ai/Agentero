# Agent 消息公式 `<` 被流式修复截断，KaTeX 报 EOF（#584）

## 范围与现象

Agent 消息里的公式包含**小于号后紧跟字母**的写法（`x_{<n}`、`$x<y$` 这类常见数学比较）时，渲染为红色 `katex-error`：

```text
ParseError: KaTeX parse error: Expected '}', got 'EOF' at end of input: …ft(x_n \mid x_{
```

复现（#584 原文）：

```markdown
$$
\mathcal{L}_{\mathrm{AR}} = -\frac{1}{N}\sum_{n=1}^{N}\log p_{\theta}\left(x_n \mid x_{<n}, \mathbf{c}\right).
$$
```

同一形状也影响行内公式与行内代码：`` $x_{<n}$ tail `` 渲染成 `$x_{`，`` use ``a<n`` here `` 渲染成 `` use ``a ``。与 #533（笔记编辑器路径的 `<0.5B`）同族但机制不同：#533 是 remarkMdx 崩溃，本篇是 Streamdown 流式修复截断。

## 原因

`MessageResponse` 用 Streamdown 渲染，默认 `mode="streaming"` 且 `parseIncompleteMarkdown=true`，于是**每次渲染**（包括消息早已完成的静态展示）都先跑一遍 `remend`——它是为流式生成设计的"不完整 Markdown 补全器"，会把未闭合的 HTML 标签从结尾截掉等待后续输入：

1. remark-parse + remark-math 阶段 mdast 完好，`math` 节点的 value 是完整 TeX（含 `x_{<n}`）。
2. Streamdown 在解析前执行 `remend(source)`；`<n}, \mathbf{c}\right).` 满足「`<` + 字母」的标签名起始形状、其后到结尾都没有 `>` 闭合，被判定为"正在生成的标签"整段截掉，`$$` 闭合围栏一并消失。
3. remend 的输出才进入 math 分词，KaTeX 拿到 `…\left(x_n \mid x_{`，`{` 未闭合 → `Expected '}', got 'EOF'`。行内 `` ` `` 代码同理（remend 不区分数学/代码区域）。

`a < b`（`<` 后是空白）与 `p<0.05`（`<` 后是数字）不构成标签名起始，不受影响；所以 #533 修复时未暴露本路径。

## 修复

`MessageResponse`（`src/components/agent/rendering/message-response.tsx`）按 `isAnimating` 派生 Streamdown 的 `mode`：

- **流式中**（`isAnimating=true`，各调用方已有的信号：chat-transcript / ask-popover / mobile-agent-page）：`mode="streaming"`，remend 照跑，行为不变——流式期间内容还会增长，截掉未闭合标签是合理的中间态。
- **已落定**（其余一切场合，含历史消息、plaza feed、翻译卡、wiki 注释嵌入、用户气泡）：`mode="static"`，完全跳过 remend，TeX 源原样进入 KaTeX，公式完整渲染。流式结束 `isAnimating` 翻 false 时 Streamdown 重渲染，从截断中间态恢复为完整公式。

不采用在 `prepareAgentMessageMarkdown` 里把数学区域的 `<` 改写成 `\lt` / `<{}` 的方案：`\lt` 在 `\text{}` 内是未定义命令会直接报错，`<{}` 虽渲染等价但污染 MathML（空 `<mrow>`）与 annotation 里的可复制 TeX 源。

## 回归验证

- `test/agent-message-math-less-than.test.ts`：#584 原公式落定后无 `katex-error` 且 TeX 源完整；`$x<y$` 行内公式与正文 `p<0.05` 不受影响；行内代码 `` ``a<n`` `` 不被吞。
