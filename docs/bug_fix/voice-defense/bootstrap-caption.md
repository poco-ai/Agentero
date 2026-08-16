# 语音答辩内部材料显示为用户字幕

**状态**：已修复  
**日期**：2026-08-10  
**范围**：ChatGPT Web Voice 答辩 MVP

## 现象

开始语音答辩后，答辩规则、论文标题和整篇材料会出现在实时字幕的“你”下面。由于上游助手回复和长文本回显的事件到达顺序可能不同，界面还可能先显示第一个问题，再显示内部材料，看起来像用户回答了整篇文章或模型跳到了第二个问题。内部材料也会进入最终转写。

## 根因

ChatGPT Web Voice 的当前 DataChannel 协议没有经过验证的 system/developer instruction 通道。Agentero 因此使用 `relay_message` 注入启动材料，而该消息必须以普通 `author.role = "user"` 发送。

旧实现由 `buildVoiceRelayEvent` 在内部随机生成消息 ID，`VoiceDefenseClient` 发送后无法识别上游回显的同一条消息。字幕解析器收到 `chat_message_delta` 时只能将它当作正常用户字幕交给 UI。

## 修复

1. `VoiceDefenseClient` 在发送 bootstrap 前生成消息 ID；
2. `buildVoiceRelayEvent` 接受调用方提供的消息 ID；
3. 客户端保存内部消息 ID 和 bootstrap 文本；
4. 字幕流仍完整消费内部消息及其增量，避免破坏后续流状态；
5. 在交给 UI 前过滤匹配内部 ID 的用户字幕；
6. 上游若重写 ID，则用规范化后的 bootstrap 文本及其流式前缀兜底过滤；
7. 通话关闭时清理所有内部过滤状态。

这只改变本地展示与转写，不改变发送给模型的答辩材料，也不伪造未经验证的 system 角色。

## 后续：保证委员先开场

仅隐藏 bootstrap 字幕不能保证首轮体验。麦克风在 bootstrap 发出前就进入 WebRTC 时，环境声可能抢先形成用户轮次；较弱的角色提示也可能让模型反问“希望我解释什么”。

修复后：

- bootstrap 明确要求下一条回复由委员先宣布答辩开始，并只提出第一个问题；
- 明确禁止询问用户希望解释什么、需要什么帮助或先复述材料；
- 使用边界标记隔离参考材料，材料内容不视为行为指令；
- 连接初期暂时关闭麦克风上传音轨，检测到助手开始响应后立即恢复；
- 若上游未响应，八秒后自动恢复麦克风，避免会话无法继续。

## 回归验证

`test/voice-defense-protocol.test.ts` 重放上游对 bootstrap 的 `chat_message_delta` 回显，验证：

- 出站消息使用客户端指定的 ID；
- 普通解析仍能得到完整 user caption；
- 匹配内部 ID 时不向 UI 暴露；
- 上游改写 ID 时，文本前缀兜底仍不向 UI 暴露；
- 普通用户语音字幕与助手字幕不受影响。
- bootstrap 包含委员主动开场、禁止元问题和材料边界规则。
