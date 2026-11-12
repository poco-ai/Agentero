# 双链 UI

编辑器状态栏展示反链数量与列表。右侧 **References** 展示当前论文的参考文献卡片；数据来自参考文献 sidecar 与库内匹配，见 [../backend/citation-parsing.md](../backend/citation-parsing.md)。

## 编辑器

- `[[wikilink]]` Live Preview；光标进入显示源码。
- 输入 `[[`：文件 / frontmatter alias / 标题 / block / 批注（`@`）候选；↑↓ 在列表内循环，不关闭菜单；底部提示 `#标题 · ^文本块 · |显示文本 · @批注`。
- **Frontmatter `aliases`**：笔记 YAML 中的别名参与 file 搜索与 resolve（与 Obsidian 一致）。按别名命中时**只**出现 alias 候选（主行=别名，副行=vault 相对路径），不再额外挂一条 basename `NOTES`。选中后写入 canonical 目标（**不**自动补 `|显示名`），便于继续输入 `#` / `@`。同名 alias 多文件时列出多条，不静默选第一条。论文的 title alias 另有同目录 canonical 主 PDF 候选，排在同名 NOTES 候选之前；选择后写入 `[[papers/<paper>/<paper>.pdf]]`，裸 `[[标题]]` 仍解析到笔记。
- 嵌套标题路径没有层数限制：`[[2026-W31#07-28 周二#复盘分析#paper 阅读]]`、同文件写法与对应 `![[...]]` 均合法。
- 完整路径是标题的 canonical identity；Markdown 引用也可省略开头祖先，使用任意长度的连续路径后缀，例如唯一时 `[[2026-W31#复盘分析#paper 阅读]]` 合法。后缀命中多个标题时返回歧义，不选择第一个结果。
- 每输入一个额外 `#`，其前面的路径段成为已确认父路径，候选只显示该父标题的直接子标题。父路径本身也按后缀匹配，因此可从省略祖先的标题继续逐级补全，且没有两级或其他固定深度限制。
- 标题候选第一行是 `H2 目标标题`，第二行是祖先前缀（`外层 >`）。选择候选后仍写回完整 `外层#内层`；手写的唯一后缀保持原文。查询接受源码分隔符 `#`，也接受前缀里的 `>` / `›`。
- `@` 批注与 `#` / `^` 同属 fragment：`[[@id]]`、`[[papers/…/NOTES@id|alias]]`、`[[paper.pdf@id]]`、`[[…#@id]]`（与 `@id` 等价）。target 必须是可解析路径/文件名，**不要**单独用论文展示标题；面板复制默认 `[[papers/…/NOTES@id|论文标题]]`。id 来自高亮 `annotations.json` 或视觉 mark（`kind: visual`，旧 `agent-trace` 仍认；nanoid 可含 `_`）。
- 序列化必须写回 `[[...]]`（Obsidian 兼容）。
- `![[...]]`：嵌入 Markdown 区段、图片、PDF、批注；Markdown 区段与批注预览只读，论文主 PDF 可直接高亮、编辑备注及创建视觉批注；普通编辑不刷新无关嵌入。单独成段时卡片占满行宽，段内空文本占位不再撑出上下空行；与正文写在同一段时保持行内，不掉到下一行。被引用的位置行、原文和译文跟 Appearance 的 `wikiEmbedFontSize`（默认 13px，再乘界面缩放）；Markdown 嵌入整段正文也跟它。卡片标题栏仍用更小的 chrome 字号。批注备注跟编辑器正文字号，不跟这个滑块。批注嵌入（`contentKind: annotation`）与其它 embed 共用 `max-h` 滚动壳；位置优先大纲路径否则页码。文字高亮与视觉批注的备注均渲染 Markdown；视觉批注的备注以图标 + 内容显示在裁剪图上方，仅当有 Agent 对话时才展示下方 transcript（无对话不显示空状态）；**正文不可点跳转**，仅顶栏 ExternalLink 打开 PDF。Host `wiki check` 校验 path + id 形态，不读 `marks/` 验存活。文字高亮的 `quote` 若对上全文译文的句对、与没有句对的整段 `source` 完全相同，或与一条划词翻译的 `quote` 相同，原文下面用更弱的颜色显示译文，字号与原文相同，不加标签，也不写回批注。对不上、视觉批注，或没有译文文件时只显示原文。
- **导出模式**（笔记导出 PDF/PNG）：`MarkdownExportModeProvider` 下展开 `max-h`、去掉打开源按钮；图片/批注裁剪图取消高度上限；完整 PDF 附件改为路径占位。见 [markdown.md](markdown.md)。

与 **Markdown 双链**（`graph_get_graph` / 反链）分层；双链索引仍服务编辑器补全、嵌入与状态栏反链，不驱动关系图。

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

### PDF 段落导航

PDF 双链可写为 `[[papers/demo/demo.pdf#2]]`、`[[papers/demo/demo.pdf#2.1]]` 或 `[[papers/demo/demo.pdf#2.1#p3]]`；普通 Markdown PDF 链接也支持这些 fragment。相对路径先按源笔记解析，再交给共享 PDF 定位器。章节和段落锚点从 `agentero layout list` 查询；目标缺失、解析缺失或歧义会提示失败，不跳到其他段落。相同锚点在聊天、链接和双链中使用相同的滚动位置与临时高亮范围。

PDF 嵌入 `![[paper.pdf#2.1]]`、`![[paper.pdf#2.1#p3]]` 及旧式 `![[paper.pdf#section=2.1]]` 复用共享定位器，在查看器布局就绪后定位到章节标题块或段落块，并持续高亮其原始 bbox（不外扩为整章正文）。每个嵌入有独立文档实例和引用高亮，不占用主查看器的临时引用焦点；引用高亮仅是展示状态，不写入批注或 layout 文件。普通重渲染保留手动滚动位置；更换目标、重新挂载或重开笔记会重新定位。目标缺失或歧义沿用嵌入状态提示；定位调用失败时另报 Toast，不展示错误章节。

`[[文件.pdf#]]` 的补全读 `source/layout.json`，列出带章节名的编号章节（不是 Markdown 标题）。第一行仍是章节标题，第二行是上级前缀（`Related Work >`），顶层章节没有第二行。Markdown 目标仍走原来的标题搜索，不读 layout。底部提示在目标或当前高亮项是 PDF 时改成章节/段落说明。Tab 在原位置把章节写成 `文件.pdf#2#`（末尾的 `#` 还不是一条完整链接，不会先删掉已输入的双链），并继续列出该章段落（`2#p1`）；Enter 只写入章节锚点。段落锚点与 Host 的阅读顺序、罗马数字章节号一致。

PDF 嵌入会确认目标是论文主 PDF 后传入论文目录、Vault 和实际 PDF 路径，复用主阅读器的 `marks/` 读写。普通附件 PDF 不挂接主论文批注。嵌入按容器页宽显示，备注卡片在悬停或编辑时显示在页内；滚动不更新论文的上次阅读页。同窗口的主阅读器与多个嵌入同步新增、备注、改色和删除；重新打开仍加载已保存批注。

带引用目标的 PDF 嵌入在顶栏「打开」左侧提供「回到引用位置」图标按钮。滑动离开目标后可一键重新定位当前实例，保留缩放和批注状态；普通 PDF 嵌入不显示该按钮。
