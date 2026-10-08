# 云同步（S3 / WebDAV）

多设备间同步整个 Vault 到 S3 兼容对象存储（AWS S3 / R2 / MinIO / OSS / BOS 等）或任意 WebDAV 服务器（坚果云 / Nextcloud / ownCloud / NAS 等）。设计草稿与分期：[../development/cloud-sync-s3.md](../development/cloud-sync-s3.md)。当前已落地 Phase 0–1 与 Phase 2 的自动同步（状态栏指示、GC、multipart 除外）。

两种后端共用同一套状态化同步协议（内容寻址 blob + 不可变 manifest + CAS `HEAD`），契约收敛在 `store.rs` 的 `RemoteStore` trait，`SyncStore` 枚举按配置选择实现，引擎对具体后端无感知。新增后端 = 新客户端模块实现 trait + 枚举一个变体。设置页可切换后端；已配置的 Vault 锁定后端选择，需先解绑再切换（换后端即指向另一个远端 store）。Azure Blob、百度网盘等无 S3 / WebDAV 对应凭据模型的服务仍不能接入。

## 模块

`src-tauri/src/integration/sync/`（desktop-only）：

| 文件 | 职责 |
|---|---|
| `mod.rs` | `SyncService` 与 `SyncRunLease`：手动、自动与退出同步共用按 Vault 的占用，guard 释放覆盖正常返回、错误、超时和 task abort |
| `config.rs` | `SyncBackendConfig`（`backend: s3 \| webdav` 判别字段，旧 `sync.json` 缺省即 S3）与凭据持久化：XDG `agentero/sync.json`（按 Vault 路径分键，0600）；`secretKey` / `webdavPassword` 出站掩码 / 回传掩码保留旧值（同 translate API key 先例）；`conditionalWrites` 持久化连接测试的条件写探测结果；`webdavUrl` 归一化（trim 尾斜杠 + 坚果云根地址展开，见 WebDAV 节）；`scope` 同步范围（见下）；`remoteIdentity()` 给出远端 store 标识（后端 + 地址/bucket/prefix + 账号名，不含密钥），供本地状态在换 store 后判失效 |
| `store.rs` | 后端无关抽象（Strategy）：`RemoteStore` trait 定义后端契约（`ensure_root` / `get` / 条件 `put` / `probe_conditional_writes`，futures 均为 `Send`），`SyncStore` 枚举是唯一的组合点（从配置选择具体客户端并转发）；engine 只依赖 trait，可用内存实现做引擎测试。另含两个客户端共享的 HTTP 工具：`send_with_retries`（幂等操作传输层 3 次重试）、`check` / `etag_of` / `error_chain` |
| `s3.rs` | 最小 S3 客户端：GET / 条件 PUT（`If-Match` / `If-None-Match`）/ DELETE / ListObjectsV2，reqwest + 手写 SigV4（HMAC-SHA256 自实现，RFC 4231 向量测试）；条件写探测与降级（见下） |
| `webdav.rs` | 最小 WebDAV 客户端：Basic Auth + GET / 条件 PUT / DELETE / MKCOL / PROPFIND（仅取状态码，无 XML 解析），见下节 |
| `snapshot.rs` | Vault 扫描 → `Manifest`（relPath → sha256/size/mtime）；`size+mtime` 未变复用 base 哈希；忽略 `.agentero` `.git` `node_modules` `.DS_Store` `*.tmp`；`SyncScope` 与分类谓词（见「同步范围」） |
| `local.rs` | `.agentero/vault.json`（Vault UUID）、`.agentero/sync/{base,state}.json`、`.agentero/sync/pushed.jsonl`（已上传未发布的 blob，见「请求预算」）；watcher 忽略 `.agentero/`，无事件回环 |
| `engine.rs` | 三方合并 + 应用 + 发布 + 空转短路 / 断点续传（见下） |
| `commands.rs` | `sync_get_status` / `sync_configure` / `sync_disconnect` / `sync_now` / `sync_scope_sizes`（本地各附件分类体积，供设置页展示）；广播 `sync:state` / `sync:progress` 事件 |
| `scheduler.rs` | 自动同步：每 Vault 一个后台任务——启动时同步一次、改动静置 30s 后同步、按 `intervalMinutes`（15/30/60）定时兜底；退出时尽力推送（每 Vault 限 5s） |

## Remote 布局与一次同步

```text
<prefix>/vault.json                  { vaultId, formatVersion, encryption }
<prefix>/HEAD                        { version, manifestKey, updatedAt } ← 唯一可变对象，CAS 推进
<prefix>/manifests/<v>-<nonce>.json.gz
<prefix>/blobs/<aa>/<sha256>         gzip(内容)，内容寻址天然去重
```

一次 `sync_now`：扫描 → GET HEAD/manifest → 与本地 base（上次同步清单）三方合并 → 应用远端改动（临时文件 + rename 原子落盘，blob 校验 sha256）→ 上传新 blob（`If-None-Match: *`，跨设备重复上传为廉价 no-op——**但坚果云忽略该头**，重复 PUT 会重传全部字节，见「请求预算」）→ 发布新 manifest → `If-Match` CAS 推进 HEAD。CAS 失败（他端并发推进）则以对方 manifest 为新 base 重跑，最多 5 次。

### 请求预算（空转短路 / 断点续传）

按请求数计费或限额的后端（坚果云 WebDAV 免费版 600 次/30 分钟、付费版 1500 次/30 分钟，且为**账号级**，与官方客户端共享）下，空转 pass 与失败重试的开销才是主要成本。引擎因此在三处收敛，判据均只比 **hash**（不比 mtime，见下）：

- **已是最新**：GET HEAD 后，若 `HEAD.version == state.lastVersion`、本地扫描与 base 内容一致、且 `base.scope == cfg.scope` → 直接返回，**整个 pass 只有 1 次请求**（原先约 11 次：vault.json/HEAD/manifest 三个 GET + 每次上传前的 MKCOL 链 + blob/manifest/HEAD 三个 PUT）。此路径同时跳过 `ensure_remote_identity`——空转 pass 不写远端，无需重新核验身份；任何真正要写的 pass 仍会核验，因此远端 `vault.json` 被外部删除后最迟在下一次有改动的 pass 补回。要求 `lastSyncAt` 非空（有同步历史），首次 pass 必须走完整握手。
- **无需发布**：合并应用完成后，若 `merged` 与**未过滤的**远端 manifest 内容一致 → 把它连同当前 version 写回本地 base/state 后返回，不发布新 manifest、不推进 HEAD。比 mtime 会误判：每次下载都以新的本地 mtime 落盘，而 `merge` 在双侧 hash 相同时采纳本地条目，于是每台设备都把自己的 mtime 重新发布一遍——两台设备会**永久互相推进 HEAD**，即使无人编辑。空转短路依赖 HEAD 版本稳定，所以这一条是它能在多设备下真正生效的前提。比对用未过滤的远端清单，是为了让「对某分类失明」的设备也能区分「无可补充」与「发布端看不见我的文件」（后者仍需发布）。
- **断点续传**：上传循环跳过 `.agentero/sync/pushed.jsonl`（`local.rs`）已记录的 hash。pass 在上传途中失败（限流、退出、断网）时 HEAD 未推进，远端 manifest 仍描述旧状态，下一趟会算出**完全相同**的上传清单——没有这份日志就会把已落地的 blob 全部重传，在忽略 `If-None-Match` 的坚果云上是全额字节重传。日志**逐条追加**（一行一个 sha256），因此进程被杀或 task 被 abort 最多丢最后一条；发布成功（或走「无需发布」）即删除——此后远端 manifest 就是权威。首行以 `#<store id>` 钉住远端 store：`store_id = sha256(cfg.remote_identity())`（后端 + 地址/bucket/prefix + 账号名，**不含密钥**，故可落在 Vault 内），换 store 后旧记录一律失效，否则会发布出引用不存在 blob 的 manifest。顺带也去重了同一 pass 内内容相同的多个路径。

`MemStore`（`engine.rs` 测试内的内存 `RemoteStore`，带请求计数与可注入的 PUT 配额）覆盖这三条：`idle_pass_costs_one_request`、`idle_devices_do_not_ping_pong_head`（含「真实改动仍会发布并被对端拉取」）、`interrupted_upload_resumes_without_resending`；日志本身的追加/去重/换 store 失效在 `local.rs` 测试内。

合并规则：单侧改动直接采纳；双侧同改 `*.md` 保留 mtime 较新者、较旧者存为 `<name> (conflict <时间).md`；其余文件（sidecar/marks/二进制）按 mtime LWW；删除 vs 修改保留修改。

## 同步范围（Sync Scope）

论文库中体积大且**可再生**的附件可以按设备排除，节省云端空间；笔记、`metadata.json` sidecar、`marks/`、`assets/` 永远同步（小且不可再生）。

- **分类**（`snapshot.rs` `scope_category`，仅识别约定论文布局）：
  - `pdf` — `papers/<id>/<id>.pdf`（论文根级 PDF；`source/`、`attachments/` 内的 PDF 跟随所在分类）
  - `source` — `papers/<id>/source/`（LaTeX / e-print）
  - `attachments` — `papers/<id>/attachments/`（支撑材料）
- **对称过滤**：同一谓词同时作用于本地扫描、base 与远端 manifest——被过滤的文件「双向失明」：不上传、不下载，也**绝不因缺失而被当作删除**。
- **manifest 携带 scope**：发布端把自己过滤掉的分类写进 manifest（`scope` 字段，全量同步时省略）。合并时：远端失明的路径不触发 `delete_local`，本地仍可见该分类时以本地条目为准并继续上传，否则携带 base 条目供其他设备可见；本地失明的路径完全惰性（不下载、不传播删除）。
- **边界**：所有设备都过滤某分类时，该分类条目会从 manifest 消失（blob 仍在，待孤儿 GC）；重新启用后本地仍有文件则自动重新上传，本地没有则需从来源重取。
- **重取**：PDF/TeX 可从 `metadata.json` 的来源字段（arXiv ID / DOI / `pdf_url`）重新下载——`paper_download_assets` 命令（库表格右键「从来源下载 PDF」、打开论文时自动补下均走此路径）。库列表的 `has_pdf` 由 `paper_list` 经 CapsCache 投影。
- **配置**：`SyncBackendConfig.scope`（缺省全量，兼容旧配置）；设置页以「同步范围」小标题分组展示逐类开关（附本地体积 `sync_scope_sizes`），默认全部开启。

## WebDAV 后端

`webdav.rs` 用 reqwest 手写（不引第三方 WebDAV 库），Basic Auth（坚果云应用密码 / Nextcloud 应用令牌 / NAS 账号均兼容）：

- **目录模型**：WebDAV 需显式建目录。PUT 前按需逐级 `MKCOL`（405 = 已存在），已建目录在客户端内缓存，稳态零额外请求；连接测试 `PROPFIND Depth:0` 根目录，404 则连目录一起创建——用户可直接指向一个不存在的目录（如 `https://dav.jianguoyun.com/dav/agentero/`）。坚果云根地址（`https://dav.jianguoyun.com/dav/`）自动展开为专用文件夹 `agentero/`：根集合可列表但拒绝创建文件（PUT 一律 404 ObjectNotFound），而它恰是官方文档给出的地址；展开是纯函数（trim 尾斜杠 + 根地址映射），`normalized()` 与客户端构造共用——新配置回显实际地址，旧配置无需重存即自愈。
- **连接测试**：PROPFIND 207 / 创建成功即凭据与目录可用；401/403 报凭证错误，不保存配置。随后做一次**无条件试写**（一次性 key，写完即删）：地址写不进去（不可写位置、权限或配额拒绝）在配置阶段就报错并带上目标目录 URL，不再静默保存坏配置、把错误推迟到首次同步。
- **条件写**：WebDAV 实现差异大，探测针对 `If-Match`（HEAD CAS 的唯一依托）：无条件试写建出一次性 key 后，带过期 etag 再 PUT，412 = 真支持，2xx = 降级为普通 PUT（与 OSS 共用 `conditionalWrites=false` 与降级语义，见上节）；`If-None-Match: *` 不探测——被忽略也无害（blob 内容寻址、manifest key 唯一随机）。实测坚果云忽略 `If-None-Match` 但强制 `If-Match`，即 CAS 原子性完整保留。硬错误（非 2xx/412）直接让连接测试失败；只有探测无结论（如条件头被忽略/拒绝）才按支持处理（fail open——被忽略的头无害，漏掉 CAS 才有害）。`test_connection` 以 `conditionalWrites=true` 构造探测客户端，保证测的是服务器行为而非持久化的旧结论。
- **无 ETag 的服务器**：`If-Match` 退化为普通 PUT，同降级语义收敛。
- **重试**：与 S3 客户端一致的传输层 3 次重试（幂等操作）。
- **安全约束同 S3**：`https://` 强制（仅 loopback 放行 http），密码掩码同 `secretKey`。NAS 场景的明文 http 与自签名证书 https 均不可用。
- **兼容性（实测）**：路径段 percent-encode、请求带尾斜杠集合形式。坚果云特性：MKCOL 对根 `/dav` 返回 403 OperationNotAllowed（按「已存在/受保护」容忍）；根 `/dav` 不允许创建文件（PUT 一律 404 ObjectNotFound，[#681](https://github.com/poco-ai/Agentero/issues/681)），故根地址自动落到 `agentero/` 子文件夹（见「目录模型」）；顶层目录名长度有限制（`sandbox name is too long`）；顶层目录不可经 WebDAV 删除、非空目录删除需先清空子项——`sync_disconnect` 本就不动远端数据，仅测试清理需注意；**请求按账号限频**（免费 600 次/30 分钟、付费 1500 次/30 分钟），空转成本见「空转短路」。Nextcloud / Apache mod_dav 按标准实现工作。
- **集成测试**：`engine.rs` `two_device_roundtrip_against_webdav`（`#[ignore]`，env `AGENTERO_SYNC_WEBDAV_TEST_URL` / `_USERNAME` / `_PASSWORD`，连接测试 + 发布/加入/编辑/分歧冲突/收敛全流程，镜像 MinIO 测试）。

## 条件写降级（OSS 等后端）

阿里云 OSS 的 PutObject 不支持任何条件请求头（`If-Match` / `If-None-Match` 等，带则返回 `400 NotImplemented`），S3 / R2 / MinIO 均支持。处理：

- **连接测试探测**：`sync_configure` 在 ListObjects 之后用一次性 key（`.sync-probe-<uuid>`）带 `If-None-Match: *` 试写并删除；`400 NotImplemented` → `conditionalWrites=false` 持久化到 `sync.json`，探测无结论时按支持处理（fail open）。
- **命令面**：当前没有独立 `sync_probe`；配置保存即执行连接探测，失败则不保存，成功后设置页按已连接展示。
- **运行时兜底**：旧配置未探测过时，首个条件 PUT 收到 `400 NotImplemented` 即在客户端内标记并立即以无条件 PUT 重试，同一 pass 内后续写入全部降级。
- **降级语义**：blobs / manifests 内容寻址或 key 唯一，无条件 PUT 幂等无害；HEAD 指针退化为 GET → PUT，牺牲严格 CAS，靠三方合并与重试收敛（单用户场景最终一致）。设置页对 `conditionalWrites=false` 显示一行小字提示。

## 身份与 Catalog 联动

- `vault.json`（远端）与 `.agentero/vault.json`（本地）配对：从未同步过的 Vault 可加入既有 remote（采纳其 id）；有同步历史的 Vault 拒绝外来 remote。
- 论文权威字段已 sidecar 化：每次 `upsert_paper` 同步投影到 `papers/<id>/metadata.json`；`paper_rescan` 优先从 sidecar 恢复（sidecar 较新则回灌 DB）。因此同步只处理普通文件，`catalog.sqlite` 不出 Vault；拉取后引擎自动 `rebuild_from_disk` + `prune_missing`。

## 前端

设置窗口「同步」pane：`src/components/settings/panes/sync-pane.tsx`；命令封装 `src/lib/sync/api.ts`。仅本地 Vault 可配置（`remote:` 句柄显示提示）。标题旁用小色点展示连接状态（灰=未连接，绿=已连接，蓝=同步中，红=最近一次同步/连接失败）。后端选择为与服务商 logo 同行的下拉框（对象存储 / WebDAV；已配置时禁用并提示先解绑），随后按后端渲染凭据表单（S3：endpoint/bucket/AK/SK + 高级项；WebDAV：服务器地址/用户名/密码）。服务商 logo 按钮按后端分组（S3：AWS/R2/MinIO/OSS/BOS；WebDAV：坚果云/Nextcloud），打开官方配置指南，不会通过外链自动创建或回填凭据。同步范围（见上）在同一 pane：小标题 + 逐类开关（行内显示本地体积，默认全开）。

## 自动同步

配置项 `autoSync`（默认开）与 `intervalMinutes`（15/30/60，默认 30）随凭据存 `sync.json`。调度任务在 `sync_configure` 后（重新）启动、`sync_disconnect` 时停止、应用启动时按配置恢复；每次触发都重读凭据，改配置无需重启。触发器：调度启动即同步一次（≈打开 Vault）、Vault 改动静置 30s、定时间隔兜底；`RunEvent::Exit` 时对所有自动同步 Vault 尽力推送（超时 5s/Vault）。

同一 Vault 的手动、自动、退出同步共用 `SyncRunLease` 占用；不同 Vault 可独立运行。退出 flush 若该 Vault 已在同步则记录并跳过，避免并发改写本地 base/state。正常成功/失败先释放占用再广播既有终态，超时或 task abort 通过 guard 自动释放，后续同步可重新取得占用。

本轮只收敛占用生命周期：abort 不新增 `sync:state` 终态事件，事件驱动的 UI 可能保持旧状态直到刷新或后续事件（`sync_get_status` 已能读取正确的 `running`）。中止 future 也不保证已启动的 `spawn_blocking` 或远端请求被撤销；协调取消、等待子任务与取消后的 UI 对账仍属架构计划 E2。

## 安全约束

远端对象视为不可信输入，引擎在应用前统一校验：

- **manifest 路径净化**（`engine.rs` `validate_manifest`）：relPath 必须非空、非绝对、仅 `/` 分隔、无空段 / `.` / `..`，否则整个 pass 失败——杜绝经 `vault.join` 越界写/删文件。
- **hash 校验**：manifest 中 hash 必须是 64 位小写 hex（sha256），防止畸形 key  panic 或索引到 `blobs/` 之外。
- **解压限流**：blob 解压上限为 manifest 声明 size + 1MiB（sha256 校验兜底），manifest 解压上限 256MiB，防 gzip bomb。
- **强制 TLS**：`validate()` 要求 S3 endpoint 与 WebDAV URL 均为 https；仅 loopback（`localhost` / `127.0.0.1` / `::1`）放行 http（本地 MinIO 测试场景），避免 SigV4 / Basic 凭据明文传输。

## 边界（后续分期）

状态栏指示、孤儿 blob GC、E2EE、官方托管凭据 provider 均未实现，见设计草稿分期表。
