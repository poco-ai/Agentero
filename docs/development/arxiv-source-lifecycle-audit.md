# arXiv 源码与正文生命周期审计

审计日期：2026-10-24。审计基线：`6125280f0`；初次审计提交：`80352d3e0`。
下文场景表和问题证据保留审计时状态；修复结果见本节，当前契约见
[论文入库](../backend/paper-import.md#latex-优先与源码补全) 与 [聊天上下文](../backend/context.md)。

## 修复结果（2026-10-24）

- 复用 `ParseBody` 作正文准备入口，先准备有效 arXiv TeX，再处理已有 Markdown / PDF；
  本地识别与合并、Connector 稳定路径 finalizer、Zotero 迁移、打开 / 全库 reconcile 均接通。
  标识符 / Bib/RIS / CLI 下载复用同一源码准备；远程 staging 与 Connector 镜像也复用它。
- 补资源分别检查原始源码和可读正文。旧 OCR、旧 catalog 标签不能掩盖缺源码；UI 使用
  Host 的有效 TeX / 缺源码标志，PDF-only 不反复提示，源码失败保留独立下载提示。
- `agentero-source.json` 记录明确无 TeX 与可重试失败；自动请求有 15 分钟退避，手动下载
  可立即重试。临时源码失败不静默启动云端 OCR，源码被同步策略排除时不自动补拉。
- 先落主 PDF，再用原生文字版本戳固定 e-print 请求；保留用户显式版本 URL。显式版本与 PDF
  文字戳冲突时报告错误。未指定版本且文字戳读不出时按最新版下载（无版本链接即当时最新版）。
- gzip / tar 在暂存目录完整解包和校验；短 HTML、空 TeX、损坏 tar 不发布为可用源码。
  发布保护已有不同内容的源码与 sidecar，失败撤销新增文件。主 PDF 不再取工程内图 PDF。
- 源码发布与正文提交共用按论文路径的锁；PDF 许可等待后重判，落盘前再验 TeX、PDF 标识
  和取消状态。晚到的有效源码使旧 OCR 结果失效，不覆盖原始源码或旧 Markdown。
- 抽取编译侧 literal TeX helper 供读取共用；聊天全文、章节与搜索优先主 TeX 和按位置展开
  的依赖，保留公式。catalog 正文投影使用既有事务字段更新，清除产物时同步修正来源。
- 广场 scratch 同样源码优先，`SOURCE.txt` 为供 Agent 只读的展开副本；没有 TeX 才解析 PDF。

本次保留的产品边界：PDF 版面分析独立；`force` 仍表示重建派生正文，不强制越过有效源码；
切换默认正文引擎不自动重跑全库；LaTeX 源码翻译仍属未实现的独立功能。复杂 TeX 宏不执行，
已有用户源码与上游冲突需要用户处理。未指定版本时按最新版补源码；显式版本与 PDF 戳冲突仍报错。

验证包括 core / Host 回归测试、前端资产判定测试、工作区 Clippy 与类型检查；桌面使用
`pnpm tauri dev` 和独立配置 / Vault 验证：两篇都保留旧 OCR Markdown，缺源码的一篇显示
下载提示，有效 TeX 的一篇正常打开且 catalog 来源修正为 `latex`。未对真实 Vault 执行修复，
未调用真实云端 OCR；远程网络 / arXiv 真实下载未作端到端回放。

## 结论与用户意图

**确实存在 arXiv 论文可以获得 LaTeX，却先进入 PDF 正文解析 / 云端 OCR 的路径。**
正常的标识符入库会并发下载 PDF 和 e-print，并等待两者结束；若磁盘已检测到
`.tex/.ltx`，计划与正文执行器都会跳过 `ParseBody`。问题集中在其它入口、临时下载失败、
并发补全和后续读取，不能概括成“所有 arXiv 都在 OCR”。

按科研阅读意图，合理的默认行为应为：

1. 已知 arXiv 身份时，优先取得、验证并保留对应版本的原始源码。
2. 源码下载中、临时失败、明确无 TeX、用户选择不下载，是不同状态。
3. 可用源码应被 paper-reader 和聊天上下文共同消费；不要求源码能在本机编译。
4. 无可用源码时再选正文提取方式；原生 PDF 文字提取与逐页 VLM OCR 应区分。
5. 阅读 PDF 仍可需要图表、坐标、跳转和翻译所依赖的版面分析。
6. 临时回退生成的 Markdown 不应让源码补全永久停止，也不应优先覆盖晚到的有效源码。

## 三条容易混淆的管线

| 管线 | 产物与用途 | 当前与 TeX 的关系 |
|---|---|---|
| `RecognizeMetadata` | 识别标题 / DOI / arXiv ID，改名或合并 | liteparse probe 明确关闭 OCR；它本身不是全文 OCR |
| `ParseBody` | PDF → `PAPER.md`，更新 `body_source/body_quality` | `has_tex=true` 时直接返回，`force=true` 也一样 |
| `LayoutAnalyze` | PDF → `source/layout.json` / `layout-index.json`，供图表、引用定位、上下文等使用 | 有 PDF 就可以调度，与是否存在 TeX 无关 |

`parserBackend` 与 `layout.backend` 是两项独立设置：

- 正文使用 `agentero` / `openaiCompatible` 时渲染 PDF 并逐页发给 VLM，不先判断原生文字是否足够。
- 正文使用 `local` 时优先本地文字，允许 best-effort OCR；`body_source=ocr` 是复杂度预检
  的 `needs_ocr` 标签，不能单凭此字段证明 OCR 确实执行且成功。
- 版面使用 `local` 时是本地模型与 PDF 文字层处理；使用 MinerU / Paddle 时会调用远程
  PDF 解析服务，即使源码已在磁盘，也可能发生远程 OCR / 提取。该任务有独立用途。

入口：core `paper/analyze/parse/mod.rs::parse_paper_body_inner`、
`run_liteparse_markdown_direct`、`run_liteparse_probe_direct`；Host
`paper/analyze/body_engines/openai_vlm.rs::parse`；前端 `lib/pdf/layout/run-analysis.ts`。

下文 `core` 指 `crates/agentero-core/src/features/`，`Host` 指 `src-tauri/src/features/`，
`integration` 指 `src-tauri/src/integration/`，前端路径相对 `src/`。

## 各入口与异常场景

| 情况 | 当前行为 | 判断 |
|---|---|---|
| 魔棒 / 广场入库，PDF 和 TeX 均成功 | `tokio::join!` 等待两个下载；`tex=true` 不计划正文解析；仍可分析 PDF 版面 | 正常 |
| 本地已有正常 TeX，再打开 / 全库补正文 | `needs_paper_md=false`，正文执行器也跳过 | 正常；不代表所有读取端能消费 TeX |
| 只有空 `source/`，没有 `.tex/.ltx` | 仍视为无 TeX，允许正文解析 | 目录本身不能证明源码存在 |
| e-print 实际为 PDF-only | 原始 `%PDF` 响应写到论文根目录，`tex=false`，允许 PDF 正文解析 | 合理回退；不应无限重试 TeX |
| 源码下载 429 / 网络失败 / 解包失败，PDF 成功 | 错误放入 `messages`，没有持久化的源码失败类别；通常继续计划 `ParseBody` | 临时失败与明确无源码混同 |
| 整体资源下载超过 180 秒 | 返回资源错误，已落盘文件保留；commit 的返回资产 flags 可能全 false | 后续打开 / reconcile 又按磁盘判定，缺少统一恢复状态 |
| 本地拖入 PDF，后台识别出 arXiv ID | 更新 metadata / 改名后直接检查 `needs_paper_md`，没有先下载 TeX | 明确的源码优先断点 |
| 自动收录裸 PDF | 后台识别后走同一 runner | 继承本地 PDF 入口问题 |
| Connector 浏览器成功上传 PDF | 初次 commit 使用 Deferred；成功上传后打开 / reconcile，不主动补拉 TeX | 明确的源码优先断点 |
| Connector 浏览器 PDF 失败，走 Host resolver | `ensure_paper_assets_with_cookies` 会尝试 PDF + arXiv TeX | 反而比浏览器上传成功时更完整 |
| Zotero 迁移，已有 arXiv ID 和本地 PDF | 迁移完成直接 spawn 正文解析，没有源码下载步骤 | 可能直接进入 OCR |
| Bib/RIS 导入，映射结果含 arXiv ID | `AssetsPolicy::SyncDownload` 尝试 TeX | 成功时正常；失败时同其它回退路径 |
| DOI / URL 元数据未返回 arXiv ID | 下载器只按 `arxiv_id` 字段决定拉 TeX，不从论文属于预印本自动推断源码 | 身份识别不足时走 PDF；不能承诺所有 DOI 都能找到 arXiv |
| 打开论文 / 启动 Vault，PDF 已到而 TeX 仍在下载 | reconcile 不等待 `DownloadAssets`，允许抢跑正文解析 | 存在竞态 |
| OCR 已生成 `PAPER.md`，TeX 仍缺失 | UI 和批量补资源把可读正文当作足够；不再选中该论文补源码 | 会长期停留在回退结果 |
| 手动单篇补资源 | 若实际执行下载命令，仍会按磁盘缺失尝试 TeX | 可以修复部分旧数据；自动筛选与图标可能不再提示 |
| 下载 TeX 成功，旧 OCR Markdown 仍存在 | 不清理旧 Markdown；显式下载命令更新 `body_source=latex` | paper-reader 与聊天上下文可能读取不同正文 |
| 用户清除 / 强制重建正文 | 清除 `PAPER.md` 后批量入队，但遇到任意 TeX 仍跳过 | 无法表达“这次明确改用 PDF 解析” |
| 广场 `@` 全文临时副本 | scratch 只下载 PDF，直接调用 `parse_body_with_engine`，不下载源码、不查 Vault TeX | 独立的 arXiv → OCR 路径 |
| 云同步排除 source，但保留 metadata / PDF | 本机无 TeX；reconcile 根据本机文件计划正文解析，metadata 不能表达 source 被排除 | 应遵守同步意图并明确回退策略 |
| 远程 Vault / CLI | 另有远程 staging/上传入口；CLI 只报告 preparation 而不执行桌面任务 | 本次只核对实现，未做配对设备 / CLI 全流程回放 |

对应入口：`core/paper/import/{mod.rs,paper_import/mod.rs,sources/zotero/io.rs}`；
`Host/paper/import/job_runners.rs`；`Host/paper/zotero/db.rs`；
`integration/connector/import.rs::{import_connector_item_with_cookies,session_has_attachment_resolvers,save_attachment_from_resolver}`；
`core/paper/discovery/scratch.rs::materialize_scratch`。

## 已确认的问题及优先级

### P1：识别出 arXiv 身份后，没有统一的源码准备步骤

`recognize_metadata_runner` 在应用识别结果后，仅按最终路径的 `PaperCaps` 安排正文、引用和版面。
没有把新获得的 `arxiv_id` 接入资源下载。Connector 有 PDF 时 resolver 直接早退，Zotero 迁移
直接 spawn 正文解析。三个入口产生的都是同一篇论文，但源码策略不同。

建议：在稳定路径 / 识别完成之后，汇入同一个论文准备入口；已知 arXiv 时先决策源码。
保留 Connector 先完成上传和目标目录移动的时序，不将网络下载塞回扩展的短超时请求中。

### P1：可读正文被错误地用作“源码资产已完整”

`PaperCaps::needs_asset_download(body_source)` 不接收 arXiv 身份。只要有 PDF，且有 `PAPER.md`
或非空 `body_source`，就返回 false。前端 `paperAssetDownloadReasons` 重复这套规则。

结果：源码失败 → OCR 产出 Markdown → 补资源入口消失 / 批量跳过；再次用魔棒导入也可能在
batch 预检时以 `already_in_library` 跳过，无法作为修复手段。

建议把“已有可读正文”和“仍应补齐原始源码”拆开；网络临时失败可重试，明确 PDF-only 可停止，
同步排除或用户不下载应被保留。旧 `body_source` 不能代替实际文件检查。

### P1：下载与解析没有依赖约束，晚到的源码不会阻止 OCR 落盘

`job_reconcile_paper` 只延后活跃的 `RecognizeMetadata`。#932 将全库补齐改为先预览、本地状态内联修复、有代价项经用户确认后按选中路径入队，并同样延后活跃识别任务；详见 [已实现行为](../backend/paper-import.md#全库论文补齐932)。
`enqueue_core` 创建普通任务时 `depends_on` 为空。正文执行器只在开头检查一次 TeX，等待解析
许可后、发起云端请求前和写盘前都没有重判。

可发生：打开 / reconcile → 此刻只有 PDF → OCR 启动 → TeX 下载完成 → OCR 仍写入 `PAPER.md`
及 `body_source=vlm`。即使 TeX 落盘已把能力缓存失效，也不会影响在途任务。

建议：正文依赖源码准备状态；等待许可后重新决策；落盘时校验输入版本 / 当前优选来源。
已发出的远程请求不一定能撤销，但旧结果不能成为新的优选正文。

### P1：TeX 的“存在”与“有效可读”没有区分

`probe_paper_caps` 见到任意 `.tex/.ltx` 就置位，不检查大小、内容、主文档或依赖。
`unpack_arxiv_eprint` 将小于 512 bytes 的任意响应视为单文件 TeX；较长内容中只要样本含
反斜杠，也可能被当作 TeX。没有在解压后的 payload 再进行 PDF 类型判定。

另一个方向是半解压：tar 顺序直接写到正式 `source/`，后续条目错误不会撤销已写的主 `.tex`。
下次 `need_tex = !before.has_tex` 为 false，不再下载；正文也继续跳过。tar 的原始错误被丢弃，
最终还可能变成泛化的格式错误。

建议：下载 / 解包先进入暂存目录；识别实际格式，拒绝 HTML / 错误页；验证主源码及可读文本，
然后提交源码文件与状态。可复用已有 TeX root / include 分析能力；缺本机宏包或编译失败不能
直接判定“源码不可读”。现有 `source/` 同时放引用、版面 sidecar，不能直接整体替换或删除。

### P1：正文消费端不统一，LaTeX 优先只在部分工作流成立

`lib/paper/reader.ts::buildPaperReaderUserPrompt` 和 Vault 模板要求优先读 TeX。
但 `core/context/service.rs::full_text` 是 `PAPER.md → layout regions → unavailable`；
`section_text`、`search_paper` 也没有 TeX 正文分支。

结果：有源码但没有 Markdown / layout 时，聊天全文工具报告不可用；两者都有时，旧 OCR
Markdown 优先。Agent 可能通过其它文件工具自行读到 TeX，因此这里的结论限于上下文工具路径。

建议统一正文来源选择，给上下文工具提供主 TeX、依赖文件和来源信息；支持安全的按需读取，
不要只靠 prompt 约定，也不必为所有 TeX 强制跑本机编译或重新 OCR。

### P2：元数据与原始资产 / 派生产物的关系无法自愈

- 初次 `paper_commit` 下载成功并返回 `tex=true`，但没有写 `body_source=latex`；显式
  `download_paper_assets_with_progress` 才做该更新。同样的文件产生不同 catalog 状态。
- 显式下载只要检测到任意 TeX，就记录 `body_quality=high`，没有正文质量验证。
- 补到 TeX 后旧 `PAPER.md` 仍在；外部增删源码主要触发能力缓存失效，不更新正文来源字段。
- 清除正文解析结果删除 `PAPER.md`，不清空 `body_source/body_quality`；批量补资源可能继续
  相信已经不存在的正文。正文 reconcile 会重建其中一部分，但不能恢复可信的来源状态。
- ParseBody runner 将“因为 TeX 跳过”和真正解析完成都标为 Succeeded，跳过原因与云端回退
  messages 没有完整投影到任务结果，用户很难理解发生了什么。

建议：原始资产可用性、当前选择的正文、派生结果的来源 / 输入指纹分开维护；删除或替换产物时
同步失效对应投影。优先复用现有 catalog 原子字段更新能力，避免新增全行覆盖写。

### P2：版本信息丢失，后补源码可能与本地 PDF 不对应

`extract_arxiv_id` / `strip_arxiv_version`、`enrich_remote_urls` 和源码下载都按 bare ID
构造 URL。用户粘贴 `v1` 不会固定下载 v1；本地已有旧版 PDF 时，稍后源码补全会访问无版本
URL，可能拿到新版。`need_pdf=false` 又保留原 PDF，缺少两者一致性验证。

arXiv 的不同版本属于永久科研记录；无版本的摘要链接显示最新版本，见
[官方版本说明](https://info.arxiv.org/help/versions.html)。

建议去重继续用 bare ID，同时保存用户请求 / 实际取得的版本；PDF、TeX、引用和解析产物记录
共同的版本或内容指纹。后补发现不一致时显式处理，不能默认为同一内容。

### P2：主 PDF 与工程内 PDF 仍有混用边界

`PaperCaps` 在没有根 PDF 时递归寻找任意 PDF，`source/` 中的图、附录 PDF 也算；根级多 PDF
则由文件名排序选首个。该能力同时决定是否需要下载主 PDF。部分解包只留下图 PDF 时，可能
错误抑制主 PDF 下载或将图片当正文输入。

版面任务已有仅使用根目录 `{id}.pdf` 的保护，应保留；正文 / 下载的主文件判定也应与之明确
对齐，并为用户实际选择的旧文件名留兼容路径。

### 其它尚未闭合的能力

- 广场 scratch 不下载源码、不复用 Vault 中的现有源文档；它绕过论文级 TeX guard 直接调用
  引擎。不能只修改 `parse_paper_body_inner` 就宣称所有 arXiv 入口都已修复。
- `lib/workspace/actions-latex-translation.ts` 仍是提示“未实现”的 stub；源码下载并不等于
  已有 LaTeX 双栏翻译能力。这与本机 `.tex` 编辑 / 编译是不同工作流。
- 切换正文引擎不会自动使已有 `PAPER.md` 失效；现有文件优先短路。应定义用户是只修改后续
  默认值，还是要求重建选中论文，不能暗中对全库重跑 OCR。

## 推荐生命周期与实施顺序

```text
导入 / 上传 / 识别 / 同步 / 打开论文
  → 确定稳定路径、论文身份与版本
  → 探测资产 + 读取源码获取状态和用户策略
  → arXiv 源码未知 / 可重试：准备源码；下载中：等待或显式使用临时回退
  → 有效 TeX：作为正文来源，供 Reader 和 Context 共用
  → 明确无源码 / 用户选择 PDF：按当前正文策略提取文字或 OCR
  → 落盘前校验当前输入与优选来源
  → 按实际产物更新来源、质量、指纹，刷新消费者

PDF 版面分析独立按功能需要运行，保留坐标与图表能力
```

不需要先建设通用工作流框架。建议从现有 `PreparationPlan` / `PaperCaps` 演进：

1. **先修路由与补全**：一个共享的源码决策入口，接入 local-PDF / Connector / Zotero；
   区分未知、下载中、可用、明确无 TeX、临时失败、用户排除；已生成 Markdown 不阻止原始源码补全。
2. **再修在途与落盘**：绑定源码准备依赖，重检 / 指纹保护，暂存解包和有效性校验；
   显示源码失败原因，避免无解释地自动切入逐页 OCR。
3. **统一正文消费与修复旧库**：Reader / Context 用同一来源选择；对照盘上文件修正 catalog，
   标记旧 OCR 为回退产物，不删除用户 NOTES 或直接覆盖既有源码；涉及版本不明时单独处理。
4. **补版本与次级入口**：保留 arXiv 版本，覆盖 scratch、同步排除、远程 Vault，明确手动
   PDF 重解析与引擎切换的语义。

修复时至少覆盖：成功 TeX、PDF-only、临时 429、源文件晚到、空 / 假 TeX、半解压、已有 OCR
后补源码、旧 PDF + 新源码、Context 全文、Connector 上传成功与 fallback、本地识别、Zotero。

## 本次验证与边界

- `cargo test -p agentero-core features::paper::capabilities::tests -- --nocapture`：11 项通过。
- `cargo test -p agentero-core features::paper::import::preparation::tests -- --nocapture`：2 项通过。
- 临时加入隔离探针，调用真实公开入口 / 同模块解包函数，运行 `cargo test -p agentero-core audit_probe -- --nocapture`：
  6 项复现通过：Markdown / 旧 body_source 隐藏缺源码；空 TeX 阻断 force；TeX 晚到仍提交
  OCR；Context 忽略 TeX 并选旧 Markdown；短 HTML 被保存为 TeX；损坏 tar 留下部分 TeX。
- 晚到源码探针使用 mock 引擎在 guard 后写入 TeX，未调用付费服务。探针断言的是当前问题
  行为，验证后已移除，未作为“正确行为”测试保留。
- 未读取或修改真实 Vault，未对用户观察到的某一篇论文归因；未执行真实 arXiv 下载、
  云端 OCR、桌面 UI、远程 Vault 或同步端到端回放。
- 源码归档的常见 gzip / tar 形式核对了 [arXiv 官方解包说明](https://info.arxiv.org/help/unpack.html)。
