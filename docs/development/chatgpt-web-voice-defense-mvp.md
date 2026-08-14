# ChatGPT Web Voice 答辩模式 MVP

**状态**：macOS 单用户内置 MVP 已完成；Windows/Linux 实机验收待完成

**关联 Issue**：[#237](https://github.com/poco-ai/Agentero/issues/237)

**平台范围**：V0 先验证 macOS

**后续规划**：[多 Agent 协同答辩准备 MVP](multi-agent-voice-defense-preparation.md)，只增强会前论文理解，保持实时 Voice 链路不变。

## 1. 产品目标

用户在 Agentero 中打开论文或笔记后，可以直接进入实时语音答辩。首次使用只需在临时登录窗口连接自己的 ChatGPT 账号；不安装 Docker，不配置 Gateway，不复制 token，也不接触账号池或管理后台。

V0 只验证一个最小闭环：

1. 打开当前论文或 Markdown；
2. 点击主窗口标题栏的麦克风按钮；
3. 首次使用时连接 ChatGPT；
4. 检查并编辑即将发送的答辩材料；
5. 开始实时语音问答；
6. 结束后把字幕保存为 Vault Markdown。

本阶段不建设通用语音平台，不引入多账号、供应商抽象、动态 RAG、会话恢复或企业级凭证系统。

## 2. 产品形态

### 2.1 用户入口

- 入口是主窗口标题栏的麦克风图标（右侧栏展开时显示；命令面板「进入答辩间」为同一动作）；
- 图标具有 `aria-label` 和 Tooltip；
- 不占用 Agent 侧栏会话条；
- 不在设置页增加 Voice 配置；
- Voice 会话与 ACP Agent 对话彼此独立。

### 2.2 首次连接

准备弹窗显示 ChatGPT 连接状态。未连接时，用户点击“连接 ChatGPT”，Host 创建一个临时原生 WebView 并打开 `https://chatgpt.com/`。

用户在该窗口完成登录后：

1. Host 仅在 `chatgpt.com` 顶层页面加载完成时执行同源 `/api/auth/session` 请求；
2. 只提取 `accessToken`；
3. token 直接写入系统凭证库（macOS Keychain、Windows Credential Manager、Linux Secret Service）；
4. 登录 WebView 立即销毁；
5. React 只收到已连接/连接中/错误状态。

登录 WebView 不获得 Agentero IPC capability。token 不经过 React、URL、剪贴板、设置 JSON、命令行或环境变量。

### 2.3 准备答辩

弹窗自动收集并展示：

1. 当前选区，优先级最高；
2. 当前 Markdown 文件；
3. 当前论文目录中的 `NOTES.md`；
4. 论文标题和来源路径。

材料可编辑，应用侧不做字符数截断，避免丢失方法、实验、结论或局限等关键内容。开始前明确提示材料和麦克风音频会发送给 ChatGPT；若上游拒绝实际超限请求，则向用户显示真实错误，不在本地静默裁剪。

### 2.4 通话中

界面只保留：

- 连接状态；
- 用户和答辩委员实时字幕；
- 麦克风静音/恢复；
- 打断当前回答；
- 开场门控放开后补充资料（底栏胶囊展开为输入条，内部用户消息，不上台不进转写）；
- 拉回主题；
- 结束答辩。

答辩口语独立于应用 UI 语言；提问难度（自适应/基础/高阶）写入 bootstrap。通话中不跑 ACP。

### 2.5 结束与保存

结束时关闭本地音轨、DataChannel 和 `RTCPeerConnection`，释放内部会话并终止 Sidecar。字幕**仅在用户明确保存时**写入：

```text
voice-defense/YYYYMMDD-HHmmss.md
```

YAML frontmatter 记录 `kind`、材料路径、preparation run、覆盖率、语言与场景。文件冲突时追加递增序号，不覆盖用户已有内容。结束页可另触发会后评价（隐藏 ACP），产物为同 stem 的 `-review.md`，不阻塞结束。

## 3. 资源生命周期

| 状态 | 登录 WebView | Voice Sidecar |
|---|---:|---:|
| 空闲 | 0 | 0 |
| 登录中 | 1 个临时窗口 | 0 |
| 已连接、未通话 | 0 | 0 |
| 通话中 | 0 | 1 个按需子进程 |
| 通话结束 | 0 | 0 |

约束：

- 登录窗口关闭后必须销毁，不常驻隐藏；
- Sidecar 只服务当前用户的一次答辩；
- 父进程退出、会话结束、启动失败或空闲五分钟时，Sidecar 必须退出；
- 不运行 Docker、HTTP 管理站或后台账号服务。

## 4. 技术架构

```text
React / WebView
  ├─ VoiceDefenseDialog
  ├─ 当前文件、NOTES.md、选区
  ├─ 麦克风与 RTCPeerConnection
  ├─ DataChannel("oai-events")
  ├─ 远端音频与实时字幕
  └─ Vault Markdown 保存
             │ Tauri IPC（不含 token）
             ▼
Tauri Host
  ├─ 临时 ChatGPT 登录 WebView
  ├─ 系统凭证库
  ├─ voice_config
  ├─ voice_session_create
  ├─ voice_session_release
  └─ VoiceSidecarController
             │ stdin bootstrap + loopback HTTP
             ▼
agentero-voice-sidecar
  ├─ 随机 127.0.0.1 端口
  ├─ 单次随机 Bearer secret
  ├─ ChatGPT Web Voice SDP 信令
  └─ 无数据库、账号池、管理页面
```

### 4.1 前端职责

- 请求麦克风权限；
- 创建 WebRTC offer 和协商式 `oai-events` DataChannel；
- 调用 Host 创建/释放会话；
- 设置远端 SDP answer 并播放音频；
- 一次性注入答辩提示和材料；
- 解析字幕、维护弹窗内临时状态；
- 写入 Vault 转写。

前端不读取或持久化 ChatGPT token，也不知道 Sidecar 的端口和内部 secret。

### 4.2 Host 职责

- 管理临时登录窗口；
- 读写操作系统凭证库；
- 按需启动和停止 Sidecar；
- 通过 stdin 传入 token、随机 secret 和可选网络代理；
- 把前端信令请求转发到 loopback；
- 在 ChatGPT 返回 401 时删除失效 token，并通知前端重新连接；
- 保证错误路径回收子进程。

### 4.3 Sidecar 职责

- 启动后先从 stdin 读取一次 bootstrap；
- 只监听随机 loopback 端口；
- 只提供当前会话需要的创建和释放接口；
- 将 SDP 与最小会话参数转发给 ChatGPT Web Voice；
- 不保存 token，不输出 token，不提供账号或管理能力。

Sidecar 的协议实现参考 [Space3044/chatgpt-web-voice](https://github.com/Space3044/chatgpt-web-voice) 和 [dyhhhhhh/chatgpt-web-voice](https://github.com/dyhhhhhh/chatgpt-web-voice)，许可声明见仓库根目录 `THIRD_PARTY_NOTICES.md`。

## 5. 最小调用流程

### 5.1 登录

```text
用户点击连接
  → Host 创建 voice-auth WebView
  → 用户在 chatgpt.com 登录
  → Host 同源读取 /api/auth/session
  → accessToken 写入系统凭证库
  → voice-auth WebView 销毁
  → voice-auth:changed 通知前端
```

### 5.2 创建会话

```text
前端获取麦克风并生成 SDP offer
  → voice_session_create
  → Host 从系统凭证库读取 token
  → Host 启动 Sidecar 并通过 stdin bootstrap
  → Sidecar 返回随机 loopback 端口
  → Host 携带单次 secret 请求 Sidecar
  → Sidecar 请求 ChatGPT Web Voice
  → answer SDP 返回前端
  → WebRTC/DataChannel 建立
  → 前端发送一次答辩材料
```

### 5.3 结束会话

```text
用户结束或弹窗关闭
  → 前端停止本地媒体与 WebRTC
  → voice_session_release
  → Host 通知 Sidecar 释放
  → Host 终止 Sidecar
  → 前端保存字幕 Markdown
```

## 6. 内部接口

### 6.1 Tauri 命令

- `voice_auth_status`
- `voice_auth_connect`
- `voice_auth_cancel`
- `voice_auth_disconnect`
- `voice_config`
- `voice_session_create`
- `voice_session_release`

### 6.2 Sidecar loopback 接口

```http
POST /v1/voice/sessions
Authorization: Bearer <single-process-secret>
```

```json
{
  "offer_sdp": "SDP_OFFER",
  "voice": "cove",
  "voice_mode": "wingman",
  "language_code": "auto"
}
```

```http
DELETE /v1/voice/sessions/{voice_session_id}
Authorization: Bearer <single-process-secret>
```

这些接口只在进程生命周期内存在，不是公开 Gateway API。

## 7. DataChannel 与提示词

DataChannel 固定为协商式通道：

```text
label = oai-events
negotiated = true
id = 0
```

事件使用 `data_message` 包裹。V0 处理 `state_update` 和 `chat_message_delta`，忽略其它元数据事件。字幕按 `message_id` 合并，内部 bootstrap 回显不展示、不写入转写。

答辩材料使用普通用户消息注入：

```text
你现在是论文答辩委员会委员。

请根据以下材料进行答辩：
1. 每次只提出一个问题；
2. 优先追问研究动机、方法、实验和局限；
3. 根据我的回答继续追问；
4. 不要复述材料，直接开始第一个问题；
5. 使用与用户相同的语言，问题保持简短。

论文标题：TITLE
来源：SOURCE

答辩材料：
CONTEXT
```

它不是 system prompt，模型可能不完全遵循规则；V0 不为此增加复杂状态机。

## 8. 安全与隐私

- token 只存在于 ChatGPT 登录页、Host 内存、系统凭证库和 Sidecar 当前进程内存；
- Sidecar bootstrap 使用 stdin，不使用参数、环境变量、URL 或磁盘文件；
- Sidecar 只绑定 `127.0.0.1` 随机端口，并要求不可预测的单次 secret；
- 登录 WebView 不拥有 Agentero IPC capability；
- 开始前让用户检查并确认发送材料；
- 仅在通话时请求和持有麦克风；
- 不自动读取当前论文范围外的 Vault 文件；
- 日志、错误、字幕和转写不得包含 token；
- ChatGPT Web 会话接口是非官方接口，可能变化，也可能受到账号、地区或服务条款限制。

## 9. 明确不做

- 外部 Gateway URL 或 API Key 配置；
- Docker 部署；
- 账号池、轮换、负载均衡或管理后台；
- 用户手工复制 ChatGPT token；
- 多供应商或多语音模型抽象；
- 数据库会话、断线恢复和跨设备同步；
- 动态 RAG、向量库或 ACP 自动长摘要；
- 答辩评分、知识点覆盖率或历史趋势；
- 企业审计、遥测和远程凭证托管。

## 10. 实施状态

### Phase 1：临时登录窗口（已实现）

- [x] `voice-auth` 原生 WebView；
- [x] 仅允许 HTTPS/about 导航；
- [x] 同源读取 ChatGPT 会话；
- [x] 系统凭证库保存 token；
- [x] 登录成功后销毁窗口；
- [x] 连接、取消、断开命令和状态事件。

### Phase 2：单用户 Sidecar（已实现）

- [x] 最小 Rust Sidecar；
- [x] stdin bootstrap；
- [x] 随机 loopback 端口和单次 secret；
- [x] SDP 会话创建/释放；
- [x] 父进程存活信号和空闲退出；
- [x] Tauri bundle 与开发构建脚本。

### Phase 3：产品面收敛（已实现）

- [x] 删除 Gateway 设置、API Key 和连接测试；
- [x] 删除外部部署步骤；
- [x] 准备弹窗改为 ChatGPT 连接状态；
- [x] 一次性迁移删除旧 `settings.voiceDefense`；
- [x] 保留上下文、字幕、静音、打断和 Vault 转写能力。

### Phase 4：macOS V0 验收（已完成）

- [x] Sidecar 编译、单元测试、鉴权和父进程生命周期测试；
- [x] 空闲状态无 Sidecar；
- [x] 旧设置迁移删除；
- [x] token 失效后删除凭证并回到重新连接状态；
- [x] 最新打包版 UI 手工检查；
- [x] 真实 ChatGPT 账号建立 WebRTC 并完成一次答辩；
- [x] Sidecar 崩溃时幂等回收，下一次调用按需重启；
- [x] 麦克风拒绝、DataChannel 故障和网络断开自动清理；
- [x] Windows Credential Manager 与 Linux Secret Service 实现；
- [ ] Windows/Linux 实机登录、通话和安装包 smoke test。

## 11. 验收标准

1. 普通用户无需理解或配置 Gateway、API Key、Docker、账号池；
2. 首次使用只需在临时窗口登录 ChatGPT；
3. 登录结束、空闲和通话结束后没有额外 WebView 或 Sidecar；
4. 当前材料可查看、编辑并一次性注入；
5. WebRTC 音频、实时字幕、静音、打断和结束可用；
6. 转写保存到 Vault 且不覆盖现有文件；
7. token 不出现在 React、设置、日志、命令行或转写中；
8. token 失效、Sidecar 崩溃和网络错误可回到可重试状态；
9. 不新增语音数据库、全局 Store 或复杂多轮状态机。

## 12. 后续决策

完成真实用户验证后，只按结果迭代：

- 提问相关性不足：增加一次性 ACP 答辩摘要；
- 材料过长：增加本地分段或摘要；
- 连接不稳定：优先修复协议兼容、网络代理和错误恢复；
- 使用意愿高：再评估文本补充、评分和历史回顾；
- 非官方接口不可持续：重新评估官方 Realtime API，不保留双架构。
