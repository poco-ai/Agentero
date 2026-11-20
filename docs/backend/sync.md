# Vault 云同步（对象存储 / Git）

桌面端和 CLI 均可在多个设备间同步本地 Vault。对象存储包括支持条件写的 S3、WebDAV 和 Agentero Cloud；Git 后端直接同步工作树和分支。**能连接、上传文件，不代表远端能安全地同步。**

引擎位于 `crates/agentero-core/src/features/sync/`（Tauri 无关），桌面端与 headless CLI 共用同一份实现——冲突处理、失败恢复与请求预算语义完全一致；CLI 侧见 `agentero sync`（[cli.md](cli.md)）。桌面端仅在 `src-tauri/src/integration/sync/` 叠加 IPC 命令与调度。

S3 / WebDAV / Agentero Cloud 共用同一套状态化同步协议（内容寻址 blob + 不可变 manifest + CAS `HEAD`），契约收敛在 `store.rs` 的 `RemoteStore` trait，`SyncStore` 枚举按配置选择实现，引擎对具体后端无感知。新增这类后端 = 新客户端模块实现 trait + 枚举一个变体。Git 不走 blob store：远端就是 Git 仓库本身，见「Git 后端」。设置页可切换后端；已配置的 Vault 锁定后端选择，需先解绑再切换（换后端即指向另一个远端 store）。Azure Blob、百度网盘等无 S3 / WebDAV 对应凭据模型的服务仍不能接入。

## 模块

`crates/agentero-core/src/features/sync/`（桌面端与 CLI 共享）：

| 文件 | 职责 |
|---|---|
| `config.rs` | `SyncBackendConfig`（`backend: s3 \| webdav \| git` 判别字段，旧 `sync.json` 缺省即 S3）与凭据持久化：XDG `agentero/sync.json`（按 Vault 路径分键，0600）；`secretKey` / `webdavPassword` 出站掩码 / 回传掩码保留旧值（同 translate API key 先例）；`conditionalWrites` 持久化连接测试的条件写探测结果；`webdavUrl` 归一化（trim 尾斜杠 + 坚果云根地址展开，见 WebDAV 节）；Git 的 `gitRemote` / `gitBranch`（Git 不存密钥）；`scope` 同步范围（见下；Git 把排除项写进 `.gitignore`）；`remoteIdentity()` 给出远端 store 标识（后端 + 地址/bucket/prefix + 账号名 + Git 分支，不含密钥），供本地状态在换 store 后判失效 |
| `store.rs` | 后端无关抽象（Strategy）：`RemoteStore` trait 定义后端契约（`ensure_root` / `get` / 条件 `put` / `probe_conditional_writes`，futures 均为 `Send`），`SyncStore` 枚举是唯一的组合点（从配置选择具体客户端并转发）；engine 只依赖 trait，可用内存实现做引擎测试。另含两个客户端共享的 HTTP 工具：`send_with_retries`（幂等操作传输层 3 次重试）、`check` / `etag_of` / `error_chain` |
| `s3.rs` | 最小 S3 客户端：GET / 条件 PUT（`If-Match` / `If-None-Match`）/ DELETE / ListObjectsV2，reqwest + 手写 SigV4（HMAC-SHA256 自实现，RFC 4231 向量测试）；强制条件写（见下） |
| `webdav.rs` | WebDAV 传输与条件写探测；实验日志模式另用普通 PUT 和 Depth 1 PROPFIND，校验 multistatus XML 与目录完整性。 |
| `snapshot.rs` / `scope.rs` | Vault 扫描、范围统计与附件分类；`size+mtime` 未变时复用 base 哈希；统计和各后端共用分类规则（见「同步范围」） |
| `local.rs` | `.agentero/vault.json`（Vault UUID）、`.agentero/sync/{base,state}.json`（`state.json` 含 `lastError`，上次失败原因，成功即清除）、`.agentero/sync/pushed.jsonl`（已上传未发布的 blob，见「请求预算」）；watcher 忽略 `.agentero/`，无事件回环 |
| `lock.rs` | 跨进程 pass 锁：`.agentero/sync/lock` 上的 advisory 文件锁（flock / LockFileEx），桌面端、CLI 与 cron 在同一 Vault 上串行化；锁随文件句柄释放，进程崩溃不残留 |
| `engine.rs` / `engine/apply.rs` / `engine/recovery.rs` | 分别做三方合并与发布编排、暂存与校验落盘、发布意图与检查点恢复。远端 CAS 失败不执行本地计划。 |
| `git.rs` | Git 同步（见「Git 后端」）：系统 `git` 子进程、仓库/分支/origin 校验、`.git/info/exclude`、按 scope 写 `.gitignore` ，仅撤销新增排除项的暂存、commit → fetch → merge → push、原生冲突 abort、差异计数与 catalog 刷新 |

`src-tauri/src/integration/sync/`（desktop-only 壳层）：

| 文件 | 职责 |
|---|---|
| `mod.rs` | 引擎 re-export + `SyncService` 与 `SyncRunLease`：手动、自动与退出同步共用按 Vault 的进程内占用，guard 释放覆盖正常返回、错误、超时和 task abort（跨进程占用由引擎内文件锁负责） |
| `commands.rs` | `sync_get_status` / `sync_configure` / `sync_disconnect` / `sync_now` / `sync_scope_sizes`（本地各附件分类体积，供设置页展示）；广播 `sync:state` / `sync:progress` 事件 |
| `scheduler.rs` | 自动同步：每 Vault 一个后台任务——启动时同步一次、改动静置 30s 后同步、按 `intervalMinutes`（15/30/60）定时兜底；退出时尽力推送（每 Vault 限 5s） |

## Remote 布局与一次同步

```text
<prefix>/vault.json                  { vaultId, formatVersion, encryption }
<prefix>/HEAD                        { version, manifestKey, updatedAt } ← 唯一可变对象，CAS 推进
<prefix>/manifests/<v>-<nonce>.json.gz
<prefix>/blobs/<aa>/<sha256>         gzip(内容)，内容寻址天然去重
```

一次对象存储同步：恢复未完成记录 → 刷出待写 sidecar → 扫描 → 读 HEAD → 对非空转同步检查条件写能力、身份、清单版本和路径树 → 用上次认可的 base、本地快照和远端清单三方合并。先暂存并校验下载、上传缺少的 blob 和不可变清单，再记录发布意图并 CAS 推进 HEAD。明确收到条件失败时，丢弃暂存计划，用**原始 base 和本地扫描**对新 HEAD 重算（最多五轮）。仅在发布成功或无需发布、直接采纳已读清单时，才把远端文件改动应用到工作树。

### 请求预算（空转短路 / 断点续传）

按请求数计费或限额的后端（坚果云 WebDAV 免费版 600 次/30 分钟、付费版 1500 次/30 分钟，且为**账号级**，与官方客户端共享）下，空转 pass 与失败重试的开销才是主要成本。引擎因此在三处收敛，判据均只比 **hash**（不比 mtime，见下）：

- **已是最新**：若远端标识、HEAD 版本和 manifest 键与上次成功同步一致，本地扫描与基线一致，且范围未改、无需恢复，对象协议只发 1 次 HEAD 指针 GET；云服务注册不计入此数。首次绑定空远端时从本地文件建立清单；已确认的 HEAD 消失则停止，不推断为删除。
- **无需发布**：合并结果与完整远端 manifest 的路径和哈希一致时，更新本地 base/state 并沿用远端版本。这样下载时产生的 mtime 差异不会让设备反复推进 HEAD。每次覆盖或删除本地文件之前，会在网络读取之后复核该文件的内容。
- **断点续传**：`pushed.jsonl` 记录按 store 身份隔离的已上传 hash，避免同一轮或中断重试时重复传输。它不证明 HEAD 已经发布；成功落盘或采纳后清除。

`MemStore`（`engine.rs` 测试内的内存 `RemoteStore`，带请求计数与可注入的 PUT 配额）覆盖这三条：`idle_pass_costs_one_request`、`idle_devices_do_not_ping_pong_head`（含「真实改动仍会发布并被对端拉取」）、`interrupted_upload_resumes_without_resending`；日志本身的追加/去重/换 store 失效在 `local.rs` 测试内。

合并规则：单侧改动直接采纳；双侧同改 `*.md` 保留 mtime 较新者、较旧者存为 `<name> (conflict <短内容哈希>).md`，重名时追加序号，不覆盖已有副本；`*.table.json` 同样保留两份，冲突副本保留完整 `.table.json` 扩展名以便在科研表格编辑器中核对；其余文件（sidecar/marks/二进制）按 mtime LWW；删除 vs 修改保留修改。Git 使用自身合并与冲突流程。

## 同步范围（Sync Scope）

范围开关控制论文的 PDF、源码和附件，可减少本机传输和新上传占用的远端空间。笔记、`metadata.json`、`marks/` 和 `assets/` 始终同步。内容寻址后端按设备应用范围。Git 把 `# agentero-sync-start` / `# agentero-sync-end` 区块随仓库版本同步。

- **分类**（`scope.rs`）支持 `papers/` 下任意层级的集合和子类。论文根级 PDF 通过同名目录或 `NOTES.md` / `metadata.json` 识别，并兼容原有一级论文目录中的 PDF。进入论文的 `source/` 或 `attachments/` 后，子树归入对应类别。进入 `assets/` 或 `marks/` 后，文件始终同步。 已有后代论文证据时，集合本身即使叫 `source` / `attachments` 也不算论文资产；缺证据时保留一级目录的旧规则。
- **内容寻址后端**：关闭的类别跳过本地上传、下载和删除，保留远端清单已有条目供其他设备使用。本地 base 只记录本设备参与同步的文件。重新开启后，可从远端下载仍存在的文件。旧版远端 manifest 的 `scope` 字段继续保护曾被过滤而缺失的条目。
- **Git**：范围开关影响共享 `.gitignore` 和尚未提交的新文件，不是设备私有的下载过滤器。已跟踪文件继续接收编辑、拉取及用户主动删除。关闭类别不产生删除提交，不回写旧历史。已被旧版本移除的资料需从备份或已知正常的 Git 提交恢复。
- **重取**：PDF/TeX 可从 `metadata.json` 的来源字段（arXiv ID / DOI / `pdf_url`）重新下载——`job_download_assets_enqueue`（DownloadAssets 后台任务；库表格右键「从来源下载 PDF」、打开论文时自动补下均走此路径）。库列表的 `has_pdf` 由 `paper_list` 经 CapsCache 投影。
- **配置**：`SyncBackendConfig.scope`（缺省全量，兼容旧配置）；设置页以「同步范围」小标题分组展示逐类开关（附本地体积 `sync_scope_sizes`），默认全部开启。

## WebDAV 后端

`webdav.rs` 用 reqwest 手写（不引第三方 WebDAV 库），Basic Auth（坚果云应用密码 / Nextcloud 应用令牌 / NAS 账号均兼容）：

- **目录模型**：WebDAV 需显式建目录。PUT 前按需逐级 `MKCOL`（405 = 已存在），已建目录在客户端内缓存，稳态零额外请求；连接测试 `PROPFIND Depth:0` 根目录，404 则连目录一起创建——用户可直接指向一个不存在的目录（如 `https://dav.jianguoyun.com/dav/agentero/`）。坚果云根地址（`https://dav.jianguoyun.com/dav/`）自动展开为专用文件夹 `agentero/`：根集合可列表但拒绝创建文件（PUT 一律 404 ObjectNotFound），而它恰是官方文档给出的地址；展开是纯函数（trim 尾斜杠 + 根地址映射），`normalized()` 与客户端构造共用——新配置回显实际地址，旧配置无需重存即自愈。
- **连接测试**：PROPFIND / MKCOL 确认目录可用，随后用一次性 key 检查创建和替换条件；认证、权限和服务错误向上传递。详见「条件写与恢复」。
- **兼容性**：已有 HEAD 必须提供强 ETag。即使服务器支持 `If-Match`，忽略 `If-None-Match` 仍不能保证两台设备首次建立 HEAD 时不会互相覆盖。
- **重试**：GET 等操作可重试传输错误；条件 PUT 返回不明确时不透明重发，由下一轮对账。

- **安全约束同 S3**：`https://` 强制（仅 loopback 放行 http），密码掩码同 `secretKey`。NAS 场景的明文 http 与自签名证书 https 均不可用。
- **兼容性（实测）**：路径段 percent-encode、请求带尾斜杠集合形式。坚果云特性：MKCOL 对根 `/dav` 返回 403 OperationNotAllowed（按「已存在/受保护」容忍）；根 `/dav` 不允许创建文件（PUT 一律 404 ObjectNotFound，[#681](https://github.com/poco-ai/Agentero/issues/681)），故根地址自动落到 `agentero/` 子文件夹（见「目录模型」）；顶层目录名长度有限制（`sandbox name is too long`）；顶层目录不可经 WebDAV 删除、非空目录删除需先清空子项——`sync_disconnect` 本就不动远端数据，仅测试清理需注意；**请求按账号限频**（免费 600 次/30 分钟、付费 1500 次/30 分钟），空转成本见「空转短路」。这些历史互操作记录不是当前服务对条件写的保证，以实际探测为准。
- **集成测试**：`engine.rs` `two_device_roundtrip_against_webdav`（`#[ignore]`，env `AGENTERO_SYNC_WEBDAV_TEST_URL` / `_USERNAME` / `_PASSWORD`，连接测试 + 发布/加入/编辑/分歧冲突/收敛全流程，镜像 MinIO 测试）。

### 普通上传的 WebDAV 日志原型

在每台测试设备上，用下面的命令绑定同一个专用空目录或加入已经初始化的日志。密码继续使用原有 CLI 凭据渠道。已有格式 1 的远端无法原地转换。初次试用可以复制本地笔记到新的测试 Vault。显式绑定后，CLI、桌面手动同步和调度器走同一个 core 入口。

```bash
agentero --vault ~/test-vault sync connect webdav https://example.com/dav/agentero-test \
  --journal --username demo
agentero sync run --vault ~/test-vault
```

远端 `vault.json` 标记格式 2。文件内容沿用 `blobs/`，每批改动最后写到 `manifests/<哈希首位>/<完整 SHA-256>.json`。每条记录包含本设备已观察到的父版本、添加的文件版本和显式撤销的旧版本。两台设备各自发布后，只需其中一台在线即可合并；并发编辑保留双方内容，删除只撤销操作方已经见过的版本。扫描、内容校验、冲突命名、暂存落盘和 Catalog 刷新沿用现有引擎。本地 `.agentero/sync/webdav-journal.json` 按绑定保存已读记录，以及落盘中断时用于恢复的路径状态。解绑会清除此检查点。

每轮按一级目录枚举，最多 16 个哈希子目录，只下载未缓存的记录。单目录达到 749 个子项、服务端返回不完整的 XML、漏掉已知记录或缺少引用的版本时，本轮停止。首次加入时无法识别服务端静默隐藏的独立记录；后续列出时补收，目录中缺少某项本身不会生成删除。原型尚无分页、历史压缩和旧格式迁移。开启入口只在 CLI。

## Git 后端

- **形态**：Vault 根目录就是 Git work tree；远端名固定 `origin`，分支由 `gitBranch` 指定（默认 `main`）。不经过 blob/manifest 引擎，Git 自己保存历史与合并。
- **要求**：本机安装 Git 并可通过 PATH 找到（桌面 GUI 也走 `resolve_command` 的补充路径）。Vault 不能位于另一个 work tree 内、不能是 bare repo / detached HEAD；已有仓库的当前分支必须与配置一致、已有 `origin` 必须与配置 URL 一致，否则同步报错而不静默改仓库。
- **忽略**：`.agentero/`、`.DS_Store`、`*.tmp`、`node_modules/` 通过 `.git/info/exclude` 排除，不写进 `.gitignore`；本地或远端已跟踪 `.agentero` 直接报 `git_agentero_tracked`。`catalog.sqlite` 仍可由 sidecar 重建。同步范围关闭的 PDF / `source/` / `attachments/` 写在 `.gitignore` 的标记区块里，已跟踪文件不因开关而移出索引。
- **一次 pass**：更新范围规则 → 暂存并提交范围内的改动 → 查询远端分支并按需 fetch → 合并 → push。远端无分支时直接推送；本地没有提交时用 `checkout --no-overwrite-ignore -B` 采纳远端，无共同祖先时走 Git 三方合并。检出或合并前先检查远端路径是否与本地未跟踪且被忽略的文件重叠；重叠则停止，请先备份并移开该文件。push 被非 fast-forward 拒绝时重新获取和合并（最多 3 次 push）。
- **冲突**：使用 Git 原生三方合并；有冲突时收集 `--diff-filter=U` 路径、`git merge --abort` 并返回 `sync_conflict`，**不 push、不 auto-resolve**。本地提交保留，用户用 Git/编辑器解决后再同步。
- **认证**：不把 token 写入 `sync.json`；使用系统 credential helper / SSH agent。子进程设置 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`SSH_ASKPASS_REQUIRE=never`（Unix 未自定义 `GIT_SSH_COMMAND` 时加 `ssh -o BatchMode=yes`），非交互环境失败而不是挂起。HTTPS 没有凭据时设置页按 `git_auth_failed` 提示先用 `git credential approve` 或系统凭据助手存 token，SSH 则提示 `ssh-add`。URL 内嵌凭据、`ext::`、`git://` 一律拒绝。非 loopback 的明文 `http://` 默认关闭，设置页「允许明文 HTTP」（`gitAllowInsecureHttp`，CLI `--git-allow-insecure-http true`）打开后才保存，令牌以明文传输，只适合没有 HTTPS 的内网。自签 HTTPS 可填 CA 证书的绝对 PEM 路径（`gitSslCaInfo`，CLI `--git-ssl-ca`），每次 Git 命令带 `-c http.sslCAInfo=<path>`；留空用系统信任库。证书校验失败为 `git_tls_failed`。不提供关闭证书校验的开关。
- **Windows 进程回收**：每次 Git 命令经 `process::command_output` 先暂停创建、加入独立 Job Object 后恢复运行，避免 Git 启动器派生的 HTTPS / SSH 后代逃逸。命令正常结束、超时（网络命令 600s）或同步任务取消时均关闭 Job，终止该次命令留下的完整进程树；不按进程名清理，不影响其它仓库的 Git。同一守卫也用于写作目录同步、Doctor / 安装器、编译工具和 MCP tunnel。非 Windows 保持原有执行方式。全局 `http.postBuffer` 等用户 Git 配置仍由 Git 自身读取，本修复不会修改；过大的上传缓冲可能放大单次 HTTPS 推送内存占用。
- **触发**：复用自动同步调度（打开 Vault、静置 30s、定时间隔）。退出 flush 跳过 Git——5s 预算可能中断 commit/push 并留下 `index.lock`，下次启动补推。`.git` 与 `.agentero` 已被 watcher 忽略，不会事件回环。
- **限制**：不会清理既有 Git 历史，也不节省已跟踪文件的拉取流量；Git LFS、partial clone 和 sparse-checkout 未接入。

## 条件写与恢复

多设备升级时，先暂停旧客户端的自动同步并备份 Vault，再升级所有写入端。远端格式仍兼容旧版本，但新客户端无法约束旧版本的无条件写入。升级不会找回旧版已传播的删除。

标准 S3 / WebDAV 协议在绑定时和非空转同步前检查一次性对象的创建、强 ETag、重复创建、按当前 ETag 替换以及按过期 ETag 替换。任一条件不成立或探测出错，客户端都会停止发布 HEAD。`conditionalWrites` 保存探测结果。显式启用日志原型的设备将该值设为 false，按本地日志检查点选择格式 2。Agentero Cloud 依赖服务端对象 API 的条件写契约。

- **正常落盘**：文件写入临时区并校验声明大小与 SHA-256；应用时重新核对本地文件，再删除已确认的阻挡项、移除空目录、安装新文件。目录含未跟踪文件或符号链接时拒绝替换，不递归清除。多文件应用并非单个文件系统事务。
- **进程中断**：`.agentero/sync/pending.json` 保存目标 HEAD 和受影响路径的原始条目；明确成功后改名为 `accepted.json`。丢失成功响应时核对远端 HEAD；能确认采纳时，用已发布清单与当前磁盘重建路径基线，重新合并未落盘变更，再写 `base.json` / `state.json`。
- **不能判定时停止**：未知发布结果且 HEAD 已越过目标版本、同版本换清单、HEAD 倒退或从既有远端消失、检查点损坏，都不会被解释成远端删除。先备份整个 Vault（含 `.agentero/sync/`），核对远端及其他设备后再决定是否解绑重建基线。恢复中不要切换至旧版客户端。不可变对象和 HEAD 的远端格式不变。
- **Catalog**：落盘或 Git 采纳/合并前写 `catalog.dirty`；重建与清理均成功才移除。失败返回错误并在后续同步重试，SQLite 本身不参与传输。

## 身份与 Catalog 联动

- `vault.json`（远端）与 `.agentero/vault.json`（本地）配对：从未同步过的 Vault 可加入既有 remote（采纳其 id）；有同步历史的 Vault 拒绝外来 remote。
- 论文权威字段已 sidecar 化：每次 `upsert_paper` 同步投影到 `papers/<id>/metadata.json`；`paper_rescan` 优先从 sidecar 恢复（sidecar 较新则回灌 DB）。因此同步只处理普通文件，`catalog.sqlite` 不出 Vault；拉取后引擎自动 `rebuild_from_disk` + `prune_missing`。

## 前端

设置窗口「同步」pane：`src/components/settings/panes/sync-pane.tsx`；命令封装 `src/lib/sync/api.ts`。仅本地 Vault 可配置（`remote:` 句柄显示提示）。标题旁用小色点展示连接状态（灰=未连接，绿=已连接，蓝=同步中，红=最近一次同步/连接失败）。后端选择为与服务商 logo 同行的下拉框（对象存储 / WebDAV / Git；已配置时禁用并提示先解绑），随后按后端渲染表单（S3：endpoint/bucket/AK/SK + 高级项；WebDAV：服务器地址/用户名/密码；Git：仓库地址/分支、明文 HTTP 开关、CA 证书路径，并说明 HTTPS 需预先存好凭据）。服务商 logo 按钮按后端分组（S3：AWS/R2/MinIO/OSS/BOS；WebDAV：坚果云/Nextcloud；Git：GitHub/GitLab），打开官方配置指南，不会通过外链自动创建或回填凭据。同步范围（见上）在同一 pane：小标题 + 逐类开关（行内显示本地体积，默认全开）。Git 下说明改为写入 `.gitignore`。 切换 Vault 重建表单；后台状态刷新不覆盖未保存的输入。

## 自动同步

配置项 `autoSync`（默认开）与 `intervalMinutes`（15/30/60，默认 30）随凭据存 `sync.json`。调度任务在 `sync_configure` 后（重新）启动、`sync_disconnect` 时停止、应用启动时按配置恢复；每次触发都重读凭据，改配置无需重启。触发器：调度启动即同步一次（≈打开 Vault）、Vault 改动静置 30s、定时间隔兜底；`RunEvent::Exit` 时对所有自动同步 Vault 尽力推送（超时 5s/Vault）。

同一 Vault 的手动、自动、退出同步共用 `SyncRunLease` 占用；不同 Vault 可独立运行。退出 flush 若该 Vault 已在同步则记录并跳过，避免并发改写本地 base/state。正常成功/失败先释放占用再广播既有终态，超时或 task abort 通过 guard 自动释放，后续同步可重新取得占用。

停止或替换调度器会阻止下一轮，不主动中断正在执行的同步。watcher 不可用时保留定时触发。退出时仍为限时的尽力同步，不是落盘完成保证。

## 并发（跨进程）

配置、解绑、同步均先取得该 Vault 的 `.agentero/sync/lock` 再读取或修改绑定。解绑清除已知基线和恢复记录，保留锁文件、Vault 身份、用户数据和远端；全局 `sync.json` 的读改写另由同目录的 `sync.lock` 串行化。

- 拿不到锁立即失败，域码 `sync_busy`（CLI 退出码 1，桌面端记入 `sync:state` error）；使用 `fs2` 的平台锁冲突错误码识别占用，避免 Windows 的 `ERROR_LOCK_VIOLATION` 被误报为普通 IO 错误。
- 正常释放 guard 时显式解锁，再关闭文件句柄，避免复制的句柄（包括 Unix 并发 `fork` / `dup` 继承的描述符）延迟释放同一把锁。进程退出、崩溃或被杀时仍由系统在最后一个相关句柄关闭后释放，无陈旧锁文件清理。
- 桌面端手动 / 自动 / 退出同步与 CLI `sync now` 均走该入口；`SyncRunLease` 仅叠加进程内 UI 状态（`running`）。
- 该锁不约束其他编辑器。应用前按路径重新校验本地内容，不将 Vault 锁当作整个文件系统的事务。

## CLI（headless）

`agentero sync`（[cli.md](cli.md)）面向无桌面环境的服务器：同一引擎、同一 `sync.json` 绑定、同一冲突与断点续传语义。典型服务器侧接入（vault 从未同步过，引擎自动采纳远端 `vault.json` 的 id 完成加入）：

```bash
agentero vault create ~/papers
agentero --vault ~/papers sync connect s3 --endpoint "https://${ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --bucket papers --credentials-input ./credentials.json
agentero --vault ~/papers sync test
agentero --vault ~/papers sync run --json

# Git 凭证由系统 credential helper 或 SSH agent 提供
agentero --vault ~/papers sync connect git git@github.com:you/papers.git --branch main
agentero --vault ~/papers sync run --json
```

S3 和 WebDAV 从系统凭据存储（service 为 `app.agentero.sync`）、本地绑定、交互输入或 `--credentials-input <文件或 ->` 获取密钥。`--json` 与 `--no-input` 禁用提示。面向终端的状态只显示后端、位置与最近同步时间。Git 使用系统凭据。三种后端都支持重复的 `--exclude`；Git 将排除项写入仓库的 `.gitignore`。

## 安全约束

远端对象视为不可信输入，引擎在应用前统一校验：

- **manifest 路径净化**（`engine.rs` `validate_manifest`）：relPath 必须非空、非绝对、仅 `/` 分隔、无空段 / `.` / `..`，否则整个 pass 失败——杜绝经 `vault.join` 越界写/删文件。
- **hash 校验**：manifest 中 hash 必须是 64 位小写 hex（sha256），防止畸形 key  panic 或索引到 `blobs/` 之外。
- **解压限流**：blob 解压上限为 manifest 声明 size（sha256 校验兜底），manifest 解压上限 256MiB，防 gzip bomb。
- **强制 TLS**：`validate()` 要求 S3 endpoint 与 WebDAV URL 均为 https；仅 loopback（`localhost` / `127.0.0.1` / `::1`）放行 http（本地 MinIO 测试场景），避免 SigV4 / Basic 凭据明文传输。Git 的非 loopback `http://` 另有显式开关，默认关闭；自签 HTTPS 只接受用户指定的 CA 文件，不关闭校验。WebDAV 仍不接受明文 http 与自签证书。

## 边界（后续分期）

状态栏指示、孤儿 blob GC、E2EE、官方托管凭据 provider 均未实现，见设计草稿分期表。Git 后端的 LFS、按论文按需拉取（partial clone / sparse-checkout 或 `sync_fetch_papers`）同样属于后续 Phase（#781 暂不关闭）。同步范围已通过 `.gitignore` 排除，不清理已有历史。
