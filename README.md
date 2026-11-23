<p align="center">
  <img src="docs/assets/hero.png" alt="Agentero" width="100%" />
</p>

<h3 align="center">All-in-one 本地科研工作台，让你的 Agent 更好地帮你做科研。</h3>

<p align="center">
  把文献管理与翻译、双链笔记、实验结果和 LaTeX 写作集中到一处，方便人操作，也方便 Agent 直接读取。
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

## 主要功能

以前做科研，往往要同时开着 Zotero、沉浸式翻译、Obsidian、Claude Code、Benchling 和 Overleaf 六个工具来回倒腾。现在，用 Agentero 一个就够了：

- **文献管理与阅读（类似 Zotero）**：支持从各个学术网站和本地一键导入论文，在原版 PDF 上直接阅读、高亮和批注，同时提取结构化文本供 Agent 读取。
- **双语翻译与论文问答（类似沉浸式翻译 / ChatPDF）**：支持划词提问、全文翻译和双语对照阅读，也能直接导出排版还原的双语 PDF。
- **双链笔记（类似 Obsidian / Notion）**：内置 Markdown 编辑器，支持数学公式和双向链接，可以把笔记、实验结果和 PDF 里的具体段落关联起来。
- **接入本地 Agent（类似 Claude Code / Codex）**：直接连接电脑上已有的 Agent 工具和现有订阅，不用额外付费。Agent 回答中引用的内容支持点击跳回本地 PDF 原文核对。
- **实验与文献数据表（类似 Benchling / Airtable）**：在工作区中创建研究表格，用来记录实验结果或整理文献对比指标，支持手动填写，也可以让 Agent 批量读取论文后自动提取填入。
- **本地论文写作（类似 Overleaf）**：直接在软件里编写 LaTeX 论文，支持实时预览、源码与 PDF 双向跳转以及一键插入本地文献引用，遇到编译报错时可以直接交给 Agent 修复。

把这些工具整合到一起，不只是为了少开几个软件。所有研究材料都留在本地，你的 Agent 可以一次性读取完整的上下文，更准确地帮你分析文献、整理数据和修改论文。

---

## 示例



## 快速开始

### 桌面客户端安装 (macOS / Windows / Linux)

从 **[官网 agentero.app](https://agentero.app/)** 或 **[GitHub Releases](https://github.com/poco-ai/agentero/releases)** 下载与你的电脑匹配的安装包。


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
</p>

如果 Agentero 对你的日常学术研究有所帮助，欢迎在 GitHub 上为本项目点亮一个 **⭐ Star**。

感谢所有贡献者！

![contributors img Made with contrib.rocks](https://contrib.rocks/image?repo=poco-ai/Agentero)

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=poco-ai/agentero&type=date&legend=top-left&sealed_token=dKsoXrNYkG3u-nEL3OLp0_aTrlN-GjDpvVEVJvC3xjH13q3viEwwkkB5m6LYT3iKu6LZXtZpQAXalvBwaFQdYgVTjTA1Dzp6NGe_BUQXA1cMt57wNdrYvA)](https://www.star-history.com/?type=date&repos=poco-ai%2Fagentero)

## 开源许可证

本项目基于 [MIT License](LICENSE) 协议开源。
