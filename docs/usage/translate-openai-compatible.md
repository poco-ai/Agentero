# 配置 OpenAI 兼容翻译

Agentero 的「OpenAI 兼容」翻译用于接入支持 **Chat Completions** 格式的模型服务。它适合 OpenAI、DeepSeek、Kimi、Qwen 兼容模式、SiliconFlow、智谱等把聊天接口做成 OpenAI 兼容形态的服务；不适合只提供厂商自定义文本接口的服务。

## 填写位置

打开 **Settings → 翻译 → API 服务 → OpenAI 兼容**：

| 字段 | 填写方式 |
|---|---|
| API Key | 服务商控制台生成的密钥。只填在设置页，不要写进 Vault、文档、终端历史或 Git。 |
| 端点 | 填 **Base URL**，不是完整请求 URL。例如 `https://api.openai.com/v1`。 |
| 模型 | 服务商实际支持的模型 ID，例如 `deepseek-flash`、`deepseek-v4-pro`。 |
| 额外参数 | 可选 JSON 对象；填写后完全替代自动采样和思考配置。 |

填完点「确定」。设置页会做一次短 probe；probe 通过后，把「默认服务」切到「OpenAI 兼容」即可用于 PDF 划词翻译和全文翻译。

## 额外参数与覆盖顺序

「额外参数」直接填写 JSON 请求体参数，不需要包一层 `extra_body`：

- **留空**：按模型自动设置采样和思考参数。
- **填写 JSON 对象**：完全替代自动采样和思考配置，只发送用户填写的参数，不补默认值；不同参数名称也不会残留冲突。
- **填写 `{}`**：只发送 `model` 和 `messages`，其余行为跟随服务端默认。

嵌套对象、数组、数字、布尔值和 `null` 原样保留，`null` 不表示删除。`model`、`messages`、`stream` 仍由应用控制；这些保留字段或非法 JSON 会在保存前报错并保留草稿。

例如，第三方服务要求将 Qwen 的思考开关放进 `chat_template_kwargs`，直接填：

```json
{
  "chat_template_kwargs": { "enable_thinking": false },
  "temperature": 0.2
}
```

请求不会再附带自动推断的顶层 `enable_thinking`。如果只想使用服务端默认思考行为并设置采样温度，填写 `{"temperature": 0.2}` 即可。参数格式以所用服务商的文档为准。

点击「确定」保存；probe、划词翻译和全文翻译使用同一份配置，修改后全文翻译不复用旧配置的译文缓存。此入口配置请求体，不配置 HTTP headers 或切换 API 协议。

## 自动模型适配

模型输入框接受任意模型 ID。以下是留空额外参数时的自动行为（官方资料核对于 2026-11-09）；第三方网关可能使用不同格式，可用上面的 JSON 完全接管参数。

| 模型 | 自动行为 |
|---|---|
| DeepSeek `deepseek-flash`（当前 V4.1）、V4 / V4.1 系列 | `thinking: {"type":"disabled"}` |
| Kimi K2.5 / K2.6 | 关闭思考；不发送 temperature，遵循服务端固定值 |
| Kimi K3 / K3.1、MiniMax M3.1-Flash | `reasoning_effort: "low"`，不强行关闭思考，不发送 temperature |
| GLM-5.3 / GLM-5.3-Flash | `reasoning_effort: "low"`，不强行关闭思考 |
| GLM-4.5 / 4.6 / 4.7 / 5 / 5.1 / 5.2、MiniMax M3 | 关闭思考；MiniMax M3 不发送 temperature |
| Qwen3 / 3.5 / 3.6 / 3.7 / 3.8 混合思考型号、qwen-plus / qwen-flash 当前别名 | `enable_thinking: false` |
| Kimi K2.7 Code、DeepSeek R1、MiniMax M2、QwQ、Qwen 专用 Thinking / Instruct 快照及已知强制思考型号 | 不注入不支持的关闭参数；Kimi K2.7 不发送 temperature |

Qwen Omni 的思考协议不同，不自动注入思考参数。以上不代表所有模型都能关闭思考，也不保证仅支持流式输出的服务可用于当前非流式翻译。旧 `deepseek-chat` 别名仍留给第三方服务解释，官方接入应使用其当前模型 ID。

依据：[DeepSeek 模型](https://api-docs.deepseek.com/quick_start/pricing/)、[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[Kimi 参数约束](https://platform.kimi.ai/docs/api/models-overview)、[GLM Chat Completions](https://docs.z.ai/api-reference/llm/chat-completion)、[MiniMax OpenAI 兼容接口](https://platform.minimax.io/docs/api-reference/text-openai-api)、[百炼深度思考型号与限制](https://help.aliyun.com/en/model-studio/deep-thinking)。

## 接口要求

Agentero 会把端点拼成：

```text
POST {baseUrl}/chat/completions
```

请求体是 OpenAI Chat Completions 风格：

```json
{
  "model": "<model>",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "temperature": 0.2
}
```

返回值必须能从这里取到译文：

```text
choices[0].message.content
```

设置里的端点建议使用根地址；完整 `/chat/completions` URL 也可用，Host 不重复追加：

| 服务 | Base URL 示例 |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Kimi / Moonshot | `https://api.moonshot.ai/v1` |
| Qwen 兼容模式 | `https://maas.qwencloudapi.com/compatible-mode/v1` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` |

AI/ML API 有单独的「AI/ML API」卡片：只填 API Key 即可，Base URL 默认 `https://api.aimlapi.com/v1`，模型留空时使用 `deepseek/deepseek-v4-flash`，也可以填其他带厂商前缀的模型 ID（如 `google/gemini-3.1-flash-lite`）。

不要填写这些值：

| 错误写法 | 原因 |
|---|---|
| `https://api.example.com/v1/responses` | Responses API 不是 Chat Completions。 |
| `https://api.example.com/v1/completions` | 旧 Completions API 没有 `messages` / `choices[0].message.content`。 |
| `https://api.minimax.cn/v1/text/chatcompletion_v2` | 这是 MiniMax 自定义文本接口，不是 OpenAI Chat Completions 兼容 Base URL。 |

## MiniMax 接入

MiniMax 国际站官方提供 OpenAI 兼容 Base URL `https://api.minimax.io/v1`，支持 `MiniMax-M3` 与 `MiniMax-M3.1-Flash`。请按账号区域和服务商控制台选择端点；不要把原生 `/text/chatcompletion_v2` 接口填入此处。M3 可以关闭思考，M3.1-Flash 只能降低思考强度。

## Probe 失败排查

设置页 probe 是 5 秒短请求，只用于快速判断配置是否大体可用。失败时按下面顺序检查：

1. **区域是否匹配**：中国区和国际区账号、Key、域名可能不互通。中国区通常用 `.cn` / `.com` 域名，国际区通常用 `.io` 域名，以服务商控制台为准。
2. **端点是否是 Base URL**：支持根地址或完整 `/chat/completions`；不要使用 `/responses`、`/text/chatcompletion_v2`。
3. **模型名是否精确**：模型 ID 区分服务商和区域，照控制台或模型文档填写。
4. **Key 是否有效**：检查余额、套餐、权限、RPM / TPM 限制；`401` / `403` 通常是 Key、区域或权限问题。
5. **网络与代理**：Settings → General → Network proxy 会影响 Host 发出的翻译请求。
6. **超时或限流**：probe 只有 5 秒，真实翻译默认 30 秒；高峰期可能 probe 失败但正式请求偶尔成功。

如果你把 API Key 发到了聊天、Issue、日志或截图里，立即去服务商控制台撤销并重建。Agentero 设置页会把已保存的 Key 掩码显示，但外部泄露的 Key 无法由应用补救。

