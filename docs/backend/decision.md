# 决策层（Decision Layer）

> 状态：核心引擎已实现。jEV 智能高亮、文件树点击已接入；语义 provider 可配置为
> TypeSafe jEV、Cloudflare Clef 或兼容 System One 的端点。语义决策当前未暴露给前端。

决策层把“需要二选一/多选一/打分”的判断统一成一次 *decision*：给定 `decisionId` 与
`state`，由注册的 provider（确定性规则、System One 决策模型、未来 LLM）给出带来源与
置信度的 `action`。目的是让语义判断与大量确定性 if-else 各归其位，而不是把所有判断都
塞给 AI，也不让决策模型和 hook 架构割裂。

## 核心概念

| 概念 | 说明 |
|---|---|
| Decision | 一次判断任务，例如“PDF 选中文本的意图是什么”。 |
| State | 决策所需上下文，例如 `{ selectedText, page, source: "pdf" }`。 |
| Question | 向 jEV 提出的问题，类型 `score` / `choice` / `noul`。 |
| Rule | 确定性函数：`state -> Option<action>`。 |
| Provider | 具体执行决策的模块：`RuleProvider`、`SystemOneProvider`（jEV/Clef/兼容）。 |
| Routing | 主 provider、fallback provider、fallback 阈值。 |
| ProviderConfig | provider 专属配置，例如 System One 的 questions。 |
| Outcome | 结果：中立信封 `{ action, status, provider, modelVersion }` + provider 专属 `metadata`。 |
| Status | 结果如何得来：`decided`（provider 作答）/ `defaulted`（schema 默认）/ `no_opinion`。 |
| Metadata | provider 专属负载（`confidence`、`probabilities`）；校准不可跨 provider 比较。 |

## 架构

```
业务 hook / 组件
      │  decide(id, state)              ┌── RuleProvider（规则链）
      ▼                                 │
┌──────────────────┐   ┌──────────────┐ │
│ DecisionRegistry │──▶│ DecisionEngine│─┼── SystemOneProvider（HTTP：jEV/Clef/…）
│ id → schema      │   │  route/fallback│ │
└──────────────────┘   └──────────────┘ └── （未来：LLM）
```

- **后端（Rust）**：`crates/agentero-core/src/decision/`，Tauri 无关，CLI 可复用。
- **前端（TS）**：语义决策当前没有前端入口；纯前端状态的规则走 `decideSync` 本地注册表。

## 后端（`agentero-core::decision`）

### Provider trait

```rust
#[async_trait]
pub trait DecisionProvider: Send + Sync {
    fn name(&self) -> &'static str;
    /// Ok(None) = “无意见”，让引擎走 fallback。
    async fn decide(&self, call: ProviderCall<'_>) -> Result<Option<DecisionOutcome>, AppError>;
}
```

`ProviderCall` 携带 `decision_id` / `state` / 该 provider 的 `ProviderConfig` / schema 顶层
规则链。规则因此留在 schema 上（provider 无关），probabilistic provider 只读自己的 config。

### 路由

`DecisionRouting { primary, fallback, fallback_threshold }`：

| primary | fallback | threshold | 语义 |
|---|---|---|---|
| `rule` | — | — | 纯规则 |
| `systemone` | — | — | 纯决策模型（jEV/Clef/…） |
| `systemone` | `rule` | scoped `0.75` | 决策模型置信度低时回退规则 |
| `rule` | `systemone` | — | 规则未命中时让决策模型兜底 |

引擎在以下情况尝试 fallback：主 provider 返回 `Ok(None)`、主 provider 置信度低于阈值、
或主 provider 报错且配置了 fallback（报错被吞掉，让确定性 fallback 仍能作答）。fallback
也无意见时保留主 provider 结果；都没有则用 schema 的 `default_action`（否则 `null`）。

### 校准边界（confidence 与阈值不跨 provider）

不同 provider 的 `confidence` 由各自训练/标定过程产生，**不可直接比较**。因此：

- 结果信封只保留中立字段 `{ action, status, provider, modelVersion }`；
  `confidence` / `probabilities` 一律放进 `DecisionOutcome::metadata`（`outcome.confidence()`
  读取，非有限值视为缺失）。
- `fallback_threshold` 不是裸 `f64`，而是 [`FallbackThreshold`]：它记录该阈值是为哪个
  `provider`（可再 pin 到 `model_version`）标定的。只有当主结果的 `provider` / `modelVersion`
  落在阈值作用域内时才生效；作用域外绝不触发基于置信度的 fallback。
- 当前配置的模型由设置注入请求；provider 把它写进 `DecisionOutcome::model_version`，
  使阈值作用域可被校验、也便于调试。schema 可用 `ProviderRequest::model_version()` 提供
  兜底版本（配置为空时生效）。

这样 jEV、Clef、OpenAI、Laya 各自接入时，阈值随 provider 配置一起定义，不会拿 A 家的
`0.75` 去裁 B 家的分数。默认 schema 只对 `jev-latest` 标定阈值：换到 Clef / 自定义模型后，
置信度 fallback 自动失效，直到为新模型重新标定。

### Built-in providers

- `RuleProvider`：按注册顺序执行规则，`Some` 即停；无置信度（`status = decided`，无 metadata）。
- `SystemOneProvider`：`state + questions -> answers` 的 HTTP 传输 + 答案解码，覆盖 jEV、
  Cloudflare Clef 及兼容端点。`complete(body)` 使用共享 client 的超时；
  `complete_with_timeout` 只覆盖这一次请求，时钟从 `send` 起算。两者都负责 Bearer key、
  错误截断和注入配置的 model，凭证通过 auth 闭包在请求时读设置。`decide` 用 config 构造请求，
  交给 `system_one::interpret_answers` 解码，再把 action/confidence/probabilities 组装成带
  metadata 的 `DecisionOutcome`。

### Provider 配置（设置）

设置项 `decision: DecisionSettings`（旧键 `jev` 仍可读）：

| 字段 | 说明 |
|---|---|
| `provider` | 预设：`jev` / `clef` / `openai` / `custom`。 |
| `baseUrl` | 端点。jEV/Clef/custom 走 System One；OpenAI 预设默认 `https://api.openai.com/v1/decisions`（也可填 `/v1`，传输层会补 `/decisions`）。Clef 填 Cloudflare Worker 运行地址（含 accountId）。 |
| `apiKey` | Bearer key（读回时打码）。 |
| `model` | 请求注入的模型 id（如 `jev-latest` / `clef` / `clef-flash`）。 |
| `smartHighlight` | 实验性 PDF 智能高亮开关。 |
| `smartHighlightConcurrency` | 智能高亮同时在飞的批次数，只能是 1、2、4、16，默认 16。非法值回到 16。 |
| `smartHighlightTimeoutSecs` | 单批超时秒数，30–600，默认 120。从该批请求发出时起算。 |

预设只在设置界面切换时预填 baseUrl/model；`openai` 预填 Decisions 端点与 `gpt-6-luna`。
调用方仍构造 System One 请求体，由 `openai_decisions` 适配器在传输层翻译为
`input` + `questions[]`，并把响应 `answers` 数组还原成 System One 的 map。
设置界面见 `experimental-pane.tsx`。

### System One 共享解码（`providers/system_one.rs`）

jEV 与 Cloudflare Clef 同属 System One 契约，传输与答案解码同处一文件，供各 provider 与
conformance 测试复用：`noul`（概率转 bool）、`choice`（选项键 + 概率/置信度）、`score`
（有序评分，`score/3` 归一）以及 `value`/`label`/`answer` 兜底。解码是保守的——无法识别
的答案一律返回 `None`（无意见），交给 fallback，而不是猜。fixture 覆盖：缺失/越界选项、
多余 answers、超时（transport error）、缺失/非有限 `confidence`。

### 注册

`DecisionEngine` 由 builder 注册 schema（核心层能力，示例见下）。Host 当前不再声明语义
schema，`features/decision/mod.rs` 只装配共享的 `SystemOneProvider` 供智能高亮复用：

```rust
DecisionSchema::new("pdf.selection.intent", "…")
    .routing(DecisionRouting::provider(SYSTEM_ONE_PROVIDER).with_fallback(
        RULE_PROVIDER,
        // 阈值只为默认模型标定；换模型/provider 不会拿它去裁别人。
        Some(FallbackThreshold::for_provider(SYSTEM_ONE_PROVIDER, 0.75)
            .model_version(DEFAULT_SYSTEM_ONE_MODEL)),
    ))
    .rule(|state| /* 空选区 -> ignore */)
    // model 由设置注入，schema 只声明 state 与 questions。
    .provider_config(FnProviderConfig::new(SYSTEM_ONE_PROVIDER, |state| ProviderRequest::new(
        SYSTEM_ONE_PROVIDER,
        json!({ "state": state, "questions": { /* … */ } }),
    )))
    .default_action(json!("ignore"))
```

### 前端入口

目前没有面向前端的 IPC：原 `decide` 命令与前端 `useDecision` hook 已移除，语义决策尚未
暴露给前端。纯前端规则仍走 `decideSync`。

## 前端（React）

语义决策目前只在核心层保留，没有前端调用入口；前端仅保留纯规则决策。

### `decideSync`（纯规则决策）

纯前端状态的判断（文件树点击、UI 开关）不该往返 Host：

```ts
registerDecision<{ node: FileNode }>({
  id: "file-tree.click",
  description: "…",
  defaultAction: "noop",
  rules: [
    ({ node }) => (isLibraryVirtualPath(node.path) ? "select-library" : null),
    // …
  ],
});
const action = decideSync("file-tree.click", { node });
```

注册表在 `src/lib/decision/registry.ts`，无副作用、同步求值。

## 已接入用例

| decision | routing | 触发点 |
|---|---|---|
| `pdf.selection.intent` | System One + 规则兜底（阈值 scoped `jev-latest` 0.75） | schema 设计已落地；Host 当前未注册，原 PDF 选区「智能操作」按钮与前端调用入口均已移除 |
| `paper.auto-tag` | 纯 System One | schema 设计已落地；Host 当前未注册，尚无 UI 入口 |
| `file-tree.click` | 纯规则（前端本地） | 文件树点击 `selectFileNode` |

智能高亮的 HTTP 传输已统一到 `SystemOneProvider::complete`：`features/jev` 保留句子抽取、
问题构造与几何还原等业务逻辑，但不再自建 client、不再自己拼 Bearer 头、不再硬编码模型。
每个句子有 5 个评分问题；单次请求不超过 64 个问题，因此每批最多 12 句。更长的论文按批拆开，
按原顺序合并。实验设置里可选并发 1、2、4、16（默认 16）和单批超时 30–600 秒（默认 120）。
超时从该批 HTTP 请求发出时起算；还在等并发名额的批次不会提前开始计时。

## 边界与后续

- **不是所有判断都进决策层**：文件保存、标签页关闭、简单 UI 状态切换仍由 hook/store 直接处理。
- **规则优先于决策模型**：能用规则确定的不要用 AI（决策模型有 token 成本与延迟）。
- **用户可覆盖**：AI 只给默认建议；UI 上应保留其他选项供用户手动选择。
- **可解释**：`Outcome` 必带中立信封 `{ action, status, provider, modelVersion }`，provider 专属的
  `confidence` 在 `metadata` 里，便于调试与 fallback。
- **provider 可切换**：设置里的 `decision.provider` 决定端点与模型；选 `openai` 时走
  OpenAI Decisions（`gpt-6-luna`），System One 形状由传输层适配。
- **未决**：
  - `pdf.smart-highlight` 仍以领域批处理直接调用 `SystemOneProvider::complete`，未统一为通用
    `decide_batch`（通用批量需要 provider 理解按 state 合并 questions 的语义，暂不抽象）。
  - `paper.auto-tag` 尚无 UI 入口。
  - 决策结果缓存、按 decision 单独选择 provider 尚未实现。
  - `choice` 置信度依赖响应里带 `confidence`/`probability`，缺失时回退到
    `probabilities` 最大值、再退到 `score/3` 归一；越界选项原样透出，由 schema 决定是否接受。

## 文件

| 层 | 路径 |
|---|---|
| 核心引擎 | `crates/agentero-core/src/decision/`（types / registry / engine / providers） |
| System One provider（传输 + 解码） | `crates/agentero-core/src/decision/providers/system_one.rs` |
| OpenAI Decisions 适配 | `crates/agentero-core/src/decision/providers/openai_decisions.rs` |
| Host 装配 | `src-tauri/src/features/decision/mod.rs`（共享 `SystemOneProvider`） |
| 设置（Host） | `src-tauri/src/features/system/settings/mod.rs`（`DecisionSettings` / `decision_config`） |
| 设置（前端） | `src/components/settings/panes/experimental-pane.tsx`、`src/lib/settings/{types,defaults,store}.ts` |
| 前端本地规则 | `src/lib/decision/registry.ts` |
