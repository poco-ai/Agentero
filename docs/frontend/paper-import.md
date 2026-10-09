# 入库 UI

前端入库入口与后置动作（刷树、开 paper、任务条）。落盘内核见 [../backend/paper-import.md](../backend/paper-import.md)。

## 魔棒

- 入口：侧栏 `WandSparkles` / `⇧⌘I`。
- 粘贴一个或多个论文标识符、Skill 来源，或直接输入论文标题（按逗号/分号/换行分隔；空格不再分隔，留给标题与 `npx skills add …`）；去重后顺序处理。
- 目标：`papers/` 或当前选中的 Papers 子文件夹。
- 弹层内 **FileUp**：多选本地 PDF。
- 本地 PDF 命中已有条目（按识别出的标识符去重）时不新建论文：PDF 合入原条目（缺主 PDF 时成为主 PDF，否则进 `attachments/`），Toast 提示「已将 PDF 合入已有条目」（#406）。
- 成功后：局部刷新 `papers/` 子树、Wiki、Library；**不**自动打开论文（并行入库时抢焦点会让文件树反复跳转），批量也**不**自动连跑精读。
- 同一条 identifier lookup 管线可由其它入口复用（References 面板、Plaza 入库、Zotero 迁移）。
- 调度：每个输入一个 JobCenter `import` job（Normal lane；并发取 `batchImportConcurrency`；`params` = `mode` + 来源标识并参与去重，同一 URL 不重复入队）。编排仍在渲染端执行器（`src/lib/paper/import/import-tasks.ts` 按 `params.mode` 分发），job id 兼作 Host `task_id`：字节进度经 `job:progress` 写回投影行，协作取消查 JobCenter 按 task id 索引的 cancel token。
- Host：`lookup_import_batch` 等。

## References 侧栏导入

- 入口：打开论文后的右侧 **References** 面板，未入库引用卡片上的 Import 按钮。
- 复用魔棒 identifier lookup 管线（与其它入口一样，入库后不打开新论文）。
- 成功后：刷新 Vault 树、Wiki 索引、Library，并重解析当前论文 references 以更新 `localMatch`；当前阅读的论文保持打开。

### 标题搜索

- 输入识别不到标识符时自动走标题/关键词搜索（Semantic Scholar 与 arXiv **并行**发起，5s 预算内 S2 非空优先，见 [../backend/identifier-lookup.md](../backend/identifier-lookup.md) § 3.4）。
- 前端对疑似标题的输入**立刻**弹出单选窗并显示 shimmer 占位（#438）；Host 返回后替换为 Top 3 候选：标题、作者 · 年份 · 出处、arXiv/DOI 徽标与被引数。长标题在卡片内换行，不撑破对话框。
- 确认后按候选的标识符走常规入库管线，落回发起搜索时的目标文件夹。
- 取消/关闭卡片会同时取消仍在进行的后台搜索任务：任务卡立即标记已取消，Host 跳过剩余查询；候选直接丢弃，无 Vault 侧临时态需要清理。
- 一次粘贴多个标题时按队列逐个弹窗，处理完一个自动显示下一个。
- 无匹配结果时关闭 pending 弹窗，走错误 Toast。

### Skill 导入

- 支持 GitHub 仓库 URL，以及 `npx skills add <source> --skill <name>`。
- Skill 解析后先弹出多选窗口，展示名称、描述、来源和已安装状态；只有点击确认后才安装到 `.agents/skills/<name>/`，并保留 `SKILL.md`、`scripts/`、`references/`、`assets/`。
- 取消窗口会删除本次解析产生的临时 discovery，不会修改 Vault。
- 已存在的 Skill 不覆盖；成功后仅刷新树并显示汇总 Toast，不打开 paper。
- 远程 Vault 当前不支持 Skill 导入。

## 本地 PDF

| 方式 | 行为 |
|---|---|
| 魔棒 FileUp | 多选 → `paper_import_local_pdf` **即时导入**（秒级，文件名元数据占位）；任务条随后出现 per-paper 的「识别论文元数据」行（可取消） |
| 拖到 `papers/` 组织夹 | 直接后台导入（无确认对话框），同上；识别完成后目录自动改名为规范 id（如 `papers/1706.03762`），树/库/tab 路径无缝迁移 |
| 拖到 Library 表 | 仅一个或多个 PDF 时显示虚线 overlay；松手后直接后台导入。目标：当前文件夹作用域，或全库时的树选中 Papers 夹 / `papers/`（[#309](https://github.com/poco-ai/Agentero/issues/309)） |
| 拖到窗口其它区域 | 按当前 Papers 目标目录直接后台导入；识别元数据、重命名和版面分析继续在后台运行 |

- Linux 主窗口启用 Tauri 原生 GTK 文件拖放，复用 Library / 文件树 / 全局落点的原生路径处理，避免 WebKitGTK 在 Files（Nautilus）拖入时提供空 `dataTransfer.files`（[上游回归](https://bugs.webkit.org/show_bug.cgi?id=323277)）。窗口配置在 Host 启动时按平台调整；Windows/macOS 保持 HTML5 拖放配置。Linux 内部文件树移动、tab 拖拽仍走 HTML5。
- 即时导入：`paper_commit` 立刻复制 PDF + 建目录 + 落 catalog，`paper:imported` 让论文马上出现在树/论文库；`RecognizeMetadata` job 在后台跑识别链路（见 [../backend/paper-import.md](../backend/paper-import.md)），返回值 `recognizePending=true` 时前端跳过自己的 layout enqueue（runner 统一在改名后编排 PAPER.md / refs / layout）。
- 识别落地：改名/合并通过 `paper:renamed` 事件通知前端 —— handler 抑制 watcher 的外部 rename 修复（`trackInternalRenamePaths`）、remap 打开的 tab/标注、定向刷新树（新旧两个路径）与 Library；`outcome=merged` 时 Toast「识别后的 PDF 已合入已有条目」。仅元数据更新走 `job:changed` 终态 → Library 刷新，树行标签随 `paperMetaByRelPath` 自动更新。
- PDF 解析最多等待 120 秒，取消任务会终止当前解析子进程。解析失败或超时时，后台入库任务仍会结束，已复制的 PDF、`NOTES.md` 与 catalog 记录保持可用；用户可稍后通过 CLI `paper parse` 重试派生正文。

## Zotero

| 入口 | 说明 |
|---|---|
| 欢迎页迁移 | 读 `zotero.sqlite` + `storage/` 整库迁移 |
| Connector | 设置开启后浏览器扩展保存；见 [../backend/connector.md](../backend/connector.md)、[../usage/zotero.md](../usage/zotero.md) |

## 补资源 / 精读触发

- Download：缺 PDF 或无正文资源时。
- 手动精读 / 自动精读：见 [agent.md](agent.md)。

## 代码

- `src/lib/paper/lookup.ts`、`import-actions.ts`、`import/`
- `src/components/sidebar/` 魔棒 Popover
- `src/components/dialogs/paper-search-dialog.tsx` 标题搜索候选单选窗
- `src/components/library/library-pdf-drop-surface.tsx` Library 拖入
