<p align="center">
  <img src="docs/assets/hero.png" alt="Agentero" width="100%" />
</p>

<h3 align="center">用来找论文、做笔记和跟 Agent 一起读文献的科研工作台</h3>

<p align="center">
  论文、笔记和对话记录保存在本地。读 PDF 时，可以把选中的原文、图表或笔记发给 Agent 一起分析。
</p>

<p align="center">
  <b>中文</b> | <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/poco-ai/agentero/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/poco-ai/agentero?style=for-the-badge&logo=github&color=E3B341&labelColor=20242D"></a>
  <a href="https://github.com/poco-ai/agentero/releases"><img alt="release" src="https://img.shields.io/github/v/release/poco-ai/agentero?include_prereleases&style=for-the-badge&logo=github&color=1B54E8&labelColor=20242D"></a>
  <a href="https://github.com/poco-ai/agentero/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/poco-ai/agentero?style=for-the-badge&logo=opensourceinitiative&logoColor=white&color=34D399&labelColor=20242D"></a>
  <a href="https://agentero.app/"><img alt="website" src="https://img.shields.io/badge/官网-agentero.app-5319E7?style=for-the-badge&labelColor=20242D"></a>
  <a href="https://agentero-docs.poco-ai.com"><img alt="docs" src="https://img.shields.io/badge/文档-在线查看-5319E7?style=for-the-badge&logo=mkdocs&logoColor=white&labelColor=20242D"></a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/119836?utm_source=repository-badge&utm_medium=badge&utm_campaign=badge-repository-119836" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/119836" alt="poco-ai%2FAgentero | Trendshift" width="250" height="55"/></a>
  <a href="https://trendshift.io/repositories/119836?utm_source=trendshift-badge&utm_medium=badge&utm_campaign=badge-trendshift-119836" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/119836/daily?language=TypeScript" alt="poco-ai%2FAgentero | Trendshift" width="250" height="55"/></a>
</p>

如果本项目对你有帮助，请在右上角**给个 star** 吧！

<p align="center">
  <a href="https://github.com/poco-ai/agentero/stargazers"><img src="https://github.com/user-attachments/assets/1d49b049-89ae-4992-a92d-d2411c8053b6" alt="Give me a star" width="480" /></a>
</p>

---

## 背景与设计初衷

很多人用 Zotero 整理论文。它的文献管理功能成熟，也有丰富的插件。

开始用 Agent 一起读论文时，麻烦往往出在几个工具之间。

* **来回复制资料。** 论文放在 Zotero，笔记写在 Obsidian，讨论留在网页对话里。想请 Agent 对照原文和之前的笔记，经常得在几个应用间复制粘贴。
* **PDF 里的结构容易读错。** 双栏的阅读顺序、跨页表格和公式都可能解析错。转成 Markdown 和 LaTeX 后，模型更容易读到这些结构。
* **常用功能要分别配置。** 用 AI 读论文、翻译全文、同步笔记，往往要装几个插件，升级后还要检查能不能继续用。
* **搜到一批论文后，还要逐篇保存。** 用 Deep Research 或自动化工具找论文很快，但把结果加进自己的论文库常常还得手动操作。

可以继续用 Zotero 整理文献，在 Agentero 里做需要结合原文、笔记和对话的工作。让 Agent 先筛摘要、查论文信息、提取图表和公式、梳理引用或整理要点，自己回到原文细读，判断证据能支持什么结论。

---

## 核心功能

### 1. 结构化阅读与笔记系统
* **读 PDF 和做批注。** 用目录跳到指定章节，按整页或页宽显示 PDF，也可以划词、高亮、写批注或搜索全文。
* **提取图表和公式。** 把公式、算法伪代码和表格解析成 Agent 能读取的 Markdown 和 LaTeX。
* **写能跳回原文的笔记。** 在可视化 Markdown 编辑器里，通过 `[[双链]]` 关联笔记和论文，输入 `/` 查找插入命令，也可以实时预览 LaTeX 公式。
* **翻译选区、单页或全文。** 可以并排看原文和译文。用内置翻译服务，也可以配置自己的 API Key（BYOK）。

<p align="center">
  <img src="docs/assets/agent.png" alt="PDF 阅读与 Agent 伴读" width="90%" />
  <br/>
  <sub>左栏读原文、做批注，右栏把选中的内容交给 Agent 提问。</sub>
</p>

<p align="center">
  <img src="docs/assets/translate.png" alt="划词翻译与笔记联动" width="90%" />
  <br/>
  <sub>在 PDF 上划词翻译，顺手把读到的要点记进 Markdown 笔记。</sub>
</p>

---

### 2. 开放的 Agent 协议与自动化接口
* **用 ACP 连接 Agent。** 通过 Agent Client Protocol 使用本机上的 Claude Code、OpenCode、Codex 等 Agent，也可以用支持本地模型的 Agent。发送消息时，问题和选入的材料会交给所选 Agent，数据处理方式取决于它的配置。
* **通过 MCP 访问文献库。** 开启内置的 Model Context Protocol 服务后，可以让 ChatGPT Web、Claude Desktop 等支持 MCP 的客户端查询知识库。不同客户端有各自的连接方式。
* **用 CLI 批量处理文献。** 在终端或脚本里导入论文、提取元数据或写入笔记。

<p align="center">
  <img src="docs/assets/image.png" alt="内置 MCP 连接" width="90%" />
  <br/>
  <sub>开启 MCP 后，可以把本地文献库接到支持 MCP 的客户端。</sub>
</p>

---

### 3. 学术雷达与文献发现
* **浏览新论文。** 在应用内浏览 [Cool Papers](https://papers.cool/) 和魔搭社区的论文，或添加 RSS 订阅。看到感兴趣的论文，可以存到自己的库里。
* **看每天的 arXiv 推荐。** arXiv Daily 参照库里论文的摘要，为当天的新论文排序。
* **顺着引用找论文。** 从解析出的参考文献里批量选论文入库，可以补齐出版商元数据，也能反过来查有哪些新论文引用了库里的文章。

<p align="center">
  <img src="docs/assets/coolpaper.png" alt="Cool Papers 集成" width="90%" />
  <br/>
  <sub>应用内直接浏览 Cool Papers 热门论文并一键导入本地知识库</sub>
</p>

---

### 4. 兼容 Zotero 生态与本地透明存储
* **从 Zotero 迁移和收集论文。** 可以选要导入的条目和附件，保留已有标签和笔记，也可以用 Zotero 浏览器扩展保存网页上的论文。支持导出 BibTeX / BibLaTeX。
* **文件可以直接打开。** 论文和笔记以 PDF 和 Markdown 保存在知识库文件夹里，用其他工具也能读。论文库的结构化元数据保存在 `.agentero/catalog.sqlite`。
* **同步或打开远程库。** 可以用 S3 兼容的存储服务同步多台电脑上的知识库，也可以通过 SSH 打开服务器上的知识库。

---

## 界面与功能预览

<details>
<summary><b>点击展开：查看更多界面截图（RSS 订阅、技能扩展、Agent 配置、S3 云同步、主题风格）</b></summary>
<br/>

#### 1. 学术 RSS 订阅
订阅常看的学术博客和实验室主页，在应用里查看更新。
<p align="center">
  <img src="docs/assets/rss.png" alt="RSS 订阅" width="85%" />
</p>

#### 2. Agent 技能（Skill）扩展
浏览并安装社区提供的 Skill，用来精读论文或辅助写作。
<p align="center">
  <img src="docs/assets/skill-import.png" alt="Skill 扩展" width="85%" />
</p>

#### 3. Agent 与连接配置
在同一个设置页管理、升级和切换通过 ACP 连接的 Agent。
<p align="center">
  <img src="docs/assets/agent-setting.png" alt="Agent 设置" width="85%" />
</p>

#### 4. S3 兼容云存储同步
给几台电脑接上同一个 S3 兼容存储，就可以同步知识库。
<p align="center">
  <img src="docs/assets/s3-sync.png" alt="S3 同步设置" width="85%" />
</p>

#### 5. 多套界面主题
可以选浅色或深色主题、调整配色，也可以跟随系统外观。
<p align="center">
  <img src="docs/assets/theme.png" alt="主题配置" width="85%" />
</p>

</details>

---

## 快速开始

### 桌面客户端安装 (macOS / Windows / Linux)

从 **[官网 agentero.app](https://agentero.app/)** 或 **[GitHub Releases](https://github.com/poco-ai/agentero/releases)** 下载与你的电脑匹配的安装包。

#### macOS (Homebrew)
```bash
brew tap poco-ai/agentero
brew install --cask agentero

```

> **Linux 用户须知**：系统环境要求 Ubuntu 22.04+（依赖 `webkit2gtk 4.1`），详细依赖说明请参考 [安装文档](docs/usage/getting-started.md)。

#### Linux 白屏 / 界面卡顿

如果你的界面一片空白，或者滚动、输入明显卡顿，可能是 WebKitGTK 的渲染降级。请先检查环境里有没有下面这两个变量：

```bash
grep -rn "WEBKIT_\|GDK_BACKEND" ~/.zshrc ~/.bashrc ~/.profile /etc/environment 2>/dev/null
grep -rn "WEBKIT_" ~/.local/share/applications/ 2>/dev/null
```

如果有，把 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 换成下面的设置即可（它保留硬件加速，只绕开出问题的缓冲区通道）：

```bash
export WEBKIT_DMABUF_RENDERER_FORCE_SHM=1
```

从桌面图标启动时，`.zshrc` 不会生效，需要同步修改启动器：

```ini
Exec=env WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 /usr/bin/agentero %U
```

> 这两个变量在 WebKitGTK 2.52+ 上会让硬件合成和线程化滚动一起失效，导致整个窗口退回 CPU 重绘，CPU 占用会持续偏高。

---

### 命令行工具 (CLI)

想在终端或脚本里管理文献，可以用 Homebrew 安装命令行工具。

```bash
brew tap poco-ai/agentero
brew install agentero

# 查看常用命令与参数
agentero --help

```

---

### 在更多地方使用 Agentero

- **DeepSeek Harness (dsh) 插件**：在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中也能直接使用 Agentero 的文献库、笔记与 PDF 阅读器。执行 `dsh plugin --profile web add @poco-ai/agentero-dsh` 安装，详见 [agentero-dsh-plugin](https://github.com/poco-ai/agentero-dsh-plugin)。

---

## 致谢与社区

* 感谢 [LinuxDo](https://linux.do/) 与 [ModelScope 魔搭社区](https://modelscope.cn/) 成员在项目早期测试阶段提供的建议与反馈。
* 感谢 [AtomGit](https://gitcode.com/poco-ai/Agentero) 提供的国内镜像支持。

### 用户交流群

<p align="center">
  <img src="docs/assets/community-qr.png" alt="Agentero 用户群二维码" width="240" />
  <br/>
  <sub>扫码加入微信群：使用心得、问题反馈与版本预告。二维码 7 天内有效，过期请在 <a href="https://github.com/poco-ai/Agentero/issues">Issue</a> 留言。</sub>
</p>

如果 Agentero 对你的日常学术研究有所帮助，欢迎在 GitHub 上为本项目点亮一个 **⭐ Star**。

感谢所有贡献者！

![contributors img Made with contrib.rocks](https://contrib.rocks/image?repo=poco-ai/Agentero)

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=poco-ai/agentero&type=date&legend=top-left&sealed_token=dKsoXrNYkG3u-nEL3OLp0_aTrlN-GjDpvVEVJvC3xjH13q3viEwwkkB5m6LYT3iKu6LZXtZpQAXalvBwaFQdYgVTjTA1Dzp6NGe_BUQXA1cMt57wNdrYvA)](https://www.star-history.com/?type=date&repos=poco-ai%2Fagentero)

## 开源许可证

本项目基于 [MIT License](LICENSE) 协议开源。第三方组件与许可证清单见 [.github/THIRD_PARTY_NOTICES.md](.github/THIRD_PARTY_NOTICES.md)。
