# shadcn AI 组件迁移（2026-11-03）

目标：尽量复用上游组件并让基础件独立升级；保留 AI SDK 和 Streamdown，不以删除依赖数量作为验收指标。

## 规划与实现

三条并行工作线先研究官方 Radix Nova registry 与 GitHub 实现，再划分文件所有权：

1. 消息与输入：Message、Bubble、Attachment、Code Block、增量高亮；科研渲染拆出基础件。
2. 过程展示：Trace 承载 Reasoning / Tool / Plan，Marker 承载 Checkpoint，Shimmer 使用上游 CSS utility。
3. 滚动与文件树：Message Scroller 跟底，保留 TanStack 虚拟化；文件树业务移出旧上游组件目录。

已移除 `components/ai-elements/`。基础件在 `components/ui/`，应用组合在 `components/agent/`，科研渲染在 `agent/rendering/`，输入状态在 `agent/composer/`，文件树状态在 `sidebar/file-tree/`。AI SDK 类型继续使用。

上游来源：

- [AI Elements patterns 与迁移对照](https://ui.shadcn.com/docs/ai-elements)
- [官方仓库](https://github.com/shadcn-ui/ui)
- registry：`https://ui.shadcn.com/r/styles/radix-nova/{name}.json`，采用 message、bubble、attachment、code-block、use-highlighted-code、trace、marker、message-scroller。

`AGENTS.md` 约定优先复用上游公开组合接口，基础组件不能导入业务。dependency-cruiser 检查新增 AI primitives 的反向业务依赖。

## 保留的业务适配及原因

| 能力 | 取舍 |
|---|---|
| Markdown | 共用 `rendering/message-response`，保留公式静态模式、引用定位、公式复制、表格和 Mermaid |
| 代码 | 上游增量高亮代替自建 token 缓存；复制在业务层调用 Tauri 兼容剪贴板；Shiki 语言使用内置懒加载器 |
| 输入 | 继续使用 Input Group，保留 IME、contenteditable token、附件状态和 ACP 提交；附件展示使用 Attachment |
| 队列 | 用户待发送消息不是 Agent todo，保留 Collapsible / ScrollArea 组合 |
| 模型选择 | 官方允许搜索场景继续用 Command，保留分组搜索与推理强度 |
| 文件树 | 当前是平铺虚拟行，不能硬套递归 Collapsible；用 Button / Slot 组合保留多选、拖放、重命名 |
| 长会话 | 80 行启用虚拟化，整个虚拟画布注册为一个 Item；历史跳转用 virtualizer，viewport 由业务 context 传递 |

上游组件不承担 ACP、Vault、PDF 状态。未为已知上游 issue 添加未经复现的补丁。后续升级先检查 registry diff 与上游能力，再决定删除本地适配。

## 验证

新增有实际行为覆盖的回归：推理手动折叠、流式代码 grammar continuation、语言回退、79→81→3 行时 viewport 与虚拟化切换。复用已有公式、引用、输入、图片和文件树测试。

检查结果：TypeScript、全库 Biome（error 级别）、dependency-cruiser、Vite 生产构建通过。全量 Vitest 为 330 文件通过、4 跳过，另 2 文件的 3 例在构建与测试并行时超时；停止资源争用后独立复跑这 2 文件，18 例全部通过。未修改测试超时或性能门槛。

computer use 使用临时测试知识库 `/tmp/agentero-ai-migration-vault`；先运行开发前端，随后验证生产构建。测试 Host 是仓库已有的 2026-10-30 debug executable，包装为临时 app 供原生 UI 自动化识别。标准 `pnpm tauri dev` 已尝试，但现有 Tauri 版本不匹配，Rust 依赖重编译未完成；本次不修改 Host。

已实际验证：知识库与笔记打开、树展开及多选、Agent 空态、中文输入、用户消息公式显示、提交与等待状态、运行中待发送队列、模型搜索、原生图片选择、Attachment 展示及移除。默认本地模型返回重试信息；切换 Cursor 后 Host 返回 `Authentication required` 并正确显示登录按钮，未代用户登录。因此不能把它作为正常模型回复与完整流式回归的证据。

尚未完成的真实交互验收：长会话上滚/跟底/回最新、完整工具与推理回放、PDF 全部浮层、移动设备与 Windows 125% 缩放、中文 IME 候选确认。对应纯逻辑与组件测试可提供部分覆盖，不能代替这些平台交互验证。
