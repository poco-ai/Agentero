# PDF 新样本与内存对照验收

2026-11-09。结论：当前连续阅读可以进入有明确范围的测试版，尚未达到“绝大多数论文完美适配”的正式交付标准。六篇新增真实论文全部能打开，五篇现代论文完成从零版面解析；测试发现并修复字体、标题和表头重复问题，历史特殊排版及纯图片页仍存在明确限制。内存对照证明阅读模式增加内存成本，但没有复现此前的 8 GiB 阈值退出，不能将该退出归因于新增功能或宣布原来就有相同泄漏。

当前验收范围已按需求收窄为正常文本层的现代论文：历史特殊版式、纯图片 OCR 不再作为本轮阻塞项，跨页断词 / 段落暂不处理。下文保留当时的原始测量；后续 13 篇出版社补测、修复与新内存对照见[最新报告](2026-11-09-pdf-publishers-memory.md)。

## 环境与方法

- Windows 主机、WSLg/X11 下的真实 Tauri 桌面，WebKitGTK 2.50.4，1280×800 窗口；Vite 提供源码。不是 Windows WebView2 安装包验收。
- 外部测试 Vault：`E:\Temp\agentero-reader-qa\runtime\vault`。样本、截图、诊断记录不提交到仓库。
- 新样本导入前没有 `source/layout.json`，本地 PP-DocLayoutV3 真正执行模型推理，然后提取 PDF glyph、生成连续阅读模型。没有使用上一轮的恢复版面缓存，也没有发起翻译请求。
- 每篇检查首、中、末页和复杂代表页；原始 PDF 的图表、公式、正文与阅读模式对照。完整链接扫描与代表悬停另列，不能替代逐页人工校对。
- 六篇为按版式挑选的压力样本，不是随机总体抽样。不能从样本通过率推断全体论文的“完美适配率”。

## 新增样本

| 来源 / 样本 | 页数 | 首次进入阅读模式等待 | 结果 |
|---|---:|---:|---|
| [ACL / BERT](https://aclanthology.org/N19-1423.pdf) | 16 | 122 秒 | 双栏、图表、附录、作者年份引用；259 个内部链接全部保留，发现并修复重复表头和续句误标题 |
| [CVPR / Deep Residual Learning](https://openaccess.thecvf.com/content_cvpr_2016/papers/He_Deep_Residual_Learning_CVPR_2016_paper.pdf) | 9 | 47 秒 | 数学、双栏、网络图；发现并修复 Nimbus 常规正文被误加粗；源文件没有内部链接 |
| [USENIX / Raft](https://www.usenix.org/system/files/conference/atc14/atc14-paper-ongaro.pdf) | 16 | 79 秒 | 封面、算法框、双栏；修复跨页单词片段被显示成标题；跨页拼接仍未实现 |
| [JMLR / t-SNE](https://www.jmlr.org/papers/volume9/vandermaaten08a/vandermaaten08a.pdf) | 27 | 147 秒 | 公式密集、彩色散点图、多面板；代表页公式与图像可读，首中末均有内容 |
| 本地 Zotero /《纳米晶金刚石钝化氮化镓 HEMT 特性研究》（朱潦亮，2024） | 89 | 422 秒 | 中文正文、上下标、目录、表格与多色坐标轴；代表页可读。四个没有阅读块的页面核对后均只有页眉页码、没有正文 |
| [1953 年 DNA 论文的公开重制 PDF](https://inters.org/files/watsoncrick1953.pdf) | 1 | 17 秒 | 有文本层，不能称为扫描件；首字下沉和特殊字间距产生重排错误，未通过连续阅读质量验收 |

合计 **6 篇、158 页**，加此前两批为 29 篇、614 页；累计数仅表示样本规模，不表示全部通过。首次等待时间受导入后台队列影响，不是单独的模型耗时基准。日志记录前五篇分别执行新的 headless layout；89 页样本的模型阶段约 402 秒。

额外从 BERT 首页生成一页纯图片 PDF，仅作为边界 fixture，不增加真实论文数量。原 PDF 模式显示正常，阅读模式返回空模型并提示 `No readable content was found.`。本地版面模型不提供 OCR，因此不能承诺扫描件重排。

## 本轮修复与验证

1. **字体名称与推断字重冲突**：`NimbusRomNo9L-Regu` / `ReguItal` 及标准 Roman 字体明确表示常规字重，优先于 PDFium 从 StemV 得出的高字重；保留 Medi / MediItal 的粗体和斜体。未知字体仍使用现有权重信息。CVPR 第 3 页正文恢复常规字重，真实粗体标题和公式向量保留。
2. **正文续句被模型标为标题**：已提取字体证据为非粗体、以小写字母开始且以句末标点结束的短续句按正文呈现。BERT 的 `ablation studies…` 和 Raft 的 `lished.` 不再放大加粗；编号章节仍是标题。此规则没有按题名、DOI 或页码分支，也没有宣称恢复跨页自然段。
3. **表头重复**：表格裁剪已包含全部实际字形时，移除行高框越出表格的重复文本；字形实际落在裁剪外的文字继续保留。BERT Table 5 的 `Dev Set` 只出现一次，阅读块 261→260、字符计数 58,968→58,961，减少的是已保留在表格图中的 7 字符。

六项新增失败断言先在修改前复现；修复后两个直接相关文件 84 项通过。扩大到七个相关文件共 **115 项通过、0 失败**，TypeScript `--noEmit` 与四个改动文件的 Biome 检查通过。

BERT 修复后重新全页扫描：253 处正文链接 + 6 处图片链接，共 259 处。Table 5、Figure 1、Peters 作者年份引用在 PDF / 阅读模式各悬停一次，共 6 次，目标页与预览图片加载成功；实际窗口截图核对。没有原生链接的样本不计作引用恢复通过。

表头去重另复查 PRISMA 第 4 页整页清单和经济论文第 52 页表格；原图内标题 / 字形保留。经济论文 Table 3 / B.1 / G.2 在两种模式共 6 次悬停，目标页 52 / 71 / 100 与图片就绪全部正确。首次经济表格截图拍到了异步加载占位，随后等待图片完成再截图，不把占位图作为视觉通过证据。六篇源 PDF 的 SHA-256 再次核对一致。

## 三组内存对照

旧前端基线为 Git `7cbdf46e`，通过 `git archive` 放到外部目录，复用同一套依赖并独立保存 Vite 缓存。确认旧源码没有连续阅读功能，`package.json`、锁文件、PDF 引擎 / provider 相对当前 HEAD 没有改动。三组都使用**同一个已编译 Rust Host**；这是旧前端同 Host 对照，不是完整旧版安装包对照。

每组重启为新的 Host / WebKit 进程，使用相同四篇已有版面缓存的论文（123 / 9 / 13 / 8 页），轮换三轮、共 12 次打开；每次访问首、中、末页并停留，末尾关闭全部测试 PDF，等待 30 秒。未安装引擎诊断钩子，未强制 GC。测量只返回标量，释放诊断引用。

| 指标 | 旧前端 PDF | 当前 PDF | 当前连续阅读 |
|---|---:|---:|---:|
| 采样跨度 | 181 秒 | 207 秒 | 311 秒 |
| WebKit RSS 采样峰值 | 994 MiB | 1,065 MiB | 2,076 MiB |
| 内核记录 RSS 最高值 `VmHWM` | 1,070 MiB | 1,078 MiB | 2,101 MiB |
| 匿名 / heap / stack Private_Dirty 采样峰值 | 749 MiB | 827 MiB | 1,842 MiB |
| 第一 / 二 / 三轮结束 RSS | 777 / 848 / 868 MiB | 837 / 850 / 883 MiB | 1,155 / 1,311 / 1,395 MiB |
| 关标签并等待后的 RSS | 854 MiB | 811 MiB | 1,107 MiB |
| 关标签并等待后的上述 Private_Dirty | 609 MiB | 578 MiB | 874 MiB |
| 页面刷新 / 进程退出 | 无 | 无 | 无 |

表中只比较 WebKit 页面进程，Host 另有记录。RSS 不等同于 WebKit 内部 footprint 阈值指标；`VmHWM` 是内核最高 RSS，二秒采样可能遗漏瞬时峰值。匿名私有脏页数据用于接近 WebKitGTK 2.50.4 的归因口径，不能与所有平台统一的“内存占用”混为一谈。

支持的结论：当前 PDF 与旧前端处在相近内存区间；连续阅读确实增加约 1 GiB 的峰值成本，关闭后较当前 PDF 仍多约 300 MiB。阅读时增加的正文字符模型、DOM、裁剪和引擎内存需要考虑资源预算。上述结果不证明增量全部属于泄漏，也不能排除更长时间 / 特殊文档才触发的问题。

不支持的结论：历史 9,408 / 10,429 MB footprint 退出“已经定位并修复”“必由阅读模式导致”或“原版就同样泄漏”。历史现场有诊断钩子污染；本次三组均未重现。冷模型推理没有进入三组同负载对照，所以不能用此表判断模型阶段是否无内存问题。

首次试跑因比较 `performance.timeOrigin` 的毫秒值发生诊断误报；同进程、navigation 为 navigate，值有数毫秒抖动。保留中断记录，改用每页随机 token 检测刷新，再从新进程重跑；该中断不计作应用刷新。

### 关闭后再打开的补充测试

排版修复后的新进程再测相同四篇，**每轮关闭所有测试 PDF 再打开**，共五轮、20 次阅读。493 秒、204 个采样点，页面 token / PID 未变；各篇五轮块数、DOM 与字符数一致。采样峰值 2,133 MiB、内核最高 RSS 2,234 MiB，匿名私有脏页采样峰值 1,901 MiB。每轮关闭约 10 秒后的 RSS 为 **1,136 / 1,246 / 1,370 / 1,380 / 1,414 MiB**，最后再等待 30 秒为 1,384 MiB。后几轮增量放缓，但该长度的实验不足以证明长期稳定平台，更不能将残留自动认定为正常缓存。

停止 WebDriver、通过 Inspector 补查（这部分在上述自然 GC 采样之后）：

- 页面没有 PDF host、没有阅读块 DOM。主页面 JavaScript 从约 116 MiB 到 GC 后 114 MiB，图片分类为 0；`other` 约 905 MiB。
- PDFium worker 堆约 99 MiB，WASM 线性内存 96,600,064 字节（约 92 MiB）；文档数、页数、引用计数、包装层跟踪分配、字体 handles / cache 全部为 0。
- 两个图片编码 worker 各约 0.17 MiB，引用解析 worker 约 4 MiB。未见文档 / 页缓存持续积压的证据；包装层为零不证明所有 native 分配都不存在泄漏。
- Inspector 结束后 RSS 约 1,230 MiB。等待、GC 和取证均影响该值，不能把差额全算成某一次 GC 的释放量。`other` 仍不是具体分配器名，历史峰值和剩余内存来源继续作为未决项。

三组基线与补充测试分开保存；后者包含本轮表头去重，不能用旧块数断言新结果。医学和经济样本的少量重复表内文字也被去除，图片仍保存对应字形。

## Zotero 的证据边界

本机正在运行 `E:\Zotero\zotero.exe` **10.0.8**（同时核对 `app/application.ini`），并非旧论坛案例中的 7/8。两次只读进程快照中主进程工作集约 2.4→2.3 GiB、私有字节约 3.8 GiB；没有重启 Zotero、关闭用户文档或禁用插件，不能据此诊断本机泄漏，也不与 Linux WebKit 的数据做性能排名。

- [Zotero 10 官方变更记录](https://www.zotero.org/support/changelog)：10.0 明确列出 reader tabs 显著降低内存；10.0.1 修复某些插件启用时长时间运行崩溃。版本改进不能代表所有泄漏都已消失。
- [2024 年特定 PDF 导致内存持续增长的报告](https://forums.zotero.org/discussion/115021/zotero-7-beta-memory-leak-from-loading-a-single-pdf-file-in-the-reader)：团队在 2024-06-11 确认最新 beta 已修复，报告者在 Windows / Ubuntu 复查通过。这是历史已确认案例，不是当前 10.0.8 普遍严重泄漏的证据。
- [2026 年官方回复](https://forums.zotero.org/discussion/132820/zotero-9-is-leaking-memory-its-memory-usage-has-exceeded-3-gb)：多个大 PDF 使用 3 GB 本身不证明泄漏；要看随操作不断增长、关闭标签并等待后仍不回落，并区分插件。
- [2025 年另一组报告](https://forums.zotero.org/discussion/124959/memory-leak-on-mac-and-zotero-7)：其中一位报告者后来定位到 Know Ur Zotero 插件；不能将帖内所有症状归为同一原因。

## 交付条件与证据位置

当前适合支持文本层正常的现代论文、保留原 PDF 随时回看，并明确标记阅读模式的适用范围。正式交付仍需 Windows 原生桌面验收、较长时间的内存趋势与异常现场分配取证，并按当前范围记录正常文本层论文中的特殊字体、图表和源文件坏链接；历史版式与扫描 OCR 已排除。不能将本次 115 项自动测试等同于任意 PDF 逐页无损。

本轮证据根目录 `E:\Temp\agentero-reader-qa`：

| 文件 | 内容 |
|---|---|
| `new-corpus/manifest.json`、`samples.json` | 来源、页数、SHA-256、测试条目路径 |
| `new-corpus/qa-results.json`、`*-content.json` | 前五篇冷解析时间、逐页文字 / 图像块摘要、初次失败现场 |
| `new-corpus/*-fixed-content.json`、`fixed-results.json` | 修复后真实模型与截图路径 |
| `new-corpus/nc_acl-audit.json`、`nc_acl-fixed-hover.json` | 全页链接与双模式悬停 |
| `new-corpus/image-only-result.json` | 纯图片边界测试，不作为额外论文计数 |
| `new-corpus/table-regression.json`、`source-hashes-verified.json` | 旧医学 / 经济表格及引用回归、六篇原文件哈希复核 |
| `new-corpus/final-tests.json` | 本轮 115 项相关回归结果 |
| `memory-ab/*-metadata.json`、`*-resources.json`、`*-results.json` | 对照条件、进程采样、每次操作结果 |
| `memory-ab/frontend-source-hashes.json`、`summary.json` | 对照前产品源码哈希、三组汇总 |
| `memory-ab/current-reader-close-*.json`、`five-cycle-summary.json`、`five-cycle-closed-inspector.json` | 五轮关开后的趋势、DOM 和 worker 关闭状态 |

`docs/frontend/pdf.md` 的「限制与后续」同步本轮结论。仓库没有独立 Roadmap / TODO。Git 作者姓名与邮箱尚未配置，本轮修改未提交；不编造作者身份，不混入其他工作区改动。
