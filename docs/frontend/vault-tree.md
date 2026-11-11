# 文件树

左侧 Vault 文件树：虚拟 Recycle Bin、`papers/` 论文库入口、魔棒、paper 行操作、多选拖拽。

## 论文库入口

`papers/` 根文件夹即论文库入口：行首用 `Library` 图标，标题显示为「论文库」，仍可展开组织子文件夹；单击打开全库表格。其右键菜单在通用文件夹操作之外，追加入库操作：下载全部不完整论文资源、导出 BibTeX、发现引用我的新论文。

非 `papers/` 文件夹（`notes/`、`data/`、`plans/` 等）单击只展开/折叠并选中该行，不切换中间视图；`papers/` 下的组织文件夹单击仍在同一 Library 表内切换作用域。

Vault 根上的 `notes/`、`data/` 只改侧栏外观，磁盘目录名不变。`notes/` 用笔记图标，显示「笔记」；`data/` 用数据库图标，显示「数据」。英文界面分别为 Notes、Data。`thesis/` 不出现在阅读的文件树里，写作项目从写作工作面进入。只匹配相对路径恰好是这两个名字的根目录；更深的同名文件夹，以及重命名之后的目录，仍显示磁盘名。单击、展开、新建和重命名仍是普通文件夹。重命名输入框里是磁盘名。粘贴到这些目录时，菜单用侧栏名称。

Markdown（`.md` / `.mdx` / `.markdown`）和科研表格（`*.table.json`）在文件行里只显示名称，不显示后缀。类型靠行首图标区分，不另加文字标签。其它文件仍显示完整文件名。悬停可以看到磁盘文件名。重命名框里仍是完整文件名，磁盘路径不变。

## 新建文件

文件树右键菜单的「新建文件」（New file）默认预填 `未命名.md`（英文为 `Untitled.md`），并选中文件名主体，保留 `.md` 后缀以便直接输入标题。确认时，未填写扩展名的名称会自动补 `.md`（例如 `读书笔记` → `读书笔记.md`）；显式填写的扩展名保持不变（包括 `.md`、`.MD` 或 `.txt`），不会重复追加。此行为适用于 `notes/`、论文目录及其它文件树目录；新建文件夹、重命名与写作模块的新建文件不受影响。

## Agent

Vault 根上的 `.agents/` 与 `AGENTS.md` 合成一行，标题为 Agent（中英文相同），`Bot` 图标，排在其它根目录之前（仍在回收站和广场下面），默认收起。磁盘布局不变：`AGENTS.md` 仍在库根，技能仍在 `.agents/skills/<id>/`。没有 `.agents/` 目录时，`AGENTS.md` 仍单独出现在根上。

展开后：

- 第一行是根上的 `AGENTS.md`，显示文件名。点开即该文件。
- 之后每个含 `SKILL.md` 的技能目录一行。行上的名字是 frontmatter `name`（合法的小写 id）；没有或非法时用目录名。悬停显示 `description` 的第一句。单击打开该技能的 `SKILL.md`，不把 Library 收成这个目录。
- 技能包里只有 `references/`、`scripts/`、`assets/` 会出现展开箭头，其下仍是磁盘文件名。`README`、`LICENSE`、`SKILL.md`、`agents/openai.yaml`、`SKILL-windows.md` 不进树。
- 重命名框里是目录名。右键「在访达中显示」指向真实路径：说明在库根，技能在 `.agents/skills/<id>/`，Agent 行本身是 `.agents/`。
- 家目录里的 `~/.agents`、`~/.claude/skills` 不进这棵树，仍只出现在 Composer 的 `$` 菜单。

更深的同名 `.agents`（例如 `notes/.agents`）保持普通文件夹。打开 `AGENTS.md` 或某个技能的 `SKILL.md` 时，树会展开 Agent 行并高亮对应行，不会因此展开技能包内部。

## 虚拟节点

| 节点 | 路径常量 | 行为 |
|---|---|---|
| Recycle Bin | `agentero:trash` | 打开回收站视图（论文项主行显示快照标题，经 `MathText`；普通文件显示文件名；副行原路径 + 删除时间）；右键清空 |
| 广场 | `agentero:plaza` | 单击只切换展开/收起（纯虚拟文件夹，无广场首页）；`Globe` 图标。子来源含 Cool Papers、ModelScope 论文、Skill 推荐与 **订阅**；右键父节点列出全部来源逐条勾选显隐（`plazaHiddenSources`） |

## 建树

- 本地：Host `vault_tree_build` **一次 IPC** 递归（`features/vault/tree.rs`）。
- 远程：`remote_list` 前端递归。
- **全量递归**：`papers/`、`notes/`、`.agents/`；论文内 `source/` **懒加载**（`childrenPending` → `vault_tree_children`）。
- 论文默认仍是叶子。满足任一条件时行上出现 chevron，展开后依次列出「根目录白名单文档」与 `attachments/` 子项：
  - **根目录白名单文档**：`.md` / `.html` / `.htm`（扩展名大小写不敏感），但 **`PAPER.md` 永不显示**（论文行已代表派生正文）。只有 1 个可显示文档时仍保持叶子（通常就是 `NOTES.md`）；**≥2 个**时全部列出，因此 Zotero / Connector 导入的额外笔记与 `snapshot.html` 会作为子节点出现（#738）。
  - **附件**：`{paper}/attachments/` 内有文件时列出其子项，不显示 `attachments` 桶本身。
  - 以上两种情况都不显示 `source/` / `marks/` / `assets/` 等内部目录。
- **应用自产 sidecar 不入树**：`{paper}/source/` 下的 `agentero-cite.json`、`agentero-figures.json` 与 `layout.json` / `layout-index.json` / `layout-translate.json` 都是可重建的应用资产，树永不列出。因此即便某文件夹没有被识别成论文单元（论文被移出 `papers/`、从外部拷贝进来、组织夹里残留等），只要其 `source/` 只装这些文件，整个 `source/` 目录也不会出现（#747）。
- 其它根目录（包括旧 Vault 中可能存在的 `plans/`）只 list 一层，展开再 list。
- **缺失目录**：本地 `read_dir` 失败返回空列表；远程 list 的 `NoSuchFile` 同样按空处理（`isPathMissingError`），避免删除后刷新把整棵树清空。删除成功后会先 `removeTreeNode` 乐观剪枝，再 `refreshTree`。
- 忽略：`.git`、`.venv`、`node_modules` 等（`TREE_IGNORE_NAMES`）。
- 基础顺序：目录在文件前；同类按数字感知的自然顺序排序（如 `9-...` 在 `10-...` 前）。
- 默认只展开 `papers/` 及其一级子目录。
- 所有节点图标统一位于行首并使用一致的左右边距；行首内容 inset 由 `TREE_ROW_INSET_PX` + 层级 × `TREE_ROW_INDENT_STEP_PX` 统一计算（`file-tree-primitives.tsx`），行背景仍铺满整行。文件夹与广场行悬停或键盘聚焦时，在同一位置将自身图标替换为展开/收缩箭头，保持行宽稳定并提示该行可展开。
- 行文字默认使用 `text-muted-foreground`，行悬停过渡到 `text-foreground`，选中行过渡到 `text-sidebar-primary-foreground`；行尾操作按钮复用同一份 `TREE_ROW_TEXT_STATE`。
- 行尾操作按钮（论文下载 / 精读、写作根的“新建项目”）复用同一个图标按钮：默认 `text-muted-foreground`，悬停转 `text-foreground`，并在右侧显示全局 Tooltip；按钮透明，不叠加自己的悬停背景，选中行内随行文字反色为 `text-sidebar-primary-foreground`。
- 虚拟化：`@tanstack/react-virtual` 拍平窗口化；`getItemKey` 用行稳定 id，避免内联新建草稿插入/移除后按索引缓存行高留下空隙。文件/文件夹行固定为 `h-7`，论文资源操作按钮不改变行高。行定位用 `top`（不用 `translateY`），并在视口**高度**变化时把 `scrollTop` 同步回 virtualizer，避免 WKWebView 在打开论文 / 刷新树后侧栏整片不绘制、滚动才恢复（见 [bug_fix/vault-sidebar-blank-until-scroll.md](../bug_fix/vault-sidebar-blank-until-scroll.md)）。宽度变化（左栏收起/展开动画、手动拖宽）不写 `scrollTop`；左栏 0 宽收起期间记住滚动位置、重新展开时恢复（#576）。扁平行集变化时不再全量 `measure()`——稳定 key 令缓存行高保持有效，全量重估会在无原生 scroll anchoring 的 WebKit 上表现为每次展开/折叠的行抖动。
- 外部工具 / CLI 导入论文时，watcher 会刷新文件树，并在 Catalog 或 `papers/` 结构变更后去抖刷新 Library 元数据；论文行标签因此可在不重开论文库的情况下从目录 ID 更新为标题/作者。窗口隐藏/失焦时变更先缓冲，回到前台再 flush；后台去抖更长。
- 外部工具 / CLI 移动或删除论文时，Library 刷新会按 Catalog 的 paper id 对比前后快照，不只依赖 watcher 的 rename 配对（macOS FSEvents 常把目录移动报成新目录 create，移出 Vault 只报旧路径）：同一 id 换了路径时，打开的论文 / NOTES tab、dockview 面板、PDF 标注、树选中与 Library 作用域一起移到新路径；id 消失且旧目录确实不在磁盘上时关闭该论文的 tab（跨 Vault 迁移、外部删除）。实现在 `src/lib/paper/library-sync.ts`，由 `lifecycle/register.ts` 注册到外部刷新波次。
- 在 `papers/` 下新建文件夹并拖入 PDF 会被 Host 自动收录为论文条目（补齐 NOTES shell 与 catalog 行，#549），`paper:imported` 事件照常驱动树与论文库刷新；详见 [backend/paper-import.md](../backend/paper-import.md) 的 auto-ingest 小节。

### 论文目录识别

- 后台资源就绪（`paper:assets-ready`，包括 Zotero Connector 的延迟资源下载）后，按论文路径重新列出父目录并刷新 Library。必须更新论文行自身的 `hasTex` / `needsSource`，不能只刷新 `source/` 子项，否则源码已落盘时下载按钮仍可能残留。其它 Vault 的事件不影响当前树。

- `papers/` 下目录的直接子项含 `NOTES.md`、`PAPER.md` 或 `source/` / `assets/` / `marks/` 时，可作为论文单元。
- 如果目录自身有索引/概览 `NOTES.md`，但其子树中还包含论文单元，则优先判定为组织目录，继续收集子论文；组织目录不会被折叠成单篇论文。
- `attachments/` 与 `source/` / `assets/` / `marks/` 一样视为论文内部目录：不单独当作论文，也不在其中再找嵌套论文。
- 文件树已经得到非空的论文目录列表后，文件路径的论文归属以该列表为准，不再把组织目录的 `NOTES.md` 通过文件名回退规则猜成论文。

## Paper 行

| 展示 | 说明 |
|---|---|
| 标签 | 默认「标题 · 作者」；`paperTreeLabelMode` 可改（展示用，不改磁盘名）。标题中的 `$\\pi$` / `\\(...\\)` 等经 KaTeX 内联渲染（`MathText`） |
| 排序 | `paperTreeSortMode`：默认 `folder` 模式下组织文件夹始终排在论文文件夹之前，再按显示标签 A–Z；其他模式按标题/作者/年份/添加时间排序 |
| Chevron | 仅当有可见子项时出现：根目录白名单文档 ≥2 个，或 `{paper}/attachments/` 非空。点三角展开/收起子项；点行仍打开论文 |
| Download | 缺 PDF，或既无 TeX 也无 `PAPER.md`（`source/` 为懒壳时按其 `hasTex` 标记判定）；指向有效普通文件的 PDF 软链接也视为本地 PDF |
| NotebookPen | 资源齐且 `is_read === false` → paper-reader |

## 交互

| 操作 | 方式 |
|---|---|
| 新建文件/文件夹 | 右键 → 树内联命名；菜单会按实际尺寸在窗口边缘自动翻转或滚动，不会被窗口下沿截断。论文行也可「新建文件」，直接建在论文根目录，默认名 `Untitled.md`（只选中主文件名、保留 `.md`），创建后会作为论文子节点出现；论文行不提供「新建文件夹」（根目录普通文件夹不会显示）。**远程 Vault** 的重名预检走 `vaultPathExists`（`remote_list` 父目录），不可用本机 `plugin-fs` `exists`（伪路径 `remote:<id>/…` 不在本地 scope） |
| 复制路径 | 右键；Windows 本地路径去掉 `\\?\` 前缀，扩展 UNC 路径显示为 `\\server\share\…`；仅转换剪贴板文本，内部文件路径保持原样 |
| Finder 显示 | 右键 / `⌥⌘R` |
| 终端打开 | 右键 / `⌥⌘T`（文件夹=自身，文件=父目录）；Windows 先把扩展盘符路径转换为普通盘符路径，再启动 Windows Terminal 或 CMD，目录名中的空格、中文与 shell 特殊字符不作为命令解析 |
| 删除 | 右键 / `⌘⌫` → 回收站（无确认） |
| 编辑元数据 | Paper 行右键（仅本地 Vault；查 `paperMetaByRelPath` 打开与 Library 相同的编辑对话框） |
| 多选与批量操作 | ⌘/Ctrl 单击切换、Shift 单击范围选择；选择后复用 Vault 的固定 `PaneHeader` 显示数量、移动、删除与清除，不在树内插入或悬浮工具条，因此树的高度、滚动位置和可见范围不变。右键已选行作用于整组；右键未选行会先收敛为该单项。Esc 清除，Space 可用键盘激活，Enter 直接对当前行开始内联重命名（虚拟节点仍按激活处理，见下）。父目录与后代同时进入范围时只保留父目录这个语义目标，避免重复移动/删除。|
| 重命名 | 右键菜单或选中行按 Enter 进入内联重命名。文件改成**不带扩展名**的名称时转成文件夹（#759）：新名称成为文件夹名，原文件保留后缀并改成同名文件移入（`notes/foo.md` → `notes/bar/bar.md`）；目标文件夹已存在时直接移入。移动失败会清掉本次刚建的文件夹。文件夹重命名始终只是改名。|
| 多选拖拽 | 从已选行拖动整组到目标文件夹（内部拖动带 `application/x-agentero-vault-paths`，Composer / Library 不抢成图片或 PDF 导入）；拖动时高亮落点夹。论文单元在移动/删除时仍作为原子单位（展开出的笔记/附件行除外），拖到论文行 = 落到它的父目录（`dropDirFor`）；两端都在 `papers/` 下走 `paper_move`，否则 `wiki_move` |
| 外部 PDF | 拖到 `papers/` 组织夹，或拖到中间栏 Library 表（[#309](https://github.com/poco-ai/Agentero/issues/309)） |
| 键盘移动 | `↑`/`↓`（`j`/`k`）只移动灰色键盘光标，**不打开**对应文件/目录：打开会重新定位侧栏，连续按键就会回跳。`←`/`h` 收起已展开目录、否则跳到上级目录；`→`/`l` 展开目录、否则进入第一个子项；叶节点（论文 / 文件）上按 `→`/`l` 等同单击，直接打开。Vim 键位受设置 → 通用 → Vim 模式控制 |
| 折叠 | `⌘←` 选中夹；`⇧⌘←` 折叠至默认 |
| 定位 | 激活文档变化时展开祖先并 `scrollToIndex`（VS Code `List.reveal` 语义：`align: "auto"` 最小滚动，行已可见则不滚，从不居中）；同一目标只定位一次，导入后台阶段引起的树刷新不再重复滚动；用户折叠包含当前选中的目录后不会被自动定位立即重新展开（#576） |
| 刷新 | File → Refresh（`⌘R`）；watcher 局部刷新 |

树内新建与重命名共用 `tree-inputs.tsx` 中的命名输入组件，统一名称校验、提交、取消与失焦处理。两者及移动面板的新文件夹输入复用 `useImeGuard`：输入法组字期间 Enter 只确认候选词、Escape 只取消候选词；同时覆盖 `keyCode 229` 与组字结束后确认按键的时序差异。组字结束后再次按 Enter 才提交；移动面板也不会因候选词的 Escape 提前关闭（#746）。树内输入失焦时读取最终输入值，并防止 Enter 与失焦重复提交。

### 拖拽的平台差异

树内拖拽必须**同时**保留 DOM 与 Tauri 原生两条路径（[#353](https://github.com/poco-ai/Agentero/issues/353)）：

- **macOS 只走原生事件**。wry 子类化 WKWebView 并接管 `NSDraggingDestination`（wry `src/wkwebview/drag_drop.rs`），只有当 handler 返回 `false` 时才 `msg_send![super(...)]` 交还给 WebView；而 Tauri 的 handler 恒返回 `true`（tauri-runtime-wry `src/lib.rs`）。于是 `super` 永不调用，页面收不到 DOM `dragover`/`drop`——**即使拖拽是从树里发起的**。落点高亮与移动因此只能由 `onDragDropEvent`（enter/over/leave/drop）+ 命中测试驱动。macOS 版也不区分是否文件拖拽，非文件拖拽只是 `paths` 为空。
- **时序陷阱**：WebKit 在拖拽*源*一侧发的 `dragend` 早于 wry 投递的原生 `drop`。若 `dragend` 直接清空拖拽状态，随后到达的 drop 就找不到路径、静默失败。`use-tree-drag-drop` 因此用 `dragPathsRef` + 到期时间保留路径一小段宽限期。
- **Windows / Linux 只走 DOM 事件**。webview2 的 `DragEnter` 拿不到 `CF_HDROP`（真实文件列表）就直接返回，后续 `DragOver`/`Drop` 全部空转；webkitgtk 的 drop 也需要 URI-list。页面内拖拽在这两个平台不产生 Tauri 事件，由 `handleRowDragOver` / `handleRowDrop` 正常处理。

## 代码

- UI：`src/components/sidebar/file-tree/`（barrel `index.ts`；`file-tree.tsx` 仅装配，行/菜单/输入/虚拟列表为独立子模块）、`vault-sidebar-header.tsx`（普通 / 多选标题栏）、AI Elements `FileTree`
- 树内状态：`src/components/sidebar/file-tree/hooks/`（`use-tree-model` 路径索引与扁平行、`use-tree-expansion` 展开与懒加载、`use-tree-selection` 多选、`use-tree-reveal` 虚拟化与定位、`use-tree-drag-drop`、`use-paper-row-actions`、`use-tree-context-menu`、`use-move-picker`）
- 逻辑：`src/lib/vault/`（store、tree、fs-watch、reveal）
- Agent 行：`src/lib/vault/agent-tree.ts`（把根上的 `AGENTS.md` 和 `.agents/skills/` 投影成一行）、`use-skill-labels.ts`（读 `SKILL.md` 的 frontmatter `name`）
- 附件：`src/lib/paper/attachments.ts`、`paths.ts`（`attachments/` 约定）
- 论文可见子项：`src/lib/paper/children.ts`（根目录 `.md`/`.html`/`.htm` 白名单，排除 `PAPER.md`，再与 `attachments/` 合成）
- 标签/排序：`src/lib/paper/tree-label.ts`、`tree-modes.ts`

## 开发注意

纯浏览器 `pnpm dev` 时本地盘 IO 受限；完整文件树/读写需 `pnpm tauri dev`。
