# 翻译（Host）

| Command | 说明 |
|---|---|
| `job_layout_translate_enqueue` | 复用同论文活动全文任务，或创建 `Focus` 任务；排队任务及其版面依赖提优，共享论文并发上限 |
| `job_layout_translate_claim` | 同一全文任务只允许一个窗口执行，其他窗口订阅进度 |
| `layout_translate_cache_write` | 跨窗口串行合并相同 key 的完成块，原子写入 `source/layout-translate.json` |
| `translate_text` | 免费 MT + 商用 BYOK + 内置 provider 路径（非文献 Translator） |
| `builtin_provider_status` | 内置 provider 的非秘密快照（`available` / `baseUrl` / 三个 model id）；见 [builtin-provider.md](builtin-provider.md) |

| 项 | 值 |
|---|---|
| 通用 `timeout_ms` | 可选；钳制 1s–30s；默认 30s |
| 商用 BYOK | DeepL / Azure / Google Cloud / AI/ML API / OpenAI-compatible；`apiKey` 可由调用方传入，或由 Host 从 `settings.translate.providerConfigs` 解析（前端仅持有同长度 `*` 掩码） |
| 内置 provider | id `agentero`；凭证由**构建期**环境变量注入，用户在设置里选它即可，无需填 key / baseUrl / model。走 Hunyuan-MT，见下方 |
| OpenAI-compatible endpoint | 要求 Chat Completions 兼容：`POST {baseUrl}/chat/completions`，`Authorization: Bearer <key>`，请求体包含 `model` 与两条 `messages`（system + user）；接受采样参数的模型带 `temperature` 0.2。解析 `choices[0].message.content`。设置里的 `baseUrl` 应是根地址（如 `https://api.openai.com/v1`），Host 会自动追加 `/chat/completions` |
| AI/ML API（`aimlapi`） | 与 OpenAI-compatible 同一条 Chat Completions 路径（提示词、采样、额外参数都相同），区别只有三点：`baseUrl` 空 → `https://api.aimlapi.com/v1`；`model` 空 → `deepseek/deepseek-v4-flash`（`AIMLAPI_DEFAULT_MODEL`，与前端 `COMMERCIAL_MT_DEFAULT_MODELS` 同步），所以只填 key 即可；请求主机恰为 `api.aimlapi.com` 时附带 `X-AIMLAPI-Source: agent/agentero`，改填其他地址或子域名时不发送 |
| OpenAI-compatible prompt | `openai_translate_messages`：system 是翻译引擎（只译、不解释、不反问；学术风格与少量英↔中例句；短选区禁止澄清问句；`[[n]]` 规则在 system），user 只有 `"""原文"""`。`temperature` 0.2；o 系列与 gpt-5 推理模型改发 `reasoning_effort` 并不带 temperature，新型号按下方配置说明区分混合思考与强制思考：DeepSeek V4/V4.1、Kimi K2.6、MiniMax M3 可关闭；GLM-5.3、Kimi K3、MiniMax M3.1-Flash 只降低 effort。与前端 `buildTranslateMessages` 保持同步。Host 在 `translate_text` 注入 `customSystem` / `customUser`（旧 `customPrompt` 仍可读：短口语是附加偏好，较长内容只替换风格块；`customSystem` 非空时优先）。用户模板含 `{{text}}` 时替换引号原文。未知 `{{…}}` 在设置归一化时剥离。引擎规则不替换 |
| 密钥存储 | BYOK：明文写在用户本机 `settings.json`（Unix `0600`）；`settings_get` / 广播按字符 redact 为 `*`；`settings_set` 对纯 `*` 串 merge 保留原值。内置 provider 的 key **不落 `settings.json`**，编译期编入二进制、只在 Host 进程内使用（见 [builtin-provider.md](builtin-provider.md) §密钥边界） |
| 免费 CNKI（`cnki`） | 知网翻译助手 `dict.cnki.net/fyzs-front-api` 逆向接口（同 zotero-pdf-translate）：`words` 字段 AES-128-ECB 加密（key 内置）+ `Token` 头（4 分钟缓存，失败即失效重取）。仅**中英互译**（接口自动判向）；单请求 ≤ 800 字符，超限由 Host 按句切分串行翻译、块间约 2s 防风控。CNKI 边缘对**未携带其下发 `SF_cookie_97` 放行 cookie** 的请求会随机直接 RST（无 HTTP 状态，reqwest 侧表现为 `error sending request for url`，实测约半数）——这正是「探测是好的、真实翻译却报错」的原因：zotero 插件借 Firefox 自动带 cookie，裸 reqwest 不带。Host 改用**进程级共享、带 cookie jar 的浏览器 UA 客户端**（`cookie_store(true)`，getToken 与各翻译块共用），第一次成功响应后即持有该 cookie，之后稳定；每请求仍带线性退避重试（最多 4 次）兜底冷启动，最终失败的错误串会带上 reqwest 的完整 source chain 便于定位；`code 401` 视为 token 失效，清缓存后重取并重试该块；触发验证码（`data.isInputVerificationCode` 或 `code 1004`「检索过于频繁」）时报错引导用户到 dict.cnki.net 过验证码；海外 IP 常 404。**刻意不进 `ZH_RACE_PROVIDERS`**（竞速会打爆风控且分句路径慢）。实现 `crates/agentero-core/src/features/translate/sources/cnki.rs` |
| 导入摘要 `free_mt_to_zh` | **并行竞速** 腾讯 / 火山 / DeepLX，取最先成功；单引擎 5s（`FREE_MT_ZH_TIMEOUT_MS`）；全失败则不写翻译。**内置 provider 不参与这条竞速**：`ZH_RACE_PROVIDERS` 只含免费引擎，导入摘要仍走非官方免费接口 |
| DeepLX 升级提示 | `result.texts[0].text` 若以已知完整英文升级提示开头（忽略前导空白），适配器返回服务错误，导入摘要继续等待其他引擎；全失败时省略摘要。此检查只拦截已知提示，不恢复接口可用性、不重写已有笔记。离线回归覆盖提示解析 → 引擎竞速 → `NOTES.md` 写入；测试响应依据已出现的提示构造，并非在线抓包。 |
| 设置页探测 | 前端 5s / 引擎，不含 Agent；内置 provider 可用时一并探测（真发一次 "Hi" 翻译请求，顺带验证网关连通），不可用时跳过——那只会在下方确定性报 no-key 错误 |

全文执行器通过 `job_report.params.layoutTranslate` 发布不含字符 IR 与页面预览的 items、cache key 和递增 revision。Host 保留最近快照，并随现有 `job:changed` 广播；后加入的查看器可以从 `job_list` 或入队响应获取当前状态。终止报告前先 flush 最后快照与缓存，查看器解除订阅不会改变 job 状态。任务去重、依赖和 `Focus` 调度见 `features/jobs`；前端执行与订阅见 `src/lib/pdf/layout/headless-translate.ts` 和 `translation-job.ts`。

## OpenAI-compatible 额外参数

OpenAI-compatible 的 `TranslateTextArgs.extraRequestBody` 是可选 JSON 对象字符串，持久化在 `settings.translate.providerConfigs.openaiCompatible.extraRequestBody`，由前端 probe / 商用翻译服务显式传递。Host 的 `apply_request_options` 在空白时保留模型默认参数；非空时只保留 `model` / `messages`，再加入用户 JSON，彻底替换所有自动采样和思考配置。`{}` 表示不发送附加参数；嵌套值及 `null` 原样透传。保留 `model` / `messages` / `stream`，出现这些字段或非法 JSON 时在发 HTTP 前报错；错误码 `translate.extra_parameters_invalid` / `translate.extra_parameters_reserved` 由前端本地化。其他 provider 不使用该字段。当前型号规则及官方依据见 [配置说明](../usage/translate-openai-compatible.md#自动模型适配)。

## 内置 provider（Hunyuan-MT）

`tencent/Hunyuan-MT-7B` 是专用 MT 模型，不是 instruct 模型，因此这条路径**不复用**上面的长规则 prompt，也**不给模型看 `[[n]]` 批量标记**（对齐协议依赖指令遵循）：

| 项 | 值 |
|---|---|
| 模板 | `Translate the following segment into <target_language>, without additional explanation.<source_text>`（逐字；指令与原文之间无空格无换行） |
| 消息 | 单条 user message，**无 system message**；`sourceLang` 不参与（模板没有它的位置，模型自动检测） |
| `[[n]]` | Host 侧按行首标记拆分（从 1 递增；行中或乱序即停止扫描）→ 每句一个请求 → `buffered(3)` 保序并发 → 按 `"{marker} {text}"` + `"\n\n"` 重组，与前端 `buildNumberedPayload` 字节一致。空段丢弃，段数变少时前端回退逐句翻译 |
| `⟦n⟧` | `mask.ts` 插入的行内占位符原样透传，不剥离（**未经真实 key 验证**） |
| 目标语言 | 只映射可达值：`zh-CN` → Chinese，`en` → English，防御性 `ui` → English，未知/`auto`/空 → English。上限由 `TR_TARGETS` 决定，模型侧的 37 语言见 [builtin-provider.md](builtin-provider.md) §支持语言 |
| 无 key | `commands.rs` 在任何 `.await` 前返回 `AppError::domain(ERR_NO_BUILTIN_KEY)`（`translate.no_builtin_key`），不放一个无法认证的请求出去 |
| 列表归属 | `"agentero"` 既不在 Rust `FREE_PROVIDERS`（CLI 用它门控 `--provider` 且以 `api_key: None` 调用）也不在 `COMMERCIAL_PROVIDERS`（驱动 WebView 凭证卡片）。**但前端 `FreeTranslateProviderId` / `FREE_MT_PROVIDER_IDS` 含它**——借此复用无 key 管线且不渲染凭证卡片；两份清单刻意相反，改一份要想到另一份 |
| 探测 | `probeFreeMtProviders` 现已含 `agentero`（探测会真的发一次 "Hi" 翻译请求，顺带验证网关连通）；`translate-pane.tsx` 在 `builtin_provider_status` 报不可用时跳过它——那时探测只会确定性复现 no-key 错误 |

实现：`crates/agentero-core/src/features/translate/sources/hunyuan_mt.rs`；凭证解析 `src-tauri/src/features/translate/commands.rs` + `src-tauri/src/features/system/builtin/`。限制与未决项见 [builtin-provider.md](builtin-provider.md) §限制与后续。

Agent 翻译走 `agent_run_once`，不经本 command。  
前端服务层：[../frontend/translate.md](../frontend/translate.md)  
代码：`src-tauri/src/features/translate/`
