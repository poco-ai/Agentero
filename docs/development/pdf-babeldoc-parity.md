# PDF 翻译与 BabelDOC 算法差异

## 基线与验收口径

2026-10-26 源码审计，上游固定为
[`38d3896dcde9b5a940c62cf5563cadea673a64d3`](https://github.com/funstory-ai/BabelDOC/tree/38d3896dcde9b5a940c62cf5563cadea673a64d3)。
本地初始基线 `5c781d586`。上游源码检出在仓库外，不作为 Agentero 的依赖。

目标是沿用 TypeScript / Rust / PDFium，逐项缩小行为差异。**当前不是 BabelDOC 的完整移植，不能宣称核心算法相同。**
上游是 AGPL-3.0，本项目是 MIT；本次修改不复制或逐行转写上游代码。
算法对照表描述行为与数据要求，不把上游代码作为 MIT 源码引入。

## 实现前的逐阶段对照

上游入口 `babeldoc/format/pdf/high_level.py:do_translate`：解析 IL → 扫描检测 →
版面 → 可选表格 → 段落 → 公式/样式 → 可选术语提取 → 翻译 → 重排 → PDF 写出。
以下上游路径相对 `babeldoc/format/pdf/document_il/`。

| 阶段 | BabelDOC 源码与行为 | Agentero 初始行为 | 核心差异 / 验收要求 |
|---|---|---|---|
| PDF 表示 | `frontend/`、`il_version_1.py`：字形、visual bbox、字体、图形状态、XObject、曲线、Form | PDFium rich runs 可用，但 `title-text.ts` 只向后传纯文本和 bbox | 丢失源样式与可移动公式对象；需要保留结构化内容到翻译、重排与导出 |
| 版面 | `midend/layout_parser.py`：布局模型及字符归属 | PP-DocLayoutV3 / Paddle / MinerU，按 run 中心入框 | 模型与粒度不同；同一 PDF 不保证相同段落 |
| 段落 | `midend/paragraph_finder.py`：layout/XObject 分组，视觉 Y 聚类，碰撞直方图分行，列表/目录/可选短行切段，重叠修复 | 阅读行排序 + 行距切段；小写续句启发式跨页/栏串接 | 初始缺少列表边界、缩进、XObject 与字符级聚类；不能用跨页拼接冒充同算法 |
| 公式 | `midend/styles_and_formulas.py`、`utils/formular_helper.py`：字体、Unicode 类别、布局、角标尺寸、visual bbox；合并公式、绑定曲线/Form | `translate/mask.ts`：TeX/URL/引用字符串占位 | 普通 PDF 没有 TeX；分数线、上下标、数学字体不能从纯文本恢复 |
| 样式 | `StylesAndFormulas._calculate_base_style`、`process_page_styles`：基准样式与同样式片段，字号众数 | 从框面积、字符长度估字号，标题统一加粗 | 不知道真实字号，段内粗斜体和颜色丢失 |
| 翻译单位 | `il_translator.py` / `il_translator_llm_only.py`：段落组成、公式与富文本占位、上下文和术语 | 句级编号批次，跨框句对映射；可靠性包装额外重试失败项 | 上游 LLM 路径还把相邻页末/页首正文配对、按 Y 跳变 >20 pt 配对跨栏段落；与本项目小写续句串接不同。同模型也不会逐字一致 |
| 输入完整性 | IL 保存完整段落；翻译失败有回退策略 | 底层 `source` 截至 2500 字符，`raw` 保留全文；实际 UI 经可靠性包装已保存全文并拆分 2200 字符块 | 两套提取器不一致；包装层把分块伪装成 header，raw 变为归一化 source，损失原句定位；需统一完整文本和传输层分块 |
| 输出校验 | 占位符解析回填结构化组成；失败按上游路径重试/回退 | 只检查占位符是否出现，漏标后发无保护原文；多余编号被最后一段吸收 | 重复/未知占位符、损坏批次可能被当成功；应拒绝不完整结果 |
| 排版单元 | `midend/typesetting.py:TypesettingUnit`：字形/公式宽高、字体 advance、原对象 passthrough/relocate | DOM span 与浏览器字体、矩形白底 | 浏览器断行不能等同于上游字形排版，公式不能整体移动 |
| 缩放 | `_find_optimal_scale_and_layout`：CJK/其他初始行距不同，离散缩放，向下/右借空白，放松英文断行后重试 | 固定 1.25→1.10 行距、二分字号；仅标题/图题受限扩框 | 顺序、阈值、可用空间均不同；单改常数不构成等价 |
| 全文一致性 | `preprocess_document`：按字符数加权的缩放众数，限制较大段落缩放 | 每块独立估算，标题有本页正文参考值 | 逐批即时显示与整篇预计算有产品取舍；需稳定的文档级布局阶段 |
| 表格/扫描 | 可选 `table_parser.py`；`detect_scanned_file.py` 与配置相关 | 目前全文覆盖依赖文字层，表格内容不作为独立单元翻译 | 不能把“图表留在原位”算成“支持表格翻译”；扫描检测不等于 OCR 完成 |
| PDF 输出 | `backend/pdf_creater.py`：重建 PDF 字体/内容，mono/dual、链接等 | 原 PDF + HTML 覆盖层、JSON 缓存 | 没有等价的重排 PDF 输出；原文批注映射是本项目额外契约 |

## 实施顺序与未决项

1. 修复完整文本、传输预算与结果校验；保留源字号，消除已知的数据损失。
2. 建立含字符索引、字体、基线与公式原对象引用的中间表示；贯穿缓存、句对、覆盖层。
3. 在中间表示上实现公式识别、公式/图形整体移动、富文本占位和还原。
4. 建立可重复的字形度量/断行/碰撞/全文缩放计算；使显示与导出消费同一布局结果。
5. 实现 PDF 内容流输出与字体子集，验证原有超链接和批注语义。
6. 同文档、同目标语言、同模型参数比较中间结果与渲染，再逐项关闭差异。

## 对照实验规则

- 科研样本至少覆盖：双栏正文、密集行内公式、多行公式/算法、表格、混合字号。
- 分离确定性算法测试和真实 LLM 测试：固定译文用于排版比较，真实翻译用于占位与语义比较。
- 记录 PDF SHA-256、页码、引擎 commit、模型/参数、字体、页面尺寸与缩放。
- 比较：源字符覆盖率、公式/占位符数量、段落边界、框越界/碰撞、字号、链接与批注。
- 截图只能证明该样本视觉结果；不能证明算法等价。没有实际运行的链路明确标为未验证。
- 样本、上游检出、截图和临时运行环境均留在仓库外。

## 第一轮验证与残余差异（历史基线）

### 已实现的范围

- 统一公开可靠性入口与底层的文本提取：完整 `source`、原始 `raw`、段落类型与句子锚点一直保留。
  取消将长段落拆成伪 `header` 的中间结构，改为占位保护后按请求预算分块。
- 缺失、重复、未知占位符和多余批次编号不再视为成功；重试保持保护，最终失败保留原文。
- 从 PDF rich runs 采样按字符数加权的源字号众数及主要粗斜体，随布局缓存、翻译条目传到覆盖层。
  老缓存只补走文字层，不重跑版面模型。字号不再仅凭框面积与译文长度猜测。
- 这些是 Agentero 的独立实现。没有引入 Python 运行时，也没有完成 BabelDOC 的字符级 IL、公式对象重排或 PDF 输出。

### 实际样本与方法

| 论文 | 实际文件 | SHA-256 |
|---|---|---|
| [Attention Is All You Need](https://arxiv.org/abs/1706.03762) | v7，15 页 | `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697` |
| [Deep Residual Learning for Image Recognition](https://arxiv.org/abs/1512.03385) | v1，12 页 | `1e0651b6810ecba34a3dbc5b5b0209226f889004607c1f203540a48d64e5a93a` |

版面链路使用真实 PDFium + PP-DocLayoutV3。视觉实验取两篇第 1 页：给两边注入**相同固定中文译文**，
Attention 替换标题、摘要标题、摘要正文 3 块；ResNet 替换标题、摘要标题、两段摘要 4 块。
其他文字保持英文。没有调用真实翻译模型；因此本实验验证提取、排版与渲染差异，不验证语义或端到端翻译质量。

BabelDOC 实际运行上述固定 commit 的 CLI，替换翻译阶段回调后继续使用其段落、样式、排版与 PDF 写出流程。
保留调试 IL 供读取字号/缩放，另跑无 debug、无水印输出用于截图。参考环境使用 bitstring 4.4、PyMuPDF 1.28.2、peewee 3.19；
最初直接安装解析到不兼容依赖，固定这些版本后成功。Agentero 使用实际 `LayoutTranslateOverlay`、同一 PDF 的底图与模型检测框，
在 Chrome 中以 816 × 1056 CSS px、DPR 2 渲染；页面为 612 × 792 pt。
“before”截图只关闭 `sourceStyle`，用于比较旧字号回退策略，**不是完整 checkout 基线的前后测试**。

桌面端已通过 `pnpm tauri dev` 编译启动并截屏。当前会话没有可用的 computer-use 交互工具，
上述组件流程由 Playwright 验证；未验证桌面内点击翻译按钮、真实 provider、跨页滚动及导出交互。

### 定量与视觉结果

下表 Agentero 为渲染后的 CSS 字号除以 4/3，统一换算成 pt；BabelDOC 为源字号乘排版 scale。

| 样本块 | 原字号回退策略 | 本次源字号策略 | BabelDOC |
|---|---:|---:|---:|
| Attention 标题 | 15.000 | 15.498 | 15.494 |
| Attention 摘要标题 | 13.321 | 11.960 | 11.955 |
| Attention 摘要正文 | 9.867 | 9.960 | 9.963 |
| ResNet 标题 | 14.605 | 14.350 | 14.346 |
| ResNet 摘要标题 | 12.896 | 11.960 | 11.955 |
| ResNet 第一段摘要 | 10.253 | 9.960 | 9.963 |
| ResNet 第二段摘要 | 10.197 | 9.960 | 9.963 |

7 个被替换块的 DOM `scrollWidth/Height` 均未超过 `clientWidth/Height`。这仅说明这些块没有滚动溢出，
不能证明没有邻块碰撞、公式遗漏或整篇无缺陷。

逐项仍可观察到：

1. **提取与排序**：ResNet PDFium runs 已将 `learn-` / `ing` 输出为 `learn` / `ing`，
   BabelDOC 段落仍含 `learn- ing`；`152 layers—8× deeper` 的乘号在 PDFium 提取顺序中跑到后方。
   这发生在翻译前，字符串后处理不足以可靠恢复。两种提取结果都需与页面字符位置核对，不能直接把某一结果当真值。
2. **字体与富文本**：ResNet 原摘要斜体。本次主要样式继承会令整段中文倾斜；BabelDOC 此样本中文使用直立字形、拉丁字母保留斜体。
   需要按字符/脚本选择真实字体与段内样式，单一 `fontStyle` 不等价。
3. **断行、缩进、行距**：字体度量、首行缩进与框边界仍不同。上游按字形/公式排版，CJK 初始行距因子 1.5，
   其他为 1.3，并同时考虑字符实际高度；当前 DOM 使用 1.25→1.10。即使最终字号相近，基线位置仍不同。
4. **缩放策略**：Attention 标题两边恰好都约缩至 90%，并不代表算法相同；当前仍为 DOM 二分适配，
   上游还会离散重试、借空白、调整英文断行、使用全文缩放统计。
5. **未覆盖功能**：公式与曲线整体移动、表格翻译、扫描件策略、术语/上下文、mono/dual PDF、字体子集与输出链接均未达到上游能力。
   公式密集页、多行公式、表格和真实翻译模型尚无配对验收结果。

### 验证记录与复现

- 最终 TypeScript 类型检查通过；全量单元测试 286 文件通过、1 文件跳过，2327 用例通过、5 跳过，
  包含公开入口长句与源样式缓存回归测试。
- `pnpm lint:ts` 通过，仓库其余位置仍有 7 warnings、1 info，未自动修改无关文件。
- Attention 全 15 页真实模型 smoke 通过。ResNet 全篇运行在第 8 页触发已有 `image.titleBbox` 断言，
  尚未与原始 checkout 配对定位，因此不能判断是否为既存缺陷；仅第 1 页定向运行通过。没有宣称全篇 smoke 通过。
- 没有 Rust 生产代码变更；桌面开发编译通过，未执行完整跨平台发布测试。

本机实验目录为 `/tmp/agentero-babeldoc-comparison`，包含两篇 PDF、检测 JSON、
`render-overlay.cjs` / `render-resnet.cjs`、`fixed-reference.py` / `fixed-resnet.py`、
调试 IL、`fixed-clean-output/` PDF、`*-before.png` / `*-after.png` / `*-babeldoc-clean.png` 与日志。
它是临时研究产物，可能被系统清理，不作为仓库依赖；截图和 PDF 未提交。

真实模型 smoke 复现（省略 `AGENTERO_LAYOUT_MAX_PAGES` 即全篇）：

```sh
AGENTERO_LAYOUT_PDF_DIR=/tmp/agentero-babeldoc-comparison \
AGENTERO_LAYOUT_MODEL=/path/to/pp-doclayoutv3.onnx \
AGENTERO_LAYOUT_PDFS=attention,resnet \
AGENTERO_LAYOUT_MAX_PAGES=1 \
pnpm exec vitest run test/pdf-layout-arxiv.test.ts
```

**验收状态：只完成第一阶段完整性与源样式修复；全文功能与核心算法等价未达成。**
后续的验收入口是上述中间表示、公式对象、统一排版及 PDF 输出四项，不能以这 7 块截图代替。

## 字符级重排与导出实现（2026-10-26，第二轮）

分支 `codex/pdf-babeldoc-parity`。本节覆盖上面第一轮「尚无 IR / PDF 输出」的状态；
第一轮证据保留作为前后对照。目标尚未全部验收，不能标记为 BabelDOC 等价实现。

### 已接通的实际链路

`PDFium → extractReflowDocument → Paragraph / Formula IR → 现有翻译服务 →
layoutReflowDocument → PDFium 原文移除 + pdf-lib 写出 → PDFium 渲染预览 / PDF 导出`。
生产应用不依赖 Python。BabelDOC 的 Python 环境仅用于仓库外对照实验。

- 字符索引、原始 Unicode、advance bbox、visual bbox、字体、字号、粗斜体、颜色保留在 IR。
  EmbedPDF engines 补丁增加按字符索引读取原始 Unicode 的内部选项，不改变原有搜索/选择默认行为。
  换行软连字符在段落文本中归一；原字符与几何仍保留。
- 按正文基准字体聚行，角标/数学字形附回邻近正文行；字体、符号、字号、模型公式框共同识别公式岛。
  空格连接的 `N = 6` 和引用编号整体保护。段内样式用成对标记，公式用唯一标记；模型输出
  缺失、重复或破坏结构时拒绝，不把损坏结果送入排版。
- 公式从未修改的 PDF 提取矢量片段；片段外文字先删除，避免复制隐藏的整页英文。
  再将片段随译文移动和缩放。独立公式、图形和未翻译区域继续使用原 PDF。
- 基于嵌入字体真实宽度排版，公式是原子单元；处理首行缩进、中西文间距、禁则标点、
  英文单词、CJK 行距、离散缩放、避障扩框和文档加权正文缩放。无法容纳时报告失败，禁止静默裁切。
- 表格按文字行和水平间距拆单元格，单元格不借用邻格空间；纯数值单元格保持原文。
- 页面预览来自最终 PDF，透明选择层使用同一布局坐标；终局后译文页由与原文页相同的渲染层按显示尺寸/DPR 绘制，缩放自动重渲。原文引用使用 IR 字符框；
  当前对齐单位是段落，无法声称仍具有原先逐句精度。源高亮可映射到译文段落。
- 工具栏支持译文 PDF 和原文/译文交替页 PDF。输出是实际文字与矢量公式，不是页面截图。
  保留并移动能匹配的链接矩形，双语输出修正复制原文页的显式 GoTo 引用。
  构建操作仅修改隔离的 PDF 副本。

### 字体与依赖

使用固定版本的 Noto Serif（常规/粗体/斜体/粗斜体）和 Source Han Serif CN（常规/粗体）。
字体来自 [BabelDOC-Assets](https://github.com/funstory-ai/BabelDOC-Assets/tree/1eeeec2a63b05fe6fe7a1f45f0955a8fa98793c4/fonts)，
逐文件 SHA-256 校验，首次下载后存入应用 cache 的 `pdf-fonts/<revision>`。
字体按上游字体说明采用 SIL OFL 1.1（Noto 字体来自 googlefonts/noto-fonts，
Source Han TrueType 来自 Pal3love/Source-Han-TrueType）；未把字体或 BabelDOC 源码加入仓库。
首次使用需下载字体；下载失败通过 Toast 报错。中文不模拟斜体。

实际渲染发现 `@pdf-lib/fontkit` 的 Source Han 子集输出会丢失部分复合字形轮廓，
虽然仍能提取文字，却显示空白。因此当前完整嵌入 CJK 字体；样本输出约 20 MB。
这与 BabelDOC 字体子集输出仍有明确差异，不能用「可搜索」代替字形可见性验收。

### 真实论文实验与迭代

沿用上表同一 SHA-256 的 Attention / ResNet；固定字体、BabelDOC commit 和 PDF 原件。
所有样本、原始 IR、译文、布局、渲染 PNG 和 Python 比较脚本位于仓库外
`/tmp/agentero-babeldoc-comparison`。可选测试入口 `test/pdf-reflow-real.test.ts`，
输入约定见测试文件；不把论文、字体、截图或第三方源码提交进 Git。

1. 固定中文译文：Attention 首页 3 个块、ResNet 首页 4 个块完成实际 PDF 导出和文字层检查。
2. 同语重排：Attention 第 3–6 页、ResNet 第 2–6 页覆盖正文、公式、图题、脚注和表格。
   同语测试验证提取与写出，不能代替翻译质量验收。
3. 真实 Google gtx 翻译：Attention 第 3–4 页选取 12 段、ResNet 第 3 页选取 12 段。
   两组各 12 段通过占位符校验及实际 PDF 导出。服务调用参数为 en → zh-CN、client=gtx；
   此实验不代表所有可配置 LLM / Agent 服务都经过端到端测试。
4. 同译文 BabelDOC 对照：保留上游自行提取的段落/公式对象，只向公式分组匹配的段落注入相同译文。
   Attention 6/12 段、ResNet 6/12 段可直接配对。其余段落因段落匹配、公式分组或富文本片段不同排除，
   不通过替换上游 IR 来掩盖差异。已渲染并人工查看两种输出。
5. 对比后修复：空格拆散数学表达式；普通斜体被过度保护；小角标附错行；CJK 字形空白；
   公式片段夹带整页隐藏原文；译文页预览提前 return；双语复制页的内部链接；
   中文句末标点被挤到独立行；粗体数学变量漏识别；高公式首行上沿越界。相应回归覆盖在 reflow 测试中。
6. 桌面 `pnpm tauri dev` 在运行；浏览器通过其 Vite 服务加载真实覆盖层组件验证，
   7 个译文段落可显示、选择层坐标有效、无暴露占位符、无页面脚本错误；工具栏双语菜单能触发对应导出回调。
   本环境没有可调用的桌面 computer-use 工具，原生保存对话框的完整交互尚未自动验证。

复现示例（先通过 `pdf-layout-arxiv.test.ts` 生成 `*-after.json`）：

```sh
AGENTERO_REFLOW_FIXTURES=/path/to/fixtures \
AGENTERO_REFLOW_FONT=/path/to/fonts/SourceHanSerifCN-Regular.ttf \
AGENTERO_REFLOW_PDFS=attention \
AGENTERO_REFLOW_PAGES=3,4 \
AGENTERO_REFLOW_MODE=identity \
pnpm exec vitest run test/pdf-reflow-real.test.ts
```

同目录需有六个字体文件；`fixed` 模式需要固定译文文件，`service` 模式需要已记录的按段落 id 索引的译文文件。
测试不自动调用收费服务。真实译文实验记录的是固定输入/输出，不将在线模型的不确定性混进常规测试。

### 未关闭的差异及可见影响

| 差异 | 当前实际影响 | 尚需验收 |
|---|---|---|
| 版面/段落模型不同 | 段落边界、图内文字、阅读顺序可能不同 | 更广样本的字符覆盖、段落匹配 |
| 公式分组不同 | 如 `LayerNorm(x + Sublayer(x))` 在本实现整体保护，上游拆分；ResNet 的函数表达式在本实现更倾向整体保护 | 更完整的字体分类、括号配对、公式语义与曲线/Form 关联 |
| 公式使用裁剪矢量片段 | 可保留复杂外观；复杂背景、越界曲线及非标准字体可能受裁剪影响 | 独立图形对象 IR 与复杂公式样本 |
| 排版不是逐行移植 | 同字体/同译文仍可能换行、基线、行距和缩放不同 | 跨栏/列表/密集长段落逐项比较 |
| 简单表格分格 | 合并单元格、跨行表头可能被分错 | 表结构重建及真实中文表格验证 |
| 仅文字层输入 | 扫描 PDF 无法走本链路 | OCR / 扫描检测与回退 |
| 旋转页 | 当前明确拒绝导出，避免输出坐标错误；未旋转的偏移 CropBox/MediaBox 已支持 | 旋转坐标转换及相应样本 |
| 字体完整嵌入 | 输出体积大；目前按中英论文字体配置 | 可靠子集化、更多语言与 RTL |
| 段落级选择/链接匹配 | 句对精度下降，无法匹配译文的原链接仍留原坐标 | 字符到译文跨度对齐，更多注释/命名目标测试 |
| 逐页预览 + 终局校正（#838） | 页内条目结束后生成单页预览；全文结束后校正，只重渲染变化页 | 字体嵌入/公式复用、可视页内存预算与端到端耗时 |

这些是剩余工作，不是可忽略的实现细节。当前已实现可运行的字符级翻译重排与导出链路，
但尚未达到「核心算法无差异」或「最终效果完全一致」。

自动检查：2338 项测试通过、7 项按环境跳过；TypeScript、依赖分层检查通过。Biome 无错误，有 7 项既有 warning 与 1 项 info（均在本次修改之外）。


## 全文端到端验收（2026-10-26，第三轮）

本节取代前两轮“只测选定段落”的验收范围。仍不代表算法等价。
全文输出与完整逐页差异报告存于本机 `~/Downloads/agentero-pdf-full-validation/`，PDF、截图及实验记录不进入 Git。

| 项目 | Attention | ResNet |
|---|---:|---:|
| 全部页数 | 15 | 12 |
| 完成翻译单元（含表格） | 245 | 350 |
| header 分类单元 | 27 | 22 |
| 翻译表格文字单元 | 72 | 163 |
| 保护公式岛（含部分引用，非公式总数） | 239 | 347 |
| 最小布局缩放 | 0.4 | 0.5 |

同一 Google gtx en→zh-CN 服务通过本机 HTTP adapter 供两边调用，缓存请求/译文。
Agentero 使用真实生产的可靠性包装、batching、token 校验、提取、排版和写出；仅 Host 网络传输被替换。
BabelDOC 使用本文件开头固定 commit 的原生非 LLM ILTranslator 路径，传入 `--translate-table-text`（该固定版本已忽略此选项，见下方源码复核）、
`--min-text-length 1`、`--no-auto-extract-glossary`，只替换翻译 adapter，不注入匹配段落、不替换其 IR。
未验证 LLM prompt、术语、不同翻译 provider 或原生保存对话框；不能用这轮结果代表这些能力。

标题「你所需要的就是注意力」「用于图像识别的深度残差学习」均已输出。
IR 段落/表格单元 ID 与翻译结果全量相等，无失败单元；所有布局 fits；输出27页逐页检查无保护占位符泄漏。
独立公式、数值/纯数学表格单元保留源矢量内容；图内文字不等于全部覆盖。fits 不是无碰撞或语义正确的证明。
已渲染并查看全部27页和上游对照接触表，重点检查两篇首页、Attention 第6/10/13/14页和 ResNet 第3/4页修复结果。

### 本轮迭代修复

- 全文测试取消短文本/页数采样；参考文献条目与标题加入翻译。
- 数字占位符被当作数值时使用非数字别名重试；仍破坏结构则按保护边界分段翻译，记录回退。
  Attention `6-0`、ResNet `0-2` / `3-1` 使用该回退；去掉回退片段的孤立句首标点，修复 ResNet 第4页整句英文回显。
- 重叠检测框按剩余字符重新锚定，移除无 IR 的重复项，修复 ResNet 第3页两级标题覆盖。
- 极小局部坐标字形不混入页面标题，修复 Attention 第13页乱码。
- 竖向字符占主导的误识别表格保留为图，修复 Attention 第14页图中文字被逐字重排。
- 表格按更小的水平间距分列；纯数学单元保持原文，避免拆断上下标。
- PDFium 删除源文字后只遮盖公式笔画；所有遮盖先于文字写出，修复整段清白擦断表格线和抹掉重叠标题。
- ResNet 第8页图没有 caption 是允许情况，移除“所有图必有 titleBbox”的过时 smoke 断言，仍检查存在的 titleBbox 包含关系。

### 未通过项 / 后续 TODO

- [x] 两篇全部页的翻译、导出和 BabelDOC 对照；标题/正文/公式/表格/参考文献纳入检查。
- [x] 全量单元与 IR 对应、页数保持、占位符完整性和框内适配检查。
- [ ] 图内标签、旋转文字、图形状态/XObject 与曲线关联；目前多处英文图例保留。
- [ ] 复杂表格结构：多层表头仍拥挤，小单元缩至40%/50%；部分短英文被 MT 原样返回。
- [ ] 作者姓名/模型名保护与语义质量；当前姓名被不恰当翻译，不能当作校译稿。
- [ ] 与 BabelDOC 等价的公式分组、段落/跨页上下文、排版扩框与缩放统计。
- [ ] 字体子集、扫描/旋转、原生桌面全操作及更多 provider 验收。

全文复现：先运行模型 smoke 生成 `attention-after.json` / `resnet-after.json`，输入目录放同版本 PDF，启动 HTTP adapter
（POST `{text}` 返回 `{text}`），随后：

```sh
AGENTERO_REFLOW_FIXTURES=/path/to/fixtures \
AGENTERO_REFLOW_FONT=/path/to/fonts/SourceHanSerifCN-Regular.ttf \
AGENTERO_REFLOW_PAGES=all AGENTERO_REFLOW_MODE=full \
AGENTERO_REFLOW_MT_ENDPOINT=http://127.0.0.1:18744 \
pnpm exec vitest run test/pdf-reflow-real.test.ts
```

独立保存的差异报告包含27页逐页记录、原件和输出 SHA-256、四份 PDF、实验 adapter、MT 缓存、IR/布局/状态及渲染接触表。
本轮全文用例2项通过；全量单测2340项通过后新增标题污染回归，相关52项通过；TypeScript 通过。
**结论：全文运行验收通过，完全等价验收不通过。** 本轮不能关闭 BabelDOC 等价目标。


## 全文差异的源码复核（2026-10-26）

复核本地固定 commit，且逐字节核对实际运行 venv 中的 translation_config、paragraph_finder、
styles_and_formulas、typesetting、il_translator、layout_helper 与参考 checkout 一致。
以下路径以上游 `babeldoc/format/pdf/` 为起点，比较对象为本项目 `86308f452`。

**纠正表格实验描述：** `translation_config.py:326` 无条件将 `table_model` 置空；
`docvision/table_detection/rapidocr.py` 为返回空框的兼容 stub。实际运行日志也报告 deprecated and ignored。
故传入 `--translate-table-text` 不代表启用了 RapidOCR，不能据此宣称上游具有完整合并单元格拓扑。
此前“开启表格检测”的表述不准确；PDF 对照产物仍有效，但应按实际生效路径解释。

| 环节 | 实际源码差异 | 对效果的因果关系 |
|---|---|---|
| 全页覆盖 | 上游 `document_il/midend/layout_parser.py:178` 从整页字符生成 fallback_line；`utils/layout_helper.py:650` 按标签优先级、交叠比例分配字符，允许 figure_text/table_cell/fallback_line。我们 `extract.ts:322` 从 selected items 入手，仅另扫 table | 未入选文字框、又不在表格内的图内标签不会被翻译；done=100% 的分母不含这些字符。上游也不保证所有图内文字都译 |
| IR | 上游 `il_version_1.py:627/982` 保存 xobj_id、vertical、advance、render_order，公式拥有字符/曲线/Form；我们 `types.ts` 只有字符索引/两种bbox/字体与颜色，公式是字符索引和矩形 | 缺少对象归属及绘制状态时，只能用几何猜测；不能等价处理局部坐标、背景或穿过公式框的非公式曲线 |
| 段落 | 上游 paragraph_finder 按 layout/XObject 分组，并用扫描碰撞直方图分行；我们中心入框、claimed先到先得、基准字聚行再附角标 | 两边的词序、段落边界和上下文不同，翻译输入在送模型前已不相同 |
| 表格 | 上游实际以布局/字符fallback和段落流程处理；我们在 `extract.ts:425` 按行及相邻字间距0.7em拆格，以文字紧框为固定排版框 | 字形占用范围不等于单元格可用范围；长中文被迫缩小。不能把此差异概括成“上游有完整表格结构、我们没有” |
| 公式 | 上游 styles_and_formulas 的字符状态机、邻字角标比例、逗号拆分、重叠合并、偏移及曲线/Form收集；我们按字体正则/Unicode/段落字号阈值及邻接传播 | 公式岛边界、baseline和占位数量不同。裁剪片段可保留样子，但没有真正恢复对象归属；扩大裁剪框也可能带入无关内容 |
| 翻译 | 上游 il_translator 按 composition 组装公式/样式占位并解析回结构；我们批次编号及额外别名/分段回退 | 同一服务面对不同文本及标记会产生不同输出；结构校验通过只证明标记契约，不证明人名、术语、句子全部正确 |
| 局部排版 | 上游 typesetting:1300 以排版单元高度众数定初始Y，首行缩进为4个半中文空格；我们 layout:121 从regular字体ascent起排，使用提取缩进并限制到框宽30% | 字号相同也会基线、缩进不同，后续行高差逐行累积 |
| 扩框与缩放 | 两边都离散缩放，但上游扩框后有重置/重试逻辑；我们只在65%/60%尝试下/右扩框，fixedBox禁止扩框 | 类似策略不等于相同搜索顺序；表格易缩小，部分段落多换一行便触发下一档缩放 |
| 全文缩放 | 上游 typesetting:865 对所有段落按排版单元数加公式字符数加权，并列众数取最小；我们 layout:350 排除heading及<100字符段，按源字符数加权，并列取最大 | 标题、小段落、正文的最终字号可以系统性不同，不能仅通过调整一个行距参数对齐 |
| 导出 | 上游对字符/曲线/Form重定位并写内容流、字体子集；我们PDFium删字+局部覆盖+pdf-lib嵌入公式片段，CJK完整嵌入 | 文件体积、复杂背景、对象层级及可选择文本不保证一致 |

LLM 标题上下文/术语路径存在于上游源码，但本轮运行的是非 LLM 路径，不能拿未启用能力解释这轮实测差异。
关于上游表3少数数值缺失的现象，当前没有定位到首个丢失阶段，不将其武断归因于 MT 或表格检测。

后续应先补全页字符覆盖账本（每个字符明确归为翻译、数学保留、图形保留或未处理），再补充对象/坐标表示、表格可用空间和公式归属。
随后用固定译文隔离排版差异，再做真实翻译测评；否则版面、翻译、排版三类变量同时变化，难以判断修复是否对因。


## 字符覆盖与变换补全（2026-10-26，第四轮）

实际实现与全文复验，覆盖第三轮源码复核中部分未关闭项。输出及报告保存在
`~/Downloads/agentero-pdf-full-validation/round-4/`，不覆盖前轮 PDF。

- PDFium 引擎补丁的 ESM/CJS 和浏览器内嵌 worker 均增加字符文本矩阵、旋转角、文本对象标识、绘制模式及局部裁剪框。
  文本对象标识仅对当前文档实例有效，未把它当作持久 ID。字号应用文本矩阵缩放，修复图内局部字号1导致标签拆散。
- 在参与翻译的页面上，对检测框以外的字符按文本对象和空间行生成 fallback。保留现有“只翻译本页”的页面选择范围。
  同一对象内的下伸字符不再被拆到另一行；真实 ResNet `weight layer` 回归已覆盖。
- 每个非空白字符有审计归类：translated/formula/table/excluded/rotated/nonpainting/clipped/unresolved。
  translated 是进入翻译 IR，不是译文正确率；未决项保留为 unresolved，不通过改分类掩盖。
- 原页渲染辅助检查变换文字是否有相应颜色像素，避免补漏把隐藏文字重画出来。
  标题内冲突变换按主要变换分组；带局部裁剪的变换文字暂保留原样。
  **这些是保守启发式，不是完整 XObject 祖先裁剪或任意背景下的可见性模型。**
- 表格增加独立 layoutBox：源文字删除框不变，排版可使用到下一格前的空白，并受邻行段落约束。
- 全文缩放统计纳入标题/短段落，按输出字符和公式字符加权，并列众数取较小值；其它基线、扩框和断行仍有差异。

| 指标 | Attention | ResNet |
|---|---:|---:|
| 全文页数 | 15 | 12 |
| 翻译单元 | 247 | 558 |
| fallback 单元 | 2 | 206 |
| 表格文字单元 | 72 | 165 |
| 相对第三轮字号增大的同 ID 单元 | 43 | 131 |
| 最小缩放 | 0.7 | 0.5 |
| 未决字符 | 9 | 515 |

Attention 的未决字符为独立公式编号；ResNet 未决项主要为图内数字、结构表达式与数值，但尚未逐项证明都可忽略。
Attention 第4页图内标题、ResNet 第2页结构图标签以及第5/8页曲线图部分文字现在翻译；第11页密集表格表头也进入翻译。
新增图内文字并不代表所有图形标签已覆盖；仍保留旋转标签及部分裁剪内容。

新增回归：全页IR字符归属不重复、非空白字符实际矩阵、Attention 可视化标题完整及不重绘 Input Input Layer5 隐藏文字、
ResNet weight layer 完整提取、独立图标签不跨空间合并、隐藏/普通数学字符区分。整篇18秒复跑2项通过；
全量2346项通过、7项环境跳过；TypeScript、依赖分层通过，Biome无错误（7 warning/1 info为既有）。
浏览器内嵌 worker 两种发行格式解析通过；原生 PDFium 完整导出和27页渲染查看通过。原生保存对话框未重复验收。
引擎 patch-commit 的重新解析遇到 registry 缺包；仅同步补丁 SHA-256 到锁文件，随后 frozen-lockfile/offline 安装验证通过，未升级依赖版本。

后续仍需：对象祖先变换/裁剪与曲线绑定、合并单元格拓扑、严格的数学内容一致性比较、全文译名/术语质量、更多复杂 PDF。
当前属于效果改进，不能标记核心算法等价目标完成。


## 与 main 的全文对照（2026-10-26）

基线为远端 main `794c06bfc`，功能分支已合入该提交（`f97525d32`）。采用同一 Attention 15页、ResNet 12页 PDF、同一检测结果及 Google gtx 翻译适配器。main 重新执行其翻译流程，使用实际 LayoutTranslateOverlay 组件及项目样式截图；功能分支使用第四轮全文导出 PDF。两侧输出按相同页面尺寸呈现。翻译分段和公式占位方式不同，因此并非相同译文的纯排版对照；main 为 DOM，分支为 PDF，也不能用像素差作为准确率。

27页均生成前后对照，main 渲染无页面脚本错误；通过全页缩略图检查整体结构，并放大检查标题、公式、表格代表页。没有将机器翻译单元数量当作译文准确率，也没有完成每个字符的人工校对。

| 项目 | main | 本分支及观察 |
|---|---|---|
| 标题 | 已翻译 | 同样翻译；Attention 第1页粗体及红色声明更接近原稿 |
| 正文 | DOM 文本覆盖，数学表达式容易变成普通字符串 | 字符级重排；Attention 第4页行内下标、根号、分数更完整，断行也不同 |
| 独立公式 | 原页公式可保留 | 仍保留；不能把原有独立公式展示说成新增功能 |
| 表格 | 两篇样例表格主体通常保留英文 | ResNet 第5页等表头、行标签翻译，数字及表格线仍在；conv 等术语存在误译 |
| 图内文字 | 样例图内标签通常为英文 | Attention 第4页两个图标题、ResNet 部分图例进入翻译；旋转/裁剪标签仍有遗漏 |
| 参考文献 | 样例参考文献主要保持英文 | 增加翻译覆盖，但人名、论文名翻译质量需继续改进 |
| 输出 | 阅读器内译文覆盖层 | 增加单语/双语 PDF 导出；这次对照使用单语成品 |
| 翻译单元 | Attention 135 / ResNet 169 | Attention 247 / ResNet 558；包含表格、补漏及参考文献，粒度不同不可直接算提升百分比 |

新版也存在可见不足：Attention 第1页作者区出现方框字形，姓名/机构翻译与换行仍不理想；密集表格和小字号内容仍需优化；部分图中短标签与旋转文字保持英文。新增覆盖不等于每处都更好。复杂裁剪、公式曲线归属及合并单元格能力仍未与 BabelDOC 等价。当前应作为 Draft PR 审阅。

对照材料存于本机 Downloads/agentero-pdf-full-validation/main-comparison：27张双栏对照、两张全文联系表、Attention 第4页切换 GIF、main DOM 审计及复现脚本。媒体不提交仓库，仅上传 PR 评论。完整新版 PDF 位于同级 round-4 目录。main 本身没有相应译文 PDF 导出，因此未把截图包装成 main 导出 PDF。

合并 main 后验证：TypeScript 通过，全量测试 2372通过/7跳过；桌面应用编译并启动。依赖分层检查失败于 `src/lib/tex/editor-lint-bridge.ts → src/components/viewer/text-editor-lint-footer.tsx`，在独立 main 工作树运行相同 depcruise 也得到同一错误，属于基线已有问题。本轮未改动翻译算法，仅补充 main 对照记录。


## 延迟跟进（2026-10-27）

- 已优化结构回退请求：跳过相同占位重试，保护边界间文字按现有预算组批；结构校验和编号失败的逐片段回退保留。
- 确定性回归：两个文字片段的回退从 5 次调用降为 3 次；编号损坏时为 5 次。没有真实服务的端到端提速结论。
- #838 已加入提取、字体、首批译文、页级/终局构建、预览渲染日志和逐页预览。TODO：实测同文档/同服务的阶段占比与回退命中率；继续调查逐公式 PDF 克隆及重复字体嵌入开销。
- 此项不改变上述覆盖与算法等价路线，也不把已有整篇验证用时当成用户真实服务延迟。


## 翻译构建专用 PDFium 引擎（2026-10-27，#838 / #798）

重排构建（prepare 字符提取、逐页预览、终局导出）每页要向 PDFium 发几十个串行 RPC（extractPages、逐公式 redact、saveAsCopy、预览渲染），此前全部排在 viewer 引擎的同一条 FIFO 上，翻译流式期间滚动瓦片被构建请求压住（#798 的队列饥饿）。

- `ReflowBuildEngine`（`src/lib/pdf/reflow/builder.ts`）为构建提供专用引擎：懒创建（首个任务时 `saveAsCopy` 源文档 → 起一个 worker 引擎 → `openDocumentBuffer` 私有副本），构建与预览渲染都走专用引擎；worker 不可用或返回 direct 引擎时永久回退共享引擎（行为等同改动前），且绝不销毁共享引擎。
- `ReflowPreviewSession` 持有 provider（测试可注入）：页任务、终局任务与 `prepare()` 都经 `obtainBuild()` 取目标；`prepareReflowItems` 的整篇字符提取同样移出 viewer 队列。
- 生命周期：队列排空后 30s 无新任务即释放专用引擎（约 25–35 MB：worker 线性内存 + 文档副本），重启翻译或文档关闭时按需重建；`dispose()` 立即释放。

**基准（`test/pdf-reflow-engine-bench.test.ts`，11 页 / 57 公式区域的 arXiv 论文，worker_threads 复刻应用架构：PDFium 在 worker FIFO、pdf-lib 留主线程、100ms 一次滚动瓦片）**：

| 场景 | 瓦片 p50 | p95 | max | 构建 |
|---|---|---|---|---|
| 仅瓦片 | 7ms | 12ms | 12ms | — |
| 共享引擎（改前） | 8ms | 285ms | 385ms | 42.3s |
| 专用引擎（改后） | 5ms | 38ms | 3224ms | 41.3s |

p95 降约 7.5 倍且构建吞吐不降；残留的偶发秒级瓦片延迟来自 pdf-lib 主线程同步拷贝（见剩余项），与队列饥饿无关。运行方式：`AGENTERO_BENCH_PDF=<pdf> AGENTERO_BENCH_LAYOUT=<layout.json> pnpm vitest run test/pdf-reflow-engine-bench.test.ts`（默认用系统字体；`AGENTERO_BENCH_FONTS_DIR` 可指定 Noto/SourceHan 目录，`AGENTERO_BENCH_PAGES` 过滤页）。

验证：`test/pdf-reflow-build-engine.test.ts` 覆盖懒创建、idle 释放、worker 失败回退（共享引擎永不销毁）、direct 引擎拒绝、dispose 竞态；`test/pdf-reflow-preview.test.ts` 增加构建路由与 idle 释放用例。

## 翻译流式渲染开销收敛（2026-10-27）

翻译进行中滚动卡顿（#770 / #798 / #838 后续）的三处收敛：

- **字体解析缓存**：pdf-lib 每次 `embedFont` 都会重新 `fontkit.create` 完整解析字体字节；页级预览每页都重嵌 CJK 字体对（`subset: false`，约 20 MB/字重），解析在主线程重复执行。`embedReflowFonts` 改为注册带 WeakMap 缓存的 fontkit 包装（键为 `loadReflowFonts()` 返回的稳定字节实例），跨构建共享解析结果。字体**写出**（save 序列化 + 传给 PDFium worker）仍按页重复，见剩余项。
- **批次 publish 合帧**：`runLayoutRegionTranslate` 每批 settle 一次 `onUpdate`，每次都整体替换 items 状态并让所有挂载页重渲染。`use-pdf-layout-translate` 把中间 publish 合并到一帧一次（rAF；无 rAF 的宿主退化 setTimeout，再退化为同步直通）；终局/失败路径 `cancel()` 丢弃仍在排队的合并项，晚到的陈旧 flush 由 `signal.aborted` 挡住。
- **预览会话按需通知**：`ReflowPreviewSession.update()` 每批都会 `changed()` 触发一次全量 re-decorate；改为 dirty 门控，仅在预览发布/吊销、busy 翻转或导出产出变化时通知。页签名的 regions 部分从「每批全量 JSON.stringify 该页 regions」改为对象身份号（regions 数组按 WeakMap 缓存分页分组，调用方 `regions ?? NO_REGIONS` 保持数组身份稳定）。

验证：2394 项测试通过（含 `pdf-layout-translate-lifecycle` 的合并/取消/迟到结果语义）；TypeScript、Biome、`pnpm build` 通过。单页构建的端到端提速仍待真实服务实测（用 `pdf.reflow.page` / `pdf.reflow.fonts` 阶段日志对比）。

剩余项：`pdf.save()` 字体字节逐页重复拷贝与 worker 传输（需输出容器级缓存）、逐公式 PDF 克隆、长文档预览内存、整篇分析门槛。


## 逐页重排预览（2026-10-27，#838）

- 翻译状态与预览缓存分离；按页签名去重，串行执行，仅取消输入已变的页。
- `buildReflowPage` 从原件提取单页，复用完整构建逻辑；单页 PDF 的页号为 0，返回布局仍使用原页号。
- 增量阶段使用局部字号，终局仍执行全文 common scale。未变化页复用 URL；导出只使用终局完整字节。
- 自动重试结束的 error/skipped 条目保留原文，其 IR 作为障碍物；取消/关闭后旧异步任务不能恢复预览。
- 字体提前加载；保留完整 CJK 嵌入以避免已有子集化缺字问题。字体嵌入对象不能直接跨 PDF 复用。
- 显示路径与原文页一致：流式阶段用单页栅格占位；终局后把译文 PDF 以隐藏文档（`autoActivate: false`）注册进 document manager，译文页交给与原文页相同的 `AgenteroRenderLayer`，按“页面 CSS 宽度 / 页面 point 宽度”和设备像素比渲染，缩放/DPR 变化时自动重渲，不再拉伸固定图片。

验证入口：`test/pdf-reflow-preview.test.ts` 覆盖逐页可见性、批次隔离、取消、失败和终局去重；
`test/pdf-reflow-real.test.ts` 设置 `AGENTERO_REFLOW_INCREMENTAL=1` 后额外比较单页 PDF 与
完整文档路径对应页的布局、像素，且验证输出仅一页。使用原有外部 fixture/font 环境变量，
配合 `AGENTERO_REFLOW_MODE=identity AGENTERO_REFLOW_PAGES=4` 覆盖非首页与公式。
计时输出写到外部 fixture 目录 `*-incremental-timing.json`，不能把单页构建对比当作端到端翻译提速比例。

剩余项：整篇分析/字符提取门槛、字体写出主线程开销、逐公式克隆、长文档预览内存；
根据新增阶段日志再决定 Worker、缓存或可视页淘汰，不在本次改变翻译请求与重试策略。

### 偏移页面边界回归

未旋转页面以 CropBox 与 MediaBox 的交集为可见区域，复用引用定位的边界计算。
重排写出时为文字、公式覆盖/裁剪/放置和链接区域补偿原点偏移，原始页面边界不变。
公式片段使用自身页面的可见区域；逐页预览与最终导出共用此逻辑。

`test/pdf-reflow-crop.test.ts` 自动生成两份样例：正向 CropBox 偏移；负向 MediaBox
且 CropBox 超出纸张。真实 PDFium 验证两者与零偏移基准的渲染逐像素一致，
并检查译文、公式文字、链接区域及原始页面边界。使用固定英文替换文本隔离坐标问题，
不依赖翻译服务。字体可使用任意支持样例拉丁字符的 TTF：

```bash
AGENTERO_REFLOW_FONT=/path/to/font.ttf \
AGENTERO_REFLOW_CROP_OUTPUT=/tmp/agentero-reflow-crop \
pnpm exec vitest run test/pdf-reflow-crop.test.ts
```

输出目录可选，生成的输入/输出 PDF 不进入仓库。旋转页面仍保留拒绝导出的保护。
