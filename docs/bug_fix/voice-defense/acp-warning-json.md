# ACP 警告导致答辩准备误判失败

## 现象

多 Agent 已完成材料分析并返回结构化结果，但“材料分析”和“审稿质疑”节点仍被标记为失败，自动重试后结果不变。另一种表现是准备页只显示 `Unexpected identifier "Warning"`，看不出真正的上游错误。

## 原因

ACP Agent 会把 skills context budget 的诊断警告作为普通消息片段发送；当它前置在合法 JSON 前时，准备流程若直接对完整消息执行 `JSON.parse()`，会在首个 `Warning` 字符处失败，已经生成的分析结果被误判为无效。若上游请求本身失败，消息可能只有该警告和 `unexpected status 403 Forbidden`，此时并不存在可以恢复的 JSON；旧实现反而把 JavaScript 引擎的 JSON 错误显示给用户。

## 修复

- 保留纯 JSON 和完整 JSON 代码块的原有快速解析路径；
- 仅在完整消息解析失败时，从 ACP 诊断文本中提取结构化 JSON 对象；
- 只接受带当前 `schemaVersion` 和 `kind` 的唯一对象；
- 多个候选对象仍按歧义输出拒绝，提取后继续执行完整字段、来源路径和证据 schema 校验。
- 对没有结构化对象、但包含 ACP 上游 HTTP 4xx/5xx 的输出，保留并展示底层诊断（例如 `403 Forbidden`），不再包装成 `JSON.parse` 错误；确定性的 4xx 不再无意义地自动重试。评价流程复用同一诊断识别。

如果诊断明确指出中转站拒绝 `codex-acp` 客户端，应在设置 → Agent → 中转站兼容中配置该渠道要求的 User-Agent / Codex Provider id；解析器不会伪造材料或吞掉上游错误。

## 回归

测试复现真实的“ACP Warning + 合法材料分析 JSON”输出，确认结果可以进入原有严格结构校验；同时覆盖“ACP Warning + 403、无 JSON”输入，确认错误保留 403 且不触发重复重试。完整答辩准备/评价测试与类型检查保持通过。
