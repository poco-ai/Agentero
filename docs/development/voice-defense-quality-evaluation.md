# 多 Agent 答辩准备 Phase 3 质量评估

Phase 0–2 的 MVP 已由自动化测试覆盖；Phase 3 是真实论文质量验证，不使用模拟 Agent 输出代替。评估工具为本地 Node 脚本，不上传论文、评分或模型输出。

## 固定样本集

先固定 3–5 篇论文，再开始生成任何材料。样本应覆盖不同来源质量和难度，并完整包含可核验的 `PAPER.md`、LaTeX 或 PDF；只有 `NOTES.md` 的论文不能作为“全文理解”样本。建议记录：

```text
paper-id | title | vault-relative-paper-path | source-availability
```

评估期间不得替换论文、修改输入文件或改变样本顺序。准备任务的 `snapshotSha256` 和来源 hash 写入结果表，确保两种方案读取的是同一版本。

## 生成两种对照

对每篇论文分别生成：

1. **single-agent**：一个论文分析 Agent 的 baseline artifact/brief；
2. **multi-agent**：Agentero 的论文分析 + 审稿质疑 + synthesis brief。

两种方案使用相同的论文快照、语言、Agent/model 配置和 Voice 测试环境。评审者只看生成材料，不看方案名称；Voice 延迟单独用同一账号、同一网络、相同问题脚本测量。

不要把 preparation 的模型思维链复制到评估目录；只保存最终 artifact、brief 和人工评分。

## 评分表

每个 variant 填入 `scripts/evaluate-voice-defense.mjs --init <study.json>` 生成的 JSON：

- `coverage`：研究问题、方法、实验、结论、局限五项是否被清楚覆盖；
- `evidence.checked/accurate`：抽查的带来源主张数和其中证据准确数；
- `unsupportedClaims.checked/unsupported`：抽查主张数和无来源/超出证据的数量；
- `questions.checked/distinct/answerable`：答辩问题中有区分度、可回答的数量；
- `generatedTextPath/reviewedTextPath`：相对 study 文件的路径，用于计算用户编辑比例；
- `durationMs`：从任务开始到材料可审阅的耗时；
- `voice.firstQuestionMs/medianTurnMs`：首问及固定问题脚本的中位轮次延迟；
- `status`：`completed`、`ready`、`awaiting_review`、`failed` 或 `cancelled`。

编辑比例由生成 brief 与最终审阅 brief 的 token 多重集差异计算，属于可重复的近似指标；评审者仍应记录“大幅重写”的主观判断。

## 运行

```bash
pnpm voice-defense:eval -- --init /tmp/agentero-voice-study.json
# 编辑 study JSON，填入固定论文和两种方案的人工评分
pnpm voice-defense:eval -- \
  --study /tmp/agentero-voice-study.json \
  --out /tmp/agentero-voice-quality-report.md
```

脚本输出：

- 每篇论文的单 Agent / 多 Agent 状态；
- 覆盖率、证据准确率、无依据结论比例、问题质量、编辑比例和耗时的均值与差值；
- 成功率和 Voice 延迟差；
- 基于固定阈值的建议：`keep-multi-agent`、`fallback-single-agent`、`add-evidence-checker` 或 `insufficient-sample`。

建议阈值可在 study JSON 中覆盖，默认值为：至少 3 篇论文、覆盖率提升 0.1、无依据结论比例增加不超过 0.02、成功率至少 0.8、Voice 延迟增加不超过 5% 或 200 ms。建议只是辅助，最终决定必须在 `decision.outcome` 和 `decision.rationale` 中由评审者记录。

## 通过条件

只有同时满足以下条件，才把 Todo 中的 Phase 3 标记完成：

1. 固定样本集至少完成 3 篇论文的两种对照；
2. 多 Agent 覆盖率有可重复提升，且无依据结论没有明显增加；
3. 用户大幅重写比例和准备失败率可接受；
4. Voice 首问与后续轮次相对基线没有可归因于 Agentero 的回归；
5. 评审者明确选择保留协同、退回单 Agent 或增加证据核查节点，并保留报告。

在这些证据出现前，代码层面的 MVP 可以交付，但不能声称“多 Agent 已被质量验证”。
