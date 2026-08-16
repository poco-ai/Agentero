# 答辩间复盘

本目录只放答辩间（Viva / voice-defense）已修复问题的分析，不删除。产品说明见 [前端 Agent](../../frontend/agent.md)。

| 复盘 | 现象 |
|---|---|
| [声音和字幕不同步](caption-av-sync.md) | 听见后半句、字幕整段抢跑、有声无字，或恢复轮与前奏叠说 |
| [无法断开 ChatGPT](chatgpt-disconnect-owner.md) | 生产包点断开报 Keychain 所有者冲突 |
| [入场按钮无反应](enter-button.md) | 就绪后点「入场答辩」停在准备页或立刻进错误页 |
| [开场回执把答辩重启](opening-ack-gate.md) | 「明白了」先应答再正式开场 |
| [开场噪声字幕与重启](opening-noise-captions.md) | 噪声 ASR 被当成回答、委员重问 |
| [开场失败关闭无响应](close-before-playback.md) | 连接失败后关窗没反应 |
| [语境漂移与字幕串台](context-drift.md) | 委员跑题、字幕槽互抢 |
| [内部材料显示为用户字幕](bootstrap-caption.md) | bootstrap 被当成「你」 |
| [材料被截断](context-truncation.md) | 注入材料被上游截断 |
| [WebKit Invalid SDP line](invalid-sdp-line.md) | macOS 启动时报 SDP 行格式错误 |
| [传输故障回收](transport-failures.md) | 断网 / DataChannel 失败后会话没收干净 |
| [ACP 警告误判准备失败](acp-warning-json.md) | 警告 JSON 被当成准备失败 |
| [总结页底栏按钮叠层](ended-footer-overlap.md) | 「打开转写」与评价状态叠在一起 |
| [总结页没有关闭按钮](ended-missing-close.md) | 保存转写后只能靠标题栏叉号退出 |
