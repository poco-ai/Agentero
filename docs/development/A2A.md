第一版已实现的是本机 Agent 经已经连上的远程 Vault SSH 会话，把任务交给服务器上已安装的 CLI Agent。不新建 A2A 服务，服务器上也不再跑一份 Agentero。工具是本机 ACP 会话上的 `agentero-delegate`（`remote_targets` / `remote_delegate` / `remote_delegate_result` / `remote_delegate_cancel`）。产物留在远端 Vault，本机用现有 SFTP 查看。

下面仍是完整 Agent Card / Task 协议的草稿，尚未实现。

需求：
1. 本地阅读文献，出idea与方案
2. 与服务器进行交互，非常薄的通信层发任务，获取状态

```
┌─────────────────────┐         ┌─────────────────────┐
│   本机 Agentero      │         │   远端 Agentero      │
│  ┌───────────────┐  │         │  ┌───────────────┐  │
│  │ 桌面 GUI       │  │   A2A   │  │ headless CLI  │  │
│  ├───────────────┤  │ ◄──────► │  ├───────────────┤  │
│  │ ACP Host       │  │ (Agent  │  │ ACP Host       │  │
│  │ (本机 CLI Agent)│  │  Card + │  │ (远端 CLI Agent)│  │
│  └───────────────┘  │  Task)   │  └───────────────┘  │
│  ┌───────────────┐  │         │  ┌───────────────┐  │
│  │ A2A Server     │  │         │  │ A2A Server     │  │
│  │ A2A Client     │  │         │  │ A2A Client     │  │
│  └───────────────┘  │         │  └───────────────┘  │
│  Vault: 论文/笔记    │         │  Vault: 实验代码/数据 │
└─────────────────────┘         └─────────────────────┘
        人在这里交互                    算力和数据在这里
```


## 实验任务的完整链路

以"让远端复现某篇论文的实验"为例：

```
1. 你在桌面端对本机 Agent 说（ACP）：
   "把 Vault 里这篇论文的实验在远端服务器复现"
        │
2. 本机 CLI Agent 判断：这活儿要算力+数据 → 生成 A2A 任务
   （它怎么知道远端能干这个？拉远端 Agent Card，看到 run-experiment skill）
        │  tasks/sendSubscribe (SSE)
3. 远端 Agentero 收到 Task，转交给【远端 CLI Agent】执行（ACP）
   ── 这里有个关键决策，见下面 ──
        │
4. 远端 Agent 在服务器环境里：读实验数据 → 写/改代码 → 跑实验
   日志和中间产物通过 SSE 实时推回本机；里程碑存成 Artifact
        │
5. 终态：completed → Artifacts（代码 diff、metrics.csv、图表）
   落远端 Vault，同时同步回本机 Vault（按内容 hash 去重）
        │
6. 本机桌面端侧边栏"远程任务"面板：实时进度 → 完成提醒 → 产物已入库
```

**关键决策：Task 到远端后，谁来执行？**

推荐**远端 CLI Agent 执行**，而不是远端 Agentero 直接调 Runner：

- 复现/实现实验是"智能体活"（读论文、写代码、调参），这本来就是 CLI Agent 的能力，远端 ACP 接线是现成的；
- Agentero 层只负责**上下文和治理**：给远端 Agent 喂 Vault 里的论文、实验记录，收它的产物落库，管权限和审计；
- 好处是双向对称——远端 Agent 缺上下文时（比如"作者原代码里的超参表"），能通过 A2A 反向问本机 Vault 要，链路一模一样，不用为反向场景写新代码。

## 关键设计细节

**1. 配对与信任（这是 P2P 架构最先要解决的）**

- 首次配对走带外渠道（类似 SSH 信任建立）：桌面端显示一次性验证码，远端 CLI 执行 `agentero pair <code>`，交换长期 Bearer Token；
- 每个节点存一张**对端登记表**：name、Agent Card URL、token、允许的技能范围（比如远端只暴露 run-experiment，不暴露 query-data）；
- Token 按节点+用途分级：跑实验的 token 不能查数据。和 ContextForge 的思路一致——凭证加密存储、调用留审计日志、默认拒绝访问本机回环地址。

**2. 任务路由：别让 Agent 瞎猜**

本机 Agent 面对多个对端节点时需要路由规则，给你三层：

| 层 | 机制 | 例子 |
|---|---|---|
| Agent Card 技能匹配 | 读各对端 Card 的 skills 描述，LLM 选 | "复现实验"→ 远端 run-experiment |
| 数据就近原则 | 任务涉及的数据在哪个节点，就派到哪 | 实验数据在远端 → 必须远端跑 |
| 硬约束声明 | Card 里显式标注资源 | "需要 GPU""需要 100GB 磁盘" |

**3. 产物与数据流（实验场景的重头）**

- 大产物（数据集、日志）**绝不走 JSON 正文**：远端上传到对象存储/或直接留在远端 Vault，Artifact 里放引用 + 签名 URL，本机按需拉取；
- 代码类产物（diff、脚本）小，直接 FilePart 内联传回，本机 Agent 可以直接 review；
- 双向同步以 **Vault 条目 hash 为准**做幂等，重试/断网恢复不产生重复条目——这是你 Vault 架构现成的优势。

**4. 状态可见性（产品化重点）**

- 每个跨节点 Task 在两端各有一条记录，用同一个 Task ID 关联：本机记录"我派出去的"，远端记录"我接到的"，两端面板都能查；
- 取消要**级联传播**：本机点取消 → A2A tasks/cancel → 远端停沙箱 → 远端 CLI Agent 的 ACP 会话也收到中断；
- 断线重连：`tasks/get` 拉状态 + 重订 SSE，本机关掉 overnight 也没事。

**5. Headless 形态的取舍**

远端节点建议同一套二进制加 `--headless` 标志：跳过 GUI/系统托盘，只起 ACP Host + A2A Server + CLI。注意 headless 下两个交互能力要降级——`input-required` 状态的追问**不能等人在远端敲键盘**，策略改为：推送给本机（谁派的任务问谁），超时自动按预设默认回答或转 `rejected`。这是桌面/服务器形态唯一需要分叉的协议逻辑，建议做成可配置策略而不是写死。
