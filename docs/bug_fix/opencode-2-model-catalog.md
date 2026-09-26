# OpenCode 2 自定义 provider 模型未出现在模型选择器

**Issue**：[#638](https://github.com/poco-ai/Agentero/issues/638)

## 现象

OpenCode 更新到 2.0.15 后，Agent 侧栏模型切换只显示 OpenCode 自带模型，自定义 provider 的模型无法在列表中找到。

## 原因

Agentero warm-up 阶段会同时看到两类模型来源：

- ACP `configOptions` 中的模型选择项；
- `session/new` 原始响应里的 legacy/raw `models.availableModels`。

旧逻辑只在没有 `configOptions` 目录时才读取 raw `models`。当 OpenCode 2 同时返回一个不完整的 `configOptions` 目录和一个更完整的 raw 模型目录时，不完整目录会挡住自定义 provider 模型。

此外，OpenCode 2 的 raw models 可能位于 `_meta.models`，模型 id 也可能采用 `provider/model` 形式。旧解析只覆盖 top-level `models` 和 `provider:model` 分组。

## 修复

- raw session models 解析同时支持 top-level `models` 与 `_meta.models`。
- 模型条目兼容 `modelId` / `model_id` / `id` / `value`，当前模型兼容 `currentModelId` / `current_model_id` 等字段。
- 分组从显式 provider 字段或 `provider:model`、`provider/model` 前缀推导。
- warm-up 阶段在 `configOptions` 和 raw models 都存在时选择更完整的模型目录，避免不完整 ACP catalog 隐藏自定义 provider。

## 验证

```bash
cargo test --manifest-path src-tauri/Cargo.toml session_models_fallback_tests --lib
```

结果：7 个相关测试通过。

Roadmap 与 TODO 已检查：这是已实现 Agent 模型目录兼容性的缺陷修复，不新增未完成产品项。
