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

## 第二轮：扩大上游复用

- `AskUserQuestionForm` 从 640 行降至约 207 行，用 `@shadcn/react/questionnaire` 管理交互，移除手写分页、选项焦点、逗号反解析与验证状态。多选在 UI 内保持结构化，仅在 ACP 回传边界序列化。
- `ui/questionnaire` 来自官方 `apps/v4/registry/bases/radix/ui/questionnaire.tsx`，按官方 `registry/styles/style-nova.css` 展开样式，避免未编译的 `cn-*` 模板类无效。
- 聊天图片与视觉批注共用 Attachment 预览组件，代码块头部与操作区复用现有 CodeBlock 部件。
- 来源列表用 Trace 并去重，行内引用用 HoverCard + Button/anchor，保留科研链接重写与跳转。
- Terminal renderer 仅处理 ACP `kind=execute` 的 command、可选 cwd 与 stdout / stderr / exitCode / metadata，完整展示 metadata。未知结构回退通用工具卡，退出码只来自结构化字段。
- 不添加缺少结构化数据的 Subagent / Test Results 展示，不将日志猜测结果伪装成结构化状态。权限弹窗已用 Dialog / Button 且保留 ACP 多选项授权语义。

第二轮新增回归覆盖问卷必填/可选跳过/多选/自由输入/失败恢复/焦点进度、来源去重和引用路由、图片预览、代码复制下载与 Terminal 降级。真实 Agent 实验指定使用 OpenCode。

OpenCode 实验发现旧 Host 把 ACP array elicitation 的选项丢弃并当成文本输入，且回传仅支持字符串。修复时沿用上游 `MultiSelectItems` / `ElicitationContentValue::StringArray`，Host、bindings、前端问题适配与问卷保持类型化数组。该修复来自真实交互复现，新增 schema→UI 与回答→wire 回归。

第二轮自动验证：最终目标 8 个前端测试文件共 69 项通过；全库 Biome error 级别、TypeScript、依赖边界和 Vite 生产构建通过。`AGENTERO_UPDATE_BINDINGS=1 cargo test -p agentero export_typescript_bindings` 与 2 个 `elicitation_tests` 通过；新的 desktop Host 已成功编译。OpenCode 免费模型额度耗尽后，改用该 OpenCode 已配置的 GLM 模型，成功返回中文、公式、表格和代码，并发起真实提问。CLI 的只读 printf 实验也实际执行并返回 stdout；不把模型自己的成功描述当成测试结果。

最终生产构建 + 新 Host 的 computer use 已确认：必填错误、单选、三项复选框、页码进度、跳过可选题、数组回答回传和 OpenCode 继续执行。模型的回复明确复述了所选项；引用链接可打开演示库本地 PDF（演示 PDF 仅一页，不据此声称验证了任意页码定位）。前后截图保存在 `/tmp`，不提交仓库。

真实 OpenCode 工具使用 `command + cwd`，原 Host 仅转发 rawOutput metadata、漏掉 ACP 原生 content 文本。现在两条工具事件通路共用输出适配：将原生文本补到 stdout，不覆盖已有 stdout，原始 metadata 或非对象 rawOutput 保留，仍走既有 32 KiB 上限。新 Terminal 可显示真实命令输出而非只在人工样例下生效。

终端修复后的最终验证：类型检查与生产构建通过，最新 5 文件 16 项前端回归通过，新增原生输出 Rust 回归及再次 bindings 生成通过，desktop Host 编译通过。在最终生产构建与新 Host 中，computer use 展开 OpenCode 执行链，实际看到 `printf component_migration_probe`、工作目录、stdout、退出码 0 与完整 metadata。终端截图在 `/tmp/agentero-ai-round2-terminal.png`，问卷对比在 `/tmp/agentero-ai-round2-before.png`、`/tmp/agentero-ai-round2-after.png`。
