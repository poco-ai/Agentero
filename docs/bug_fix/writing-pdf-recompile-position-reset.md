# 写作模式每次编译后 PDF 跳回开头

**影响面**：写作工作区右侧编译预览（`ProjectPdf`，含 `tex-project-view.tsx` 内嵌的项目编辑面板）；不涉及普通论文阅读的 PDF tab。

## 现象

写作模式下每次编译成功，右侧 PDF 都回到第 1 页、缩放重置为默认适应宽度，正在查看的位置丢失。

## 原因

`ProjectPdf` 把每次编译递增的 `rev` 同时拼进了 `PdfViewer` 的 `key` 和 `docId`：

- 编译成功 → `jobId` 变化 → `buildToken` 变化 → effect 重读 PDF 字节 → `rev + 1`；
- `key` 随 `rev` 变化导致整个 `PdfViewer` 连根 remount；
- 滚动位置快照 `reloadPositionRef`（页码 / zoom / 对齐比例）是 viewer 实例内的 ref，旧实例卸载即丢失；写作模式又没传 `paperRelPath` / `paperAbsPath`，`usePdfNavigation.restore()` 的持久化阅读位置兜底也不生效 → 新实例从第 1 页开始。

而 `embedPdfDocumentId` 本来就为 buffer-backed 文档内置了按 `ArrayBuffer` 身份分配的 `::r<n>` 修订号（见 [pdf-disk-refresh-after-compile.md](pdf-disk-refresh-after-compile.md) 的二次修复）：bytes 换新时 `PdfViewer` 内部的 `EmbedPDF key` 会自然变化、原地重载文档，同时 `reloadPositionRef` 快照存活，`restore()` 检测到 `snapshot.documentId !== docId` 后恢复页码与 zoom。外层再把 `rev` 拼进 key/docId 既重复又有害——key 击穿位置恢复，docId 让 layout store、scroll-sync peer 等跨模块键（`stripEmbedPdfRevision` 只剥 `::r<n>` 尾缀）每次编译都换成新键。

## 修复

`src/components/writing/writing-desk.tsx`：

- `PdfViewer` 的 `key` 改为仅 `pdf.path`（输出 PDF 路径变化才换新 viewer），`docId` 去掉 `:${rev}`，保持 `${instanceId}:${path}` 稳定——与工作区 PDF tab（`doc-view.tsx` 用稳定 `docId={tab.id}` + 原地换 `pdfBytes`）同一范式；
- 顺带移除失去用途的 `PdfState.rev` 字段。

## 回归

无独立自动化用例（remount 与否依赖 React 渲染语义，DOM 测试只能复读实现）。手动验证：

1. 打开写作项目，编译成功后把 PDF 滚到中间页、改一下缩放；
2. 改源码触发重新编译（或点 Recompile / ⌘S）；
3. 编译成功后 PDF 应原地刷新为新内容，页码与缩放保持，不回第 1 页；
4. 切换到其他项目再切回，仍按项目恢复预览。

既有约束由 `test/pdf-document-id.test.ts` 守住（documentId 必须随 buffer 身份变化）。

> 约束：凡是以 `sourceBytes` 喂 `PdfViewer` 的调用方，key / docId 都必须只随"文档身份"（路径、tab id）变化，绝不能随编译轮次或 buffer 读取次数变化；buffer 修订已由 `embedPdfDocumentId` 内建。
