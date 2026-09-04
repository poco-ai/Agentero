# Zotero Word 插件兼容与引用工作流（草案）

关联 Issue：[\#167](https://github.com/poco-ai/Agentero/issues/167)（“支持一下 Zotero Word 插件”）。

> 状态：未实现。本文先固定产品边界和技术路线；落地后应将已实现部分移至前端/后端功能文档，并从本目录移除。

## 结论与产品决策

Issue 所说的“Zotero Word 插件”有两层含义，必须分开处理：

| 目标 | 结论 |
| --- | --- |
| 在 Microsoft Word 中搜索 Agentero Library、插入可刷新引文和参考文献 | **做**：在官方插件兼容模式中直接由 Agentero 提供；Agentero 自有 Office Add-in 是后备方案，不是首个交付。 |
| 让已安装的官方 `Zotero.dotm` 直接把 Agentero 当成 Zotero Desktop | **做，按平台分期**：macOS 先做（插件已有 HTTP 入口）；Windows 后做（`WM_COPYDATA` + OLE Automation）。两者均不能与 Zotero Desktop 同时接管插件。 |
| 保留已有 Zotero Word 文档的可读性 | **做迁移工具，不改原文档**：识别现有 Zotero field code，尽力读出嵌入的 CSL 引文数据；用户确认后生成副本并以当前 provider 验证的兼容字段重写。 |

当用户已安装官方 `Zotero.dotm` 时，首版优先保持其现有 Ribbon 和按钮不变，由 Agentero 接收同一协议并显示自己的引用选择界面。该模式应显式显示为“使用官方 Zotero Word 插件（Agentero provider）”，不得暗示 Agentero 是 Zotero 或修改 Zotero Desktop；Zotero 商标使用需在发布前走法律审核。

**互斥规则**：同一用户会话中只能有一个 provider。启用 Agentero provider 前必须退出 Zotero Desktop；停用后才可恢复 Zotero Desktop。Windows 的插件通过窗口查找第一个匹配目标，macOS 使用固定本机端口/pipe，双进程并行会造成请求随机路由或端口冲突，不能靠提示“同时使用”解决。

实际工作量是中高风险的桌面集成功能，而非 Connector 加一个普通端点。推荐的 go/no-go 顺序是：**M0 macOS 官方插件握手与空文档操作 → M1 macOS 可用闭环 → M2 Windows → 评估是否仍需要自有 Office Add-in**。

## 协议事实与 Connector 边界

当前 `features/connector/` 在 `127.0.0.1:23119` 实现的是浏览器 Zotero Connector 保存协议：网页元数据/PDF 进入 Vault。它不管理 Word 的光标、field code、文档偏好或 CSL 排版。

官方 Windows `Zotero.dotm` VBA 宏会查找 `ZoteroMessageWindow`（Zotero 6）或 `Mozilla_zotero_*_RemoteWindow`（Zotero 7），以 `WM_COPYDATA` 发送 `-ZoteroIntegrationAgent WinWord`、命令、文档路径和 template version；Zotero 再用 C++ OLE Automation bridge 操作 Word。官方 macOS 宏则优先请求 `GET http://127.0.0.1:23119/integration/macWordCommand?agent=...&command=...&document=...&templateVersion=...`，失败后才读取 `ZoteroPort.txt` 或写入 `.zoteroIntegrationPipe`，再由 ObjC/AppleScript bridge 操作 Word。

因此 **macOS 可以复用同一个 loopback listener 与端口，但不能复用现有 Connector 业务路由**：新增的是 `/integration/macWordCommand` 和一套 Word integration engine。Windows 则需要一个独立的 native message receiver。两端最终都要实现文字处理器回调（如 `Document_getFields`、`Document_insertField`、`Document_setDocumentData`）、引文选择、CSL 排版和 field code；仅返回 HTTP `200` 没有任何用户价值。

参考： [Windows VBA 宏与 OLE bridge](https://github.com/zotero/zotero-word-for-windows-integration/blob/main/build/template/Zotero.dotm/word/vbaProject.bin/Zotero.bas) · [macOS VBA 宏、HTTP 与 pipe fallback](https://github.com/zotero/zotero-word-for-mac-integration/blob/main/build/template/Zotero.dotm/word/vbaProject.bin/Zotero.bas) · [LibreOffice wire protocol](https://www.zotero.org/support/dev/client_coding/libreoffice_plugin_wire_protocol/) · [Zotero Word Plugin](https://www.zotero.org/support/word_processor_plugin_usage)。

## 范围与用户契约

### M1 要做（macOS 官方插件 provider）

- 支持 Microsoft 365 Word Desktop for macOS 的当前受支持版本；用户继续使用官方 `Zotero` Ribbon 的 Add/Edit Citation、Add/Edit Bibliography、Document Preferences、Refresh、Unlink Citations。
- Agentero 收到 `addEditCitation` 等命令后打开自己的原生引用选择窗口，搜索当前已选择的本地 Vault Catalog；支持多条引用、页码/locator、prefix/suffix、suppress author、引文重排。
- 至少内置 APA、Chicago author-date、IEEE 三种 CSL 样式及相应 locale；样式随 Agentero release 更新，不在运行时静默联网下载。
- 插入/刷新后，文档自身含有恢复和排版所需的 CSL-JSON 快照。关闭 Agentero、移动 Vault、把 `.docx` 发给他人后，现有引文仍是普通 Word 字段显示的文本；重新编辑需要连接一个可用的 Agentero Vault。
- Agentero 只读使用当前 Vault 的论文元数据；Word 文件的写入只能由 Word automation 完成，不经 Vault 覆盖用户文件。

### M1 不做

- 不同步或写入 Zotero Desktop 数据库、Zotero Sync 或用户的 Zotero 账号。
- 不分发、修改或覆盖官方 `Zotero.dotm`；用户需自行通过 Zotero 安装它。Agentero 只对其公开可观察的本机调用协议作兼容，具体许可结论见“许可证”。
- 不保证 Agentero provider 写出的字段在 Zotero Desktop 中可继续编辑，或反向保证 Zotero 字段能被 Agentero 无损编辑；迁移必须创建副本。
- M1 不支持 Windows Word、Google Docs、Word Online、iOS/Android Word；它们分别需要 Windows native bridge、HTTP citing adapter 或 Office Add-in。
- 不做在线下载任意 CSL style，也不覆盖已有 `.docx`。迁移始终显式确认并输出副本。

## 领域模型与持久化

Catalog 是“可搜索的当前来源”，不是稿件可重复排版的唯一事实来源。为了让未修改的官方插件能够识别文档，provider 不能另造 `agentero.citation/1` field schema；必须生成并读取 Zotero 已使用的 document data 与 `ADDIN ZOTERO_ITEM` / CSL citation payload。每个 citation 仍须嵌入完整可用的 CSL item data，避免文档只引用一个会失效的 Vault 路径。

```text
Agentero Catalog (当前 Vault，只读)
  -> PaperRecord -> Zotero-compatible CSL item snapshot
  -> official Zotero.dotm -> Agentero provider
  -> Word ADDIN ZOTERO_ITEM field (payload + rendered text)
  -> Word document

Zotero document data (style / locale / field mode)
  -> document-level Zotero-compatible payload

Refresh
  -> scan document Zotero fields
  -> optional Catalog match by DOI -> arXiv -> normalized title
  -> citeproc recomputes all rendered citations and bibliography
```

Zotero field/document data 的序列化、版本迁移、citation ID、note index、style/locale 与 bibliography 语义以官方集成测试为兼容基线。不要从零猜一个“看起来像 CSL-JSON”的格式。Agentero 的内部类型可以有显式 schema，但写到 Word 前必须通过一个专用 `zotero_field_codec` 转成经 fixture 验证的官方格式。

内部 citation draft 的概念形态如下；它不是文档中最终存储的 JSON：

```json
{
  "citationID": "01J...",
  "citationItems": [
    {
      "id": "doi:10.0000/example",
      "itemData": { "type": "article-journal", "title": "...", "DOI": "10.0000/example" },
      "locator": "12-14",
      "label": "page",
      "prefix": "see ",
      "suffix": "",
      "suppress-author": false
    }
  ],
  "properties": { "noteIndex": 0 }
}
```

`itemData` 是必要字段，`id` 只帮助重新连接 Catalog。匹配优先级为 DOI → arXiv → 归一化 title + author + year；不能匹配时仍以嵌入快照重新排版，并在 Agentero 的引用选择窗口标记为“未连接到当前 Vault”。不得把绝对 Vault 路径、远程会话 ID、用户路径或凭据写进 `.docx`。

Document Preferences 保持 Zotero-compatible data，保存 `styleId`、locale、note/author-date 模式、field mode 和 bibliography ID。Bibliography 也以 Zotero 兼容字段定位，刷新时只替换该字段的结果。`Unlink Citations` 必须二次确认，因为它会把字段转为不可刷新的普通文本。

## 推荐架构

### 1. 共享 integration engine

Tauri Host 新增 `features/word/`。它不是一个仅返回元数据的 HTTP bridge，而是对官方插件命令执行完整事务的 orchestration 层：

| 部件 | 职责 |
| --- | --- |
| `provider` | 处理 `addEditCitation`、`addEditBibliography`、`setDocPrefs`、`refresh`、`removeCodes` 等命令，维护单文档互斥 transaction。 |
| `word_document` trait | 统一 `get/setDocumentData`、cursor field、enumerate/insert/update/delete fields、footnote/endnote、alert 与 Undo。 |
| `mac_word_driver` | 通过 macOS Automation/AppleScript/ObjC bridge 实现 `word_document`；必须处理 Word 未启动、权限拒绝和前台激活。 |
| `win_word_driver` | 通过 Windows OLE Automation 实现相同 trait；仅 M2 引入。 |
| `citation_domain` | Catalog 映射、Zotero field codec、样式偏好、citation order、refresh plan、bibliography plan。 |
| `citeproc` adapter | 输入 CSL item + style + locale + 当前文档 citation order，输出 citation/bibliography 富文本；先评估可嵌入 Rust/Tauri 的实现及许可证。 |
| `citation_dialog` | Agentero 原生窗口；接收官方 Ribbon 命令后给用户搜索、多引文、locator/prefix/suffix 等交互。 |

```text
official Zotero.dotm command
  -> platform ingress
  -> Agentero provider transaction
  -> Word document driver reads fields/data
  -> Agentero citation dialog + current local Vault Catalog
  -> citeproc + Zotero field codec
  -> Word document driver writes fields/bibliography
```

### 2. macOS ingress（M0/M1）

在现有 `ConnectorController` 管理的 `127.0.0.1:23119` listener 上增加 `GET /integration/macWordCommand`，但只有启用“官方 Zotero Word 插件 provider”且 Zotero Desktop 未运行时才注册/接受该路由。query 的 `agent`、`command`、`document`、`templateVersion` 全部视为不可信：

- 只接受已知 Word agent 与固定命令 allowlist；拒绝未知 template version、缺失字段、过长值和非本机 `Host`。
- HTTP 返回只确认“命令已受理”；异步 provider 再验证前台 Word 进程和活动文档，绝不把 query 中的路径当成可读写文件路径。
- 未修改的官方宏不能携带 bearer token，因而此端点不能达到 Office Add-in 的 token 安全等级。默认关闭、loopback-only、在 Settings 明确显示风险、只接受固定动作；`removeCodes`、迁移或影响多字段的操作在 Agentero 中二次确认。
- 停用 provider 即移除 integration route；`/connector/*` 浏览器导入路由可与它同 listener 共存，但任一模式都不得与 Zotero Desktop 共用 `23119`。

M0 先验证 Word 的 HTTP 请求确实到达、`addEditCitation` 能打开 Agentero 空对话框，并能通过 macOS automation 在临时文档读取/插入一个无害 field。任何一步依赖修改 `Zotero.dotm` 或降低 Host 校验，立即停止 M1。

### 3. Windows ingress（M2）

新增一个隐藏的 Win32 message window，优先注册 `ZoteroMessageWindow` 以兼容官方宏的稳定 Zotero 6 分支；接收并严格解析 `WM_COPYDATA` 的 UTF-8 命令行 payload。不要尝试伪造 Zotero 7 的 Mozilla window tree，除非 M2 fixture 证明旧窗口 class 已不被当前 `Zotero.dotm` 接受。收到 `WinWord` 命令后走同一 provider，再由 Windows OLE Automation driver 操作活动 Word。

由于官方宏会寻找第一个匹配窗口，此模式必须在 Host 启动时探测 Zotero Desktop，并在其运行时拒绝启用。Windows 安装器还要处理 x64/ARM64 Word、Office bitness、OLE/COM 权限、UAC、崩溃后的 message window 回收及 Word modal dialog。该平台没有“在 Rust axum 里补一个 endpoint”的捷径。

### 4. Catalog 到 CSL 的映射

现有 `features/zotero/io.rs` 已能把 Catalog 行转成 Zotero API JSON 并经 Translator 导出。Word 引用不能把每次击键交给远端 Translator，也不能依赖网络；应新增纯 Rust 的 `features/citation/` 映射层：

- `PaperRecord -> CslItem`：优先保留 title、author/editor、issued、container-title、volume、issue、page、DOI、URL、publisher、edition、type；类型映射与现有 Zotero import map 对齐。
- 生成稳定候选 ID：`doi:<normalized>` → `arxiv:<id>` → `bib:<bibtexKey>` → 本地 UUID。ID 不能仅使用可变的 Vault 相对路径。
- 由 provider 生成的 `CslItem` 必须是值副本；通过 Zotero field codec 立即嵌入当前引用。Catalog 的后续修订只在用户点击 Refresh 时才影响文档。

CSL style/locale 作为应用内版本化资源交付，记录 `styleId` 与 bundle version；更新应用后既有文档仍按 `styleId` 可重排。缺失样式时不得替换 field text，先提示用户恢复对应版本或选择新的样式。

## 文档兼容与迁移

### Zotero 兼容字段

provider 使用 Zotero 兼容字段和 document data。普通读者无需 Agentero 也能看到渲染文字；有兼容 provider 的安装才可编辑或刷新。导出 PDF、另存 `.docx`、复制粘贴和协作编辑是 M0/M1 的必测行为。

### 导入 Zotero 字段

Zotero Word 文档会保留 citation field code，且 Zotero UI 允许已不连接其库的 orphaned item 继续存在。Agentero 的导入器可以利用其中的序列化 CSL citation data 做**尽力**迁移：

1. 只读扫描 `ADDIN ZOTERO_ITEM` / Zotero document data，报告可解析、不可解析和缺失 item snapshot 的数量。
2. 用 DOI → arXiv → title+author+year 匹配当前 Vault；不匹配时保留可得的嵌入元数据，绝不自动入库或猜测论文。
3. 在用户选择目标文件名并确认后，对副本写入经当前 provider 验证的兼容字段、重新生成 bibliography；原文件不触碰。
4. 校验副本的 citation 数、字段数和 bibliography 条目数；无法解析的 field 保留原始文本并列出报告，不静默删除。

迁移不等于双向兼容。若用户需要继续让 Zotero 管理该稿件，应保留原文件并继续使用 Zotero；Agentero 只在用户显式迁移后成为该副本的 provider。

## 实现难度与前置需求

### 平台评估

| 平台 | 官方通信方式 | 难度 | 必要实现 | 预估投入 |
| --- | --- | --- | --- |
| macOS Word | `:23119` HTTP command，pipe fallback，AppleScript/ObjC 操作 Word | 中高 | 新 route、provider transaction、macOS Word driver、引用选择 UI、citeproc、Zotero field codec、Automation 权限处理 | M0 约 2-3 人周；M1 约 8-12 人周。 |
| Windows Word | `WM_COPYDATA` command + OLE Automation | 高 | 隐藏 Win32 window、严格 payload parser、Windows Word driver、x64/ARM64/Office 版本兼容、同一 provider core | M2 约 10-16 人周。 |
| LibreOffice | 23116 TCP wire protocol | 中 | frame/transaction transport + 同一 provider core 的 LibreOffice driver | 约 6-10 人周；不阻塞 Word。 |
| 自有 Office Add-in | Office.js + 自身字段 schema | 中高 | manifest、task pane、文档 adapter、配对 bridge、跨宿主兼容 | 约 10-16 人周；作为官方插件兼容失败时的替代。 |

投入以一名熟悉 Rust/Tauri 与对应平台原生 Word automation 的工程师为单位，包含实现和平台手工 QA，不包含法律评审、CI 真机授权和后续 Word/Zotero 版本维护。核心共享层未完成前，不得并行开两个平台 driver。

### 功能与发布前置条件

1. **协议 fixtures**：收集由官方插件生成的空文档、单引文、多引文、author-date、numeric、footnote、bibliography、refresh、unlink 样本；对 field code 与 document data 建字节级或语义级回归测试。
2. **Word 自动化 spike**：macOS 用用户授权的 Automation 从 Agentero 读取活动 Word 文档、插入 field、写 field code、遍历 fields、更新 bibliography，并验证保存/重开/Undo/Track Changes。没有此证明，不开始 citation UI。
3. **citeproc 与样式**：选择可再分发的 citeproc 实现和 CSL style/locale bundle，确认许可证、富文本、脚注、locale 与 disambiguation 行为；不能依赖在线 Translator。
4. **协议安全**：macOS unmodified macro 不带认证 token，需单独威胁建模；路由默认关闭、loopback-only、allowlist、活动 Word 文档复核、破坏性命令二次确认、可见 provider 状态与一键停用都是发布门槛。
5. **Zotero 共存**：启用前检测 Zotero Desktop/端口/Windows 目标窗口；强制单 provider，明确切换流程。不得修改 Zotero 安装、`Zotero.dotm` 或用户 Word Startup 文件。
6. **许可证与商标**：官方 Windows/macOS 集成仓库为 [AGPLv3](https://github.com/zotero/zotero-word-for-windows-integration/blob/main/COPYING)，模板内宏标注 GPL；复用、改编、分发模板或将其实现移植进 Agentero 前必须完成法律评审。技术 spike 只允许最小观察与隔离验证，不把官方源码复制进仓库。Zotero 名称/图标不能作为 Agentero 功能品牌使用。
7. **测试设备**：至少一台受支持 macOS + Microsoft 365 Word；Windows 阶段需 x64 与 ARM64/不同 Office bitness 覆盖。Office 授权、Automation consent 和 Word 更新通道应纳入 release checklist。

### Go / No-Go

M0 的成功标准是：用户不修改官方插件，在 Zotero Desktop 退出时点击现有 Add/Edit Citation，Agentero 能安全接收命令、显示空选择界面，并在用户取消时不改变 Word 文档；再通过 macOS driver 向临时文档写入并读回一个兼容 field。只有这两项和许可证评审均通过，才进入 M1。

以下任一情况为 **No-Go**：需分发或修改 `Zotero.dotm` 才能完成基本交互；无法在不放宽 loopback 安全边界的前提下确认命令来源/活动文档；Word Automation 无法稳定保存兼容 fields；或法律结论不允许期望的分发方式。No-Go 后转向自有 Office Add-in，不继续在不稳定的兼容层上投入。

## 实施分期

| 阶段 | 交付 | 完成门槛 |
| --- | --- | --- |
| M0：macOS Go/No-Go | `macWordCommand` ingress、命令 allowlist、空对话框、Word field read/write、许可评审 | 未修改官方插件即可安全完成握手；所有 No-Go 条件均未触发。 |
| M1：macOS 官方插件 provider | 共享 engine、macOS driver、Catalog→CSL、三种样式、单/多引文、locator、Refresh、bibliography、Unlink | 用户在现有 Ribbon 完成“选择论文 → 插入 → 改顺序 → Refresh → 导出 PDF”闭环。 |
| M1.5：迁移与稳定性 | Zotero fields 扫描、显式副本迁移、未匹配报告、样式/locale 扩展 | 原 `.docx` hash 不变；迁移副本可重新打开并刷新。 |
| M2：Windows 官方插件 provider | Win32 receiver、Windows OLE driver、x64/ARM64 QA | 同一份 fixture 在 Windows Word 完成 M1 闭环；Zotero Desktop 共存检测可靠。 |
| M3：平台扩展 | LibreOffice adapter、remote Vault 只读 provider、更多 CSL styles | 每项独立发布，不阻塞 M1/M2。 |
| 备选：自有 Add-in | Office Add-in + 自身文档 schema | 仅在 M0 No-Go，或后续需要 Word Online/跨平台独立发行时启动。 |

## 测试与验收

### 自动化

- Rust 单测：`PaperRecord -> CslItem` 类型、日期、作者、DOI/arXiv ID 和缺失字段映射；Zotero field codec、document data migration、命令 allowlist、Host guard、请求参数上限。
- Provider 集成测试：未启用、无 Vault、未知 command、无效 template version、端口占用、Zotero Desktop 已运行、Word automation 拒绝；业务 API 不写 Catalog/Vault。
- 前端单测：citation dialog 的候选检索、多引文、locator/prefix/suffix、取消事务不产生写入；Zotero field parser 的正常/损坏输入。
- fixture `.docx` 回归：一篇/多篇引用、author-date、numeric、note style、bibliography、refresh、unlink、迁移、截断 payload、重复 citation ID。

### 手工 Office 矩阵

| 场景 | 验收 |
| --- | --- |
| macOS Word Desktop（M1）/ Windows Word Desktop（M2） | 插入、编辑、Refresh、Undo、脚注、bibliography、Unlink 均正常；异常显示 i18n Toast/原生错误而不破坏字段。 |
| 保存、重开、复制粘贴、Track Changes、协作者无 Agentero | 已有文本不丢失；可重新定位的字段不重复生成 bibliography。 |
| Catalog 元数据变更 | 只有显式 Refresh 改变排版；未匹配项保持 document snapshot 并明确标记。 |
| Agentero 停止、provider 停用、端口被占 | Word 不写半个字段；官方 Ribbon 显示其原有“无法通信”错误，Agentero 不留半完成事务。 |
| Zotero Desktop 正在运行 | Agentero provider 拒绝启用；不抢 `23119`、不修改 Zotero 配置、不接管 Windows 消息窗口。 |
| Zotero 迁移 | 原 `.docx` 不变；副本有完整可刷新的兼容字段，失败项在报告中可见。 |

## 风险与待决项

| 风险 | 应对 |
| --- | --- |
| CSL 排版、富文本和脚注细节复杂 | 采用成熟 citeproc 实现；先固定三种样式；把 style/locale bundle 与 engine 版本写进兼容测试。 |
| 未修改 macOS 宏无法携带 bearer token | 默认关闭、loopback、Host/command allowlist、活动 Word 文档复核、二次确认破坏性操作、短生命周期 provider；不提供任意 Vault 查询 endpoint。 |
| 用户误以为可与 Zotero 双向同步/并行使用 | Settings、文档和切换流程强调“单 provider”；provider 启动前强制探测并拒绝 Zotero Desktop。 |
| 官方插件兼容依赖 Windows/macOS 私有自动化与 Zotero 内部格式 | 先完成 macOS M0；复用共享 engine，Windows/LibreOffice 独立排期；每次 Zotero/Office 大版本更新跑 fixtures。 |
| AGPL/GPL 源码与 Zotero 商标 | 不复制、不分发官方模板/源码；在公开发布前取得书面法律评审结论。 |
| Zotero-compatible field payload 过大或格式变化 | M0 量测并用官方 fixtures 回归；超限时停止而不截断，不能改为私有分段格式破坏兼容。 |

## 预期改动落点

| 区域 | 路径 |
| --- | --- |
| 本设计 | `docs/development/zotero-word-integration.md` |
| macOS ingress | `src-tauri/src/features/connector/server.rs`（增加受限 integration route） + `src-tauri/src/features/word/` |
| Windows ingress | `src-tauri/src/features/word/windows/`（新增；Win32 message receiver + OLE driver） |
| macOS Word driver | `src-tauri/src/features/word/macos/`（新增；Automation/ObjC bridge） |
| CSL 领域映射 | `src-tauri/src/features/citation/`（新增；不与 `features/refs/` 的论文引用解析混合） |
| App 设置/状态 | `src/lib/settings/*`、`src-tauri/src/features/system/settings/*` |
| Zotero field codec / fixtures | `src-tauri/src/features/word/zotero_codec.rs`、`src-tauri/tests/fixtures/word/`（新增） |
| i18n | `src/i18n/locales/en/*.json` 与对应 `zh-CN/*.json` |
| 已实现文档 | 完成后补 `docs/frontend/`、`docs/backend/`、`docs/usage/`，并将本文改为历史设计或删除 |

---

*修订：2026-08-05 — 重评官方插件兼容：macOS `:23119` HTTP provider 优先，Windows `WM_COPYDATA` + OLE 后置；新增投入、许可证、安全和 Go/No-Go 门槛。*
