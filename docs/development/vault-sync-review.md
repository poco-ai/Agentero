# Vault 同步审计与重构提案

2026-11-19 · 审计基线 `3585e46ed` · **下文审计记录对应修复前的代码，不是当前运行说明**。覆盖设置页、Tauri 命令与调度器、headless CLI、core 的 Git 和对象存储两条执行路径；PDF 全文翻译仅核对指定 issue 及其与同步的交界。Zotero、Overleaf、PDF 滚动等没有参与 Vault 协议，不在本次审计范围。使用方式和磁盘格式见[现行协议说明](../backend/sync.md)。

**结论：保留两套引擎，统一谁有权做什么。** Git 的删除是仓库历史的一部分，对象存储的删除是两份快照相对共同基线的判断。硬把两者塞进一个「同步后端」接口，反而会隐藏最重要的差异。首要工作不是拆文件，而是防止把**未观察、未参与、未成功发布**误判为**用户删除**。下文 A–E 有隔离环境实测；其余明确标为源码推演。

## 本轮实施结果

| 审计项 | 新行为 | 验证方式 |
|---|---|---|
| A：两台设备并发发布 | 不兼容端点停止；可靠端点先发布后落盘，CAS 输家重新合并，不得用失败计划改工作树。 | loopback WebDAV 在绑定后改为忽略条件；内存对象存储模拟竞争及发布响应丢失。 |
| B / E：范围开关 | Git 只排除新增文件，不把已跟踪 PDF 删除提交给另一台设备；已识别的集合与论文自己的 `source/` 分开分类。 | 两个临时工作区与 bare Git 仓库、嵌套同名集合。 |
| C：解绑与互斥 | 配置、解绑、手动和自动同步均持同一 Vault 锁，解绑保留锁文件。 | 独立进程持有文件锁时解绑失败，释放后成功且锁文件身份不变。 |
| D：文件和目录互换 | 确认远端版本后再清除已知阻挡项和空目录，保留未知文件；未完成的落盘在下轮对账。 | 双向类型转换、目录含保留项、部分文件已落盘后恢复。 |

实现没有引入通用任务框架，也没有改变远端格式。Git 保留原生合并；对象存储分为计划、发布、落盘、恢复四个步骤。升级前应优先确认远端支持条件写；旧版已经传播的删除不会自动恢复。协议、运维步骤及安全边界见[同步说明](../backend/sync.md#条件写与恢复)。不包含多绑定（#1048）、孤儿对象回收、译文缓存逐块合并或 Windows / 生产云端认证。

额外验证了两个不适合只用 mock 判断的边界：两个真实 Git 工作树在检出或分叉合并前均拒绝覆盖本地忽略文件；挂载设置页后切换 Vault，旧请求晚到不会覆盖新 Vault 的草稿。本轮一次性用例仅作本地验证，未加入默认测试集。真实 MinIO / WebDAV 端到端测试未运行。

## 先核对四个 issue

| Issue | 原报告与当前代码 | 本次判断 |
|---|---|---|
| [#1065](https://github.com/poco-ai/Agentero/issues/1065) | 参考文献作者缩写、带占位符的短图注收到空译文，可能拖累整段。关闭时选择的是默认跳过参考文献；`src/lib/pdf/layout/layout-translate.ts` 的 `canRecoverProtectedResponse` / `translateProtectedSpans` 仅对带标记且有正文的缺译恢复，回填后仍校验。 | **不是传输丢块**。并非「作者缩写切句已全面修好」，也不应把鉴权、限流、取消等失败当作空译文重试。相关本地测试通过，未实连腾讯。 |
| [#1066](https://github.com/poco-ai/Agentero/issues/1066) | 有可用部分缓存，却先排队补全。`use-pdf-layout-translate.ts` 将缓存展示和显式补全分开；`test/pdf-layout-translate-lifecycle.test.ts` 的部分缓存用例分别挂载正文和译文面板，并在已有排队任务时断言不订阅、不新跑、不写回。 | 原报告路径有行为测试且通过。不匹配当前源文的旧缓存并不算命中。不要让 Vault 同步在收到文件后代用户启动翻译。 |
| [#1165](https://github.com/poco-ai/Agentero/issues/1165) | Git 配置保存后强制恢复全量。当前 `config.rs` 的 `normalized()` 已保留部分范围，`git_config_preserves_partial_scope` 通过。 | `21b446ee4` 已在审计基线上；不是待修旧 bug。实际关掉类别后**其他设备**怎样，是另一件事（B）。 |
| [#1166](https://github.com/poco-ai/Agentero/issues/1166) | 老代码按固定两层认论文。当前 `scope.rs` 被 `scope_sizes`、扫描、merge 和 Git 规则生成复用；既有用例覆盖多层集合、同名 PDF、有 marker 的异名 PDF 和嵌套资产。 | 原固定深度问题已处理；同名集合与资产目录仍有歧义（E）。不应再增加一套 glob 修分类。 |

四个 issue 均按 GitHub issue API 核对为已关闭。它们有一个真实交点：`layoutTranslateSidecarPath` 把译文放进论文的 `source/layout-translate.json`。对象存储排除 `source` 时不会传这份缓存；纳入时，它按整个 JSON 文件同步，**不是**按译文块合并。两台设备各补了一半时，普通 JSON 的修改时间胜出策略不保证保留两份进度。这是缓存可用性的限制，不是 #1065/#1066 回归的证据。

## 一次同步经过哪里

| 环节 | 现有责任与值得保留的约束 |
|---|---|
| 入口 | `src/components/settings/panes/sync-pane.tsx` 经 `src/lib/sync/api.ts` 调 Tauri；手动和自动走 `perform_sync`，退出尽力同步直接走 core。`cli/src/commands/sync.rs` 也调用 `engine::sync_vault_locked`。Host 的 lease 给 UI 提供进程内状态；core 的文件锁才负责跨进程互斥。 |
| 对象存储 | S3、WebDAV、Agentero Cloud 共用 `RemoteStore`。`run_sync` 先刷待写 sidecar，扫描本地，读取 HEAD，必要时验证身份、取 manifest；按 `base/local/remote` 制定计划，**先改本地**，再上传缺失 blob、写 manifest、发布 HEAD，最后保存本机基线并刷新 Catalog。健康空转保留一次 HEAD GET；未发布 blob 日志用于中断续传。官方云还需注册/解析服务端 Vault，不应把协议 GET 数当其总 HTTP 请求数。 |
| Git | `git::sync_vault` 刷 sidecar → 更新范围规则、暂存和提交 → 按需 fetch / merge → push → 记状态并刷新 Catalog。沿用 Git 原生历史与冲突处理，不需要自实现三方文本合并；本地及远端仓库均不应跟踪 `.agentero`。 |
| 权威 | 用户文件和 Catalog 不是同步临时状态；不可直接同步 SQLite。对象存储 HEAD 指向已发布清单；本地 base 是**该设备上次认可**的文件集；`pushed.jsonl` 只是传输优化，不是发布证明。Git 的远端分支是共享历史，不能表达设备私有偏好。 |

## 已复现的五个场景

均用 macOS 上的实际 `agentero-cli`，每组独立临时 Vault、HOME、XDG 配置，无真实账号或资料。A/D 用仅监听 loopback 的内存 WebDAV 替身；B/E 用本地 bare Git；C 用操作系统文件锁。下列优先级按用户后果，不按代码规模。

| 优先级 | 触发与观察 | 根因、影响与先行措施 |
|---|---|---|
| **A · P1 无条件 HEAD 覆盖** | 已绑定同一远端且共同基线为 v1。A/B 各新增不同笔记，在两次 HEAD PUT 处用屏障令两者都基于 v1 发布。两进程都返回 `ok:true, version:2`；被覆盖方再同步返回 `deletedLocal:1`，自己新增的笔记从磁盘消失。 | `engine.rs::run_sync/merge` 只在 `PreconditionFailed` 时重算；普通 PUT 两次都成功。后写清单缺少前写笔记，下一轮遂被当作远端删除。blob 可能还在，但当前清单没有它。**条件写不可靠时，不要让多个设备并发写，也不要以自动重试作为保护。** |
| **B · P1 Git 排除传播为删除** | A/B 同分支、同一已跟踪 PDF，B 仍为全量。A 关 PDF 再同步：本机文件仍在，`removedRemote:1`；B 同步成功，`deletedLocal:1`，原 PDF 从 B 的工作区消失。 | `git.rs::commit_local/untrack_excluded` 的 `rm --cached` 只对发起端「仅改索引」；B 的 `merge_remote` 接收的是删除提交。旧提交可恢复，不等于工作区没有损失。**在共享仓库中不要把现开关当作“仅此设备不传”。** |
| **C · P1 解绑破坏互斥** | 外进程持有真实 `.agentero/sync/lock` 独占锁。CLI `sync disconnect --yes` 仍返回成功，锁路径消失。 | 两端 disconnect 均未用 `SyncLock`，`local.rs::clear` 递归删除包含锁的目录且忽略错误。在 Unix 上旧句柄仍锁旧 inode，新创建的同名文件不受保护；在途 pass 还可能写回被遗忘的状态。实测为 macOS，未据此推断 Windows 的删除结果。**解绑前先停所有写入端。** |
| **D · P1 文件变目录后重试不前进** | A/B 原先都有普通文件 `entry`；A 用目录和 `entry/child` 替换并成功发布。B 连续两次同步均报 `Not a directory (os error 20)`。 | `engine.rs::apply_local` 固定先下载后删除，安装子文件时旧父文件还在。反向转换也需要显式处理空目录和未跟踪子项，不能用「先递归删目录」修。遇到此状态先备份本地阻挡项、移出该路径再同步。 |
| **E · P1 同名集合导致笔记漏传** | 放入 `papers/reading/source/topic/paper-x/NOTES.md`，仅关闭 source。Git 同步成功，却生成 `/papers/reading/source/` 忽略整棵子树；远端树没有 `NOTES.md`。 | `scope.rs::classify` 在确认论文根之前先命中名为 `source` 的路径段；统计和对象引擎复用同一分类器，静态上也受影响。不是旧版「层数不够」问题。修复前，类似布局不要关闭对应类别；审查清单时不能只看字节总数。 |

**A 的额外边界：** 已有 HEAD 的替换需要 `If-Match` 和可用 ETag；首个 HEAD 和远端身份的创建需要 *create-if-absent*。`webdav.rs::probe_conditional_writes` 只检验前者的过期标签，`s3.rs` 对新随机键第一次条件写返回成功也不足以证明服务器会拒绝重复创建或过期替换。一个 `conditional_writes: bool` 混淆了这两种保证。A 证明的是无条件写协议的后果，**不是**对每个供应商的实测结论。

## 源码还能确定的缺口

下表给出可检查的执行顺序；没有把源码推演写成已发生的生产事故。

| 位置 | 失败条件与后果 | 应建立的约束 |
|---|---|---|
| `engine.rs::run_sync/refresh_catalog_if_needed`、`git.rs::finish` | 本地先改，之后上传、发布或 push 失败。下一次物理文件已相同，当前轮 `downloaded/deleted_local` 可均为零；上次没执行的 Catalog 重建也就不再触发。重建本身失败只记日志。 | 把「磁盘需重新投影」记在本地持久状态，成功投影后才清；不能依赖某一轮的网络计数。不要把 SQLite 加进同步。 |
| `engine.rs::merge/conflict_name/apply_local` | 冲突名只精确到秒，不与已有本地/远端名字去重。已有同名副本时，保留本地的一支只校验来源，`fs::copy` 可覆盖目标；计划表里也可出现同一名字争用。 | 先预留不冲突的名字，目标只允许新建；重试复用同一计划身份，不靠当前时钟再起名。 |
| `local.rs::read_base/read_meta`、`engine.rs::ensure_remote_identity` | 不存在、不可读、JSON 损坏都可能变成默认值。能否采纳外来 Vault 看的是 `base.files.is_empty()`，不是「是否曾同步」；历史为空或状态损坏都可能被当首次加入。`record_sync` 还分两次写 base/state。 | 首次、有效、损坏分别返回；有历史但不完整时停止推断删除/自动改绑，显式修复。不要丢弃上一份可读检查点。 |
| `config.rs::read_all/set/remove`、两个 configure 入口 | 全局 `sync.json` 的读改写无跨进程事务，不同 Vault 同时保存会后写覆盖先写；文件解析失败后 `set` 会用空表重写。桌面 configure 取 Vault 锁，CLI configure 不取，且仅加每库锁无法保护跨库注册表。 | 全局配置的短时读改写锁，与单 Vault 操作锁分开；网络探测不占全局锁；解析失败不覆盖原文件。 |
| `scheduler.rs::run_loop/stop_scheduler` | watcher 初始化失败会丢掉持有发送端的回调，`rx.recv()` 得到 `None` 后 `break`，定时兜底也退出。另一个问题是 `abort` 释放 lease 不等于阻塞任务或远端请求已停止，且未发终态。 | watcher 不可用时只关事件分支，保留 interval；停止触发与取消在途操作分离，等安全点后再报告结束。 |
| `sync-pane.tsx::refresh/save` | A 的状态请求晚于 B 返回，切库时的同步 reset 不能阻止旧响应 `setForm`；同库终态 refresh 也会覆盖用户尚未保存的 scope 或地址。 | 请求结果核对 Vault 和请求代次；已保存状态与编辑草稿分离。scope 字节数已有取消保护，可复用其思路。 |
| `snapshot.rs::scope_sizes` 与 `scan_vault` | 前者忽略遍历错误、metadata 失败计零，后者会报错。UI 的 `0 B` 无法区分「确实为空」和「没读完整」。`size + mtime_ms` 复用哈希也不是文件内容相等的保证。 | 体积结果区分完整与不完整。保留稳态哈希缓存，但不把它用作破坏性替换的最终验证。 |

另一个防御边界：扫描器不跟随目录链接、跳过私有路径；远端 manifest 的语法验证和本地写入不是同一套规则。`validate_manifest` 检查路径文本和哈希，`verify_local_unchanged` 检查末端文件；不能由此断言所有祖先目录、平台路径和应用保留目录都已验证。应在本地执行器集中做根目录约束和保留项拒绝，无法安全定位就不写、不删；本次未做攻击性验证。

## 建议的最小架构

1. **统一操作入口，不统一协议。** core 收回 `configure / run / disconnect` 的互斥、绑定读取和清理；拿 Vault 锁后重读有效绑定，锁文件不属于可清理数据。保留 Host 的进度/会话凭据适配与 CLI 的参数/输出；scheduler 只提交运行意图。保留 `SyncStore`、系统 Git 和现有调用名称，无需再造调度框架或把 Git 假装成 blob store。
2. **一份文件清单，两种范围语义。** 在 `scope.rs` 先以已有 paper marker、同名主 PDF 和兼容规则确定论文根，再在根内解释资产目录；保留一级旧布局，无标记且归属不明时不要排除笔记。统计、扫描和 Git 索引使用同一分类结果。对象引擎的设备范围令被排除项「不参与」，不是删除。Git 的建议默认是**只排除新增的未跟踪文件，保留已跟踪项**；要把历史跟踪项从当前分支移除，应另设显式仓库操作，预览影响路径并确认。这比立即切换到 [Git sparse-checkout](https://git-scm.com/docs/git-sparse-checkout) 小：后者控制工作树物化，不等于保留本机文件而不上传。
3. **对象引擎分清计划、发布与落盘。** 保留现有 `merge` 规则，把输入变成不可变的「基线、本地观察、远端 HEAD、范围」；输出文件结果、需传输的内容和有前置条件的本地操作。计算时不取时钟、不写盘。先暂存并校验内容，在 `.agentero/sync` 留下恢复记录，再按能力有条件发布 HEAD；比较失败则重读 HEAD 重算，**不在旧计划上继续改工作树**。成功发布或仅采纳远端后，按依赖顺序落盘：先保护阻挡项和冲突内容，再做文件/目录转换，每次替换/删除前复核本地内容。执行期间用户有新编辑就保留，重新规划，不能为了匹配已发布清单强制覆盖。下载不需要发布时也走相同的落盘与恢复路径。
4. **把可恢复性写成明确状态。** 本地最少区分「已准备（含预期 HEAD、计划及输入内容身份）→ 已发布/已采纳 → 已落盘、待 Catalog 投影 → 完成」。若响应丢失，比较不可变 manifest key，不按版本数字猜测是否是本次发布；HEAD 已继续前进则用恢复记录对账，不能盲目重放。`pushed.jsonl` 只优化流量。先用现有 JSON 原子写原语，不引入第二个数据库、不升级远端格式。

**无 CAS 的决策不能靠抽象解决。** 将覆盖已有 HEAD 与独占创建分开探测；对已有 HEAD，缺 ETag 或发布能力未知，一律不能宣称支持多写者。推荐默认拒绝不安全发布、保留读取和诊断；兼容确有需要的无 CAS 旧绑定，可经显式选择保留单写者模式，其他设备不可自动写。仅发警告、发布前多 GET 一次、或给每台设备各加一把本地锁，都不能保证多机互斥。检测到同版本不同 manifest 是分叉信号，应停止自动删除；这只是止损，并不能识别所有丢失更新。

## 交付顺序与验收

| 切片 | 独立交付与验收门槛 |
|---|---|
| **1 · 先止损** | 驳回不安全 HEAD 发布和分叉后的删除；让 core 在持锁时解绑/改绑，清理不删除锁本身。重跑 A/C：两端不能都报安全成功后再删笔记；忙时保持原绑定和基线。Windows 需单独验证文件锁和取消。 |
| **2 · 明确范围** | 决定 Git 已跟踪文件策略后再改 UI/CLI；用 B/E 加上旧一级、深层异名 PDF、`source/attachments`、`assets/source`、缺 marker 的资料夹做契约验证。A 关闭范围后，B 的干净工作区不能在未确认的情况下消失文件。旧版已提交的删除不能自动撤销；提供从旧提交恢复的路径，不重写历史。 |
| **3 · 拆计划和执行** | 先无行为变更抽纯计划，再引入暂存/恢复与类型转换。D 必须收敛；另验反向目录转文件、目录含未跟踪内容、同名冲突副本、扫描后本地编辑、发布响应丢失、落盘中断、Catalog 重建失败。重启只补未完成工作；无关文件保持原样。 |
| **4 · 调度与界面** | watcher 初始化失败仍能按时同步；手动/定时/退出及 CLI 竞争只准一个写者；快速切库、编辑草稿时收到终态不串表单。保持空闲对象存储单次 HEAD 请求、已上传 blob 不重复发送，Git 仍用原生 merge。 |

迁移时先兼容读取旧 `base.json/state.json` 和缺省全量的旧 manifest；仅在 store、HEAD、版本与基线能对齐时生成新检查点，歧义走只读诊断。若有未完成的恢复记录，**先完成或安全取消，不允许旧引擎接管该 Vault**；回滚前保留用户文件和原检查点备份。绑定新增能力字段按未知处理，不沿用旧布尔值作为已验证保证。多个绑定（[#1048](https://github.com/poco-ai/Agentero/issues/1048)）暂缓：等单绑定恢复语义成立后，再讨论每个远端独立基线，不能多个后端共用一个 base。

## 修复前的验证记录

| 执行项 | 结果和界限 |
|---|---|
| `cargo test -p agentero-core features::sync:: --lib` | 61 通过，2 个依赖真实 MinIO/WebDAV 的测试按默认设置跳过。包括 Git 本地往返、排除、冲突、锁、scope、对象引擎空转和续传。 |
| `cargo test -p agentero-cli --test cli_sync` | 6 通过，包括独立 HOME 下配置/错误契约、Git 本地 bare remote。 |
| `pnpm exec vitest run test/pdf-translation-references.test.ts test/pdf-translation-recovery.test.ts test/pdf-layout-translate-lifecycle.test.ts test/pdf-layout-sentences.test.ts test/pdf-layout-translate-run.test.ts test/pdf-translate-run-selection.test.ts` | 6 文件、129 用例通过；覆盖参考文献过滤、缺译保护标记恢复、完整/部分缓存及显式补全。 |
| 额外双端实验 | A–E 是现有测试通过后仍可复现的反例。只在临时目录运行，未把一次性探针或新增测试提交到仓库。没有连接真实云服务、运行桌面端到端流程或在 Windows 上验证；源码推演项仍需在对应切片做故障注入。 |
