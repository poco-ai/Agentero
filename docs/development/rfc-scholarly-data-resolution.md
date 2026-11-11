# [RFC]: 学术数据解析与补全架构

> 状态：草稿，待评审
> 日期：2026-11-10
> 关联：[＃459](https://github.com/poco-ai/Agentero/issues/459)、[＃460](https://github.com/poco-ai/Agentero/issues/460)、[＃719](https://github.com/poco-ai/Agentero/issues/719)、[＃848](https://github.com/poco-ai/Agentero/issues/848)、[＃960](https://github.com/poco-ai/Agentero/issues/960)；＃1080 待核实
> 性质：拟议设计。「现状」以 2026-11-10 代码为准。[现有 API 说明](../backend/academic-search-apis.md) 有部分过期描述。

## 摘要

学术 API 层统一了部分外部请求和论文候选映射，但精确解析、标题搜索、候选融合、venue、引用、代码仓库及 PDF 获取仍由不同入口各自编排。新增来源需要修改多条静态来源链和字段规则。最终论文记录仅留下一个来源字符串，无法解释字段来源、冲突和置信度。

本 RFC 提议保留 agentero-core 与 Catalog 的现有权威边界，逐步建立四层：**来源适配器、按操作选择来源的解析策略、带字段证据的候选融合、入库后的补全**。PDF 与机构认证是独立的资源获取能力，只通过下载候选与论文解析衔接。先修正身份合并和模块边界，再迁移编排、证据与缓存；不一次重写全部来源。

## 1. 需求与范围

| 需求 | 已核实问题 | 设计方向 |
|---|---|---|
| [＃459](https://github.com/poco-ai/Agentero/issues/459)、[＃460](https://github.com/poco-ai/Agentero/issues/460) | metadata 刷新、BibTeX verifier 式置信度与来源透明 | 身份核验、字段证据、冲突与刷新报告 |
| [＃719](https://github.com/poco-ai/Agentero/issues/719) | publication、模板投稿、EasyScholar 排名各有规则 | 结构化 PaperVenue；标签只是投影 |
| [＃960](https://github.com/poco-ai/Agentero/issues/960) | Papers with Code API 补官方代码等，MCP 集成 | PwC 作为有条件的解析和补全来源，复用适配器 |
| [＃848](https://github.com/poco-ai/Agentero/issues/848) | 机构代理、会话、VPN 与实际 PDF 权限混杂 | metadata 与资源访问分层 |
| ＃1080 | 当前仓库 issue、PR 和 REST 查询均为 404 | 暂不推断需求；获得准确链接后补充 |

目标是让 DOI、arXiv、PMID、URL、标题和 PDF 识别后续解析共享身份判断与来源报告；字段级说明来源、抓取时间、冲突和刷新理由；按操作选择来源并控制请求预算；桌面和 CLI 共用 core 逻辑。Catalog 继续是结构化 metadata 的权威，metadata.json 继续是投影。

本 RFC 不把 PDF 下载协议或机构登录塞进元数据 provider；不要求每个 provider 支持所有能力；不把未经校准的 0–1 分数称为跨来源真实概率；不在首期建设运行时代码插件或远程后端。S2 的反向引用能力仍独立保留。

## 2. 代码现状与不足

主要实现：`crates/agentero-core/src/features/paper/scholar_api/mod.rs`（学术数据模型）、`.../scholar_api/traits.rs`（来源接口）、`.../scholar_api/search.rs`（标题搜索）、`.../scholar_api/identifiers/fallback.rs`（精确查询回退）、`.../paper/import/api_mapper.rs`（入库映射）、`.../paper/discovery/pwc.rs`（PwC）、`.../paper/venue.rs`（venue）、`.../paper/import/download.rs`（资源下载）。

~~~mermaid
flowchart LR
    Input[DOI / arXiv / URL / 标题 / PDF] --> Import[import / recognize]
    Import --> Translator[Translator 主路径]
    Translator -->|失败| Fallback[静态 fallback 链]
    Import --> Search[六源标题搜索]
    Fallback --> Paper[ApiPaper]
    Search --> Fusion[import/api_mapper 候选融合] --> Paper
    Paper --> Record[PaperRecord / Catalog]
    Record --> PwC[PwC 异步填空]
    Record --> Venue[venue 标签 / EasyScholar]
    Record --> Refs[S2 / Crossref 引用]
    Record --> Assets[PDF 下载 / 机构代理]
~~~

| 现状 | 后果 |
|---|---|
| 搜索层反向调用 import/api_mapper 中的候选融合 | 学术数据层依赖入库层，纯融合无法独立复用 |
| 单个 AcademicApi.fetch 同时表达精确查询和多结果搜索；references 默认空列表 | 不支持与确实无结果难区分；S2 match、venue、batch 又在 trait 旁路 |
| 六个标题来源、标识符 fallback 链与全局 priority 整数写死 | 无法按 DOI、PMID、标题或字段质量选择来源，新增来源需改多处 |
| ApiPaper.source 和 PaperRecord.meta_source 只存整条记录的来源 | 无法追溯每个字段的来源、时间和冲突 |
| normalize_id 对所有 ID 删除连字符、下划线与空格；模糊去重未否决冲突 ID | DOI 连字符可能有语义，不同 DOI/arXiv 的同题作品可能被混写 |
| 字段融合依固定来源顺序，citation_count 取跨源最大值 | 旧值、来源口径和统计时间不可解释 |
| 常规入库先走 Translator；标题确认多只传 identifier；PdfIdentProbe 复制字段 | 搜索候选中的 citation_count 等字段可能在主路径断流 |
| meta_source = manual 是整条记录级保护 | 用户只改一个字段，也可能阻止其他字段补全；手动清空无独立语义 |
| HTTP 仅有全局 semaphore=4；六源搜索排队计入各 8 秒预算，limit 未下传 | 资源竞争与尾部超时；结果足够也会等待慢源 |
| fallback 固定错峰和整链重试；错误多为字符串 | 无 Retry-After、来源级退避、健康和稳定诊断 |
| 学术数据无统一结果缓存，refs 与 PwC 各自处理 | 重复请求，无法判断旧值能否在故障时复用 |
| PwC 独立请求并在提交后异步填空 | accepted venue、官方代码和 TL;DR 不参与统一来源报告 |

当前搜索仅在所有来源失败时报告错误；一个来源成功返回空列表可掩盖其他来源的 429/超时。S2 match 快路径的失败也不进入该汇总。已有 ＃524 的「全链限流不误报无结果」规则须保留，并扩展为部分成功报告。

应复用现有 ApiQuery、ApiPaper、来源映射、HTTP client、paper_commit、venue 模板推断和引用 sidecar。PwC 的「只填空」「官方仓库优先」「未命中不作负面推断」是有意策略，不应在迁移中丢失。

## 3. 目标边界

~~~mermaid
flowchart TD
    Input[输入识别 / PDF 线索] --> Policy[ResolvePolicy: 操作与预算]
    Policy --> Registry[ProviderRegistry: 来源能力]
    Registry --> Transport[共享 HTTP 调度 / 缓存]
    Transport --> Adapter[Translator / Crossref / S2 / arXiv / OpenAlex / PubMed / PwC]
    Adapter --> Observation[ProviderObservation: 值 / 来源 / 时间]
    Observation --> Identity[身份核验与候选关联]
    Identity --> Fusion[字段融合与冲突报告]
    Fusion --> Commit[Import mapper / paper_commit] --> Catalog[Catalog]
    Catalog --> Enrich[Venue / citation / code / refs 补全] --> Registry
    Fusion --> Download[PDF / landing 下载候选] --> Access[资源访问: 直连 / OA / 机构代理 / VPN]
~~~

| 层 | 责任 |
|---|---|
| Provider adapter | 构造请求、解析响应、声明能力、返回带来源的 observation；不写 Catalog |
| Registry + policy | 按查询类型、操作、字段、可用性和预算选择来源；初期为显式静态注册，不引入动态插件 |
| Identity + fusion | 判断是否同一作品、选字段、记录冲突和理由；不做 HTTP 或磁盘提交 |
| Import mapper + commit | 映射 PaperRecord，沿用既有去重、Catalog 写入和资产准备 |
| Enrichment | 入库后补 venue、指标、代码、引用等可选事实；不阻塞基础入库，不覆盖手动锁定字段 |
| Access resolver | 对下载候选执行直连、OA 或机构访问并报告实际结果；不推断论文 metadata |

一个 provider 可以提供多个语义接口，例如 MetadataLookup、MetadataSearch、ReferencesLookup、VenueMetricsLookup、CodeLookup 和 PdfUrlLookup。精确查询应区分 Found、NotFound 和 Unsupported；不能用默认空列表代表不支持。Translator 的 URL/题录转换与 PDF Recognizer 属输入适配，不强制伪装为普通论文索引。

## 4. 身份、证据与刷新

以下为目标概念，不是已发布的 Rust、IPC 或 SQLite 签名：

~~~text
ProviderObservation<T> = value + provider + operation + observed_at
                         + matched_identity + raw_ref
FieldDecision<T> = chosen + alternatives + reason + conflict
ResolveReport = candidates + provider_attempts + degraded
~~~

### 4.1 先核验身份，再融合字段

按标识符类型规范化：DOI 去前缀与外围空白并按标准比较大小写，保留有语义的连字符；arXiv 去版本号只用于作品级关联，版本另存；PMID 和 ISBN 使用各自规则。可信相同 ID 可支持合并；两个候选都有 DOI 且冲突时，不得再凭模糊标题强合并，arXiv 冲突同理。缺 ID 时，标题、作者、年份只生成候选关联和匹配证据，不能直接混写。预印本与正式发表版本需要明确的关联语义。

BibTeX verifier 式校验报告「一致、冲突、无法核实」和证据，不用单个总分掩盖 ID 冲突。首版采用确定性、可解释的规则；如引入置信度分数，只在同一校准策略内比较。

### 4.2 按字段与 claim 选择来源

| 字段或 claim | 主要证据与规则 |
|---|---|
| DOI、arXiv、PMID | 对应 ID 查询与交叉匹配；冲突阻止强合并 |
| 卷期页、publisher | 出版记录 / Crossref 优先，保留字段来源 |
| abstract | 优先完整文本，不用摘要片段覆盖完整内容 |
| published venue | 过滤 repository 名；综合出版证据、S2 publicationVenue、Crossref；不能仅以字符串长度判断会议名 |
| submitted venue | LaTeX 模板推断仅说明投稿目标，不等于已录用 |
| accepted venue | PwC 明确的 conference_name 是录用证据，缺失不代表未录用 |
| citation count | 保留来源、时间和口径，不直接把跨源最大值当真实值 |
| official code | PwC 标记 official 的 repository；不覆盖用户手填或手动清空 |
| ranking / IF | EasyScholar 加 venue 匹配证据；是 venue 指标，不是论文出版事实 |

刷新逐字段决定 changed、retained、conflicted 或 unavailable，并说明原因。用户显式编辑或清空的字段锁定，未锁定字段依身份、权威性、完整度、新鲜度合并；来源故障不能清空现值。meta_source 暂保留为兼容摘要，不能再作为唯一 provenance。自动提交只应用无冲突且非手动字段。

### 4.3 统一 Venue（＃719）

PaperVenue 包含 published、submitted、rankings、evidence、conflicts。VenueRef 包含规范名、别名、会议/期刊/仓库类型、年份和可用标识符。publication 继续是 Catalog 中当前选定的 published venue；仓库名不能成为 published venue。#submitted: 与 #easyscholar: 是兼容标签投影，废弃 #venue: 继续清理。名称归一、标签生成、去重、配色和失效清理共用 venue 逻辑。paper_venue_get / paper_venue_refresh 是后续拟议 IPC，不是现有命令。

### 4.4 PwC 作为来源（＃960）

将 discovery/pwc.rs 的请求和映射提取为共享适配器，保留广场入库。先支持按 PwC paper id 和 arXiv id 精确查询；只有实测存在可靠搜索端点后才声明标题搜索能力。PwC 可在身份已确认后参与解析，也可在提交后补全，两者采用同一字段证据规则。未收录不否定论文、venue 或代码。MCP 若实施应调用相同 core 适配器，不重复实现 HTTP 和映射；MCP 权限及是否允许触发写入另行设计。

### 4.5 资源访问边界（＃848）

解析只输出带来源的 PDF URL、landing URL、DOI、OA 线索等 DownloadCandidate。资源访问层决定直连、Unpaywall、机构代理或已连接的系统 VPN，报告实际下载结果。认证成功、协议兼容、机构订阅可访问、PDF 下载成功是四个独立状态。机构代理后续按 URL 重写、会话准备、探测、下载分接口；EZProxy、wengine、子域映射、Array、aTrust 和系统 VPN 的支持判定以授权账号实际下载为准。该专项不扩张 metadata provider 接口。

## 5. 请求调度、失败与缓存

- RequestContext 传递操作、任务取消、总 deadline、单源预算、trace id 和字段集。保留全局并发上限，再加来源级并发/速率限制，识别 Retry-After；仅对可重试错误退避并加 jitter。S2 批量重试也进入同一调度。
- 标题查询按阶段启动来源：先查与领域匹配的高价值来源；候选足够且身份可信时取消不再需要的请求；低置信或失败时扩大范围。limit 下传至来源，避免每次六源全部请求并等待。
- 精确解析保留 Translator 失败后直连的现有退化行为，再按延迟与请求数基线逐步评估权威 ID 直查和 Translator 的并行/按需策略。保留 ＃524 限流语义。
- ProviderAttempt 区分 found、empty、unsupported、rate_limited、timeout、unavailable、cancelled。部分成功返回结果和失败清单；所有可用来源失败时返回结构化错误，不伪装成「没有论文」。
- 先做进程内相同请求合并和短期缓存；确认命中率后增加可重建持久缓存。键包含 provider、操作、规范查询、字段集、schema 版本；值包含抓取时间、有效期、状态和可用的 ETag。故障时旧值须标记 stale。凭证和机构 Cookie 不入缓存与日志。

## 6. 存储与迁移

PaperRecord 与现有 IPC 出参先保持兼容。建议在 Catalog 增加可迁移的字段证据及手动锁定记录：paper id、field、value、provider、observed_at、authority、identity_match、manual_state。大体积原始响应只放可删除的诊断缓存。精选 provenance 是否也写入 metadata.json sidecar，需按现有重建与跨设备同步语义定案；不能只放 SQLite 后使重建丢掉用户手动锁。

旧记录无字段证据时生成 legacy_unknown，不臆造来源。旧 meta_source=manual 记录先整体保护，再依用户明确编辑逐步收窄。旧 EasyScholar 标签仅在新指标与 venue 对应得到确认后替换。新增 IPC 或事件须重新生成 bindings 并运行事件契约检查。

## 7. 分阶段实施

| 阶段 | 交付 | 退出条件 |
|---|---|---|
| P0 正确性与边界 | 按 ID 类型规范化；冲突 ID 否决模糊强合并；纯候选融合移出 import；建立请求/延迟基线 | 不同 DOI/arXiv 不误合并，现有搜索/入库回归通过 |
| P1 编排 | ProviderId、RequestContext、结构化错误/报告；静态 Registry 与操作策略替代分散表；limit 和取消下传 | DOI/arXiv/PMID/标题/PDF 后续解析可报告来源；部分成功与 429 可解释；请求数不退化 |
| P2 证据与刷新 | 身份验证、字段 observation/决策、手动字段锁、刷新报告；打通候选至入库的字段断点 | BibTeX 式核验显示冲突与来源；手动清空不回写；citation_count 不静默丢失 |
| P3 来源与 venue | PwC 精确解析/补全共用；PaperVenue；EasyScholar ranking 投影；MCP 复用适配器 | accepted venue 与官方代码带来源；venue 三种事实可并存且旧标签可清理 |
| P4 运行治理 | 来源级限流、Retry-After、请求合并、缓存与健康观测；机构访问按 ＃848 专项推进 | 重复刷新减少请求；故障可诊断；机构支持由真实 PDF 下载验证 |

各阶段拆成聚焦 PR。P0 正确性修复可先独立落地；P3/P4 不作为 P1 上线前置条件。

## 8. 验收与验证

| 场景 | 预期 |
|---|---|
| 标题和作者相近、DOI 不同 | 保持独立候选并报告身份冲突，不交叉填字段 |
| arXiv v1/v2 与正式 DOI | 作品级关联可解释，版本不误删，正式版不自动污染预印本 |
| Translator 不可用、Crossref 429、S2 成功 | 可以入库，并报告各来源结果及退化状态 |
| 一个来源空结果，其余来源限流 | 返回部分失败，不把空结果解释成所有来源均正常 |
| 用户只改 publication 或手动清空 code repo | 保留该字段，其他未锁字段仍可更新 |
| PwC 命中或未命中 | 命中时只采纳有证据的 accepted venue/official code；未命中不作否定 |
| repository venue、模板投稿、EasyScholar 排名 | published/submitted/ranking 区分，标签投影可清理 |
| 机构网关可登录但出版商 PDF 不可取 | 报告资源失败，不标记学校为可下载 |
| 同 query 并发、取消、重复刷新 | 在途共享、取消生效、缓存命中，符合来源预算 |

单元测试聚焦身份冲突、字段决策、手动保护和状态分类；provider 使用固定响应样本做契约测试。网络集成测试只覆盖稳定公开端点；机构 PDF 需授权环境人工验收。性能基线至少记录请求数、P50/P95、限流次数与各来源耗时，并与现状比较。

## 9. 待评审决策

1. PaperVenue 与精选 provenance 在 sidecar 保存到什么粒度，才能兼顾 Catalog 重建与多端同步？
2. metadata 刷新默认自动应用哪些无冲突字段，哪些字段需用户确认？
3. citation count 展示选定来源的最近值，还是同时展示多来源值？不能继续把跨源最大值冒充统一统计量。
4. PwC MCP 只做只读查询，还是允许触发入库/刷新？不影响共享适配器的设计。
5. ＃1080 的准确链接与诉求是什么？收到后判断是否调整范围和阶段。

## 参考

- [现有学术搜索 API](../backend/academic-search-apis.md)
- [Catalog 数据模型](../backend/catalog.md)
- [论文入库](../backend/paper-import.md)
- [引用解析](../backend/citation-parsing.md)
