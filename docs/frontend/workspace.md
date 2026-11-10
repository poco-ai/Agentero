# Dockview 文档工作区

中间栏由 **单一全局 Dockview** 管理全部打开文档；标题栏**无**文档 tab 条。

命令式操作契约统一定义在 `lib/workspace/dock-registry.ts` 的 `DockHandle`；组件导出的 `DockWorkspaceHandle` 是其类型别名。

`components/workspace/dock-layout.ts` 集中维护落点映射、面板放置、栏宽调整及布局恢复后的面板对账；`dock-workspace.tsx` 保留 Dockview 注册副作用、React 挂载和事件接线。

## 行为

| 场景 | 行为 |
|---|---|
| 打开文档 | 文件树 / Library / 命令面板 → `openTab` → `workspaceRef.openPanel` |
| CLI 工作区操作 | `agentero ui open/close/window`、`agentero paper open` / `agentero://ui?action=…` → Host `ui:request` → 需要时先切换 Vault → 调用与 UI 相同的 `openPaper` / `openVaultRel` / `closeTabsUnderPath` / 原生窗口打开 |
| Library 常驻 | 打开 Vault 期间 Library tab 始终在标签条（打开、恢复、清空后由 `ensureLibraryTabPresent` 补齐）：不可关闭——无关闭按钮、中键与右键关闭项禁用、「关闭其他/全部」跳过、⌘W 对其 no-op；仅剩 Library 时 ⌘W 关闭窗口。其它 tab 的固定（pin）能力已移除 |
| 首篇 paper | PDF/HTML 默认组 + `NOTES.md` 右分屏（阅读默认；通用设置 `autoOpenPaperNotes` 关闭时只开 body，NOTES 仍可 `⌘\` / 右键「打开笔记」手动开） |
| 再开 paper | 已是「论文 \| 笔记」左右两栏时，body 固定进左栏、NOTES 固定进右栏（与当前焦点在哪一栏无关，#785）；其它布局 body 走自由 dock 放置（当前组 / 默认，可再拖分屏），NOTES 优先叠进已有笔记列；body↔NOTES **焦点仍同步** |
| 同步关闭 | 关 paper body 时一并关 NOTES；关 NOTES 保留 body |
| 文件树拖入 | left/right/above/below/within 分屏落点 |
| 关 panel | dockview X → `closeTab`；焦点 `onDidActivePanelChange` |
| 循环 | `⌥⌘←/→` 按 `api.panels` **视觉序** |
| 移至新窗口 | 文档 tab **右键** → **移动至新窗口** → 独立 `doc-*` Webview；源 panel 关闭（Library / Trash 除外）；弹出窗自带 Vault watcher，Markdown / PDF 外部改盘就地重载；URL `mode` 参数与主窗口一致参与 PDF 模式保护（探测失败不降级 Markdown） |
| 复制路径 | 文档 tab **右键** → **复制路径**。剪贴板用 `displayPath`（Windows 去掉 `\\?\` 前缀）。Library / Trash / 广场和 `agentero:` 虚拟路径不显示该项 |
| Split pane | `⌘\` / `Ctrl+\` 向右新增 pane；当前论文未开 NOTES 时默认打开 NOTES，否则复制当前 pane；横向 pane 重新等宽 |
| NOTES 开关 | Layout 菜单；优先叠右列。重复打开保持比例；重建标准 PDF / Notes 双列时恢复共用比例，没有记录时使用 Dockview 默认分配 |
| 打开笔记 | 论文 tab 右键 /文件树论文行右键 → NOTES 进右侧阅读列（已开则聚焦；菜单显示 `⌘\` / `Ctrl+\`） |
| 切换笔记 | 已有 Notes 列时，从文件树或链接打开另一篇论文笔记（`papers/**` 下的 Markdown）默认**原位替换**当前 Notes 面板：保留分栏位置与宽度、不新增 tab；目标笔记已在别处打开时只聚焦它（#738） |
| 关光文档 | 回到常驻的全库 Library panel |

标题栏 Layout 菜单中的窗口布局预设改变当前论文的 Notes 分屏与外层 Agent panel，与左侧 Vault sidebar 解耦：Agent 模式与笔记模式均不强制或更改左侧栏展开/收起状态（开启布局时左侧栏保持原状，开关左侧栏也不退出该布局）。Agent 模式配置 PDF / Agent 栏宽并关闭笔记分屏，笔记模式折叠右侧栏并开启 PDF / Notes 分屏。阅读模式折叠左右栏并最大化**当前 Dockview 活动分组**（`maximizeGroup`），多栏 / 多标签下都只显示当前正文；其它分栏与标签不关闭，退出阅读模式时恢复进入前的布局与侧栏状态（#764）。

标签组 chip 的颜色菜单会将展开/收起 icon 染为对应颜色，并同步用于组内 tab 的强调线；清除颜色后恢复默认颜色。

Dockview 保持 7.0.4，以保留当前免费模块提供的 `Ctrl+M` 键盘停靠；v8 将该能力移入商业模块，不能直接升级替代现有行为。外部拖拽退出工作区时，由 `dockview-core` 的小型生命周期补丁清理 overlay 及内部引用，不再按 `.dv-*` 类名从应用侧删除 DOM。回归测试使用真实 Dockview，覆盖退出后再次拖入、子元素间移动及外部拖拽结束不会误接受 drop。pointer 拖拽取消保护、首次隐藏面板定位和 resize 节流仍服务当前版本。

Library 始终位于所在标签条的第一位：禁止拖动 Library 及包含它的整组，其他标签不能拖到它前面。恢复旧布局、打开文档及布局变化时也会校正顺序，校正不会切换当前活动文档。

布局只存 dockview `toJSON()`；path/mode/title 在 panel params。同一路径可存在多个 split pane，panel id 保留 pane 实例后缀用于恢复布局。Tab 条上的论文标题经 `MathText` 渲染内联公式（`$\\pi$` 等）；`panel.api.setTitle` 仍存原始字符串。

活动 panel 为 `papers/` 下的论文 PDF 时，其顶部（Dockview 标签条之下、正文之上）显示面包屑路径条 `papers / 论文标题`：论文目录的 catalog id 段替换为 `paperMeta.title`（缺失时回退 tab title），标题经 `MathText`，超宽逐级 `min-w-0 truncate`。文件夹段 **悬停** 弹出其子项候选（论文目录显示 catalog 标题，超过 50 项截断），点击候选经 `selectFileNode` 跳转（论文开 PDF、普通文件夹进 scoped Library、文件直接打开）；**点击文件夹段本身** 进入该文件夹对应的 scoped Library，`papers` 段进入主 Library（`selectLibrary`）。仅在活动 panel 渲染；非 PDF 论文、HTML 版与虚拟标签（Library / 回收站 / 广场）不显示。实现：`src/components/workspace/paper-path-bar.tsx`。

启动恢复只 hydrate 每个 Dockview group 当前可见的 panel；隐藏标签在首次切换到前台时再读取资源。 `papers/` 下的占位标签统一等待文件树加载完成后再 hydrate，不按扩展名猜测文件或目录，避免带点的论文 ID（如 `2606.04046`）被误归属到父级分类目录并触发错误的引用解析；其它笔记与虚拟标签可继续加载。恢复出的占位 tab 直接用 params 里的 title 显示（论文名），无需等资源加载；未携带 title 的旧布局回退为文件夹名，激活后由资源加载刷新。PDFium 保留当前可见与最近使用的至多两个 PDF viewer，本地 PDF `ArrayBuffer` 离开保留集合后释放，避免多标签工作区重启时并发加载全部 PDF 并长期占用 WebContent 内存；重新 hydrate 既有 PDF tab 时只刷新资源，不因一次 PDF 探测失败降级成 Markdown 空编辑器；同一保护（`patchFromTabResources`）覆盖 ⇧⌘T 重开与文档弹出窗。资源侧论文正文只产出 pdf / html（`paperBodyMode`）：探测全空且 catalog bundle / 元数据也落空时先延迟重试一次（启动时 Host catalog 或 fs scope 未就绪的竞态），仍无资源则停在 PDF「暂无论文」空态，绝不渲染空 Markdown 编辑器；paper 文件夹内的子目录按 scoped library 打开，同样不进编辑器。Markdown 编辑器（含 NOTES）与纯文本编辑器同样保活：至多两个最近使用的编辑器保持挂载，切换标签不再重建 Plate / CodeMirror；离开保留集合的编辑器卸载为占位，切回时重新反序列化，卸载时未落盘的编辑会照常 flush。

## 纯文本编辑器（CodeMirror 兜底）

`papers/` 之外的文本文件在专用查看器（PDF / HTML / 图片 / Excalidraw / Markdown）都不命中时，落入 CodeMirror 6 纯文本编辑器（`text` 模式），承担「未知格式兜底查看器」的角色；`papers/` 内部保持原 Markdown 行为不变（paper 域文件不降级为原始文本缓冲）。

| 项 | 方案 |
|---|---|
| 路由 | `preferredModeForPath`（注册表 `matchesPath` 表序驱动，见「文档类型注册表」）：专用扩展名优先，`.md` 显式回 Markdown，`isUnderPapers` 拦截，其余一律 `text`（不设 `isTextOpenable` 白名单门槛——兜底查看器不做过滤） |
| 高亮 | `textLanguageIdForPath`：`json` / `yaml(yml)` / `python(py,pyw)` / `tex(sty,cls)` / `bib`；`.txt` 与未知扩展名为纯文本 |
| 语言实现 | `@codemirror/lang-json`、`@codemirror/lang-python`；TeX 走 `codemirror-lang-latex`（Overleaf Lezer 语法的社区包：精确高亮、环境自动闭合 / 缩进、preamble / 注释 / 小节折叠；`enableAutocomplete` 关闭——它默认装的 `autocompletion({override})` 层会吞掉其他补全源，补全统一经 `basicSetup` 的 autocompletion 调度语言数据；**语言包 lint 关闭**——检查统一使用 ChkTeX，悬停命令弹文档，`fileName` 让 linter 在 .sty/.cls 上放宽 document-env 规则）；yaml 走 `@codemirror/legacy-modes` StreamLanguage；`.bib` 用内置最小 BibTeX tokenizer（`%{}%` 注释、`@type`、字段、字符串）+ **Google Scholar 跳转**：hover / 光标落在条目内时，条目首行右侧出现学士帽按钮（打开文件即显示首条，光标所在条目优先），按标题词（不加引号，避免标点/副标题差异导致整条命中丢失）→ `doi:` → `arxiv:` 拼 `scholar.google.com/scholar?q=…` 搜索 URL（非 citation 会话链接，标题优先——Scholar 的 `OR` 与 DOI 组合不稳定，不用它合并两个入口），`openExternalUrl` 打开系统浏览器；解析 `src/lib/bibtex/`，扩展 `bibtex-scholar-extension.ts` |
| 代码提示 | TeX / BibTeX 自定义补全经 `language.data.of({ autocomplete })` 挂进语言数据（TeX 为语言包的命令 / 环境 / 数学符号补全 + 文件路径补全；BibTeX 为 `@` 后条目类型、条目内行首字段名）；JSON / Python 用语言包自带补全 |
| 代码检查 | TeX 仅使用本机 **ChkTeX**，保留第三方原始规则；语言包诊断与自写项目诊断均关闭。Rust `chktex_lint` 把活动缓冲经 stdin 喂给 chktex（`-I0` 不跟随 `\input`），行列与命中长度映射回编辑器；缺少工具时返回空，不另起一套检查。1s 防抖，消息尾注 `chktex <编号>` 保留规则来源 |
| lint 状态栏 | TeX 底部保持原有严重度计数与悬停问题列表，也支持键盘聚焦；只展示 ChkTeX，单击问题定位，文字可拖选复制；每条末尾行列在悬停/聚焦时原位换为复制图标（触屏常显），复制包含文件、行列与原始消息。LaTeX 侧栏只有日志 modal 入口。实现 `text-editor-lint-footer.tsx`；详见 [latex.md](latex.md) |
| 文件路径补全 | TeX 路径参数命令（`\input` / `\include` / `\includeonly` / `\includegraphics` / `\includepdf` / `\includesvg` / `\bibliography` / `\addbibresource`，含 `*` 变体与 `[可选参数]`）的 `{}` 内按需列目录：路径相对当前文件目录解析（latexmk 以 .tex 父目录为 cwd），目录项带尾 `/` 置顶、按命令过滤扩展名（`\bibliography` 去掉 `.bib` 后缀），经 Host 树命令 / SFTP 逐级列出（同文件树忽略规则），带 10s 目录缓存；`validFor` 检测目录前缀变化后重新查询 |
| 换行 | `EditorView.lineWrapping` 全局启用 |
| 主题 | 底色、行号、当前行、选区、补全弹层走界面 CSS 变量（`--background` / `--foreground` / `--muted` / `--border` / `--popover`），盖过 CodeMirror 自带的 `&light` / `&dark` 实色。语法色从当前主题的 `--primary` 色相用 `oklch(from …)` 推出，浅色/深色各一套明度，注释用 `--muted-foreground`，非法片段用 `--destructive`。`\cite` 等引用命令在语法里是 quote 而不是 keyword，`\includegraphics` / `\footnote` 等被单独切开且没有高亮标签的命令用 `cm-tex-cmd` 补上同一命令色；`\ref` / `\label` 仍用名字色。明暗只切换 `color-scheme`。实现 `text-editor-theme.ts` |
| 生命周期 | 与 ExcalidrawViewer 同契约：props 播种 + `reloadKey` 信号，内容 / dirty / 800ms 防抖自动保存由编辑器持有，`persistTextFile` 带磁盘冲突守卫与按路径写队列；外部改盘 `reloadKey` bump 后**原地换 doc**（视图、滚动、撤销历史保留，不重挂载） |
| 手动保存 | ⌘S / Ctrl+S：立即 flush 防抖自动保存（跳过等待），成功后触发 `onManualSave`；内容干净时按 ⌘S 仍触发（显式重建），保存被冲突守卫拒绝则不触发。编辑器挂载时经 `registerTextEditorFlusher`（`lib/workspace/text-editor-flush.ts`，lib 层注册表，避免 actions 反向依赖 lazy chunk）注册 flush，卸载自动注销 |
| 划词工具栏 | 非空选区弹出与 PDF 同款的 `SelectionMenu`（portal 到 body 的 fixed 工具栏），只带 **加入对话（⇧⌘L）**（文字按钮）与 **快速对话（⌘K）**（下拉）：文本文件没有 marks/ 侧车（无高亮/翻译按钮），也**不做选区自动复制**——代码缓冲里选区常是粘贴替换的前奏，静默改写剪贴板会破坏待粘贴内容。拖选在 mouseup 后弹出（同 PDF），键盘选区（⇧ 方向键 / 双击 / ⌘A）即时弹出，滚动时锚点跟随（`coordsAtPos` 客户端坐标）。选区经 `publishSelection`（origin `markdown`，带 1 起始的 `lineFrom` / `lineTo` 行跨度——选区终点恰在行首时不含该行）镜像为 Agent composer 的临时 chip，chip 标签显示 `文件名 7行` / `文件名 12-15行`（行号后缀走 i18n，`composer.selectionChipWithLine(s)`；PDF chip 的 `· p.N` 对应形态），提交 prompt 为 `Selected text from {path} (lines A-B):`；加入对话 = 发布 + `pinActiveSelection` + 打开 Agent 侧栏并折叠选区；快速对话复用 `useSelectionAsk` + `AskPopover`（prompt 走 `buildPlazaAskPrompt` 的 `surface: "text"` 变体）。仅活动面板弹出（keep-alive 的隐藏 pane 不弹）；切走标签即收起工具栏，Ask 线程继续流式。划词工具栏与 Ask 卡都是 portal 到 body 的 fixed 浮层，选到面板顶部一两行时会贴着 dockview tab 条；两者挂载期间经 `src/lib/workspace/selection-overlay.ts` 把工作区 `disableDnd` 置真，暂停 tab / group 拖拽，避免在浮层上起手拖拽误触分栏（#608）。实现：`src/components/viewer/use-text-editor-selection.ts`。**Plate Markdown 笔记**同样写入 `lineFrom` / `lineTo`（`use-selection-context-publish` + 划词工具栏 / ⇧⌘L）：按顶层块 `serializeBlocksAsMarkdown` 前缀行数 + 块内换行偏移，再加 YAML frontmatter 行偏移，使行号与磁盘文件一致；块多选与行内选区均覆盖（#709）。实现：`src/lib/markdown/selection-source-lines.ts` |
| TeX | 项目主文件识别与显式选择；latexmk 增量 / 强制 / 清理重建、命名配方、输出目录与文件名；按保存或依赖变化自动编译；编译期间保留旧 PDF，成功后恢复阅读位置并刷新所有同路径分屏；源码与 PDF 双向 SyncTeX；整项目补全、大纲和论文库引用插入。问题统一在编辑器底部原有计数 / 悬停列表，日志从 LaTeX 侧栏按钮打开 modal。详见 [latex.md](latex.md) |
| 接入 | 懒加载 chunk（`doc-view.tsx` 分支）；dockview `renderer: 'always'` + 编辑器 LRU 保活；弹出窗 watcher / 会话恢复 / `applyDiskChange` 均已覆盖 `text` 模式 |
| 实时预览 | 仅当本机有 LuaLaTeX：LaTeX 面板里的「实时预览」打开或关闭 root PDF tab 的实时模式（`texLive`）。打开不改编译引擎。pane 内按 root 启动 rtex session（`src-tauri/src/features/rtex`），每次 CodeMirror change 经 UTF-16→UTF-8 字节转换后 `rtex_edit`；段落 display list 直接画到 canvas，degraded 页用 layout PDF（PDFium）。后台 pass 输出在 `<vault>/.agentero/rtex`，不进文件树/watcher。实现：`src/lib/tex-live/`、`src/components/viewer/texlive/`；详见 [../backend/rtex.md](../backend/rtex.md) |

## 面板类型

Library · Trash · PDF · HTML · 图片 · Markdown · 论文 NOTES · 纯文本（CodeMirror）。

## 文档类型注册表

文档类型（`CenterViewMode`）及依赖它的全部分发行为收敛在单一注册表 `VIEWER_MODE_TABLE`（`src/lib/workspace/viewer/index.ts`）：`CenterViewMode` 联合类型从表推导，其余触点一律读表，不再维护散落的 mode 枚举副本。

| 字段 | 驱动的触点 |
|---|---|
| `mode` | `CenterViewMode` 联合；持久化白名单 `isCenterViewMode`（`tabs/persist.ts` 不再自带 `VALID_MODES`） |
| `matchesPath` | `preferredModeForPath` 的匹配优先级（表序即顺序）；`papers/` 域回退 Markdown、其余回退 `text` 仍在函数内显式表达 |
| `renderer` | dockview panel renderer（`dock-workspace.tsx`）：`always` 保持未激活 panel 的 React 壳挂载，配合保活 LRU |
| `keepAlive` | 保活 LRU 池归属（`workspace-host.tsx`）：`pdf` = PDF viewer LRU=2，`editor` = Markdown / 文本编辑器 LRU=4，null = 不保活 |
| `props` | DocView 的域 props 比较器（`doc-view.tsx`）：按 mode 查表取域，替代原「镜像路由顺序」的手写比较列表 |
| `resource` | `loadTabResources` 的资源解析策略（`tabs/resources.ts`）：按 mode 取 PDF 字节 / 图片 blob / Markdown / Excalidraw / 文本种子，取代重复的路径谓词判断；pdf 与 translation 共享 `pdf`（translation 由 `createTranslationSplitPane` 克隆源 pane 字节，磁盘刷新 `refreshPdfTab` / `applyDiskChange` 同判据） |
| `restore` | 持久化会话恢复覆盖（`store.ts`）：translation 面板恢复为「已加载」的 paper 标签且不走磁盘 hydrate，其余为默认占位 |

新增一种文档类型 = 注册表加一条目 + `doc-view.tsx` 加一个渲染分支；复用既有 `resource` 策略时，加载器 / 持久化 / renderer / LRU / props 比较器 / 恢复都不用改。PDF / Plate / CodeMirror / Excalidraw 引擎、选区与持久化模型是本质差异，仍各自独立——注册表只收敛类型层与分发层。表完整性与各字段取值由 `test/workspace-viewer-modes.test.ts` 反漂移钉住（renderer / keepAlive / resource / props 逐项与旧行为等价）。

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
| `src/components/viewer/use-text-editor-selection.ts` | CodeMirror 选区 → 划词工具栏（加入对话 / 快速对话） |
| `src/components/viewer/text-editor-language.ts` | 扩展名 → 语言 / 自定义补全映射 |
| `src/lib/workspace/text-editor-flush.ts` | 编辑器防抖自动保存的 flush 注册表（编译按钮编译前落盘） |
| `src/lib/workspace/store.ts` | tabs / active / dockLayout |
| `src/lib/workspace/viewer/index.ts` | 文档类型注册表（`VIEWER_MODE_TABLE`）+ 路径谓词 / `preferredModeForPath` |
| `src/lib/workspace/tabs/` | DocTab 模型、NOTES 分屏、持久化 |
| `src/lib/workspace/dock-registry.ts` | 命令式 dockview 句柄 |
| `src/lib/workspace/selection-overlay.ts` | 划词工具栏 / Ask 卡等浮动浮层的挂载计数；工作区据此在浮层打开时 `disableDnd`（#608） |

PDF 分屏拖动性能见 [Markdown 编辑](markdown.md) 的长文阅读说明。
