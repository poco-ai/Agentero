# 论文库 Library

中间栏 catalog 表格；数据一次 `paper_list` 进内存。

## 视图

- 虚拟路径 `agentero:library`（不写盘）。
- **全库**：点 Library 节点或关光文档后默认页。
- **文件夹作用域**：单击 `papers/` 下非 paper 叶目录（如 `papers/nlp`）→ 同一 Library panel 上按 `paper.path` **前缀过滤**（不新开 tab、不重新 RPC）。
- **非 papers 目录**（`notes/`、`.agents/`、`plans/` 等）：不进入文件夹作用域，Library 显示全库（#160）。
- 外部 CLI / 同步工具改动 `.agentero/catalog.sqlite` 或 `papers/` 结构时，前端会后台去抖重新 `paper_list`，同步 Library 表格与文件树论文标题。
- NOTES 仅选中**具体论文**时出现；Paper Info 保留最近选中的论文，切换到非论文文档时仍显示。

## 表格能力

| 能力 | 说明 |
|---|---|
| 排序 | 表头点击；排序/标签筛选变化时行区 150ms 淡入提示重排（搜索键入不触发） |
| 列 | 表头右键选列 / 拖拽排序；顺序+显隐持久化 `libraryColumns`；标题列不可隐藏 |
| 滚动 | 横向 + 纵向 |
| tags | 染色 chip；搜索框匹配用户标签子串；`@zotero:` Connector 内部标签不显示 |
| 阅读热力 | 标题列左侧显示该论文阅读进度热力条；基于 `marks/` 中逐页标注与阅读位置聚合 |
| Rescan | `paper_rescan`：盘上有、catalog 无则补齐 |
| Download | 库内任一篇缺资源时批量补下 |
| 导入/导出 | Library 工具栏；导出 BibTeX 亦可在 Library 节点右键 |
| 拖入 PDF | Finder / 其它 App 把一个或多个 PDF 拖到 Library 表：虚线 overlay（仅 PDF），松手后走与文件树相同的 metadata 确认框。文件夹作用域导入到当前 `papers/…`；全库则落到树选中的 Papers 夹（否则 `papers/`）。非 PDF 不显示 overlay、不入库 |

## Tags（前端）

- Paper Info 增删 + Apple 8 色色盘 → `paper_set_tags`。
- `@zotero:` 前缀标签属于 Connector 来源标记，只保留在 catalog 中，不参与展示、搜索和筛选；编辑普通标签时会保留这些内部标签。
- 色板：`src/lib/ui/tag-colors.ts`。
- CLI 标签见 [../backend/catalog.md](../backend/catalog.md)。

## 代码

- UI：`src/components/library/`（拖入：`library-pdf-drop-surface.tsx`）
- 状态：`src/lib/paper/library-store.ts`、`library-actions.ts`、`import-actions.ts`（`dropLocalPdfs`）
- 单测：`test/library-scope.test.ts`、`test/prompt-image.test.ts`（`dataTransferLooksLikePdfs`）
