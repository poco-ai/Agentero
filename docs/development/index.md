# 开发草稿

本目录只放：

1. **工程规划**（版本切片、发布）
2. **尚未实现**的功能设计稿，以及仍要对照实现的设计记录

已实现功能的说明在 [`../frontend/`](../frontend/index.md) 与 [`../backend/`](../backend/index.md)，按功能分篇。

较大的设计改动先在 GitHub 开 [RFC issue](https://github.com/poco-ai/Agentero/issues/new?template=rfc.yml) 评审，结论收敛后再把设计稿落到本目录。

## 未实现草稿

| 文档 | 主题 |
|---|---|
| [rfc-scholarly-data-resolution.md](rfc-scholarly-data-resolution.md) | 学术数据解析与补全 RFC：来源编排、身份与字段证据、venue、PwC、机构 PDF 获取边界。**设计稿，待评审** |
| [usage-analytics.md](usage-analytics.md) | \#239 Activity 总线。P0 存储已落地：XDG `usage.sqlite`（见 [../backend/usage.md](../backend/usage.md)） |
| [decision-layer.md](decision-layer.md) | 通用决策层：规则 / System One（jEV/Clef）/ LLM 统一为可插拔 provider + routing。**已落地**（见 [../backend/decision.md](../backend/decision.md)），保留为设计记录 |
| [A2A.md](A2A.md) | 第一版是本机 Agent 经已连接的远程 Vault SSH 委派远端 CLI Agent。完整 Agent Card + Task 仍是草稿 |

macOS 签名与公证（已实现流程说明）在 [`../test/macos-signing.md`](../test/macos-signing.md)。

LaTeX 写作与构建能力已落地，项目设置、依赖自动编译、统一底部问题列表、写作问题卡片与日志对话框、SyncTeX、项目补全与大纲见 [`../frontend/latex.md`](../frontend/latex.md)；本机工具链及边界见 [`../backend/latex.md`](../backend/latex.md)。文件树入口与源码、预览一体的项目编辑区见 [`../frontend/writing.md`](../frontend/writing.md)。

本目录没有单独的 Roadmap / TODO 文件：未决项按能力记在对应已实现文档的「限制与后续」里。内置 provider（翻译 / embedding / 正文 OCR）的未决清单——`⟦n⟧` 占位符透传待真实 key 验证、Hunyuan-MT 模板空格待 A/B、目标语言从 en/zh-CN 扩到 37 种、把内嵌 key 换成网关签发的 per-install activation token——在 [`../backend/builtin-provider.md`](../backend/builtin-provider.md) §限制与后续。
