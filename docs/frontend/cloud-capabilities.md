# Agentero 云端能力

账户设置中的云端区域提供翻译、OCR 和 Embedding 免费剩余额度，以及一个账户级「超额使用 Credit」开关。开关默认关闭，统一控制三项能力；说明通过问号展开，不提供能力消费上限表单。个人和组织账户分别保存设置，组织仅 owner/admin 可修改。

`src/features/capabilities/data.ts` 集中管理会话请求、查询缓存、开关和操作恢复；通过 `tauriFetch` 使用现有账户会话。Rust 账户插件允许 `/api/account/capabilities` 和组织路由，不改变 IPC 命令签名。

## 翻译

选择 Agentero 后，`src/lib/translate/api.ts` 将请求交给已登录的个人账户服务。原文按服务端规范化后的 Unicode 字符计量。网络重试复用持久化幂等键，避免响应丢失造成重复收费；本地只存用户 ID、输入摘要和请求 ID，不保存原文或凭证。其他翻译供应商仍使用已有适配器。

## PDF OCR

在账户设置选择个人或组织账户，上传 PDF 后先报价，再明确开始任务。支持查询恢复、取消和逐页 Markdown 结果。源文件最大 32 MiB、500 页，服务端自动提取已有文本，只对实际成功 OCR 的扫描页计量。此入口不替代本地布局分析和 bounding boxes 工作流。

待恢复记录按用户和账户隔离，保存文件、报价、幂等键和 operation ID。切换账户不复用另一账户的任务。取消停止后续派发；已经发出且成功交付的页可能继续结算。关闭超额开关仅阻止新的付费准入。

## Embedding

Embedding 设置中的 Agentero 预设填入账户 API `/v1` 地址和 `agentero-embedding-v1`，并清空上一供应商密钥。使用 Agentero API Key，由该 Key 绑定的账户支付；并非第三方供应商 BYOK。向量空间固定，不能将旧模型索引直接视为新模型索引。

## 验证

前端变更运行 `pnpm typecheck`、`pnpm deps:check` 和能力数据层测试。原生验证须先完成仓库词典、PDFium 等资源准备，再运行 `pnpm tauri dev`；浏览器页面验证不能替代原生会话联调。

2026-11-16 本次验证：类型检查、依赖检查、31 项翻译相关测试及 Rust 格式检查通过。原生启动和提交钩子的 Clippy 均被缺少 `dictionary/*` 资源阻塞，指定来源下载超时；原生构建和会话联调尚未验证。提交时保留这一缺口，资源补齐后需重跑 `pnpm run lint:rs` 和原生流程。
