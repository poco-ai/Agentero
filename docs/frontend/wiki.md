# 双链 UI

右侧 **Backlinks** 栏：上方反链列表，下方 **双链 Graph**（非文献引用图）。

## 编辑器

- `[[wikilink]]` Live Preview；光标进入显示源码。
- 输入 `[[`：文件 / frontmatter alias / 标题 / block / 批注（`@`）候选；↑↓ 在列表内循环，不关闭菜单；底部提示 `#标题 · ^文本块 · |显示文本 · @批注`。
- **Frontmatter `aliases`**：笔记 YAML 中的别名参与 file 搜索与 resolve（与 Obsidian 一致）。按别名命中时**只**出现 alias 候选（主行=别名，副行=vault 相对路径），不再额外挂一条 basename `NOTES`。选中后写入 canonical 目标（**不**自动补 `|显示名`），便于继续输入 `#` / `@`。同名 alias 多文件时列出多条，不静默选第一条。
- 嵌套标题路径没有层数限制：`[[2026-W31#07-28 周二#复盘分析#paper 阅读]]`、同文件写法与对应 `![[...]]` 均合法。
- 完整路径是标题的 canonical identity；Markdown 引用也可省略开头祖先，使用任意长度的连续路径后缀，例如唯一时 `[[2026-W31#复盘分析#paper 阅读]]` 合法。后缀命中多个标题时返回歧义，不选择第一个结果。
- 每输入一个额外 `#`，其前面的路径段成为已确认父路径，候选只显示该父标题的直接子标题。父路径本身也按后缀匹配，因此可从省略祖先的标题继续逐级补全，且没有两级或其他固定深度限制。
- 标题候选显示 canonical 路径 `外层标题 › 内层标题`，选择候选后写回完整 `外层标题#内层标题`；手写的唯一后缀保持原文。查询接受源码分隔符 `#` 和候选展示分隔符 `›`，并保留用户已输入的文件 target、alias 与 embed 标记。
- `@` 批注与 `#` / `^` 同属 fragment：`[[@id]]`、`[[papers/…/NOTES@id|alias]]`、`[[paper.pdf@id]]`、`[[…#@id]]`（与 `@id` 等价）。target 必须是可解析路径/文件名，**不要**单独用论文展示标题；面板复制默认 `[[papers/…/NOTES@id|论文标题]]`。id 来自高亮 `annotations.json` 或视觉 mark（`kind: visual`，旧 `agent-trace` 仍认；nanoid 可含 `_`）。
- 序列化必须写回 `[[...]]`（Obsidian 兼容）。
- `![[...]]`：嵌入 Markdown 区段、图片、PDF、批注（只读）；普通编辑不刷新无关嵌入。批注嵌入（`contentKind: annotation`）与其它 embed 共用 `max-h` 滚动壳；位置优先大纲路径否则页码。视觉批注：备注以图标 + 文字显示在裁剪图上方；仅当有 Agent 对话时才展示下方 transcript（无对话不显示空状态）；**正文不可点跳转**，仅顶栏 ExternalLink 打开 PDF。Host `wiki check` 校验 path + id 形态，不读 `marks/` 验存活。
- **导出模式**（笔记导出 PDF/PNG）：`MarkdownExportModeProvider` 下展开 `max-h`、去掉打开源按钮；图片/批注裁剪图取消高度上限；完整 PDF 附件改为路径占位。见 [markdown.md](markdown.md)。

## Graph

| 项 | 说明 |
|---|---|
| 库 | `react-force-graph-2d`（Canvas 力导向） |
| 数据 | Host `graph_get_graph` → nodes / edges |
| 节点启发 | paper / note / index / stub |
| 壳 | 嵌在 Backlinks 下方，非独立顶层 tab |
| 交互 | 缩放、拖拽、点击打开文件/paper |

数据必须来自 Markdown 双链索引，不能来自手工图数据库。

派生全文 `PAPER.md` 只作为可链接目标和标题来源，不向 Graph 贡献 outgoing edges；用户笔记中的 `NOTES.md` 和普通 Markdown 仍参与完整索引。

## 链接修复（前端触发）

- Agentero 内重命名/移动：事务化修复已解析链接。
- 外部本地 rename：按设置 `ask` / `always`。
- 外部 rename 的双链修复与警告只关注 Markdown、PDF、受支持图片和疑似目录；JSON sidecar、临时文件等明确非链接目标仍刷新工作区，但不进入双链处理。
- 显式标题重命名事务。

标题重命名、跳转和嵌入继续消费同一个结构化 `LinkFragment.path: string[]`。该数组保存 Markdown 中实际写下的完整路径或连续后缀；解析成功后再映射到唯一 canonical heading path。显式标题重命名只改写引用中实际包含的被改名路径段，省略该祖先的后缀引用保持原文。

## 代码

- 面板：`src/components/wiki/`
- 逻辑：`src/lib/wiki/`、`wiki-completion.ts`、`wiki-embed.ts`、`wiki-navigation.ts`、`wiki-heading-rename.ts`
- Host：[../backend/wiki.md](../backend/wiki.md)
