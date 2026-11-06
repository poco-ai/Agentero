# 安装与首次使用

本教程带你完成第一次打开 Agentero、创建 Vault，并确认工作区可用。

## 准备工作

### 系统要求

| 平台 | 最低要求 |
|---|---|
| macOS | 12.0+ |
| Windows | 发布页 x64 安装包 |
| Linux | Ubuntu **22.04+**（需 **webkit2gtk 4.1**，包名常见 `libwebkit2gtk-4.1-0`） |

Linux 桌面包在 Ubuntu 22.04 上构建。更旧的发行版（如 Ubuntu 20.04，仅有 webkit2gtk 4.0）请先升级系统。

从 [发布页](https://github.com/poco-ai/agentero/releases) 或官网下载与系统匹配的桌面版本。macOS 也可用 Homebrew：

```bash
brew tap poco-ai/agentero
brew install --cask agentero
```

开发者可在仓库根目录运行：

```bash
pnpm install
pnpm tauri dev
```

首次使用**不需要**先安装 Zotero 或 Agent。只有在浏览器导入或 AI 辅助阅读时，才需要继续配置对应软件。

### Linux：`libwebkit2gtk-4.1-0` 无法满足

安装 `.deb` 时若缺少 `libwebkit2gtk-4.1-0`（常见于 Ubuntu 20.04）：请升级到 **22.04+**，或尝试发布页的 **AppImage**。见 [#253](https://github.com/poco-ai/Agentero/issues/253)。

## 创建第一个 Vault

1. 启动 Agentero。
2. 在欢迎页选择 **Create Vault**。
3. 选择一个长期保存研究资料的位置，例如 `~/Documents/ResearchVault`。
4. 等待左侧文件树和中间 Library 加载完成。

Vault 是普通目录。建议不要放在临时目录、下载目录或会被自动清理的同步缓存中。

创建后，目录通常会包含：

```text
ResearchVault/
├── papers/
├── notes/
│   ├── 01 论文导入与管理.md
│   ├── 02 Agent 与 Skill.md
│   └── 03 Markdown 与双链.md
├── .agents/
│   └── skills/
├── AGENTS.md
└── .agentero/
    └── catalog.sqlite
```

- `notes/` 下的三篇教程会按当前语言自动生成，首次创建 Vault 后会自动打开第一篇。
- 这些教程只是普通 Markdown，你可以自由编辑或删除；删除后不会自动恢复。
- 不要手动编辑 `.agentero/catalog.sqlite`。论文正文和笔记可以直接用外部编辑器修改，但结构化论文元数据应通过 Agentero 操作。

## 打开已有 Vault

在欢迎页选择 **Open Vault**，选择包含 `papers/`、`notes/` 或 Markdown 资料的目录。

如果已有目录中的文件没有立即出现在 Library：

1. 打开 Library（左侧虚拟节点，或关光文档后回到全库）。
2. 右键左侧 **papers/** 论文库节点，选择 **重新扫描 papers/**（Rescan papers/）；空库时也可点击中央的扫描按钮。
3. 等待扫描完成后重新查看论文列表。

有 Zotero 文库时，欢迎页也可选择 **从 Zotero 迁移**（迁移前会先创建 Vault）。详见 [导入和管理论文](import-papers.md)。

## 认识工作台

| 区域 | 作用 |
|---|---|
| 左侧文件树 | 浏览 Vault；顶部有 Library、回收站；魔棒可入库 |
| 中间工作区 | Dockview 文档面板：Library 表、PDF、Markdown、回收站等 |
| 右侧栏（可选） | Agent / 批注 / References（引用卡片 + 近邻图）/ Figures；编辑器状态栏看双链反链 |
| 左下角 | 后台任务（下载、入库、精读等） |
| 右上角 | 错误 / 警告 Toast |

打开论文时，默认会 **左右分屏**：左侧 PDF（或 HTML），右侧 `NOTES.md`。可用 Layout 菜单或快捷键开关 NOTES。

## 第一次检查

打开 Vault 后，建议依次确认：

1. 左侧文件树能展开 `papers/`。
2. Library 能显示论文或空状态。
3. 能新建一个 Markdown 文件并保存。
4. 若有 PDF，打开后可翻页和 `⌘F` 搜索。
5. `⌘P` 能打开快速打开面板；划词后 `⌘K` 快速对话、`⇧⌘L` 加入 Agent 对话，`⌘L` 切换右栏。组合可在「设置 → 快捷键」修改。

## 数据位置和备份

| 路径 | 用途 |
|---|---|
| `papers/<paper>/NOTES.md` | 论文笔记、摘要和整理结果 |
| `papers/<paper>/marks/` | PDF 高亮、批注、提问和翻译结果 |
| `papers/<paper>/*.pdf` | PDF 原文 |
| `papers/<paper>/source/` | arXiv 等来源的 TeX 或其它源文件 |
| `papers/<paper>/attachments/` | 可选支撑材料（补充 PDF、幻灯片、代码仓库）；有文件时文件树论文行才可展开 |
| `.agentero/catalog.sqlite` | Library 使用的论文集合和元数据 |
| `~/.local/share/agentero/usage.sqlite` | 本机使用记录（不在 Vault 内；设置 → 通用 → 隐私可关或清除） |

建议定期备份整个 Vault。若使用 Git，优先提交 Markdown、JSON、TeX 和其它源文件；`catalog.sqlite` 也应随 Vault 一起备份，以保留 Library 元数据。

## 自动更新失败

设置中点击更新时若弹出 **「无法安装更新，请重试」**（英文 **Couldn't install the update. Try again**），通常是下载安装包时网络不通或代理不稳导致：

1. **换一个代理节点**后重试；确认当前网络能访问 GitHub Releases。
2. 检查 **Settings → General → Network proxy** 的代理配置是否正确。
3. 若仍失败，可直接到 [发布页](https://github.com/poco-ai/agentero/releases) 手动下载最新安装包。

## 下一步

- [导入和管理论文](import-papers.md)
- [阅读、标注与整理](read-and-organize.md)
- [接入 Agent](agents.md)
