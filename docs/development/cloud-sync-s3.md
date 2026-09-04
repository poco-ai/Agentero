# 云同步（S3）设计草稿

> 状态：Phase 0–2（自动同步部分）已落地（实现说明见 [../backend/sync.md](../backend/sync.md)），Phase 2+ 为草稿。多设备间同步整个 Vault，存储后端只做 S3 兼容对象存储（AWS S3 / Cloudflare R2 / 阿里 OSS / MinIO / B2）。同一套引擎同时服务两种模式：用户自带 bucket（BYO）与将来的官方托管服务。

## 目标与非目标

**目标**

- 多设备同步同一 Vault：Markdown 笔记、论文 PDF、TeX 源码、marks、assets、attachments。
- 引擎与现有代码低耦合：新增 `features/sync/` 一个模块，对外只暴露命令 + 事件；对现有代码的侵入点控制在 3 处以内（见「侵入点清单」）。
- 冲突可预期：不丢数据，不需要用户理解版本控制。
- 为官方托管服务预留凭据形态，不提前建设控制面。

**非目标**

- 实时协同编辑（OT/CRDT）。
- 与 `features/remote/`（SSH 远程 Vault）合并——那是「数据在服务器、本机是 UI」，本方案是「每台设备都有完整副本」，二者并存。
- 同步 XDG 侧数据（`usage.sqlite`、应用设置）。

## 前置：catalog 权威字段 sidecar 化（Phase 0）

当前 `catalog.sqlite` 中 tags / is_read / url 等字段是**权威数据**（`paper_rescan` 无法恢复），而 SQLite WAL 文件不可按文件同步。方案：把 per-paper 权威字段落成 sidecar 文件，让 catalog 退化为**可重建缓存**，同步引擎从此只处理普通文件。

- 位置：`papers/<id>/.meta.json`（隐藏文件，不进文件树，不算论文身份 marker）。
- 内容：`PaperRecord` 中不可从盘上重建的字段（tags、is_read、url、title/authors 覆写、added_at、updated_at 等），带 `updatedAt` 时间戳。
- 写路径：`catalog/commands.rs` 的每个 mutation（`paper_set_tags`、`paper_set_is_read`、`upsert_paper` 等）成功后写 sidecar。收敛为 `catalog/sidecar.rs` 一个 `write_sidecar(vault, &PaperRecord)` 入口。
- 读路径：`paper_rescan` 发现 sidecar 的 `updatedAt` 新于库内 `updated_at` 时，以 sidecar 为准回灌 DB。同步拉取改动 `.meta.json` 后触发一次对应论文的回灌（或整库 rescan，MVP 可接受）。
- 兼容：首次升级时全量导出一遍 sidecar；老 Vault 无 sidecar 不报错。

Phase 0 独立可交付：即便不做同步，它也兑现「离开应用数据仍可读」的 local-first 承诺，并让 Vault 可被任意文件级备份工具安全备份。

另需引入 **Vault UUID**：新增 `.agentero/vault.json`（`{ "id": "<uuid>", "createdAt": ... }`），首次访问时生成。同步用它防止两个不同 Vault 误绑同一 remote。

## 同步模型：内容寻址 blob + 版本清单 + CAS 指针

不做 oplog，不做逐文件远端比对。整体是 **state-based 快照同步**（remotely-save / rsync-with-manifest 模型），正确性只依赖 S3 的一个能力：**条件写（`If-Match` / `If-None-Match`）**，S3、R2、MinIO 均已支持。

### Remote 布局

```text
s3://<bucket>/<prefix>/
├── vault.json               # { vaultId, formatVersion, encryption: "none"|"e2ee" }
├── HEAD                     # { version: 42, manifest: "manifests/000042.json", deviceId, ts }
├── manifests/000042.json.gz # relPath -> { hash, size, mtime }
└── blobs/ab/<sha256>        # gzip（+可选加密）后的文件内容，内容寻址，天然去重
```

- `HEAD` 是唯一的可变对象，推进时用 `If-Match: <etag>` CAS；首次创建用 `If-None-Match: *`。
- manifest 不可变、保留最近 N 份，免费获得粗粒度历史版本。
- blob 内容寻址：同一 PDF 在多篇笔记引用、或重命名，都不重复上传。

### 本地状态

`.agentero/sync/`（watcher 已忽略 `.agentero/`，不会造成事件回环）：

- `base.json`：上次同步成功时的 manifest（三方合并的 base）。
- `state.json`：remote 绑定信息、HEAD etag、上次同步时间。

凭据**不放 Vault 内**（Vault 本身会被同步），见「配置与凭据」。

### 同步流程（一次 `sync_now`）

1. **扫描**：walkdir 全量扫 Vault（排除 `.agentero/`、`.trash`、`.git` 等，规则与 watcher `is_ignored` 对齐），用 `size+mtime` 与 `base.json` 快速比对，变化的文件才算 sha256 → 得到 `local` 清单。
2. **拉取**：GET `HEAD`，若 `version` > base 的 version，GET 对应 manifest → `remote` 清单。
3. **三方合并**（base / local / remote 逐路径）：
   - 仅一侧改动 → 直接采纳；
   - 双侧同改 → 冲突策略（见下）；
   - 删除 vs 修改 → 保留修改（复活文件）。
4. **应用远端**：下载缺失 blob，写入本地（临时文件 + rename 原子落盘）。
5. **上传本地**：新 blob PUT（`If-None-Match: *`，已存在即跳过）；写新 manifest；`If-Match` CAS 推进 `HEAD`。
6. **CAS 失败**（他端并发推进）：丢弃本次 manifest，回到第 2 步重来。blob 已上传的不浪费。
7. 成功后更新 `base.json`，emit `sync:state`。

### 冲突策略

| 文件类型 | 策略 |
|---|---|
| `*.md` 等文本 | 保留 mtime 较新版本，较旧版本另存为 `<name> (conflict <device> <date>).md`，emit 事件提示 |
| `.meta.json` sidecar / `marks/*.json` | 按文件 LWW（`updatedAt` 新者胜），不产生冲突副本 |
| PDF / 二进制 | LWW（实际几乎不可变，冲突概率≈0） |

### 触发时机

- 手动：设置面板 / 状态栏「立即同步」。
- 自动：`features/sync/` 自持一个 `notify_debouncer_full` 实例（debounce 30s，与前端 watcher 各自独立、互不改动）+ 定时兜底（默认 5 min）+ 应用启动后一次。
- 串行化：同一 Vault 全局互斥锁，同步中再触发只置 dirty 标记。

### GC

blob 无引用即可删：客户端同步成功后低频（如每周）执行一次「列出最近 N 份 manifest 引用集合，删除孤儿 blob + 更老的 manifest」。托管模式下也可由服务端离线做。

## S3 客户端

只需要 6 个操作：`GET` / `PUT`（含条件头）/ `HEAD` / `DELETE` / `ListObjectsV2` / （大文件可选 multipart）。不引入 `aws-sdk-s3`（依赖树过重）；基于现有 **reqwest 0.12 + sha2** 手写 SigV4 签名（新增 `hmac` 一个小依赖），收敛在 `features/sync/s3.rs`（约 300 行）。兼容 path-style（MinIO）与 virtual-host style。

凭据形态设计为枚举，为托管模式预留：

```rust
enum SyncCredentials {
    /// BYO：用户自填 endpoint / region / bucket / prefix / AK / SK
    Custom { endpoint: String, region: String, bucket: String, prefix: String, access_key: String, secret_key: String },
    /// 官方托管（将来）：控制面签发限定 prefix 的临时凭据，engine 无感
    Managed { token: String },
}
```

托管模式落地时只需实现一个「用 token 换临时 STS 凭据」的 provider，engine 与 remote 布局零改动。

## 端到端加密（Phase 3）

- blob 与 manifest 用 XChaCha20-Poly1305 对称加密（新增 `chacha20poly1305`，已在 crypto_box 依赖树内）；密钥由用户口令经 Argon2id 派生（新增 `argon2`），加密后的 key-check 块存 remote `vault.json`。
- 文件名不外泄（内容寻址 + manifest 加密），远端只见随机 hash。
- BYO 模式可选，官方托管服务上线前必须默认开启（「我们也读不到你的数据」是核心卖点）。
- MVP（Phase 1–2）先不做，但 remote `vault.json` 的 `encryption` 字段从第一天就存在，`formatVersion` 预留迁移。

## 模块与侵入点

```text
src-tauri/src/features/sync/
├── mod.rs        # SyncConfig / SyncState / SyncService（含互斥锁、调度）
├── commands.rs   # sync_configure / sync_now / sync_status / sync_disconnect
├── s3.rs         # SigV4 + reqwest 最小客户端
├── snapshot.rs   # Vault 扫描 → Manifest
├── engine.rs     # 三方合并、计划、应用、CAS 循环
└── local.rs      # .agentero/sync/ 状态读写
```

事件（参照 `zotero_sync` 长任务 + 进度先例）：`sync:progress`（阶段/文件计数/字节）、`sync:state`（idle / syncing / error / conflict）。

**侵入点清单**（全部改动）：

1. `app/handlers.rs`：`common_commands!` 注册 sync 命令。
2. `features/paper/catalog/`：Phase 0 的 `sidecar.rs` + mutation 后调用 + rescan 回灌。
3. `features/system/settings/`：`AppSettings` 增加 `sync: HashMap<VaultId, SyncCredentials>`（存 XDG `settings.json`；SK 掩码遵循 translate API key 先例：`settings_get` 返回 `***`，`settings_set` 收到全掩码保留旧值）。

watcher、vault、import、remote 均不改。

## 前端

- 设置面板：`src/components/settings/panes/sync.tsx`（参照 `remote-access` pane）——绑定表单（endpoint/bucket/AK/SK/prefix）、连接测试、自动同步开关、立即同步、解绑。
- 状态：`src/lib/sync/store.ts`（zustand，订阅 `sync:state` / `sync:progress`）。
- 状态指示：shell 状态栏一个图标按钮（idle/syncing/error/conflict 四态），带 Tooltip 与可访问名称；错误走 `notifyError`。
- i18n：`src/i18n/locales/{en,zh-CN}/settings.json` 增加 `sync.*` 键。

## 分期

| Phase | 内容 | 交付判断 |
|---|---|---|
| 0 ✅ | catalog sidecar 化 + `.agentero/vault.json` UUID | 删库后 rescan 能恢复 tags/is_read |
| 1 ✅ | sync 模块 MVP：配置 UI、手动同步、manifest/blob/CAS、冲突副本 | 两台设备经 MinIO/R2 双向同步收敛 |
| 2 🚧 | 自动同步 ✅（打开/静置 30s/定时 + 退出尽力推送）；状态栏指示、GC、multipart 未做 | 日常使用无感同步 |
| 3 | E2EE（口令派生密钥、blob/manifest 加密） | 远端只见密文 |
| 4 | 官方托管：控制面（账号/配额/临时凭据签发）+ `Managed` provider | 应用侧仅新增 provider，engine 不动 |

## 风险与对策

- **大量小对象的请求费**（S3 按请求计费）：manifest 一次一个对象已摊薄；若 marks/sidecar 碎文件成为成本问题，Phase 2 再考虑小文件 packfile，MVP 不做。
- **时钟偏差影响 LWW**：冲突窗口本就极小；文本类有冲突副本兜底，不丢数据。
- **同步中途崩溃**：blob/manifest 均不可变、HEAD 原子 CAS，半途状态只留孤儿 blob，由 GC 回收；本地应用远端时先写临时文件再 rename。
- **Windows 路径**：manifest 内统一 `/` 分隔的相对路径，落盘经 `joinVaultPath` 归一（AGENTS.md #181 教训）。
- **误绑其他 Vault 的 remote**：`vault.json` 的 vaultId 不匹配时拒绝并要求显式确认覆盖方向。
