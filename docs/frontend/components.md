# 组件约定

## AI Elements

Chat / Agent UI 使用 [shadcn/ui AI Elements](https://ui.shadcn.com/docs/ai-elements) 的 Radix patterns，并复用当前 `radix-nova` 基础组件。

- 上游基础件落盘：`src/components/ui/`。安装前用 `pnpm exec shadcn view <name>` 对比，按需添加，禁止批量覆盖已有组件。
- 应用组合位于 `src/components/agent/`：`elements/` 为过程展示与队列，`composer/` 为输入状态与附件，`rendering/` 为科研 Markdown、引用及代码展示。旧 `ai-elements/` 目录已移除。
- 主题跟 shadcn token；**不是** Vercel AI SDK `useChat`（传输层为 ACP）。
- `ui/message`、`bubble`、`trace`、`code-block`、`attachment`、`message-scroller` 保持上游通用接口，通过 props / children 组合业务；不导入 ACP、Vault、PDF、业务 store 或 IPC。`pnpm deps:check` 检查这条边界。
- 保留 AI SDK、Streamdown 等成熟依赖；只有确认无消费者才删除，不为减少依赖重新实现基础能力。

待发送队列与官方 Agent todo Queue 语义不同；模型选择器需要 Command 搜索；Vault 文件树需要多选、拖放和重命名。这些能力用基础组件组合，不能用精简展示示例替代。

提问表单使用 `ui/questionnaire`，分页、选择、自由输入、校验与焦点由 `@shadcn/react/questionnaire` 管理；业务只负责 ACP 问题/答案转换、折叠和异步提交恢复。该基础件按官方 Radix 源码与 Nova style 展开，禁止在基础件里处理协议回传。

待发送与已发送图片均使用 Attachment；已发送图片与视觉批注共用 `agent/chat-image-gallery.tsx` 的预览交互。代码块复用 Code Block 的 Header / Title / Actions，Tauri 剪贴板与文件下载保留在业务层。

引用来源列表用 Trace Sources 组合并按 URI 去重；行内引用用 Hover Card + Button/链接组合，Vault/PDF 跳转仍经项目解析器。Terminal pattern 只接受可验证的 ACP execute 命令、可选 cwd 与文本输出，保留完整 metadata；未知字段回退通用 Tool，退出码只读结构化字段，不能从日志猜测或隐藏参数。

Agent / Reasoning 消息里的 Markdown：`Streamdown` + `PlainTable` / `PlainCodeBlock`（代码块左上角语言标签，悬停复制/下载；无外侧卡片，见 [agent.md](agent.md)#消息-markdown-渲染）。

## 表面与层级

浮层统一走主题阴影阶梯，不在业务组件里写 `shadow-lg` / `shadow-2xl`：

| Token | 用途 |
|---|---|
| `shadow-raised` | 可悬浮的卡片 / 按钮 hover，轻量抬升 |
| `shadow-overlay` | Popover、Dropdown、ContextMenu、Select、Tooltip、Toast、PDF 浮卡 |
| `shadow-dialog` | Dialog / Command 主模态 |

阴影值定义在 `src/index.css`（`--agentero-shadow-*`，暗色单独增强）；浮层仍保留 `ring-1 ring-foreground/10` 发丝边，白底时不靠阴影硬撑边界。菜单容器用 `p-1.5`、菜单项用 `px-2 py-1.5`，与 `Button` 的 24 / 28 / 32 / 36 控件高度阶梯对齐；自绘菜单（文件树右键、编辑器补全）按同一组尺寸复刻。

## 交互态

列表行（论文库、PDF 目录、设置导航、文件树）的 hover / 选中底色落在整行容器上。只读单元格不再叠加内容宽度的 hover 底色；可编辑单元格用尾随铅笔 / 下拉图标提示，行底色由表格行统一提供。PDF 书签编辑行把 hover 放在整行 `<fieldset>` 上，尾部操作按钮也共享同一底色。设置页侧栏的选中态保持平层，不加阴影。

## 业务组件目录

| 目录 | 职责 |
|---|---|
| `components/shell/` | 三栏壳、标题栏、对话框挂载 |
| `components/sidebar/` | 文件树、Paper Info、LaTeX 面板、魔棒 |
| `components/writing/` | 写作工作面：阅读 / 写作切换、项目列表、源码与 PDF |
| `components/workspace/` | Dockview 宿主与 panel 内容 |
| `components/library/` | 论文库表 |
| `components/editor/` | Plate Markdown |
| `components/viewer/` | PDF / HTML / 图片。对外只经 `viewer/index.ts`；内部 `pdf/`（外壳 + `hooks/` + `layers/` + `chrome/` + `cards/` + `viewport/`）、`panels/`（右栏面板） |
| `components/agent/` | Agent 面板。外壳 + `hooks/`（面板与 composer 状态）+ `composer/`（输入区子件） |
| `components/wiki/` | 反链列表 / 引用近邻图（`graph-panel`） |
| `components/settings/` | 设置页 |
| `components/dialogs/` | 命令面板、权限、迁移等 |
| `components/ui/` | shadcn 基础件；`math-text.tsx` 用 KaTeX 渲染标题内联公式（`$\\pi$`） |

## 状态订阅

组件经 `hooks/use-app-stores.ts` selector 订阅；避免整树重渲染。命令式 dock/布局经 registry，不把 DOM ref 塞进 zustand。
