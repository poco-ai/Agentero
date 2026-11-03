# 开发草稿

本目录只放：

1. **工程规划**（版本切片、发布）
2. **尚未实现**的功能设计稿

已实现功能的说明在 [`../frontend/`](../frontend/index.md) 与 [`../backend/`](../backend/index.md)，按功能分篇。

较大的设计改动先在 GitHub 开 [RFC issue](https://github.com/poco-ai/Agentero/issues/new?template=rfc.yml) 评审，结论收敛后再把设计稿落到本目录。

## 未实现草稿

| 文档 | 主题 |
|---|---|
| [ai-components-migration.md](ai-components-migration.md) | shadcn AI 组件迁移：上游基础件与业务解耦、能力取舍和验证记录 |
| [lifecycle-events.md](lifecycle-events.md) | 生命周期事件系统：语义事件 + 注册式 handler，统一事件命名规范。**已落地**，保留为设计记录（scoped 事件与 teardown 语义、为何不需要 `vault:closed`、为何 `app:will-quit` 延后） |
| [plaza.md](plaza.md) | 广场（Cool Papers / ModelScope 论文 / 推荐 / 播客）。**壳 + 两个站点来源浏览与入库已落地**（`agentero-coolpapers` / `agentero-modelscope` 站点代理）；推荐 / 播客仍为草稿 |
| [webpage-library.md](webpage-library.md) | #821 网页收藏：RSS 入库入口已实现；正文归档、来源去重设计待实现 |
| [plaza-feeds.md](plaza-feeds.md) | 广场订阅 MVP：本地 RSS/Atom 时间线 + 论文入库。**已落地** |
| [usage-analytics.md](usage-analytics.md) | \#239 Activity 总线。P0 存储已落地：XDG `usage.sqlite`（见 [../backend/usage.md](../backend/usage.md)） |
| [zotero-word-integration.md](zotero-word-integration.md) | 官方 Zotero Word 插件 provider 兼容、文档迁移与平台实现评估；2026-10-26 macOS 正文原型已通过官方插件插入、参考文献、保存重开与刷新实测；Windows 已接隐藏消息窗口与正文 COM 驱动，真实 Word 验收与完整 M1 仍待补齐 |
| [cloud-sync-s3.md](cloud-sync-s3.md) | 云同步（S3 兼容）：catalog sidecar 化前置 + 内容寻址 blob/manifest/CAS 同步引擎。**Phase 0–1 已落地**（见 [../backend/sync.md](../backend/sync.md)）；自动同步 / GC / E2EE / 官方托管仍为草稿 |
| [mark-cli-roadmap.md](mark-cli-roadmap.md) | \#170 阅读标注**内置进 CLI**（方案/命令面/边界）+ 基础→上层→Skill；与 [CLI 文档](../backend/cli.md) 分发衔接 |
| [mark-locate-lazy.md](mark-locate-lazy.md) | 文字定位：打开 PDF 再算（惰性，默认主路径） |
| [import-api-abstraction.md](import-api-abstraction.md) | Import 学术 API 抽象层：统一论文元数据、期刊指标、PDF URL 与题录批处理的 trait 与数据结构。**已落地**（`crates/agentero-core` 的 `features/paper/scholar_api/`），保留为设计记录 + 论文元数据重构的剩余缺口清单（`citation_count` 入库断点、`status`/`body_source` enum 化代价、`PaperTag` 生成契约） |
| [mark-locate-eager.md](mark-locate-eager.md) | 文字定位：标注时算（即时 B1 viewer / 可选 B2 headless） |
| [crate-split-roadmap.md](crate-split-roadmap.md) | agentero-core crate 拆分路线：Phase 1/2 已落地（基座 + CLI 数据域迁入、`HostHooks` 事件抽象、CLI 脱离 `agentero_lib`）；留守域耦合清单与 Phase 3 建议 |
| [agent-dx.md](agent-dx.md) | Agent DX：ops 自省 / MCP 对齐 / Skill 削薄。Phase 2 + 精简 3 + 4 已落地；dry-run 与更多 MCP tools 仍为后续 |
| [plugin-api.md](plugin-api.md) | 插件数据面契约：ops 稳定性 / 权限 / `since`，五个公开生命周期事件（webview 内 `onPublic`），`plugins.json`（启动不加载、无设置页），进程内命令面板注册表，以及三个菜单贡献位；本地初版开发宿主已接通命令与受限论文读取，设置入口暂时隐藏（`pluginsSurfaceEnabled`），见 [实现/未决项](../backend/plugins.md) |
| [decision-layer.md](decision-layer.md) | 通用决策层：规则 / System One（jEV/Clef）/ LLM 统一为可插拔 provider + routing。**已落地**（见 [../backend/decision.md](../backend/decision.md)），保留为设计记录 |
| [rust-arch-refactor.md](rust-arch-refactor.md) | Rust 架构重构计划（2026-10-21 更新）：共享业务用例、提交与恢复、Vault 派生状态、论文准备/共享提取、任务生命周期、Agent 上下文六条主线；含前置正确性修复、依赖与验收、旧任务归并及历史裁决。R1 WAL 一致快照、R2 字段原子更新、R3 sync 占用 RAII、A1 共享移动用例已完成；D2 MinerU 在途共享与 B3 原子写基础已落地，长期缓存与跨文件恢复仍按计划推进 |
| [arxiv-source-lifecycle-audit.md](arxiv-source-lifecycle-audit.md) | arXiv 源码与正文生命周期审计（2026-10-24）：各导入入口、TeX / OCR 路由、补资源与在途竞态、正文消费、版本一致性；含隔离复现与修复对应关系；源码补全、竞态和聊天读取已修复 |
| [zhihu.md](zhihu.md) | 知乎开放平台集成：**内置知乎 Agent（直连 HTTP：直答 + 标题检索）+ 设置页凭证已落地**（见 [../frontend/zhihu.md](../frontend/zhihu.md)、[../backend/zhihu.md](../backend/zhihu.md)）；统一 CLI 后端、广场知乎面板、论文找讨论 / 划词插引用仍为设计稿 |
| [A2A.md](A2A.md) | 本机桌面与远端 headless 之间的薄 A2A 任务层：Agent Card + Task，把算力和数据留在服务器。设计草稿，实施未开始 |
| [pdf-babeldoc-parity.md](pdf-babeldoc-parity.md) | BabelDOC 固定版本算法对照；字符级 IR、公式保护、重排与 PDF 导出已接通；Attention 15 页、ResNet 12 页全文对照与修复；第四轮补全字符覆盖、文本矩阵、图内标签及表格可用空间；复杂裁剪、公式对象及算法等价仍未通过 |
| [translate-sentence-anchor.md](translate-sentence-anchor.md) | 全文译文划选按句锚回英文。**已落地**（见 [../frontend/translate.md](../frontend/translate.md)、[../frontend/wiki.md](../frontend/wiki.md)），保留为设计记录。侧栏译文面板不给英文高亮加淡底 |

macOS 签名与公证（已实现流程说明）在 [`../test/macos-signing.md`](../test/macos-signing.md)。

LaTeX 写作与构建能力已落地，项目设置、依赖自动编译、统一底部问题列表、写作问题卡片与日志对话框、SyncTeX、项目补全与大纲见 [`../frontend/latex.md`](../frontend/latex.md)；本机工具链及边界见 [`../backend/latex.md`](../backend/latex.md)。文件树入口与源码、预览一体的项目编辑区见 [`../frontend/writing.md`](../frontend/writing.md)。

本目录没有单独的 Roadmap / TODO 文件：未决项按能力记在对应已实现文档的「限制与后续」里。内置 provider（翻译 / embedding / 正文 OCR）的未决清单——`⟦n⟧` 占位符透传待真实 key 验证、Hunyuan-MT 模板空格待 A/B、目标语言从 en/zh-CN 扩到 37 种、把内嵌 key 换成网关签发的 per-install activation token——在 [`../backend/builtin-provider.md`](../backend/builtin-provider.md) §限制与后续。
