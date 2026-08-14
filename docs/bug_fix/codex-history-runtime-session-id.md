# Codex 历史恢复误用 runtime session id

**状态**：已修复  
**Issue**：[#209](https://github.com/poco-ai/Agentero/issues/209)  
**影响面**：Agent 面板中新建对话后打开刚结束的 Codex 历史会话

## 现象

完成一轮 Codex 对话，点击「新建」，再从历史记录打开刚才的会话时，ACP 返回：

```text
session/load: Internal error: no rollout found for thread id <uuid>
```

错误中的 UUID 是 Agentero 为事件关联生成的 runtime session id，不是 Codex rollout/thread id。

连续在同一个对话中发送第二个问题时，还会看到两个（或多个）历史项：每一项只有当前轮的标题，像是每次提问都新建了会话。

## 根因

问题由三段状态衔接共同触发：

1. `newConversation` 在活动 tab 仍指向旧会话时先调用 `setLines([])`，因此清空了旧会话保存在共享 session store 中的 transcript。
2. 再次打开该历史项时，因为本地 `lines` 已为空，前端转而调用 `session/load`；旧实现传入 `item.id`（Agentero runtime id），而不是该项已经保存的 `providerSessionId`（Codex thread id）。Codex 自然找不到对应 rollout。
3. `session/load` 成功后的 transcript 写入、会话激活和 `setLines` 原本分散在多次 store 更新中；历史列表若在加载期间刷新，目标行可能已经不存在，最终会激活一个没有 transcript 的 id，表现为“不报错但空白”。
4. ACP 为每次 `agent_run_once` 请求生成新的 Agentero runtime id，即便请求通过 `session/resume` / `session/load` 续接同一个 provider session。前端原先按 runtime id 无条件新增历史项，未按 provider id 合并，因此一个 provider 对话被拆成多个列表项。
5. 续聊时前端还曾把 provider id 当作“待接收事件”的 runtime id；完成事件可能在新历史行创建前被过滤，导致界面只剩用户提问。

## 上游行为核对

官方 [`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp) 的 `loadSession` 会先 `threadResume` / `threadRead(includeTurns: true)`，再通过多条 `session/update` 回放历史，最后返回 `session/load` response；也就是说，历史通知可能早于 RPC response。

参考 [`zed-industries/zed`](https://github.com/zed-industries/zed) 的 ACP client 与回归测试，客户端必须在请求完成前准备好会话接收容器。Agentero Host 的 `ReplayBuilder` 已经能接住 response 前的更新并产出非空 `history.lines`，因此第二阶段空白发生在前端把完整快照写入共享 session store 的过程，不需要修改 ACP 协议层。

## 修复

- session store 提供原子的 `startDraft()`：只切换到空草稿并清空草稿内容，不修改刚离开的会话 transcript。
- 历史恢复统一通过 `providerSessionIdForHistoryLoad()` 解析 provider id；优先使用非空 `providerSessionId`，仅对 provider 直接索引的历史项回退到 `item.id`。
- session store 提供 `hydrateAndActivateSession()`：在一次更新中 upsert 历史项、写入完整 transcript、清理草稿并激活目标会话；即使列表刷新暂时移除了目标项，也会从用户点击时的快照恢复。
- 打开已有本地 transcript 时，后续续聊也使用同一 provider id。
- 连续续聊时，新的 runtime 行会替换旧的活动行，并按 provider id 去重；历史刷新也会用 provider id 将本地 runtime 行与 ACP `session/list` 结果合并，避免再次出现重复项。
- 事件等待状态只记录新请求返回的 runtime id；provider id 仅用于 ACP resume/load，因此续聊的流式回答和完成事件不会在建行前丢失。

## 回归覆盖

- 新建对话后，旧会话 transcript 保持不变。
- 本地历史项同时包含 runtime id 和 provider id 时，加载选择 provider id。
- ACP `session/list` 直接导入、其 `item.id` 本身就是 provider id 时仍可正常加载。
- `session/load` 返回非空 transcript 后，激活项立即可从共享 store 读到相同行；加载期间目标项被列表刷新移除时也不丢失内容。
- 同一个 provider session 连续发送多轮后，历史列表保持单个会话项，且该项包含之前的用户问题与助手回答。
- 续聊的 runtime 事件在历史行发布前会暂存，发布后回放，确保助手回答不再缺失。

Roadmap 与 TODO 已检查：这是已实现 Agent 历史能力的缺陷修复，不新增未完成产品项。
