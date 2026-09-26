# Dockview 文档工作区

中间栏由 **单一全局 Dockview** 管理全部打开文档；标题栏**无**文档 tab 条。

## 行为

| 场景 | 行为 |
|---|---|
| 打开文档 | 文件树 / Library / 命令面板 → `openTab` → `workspaceRef.openPanel` |
| Library 常驻 | 打开 Vault 期间 Library tab 始终在标签条（打开、恢复、清空后由 `ensureLibraryTabPresent` 补齐）：不可关闭——无关闭按钮、中键与右键关闭项禁用、「关闭其他/全部」跳过、⌘W 对其 no-op；仅剩 Library 时 ⌘W 关闭窗口。其它 tab 的固定（pin）能力已移除 |
| 首篇 paper | PDF/HTML 默认组 + `NOTES.md` 右分屏（阅读默认；通用设置 `autoOpenPaperNotes` 关闭时只开 body，NOTES 仍可 `⌘\` / 右键「打开笔记」手动开） |
| 再开 paper | body 走自由 dock 放置（当前组 / 默认，可再拖分屏）；NOTES 优先叠进已有笔记列；body↔NOTES **焦点仍同步** |
| 同步关闭 | 关 paper body 时一并关 NOTES；关 NOTES 保留 body |
| 文件树拖入 | left/right/above/below/within 分屏落点 |
| 关 panel | dockview X → `closeTab`；焦点 `onDidActivePanelChange` |
| 循环 | `⌥⌘←/→` 按 `api.panels` **视觉序** |
| 移至新窗口 | 文档 tab **右键** → **移动至新窗口** → 独立 `doc-*` Webview；源 panel 关闭（Library / Trash 除外）；弹出窗自带 Vault watcher，Markdown / PDF 外部改盘就地重载；URL `mode` 参数与主窗口一致参与 PDF 模式保护（探测失败不降级 Markdown） |
| Split pane | `⌘\` / `Ctrl+\` 向右新增 pane；当前论文未开 NOTES 时默认打开 NOTES，否则复制当前 pane；横向 pane 重新等宽 |
| NOTES 开关 | Layout 菜单；优先叠右列。重复打开保持比例；重建标准 PDF / Notes 双列时恢复共用比例，没有记录时使用 Dockview 默认分配 |
| 打开笔记 | 论文 tab 右键 /文件树论文行右键 → NOTES 进右侧阅读列（已开则聚焦；菜单显示 `⌘\` / `Ctrl+\`） |
| 关光文档 | 回到常驻的全库 Library panel |

标题栏 Layout 菜单中的窗口布局预设改变当前论文的 Notes 分屏、外层 Agent panel 和左侧 Vault sidebar：Agent 模式为 PDF / Agent `2:1` 并展开左侧栏，笔记模式关闭左右侧栏并显示 PDF / Notes，阅读模式关闭 Notes、Agent 与左侧栏，只保留 PDF 阅读界面。其它 PDF tab 保持打开。

标签组 chip 的颜色菜单会将展开/收起 icon 染为对应颜色，并同步用于组内 tab 的强调线；清除颜色后恢复默认颜色。

Library 始终位于所在标签条的第一位：禁止拖动 Library 及包含它的整组，其他标签不能拖到它前面。恢复旧布局、打开文档及布局变化时也会校正顺序，校正不会切换当前活动文档。

布局只存 dockview `toJSON()`；path/mode/title 在 panel params。同一路径可存在多个 split pane，panel id 保留 pane 实例后缀用于恢复布局。Tab 条上的论文标题经 `MathText` 渲染内联公式（`$\\pi$` 等）；`panel.api.setTitle` 仍存原始字符串。

活动 panel 为 `papers/` 下的论文 PDF 时，其顶部（Dockview 标签条之下、正文之上）显示面包屑路径条 `papers / 论文标题`：论文目录的 catalog id 段替换为 `paperMeta.title`（缺失时回退 tab title），标题经 `MathText`，文件夹段点击在左侧文件树中定位展开（`setTreeSelectedPath`）。仅在活动 panel 渲染；非 PDF 论文、HTML 版与虚拟标签（Library / 回收站 / 广场）不显示。实现：`src/components/workspace/paper-path-bar.tsx`。

启动恢复只 hydrate 每个 Dockview group 当前可见的 panel；隐藏标签在首次切换到前台时再读取资源。 `papers/` 下的占位标签统一等待文件树加载完成后再 hydrate，不按扩展名猜测文件或目录，避免带点的论文 ID（如 `2606.04046`）被误归属到父级分类目录并触发错误的引用解析；其它笔记与虚拟标签可继续加载。恢复出的占位 tab 直接用 params 里的 title 显示（论文名），无需等资源加载；未携带 title 的旧布局回退为文件夹名，激活后由资源加载刷新。PDFium 保留当前可见与最近使用的至多两个 PDF viewer，本地 PDF `ArrayBuffer` 离开保留集合后释放，避免多标签工作区重启时并发加载全部 PDF 并长期占用 WebContent 内存；重新 hydrate 既有 PDF tab 时只刷新资源，不因一次 PDF 探测失败降级成 Markdown 空编辑器；同一保护（`patchFromTabResources`）覆盖 ⇧⌘T 重开与文档弹出窗。资源侧论文正文只产出 pdf / html（`paperBodyMode`）：探测全空且 catalog bundle / 元数据也落空时先延迟重试一次（启动时 Host catalog 或 fs scope 未就绪的竞态），仍无资源则停在 PDF「暂无论文」空态，绝不渲染空 Markdown 编辑器；paper 文件夹内的子目录按 scoped library 打开，同样不进编辑器。Markdown 编辑器（含 NOTES）与纯文本编辑器同样保活：至多两个最近使用的编辑器保持挂载，切换标签不再重建 Plate / CodeMirror；离开保留集合的编辑器卸载为占位，切回时重新反序列化，卸载时未落盘的编辑会照常 flush。

## 纯文本编辑器（CodeMirror 兜底）

`papers/` 之外的文本文件在专用查看器（PDF / HTML / 图片 / Excalidraw / Markdown）都不命中时，落入 CodeMirror 6 纯文本编辑器（`text` 模式），承担「未知格式兜底查看器」的角色；`papers/` 内部保持原 Markdown 行为不变（paper 域文件不降级为原始文本缓冲）。

| 项 | 方案 |
|---|---|
| 路由 | `preferredModeForPath`：专用扩展名优先，`.md` 显式回 Markdown，`isUnderPapers` 拦截，其余一律 `text`（不设 `isTextOpenable` 白名单门槛——兜底查看器不做过滤） |
| 高亮 | `textLanguageIdForPath`：`json` / `yaml(yml)` / `python(py,pyw)` / `tex(sty,cls)` / `bib`；`.txt` 与未知扩展名为纯文本 |
| 语言实现 | `@codemirror/lang-json`、`@codemirror/lang-python`；TeX 走 `codemirror-lang-latex`（Overleaf Lezer 语法的社区包：精确高亮、环境自动闭合 / 缩进、preamble / 注释 / 小节折叠；`enableAutocomplete` 关闭——它默认装的 `autocompletion({override})` 层会吞掉其他补全源，补全统一经 `basicSetup` 的 autocompletion 调度语言数据；**lint 开启**——波浪线标未闭合环境 / 括号、重复 label、缺失引用等，悬停命令弹文档，`fileName` 让 linter 在 .sty/.cls 上放宽 document-env 规则）；yaml 走 `@codemirror/legacy-modes` StreamLanguage；`.bib` 用内置最小 BibTeX tokenizer（`%{}%` 注释、`@type`、字段、字符串） |
| 代码提示 | TeX / BibTeX 自定义补全经 `language.data.of({ autocomplete })` 挂进语言数据（TeX 为语言包的命令 / 环境 / 数学符号补全 + 文件路径补全；BibTeX 为 `@` 后条目类型、条目内行首字段名）；JSON / Python 用语言包自带补全 |
| 代码检查 | TeX 双层：语言包内建 lint（未闭合环境 / 括号、悬空 `\ref`、重复 label 等，语法树级）+ **chktex** 外部规则集（Overleaf / VS Code LaTeX Workshop 同源，47 条编号警告）——Rust `chktex_lint` 把活动缓冲区经 stdin 喂给本机 chktex（TeX Live 自带，`-I0` 不跟随 `\input`，缺席时返回空、静默降级为仅内建规则），行 / 列 / 命中长度映射回编辑器坐标，消息尾注 `chktex <编号>` 便于行内 `%chktex <n>` 抑制；两层经 lint facet 合并，1s 防抖（facet 取 max，两层同节奏） |
| lint 状态栏 | 编辑器底部（仅 TeX——唯一带 lint 源的模式）按严重度计数：错误（红 `CircleAlert`）/ 警告（amber `TriangleAlert`）/ 提示（sky `Info`）icon + 数字，零计数淡化；计数区即悬停目标，纯 CSS hover 弹出问题卡列表（文档序，icon + 消息 + `L行:C列`，点击选中该 span、滚动并聚焦编辑器）。group 用命名 `group/lint`——编辑器 wrapper 自带裸 `group`（工具栏 hover chrome），裸 `group-hover` 会匹配任意 `group` 祖先导致悬停编辑器任意处弹卡。刷新经 `setDiagnosticsEffect` 监听（lint state 对外私有，该 effect 是公开信号；两源每次 run 合并为单事务）；实现 `text-editor-lint-footer.tsx` |
| 文件路径补全 | TeX 路径参数命令（`\input` / `\include` / `\includeonly` / `\includegraphics` / `\includepdf` / `\includesvg` / `\bibliography` / `\addbibresource`，含 `*` 变体与 `[可选参数]`）的 `{}` 内按需列目录：路径相对当前文件目录解析（latexmk 以 .tex 父目录为 cwd），目录项带尾 `/` 置顶、按命令过滤扩展名（`\bibliography` 去掉 `.bib` 后缀），经 Host 树命令 / SFTP 逐级列出（同文件树忽略规则），带 10s 目录缓存；`validFor` 检测目录前缀变化后重新查询 |
| 换行 | `EditorView.lineWrapping` 全局启用 |
| 主题 | 基础 chrome 走 shadcn CSS 变量（`--foreground` / `--font-mono` / `--muted` …），语法色 light 用默认高亮、dark 用 oneDark，`Compartment` 随 `resolvedTheme` 热切换 |
| 生命周期 | 与 ExcalidrawViewer 同契约：props 播种 + `reloadKey` 信号，内容 / dirty / 800ms 防抖自动保存由编辑器持有，`persistTextFile` 带磁盘冲突守卫与按路径写队列；外部改盘 `reloadKey` bump 后**原地换 doc**（视图、滚动、撤销历史保留，不重挂载） |
| 手动保存 | ⌘S / Ctrl+S：立即 flush 防抖自动保存（跳过等待），成功后触发 `onManualSave`；内容干净时按 ⌘S 仍触发（显式重建），保存被冲突守卫拒绝则不触发。编辑器挂载时经 `registerTextEditorFlusher`（`lib/workspace/text-editor-flush.ts`，lib 层注册表，避免 actions 反向依赖 lazy chunk）注册 flush，卸载自动注销 |
| 划词工具栏 | 非空选区弹出与 PDF 同款的 `SelectionMenu`（portal 到 body 的 fixed 工具栏），只带 **快速对话（⌘K）** 与 **加入对话（⌘L）**：文本文件没有 marks/ 侧车（无高亮/翻译按钮），也**不做选区自动复制**——代码缓冲里选区常是粘贴替换的前奏，静默改写剪贴板会破坏待粘贴内容。拖选在 mouseup 后弹出（同 PDF），键盘选区（⇧ 方向键 / 双击 / ⌘A）即时弹出，滚动时锚点跟随（`coordsAtPos` 客户端坐标）。选区经 `publishSelection`（origin `markdown`，带 1 起始的 `lineFrom` / `lineTo` 行跨度——选区终点恰在行首时不含该行）镜像为 Agent composer 的临时 chip，chip 标签显示 `文件名 7行` / `文件名 12-15行`（行号后缀走 i18n，`composer.selectionChipWithLine(s)`；PDF chip 的 `· p.N` 对应形态），提交 prompt 为 `Selected text from {path} (lines A-B):`；加入对话 = 发布 + `pinActiveSelection` + 打开 Agent 侧栏并折叠选区；快速对话复用 `useSelectionAsk` + `AskPopover`（prompt 走 `buildPlazaAskPrompt` 的 `surface: "text"` 变体）。仅活动面板弹出（keep-alive 的隐藏 pane 不弹）；切走标签即收起工具栏，Ask 线程继续流式。实现：`src/components/viewer/use-text-editor-selection.ts` |
| TeX | 编译**仅手动触发**，目标始终是项目 **root 文件**（多文件项目保存/编译子文件 = 编译 root）：`resolveTexRoot` → Rust `resolve_latex_root` 一次 IPC 检测链 `% !TEX root` magic 注释链（含环检测）→ 自身含 `\documentclass`/`\begin{document}`（剥 `%` 注释后判定）→ vault 反向扫描 `\input`/`\include` 引用闭包（命令名精确匹配排除 `includegraphics` 等、参数相对声明文件目录解析可补 `.tex`、多级链 BFS 向上、跳过 `papers/` 与文件树同套忽略目录、同浅度多候选取字典序最小）→ fallback 编译自身。三个入口（⌘S `compileTexOnManualSave` 静默编译、编译按钮 / ⌘\ `openTexPdf`）触发时先 `flushAllTextEditors` 把**所有**挂载编辑器的防抖内容落盘（saveAll 等价——root 编译要读全部子文件最新字节；best-effort，被冲突守卫拒绝的文件用其盘上快照），再解析 root，故刚敲的 magic 注释 / `\input` 立即生效；无引擎显式报错、非 `.tex` no-op。自动保存（防抖 / 卸载 flush）只写盘**不编译**。PDF pane / 任务行 / 去重键跟 root，文件树 spinner 仍在触发文件行；若 root 的 PDF pane 已打开，编译期间显示 shimmer，完成后以最新 PDF 字节原地刷新；编译中再触发合并为一个尾随编译（尾随时对新盘状态重解析 root）。latexmk 带 `-g`——手动触发即**强制重跑**（每次点编译都是真实构建；失败后未改文件再点编译不再卡在 latexmk「Nothing to do + previous invocation error」的指纹库复读态）。引擎下拉里「清除中间产物」（`cleanTexAuxFiles` → 同样先解析 root → Rust `clean_latex_aux_files` → 对 root 跑 `latexmk -c`，其指纹库覆盖子文件产物）清掉 `.fdb_latexmk` / `.aux` 等可再生产物（**保留 PDF**），彻底归零磁盘构建状态；编译进行中 no-op。实现：`src-tauri/src/features/compile/root.rs` |
| 接入 | 懒加载 chunk（`doc-view.tsx` 分支）；dockview `renderer: 'always'` + 编辑器 LRU 保活；弹出窗 watcher / 会话恢复 / `applyDiskChange` 均已覆盖 `text` 模式 |

## 面板类型

Library · Trash · PDF · HTML · 图片 · Markdown · 论文 NOTES · 纯文本（CodeMirror）。

## 代码

| 路径 | 职责 |
|---|---|
| `src/components/workspace/dock-workspace.tsx` | Dockview 宿主（tab 右键 → 移至新窗口） |
| `src/components/workspace/paper-path-bar.tsx` | 活动论文 PDF 的 `papers / 标题` 面包屑路径条 |
| `src/lib/shell/leaf.ts` | leaf 打开 / `moveDocToWindow` |
| `src/lib/shell/doc-window.ts` | `doc_window_open` 前端封装 |
| `src/components/shell/doc-window-root.tsx` | 文档弹出窗根 |
| `src/components/viewer/text-editor.tsx` | CodeMirror 纯文本编辑器（`text` 兜底模式） |
| `src/components/viewer/text-editor-lint-footer.tsx` | TeX 编辑器 lint 状态栏（严重度计数 + 悬停问题卡 + 点击跳转） |
| `src/components/viewer/use-text-editor-selection.ts` | CodeMirror 选区 → 划词工具栏（快速对话 / 加入对话） |
| `src/components/viewer/text-editor-language.ts` | 扩展名 → 语言 / 自定义补全映射 |
| `src/lib/workspace/text-editor-flush.ts` | 编辑器防抖自动保存的 flush 注册表（编译按钮编译前落盘） |
| `src/lib/workspace/store.ts` | tabs / active / dockLayout |
| `src/lib/workspace/tabs/` | DocTab 模型、NOTES 分屏、持久化 |
| `src/lib/workspace/dock-registry.ts` | 命令式 dockview 句柄 |

PDF 分屏拖动性能：见 `docs/bug_fix/dockview-sash-pdf-resize-jank.md`。
