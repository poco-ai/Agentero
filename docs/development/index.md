# 开发草稿

本目录只放：

1. **路线图 / TODO / 发布**（工程规划）
2. **尚未完成或仍需验证**的功能设计稿

已实现功能的说明在 [`../frontend/`](../frontend/index.md) 与 [`../backend/`](../backend/index.md)，按功能分篇。

## 规划

| 文档 | 说明 |
|---|---|
| [roadmap.md](roadmap.md) | 自 **0.5.0** 起的未来版本切片（无已实现清单） |
| [todo.md](todo.md) | **仅未完成** backlog（按 0.3 / 0.4… 分组） |
| [bug.md](bug.md) | 已知问题语料（精简） |

## 进行中设计

| 文档 | 主题 |
|---|---|
| [plaza.md](plaza.md) | 广场（Cool Papers / 推荐 / 播客） |
| [bundled-cli.md](bundled-cli.md) | 桌面安装包内置 CLI、命令行打开 Vault 与跨平台 PATH 策略 |
| [zotero-word-integration.md](zotero-word-integration.md) | 官方 Zotero Word 插件 provider 兼容、文档迁移与平台实现评估 |
| [chatgpt-web-voice-defense-mvp.md](chatgpt-web-voice-defense-mvp.md) | ChatGPT Web Voice 论文答辩 MVP（桌面主路径已实现，跨平台 smoke test 待完成） |
| [multi-agent-voice-defense-preparation.md](multi-agent-voice-defense-preparation.md) | 会前多 Agent 论文理解、答辩材料整合与单 Voice 实时交互（Phase 0–2 已实现，Phase 3 真实论文评估待完成） |
| [voice-defense-quality-evaluation.md](voice-defense-quality-evaluation.md) | Phase 3 固定论文集、人工评分口径、本地汇总工具与 Go / No-Go 条件 |
| [mark-cli-roadmap.md](mark-cli-roadmap.md) | \#170 阅读标注**内置进 CLI**（方案/命令面/边界）+ 基础→上层→Skill；与 [bundled-cli](bundled-cli.md) 分发衔接 |
| [mark-locate-lazy.md](mark-locate-lazy.md) | 文字定位：打开 PDF 再算（惰性，默认主路径） |
| [mark-locate-eager.md](mark-locate-eager.md) | 文字定位：标注时算（即时 B1 viewer / 可选 B2 headless） |

macOS 签名与公证（已实现流程说明）在 [`../bug_fix/macos-signing.md`](../bug_fix/macos-signing.md)。
