# 导入和管理论文

Agentero 提供多种入库入口。选择哪一种取决于你手上的资料，而不是论文来源。

| 手上的资料 | 推荐入口 |
|---|---|
| DOI、arXiv ID、PMID、ISBN 或论文链接 | 魔棒（可批量粘贴） |
| GitHub Skill 链接或 `npx skills add …` | 魔棒（Skill 导入） |
| 浏览器中正在打开的论文网页 | [Zotero Connector](zotero.md) |
| 本地 PDF 文件 | 魔棒本地导入，或直接拖入应用窗口 |
| 已有 Zotero 文库 | 欢迎页「从 Zotero 迁移」 |
| BibTeX / RIS 等 | Library 导入 |

## 用魔棒导入标识符或链接

1. 打开一个 Vault。
2. 点击左侧 **魔棒**，或按 `⇧⌘I`。
3. 粘贴一个或多个标识符或 Skill 来源（空格、逗号、分号、换行均可分隔）。
4. 确认目标文件夹（默认为 `papers/`，或当前选中的 Papers 子文件夹）。
5. 开始导入；左下角任务条会显示进度。

导入进行中仍可再次打开魔棒并提交新的标识符；新的导入会进入任务队列，按顺序处理。

导入成功后，Agentero 会创建论文目录、写入 catalog，并尽量下载 PDF。对 arXiv 论文还会尝试把 e-print LaTeX 解压到 `source/`。随后会刷新文件树、展开并打开新论文。

### 同时导入 Skill

魔棒也支持把 GitHub 上的 Agent Skill 装入当前 Vault：

```text
https://github.com/mattpocock/skills
npx skills add https://github.com/anthropics/skills --skill pptx
```

1. 粘贴 Skill 来源后，Agentero 会解析仓库并列出候选 Skill。
2. 弹出的选择窗口会显示名称与已安装状态；勾选需要的项。
3. 确认后仅安装选中 Skill 到 `.agents/skills/<name>/`；已存在的 Skill 不会覆盖。
4. 取消或关闭窗口会清理本次解析的临时包，不会修改 Vault。

Skill 导入当前**仅支持本地 Vault**，远程 Vault 会提示暂不支持。

```text
papers/<paper-id>/
├── NOTES.md              # 笔记壳（不覆盖你已有内容）
├── <paper-id>.pdf        # 能下到时
├── marks/                # 阅读标注目录
├── source/               # arXiv TeX 等
└── attachments/          # 可选：补充 PDF、幻灯片、代码仓库（有文件才出现）
```

支撑材料放在 `attachments/`，不要堆在论文根目录。文件树默认把论文当叶子；该目录非空时论文行才出现展开三角。

## 将 PDF 存在 Vault 外（软链接）

如果希望 PDF 也能被 Finder、Zotero、其他阅读器或 Git 仓库之外的工具直接管理，
可以把 PDF 放到 Vault 外部的独立目录，再在论文目录根部创建一个软链接：

```text
Research/
├── agentero-vault/
│   └── papers/latent/2604.13349/
│       ├── NOTES.md
│       ├── source/
│       └── 2604.13349.pdf -> ../../../../pdf-library/2604.13349.pdf
└── pdf-library/
    └── 2604.13349.pdf
```

这仍然保留了 Agentero 需要的论文单元：`NOTES.md`、`source/`、`marks/` 和论文元数据在
Vault 内，PDF 二进制则由 `pdf-library/` 管理。论文目录下的 PDF 软链接会被识别为本地
PDF，论文行不会显示「下载」按钮，打开论文时也会读取软链接指向的文件。建议使用相对
软链接，并让 Vault 与外部 PDF 目录保持稳定的相对位置，这样在另一台设备上更容易恢复。

### 创建软链接

macOS / Linux：

```bash
ln -s /path/to/pdf-library/2604.13349.pdf \
  /path/to/agentero-vault/papers/latent/2604.13349/2604.13349.pdf
```

Windows（PowerShell 或命令提示符）：

```powershell
mklink "C:\path\to\agentero-vault\papers\latent\2604.13349\2604.13349.pdf" `
       "D:\path\to\pdf-library\2604.13349.pdf"
```

Windows 创建软链接可能需要开发者模式或管理员权限。创建后在 Agentero 中执行刷新，
或重新打开 Vault。也可以在文件管理器中直接打开外部目录里的原始 PDF。

### 同步与备份注意事项

- Agentero 的 S3 同步只同步 Vault 内的普通文件，不跟随软链接；外部 PDF 目录需要单独
  用 iCloud、坚果云、Dropbox 等同步。同步前应确认两台设备都能访问同一份外部 PDF。
- Git 通常只记录软链接本身及其目标路径文本，不会把目标 PDF 提交进仓库。这样适合让
  Git 管理 Markdown、TeX、JSON 和标注，但不能单靠 `git clone` 恢复 PDF。
- 绝对软链接换电脑后通常会断。优先使用相对软链接，或在每台设备上运行一次维护脚本
  重新建立链接。外部 PDF 被移动、删除或同步尚未完成时，Agentero 会重新显示资源缺失
  的下载提示。
- 软链接应放在论文目录根部，例如 `papers/<id>/<id>.pdf`；不要把主 PDF 软链接放进
  `attachments/`，也不要把外部目录本身作为软链接目录让 Agentero 递归扫描。

这种方式是“外置 PDF + Vault 内索引/笔记”的管理方式，不是把论文单元完全移出 Vault。
如果希望 Agentero 的 S3 同步也负责保存 PDF，请继续使用 Vault 内的真实 PDF 文件，并在
同步设置中保留 PDF 类别。

### 识别失败时

- 优先粘贴单篇论文的 DOI 或 URL，不要一次粘贴搜索结果页。
- 检查设置中的 Translator 服务地址是否可访问（默认见应用设置）。
- arXiv 可直接使用 ID（如 `1706.03762`）。
- 元数据成功但 PDF 失败时，先保留条目，再在论文行或 Library 使用 **Download**。

批量入库时不会自动连跑精读；精读需在文件树手动触发，或开启自动精读后再单篇触发。

## 导入本地 PDF

**方式 A — 魔棒**

1. 打开魔棒的本地文件导入。
2. 选择一个或多个 PDF。
3. 确认元数据后写入目标目录。

**方式 B — 拖到 Library**

1. 打开中间栏论文库（全库或某个 `papers/` 子文件夹作用域）。
2. 把一个或多个 PDF 从访达拖到表格上；仅 PDF 会显示「松开以导入」overlay。
3. 松手后直接后台导入；元数据识别继续在后台运行。

文件夹作用域下会导入到当前文件夹；全库则落到左侧选中的 Papers 组织夹，否则 `papers/`。

**方式 C — 拖到文件树**

1. 把 PDF 拖到文件树中的 `papers/` 或其组织子文件夹。
2. 松手后直接后台导入并复制 PDF、写入 catalog；无 TeX 时会尝试生成 `PAPER.md`。

PDF 拖到窗口任意区域都会导入当前 Papers 目标目录；Library 表和文件树中的
`papers/` 组织夹会优先使用它们各自的目标目录。识别元数据、重命名和版面分析在
后台任务中继续。图片等非 PDF 拖到 Library 不会出现 overlay。

本地 PDF 文件名不一定含完整信息。导入后请在 Paper Info 中检查标题、作者、日期和标签。

## 从 Zotero 迁移

适合把已有 Zotero 文库整体迁到新 Vault：

1. 欢迎页选择 **从 Zotero 迁移**（或等价入口）。
2. 选择包含 `zotero.sqlite` 与 `storage/` 的 Zotero 数据目录。
3. 查看扫描结果（论文、PDF、笔记数量）。
4. 按需选择：复制本地 PDF、按 collection 建子文件夹、迁移笔记与高亮等。
5. 开始迁移并等待进度完成。

迁移不会把 Zotero 数据库当作 Agentero 运行时库；文件写入当前 Vault，元数据写入当前 catalog。

若一篇论文属于多个 Zotero 分类，Agentero 仍只保存一个真实论文目录：优先放入层级最深的分类，层级相同则按完整路径字母顺序确定。它的其他原始归属会直接在对应分类文件夹中显示为带链接标识的论文条目；它们都指向同一真实目录，不会复制文件。所有空分类仍会作为真实文件夹保留。

## 管理论文

### Library 与文件夹作用域

- 左侧虚拟节点 **Library** 打开全库表格。
- 单击 `papers/` 下的组织文件夹（如 `papers/nlp`）：同一 Library 表按路径前缀筛选（不新开 tab、不重新拉全库）。
- 单击 `notes/`、`.agents/`、`plans/` 等非 papers 目录：不进入文件夹作用域，Library 仍显示全库。
- 表头可排序；表头右键可选列与顺序（持久化到设置）。

### 标签

在 Paper Info 中增删标签并可选 Apple 风格 8 色。Library 的 tags 列显示染色 chip；搜索框可匹配标签子串。

### 补下载资源

- 论文行缺 PDF，或既无 TeX 也无 `PAPER.md` 时，显示 **Download**（hover 可见原因）。
- Library 可对库内缺失资源批量补下。

### 导出

在 Library 虚拟节点上右键 **导出论文库**（BibTeX）。也可在 Library 内使用导入 / 导出相关入口。

### 删除与回收站

删除走回收站（`⌘⌫` 或右键），无确认、无 Undo toast。左侧 **Recycle Bin** 打开中间栏，可恢复或永久删除；清空在回收站节点右键菜单。

删除论文时，该论文的后台任务（下载 / 解析 / 版面分析 / 元数据识别）会自动取消，任务面板对应条目置为已取消。

### 处理重复导入

重复导入通常会复用已有目录或给出去重结果。不要手动删已有 `NOTES.md`，其中可能已有阅读记录。

## 下一步

- [阅读、标注与整理](read-and-organize.md)
- [使用 Zotero Connector](zotero.md)
