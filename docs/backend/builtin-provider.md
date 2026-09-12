# 内置 Provider（翻译 / Embedding / 正文 OCR）

`agentero` 是一个内置 provider id：凭证在**构建期**编入 Host，用户选中它之后不需要填任何 baseUrl / API Key / model，设置面板也不为它渲染凭证卡片。它是新装用户的默认选项（仅当本次构建注入了 key）。

三个消费方：

| 能力 | 设置项 | 模型兜底 |
|---|---|---|
| 翻译 | `translate.provider` | `tencent/Hunyuan-MT-7B` |
| arXiv Daily 推荐 embedding | `embedding.source` | `BAAI/bge-m3` |
| `PAPER.md` 正文解析 OCR | `layout.parserBackend` | `PaddlePaddle/PaddleOCR-VL-1.5` |

代码：`src-tauri/src/features/system/builtin/mod.rs`（凭证模块）、`crates/agentero-core/src/features/translate/sources/hunyuan_mt.rs`（翻译 source）、`src-tauri/src/features/system/settings/mod.rs`（embedding / layout 凭证解析）、`src-tauri/src/features/paper/analyze/body_engines/`（引擎注册）。

---

## 构建期环境变量

| 变量 | 兜底 | 秘密 |
|---|---|---|
| `AGENTERO_BUILTIN_BASE_URL` | `https://api.qiyuanchen.top/v1` | 否 |
| `AGENTERO_BUILTIN_API_KEY` | 无——必须注入 | **是** |
| `AGENTERO_BUILTIN_TRANSLATE_MODEL` | `tencent/Hunyuan-MT-7B` | 否 |
| `AGENTERO_BUILTIN_EMBEDDING_MODEL` | `BAAI/bge-m3` | 否 |
| `AGENTERO_BUILTIN_OCR_MODEL` | `PaddlePaddle/PaddleOCR-VL-1.5` | 否 |

- 五个变量全部经 `option_env!` 在 Rust 侧**编译期**解析（形态为 `option_env!(...).map(str::trim).filter(|v| !v.is_empty())`，空白串等同未设置）。TS 侧不读任何 `AGENTERO_BUILTIN_*`：`import.meta.env.VITE_*` 会把 key 内联进 JS bundle，等于把秘密发到 webview，因此明确不走那条路。
- 用 `option_env!` 而非 `env!`：`env!` 在变量缺失时编译失败，会打断本地 dev / contributor / 无 secret 的 CI。仓库必须能在没有任何 secret 的情况下构建。
- 没有注入 key 的构建里 `available()` 为 `false`，`builtin_provider_status` 返回 `available: false`，UI 隐藏或禁用内置选项，`default_translate_provider()` / `default_parser_backend()` 回落到 `tencenttransmart` / `local`，`embedding_config()` 穿透到已存值（仍为空则返回 `None`，照常触发 `recommend.no_embedding`）。
- 既有先例：`posthog_key()`（`src-tauri/src/core/telemetry/mod.rs`）用的就是同一套 `option_env!` + trim + filter-empty，见 [telemetry.md](telemetry.md) §开关语义。

**构建脚本转发**：`src-tauri/build.rs` 的 `forward_build_env()` 为全部六个变量（`AGENTERO_POSTHOG_KEY` 加五个 `AGENTERO_BUILTIN_*`）发 `cargo:rerun-if-env-changed`，并在环境变量缺失时回退读仓库根 `.env`（gitignored），经 `cargo:rustc-env=` 重新导出。因此

- 本地既可以直接导出环境变量，也可以把 `AGENTERO_BUILTIN_API_KEY` 写进 `.env`；显式环境变量优先。
- 改变量值会触发 `src-tauri` 重编。这一条是必需的而非便利：cargo 默认不追踪 `option_env!` 读到的变量，缺了 `rerun-if-env-changed` 时换 key 不会重编，发布包会静默带着旧值或空值出去且毫无征兆。
- 运行时 `std::env::set_var` 仍然改变不了已解析的值——`builtin/mod.rs` 的测试块里有注释标注这一点。

---

## 密钥边界

- 唯一读取口是 `builtin::api_key()`；baseUrl 与三个 model 访问器保持私有，Host 消费方统一走 `status()`。
- `builtin_provider_status` 只返回非秘密字段 `{ available, baseUrl, translateModel, embeddingModel, ocrModel }`。测试断言序列化后既没有 `key` / `apiKey` / `secret` / `token` / `auth` / `credential` / `mask` 这类字段名，也不含 key 本身（无前缀、无长度、无 mask、无 hash 派生物）。
- 内置 key **不写入 `AppSettings`**：`normalize_layout_provider_configs` 的 `PROVIDERS` 白名单是 `["paddle", "mineru", "openaiCompatible"]`，任何 `agentero` 卡片在每次保存时被 `retain` 丢弃并由 `persist` 写盘，所以它进不了 `settings.json`，也就到不了 webview。`redact_secrets` / `merge_secrets` 只处理固定字段清单，`AppSettings` 上的新字段一律会被回显给 webview——这是不给内置 key 加设置字段的原因。
- 前端只消费 `available` 一个字段；baseUrl 与 model id 不显示到 UI。

## 网关与真实的安全边界

`AGENTERO_BUILTIN_BASE_URL` 的兜底 `https://api.qiyuanchen.top/v1` 是产品方**自己的网关**，不是直连上游 provider。这是「客户端内嵌 key」风险可控的前提：model 白名单、per-IP 限流、花费上限与**上游** key 轮换都能在服务端强制。

但不要过度声称安全：

- **内嵌在已发布客户端二进制里的 key，对拿到安装包的人仍然是可提取的**——`strings` 扫二进制，或者用户在自己机器上跑 mitmproxy 看 `Authorization` 头即可。网关限制的是损失面（能调哪些 model、调多少），**不能阻止提取**。
- 因此对外文案不应把它描述为「安全」或「用户拿不到 key」。
- 彻底解法（未实现）：把内嵌 key 换成网关签发的 **per-install activation token**，届时可获得吊销与 per-user 配额，而客户端 provider 形状不变。

## 编译期语义的运维后果

- 因为是**编译期**变量：换 model id、或轮换**客户端侧** key，都必须发新版才能生效。
- 网关侧轮换**上游** key **不需要**发版——客户端只认网关。
- 发布构建必须注入 `AGENTERO_BUILTIN_API_KEY`（其余四个可选）。步骤与 secret 约定见 [../test/release.md](../test/release.md) §内置 Provider 构建期注入。

---

## 翻译：Hunyuan-MT

`tencent/Hunyuan-MT-7B` 是**专用 MT 模型**，不是 instruct 模型：它只遵循自己被微调过的那套模板。因此内置路径刻意**不复用** `openai_compatible.rs` 的长规则提示词，也**不给模型看 `[[n]]` 批量标记**（那套对齐协议依赖指令遵循）。

| 项 | 值 |
|---|---|
| 模板（逐字） | `Translate the following segment into <target_language>, without additional explanation.<source_text>` |
| 消息形状 | 单条 user message，**无 system message**（对比 `openai_compatible.rs` 是 system + user） |
| 源语言 | 模板里没有它的位置；模型自动检测，`sourceLang` 不参与 |
| `temperature` | `0.2`（沿用 `openai_compatible` 惯例；技术报告未规定解码参数） |
| 端点 | `{base_url}/chat/completions`，`Authorization: Bearer <key>` |

### `[[n]]` 批量：Host 侧拆分与重组

前端仍按 `buildNumberedPayload`（`src/lib/pdf/layout/layout-translate.ts`，批内 payload ≤ `LAYOUT_TRANSLATE_BATCH_CHARS` = 4500 字符）产出 `[[n]]` 编号批次，见 [../frontend/translate.md](../frontend/translate.md)。Host 收到后：

1. 按字节扫描**行首**的 `[[n]]`，要求从 1 开始递增；遇到行中标记或乱序即停止扫描（避免把含字面 `[[1]]` 的散文切碎），余下文本留在当前段内。
2. 标记 1 之前的文本作为无标记段；每段 trim，空段丢弃。
3. 每段一个独立请求，`StreamExt::buffered(3)`——既有并发上限又保证结果顺序，省掉索引管线。并发数 3 对齐 `openai_vlm.rs` 的 `PAGE_CONCURRENCY`。
4. 重组为 `"{marker} {text}"` 以 `"\n\n"` 连接，与前端 `buildNumberedPayload` 的输出字节一致。

段数少于前端预期时，`parseNumberedTranslation` 返回 null 并**回退为逐段翻译**，段落不会错位。

`⟦n⟧` 行内占位符（前端 `mask.ts` 用于保护引用 / URL / 行内公式）**原样透传**，不剥离。这是一个**未经真实 key 验证的假设**，见下方「限制与后续」。

### 语言映射

代码只映射 Rust 实际可能收到的值：`en` → `English`，`zh-CN`（含 `zh` / `Chinese`）→ `Chinese`，另有防御性的 `ui` → `English`，未知值 / `auto` / 空 → `English` + debug 日志。查表大小写不敏感，也接受英文名本身。

真正的约束在 UI：目标语言白名单是 `settings/mod.rs` 的 `TR_TARGETS = ["ui", "en", "zh-CN"]`，前端 union 是 `TranslateTargetLang = "ui" | "en" | "zh-CN"`，而 `"ui"` 在前端解析阶段就已经换成 en / zh-CN。所以 Hunyuan-MT 更宽的语言支持目前**不可达**。完整 37 语言表见下方，作为将来扩目标语言的依据。

### 错误

- 构建里没有 key 时，`src-tauri/src/features/translate/commands.rs` 在任何 `.await` 之前返回 `AppError::domain(ERR_NO_BUILTIN_KEY)`，标记为 `translate.no_builtin_key`，而不是放一个无法认证的请求出去。
- `finish_reason` 为 `length` / `max_tokens` / `content_filter` 时报「translation incomplete…retry with a smaller chunk」。
- `"agentero"` 刻意**不在** Rust 的 `FREE_PROVIDERS` 里（CLI `cli/src/commands/translate.rs` 用它门控 `--provider`，随后以 `api_key: None` 调用，会让 CLI 接受一个无法认证的 provider），也**不在** `COMMERCIAL_PROVIDERS` 里（那个列表驱动 WebView 凭证卡片，内置 provider 不该渲染任何卡片）。
- **两份「免费 provider」清单刻意不一致**：前端 `FreeTranslateProviderId` / `FREE_MT_PROVIDER_IDS`（`src/lib/translate/types.ts`）**含** `agentero`——这样它复用无 key 引擎的管线、且因为不是 `CommercialTranslateProviderId`，`translate-pane.tsx` 不会为它渲染凭证卡片，`COMMERCIAL_MT_DEFAULT_BASE_URLS` / `COMMERCIAL_MT_DOCS_URLS` 这两个 total Record 也不需要新条目。Rust 的 `FREE_PROVIDERS` **不含**它（理由见上条）。改任何一份清单时都要意识到另一份是反的。
- 探测：`probeFreeMtProviders` 显式把 `agentero` 过滤掉（探测它会真的发一次翻译请求），可用性只来自 `builtin_provider_status`。

### 支持语言（Hunyuan-MT，37）

代码只实现上节所述的可达值；下表是模型侧的完整支持面，扩 `TR_TARGETS` 时按 Abbr 对照。

| English name | Abbr | 中文名 |
|---|---|---|
| Chinese | zh | 中文 |
| English | en | 英语 |
| French | fr | 法语 |
| Portuguese | pt | 葡萄牙语 |
| Spanish | es | 西班牙语 |
| Japanese | ja | 日语 |
| Turkish | tr | 土耳其语 |
| Russian | ru | 俄语 |
| Arabic | ar | 阿拉伯语 |
| Korean | ko | 韩语 |
| Thai | th | 泰语 |
| Italian | it | 意大利语 |
| German | de | 德语 |
| Vietnamese | vi | 越南语 |
| Malay | ms | 马来语 |
| Indonesian | id | 印尼语 |
| Filipino | tl | 菲律宾语 |
| Hindi | hi | 印地语 |
| Traditional Chinese | zh-Hant | 繁体中文 |
| Polish | pl | 波兰语 |
| Czech | cs | 捷克语 |
| Dutch | nl | 荷兰语 |
| Khmer | km | 高棉语 |
| Burmese | my | 缅甸语 |
| Persian | fa | 波斯语 |
| Gujarati | gu | 古吉拉特语 |
| Urdu | ur | 乌尔都语 |
| Telugu | te | 泰卢固语 |
| Marathi | mr | 马拉地语 |
| Hebrew | he | 希伯来语 |
| Bengali | bn | 孟加拉语 |
| Tamil | ta | 泰米尔语 |
| Ukrainian | uk | 乌克兰语 |
| Tibetan | bo | 藏语 |
| Kazakh | kk | 哈萨克语 |
| Mongolian | mn | 蒙古语 |
| Uyghur | ug | 维吾尔语 |
| Cantonese | yue | 粤语 |

---

## Embedding：arXiv Daily 推荐

`EmbeddingSettings` 新增 `source: "builtin" | "custom"`。它是普通的 `#[serde(default)]`（空串即「未设置」），**不是** `default = "..."` 返回 `"builtin"`：否则一个填了 BYOK 字段但没有 `source` 键的旧 `settings.json`，与「用户显式选了内置」无法区分。

**迁移规则**（Rust `resolve_embedding_source()` 与前端 `normalizeEmbeddingSettings` 必须逐条一致）：

1. 显式的 `"builtin"` / `"custom"` 优先；
2. 否则 `baseUrl` / `apiKey` / `model` 任一非空（全 `*` 掩码也算非空）⇒ `"custom"`；
3. 三项全空 ⇒ `"builtin"`；
4. 未知值按 2–3 重新推断。

也就是说：已经填过自定义端点的老用户**不会被静默切走**，只有真正全新 / 全空的配置才变成内置。

`embedding_config()` 在解析出的 source 非 `"custom"` 且 `builtin::available()` 时使用网关凭据；否则穿透到已存值，并随凭据返回用户设置的 `embedding.batchSize`（默认 64）。这条链路只服务 arXiv 每日推荐（[../development/plaza.md](../development/plaza.md) §3.4），Host 命令 `recommend_arxiv` 透明继承。

向量缓存安全：`embed_cache` 的主键是 `(text_hash, model)`（`catalog/schema.rs` v6），所有读写都按 model 过滤，所以换 embedding 模型不会读到旧向量。

## 正文解析 OCR：`PAPER.md`

`"agentero"` 加进 `PARSER_BACKENDS`，**复用既有的 `OpenAiVlmBodyEngine`，没有新引擎**。该引擎本来就同时处理 PaddleOCR-VL（提示词 `"OCR:"`，剥掉 `<|LOC_123|>` 坐标 token）与 `deepseek-ai/DeepSeek-OCR`（剥掉 grounding 标注），按 model id 自动选提示词。

| 项 | 值 |
|---|---|
| 注册 | `body_engines/mod.rs` 里以 `engines::register_engine(BUILTIN_PROVIDER_ID, …)` 注册一个 `OpenAiVlmBodyEngine::new(BUILTIN_PROVIDER_ID)` |
| 引擎 id | 引擎携带自己注册时的 id，因此回退提示读作 `agentero failed: …` 而非 `openaiCompatible failed: …` |
| 凭证 | `layout_api_key` / `layout_base_url` / `layout_model` 在 **getter 层**特判内置 id，所有调用方自动正确 |
| prompt / language / force-OCR | `layout_prompt` / `layout_language` / `layout_is_ocr` **不特判** → `None` / `None` / `false`。提示词由 model id 推导；后两项是 MinerU 专用（`mineru.rs`），VLM 引擎不读。前端 `PARSER_PROVIDERS` 里内置描述符的 `requiresApiKey` / `supports*` 全 false，`isProviderCardConfigurable` 因此把整张卡过滤掉——不是隐藏两个控件，而是什么都不渲染 |
| `providerConfigs` 卡片 | 无。`layout_provider_settings_key("agentero")` 返回 `"agentero"` 只是为了给凭证 `HashMap` 一个稳定的键，白名单会把任何落盘的卡片丢掉 |
| hosted layout engine | **不注册**。`layout/hosted/engine.rs` 的 `engine_for("agentero")` 返回 `None` → 明确的 unknown provider 错误。这是正确的：前端不会为它渲染凭证卡片，也没有探测按钮 |

两个容易漏的点：

- `PARSER_BACKENDS` 白名单必须含 `"agentero"`。`normalize()` 在**每次保存**时都会跑，未列入的 backend 会被重置为 `default_parser_backend()` 并由 `persist` 写盘——不加就等于永远选不上。
- 未注册的 backend 会**静默回退**到 `LocalBodyEngine`（`crates/agentero-core/src/features/paper/analyze/parse/engines/mod.rs` 的 `engine_for`）而不报错，漏注册只会悄悄退化成本地解析。因此有测试显式断言 `engine_for("agentero")` 解析到 VLM 引擎。

大小写：`register_engine` 与 `engine_for` 都小写化，所以引擎查表大小写不敏感；而凭证 `HashMap` 取值经 `provider_for_backend` → `layout_provider_settings_key`（返回规范 camelCase）是**大小写敏感**的。`"agentero"` 全小写，三处字符串天然重合。引擎实现在 `src-tauri/src/features/paper/analyze/body_engines/`，trait 与注册表在 `crates/agentero-core/.../parse/engines/`。

---

## 版面分析不走内置（layout / parser 不对称）

**`"agentero"` 是 parser（正文）backend，不是 layout（版面分析）backend。** `LAYOUT_BACKENDS` 仍是 `["local", "paddle", "mineru"]`，`default_layout_backend()` **无条件**返回 `"local"`，而 `default_parser_backend()` 在有编译期 key 时优先返回内置。

原因：版面分析跑在随包的 PP-DocLayoutV3 ONNX 模型上，首次使用下载到 XDG cache 目录，再经 `agentero-model://` scheme 喂给 webview 的 `onnxruntime-web`——已经免费且离线（见 [../frontend/pdf-layout-analysis.md](../frontend/pdf-layout-analysis.md) §模型落盘）。把版面分析默认切到云端网关会让每个 PDF 都产生费用，且没有任何质量收益。有测试 `layout_backend_never_becomes_builtin` 守住这一点。

---

## 默认值

| 函数 | 有编译期 key | 无 key |
|---|---|---|
| `default_translate_provider()` | `agentero` | `tencenttransmart` |
| `default_parser_backend()` | `agentero` | `local` |
| `default_layout_backend()` | `local` | `local` |
| `EmbeddingSettings::source`（推断） | `builtin`（仅当 BYOK 三项全空） | `builtin`（同左；但 `embedding_config()` 穿透到空值 → 功能禁用） |

新装用户没有 `settings.json`，`read_file` 返回 `AppSettings::default()`，因此**由 Rust 的 `default_*()` 决定首次安装的取值**。前端 TS 的 defaults 只在浏览器 dev（无 Tauri、也就不可能有 key）里生效，所以刻意保持在非内置值上，两边不需要一致。

---

## 限制与后续

已登记的未决项（多数需要真实 key 才能验证，不阻塞发布）：

1. **`⟦n⟧` 占位符透传未验证**：Host 假设 Hunyuan-MT 原样返回 `mask.ts` 插入的 `⟦n⟧`。需要一次真实 key 的整篇 PDF 翻译，确认占位符没被吞掉或改写（吞掉会触发 chain 用原文重译一次）。
2. **模板空格待 A/B**：arXiv Hunyuan-MT 技术报告渲染为 `…explanation. <source_text>`（**有**空格），实现用的是模型文档模板的无空格形式。值得一次真实对比再定。
3. **`temperature = 0.2`** 沿用仓库惯例；技术报告没有规定解码参数。
4. **多段翻译没有全局 deadline**：最坏墙钟时间是 `ceil(n/3) × timeout`（`timeout` 默认 30s，钳制 1–30s）。整篇 PDF 的一批最多十几段，实测前不设总闸。
5. **`arxiv_rec_state` 不按 model 建键**：当日已排序结果在切换 embedding 来源后的首次运行会被复用，除非 `force`。既存行为，本次不改（详见 [../development/plaza.md](../development/plaza.md) §3.4）。
6. **目标语言只有 en / zh-CN**：扩到 Hunyuan-MT 的 37 语言需要同时改 `TR_TARGETS`、前端 `TranslateTargetLang` union 与目标语言选择器，并在 `hunyuan_target_name` 补映射。
7. **内嵌 key → per-install activation token**：由网关签发、可吊销、可做 per-user 配额；客户端 provider 形状不变。这是内嵌 key 可提取问题的真正解法。
8. **新手引导没有「Agentero 内置」这一档**：`translate` / `layout` 两个引导步只有「填自己的 Key」与「用免费引擎 / 本地模型」二选一。`translate-step.tsx` 的「用系统默认」原先写入静态前端默认值、会覆盖 Host 解析出的内置默认，现已改为按可用性解析（与 `default_translate_provider()` 一致），因此一路点过引导不再丢失内置默认；但引导界面本身仍未把内置作为显式选项呈现。见 [../frontend/onboarding.md](../frontend/onboarding.md)。

前端 provider / 面板 / i18n 落点见 [../frontend/settings.md](../frontend/settings.md)、[../frontend/translate.md](../frontend/translate.md)。
