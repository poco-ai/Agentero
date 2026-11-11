# PDF 与连续阅读跨领域回归

2026-11-08 开始，2026-11-09 补充异步页状态修复验证。新增 8 个领域的 8 篇真实论文，共 247 页，继续检查 Agentero 的 PDF 与连续阅读。此前的 [15 篇、209 页回归](2026-11-08-pdf-reader-regression.md) 保留独立记录。本轮修复使用字体、文字几何、版面角色和原生链接，没有按论文标题、DOI 或固定页码分支。

作者年份引用的空白 / 错误裁剪已在桌面实测中修复，同一文档切换阅读模式不再重复提取整篇文字。多文档轮换后的碎句和缺字已定位为 WebKit 异步捕获变量缺陷，通过同步页计算隔离修复。文档写入引起的开发页 reload 已复现并收窄 Tailwind 扫描范围修复。另已捕获 WebKit 内存超阈值终止页面进程的日志，干净流程未重现该峰值，历史退出的分配来源仍待定位。

## 样本与覆盖

| 领域 | 样本 | 页数 | 原文件 GoTo / Named 标注 | 扫描与悬停结果 |
|---|---|---:|---:|---|
| 数学 | Johnson–Lindenstrauss lemma，arXiv 1411.2404v1 | 8 | 74 | 74 处正文链接；8 个悬停；`[JL84]` 在两种模式补查原文条目 |
| 机器学习 | Attention Is All You Need，1706.03762v7 | 15 | 95 | 77 处正文 + 18 处图片链接；21 个悬停 |
| 天体物理 | Observation of Gravitational Waves，1602.03837v1 | 16 | 116 | 115 个可解析目标；14 个悬停；另 1 个原文件 `viewpoint` 目标不可解析 |
| 医学方法学 | PRISMA 2020，10.1136/bmj.n71 | 9 | 0 | 原文件无内部链接；检查术语、整页表与流程图 |
| 药物化学 | SwissADME，10.1038/srep42717 | 13 | 165 | 144 处正文 + 21 处图片链接；21 个悬停；表内第 53 篇引用在两种模式补查 |
| 生物统计 | DESeq2，10.1186/s13059-014-0550-8 | 21 | 186 | 186 处正文链接；29 个悬停 |
| 大气气候 | CAMS reanalysis，10.5194/acp-19-3515-2019 | 42 | 62 | 21 处作者单位导航；41 处页脚页码在阅读模式隐藏；图表与代表页另查 |
| 经济金融 | Banking networks and economic growth，ECB WP 3019 | 123 | 492 | 487 处正文 + 2 处图片 + 3 个无文字标注；56 个悬停复查中 51 个有效预览、4 个脚注导航、1 个源文件坏目标 |

合计 1,190 个原始标注，PDFium 提供 1,189 个可扫描标注。前五个有可预览引用的短样本共 93 个悬停，加上经济论文 51 个有效预览，共 144 个目标页与图片就绪检查。代表引用额外核对实际文字；此数字不代表每张图表整页都经过人工逐字审阅。

### 源文件本身的限制

- 天体物理首页顶部 `viewpoint` 无可解析页面目标；不计作阅读模式漏挂。
- 气候论文正文的作者年份引用和图号本来没有原生链接。已有 62 个标注是作者单位和页脚页码，不能把它们计作文献预览通过。
- 经济论文 `table.caption.10` 的目标损坏，PDFium 返回 `pageIndex=-1`；独立 PyMuPDF 解析也得到异常目标。阅读器不猜另一个表格位置。
- 经济论文第 16/17 页另外三个标注没有可命中的文字，其中一个在页外；与上述坏表格目标分别记录。
- 经济论文正文上标 1、9、20、30 指向脚注，保留导航，不显示参考文献卡片。

## 通用修复

| 触发条件 | 处理 |
|---|---|
| 独立公式被移到正文之前 | 公式编号合并保留连续阅读的原始顺序，图表库继续使用自身排序 |
| Computer Modern 正文被显示成粗体 | 优先采用 TeX 字体变体，支持子集前缀；保留实际粗体和斜体 |
| 相邻重叠段落抢走公式 / 引用 | 链接中心落入多个区域时按实际交叠面积分配 |
| 图号被误判为上标文献 | 比较最近且垂直相交的正文邻字，排除邻栏和远处下行笔画 |
| 表格 Reference 列的纯数字不弹预览 | 目标页存在相同编号的文献条目后才启用裁剪 |
| 旧式 LaTeX 字母型引文 / 公式目标失效 | 同时解析 Catalog `/Dests` 字典与 `/Names /Dests` name tree，兼容数组和 `/D` wrapper |
| 帽号脱离变量或连成横跨正文的公式条 | 按水平交叠和垂直位置把重音符附着到变量并保留原字形 |
| 导数上方的点被编码为 `_` | 依实际重叠几何保留点与变量，普通下划线仍按文字处理 |
| 页边小脚注字母被框裁掉 | 只恢复紧邻已有正文基线的较小前置标记，不放宽孤立页码 |
| 短小重复页边水印进入正文 | 识别跨页重复的窄边缘文字，正文同词不受影响 |
| 作者年份引用目标坐标失准 | 合并相邻同 key 的作者 / 年份标注，在原目标页唯一匹配明确作者及年份；歧义时不显示猜测条目 |
| 长文反复切换阅读模式耗时 | 复用当前 viewer 已完成的文字准备；版面变化、重试或换文档使其失效，取消任务的迟到结果仍丢弃 |
| 多文档轮换后正文变为大量碎句 | 异步循环只读取页数据；字体映射和整页同步重建通过参数隔离，避免 WebKit 代码回收后闭包读到前页状态 |

### 作者年份裁剪的实际核对

经济论文第 10 页 `Kalemli-Ozcan, Papaioannou, and Perri (2013)`，现在在 PDF / 阅读两种模式都显示第 42 页的 **Global banks and crisis transmission**，含期刊、卷期与 495–510 页。第 11 页脚注中的 `Davis and Kahn (2008)` 在两种模式都显示第 41 页的 **Interpreting the great moderation: Changes in the volatility of economic activity at the macro and micro levels**，含期刊与 155–80 页。

另外逐张检查 Backus 1992、Demsetz / Strahan 1997、Andrews / Stock / Sun 2019、Arezki / Ramey / Sheng 2017、Landier / Sraer / Thesmar 2017、Petersen / Rajan 1994、Gabaix / Koijen 2020，以及表格图片内 Berger / Kashyap / Scalise 1995；裁剪包含对应文献文字。图表 Table 3、B.1、G.2 在两种模式补查目标页和整页预览。

## 长文与稳定性

同一 123 页文档在修复前每次从 PDF 切回阅读模式都重新调用整篇文字提取，实测约 27 秒。修复后首次准备 20.297 秒，随后三次切回分别为 **2.421 / 2.266 / 2.453 秒**；保留 862 个阅读块。最终页状态修复后再测三次为 **2.266 / 2.313 / 2.312 秒**，块数保持 862。这是恢复已有版面结果后的文字准备时间，不是从零运行版面模型的时间，也不代表冷启动已达到秒开。

初轮八篇样本完成两轮共 16 次打开、首 / 中 / 末页滚动及模式切换。资源采样跨度 512 秒、163 个采样点，WebKit 页面进程 PID 始终为 654，RSS 约 **2.0–3.4 GiB**，结束约 2.8 GiB。随后 23:28:45 观察到页面 reload，Host / WebKit PID 未变。最终两轮及引用复查结束后，01:09 / 01:11 / 01:15–01:16 又出现前端重新启动，Host / WebKit PID 仍为 11533 / 11574；读取到 navigation type 为 `reload`。当时未发现对应 Vite full reload 日志；后续已复现文档写入触发 Tailwind 直接刷新，见下节。历史未记录刷新消息的每次事件不能仅凭时间逐一确定。

进一步复现中，23:58 及次日 00:53 的 WebKit 日志明确报告 footprint 达到 **9,408 / 10,429 MB**，无法降至 **8,192 MB** 以下而主动终止页面进程。Host 继续存活，WebDriver 会话失效。此指标不等同于采样 RSS；没有内核 OOM 日志不能排除 WebKit 自身的内存保护。占用来源尚未定位，不能将历史所有退出都归于同一原因，也不能宣称长期无泄漏或崩溃已修复。

轮换中发生过一次测试脚本在工具栏挂载前读取空节点，应用页面仍在，等待控件就绪后继续。化学表格引用的一次悬停受面板裁切影响，展开可见区域后两种模式均通过。脚本 / 窗口遮挡问题不计作应用崩溃。

第二轮曾记录机器学习 / 化学论文的阅读块数从 166 / 134 变为 513 / 510。后来捕获到 PRISMA **131 → 797**、经济论文 **862 → 4,034** 的完整异常模型，DOM 数量一致，确认是实际内容损坏。worker 返回的经济论文 text runs 正确，最终模型却使用首页字体。相同 JavaScriptCore 2.50.4 的代码回收复现与 WebKit [bug 313499](https://bugs.webkit.org/show_bug.cgi?id=313499) 一致。仅移动字体映射仍会丢字；整页同步计算隔离后，底层复现连续 8 次保留四页全部 9,600 个字符且字体全部正确，详见 [复盘](../bug_fix/pdf-webkit-async-page-state.md)。

最终使用无诊断钩子的全新桌面进程完成八篇两轮，16 次模型 / DOM 块数全部一致，各篇字符总数两轮一致。295 秒、94 个采样点中 WebKit PID 始终为 11574，RSS **671–2,217 MiB**，结束 1,946 MiB；没有页面进程退出。这是短时修复验证，不能证明上述内存问题已解决。PRISMA 第 2 页原异常段落恢复为完整连续正文，并查看实际窗口截图；两处经济论文作者年份引用再次在 PDF / 阅读模式各检查一遍，预览题名、作者及页码均正确。

| 样本 | 每轮阅读块 / DOM 块 | 每轮模型字符数 |
|---|---:|---:|
| 数学 | 140 | 21,845 |
| 机器学习 | 166 | 35,300 |
| 天体物理 | 227 | 71,477 |
| 医学方法学 | 131 | 49,777 |
| 药物化学 | 134 | 65,667 |
| 生物统计 | 303 | 93,194 |
| 大气气候 | 336 | 141,068 |
| 经济金融 | 862 | 217,752 |

字符数为阅读模型中各段 `characters` 的合计，用于两轮内容稳定性对比；不是整篇 PDF 所有字符的无损覆盖率。

### 2026-11-09 刷新与内存继续定位

将回归报告原样写回、保持 SHA-256 不变，实际收到 Tailwind 的 `full-reload`，页面随即卸载。`src/index.css` 原先从整仓扫描类名，文档和测试也被注册为依赖；该插件直接发送刷新消息，因此没有 Vite 常规刷新日志。现使用 `source(".")` 限定 `src/`，显式纳入 `index.html`。重启 Vite 清除旧依赖后，原样写回文档及测试文件均不刷新，见 [复盘](../bug_fix/tailwind-dev-reload.md)。

内存验证先在无引擎钩子、只保留标量诊断数据的页面执行轮换：758 秒、346 次 RSS 采样，峰值 **3,289 MiB**，结束 **2,508 MiB**，PID 11574 未变。前 35 次模型块数与字符数一致。第 36 次脚本误读 React alternate 上的旧准备状态（118 块、字符数 0），此时当前 DOM 为 134 块；重新读取已提交树得到 134 块、65,667 字符。保留这次中断，不能把旧状态计作内容损坏或把该轮宣称为 40 次通过。

修正外部诊断脚本、完成扫描范围修复后重新执行八篇两轮：**16 次模型 / 当前 viewer DOM 块数全部一致，每篇字符总数两轮一致**。343 秒、156 次采样中 PID 始终为 11574，RSS **704–2,660 MiB**，结束 **1,943 MiB**；没有新的卸载 / 刷新事件或进程退出。PRISMA 第 2 页实际窗口正文再次核对。

随后通过 WebKit Inspector 读取主页面及 worker 堆，关闭独立测试文库的 PDF 标签并做 GC 对照：

| 观测 | 结果与范围 |
|---|---|
| 页面打开时内存分类 | JavaScript 约 472 MiB，图片约 2 MiB，`other` 约 1,018 MiB；单次主页面 GC 变化很小 |
| 关闭测试 PDF 后 | 主页面 JavaScript 降至约 123 MiB；worker GC 后图片降到 0，`other` 仍约 990 MiB，RSS 约 1.3 GiB |
| 活跃 worker | 4 个：PDFium、两个图片编码器、引用解析器；编码器各约 0.26 MiB，引用解析器约 5.16 MiB 的堆 self size |
| PDFium 关闭状态 | `documents=0`、`totalPages=0`、refCounts 为空；包装层跟踪的 `totalAllocated=0`、`allocationCount=0`，字体 handles / cache 均为 0 |
| PDFium 保留容量 | WASM 线性内存仍为 251,461,632 字节（239.81 MiB）；含其他 ArrayBuffer 的 worker 堆约 246 MiB。保留容量不等同于仍持有旧文档 |
| 引擎队列 | 运行时没有堆积已完成的 resultTasks；独立 JSC 代码回收场景下 300 个队列任务按页返回且最终排空 |

`other` 不是具体分配器名，以上结果不能把剩余约 1 GiB 归到 PDFium，也不能推出历史 10 GiB 峰值的持有者。旧第二次退出进程曾产生 40,418 条诊断钩子相关的 `unhandledrejection`，第一次退出也运行着字体诊断钩子；这些现场受到诊断干扰。干净流程未重现阈值退出，保留历史日志，但不据此宣布泄漏修复或将退出全部归因于钩子。

## 自动验证

- 122 个测试文件：**968 项通过、10 项跳过、0 项失败**。
- TypeScript `--noEmit` 通过；本次引用裁剪、生命周期、页状态隔离及对应测试的 Biome 检查通过。
- Rust `cargo test -p agentero-core features::pdf::layout_index::tests --lib --offline`：13 项通过。该命令没有重编译桌面程序，也没有覆盖运行中的 PDFium 动态库。
- 新增的生命周期用例先复现重复提取失败，再验证复用、版面变化、手动重试、文档替换及取消后的迟到结果。
- 异步页状态另在 JavaScriptCore 下验证修改前失败、关闭 JIT 时恢复、整页隔离后连续 8 次通过；Node 单元测试不代替运行时缺陷复现。
- 8 个原始 PDF 的 SHA-256 与导入前清单一致。
- 刷新修复后另运行页字体、重建、字符覆盖与连续阅读生命周期四个文件：51 项通过；TypeScript `--noEmit`、`src/index.css` 的 Biome 检查通过。实际 Tailwind 编译 / 扫描检查通过；写回应用样式仍产生局部 HMR，文档和测试写回不刷新页面。

## 复查方法与证据

环境为 Windows 上的 WSLg / X11 / WebKitGTK Tauri 桌面程序，Vite 热更新加载当前前端源码；不是仅在独立浏览器网页验证。运行时使用 `ulimit -c 0`，未新增 WSL 崩溃转储。未重建 Windows WebView2 安装包。

原临时 Vault 随 WSL `/tmp` 清空，本次重新导入原始 PDF，并由前一轮真实阅读块记录恢复测试 Vault 的 `source/layout.json`。随后重新提取 PDF glyph、构建阅读正文并执行真实鼠标悬停。这能验证引用、重排与模式切换，**不等同于重新从零执行版面模型**。没有发起新的翻译或 AI 请求。

在独立测试文库打开各篇，等待文字准备结束，依次检查：

1. 经济论文第 10/11 页上述作者年份引用，分别切换 PDF / 阅读模式；核对预览作者、年份、题名和期刊页码。
2. 经济论文 Table 3 / B.1 / G.2、数学 `[JL84]`、化学表内 `53`；检查真实指针命中、目标页与预览文字。
3. 同一文档关闭 / 重开阅读模式，确认没有再次整篇提取；更换文档、版面更新或显式重试应重新准备。
4. 轮换八篇并滚动首中末页，记录文档 ID、阅读块数、实际 DOM 块数、WebKit PID / RSS 与内核日志。

本机证据根目录为 `E:\Temp\agentero-reader-qa`，图片与临时样本不进入仓库：

| 位置 | 内容 |
|---|---|
| `crossfield-manifest.json` | 原始文件完整路径、来源、页数与初始 SHA-256 |
| `crossfield/*-audit.json`、`*-hover.json` | 首轮逐页标注扫描与悬停结果 |
| `crossfield/econ-source-anomalies.json` | 经济论文坏目标与三个空白标注的独立解析 |
| `runtime/econ-hover.json` | 两处作者年份引用、两种模式四张窗口截图 |
| `runtime/econ-recheck.json`、`econ-recheck-*-0.png` | 56 个悬停复查与实际预览图像 |
| `runtime/*-representative.json` | 数学、化学与经济表格的双模式补查 |
| `runtime/mode-switch-timing.json`、`post-font-fix-switch.json` | 123 页模式切换耗时 |
| `runtime/stability-results.json`、`stability-resources.json` | 两轮切换、进程与 RSS 采样，保留脚本中断记录 |
| `runtime/switch-content-recheck.json`、`switch-scroll-recheck.json` | 异常块数后的针对性复查 |
| `runtime/content-anomaly-1-cf_med.json`、`med-anomaly-page2.json` | PRISMA 异常模型、DOM 正文及重新读取的正确 glyph / runs |
| `runtime/econ-font-current.json` | 经济论文 4,034 块异常模型与 API / worker 响应对照 |
| `runtime/jsc-page-font-regression.json`、`jsc-page-isolation-regression.json` | JavaScriptCore 修改前、JIT 对照及最终 8 次隔离验证 |
| `runtime/post-font-fix-results.json`、`post-font-fix-resources.json` | 最终干净进程八篇两轮内容及资源采样 |
| `post-font-fix-med-p2-settled.png`、`runtime-econ-*.png` | 异常正文恢复和作者年份预览双模式截图 |
| `runtime/app-restarted.log` | 包含第二次 WebKit 内存阈值终止日志 |
| `runtime/final-vitest-page-isolation.json`、`source-hashes.json` | 最终自动测试与源文件哈希复核 |
| `runtime/vite-hmr-wire.jsonl`、`reload-before-doc.json`、`reload-after-restart-*.json` | 文档写入触发刷新及收窄扫描范围后的反向验证 |
| `runtime/tailwind-source-check.json` | 实际 Tailwind 扫描范围与 CSS 生成检查 |
| `runtime/memory-clean-*.json`、`memory-confirm-*.json` | 首轮诊断中断与修正后两轮模型、DOM、RSS 记录 |
| `runtime/heap-after-rotation-summary.json`、`worker-heaps-closed.json`、`pdfium-after-close.json` | 页面 / worker 堆摘要和关闭文档后的 PDFium 状态 |
| `runtime/memory-categories-closed-tabs.json`、`memory-categories-after-worker-gc.json`、`native-maps-closed.json` | 内存分类、GC 及 Linux 映射对照 |

未覆盖扫描件 OCR、任意 PDF 逐页视觉无损、跨页引用区间收集、新论文在线翻译质量及 Windows 原生安装包验收。页间续句可能保留段落空隙；无原生链接的普通图号 / 引文不自动补造。项目无单独 Roadmap / TODO，此处未决项同步到前端 PDF 文档的「限制与后续」。Git 作者姓名和邮箱仍未配置，本轮相关修改尚未提交。
