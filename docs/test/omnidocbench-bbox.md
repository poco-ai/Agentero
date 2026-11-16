# OmniDocBench bbox 融合评测

此工具复用 OmniDocBench 的人工区域及关联标注，对同一批模型检测结果反复运行 Agentero 的启发式融合，比较融合前后的裁剪框。评测独立于桌面 UI，不调用模型 API、不把人工图注文字注入检测结果。

## 与 MinerU-Popo 的关系

参考 [MinerU-Popo 的标准块结构](https://github.com/opendatalab/MinerU-Popo/blob/master/post_processing/label_normalization.py)和 [image association 候选筛选与推理流程](https://github.com/opendatalab/MinerU-Popo/blob/master/post_processing/inference.py)，使用以下结构：

```text
页面检测 / 已有 OCR
  → NormalizedBlock 标准块
  → 启发式关联后端（替代 VLM 推理）
  → 图 / 表分组、caption src → host tgt、融合 bbox
  → 与人工真值比较
```

`pipeline.ts` 使用上游 `block_id/page/bbox/type/content/order/popo_type/source_label/meta` 字段命名；明确约定 bbox 是 **0–1 相对 xyxy**，页码从 0 开始，`meta` 保存 Agentero 类型、分数和 caption 角色。它是本项目的接口适配，不宣称能直接读取上游全部格式，也不使用推理 prompt 的 yxyx / 1000 坐标。

相对坐标按页宽 / 高缩放，不代表所有预测都严格落在页面内。产品现有检测归一化分别限制 x/y/w/h，部分右下角仍可能越界；回放保持这些预测不变，不偷偷裁切它们以改变融合行为。倒置或非有限框会拒绝；人工真值的越界仍按下方规则单独审计。

启发式后端直接复用 `mergeCaptionsIntoHosts` 和 `dedupeLayoutRegions`，没有复制另一套融合逻辑。普通正文作为几何阻断保留，不能照搬上游为压缩 VLM prompt 而剔除正文的策略。当前只覆盖图 / 表的分组、图注关联和裁剪，不实现 Popo 的标题层级、段落续接与跨页表格重建。关联输出连接原始块 ID；融合对象另有独立 ID。成员列表按输出框包含关系重建，仅用于诊断，不冒充算法逐步决策轨迹。

没有复制上游代码或引入 VLM 运行时；可选的离线 OCR 捕获脚本单独使用 Python，不进入桌面应用依赖。上游项目采用 MIT 许可。本工具的 bbox 指标不是 Popo 的标题 TEDS，二者分数不可直接比较。

## 数据与真值

维护者准备本地 `OmniDocBench.json`。本轮核对的官方数据版本为 [aa1ee96](https://huggingface.co/datasets/opendatalab/OmniDocBench/tree/aa1ee96)，实际 JSON 的 SHA-256 写入清单。所有下载数据、模型快照、报告和图片放在已忽略的 `tmp/`，不进入 Git 历史。

转换规则：

- 默认筛选 `academic_literature`，约 80% 正样本页与 20% 无目标负样本页，固定种子排序；不足时以其他可用页补齐。
- 读取四边形的轴对齐外接框；坐标越界、重复 ID、悬空关联等按页排除并记录原因，不静默夹紧坏标注。
- 同时兼容数字 / 字符串 ID，以及 `relation` / `relation_type` 字段。
- 只按明确的 `parent_son` 关联聚合同类 figure / table 片段，并加入相关主图注；图注关联缺失或有歧义时不猜测。此类对象列入忽略区域并在报告中记录，不算已确认的无图注对象。
- 目标 crop 为同页图本体与已关联图注的外接矩形。完整页和关系适配的是裁剪评测，不自动声称具备所有语义子图标签。
- 源论文名可从 `*.pdf_页码.jpg` 推断；也支持 `--document-map`，JSON 格式为 `{ "页面文件名": "同源论文ID" }`。同一论文按固定哈希整体划入 dev 或 test。UUID 文件名没有论文身份时只进入 dev，不能把不同 UUID 擅自当作独立论文用于测试。
- 页面独立检测，快照中的本地页码固定为 0；本轮不评价跨页图注。

## 运行

需要 Node 24 和项目已安装依赖。下面命令均在仓库根目录运行；它们不会进入默认 CI。

```powershell
# 1. 固定首批20页，输出数据来源、划分、真值和排除原因
node scripts/omnidocbench-bbox/run.mjs prepare --gt tmp/omnidocbench/OmniDocBench.json --out tmp/omnidocbench/manifest.json --limit 20

# 2. 仅下载清单中的页面，默认固定到 aa1ee96；Windows 使用系统 PowerShell 网络能力
node scripts/omnidocbench-bbox/run.mjs download --manifest tmp/omnidocbench/manifest.json --images tmp/omnidocbench/images

# 3. 传入本机已有模型，记录模型与图像哈希，冻结检测结果
node scripts/omnidocbench-bbox/run.mjs capture --manifest tmp/omnidocbench/manifest.json --images tmp/omnidocbench/images --model "C:/path/to/pp-doclayoutv3.onnx" --out tmp/omnidocbench/snapshot.json

# 4. 改规则前后反复回放同一快照。带 --images 时另外生成绿真值 / 红预测的前后叠加图
node scripts/omnidocbench-bbox/run.mjs evaluate --manifest tmp/omnidocbench/manifest.json --snapshot tmp/omnidocbench/snapshot.json --images tmp/omnidocbench/images --out tmp/omnidocbench/report --split dev
```

`capture` 不覆盖已有快照；新模型或新预处理使用不同输出文件。自动图像下载只接受固定 commit；使用其他数据版本时为 prepare / download 同时传入对应 `--revision`。评测会拒绝清单哈希不符、缺页或重复页的快照；绘图时还会校验图像哈希。

当前 capture 从页面图像提取检测框，**没有 PDF 文字层，也没有额外 OCR**，所以输入模式明确标为 `detector-only-no-text`。它测的是几何回放基线，不等同于桌面中经过文字提取、图注恢复后的完整流水线。可按下方流程使用独立 OCR 补充文字并冻结另一份输入，不能从人工真值拷贝文字提高成绩。

### 可选：冻结独立 OCR 文字

OmniDocBench 只有页面图像，使用 [RapidOCR](https://github.com/RapidAI/RapidOCR) 的 CPU ONNX 实现补充真实识别文字，复用产品已有的文字抽取、图注恢复和融合。首次运行会安装固定版本依赖，后续无需模型 API。该脚本只在评测时运行，不给桌面端新增 Python 依赖。

```powershell
uv run --with rapidocr-onnxruntime==1.4.4 python scripts/omnidocbench-bbox/ocr.py --manifest tmp/omnidocbench/manifest.json --images tmp/omnidocbench/images --out tmp/omnidocbench/ocr.json
node scripts/omnidocbench-bbox/run.mjs enrich --manifest tmp/omnidocbench/manifest.json --snapshot tmp/omnidocbench/snapshot.json --ocr tmp/omnidocbench/ocr.json --out tmp/omnidocbench/snapshot-ocr.json
node scripts/omnidocbench-bbox/run.mjs evaluate --manifest tmp/omnidocbench/manifest.json --snapshot tmp/omnidocbench/snapshot-ocr.json --out tmp/omnidocbench/report-ocr --split dev
```

`ocr.py` 只读取清单中的页面文件名与图像；`enrich` 使用页面尺寸，不读取人工文字、框或关联。OCR 分数至少 0.5 才进入文字流程；非法分数 / 四边形、清单或图片哈希不一致、缺页 / 重复页均拒绝。OCR 和补文字后的快照均拒绝覆盖，后者记录原检测快照、OCR 文件哈希和 OCR 引擎版本，输入模式为 `detector-plus-ocr`。OCR 行没有 PDF 字符序，不伪造字符索引，因此不能据此恢复跨栏续文。

纯检测与 OCR 输入的成绩分开报告；验证融合规则收益时须固定同一份补文字快照。OCR 可恢复漏检图注，不能代替对漏检图本体或模型误分类的修复。

## 指标与报告

`report.json` 保留每页 GT、融合前后预测、匹配、FP/FN、忽略计数和关联诊断；`report.md` 给出总分与逐页错误数量；`overlays.md` 和对应 SVG 展示前后框。报告不写回论文或侧栏缓存。

对相同类型进行一对一最大匹配，分别报告 IoU 0.5 / 0.8 的 Precision、Recall、F1 和 TP / FP / FN。重复预测算 FP，漏检算 FN；无目标页也参与误检统计。没有样本的比率写为 null，不伪装成 100%。融合前基线也经过同样的置信度、面积和 NMS 过滤。与明确计分对象的 IoU 已达 0.5 时优先计分，否则与忽略区域 IoU 达 0.5 的预测不计分。

这些是**裁剪框检测指标**，不等于直接衡量图注关联或每个子图的分组正确率。调参只看 dev；test 仅用于方案确定后的验收。当前小样本不代表所有论文版式，选样和排除情况应与分数一起解释。

### 首次开发集基线

2026-11-16 使用上述固定数据版本与默认种子抽取 20 页（29 个可计分目标），其中 dev 17 页 / 26 个目标，test 3 页保留；2 页来源不明的 UUID 页面只在 dev。数据转换另排除 4 个坐标或关联异常的学术页面。输入为本机已有 PP-DocLayoutV3 的纯检测框，未使用人工文字，也未修改产品融合阈值。

| 条件 | Precision | Recall | F1 |
| --- | ---: | ---: | ---: |
| 不融合，IoU 0.5 | 0.656 | 0.808 | 0.724 |
| 现有融合，IoU 0.5 | 0.852 | 0.885 | 0.868 |
| 不融合，IoU 0.8 | 0.313 | 0.385 | 0.345 |
| 现有融合，IoU 0.8 | 0.593 | 0.615 | 0.604 |

这是现有算法相对于不融合的收益，不是本次阈值优化的收益。严格阈值下仍有 11 FP / 10 FN，后续应先看错误图，区分原始检测框偏大、错误关联与错误联图，再改变规则。

### 基于开发集的首轮修复

在相同清单、检测快照和计分规则下修复两个可解释问题，不按页面、论文名或真值坐标增加特例：

1. 未分类 header 不再直接作为主图注；真实图注被标成 header 时，已有文字角色识别仍允许恢复。避免页眉、章节标题扩大图 / 表裁剪框。
2. 无文字的通用 `figure_title` 不再仅凭宽度锁定为图题；比较图、表、算法在各自常见贴题方向的候选分数。表 / 算法候选领先另一宿主族至少 0.2 才改判，歧义时保留原图题兜底，明确文字语义始终优先。

该处理与 [PDFFigures2 的 caption 候选过滤](https://github.com/allenai/pdffigures2/blob/master/src/main/scala/org/allenai/pdffigures2/CaptionDetector.scala)中验证图注身份的思路一致；实现复用本项目既有角色识别和贴题评分，不引入其 PDFBox / Scala 依赖。

| 集合 / 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| dev 17 页 / 26 目标，F1 @ IoU 0.5 | 0.868 | 0.868 |
| dev 17 页 / 26 目标，F1 @ IoU 0.8 | 0.604 | 0.755 |
| dev TP / FP / FN @ IoU 0.8 | 16 / 11 / 10 | 20 / 7 / 6 |
| 保留 test 3 页 / 3 目标，F1 @ IoU 0.8 | 1.000 | 1.000 |

测试集只在候选确定后核验，未用于调参；3 个目标过少，不能把这个 1.000 当作泛化准确率。以上仍是无文字层的几何回放成绩，未改变评测定义、检测阈值或人工标注。尚存错误包括图注未检出、整图误标以及图本体碎片 / 边界缺失；这些应与关联错误区分，不能靠盲目扩大 bbox 消除。

### 第二轮：文字恢复与完整图保护

2026-11-16 将固定选样扩大到 40 页 / 52 目标：dev 31 页 / 43 目标，test 9 页 / 9 目标，来源不明的 5 个 UUID 页均仅用于 dev。新增 20 页使用同样种子排序与源论文划分，包含 14 个 dev 页和 6 个此前未查看的 test 页；复用原始 20 页快照，新增页面另行冻结。**这是页面数，不是论文数。**

改动包括：编号后无分隔符 / OCR 缺空格的主图注识别、仅对明确编号的近距离侧边图注开放关联、避免大块 header 双标删除图、未配图注时在置信度接近的嵌套框中保留完整图。文字行聚合也收紧双栏间隔，避免把相邻栏的致谢拼入图注。没有按页面名、真值坐标增加特例，没有改变评测 IoU 或人工标注。

以首轮提交 `61356292f` 为旧算法，旧融合模块保留旧的 `figureCaptionKey` 实现，对同一份冻结 OCR 标准块回放：

| 集合 / 输入 | 旧 F1 @0.8 | 新 F1 @0.8 | 旧 TP / FP / FN | 新 TP / FP / FN |
| --- | ---: | ---: | --- | --- |
| 原 dev 17 页 / 26 目标，独立 OCR | 0.755 | 0.962 | 20 / 7 / 6 | 25 / 1 / 1 |
| 新增 dev 14 页 / 17 目标，独立 OCR | 0.824 | 0.882 | 14 / 3 / 3 | 15 / 2 / 2 |
| 合计 dev 31 页 / 43 目标，独立 OCR | 0.782 | 0.930 | 34 / 10 / 9 | 40 / 3 / 3 |
| 新增 test 6 页 / 6 目标，独立 OCR | 0.667 | 0.667 | 5 / 4 / 1 | 5 / 4 / 1 |
| 原 test 3 页 / 3 目标，独立 OCR | 1.000 | 1.000 | 3 / 0 / 0 | 3 / 0 / 0 |

纯检测输入合计 dev 的严格 F1 **仍为 0.782**；IoU 0.5 的 F1 从 0.920 升至 0.966。不能把带 OCR 的 0.930 描述成纯几何算法准确率。旧规则即使接入同一 OCR，严格成绩仍为 0.782；本轮收益依赖文字身份识别与几何规则共同生效。

新增 test 在候选固定后验收，没有继续据此调参。其失败页仍将同一张免疫印迹组合图拆成多个高置信图框（4 FP / 1 FN）；开发集还存在图内表格误分类、跨栏图注缺失和边界不全。侧边图注示例虽然通过 IoU 0.8，右侧图例仍未纳入，说明该指标不保证视觉内容完全无缺。新增 test 的 0.667 说明泛化问题尚未解决，不能用 dev 的 0.930 宣称所有论文已达到该水平。下一轮必须另留未查看的论文页作验收，优先处理多面板分组证据，而非盲目扩大 bbox。

## 本地验证

```powershell
pnpm exec tsc -p scripts/omnidocbench-bbox/tsconfig.json
pnpm exec vitest run test/pdf-layout-merge-captions.test.ts test/pdf-layout-dedupe.test.ts
```

针对转换器和标准化后端的临时测试覆盖 ID / 关联兼容、图组与图注并集、非法坐标、未知论文的 dev-only 划分、一对一匹配、重复预测、漏检、关联 ID 和反向框拒绝。按项目规则，这些新增单元测试只作本地验证，不提交仓库。
