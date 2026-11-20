# 研究上下文

Quick Chat、侧栏及 Zen 复用同一条证据链。桌面根据选区、当前论文和 `@` 提及生成 `ContextRequest`，解析出的 `ContextPlan` 包含引用、允许读取的论文或文件、字符预算及指纹。Prompt 只预置标题、定位信息与最多 1200 字的选区，引文可跳回原文。

## 本地回合

本机支持 shell 的内置预设从桌面取得同版本 CLI 的可执行路径。带锚点的回合在独立 ACP 进程中运行，宿主向进程及 ACP 创建的终端注入 `AGENTERO_CONTEXT_GRANT`。值为随机的单回合句柄。CLI 通过桌面私有命令通道把请求交给宿主。授权、累计预算与已返回材料清单均由宿主保存在内存里。用户切库、关闭所属窗口、取消或结束回合，句柄即失效。具有任意 shell 和用户文件权限的执行器仍受自身沙箱管理。

| 命令 | 回合内行为 |
|---|---|
| `agentero search QUERY` | 只在已授权论文、文件和目录内返回证据卡片。每页命中数与摘录长度均受预算限制。 |
| `agentero read SOURCE` | 接受论文、文件和搜索所得引用。支持行、章节、PDF 页及区域定位，读取和续读共用本轮预算。 |
| `agentero paper relations PAPER` | 从馆藏缓存提取引用关系。范围外论文的库内路径不随结果提供。 |

桌面使用回合中实际返回的证据填充消息的来源。点击 `agentero://cite/…` 时，宿主先验证当前库和材料版本，再打开相应论文、PDF 页面、区域或笔记行。修改后的材料可通过重新搜索取得当前版本的引用。

未声明 shell 的自定义执行器、仅提示执行器以及找不到同版 CLI 时，宿主对最多两个已授权的本地来源预取摘录，每项最多 280 字，连同可回跳引用加入 prompt 和完成消息。没有可访问的本地源时，仍传入已有的选区和定位信息。授权来源或展开方式改变时，新会话会收到先前可见对话作为历史。

## 文件产物

本机聊天回合可执行 `agentero app present outputs/comparison.md`。宿主校验文件位于本轮 Vault，按回合记录所属 Vault、相对路径及可选标题。侧栏或 Zen 中点击产物时，会在所属 Vault 中预览 Markdown、PDF、HTML、图片及受支持的文本文件，其他格式在系统文件管理器中定位。未绑定当前回合的普通终端使用 `agentero app open`。SSH 委派由 `delegate targets/run/result/cancel` 连接桌面已有会话，操作许可仍由远端执行器的权限弹窗处理。

## 实现

| 职责 | 源码 |
|---|---|
| 证据计划与指纹 | `crates/agentero-core/src/features/context/` |
| 检索、定位、版本和预算 | `crates/agentero-core/src/features/evidence/` |
| 本地回合授权和收据 | `src-tauri/src/features/agent/hosted_turn.rs` |
| 工作区请求与回执 | `src-tauri/src/app/workspace_cli.rs`、`src/hooks/use-workspace-cli.ts` |
