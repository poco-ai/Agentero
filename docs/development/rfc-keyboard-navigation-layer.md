# [RFC]: Navigator —— 键盘导航、决策层与主动式交互

> 状态：草稿（待评审）  
> 日期：2026-11-10
> 范围：桌面端交互层、Decision Layer、主动式建议；不改变 Vault 文件格式和 Catalog 权威模型

## 摘要

本 RFC 将 Vimium 风格的键盘浏览重新定义为 Agentero 的 Navigator：覆盖文件树、Library、Dockview、PDF、Markdown 和 Agent 的统一交互协议。Navigator 不是快捷键清单，而是把目标、动作、上下文和判断连接起来。

1. **目标（Target）**：可以被定位、聚焦或操作的论文、面板、引用、图表、选区和按钮。
2. **动作（Action）**：打开、跳转、分屏、复制引用、加入 Agent、翻译、标注等可执行操作。
3. **上下文（Context）**：Vault、论文、文件、面板、页码、选区和会话的稳定快照。
4. **判断（Decision）**：在多个动作中选择默认建议，或判断是否值得主动提醒用户。

第一阶段只做键盘导航和元素提示；后续把用户活动、生命周期事件和语义决策接入受控的主动式建议。模型只能产生带来源、置信度、过期时间和风险等级的建议，不能绕过用户直接执行破坏性操作。

原有 C1/C2 方案保留为 Navigator 的第一阶段实现：

1. **PDF 位移键（C1）**：在 PDF 阅读面用 `j/k/h/l/d/u/J/K/gg/G/数字` 完成滚动、翻页与跳页，不涉及 PDF 内容链接提示。
2. **全局元素提示（C2）**：按 `F` 在当前窗口（或最上层对话框）内给可交互元素打字母标签，输入字母直接点击对应按钮，覆盖标签页、标题栏、侧栏、Agent 按钮、PDF 工具栏等应用 Chrome。

两者共享“当前哪个表面拥有键盘”的归属模型，但 UI 与状态机彼此独立。后续阶段扩展为科研对象操作、决策层和主动式建议。

---

## 1. 现有架构

下面的实线表示当前已有的数据和命令流；决策层与前端之间的虚线表示目前尚无通用语义决策入口。C1/C2 是本 RFC 的首个实现切片，尚未落地。

~~~mermaid
flowchart LR
    subgraph UI[React WebView]
        KB[shortcuts.ts / useAppShortcuts]
        CP[Command Palette / command registry]
        Surface[文件树 / Library / Dockview / PDF / Markdown / Agent]
        Store[Zustand 业务 stores]
        Selection[选区上下文 / Ask / Agent composer]
        Lifecycle[生命周期总线]
        Activity[Activity track]
    end
    subgraph Host[Tauri Host 与 agentero-core]
        IPC[Tauri commands / typed events]
        Features[Vault / Paper / PDF / Agent / Jobs]
        Decision[DecisionEngine: rules / System One]
        Vault[Vault 文件与 Catalog SQLite]
        Usage[usage.sqlite]
    end
    KB --> Surface
    CP --> Surface
    Surface --> Store --> IPC --> Features --> Vault
    Surface --> Selection
    IPC --> Lifecycle --> Surface
    Activity --> IPC --> Usage
    IPC -. 前端语义决策入口尚未实现 .-> Decision
~~~

现有边界决定了 Navigator 的接入方式：组合快捷键继续处理固定动作；命令面板继续作为命令目录；Dockview 操作走 DockHandle；选区进入已有 SelectionContext；生命周期事件与 Activity 分开使用。DecisionEngine 已在 agentero-core 内实现规则与 System One provider，当前只有前端同步规则注册表，语义决策没有前端 IPC 入口。详见 [决策层实现](../backend/decision.md)。

## 2. 目标架构

Navigator 被定义为工作台的目标与动作协议，不只是 Vim 键位。键盘、鼠标、命令面板和未来的主动建议，都应通过相同的目标解析和动作执行路径。

| 层 | 职责 | 所有权 |
|---|---|---|
| Surface Adapter | 注册当前可见的论文、文件、面板、引用、图表、选区、按钮 | 各业务表面 |
| Interaction Kernel | 当前键盘归属、模式、hint 标签、上下文快照 | 前端 Navigator |
| Action Registry | 目标支持的动作、风险等级、执行器、确认策略 | 前端业务命令组合 |
| Decision Gateway | 白名单、最小化 state、超时、取消、provider 错误和 trace | Host 与 agentero-core |
| Proactive Coordinator | 触发条件、候选生成、排序、去重、过期和静默策略 | Host 统筹，前端展示 |

~~~mermaid
flowchart TB
    Input[键盘 / 鼠标 / 命令面板] --> Kernel[Navigator Interaction Kernel]
    subgraph Frontend[React 前端]
        Surface[PDF / Library / Tree / Markdown / Agent adapters] --> Targets[Target Registry]
        Kernel --> Targets
        Kernel --> Context[Context Composer]
        Targets --> Resolver[Target + Action Resolver]
        Context --> Resolver
        Resolver --> Actions[Action Registry]
        Actions --> Executor[DockHandle / commands / Ask / marks / Wiki]
        Suggestions[建议界面: status / Agent / task row] --> Resolver
    end
    subgraph Backend[Tauri Host / agentero-core]
        Gateway[Decision Gateway] --> Engine[DecisionEngine]
        Engine --> Rules[RuleProvider]
        Engine --> Semantic[SystemOneProvider]
        Events[Lifecycle + Activity + Job events] --> Coordinator[Proactive Coordinator]
        Coordinator --> Policy[开关 / 时机 / 冷却 / 风险策略]
        Policy --> Candidate[规则 / 决策 / Agent 候选]
        Candidate --> Queue[Suggestion Queue]
    end
    Context --> Gateway
    Queue --> Suggestions
    Executor --> Events
~~~

### 核心契约

- **TargetRef**：kind、稳定 id、Vault/path/paper/page/anchor 等必要定位字段；不传 DOM 节点、React ref 或屏幕坐标。业务表面负责解析与重新验证。
- **NavigatorContext**：当前 Vault、论文、面板、页码、选区、Agent 会话和捕获时间。它是一次操作的冻结快照，不从延迟返回时的活动 tab 偷换上下文。
- **ActionDescriptor**：稳定 action id、可用 target kind、权限、风险等级、执行器和确认要求。现有 command registry 的 handler 优先复用。
- **Suggestion**：trigger、TargetRef、action id、结构化原因、provider/modelVersion、过期时间、风险和状态。它不是可执行命令；接受后仍要经过 Action Registry 的目标与权限校验。

~~~ts
type TargetRef = {
  kind: "paper" | "file" | "panel" | "pdf-region" | "selection" | "ui-control";
  id: string;
  vaultId: string;
  paperId?: string;
  path?: string;
  page?: number;
  anchor?: string;
};

type NavigatorContext = {
  target: TargetRef;
  panelId?: string;
  selection?: SelectionSnapshot;
  agentSessionId?: string;
  capturedAt: string;
  fingerprint: string;
};

type ActionDescriptor = {
  id: string;
  supportedKinds: TargetRef["kind"][];
  risk: "read" | "write" | "external" | "destructive";
  confirm: "never" | "on-suggestion" | "always";
};

type Suggestion = {
  id: string;
  trigger: string;
  context: NavigatorContext;
  actionId: string;
  reasonKey: string;
  provider: string;
  modelVersion?: string;
  expiresAt: string;
  status: "pending" | "accepted" | "dismissed" | "expired";
};
~~~

这里的 SelectionSnapshot 是现有选区上下文在交互层的只读快照，不能整体持久化到建议队列。跨重启建议只保存 TargetRef 和最小定位信息；再次展示或执行前由表面适配器重新解析。

通用 DOM button/link 仅作 hint 兜底。PDF canvas 正文不做全量扫描；引用、图、表、公式由现有 link/layout/selection 解析结果显式注册。目标卸载或 Vault 切换后失效。

## 3. 与决策层结合

Navigator 负责“用户指向哪个目标、有哪些动作”；Decision Layer 负责“多个合理动作里建议哪一个”。文件树节点类型、按钮点击、保存等确定性判断继续留在同步规则或业务代码；PDF 选区意图、导入后的下一步、Agent 结果后续操作这类语义判断才进入异步 Gateway。

~~~mermaid
sequenceDiagram
    participant U as 用户
    participant N as Navigator
    participant G as Decision Gateway
    participant D as DecisionEngine
    participant A as Action Registry
    U->>N: 选中 PDF 内容并请求建议
    N->>N: 冻结 TargetRef 与 NavigatorContext
    N->>G: decisionId + 白名单 state
    G->>D: 路由规则或语义 provider
    D-->>G: action / status / provider / modelVersion / metadata
    G-->>N: DecisionOutcome
    N->>A: 验证 action、目标、权限与风险
    A-->>U: 展示建议及其他可选动作
    U->>A: 接受一个动作
    A-->>N: 执行结果与事件归因
~~~

Gateway 应只接受注册过的 decisionId 和对应 schema，不接受任意前端传来的 provider prompt。它负责 state 最小化、超时、取消、并发限制、错误映射和 trace id。模型返回的 action 必须是该目标允许的 action id；置信度只在同 provider/modelVersion 标定范围内比较。首个用例建议是 PDF 选区意图；规则优先，System One 只做语义兜底。新增 IPC 时按项目契约重新生成 bindings，并运行事件登记检查。

建议的 Gateway 请求形状是 decisionId、版本化 state、context fingerprint 和允许的 action id 列表；返回沿用 DecisionOutcome 的 action、status、provider、modelVersion 与 metadata。Host 按 decisionId 构造 provider 请求，不信任前端提供的任意 prompt 或 action。异步结果返回时先比对 fingerprint，再解析 TargetRef；上下文已变化则丢弃结果。此处是未来契约，当前仓库没有对应 Tauri command。

## 4. 主动式交互

主动式交互的产品行为是：系统观察到明确的工作流节点后，提出一条可解释、可忽略、会过期的下一步建议。建议默认非阻塞，出现在任务完成行、Agent 消息尾部或紧凑状态位；避免在阅读中频繁弹 Toast。

~~~mermaid
flowchart LR
    E[资源就绪 / 任务完成 / Agent 结束 / 搜索无结果] --> Normalize[Event Normalizer]
    Normalize --> Reduce[Context Reducer: 最小必要事实]
    Reduce --> Eligible[Eligibility: 开关 / 当前表面 / 冷却]
    Eligible --> Candidate[规则 / Decision / Agent 候选]
    Candidate --> Rank[排序 / 去重 / 过期 / 退避]
    Rank --> Queue[Suggestion Queue]
    Queue --> UI[任务行 / Agent / 状态位 / 未来 Inbox]
    UI -->|接受| Execute[Action Registry 重新验证并执行]
    UI -->|忽略或稍后| Feedback[记录状态与冷却]
    Execute --> Feedback
    Feedback -. 防止重复触发 .-> Eligible
~~~

首批触发器只选有明确因果关系的事件：现有生命周期总线的 paper:assets-ready 和 job:completed 可以直接消费。Agent 生成文件后的建议需要从现有 Agent 运行终态适配器采集，不应写成已经存在的 agent:completed 生命周期事件；搜索无结果和翻译完成也需要在对应前端业务表面产生本地事实。连续阅读推断、跨论文计划和 Agent 生成候选放在后续阶段。

| 风险 | 示例 | 主动建议处理 |
|---|---|---|
| read | 打开 PDF、定位引用 | 接受后直接执行 |
| write | 创建高亮、Notes 草稿 | 接受后显示目标和写入位置 |
| external | 调用付费 provider、打开外部链接 | 明确成本或目的地，必要时确认 |
| destructive | 删除、移动、覆盖、发送外部消息 | 永远确认；首版不主动建议执行 |

Suggestion Queue 仅持久化 id、trigger、稳定 TargetRef、action、reason key、状态、provider/modelVersion 和过期时间；不保存选区原文、模型请求正文、Agent 私密内容或 DOM 坐标。相同 trigger/target/action 在冷却期只保留一条；执行产生的事件需要由 Coordinator 附带 suggestion id 归因，若扩展 Tauri 事件 payload 则同步 bindings 和事件契约。用户可以全局关闭、按触发器关闭、忽略一次、稍后提醒或永久忽略。Activity 仅记录展示、接受、忽略、过期和执行结果等低敏 facet。

## 5. 实施路线

| 阶段 | 交付 | 验收 |
|---|---|---|
| 0 契约 | TargetRef、Context、Action Registry、Target Registry；复用 command registry 和 DockHandle | 能列出当前表面的目标与动作，现有行为不变 |
| 1 导航 | 原 C1/C2 的 PDF 位移键和 F hint | 无鼠标打开论文、切 Notes、聚焦 Agent；输入/IME 不受影响 |
| 2 科研目标 | PDF 引用/图表/选区、Markdown 块；复制、提问、翻译、标注 | 切 tab、重载或换 Vault 后不会执行悬空目标 |
| 3 决策 | 受限前端 Gateway、PDF 选区意图 | provider 错误和超时不破坏现有选区动作 |
| 4 主动建议 | 资源就绪、任务完成、Agent 结束；队列和关闭设置 | 可接受、忽略、稍后提醒、过期，不重复打扰 |
| 5 工作流 | 阅读计划、论文关系、受限 Agent 候选 | 以接受率、忽略率、错误率和延迟评估效果 |

开放问题：F 是否默认开启；Target Registry 何时成为 plugin API；建议队列是否跨窗口共享；何时需要独立 Inbox。初期采用进程内目标注册、按窗口展示、全局 decision provider 设置和规则优先的保守默认。

## 附录：第一阶段 C1/C2 实现细案

以下细案继承原版 RFC；如与主文的目标契约不同，以主文为准。

## A. 背景与动机

### 现状

| 能力 | 现状 | 限制 |
|---|---|---|
| 全局快捷键 | `src/lib/shell/shortcuts.ts` + `use-app-shortcuts.ts`，以 `⌘/⌃/⌥/⇧` 组合键为主 | 只能覆盖有快捷键的动作；工具栏图标、标签页等空间目标没有入口 |
| 命令面板 | `⇧⌘P` 命令面板 + `src/lib/shell/commands/registry.ts` | 解决"知道动作名"的场景；不知道命令名、或目标是一个具体标签页时无能为力 |
| PDF 滚动 | `keyboard-scroll-handler.tsx`：↑↓ 滚动/翻页；`page-turn-handler.tsx`：分页模式 PageUp/PageDown | 没有 Vim 风格位移键；方向键需要手离开主键区 |
| PDF 跳转 | `use-pdf-navigation.ts` 的 `goToPage`、`use-pdf-find.ts` 的 `findNext/findPrev`、`use-pdf-jump-back.ts` | 能力已存在，但没有统一的键盘入口 |
| 元素标记 | 标题栏已有 `data-tb-sidebar` / `data-tb-agent` 等属性 | 没有统一的可提示目标约定，也没有提示层 |
| 输入保护 | `shortcutBelongsToTextField()`、`isEditableClipboardTarget()`、`EXCLUDED` 选择器 | 可复用，避免单字母键在编辑器/输入框中误触 |

### 痛点

- 高频动作（切标签页、开合 Agent、切侧栏、PDF 工具栏）主要靠鼠标，快捷键覆盖不全。
- 命令面板是"搜索式"入口，无法表达"点左边第二个标签页"这种空间目标。
- PDF 阅读是长时间连续操作，方向键需要手离开 `hjkl` 区域，和用户已有的 Vim/终端习惯断裂。
- 现有 `F` 在非输入状态下没有占用，是低成本切入点。

### 为什么不直接照搬 Vimium

- PDF 是 canvas，不是 DOM，不能全量扫描可点击元素；第一阶段不做 PDF 内容提示。后续只为现有解析结果提供显式目标。
- 桌面应用的按钮密度远低于网页，全量扫描会产生"标签雨"，必须做目标筛选。
- 单字母键必须服从输入框/编辑器/IME 的优先级，不能做成无条件 `window` 监听。

---

## B. 第一阶段目标与非目标

### 目标

- C1：PDF 阅读面支持 Vim 风格位移键，行为与现有方向键/翻页逻辑一致，不新增第二套滚动实现。
- C2：`F` 进入提示模式，给当前作用域内**经过筛选**的可交互元素打标签，输入字母完成点击。
- 两个能力都可以在设置中关闭；默认策略见「开放问题」。
- 不破坏现有快捷键、文本输入、选区批注、命令面板与无障碍焦点顺序。

### 非目标

- 第一阶段不做 PDF 正文/引用/图表的链接提示。
- 第一阶段不做完整的 Vim 模式（normal/insert/visual/寄存器/宏），不引入 `:` 命令行。
- 不做跨窗口提示；多窗口各自独立。
- 不替代命令面板，不把设置页的每个开关都纳入提示。
- 首版不做用户自定义提示键位（`F` 先固定，后续可接入快捷键注册表）。
- 不让模型直接调用任意 DOM、文件系统或 Dockview API。
- 不在第一阶段自动删除、移动、发送消息、修改笔记或提交远程请求。
- 不把所有 if-else、保存流程和简单 UI 状态都迁入 Decision Layer。

---

## C. 方案总览

```mermaid
flowchart TD
    subgraph Input["键盘输入"]
        K1["PDF 阅读面 keydown"]
        K2["窗口级 keydown（非输入态）"]
    end

    subgraph C1["C1: PDF 位移键"]
        O1["ownsPdfKeyboard()<br/>hover / focus / 排除 editable"]
        H1["PdfVimKeyHandler"]
        A1["scroll / scrollToPage / findNext"]
    end

    subgraph C2["C2: 全局提示层"]
        O2["HintModeProvider<br/>F 进入 / 字母过滤 / Esc 退出"]
        T2["useHintTargets<br/>扫描 + 可见性 + 去重 + 优先级"]
        R2["HintOverlay<br/>portal + badge"]
        A2["element.focus() + element.click()"]
    end

    K1 --> O1 --> H1 --> A1
    K2 --> O2 --> T2 --> R2
    O2 --> A2
```

两个子能力共享两条约束：

1. **表面归属**：只有当前表面拥有键盘时才消费按键。PDF 已有 `host.matches(":hover")` + focus 兜底模型；全局提示层用"非 editable + 无修饰键 + 非组合输入"。
2. **不抢原生输入**：`input` / `textarea` / `[contenteditable]` / `select` / 菜单 / 树 / 对话框中，字母键保持原义。

---

## D. C1：PDF 位移键

### 触发与归属

复用 `keyboard-scroll-handler.tsx` 的 ownership 规则，抽出纯函数：

```ts
// src/lib/pdf/keyboard-ownership.ts
export function ownsPdfKeyboard(args: {
  target: EventTarget | null;
  host: HTMLElement | null;
  active: boolean;
}): boolean;
```

规则保持不变：

- 目标在 `[data-pdf-chrome]`、`[role=dialog/menu/tree/grid/...]`、`input/textarea/select/contenteditable` 内 → 不拥有；
- `host.matches(":hover")` → 拥有；
- 否则仅当 `active` 且焦点不在其他可编辑表面时拥有。

### 键位

| 键 | 连续滚动模式 | 分页模式 | 说明 |
|---|---|---|---|
| `j` / `k` | 向下/向上滚动 | 向下/向上滚动（不翻页） | 复用现有 `ARROW_SCROLL_STEP_PX` 或 scroll capability |
| `d` / `u` | 半页 | 半页 | 可选，Phase 1 一并实现 |
| `h` / `l` | 横向滚动 | 上一页/下一页 | 单页纵向布局下 `h/l` 映射为翻页，避免空操作 |
| `J` / `K` | 下一页/上一页 | 下一页/上一页 | 与 Zathura 一致；连续模式也允许整页跳 |
| `gg` / `G` | 文首/文末 | 文首/文末 | 复用 `scrollToPage` / 布局首尾 |
| `{n}G` | 跳到第 n 页 | 跳到第 n 页 | 复用 `goToPage`；`n` 为数字前缀 |
| `n` / `N` | 下一个/上一个搜索命中 | 同左 | 复用 `findNext/findPrev`；无搜索时忽略 |
| `Esc` | 清除数字前缀/退出状态 | 同左 | 不关闭 PDF 标签 |

不处理带 `⌘/⌃/⌥` 的组合键；`⇧` 仅参与大小写区分（`G` vs `g`）。

### 边界

- 不监听 PDF 内容区文本选择层之外的点击；提示层不进入 PDF canvas。
- 与现有 ↑↓ / PageUp / PageDown 并存，不重映射。
- 双窗格（split view）中沿用 hover 归属：鼠标/焦点所在窗格优先。
- 选区非空时，`Esc` 先清选区语义由现有逻辑决定，本 RFC 不改变。

### 文件改动

| 文件 | 动作 |
|---|---|
| `src/lib/pdf/keyboard-ownership.ts` | 新增；从 `keyboard-scroll-handler.tsx` 抽 ownership |
| `src/components/viewer/pdf/viewport/pdf-vim-key-handler.tsx` | 新增；实现上表与数字前缀 |
| `src/components/viewer/pdf/viewport/keyboard-scroll-handler.tsx` | 改为复用 `ownsPdfKeyboard`，行为不变 |
| `src/lib/settings/store.ts` | 增加 `pdfVimKeys: boolean` 与归一化默认值 |
| `src/components/settings/panes/general-pane.tsx` | 增加开关（与 `pdfScrollStrategy` 同组） |

---

## E. C2：全局元素提示

### 状态机

```text
idle
  -- F（非输入态、无修饰键、非 composing） --> collecting
collecting
  -- 字母 --> filtering（追加 query）
  -- Backspace --> filtering（删除一位）
  -- 唯一命中 --> clicking --> idle
  -- Esc --> idle
  -- 滚动 / resize / 窗口失焦 / 目标被卸载 --> idle
```

`collecting` 只在进入时扫描一次 DOM，提示层存活期间不持续监听滚动。滚动、窗口尺寸变化、焦点变化都直接退出，避免标签与目标错位。

### 目标发现

采用"显式标记优先 + 通用选择器兜底"的混合策略，避免全量扫描：

```ts
// 显式目标
const EXPLICIT = "[data-hint]";

// 兜底目标：只在显式目标不足时参与
const GENERIC = [
  "button:not([disabled])",
  "[role='tab']",
  "[role='button']",
  "a[href]",
].join(",");
```

优先级：

| 优先级 | 目标 | 标记 / 来源 |
|---|---|---|
| 1 | 文档标签页、标题栏按钮、侧栏顶部操作、Agent 面板头部、PDF 工具栏 | `data-hint` 或 `data-hint-priority="1"` |
| 2 | 当前可见面板内的主按钮、空状态主操作、批注菜单项 | 通用选择器自动发现 |
| 3 | 设置页控件、下拉菜单、低频开关 | 不进入提示层 |

显式约定：

```tsx
<button data-hint data-hint-priority="1" aria-label="…">…</button>

// 需要排除的容器
<div data-hint-ignore>…</div>
```

过滤规则：

- 跳过 `disabled`、`aria-disabled="true"`、`inert`、`hidden`、`display:none`、`visibility:hidden`、`opacity:0`；
- `getBoundingClientRect()` 宽高均 ≥ 8px，且与视口相交；
- 跳过 `[data-pdf-content]`、`canvas`、`[contenteditable]`、`input`、`textarea`、`select`；
- 嵌套去重：`element.closest("button, [role='tab'], [role='button'], a[href]")`，一个目标只出一个标签；
- 上限 60 个；超出时按 `priority` 升序（1 优先）再按 DOM 顺序截断。

### 标签生成

```ts
// src/lib/keyboard/hint-labels.ts
export function assignHintLabels(count: number, alphabet?: string): string[];
export function matchHintLabel(query: string, labels: string[]): string | null;
```

- 字母表使用主键区、避免易混字符：`asdfghjklqwertyuiopzxcvbnm`，排除 `l/1/o/0` 这类歧义组合中的数字；
- 超过字母表容量时生成两位标签（`aa`、`as`、…），首位先变化，保证前缀可预测；
- 标签大写显示、输入不区分大小写；
- 顺序按目标的视觉位置（上→下、左→右）稳定排序，便于形成肌肉记忆；
- `Backspace` 逐位删除；无命中时保持 `collecting`，不清空已输入前缀，除非用户按 `Esc`。

### 覆盖层

- 通过 `createPortal` 挂到 `document.body`；`position: fixed`，坐标来自进入瞬间的 `getBoundingClientRect()`；
- 覆盖层 `pointer-events: none`，标签本身也默认不接收指针事件，避免拦截用户点击；
- `z-index` 高于普通 UI、低于最上层 Dialog；进入时记录作用域根节点，标签只在根节点内定位；
- 主题：使用 accent/amber 变体，深色文字 + 描边；不使用纯黄底白字；
- 标签 `aria-hidden="true"`，真实按钮保留自身 `aria-label`；
- `prefers-reduced-motion` 下只做透明度变化，不做缩放/位移动画；
- 目标被 React 卸载（`!element.isConnected`）时点击前二次校验，失效则退出。

### 键盘处理

- 监听器注册在 `capture` 阶段，先于 Radix/Dockview 的内部处理；
- 进入条件：`event.key === "F"`（或配置键）、无 `⌘/⌃/⌥`、`!event.isComposing`、`!event.repeat`；
- 输入保护：`target.closest("input, textarea, select, [contenteditable]")` 或 `shortcutBelongsToTextField` 命中 → 不进入；
- 选区保护：`window.getSelection()?.isCollapsed === false` 时不进入，避免打断"选中文本 → 批注"流程；
- 模式期间：字母/Backspace/Esc 由提示层消费并 `preventDefault`；其他键（`Tab`、方向键）默认退出提示层并放行；
- 点击语义：`element.focus({ preventScroll: true })` 后 `element.click()`；对 `role=tab`/`role=button` 同样适用；`disabled` 已在扫描阶段排除。

### 作用域

- 如果存在最上层模态对话框（`overlay-stack` 中的顶部 `modal`，或 DOM 中最后一个 `[data-slot="dialog-content"][data-open]`），**只扫描该对话框内部**；
- 否则扫描当前 `WebviewWindow` 的 `document.body`；
- 不跨窗口、不跨 iframe（应用内若有 iframe，如 PDF 翻译页，不进入提示范围）；
- 提示层本身不注册到 `overlay-stack`，避免被 `Esc` 的全局关闭逻辑误关；它自己处理 `Esc`。

### 可访问性

- 提示层是**并行入口**，不是替代：所有目标仍然可以通过 `Tab` 聚焦，按钮保留可访问名称；
- 进入/退出提示模式时通过 `aria-live="polite"` 播报状态与候选数；退出后清除播报；
- 标签颜色不是唯一信息：同时显示字母，且目标有可见焦点环；
- 不改变 DOM 顺序与 `tabIndex`；
- 对比度满足 WCAG AA；深色/浅色主题分别验证。

### 设置与发现

| 项 | 位置 | 说明 |
|---|---|---|
| `pdfVimKeys` | 设置 → 通用 → PDF | 默认开还是关见「开放问题」 |
| `hintModeEnabled` | 设置 → 键盘 | 关闭后 `F` 不进入提示模式 |
| `F` 提示 | `?` 快捷键帮助 / 键盘设置页 | 复用现有快捷键展示组件 |
| 首次引导 | `use-feature-tour.ts` | 首次进入 PDF 或主窗口时提示一次，可跳过 |
| 命令面板 | 新增命令「键盘提示」 | 方便不知道 `F` 的用户发现；不新增 i18n 段落，复用命令标题 |

---

## F. 数据流

```mermaid
sequenceDiagram
    participant U as 用户
    participant W as window keydown (capture)
    participant P as HintModeProvider
    participant T as useHintTargets
    participant O as HintOverlay
    participant E as 目标元素

    U->>W: 按 F
    W->>P: 非输入态 / 无修饰键
    P->>T: scan(scopeRoot)
    T-->>P: HintTarget[]（已过滤、排序、限量）
    P->>O: render(targets)
    U->>W: 输入字母 a
    W->>P: query = "a"
    P->>P: 匹配唯一标签
    P->>E: focus() + click()
    P->>O: unmount
```

---

## G. 关键类型与设置

```ts
// src/lib/keyboard/hint-targets.ts
export type HintTarget = {
  element: HTMLElement;
  rect: DOMRect;
  priority: number;
  source: "explicit" | "generic";
};

export type HintQueryResult =
  | { kind: "none" }
  | { kind: "partial"; remaining: number }
  | { kind: "unique"; target: HintTarget };
```

```ts
// src/lib/settings/store.ts
type Settings = {
  // …
  pdfVimKeys: boolean;
  hintModeEnabled: boolean;
};
```

不新增 IPC、Rust 命令或 catalog 字段；settings 仍通过现有设置 store 持久化。

---

## H. 替代方案与取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 全量扫描所有 `button/a/[role=*]` | 实现简单，覆盖全 | 设置页/侧栏标签爆炸；视觉噪音大；误点风险 | 不采用 |
| B. 只扫描显式 `data-hint` | 目标可控、稳定 | 需要逐个标注；新按钮容易漏 | 作为第一优先级，配合通用兜底 |
| C. 只增强命令面板 | 零视觉成本 | 无法表达空间目标（具体标签页、具体按钮） | 保留，作为互补入口 |
| D. PDF 内也做提示 | 与 Vimium 一致 | canvas 无 DOM、误报高、与批注/选中冲突 | 明确排除 |
| E. 全局 Vim 模式（normal/insert） | 概念统一 | 与 Markdown/笔记/Agent 输入冲突；状态机复杂 | 不做；只在各表面做局部键盘层 |

本 RFC 选择 **B + 通用兜底 + 对话框作用域**，并把 C1 与 C2 解耦，避免一个功能的失败拖累另一个。

---

## I. 第一阶段实施与验收

### Phase 0：基础设施（0.5 天）

- 抽出 `ownsPdfKeyboard`；
- 增加 settings 字段与归一化；
- 增加 `data-hint` 约定文档（本 RFC 即约定来源）。

验收：`pnpm typecheck` 通过；现有 PDF 方向键行为不变。

### Phase 1：PDF 位移键（0.5–1 天）

- 实现 `j/k/d/u/h/l/J/K/gg/G/{n}G/n/N`；
- 连续/分页/横向三种布局手动验证；
- 编辑器、输入框、菜单中不触发。

验收：

- 连续模式 `j/k` 滚动、`J/K` 翻页、`gg/G` 首尾、`3G` 跳第 3 页；
- 分页模式 `h/l` 与 `J/K` 都能翻页；
- 多窗格下 hover/focus 归属正确；
- 设置关闭后全部失效。

### Phase 2：全局提示层 MVP（2–3 天）

- `HintModeProvider` + `HintOverlay` + `useHintTargets`；
- 先覆盖：标题栏（`data-tb-*` 已存在）、Dockview/写作标签页、右侧 Agent、左侧侧栏、PDF 工具栏；
- 对话框作用域；输入态与选区保护；`Esc/Backspace`；
- `aria-live`、对比度、reduced-motion。

验收：

- 点击标签页/Agent/侧栏/PDF 工具栏按钮均可无鼠标完成；
- 输入框内按 `F` 正常输入字符；
- 打开设置对话框后 `F` 只提示对话框内元素；
- 60 个目标以上时按优先级截断，不出现三位标签；
- 不改变现有 Tab 焦点顺序；
- 无控制台错误、无明显布局抖动。

### Phase 3：打磨与可发现性（1 天）

- `?` 快捷键帮助与命令面板入口；
- feature tour 首次提示；
- 设置开关与键盘页展示；
- 补充纯函数单测：标签生成、前缀匹配、目标去重/过滤。

验收：`pnpm typecheck`、`pnpm lint`、`pnpm deps:check`、相关单测通过；手动走查浅色/深色主题。

---

## J. 第一阶段风险与边界

| 风险 | 影响 | 缓解 |
|---|---|---|
| 单字母误触 | 用户在非输入区按 `F` 进入提示层 | 仅非输入态进入；`Esc` 立即退出；默认可在设置关闭 |
| 标签遮挡内容 | PDF/表格阅读被打断 | 只提示 chrome；标签小、半透明、带描边；滚动即退出 |
| 目标数量过多 | 标签变长、难以扫视 | 显式优先 + 上限 60 + 优先级截断 |
| 动态卸载 | 点击已消失的按钮 | 点击前校验 `isConnected`；滚动/resize 直接退出 |
| Dockview 重渲染 | rect 失真 | 进入时冻结坐标；布局变化即退出 |
| 输入法/组合键 | 中文输入被吞 | 检查 `isComposing`；输入态直接放行 |
| 无障碍倒退 | 读屏用户困惑 | 标签 `aria-hidden`；真实元素保留名称；`aria-live` 播报 |
| 现有快捷键冲突 | `F` 与其他组合键冲突 | 只匹配无修饰键的 `F`；接入快捷键注册表时再评估可配置 |

---

## K. 第一阶段开放问题

- [ ] `F` 默认开启还是首次引导后开启？倾向：默认开启，但在输入态严格放行。
- [ ] `Shift+F` 是否用于"只提示核心 chrome"，还是留给未来的"提示并关闭/次级动作"？
- [ ] 标签页的关闭按钮是否单独出标签？倾向：不出，避免嵌套目标噪音；保留现有快捷键。
- [ ] PDF 工具栏提示是否包括浮动选区菜单？倾向：只包括固定工具栏，浮动菜单继续用原交互。
- [ ] 是否把 `data-hint` 目标注册表暴露给插件 API（`docs/development/plugin-api.md`）？本 RFC 不做。
- [ ] `h/l` 在连续纵向模式下映射翻页是否会造成困惑？备选：连续模式忽略 `h/l`。
- [ ] 是否允许用户自定义提示键与字母表？首版不做，后续接入 `ShortcutOverrides`。

---

## 参考资料

- Vimium C：`f` 链接提示、`unmapAll` 自定义键位、`linkHintCharacters` 字母表。
- Zathura：`j/k` 滚动、`J/K` 翻页、`gg/G` 首尾。
- Sioyek：面向论文阅读的键盘优先设计、引用/图表跳转与返回栈。
- 现有实现：`src/components/viewer/pdf/viewport/keyboard-scroll-handler.tsx`、`page-turn-handler.tsx`、`src/hooks/use-app-shortcuts.ts`、`src/lib/core/overlay-stack.ts`、`src/lib/shell/commands/registry.ts`。
- 相关文档：[`frontend/pdf.md`](../frontend/pdf.md)、[`frontend/shell.md`](../frontend/shell.md)、[`frontend/settings.md`](../frontend/settings.md)、[`development/plugin-api.md`](plugin-api.md)。
