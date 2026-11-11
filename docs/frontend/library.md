# 论文库 Library

中间栏 catalog 表格；数据一次 `paper_list` 进内存。

## 外观

- 画布用 `bg-background`（与侧栏 `bg-sidebar` 分层）；表头 sticky 半透明 + `backdrop-blur`（滚动边缘用 soft shadow，非硬分割线）；行间 hairline `border-border/40`，悬停 `accent` 浅洗。
- 配色跟默认主题 token，见 [settings.md](settings.md)「主题」。

## 视图

- 虚拟路径 `agentero:library`（不写盘）。
- **全库**：点 `papers/` 论文库节点（根文件夹）或关光文档后默认页。
- **文件夹作用域**：单击 `papers/` 下非 paper 叶目录（如 `papers/nlp`）→ 同一 Library panel 上按 `paper.path` **前缀过滤**（不新开 tab、不重新 RPC）。
- **非 papers 目录**（`notes/`、`.agents/`、`plans/` 等）：只展开/折叠并选中文件树行，不切换当前视图，也不改变 Library 作用域。
- 外部 CLI / 同步工具改动 `.agentero/catalog.sqlite` 或 `papers/` 结构时，前端会后台去抖重新 `paper_list`，同步 Library 表格与文件树论文标题。
- NOTES 仅选中**具体论文**时出现；Paper Info 在选中论文时显示，或在 Library 中**悬停行 180ms** 后预览该论文（不打开即可查看）。离开行、移入 Info 或滚动列表时保留最近一次预览；短暂经过其他行不会切换，Info 内输入及展开菜单期间不替换预览。切换文件夹、离开 Library、切换 Vault 或预览论文被过滤/移除时清除；返回 Library 不恢复旧预览。已打开论文的 Info 继续跟随当前论文。

## 表格能力

论文标题在 Library、Paper Info、文件树、论文标签页、路径栏、回收站与移动端列表中共用 `PaperTitle`：支持来源元数据中的 HTML 斜体（`i` / `em`）、粗体（`b` / `strong`）、上下标（`sup` / `sub`）及 `u` / `s` / `small`，并解码 HTML 实体。渲染前用 DOMPurify 限定行内标签、移除所有属性及活动内容，再由 [html-react-parser](https://github.com/remarkablemark/html-react-parser) 转为 React 节点，通过公开的 `replace` 回调将含 TeX 的文本交给现有 `MathText`，保留嵌套公式与截断行为；不自行实现 HTML 解析或节点递归转换。普通标题绕过 HTML 解析，格式化结果按标题 memo。仅影响展示；catalog、元数据编辑和复制继续保留原始标题（含 HTML / TeX）。普通文件名不按 HTML 标题解析。

| 能力 | 说明 |
|---|---|
| 排序 | 表头点击；发表日期 / 添加日期 / 被引数默认新→旧（高→低），文本列升序。日期列按 `YYYYMMDD` 数值键排序，未披露的月/日补 `0`（年份粒度排在该年已披露日期之前），无日期无年份的行排最后（降序）；添加日期按 catalog `added_at` 的完整时间戳排序（识别时区），空值/非法值降序置后，同值按标题和 id 稳定排序；排序/标签筛选变化时行区 150ms 淡入提示重排（搜索键入不触发） |
| 搜索 | 表头搜索框匹配标题、作者、catalog id、展示 identifier、vault path、DOI、arXiv、PMID、ISBN、期刊/出版物、出版社和可见标签。拖入 PDF 后即使标题被识别改名，也可用文件夹 id / DOI 找回 |
| 列 | 表头右键选列 / 拖拽排序；拖动表头右边缘调整列宽，聚焦边缘后左右方向键每次调整 `1rem`，Esc 取消拖动；首次调整将当前可见列的宽度固定并以 `widthRem`（`5–120rem`）随设置保存，松手时才写入 Host，重启后保留；未调整的布局及后启用的无宽度列按权重自适应，窄窗口横向滚动；右键「重置列」恢复默认宽度、顺序和显隐；顺序+显隐经 Tauri Host 持久化 `libraryColumns`（前后端列集合与默认显隐保持一致）；标题列不可隐藏；添加日期列默认隐藏，可在表头右键菜单启用，按本地时区显示 `YYYY-MM-DD`、悬停显示完整时间；升级保留原有列的顺序与显隐；标题单元格对 `$...$` / `\\(...\\)` 做 KaTeX 内联渲染（复制仍为原始 TeX）。日期列显示 `YYYY` / `YYYY-MM` / `YYYY-MM-DD`（精度随元数据），无 `date` 时回退 `year`；旧设置里的 `year` 列键在加载时原地改名为 `date` |
| 滚动 | 横向 + 纵向；滚动中表头控件瞬间隐藏为纯列名（搜索框与刷新/筛选等图标，固定 `h-9` 行高与占位不变；当前排序列仍保留方向箭头；有标签筛选时 Tags 列名旁留小圆点），停滚约 450ms 后淡入恢复（入 300ms） |
| tags | 只展示用户标签（染色 chip）；搜索框仍匹配全部可见标签与 publication。`@zotero:` / `@arxiv:` 内部标签不显示；`#submitted:` / `#easyscholar:` 是 Host 写入的投影，不在 Tags 列展示，由「发表 / 投稿」列消费 |
| 发表 / 投稿 | 原 Publication 列。单元格由 `publication`、`#submitted:` 和 `#easyscholar:` 聚合：真实 publication → 「已发表」+ venue 名 + 指标；仅有 `#submitted:` → 「投稿」+ 目标 + 「模板推断」；仓库类 publication（arXiv/bioRxiv 等）→ 「预印本」+ 仓库短名。支持双击复制完整值 |
| 阅读热力 | 标题列左侧显示该论文阅读进度热力条；基于 `marks/` 中逐页标注与阅读位置聚合。激活 Library 时经 `paper_reading_activity_batch` 一次批量 IPC 刷新全部活动点（缓存保温，不再逐论文 3 次 IPC）；PDF 页数走 catalog `pdf_page_counts` 缓存，缺缓存时仅对可视行懒加载并回写 |
| Rescan | 右键左侧 `papers/` 论文库节点 →「重新扫描 papers/」；空库仍保留中央按钮，扫描期间禁用重复操作。`paper_rescan` 补齐盘上有、catalog 无的论文目录，并修复旧 `id=paper` 本地条目；不负责导入任意裸 PDF |
| 行右键 | 打开 / 编辑元数据（远程 Vault 隐藏编辑项）/ 添加到对话 / 在 Finder 中显示（仅本地）/ 删除；单击打开、双击复制。文件夹还在时整夹进回收站并去掉 catalog 行；文件夹已经没了（列表上仍可能显示「本地无 PDF」）时直接去掉 catalog 行，论文从库里消失 |
| 多选 / 批量 | **选择模式**：平时表格与以前完全一致（没有复选框、不额外占列宽）。在表格内按住左键拖出矩形选框（移动超过 4px 才进入框选）即进入选择模式——表头出现三态全选框、每行左侧出现复选框，覆盖到的行被选中；此时单击行是勾选 / 取消勾选而**不再打开论文**（双击复制单元格、右键菜单不受影响），⌘/Ctrl 拖动为追加。清空选择（Esc、点击表格空白处、或取消最后一个勾选）即退出选择模式，复选框与列宽一起消失。全选只作用于**当前筛选与作用域内的可见行**（搜索、标签筛选、文件夹作用域都算）；搜索 / 筛选 / 作用域变化或论文被删除后，已隐藏的行自动从选中集合剔除，避免误删看不见的论文。⌘/Ctrl 点击切换单行并进入选择模式，Shift 点击按当前排序范围选择；⌘A 全选、Delete 移入回收站（输入框、弹窗和打开中的菜单里不触发）；框选期间暂停悬停预览，靠近上下边缘自动滚动。右键已选行显示批量菜单（添加到对话 / 复制到文件夹 / 下载缺失 PDF / 删除 N 篇 / 清除选择），选中时视图底部浮出操作条；未选中时右键仍走原菜单。「复制到文件夹…」把选中的论文文件夹完整复制到 `papers/` 下任一目录（也可当场新建目录）：副本有独立的 catalog 行与页数缓存，源论文的双链、`is_read` 和标签互不影响；目标已存在时只跳过该篇并汇总提示 |
| Download | 库内任一篇缺资源时批量补下 |
| 导入/导出 | Library 工具栏；导出 BibTeX 亦可在 `papers/` 论文库节点右键 |
| 发现引用 | `papers/` 论文库节点右键「发现引用我的新论文」→ 后台扫描全库反向引用 → 候选清单勾选入库；见 [../backend/citation-parsing.md](../backend/citation-parsing.md) §7 |
| 拖入 PDF | Finder / 其它 App 把一个或多个 PDF 拖到 Library 表：虚线 overlay（仅 PDF），松手后直接后台导入。文件夹作用域导入到当前 `papers/…`；全库则落到树选中的 Papers 夹（否则 `papers/`）。Host lifecycle 事件会触发表格刷新；前端导入 job 成功后也会主动 `refreshLibrary()` 兜底，避免事件延迟时新论文短时间不可见。识别、重命名和版面分析在后台继续；非 PDF 不显示 overlay、不入库 |

页数懒探测复用 headless PDF engine，但每次使用独立 registry 和唯一文档 ID；成功、失败或读到空页数都会在 `finally` 中尝试关闭本次文档并销毁 registry，等待清理后返回。显式关闭失败后仍尝试 registry teardown；不销毁共享 engine，也不关闭其他探测或后台版面分析的文档，避免热力图逐篇补页数时累积 PDF 文档和字节缓冲。

## Tags（前端）

- Paper Info 增删 + Apple 8 色色盘 → `paper_set_tags`。Library 与 Paper Info 点击已有标签可修改颜色或恢复无色；色盘支持键盘焦点、Enter/Space 选择与 Escape 关闭。颜色按当前论文保存，不改变其他论文的同名标签。
- 系统命名空间（`#submitted:`、`#easyscholar:`）只由 Host 写入。前端不生成、不编辑、不删除；Paper Info 的标签编辑器只列出用户标签，提交时原样保留系统投影。
- `@zotero:` 前缀标签属于 Connector 来源标记，只保留在 catalog 中，不参与展示、搜索和筛选；编辑普通标签时会保留这些内部标签。arXiv 学科分类（`@arxiv:` 前缀或同形遗留标签）同样按内部隐标签处理。
- `publication` 是唯一权威 venue 字段。`#venue:` 已废弃：不再写入，前端立即隐藏遗留标签，Host 同步时从 catalog 清理。
- `#submitted:` 是 arXiv LaTeX 模板推断的投稿目标（不是学术 API 字段），由 Host 的 `paper::venue::sync` 维护；一旦存在真实 `publication` 就删除。UI 在「发表 / 投稿」列显示为「投稿」并注明「模板推断」。
- EasyScholar Key 配置后，表头「同步出版信息」会在元数据刷新后调用 Host 的 `paper_sync_publication`：后端用 `publication` 查询 EasyScholar、解析指标并写入 `#easyscholar:`（IF / IF5 / JCI / 分区），不再生成 `journal=` 标签。等级支持 SCI、SSCI、EI、CSSCI、北大中文核心、CCF，以及经管类 FMS 和 UTD24；FMS 保留 API 返回的等级（如 `A(T1)`），UTD24 收录标记显示为 `UTD24`。已有同名标签的颜色会被保留；publication 变化时旧指标立即失效并在下次同步重拉。网络失败时保留已有指标。
- 表头只有一个「同步出版信息」按钮（「发表 / 投稿」列），Tags 列只保留用户标签筛选；分组操作（单独刷新元数据 / venue / 分区）不再暴露。
- 标签类型与语义（normalize / coerce / 可见性）：`src/lib/paper/tags.ts`（类型在 `src/lib/paper/types.ts`）；命名空间判定：`src/lib/paper/tag-namespaces.ts`；色板映射：`src/lib/ui/tag-colors.ts`。
- CLI 标签见 [../backend/catalog.md](../backend/catalog.md)。

## 自定义属性列（Select / Text）

表头右侧 `+`（或表头右键菜单）新建自定义属性列；创建时在对话框里选类型，类型创建后不可更改（切换会作废已有取值）：

| 类型 | 取值 | 单元格 |
|---|---|---|
| Select（单选） | `option_id` | 点击弹出搜索面板：选已有选项、输入即建新选项（可配色）、删除选项、清除值 |
| Text（文本） | 自由文本（trim 后 ≤ 2000 字符） | 点击原地输入，Enter / 失焦提交，Esc 取消；空值等于清除 |

- 两种类型共用 `papers.custom_props_json` 的 `property_id -> string` 映射，取值语义由属性定义的 `type` 决定，因此新增类型不需要 schema 迁移。
- 列宽 / 显隐 / 顺序与内置列一致走 `libraryColumns`（`prop:<id>` 键）；属性删除时同步清理偏好与全部论文取值。
- 排序在内存里就地做：Select 按选项名、Text 按原文小写比较，空值排最后（见 `library-row-utils.ts`）。
- 定义落盘 `.agentero/properties.json`，取值随 `PaperRecord` 投影到 `{paper}/metadata.json`。后端语义见 [../backend/catalog.md](../backend/catalog.md)。

## 编辑元数据

误识别/缺失的论文元数据可手动修正，三个入口共享同一对话框（`edit-paper-meta-dialog.tsx`，挂在 `app-dialogs.tsx`，经 `libraryStore.editMetaDraft` 打开）：

- Paper Info 面板头部铅笔按钮；
- Library 表格行右键"编辑元数据"；
- 文件树论文行右键"编辑元数据"。

核心字段（标题/作者/日期/DOI/arXiv/期刊）直接展示，卷期页、出版社、摘要、URL、代码仓库（`code_repo`）和 OpenReview 链接（`openreview_url`）折叠在"更多字段"。`code_repo` 在主 PDF 入库时若为空且用户没改过，按摘要、首页脚注、文末的顺序自动填入论文自己的 GitHub 仓库，参考文献里的仓库不写入；已经在库里的论文在下一次打开时补扫一次。手改或清空后不再自动覆盖。`openreview_url` 仅手动填写，无自动查找。作者每行一位；日期接受 `YYYY` / `YYYY-MM` / `YYYY-MM-DD`（也容忍 `2017-06-12T00:00:00Z`、`Spring 2017` 这类松散串，由 Host 规范化），年份由日期派生；仅提交变更字段（patch）→ `paper_update_meta` → 返回完整记录替换 Library 与打开 tab 的 metadata（`paperMetaChange`，仅保留列表的 `has_pdf` 探测结果），确保清空的可选字段立即移除。OpenReview 字段可设置或清空，保存后在 Paper Info 链接区展示；标识符刷新保留该手工值，有效 HTTP(S) 地址才展示按钮。远程 Vault 暂不支持，入口隐藏。后端语义见 [../backend/catalog.md](../backend/catalog.md)。

DOI 旁有 **刷新** 按钮：按当前 DOI（或 arXiv ID）拉取权威元数据（`paper_resolve_identifier` → Translator/Crossref/arXiv Atom，再用 S2 `publicationVenue` 补期刊/会议名），只填充表单供确认，保存仍走 patch。venue 源优先级见 [../backend/academic-search-apis.md](../backend/academic-search-apis.md) §2.5。

## 导入 PDF 识别

本地文件名派生 ID 保留中文等 Unicode 字母与数字；无可用字符时使用名称的稳定短哈希，全库同名本地 ID 冲突时追加后缀（原地自动入库用路径短哈希，分配新目录的文件导入用编号）。Library 不会仅因无 DOI/arXiv 的本地 PDF 同名而隐藏条目。读取列表及 Rescan 会修复旧 ASCII slug 遗留的 `id=paper`，同时通过持久 sidecar 队列写回 `metadata.json`，不移动目录、PDF、笔记或标注（#937）。

拖入/魔棒导入 PDF 直接进入后台导入任务，无确认对话框；识别链路（liteparse probe → Zotero recognizer → 标识符解析，见 [../backend/paper-import.md](../backend/paper-import.md)）在导入任务内自动补全：

- 识别成功自动填充 标题/作者/日期/DOI/arXiv ID，文件夹 id 按 arXiv ID → DOI slug → 文件名 slug 自动派生；
- 识别失败静默回退文件名派生元数据，用户在 Edit Metadata 中修正（DOI 旁刷新按钮拉取权威元数据）。

## 代码

- UI：`src/components/library/`（拖入：`library-pdf-drop-surface.tsx`；自定义属性：`custom-property-dialogs.tsx` / `select-cell.tsx` / `text-cell.tsx`）
- 状态：`src/lib/paper/library-store.ts`、`library-actions.ts`、`import-actions.ts`（`dropLocalPdfs`）
- 单测：`test/library-scope.test.ts`、`test/prompt-image.test.ts`（`dataTransferLooksLikePdfs`）、`test/pdf-page-count.test.ts`（真实 EmbedPDF registry / 插件 + 跟踪文档和缓冲所有权的 engine 替身：重复探测、并发隔离、初始化与打开失败、页数读取异常和关闭重试；不以 WASM heap 缩小作为释放判据）
- 原生资源回归：`test/pdf-page-count-native.test.ts` 使用安装的 PDFium WASM 和内存生成的三页 PDF，验证 32 次串行、8 次并发探测及损坏 PDF 后的文档缓存、受跟踪分配数量与字节数回到基线；WASM 从本地依赖经 data URL 加载，无网络或真实 Vault 依赖。
