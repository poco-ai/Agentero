# Markdown 编辑

Plate WYSIWYG；用于普通笔记与论文 `NOTES.md`。磁盘上始终是标准 Markdown，保证 Vault 可被 Obsidian / VS Code 打开。

## 技术选型

| 库 | 用途 |
|---|---|
| `@platejs/*` 插件体系 | 基于某种 Slate 模型的富文本编辑 |
| `@platejs/markdown` | Markdown ↔ 编辑器文档 序列化 |
| `prettier/standalone` + `prettier/plugins/markdown` | 用户显式触发的整篇 Markdown 格式整理；首次使用时按需加载 |
| `@platejs/media` 等 | 图片等节点 |
| 自定义双链插件 | `[[...]]` 输入、高亮、跳转；序列化必须写回 `[[...]]` |

原则：所见即所得；与 shadcn/ui 工具栏风格一致；Agent 写回的 Markdown 经反序列化再展示。编辑期间的权威状态是 Plate AST，保存时再序列化为 Markdown；应用不会在每次渲染时重新读取一份隐藏的 Markdown 源字符串。

## 能力

- 自动保存；可选顶部格式工具栏（`showEditorToolbar`）。
- **文档目录**：至少存在三个标题时，才在编辑器右侧四分之一高度显示层级标记，一级标题标记最长，后续层级依次缩短；收起时保持紧凑，悬停或键盘聚焦后以动效展开标题；展开后标题在目录块内左对齐，depth marker 仍靠右；滚动时以中性色高亮视口对应的标题，点击标题会在当前 Dockview 文档面板内平滑滚动并高亮目标。
- **外部链接**：手写或粘贴标准 Markdown `[文字](https://…)` 会成为链接节点；普通单击打开编辑气泡（改显示文字与 URL），`⌘/Ctrl+单击`、中键或右键用系统浏览器打开；气泡内也有「打开」。`/` 菜单「外部链接」或右键「新增外部链接」直接插入链接节点（默认占位文字）并打开同一编辑气泡，而不是插入字面量 `[]()`。Vault 内相对 `.md` 链接与 `wiki:` 双链仍走站内导航。
- **Markdown 粘贴**：普通文本粘贴默认按 Markdown 反序列化，粘贴后光标保持在插入内容之后。
- **整理 Markdown 格式**：编辑器右键显式整理当前整篇文档；只读编辑器禁用。
- **Slash 格式命令**：在可编辑正文中输入 `/` 打开轻量命令列表；使用上下方向键选择、Enter 执行、Escape 关闭。Slash 与双链候选会在可视窗口边缘自动翻转并限制高度；滚动编辑器时关闭候选，避免脱离光标。
- **美元符号**：`\$a\$` 是普通文本，`$a$` 是行内公式；两者经编辑、粘贴、整理和保存后保持不同语义。
- **公式错误恢复**：未闭合的独立 `$$` 不会吞掉其后的 Markdown；围栏内的错误内容按普通文本保留，后续段落和标题继续正常解析。
- **Obsidian Callout**：`> [!important]` 等标准 marker 渲染为专用块，正文继续使用既有段落、列表、公式与双链节点。
- **代码块操作**：编辑态悬停或聚焦代码块时，右上角依次显示语言选择与复制按钮；只读预览只显示复制按钮。选择 Mermaid 语言后，源码下方显示实时预览。
- **内嵌图**（见下表）。
- **双链 / 嵌入**：见 [wiki.md](wiki.md)。
- **导出 PDF / PNG**（桌面端）：工具栏分享按钮或右键「导出为 PDF / 图片…」。离屏只读渲染当前序列化内容（含未保存改动）。页面背景贴边；正文内边距对齐编辑器 `default`（`px-16 pt-4`，底边 `pb-10`）。默认完整展开 `![[…]]` 嵌入，就绪后用 `html-to-image` 截视觉层。**PDF**（`pdf-lib`）在位图上叠 **不可见可选中文字层**（DOM 测量 + Host `export_system_cjk_font`）与 **http(s)/mailto 链接注解**，再按 A4 分页；**PNG** 仍为纯位图。可选论文页眉、每页水印（logo + `muted-foreground`）。完整 PDF 附件嵌入为路径占位。默认水印见设置 → 通用。
- **外部改盘**：无未存改动则重载；有未存则 toast；内容相等抑制自写回声。
- **保存冲突**：写盘前比对上次落盘内容；磁盘已被外部改则中止并警告。

## 内嵌图片

| 项 | 方案 |
|---|---|
| 落盘 | `{mdDir}/assets/`；正文 `![alt](./assets/file.ext)`（Obsidian 兼容） |
| 插入 | 粘贴 / 工具栏 → `writeVaultBytes` |
| 预览 | 相对路径 → fs `readFile` → `blob:`；**选中**节点显示 Markdown 源码 |
| GC | 引用计数归零且 managed `./assets/` 时删除文件 |

## 数据流

```text
打开文件
  → Host 读文本
  → @platejs/markdown 反序列化
  → Plate 渲染

保存
  → 序列化为 Markdown 文本
  → Host 写盘
  → watcher → 按需重建 wiki 索引
```

### 显式格式整理

“整理 Markdown 格式”采用 `Plate AST → Markdown → Prettier → Plate AST`，处理整篇文档，不读取选区的可见文本，也不会在输入、粘贴、打开或自动保存时隐式运行。

```text
右键整理
  → 序列化当前完整快照
  → 异步加载 Prettier 并格式化
  → 再次比对当前序列化结果
  → 结果过期：提示重试，不替换编辑器内容
  → 结果未变化：恢复焦点，不写 Undo history
  → 结果有效：反序列化并以一个 history batch 替换全文
  → 按文本上下文恢复选区与焦点
```

Frontmatter 当前保存在 Plate AST 之外，因此整理时继续字节级保留；这样格式整理产生的实际正文变化可以由一次 Undo 完整撤销。Prettier 固定使用 `proseWrap: "preserve"`、`embeddedLanguageFormatting: "off"` 与 `htmlWhitespaceSensitivity: "ignore"`，避免重排正文段落或 fenced code 内部语言。

### Properties（frontmatter）

编辑器工具栏提供 **Properties** 图标，点击后展开属性填写下拉表格：

- **表单模式（默认）**：左侧类型图标切换 **文本 / 列表 / 复选框 / 日期**（列表为 chips，复选框为开关，日期为 `YYYY-MM-DD`）；可添加属性。磁盘仍为合法 YAML（`true`/`false`、ISO 日期、block list）。
- **源码模式**：右上角切换为 YAML 正文（不含 `---` 围栏；保存时自动包回）。复杂 YAML（嵌套 map、多行标量等）自动回退源码。
- 清空属性即去掉 frontmatter；与正文共用自动保存 / dirty 状态。
- 常见用途：Obsidian 兼容 `aliases`，供双链搜索按标题命中该笔记（见 [wiki.md](wiki.md)）。
- 精读 skill 会在 `NOTES.md` 写入 `aliases`（论文全称 + 短标题）与 `created: YYYY-MM-DD`（已有创建日期不覆盖）；用户也可在此面板改。

### Slash 格式命令

输入 `/` 后，编辑器根据 `/` 后的连续文本过滤命令，条目统一显示图标与本地化文案。`/` 必须位于当前文本叶开头或紧跟空白，URL、转义斜杠、代码块和只读编辑器不会触发；Wiki 双链补全活跃时优先使用 Wiki 菜单，编辑器失焦后关闭菜单。执行前会再次核对当前光标、文本位置与 `/query`，选区已经移动或文本已变化时不会删除内容。

首版命令包含一级至三级标题、无序列表、有序列表、待办列表、引用、代码块、Mermaid 图表、添加内部链接、添加外部链接和 Obsidian Callout。`/mermaid` 会插入带 `lang: mermaid` 标记的 Plate 代码块，Mermaid 代码块会在源码下方实时显示预览；输入未完成或语法错误时保留源码并提示无法渲染。需要普通代码块时仍使用 `/code`，也可以在代码块右上角的语言选择器中选择 Mermaid。“添加内部链接”和“添加外部链接”复用右键菜单的模板插入逻辑，分别插入 `[[]]` 与 `[]()`，并把光标放到可继续输入的位置；内部链接会继续打开双链候选。其他命令直接调用现有 Plate 块、列表与代码转换；Callout 使用 Agentero 已有的 Obsidian 节点，默认类型为 `note`，可以保留 `/query` 前的当前块文本。Callout 内仍可用 Slash 命令调整正文格式，但不会提供嵌套 Callout。完整 Plate SlashKit 中的 AI、Toggle、Columns、TOC、Date、Excalidraw 与通用非 Obsidian Callout 不接入。

`/mermaid` 的初始内容为：

```mermaid
graph LR
A[Start] --> B[Process]
B --> C[End]
```

### Callout

支持以下 Obsidian 形式：

```md
> [!important] 可选标题
>
> 正文可包含列表、$公式$ 与 [[双链]]。
```

已知类型使用对应图标与 light/dark 主题；未知但合法的 type 使用通用样式，并按原始大小写写回 Markdown。没有显式标题时只显示本地化默认标题，不向源码补写标题。标题行通过 Markdown hard break 与正文相连时仍可识别；`\[!important]` 的开括号已经显式转义，因此保持普通引用文本。逐字符输入完整的 `> [!important] 可选标题` 后按 Enter，会转换为 Callout 并将光标放入正文；转换不依赖粘贴或格式整理。Slash 菜单也可以插入默认 `note` Callout。正文普通段落中的 Enter 只在当前 Callout 内拆分段落，不复制整个 Callout；列表和嵌套块继续使用各自插件的 Enter 语义。光标位于正文时，第一次 `⌘A` / `Ctrl+A` 只选中当前 Callout 的全部正文，再按一次才扩展为整篇文档。编辑态点击标题可直接行内编辑，标题输入框保持透明且无边框，失焦或按 Enter 保存，按 Escape 取消；点击标题左侧图标会打开带主题色图标和本地化名称的标准类型列表。修改后的元数据通过既有自动保存写回 marker。首版不支持自定义 type 输入、`+` / `-` 折叠 marker、嵌套 Callout、工具栏插入或拖拽换类型，这些语法保持普通引用文本。

## 代码

| 路径 | 职责 |
|---|---|
| `src/components/editor/` | Plate 编辑器 |
| `src/components/editor/markdown-export-dialog.tsx` | 导出格式与选项对话框 |
| `src/components/editor/markdown-export-surface.tsx` | 离屏只读导出渲染（export mode） |
| `src/lib/markdown/export/` | 论文页眉解析、就绪等待、截图 / PDF 分页、保存 |
| `src/components/editor/frontmatter-panel.tsx` | 可折叠 Properties / YAML frontmatter 编辑 |
| `src/lib/markdown/frontmatter.ts` | frontmatter 围栏拆装与属性计数 |
| `src/components/editor/toc-sidebar.tsx` | 基于 Plate TOC hooks 的悬浮目录、当前标题跟踪与跳转 |
| `src/components/editor/code-block-node.tsx` | 代码语言选择、复制与 Mermaid 预览 |
| `src/components/editor/plugins/callout-actions.ts` | Callout 类型与标题的校验和 AST 更新 |
| `src/components/editor/plugins/slash-command.ts` | Slash trigger、过滤、stale guard 与格式转换 |
| `src/components/editor/slash-command-menu.tsx` | 图标列表、键盘选择与浮层交互 |
| `src/components/editor/plugins/markdown-kit.tsx` | Markdown 解析、序列化、粘贴与 Callout portable rules |
| `src/lib/markdown/format.ts` | 按需加载的 Prettier Markdown 纯函数 |
| `src/lib/markdown/editor-format.ts` | stale guard、frontmatter 保留、selection bookmark 与单次 Undo 事务 |
| `src/lib/markdown/image.ts` | 内嵌图 IO / GC |
| `src/lib/markdown/save-state.ts` | 保存与冲突 |
| `src/lib/vault/fs-watch.ts` | 文件变更重载 |

Vault 文件约定：[../backend/data-model.md](../backend/data-model.md)。
