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

没有复制上游代码或引入 Python / VLM 运行时；上游项目采用 MIT 许可。本工具的 bbox 指标不是 Popo 的标题 TEDS，二者分数不可直接比较。

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

当前 capture 从页面图像提取检测框，**没有 PDF 文字层，也没有额外 OCR**，所以输入模式明确标为 `detector-only-no-text`。它测的是几何回放基线，不等同于桌面中经过文字提取、图注恢复后的完整流水线。以后接真实 OCR 应在 capture / 标准化阶段补充模型产生的文字并重新冻结，不能从人工真值拷贝文字提高成绩。

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

## 本地验证

```powershell
pnpm exec tsc -p scripts/omnidocbench-bbox/tsconfig.json
pnpm exec vitest run test/pdf-layout-merge-captions.test.ts test/pdf-layout-dedupe.test.ts
```

针对转换器和标准化后端的临时测试覆盖 ID / 关联兼容、图组与图注并集、非法坐标、未知论文的 dev-only 划分、一对一匹配、重复预测、漏检、关联 ID 和反向框拒绝。按项目规则，这些新增单元测试只作本地验证，不提交仓库。
