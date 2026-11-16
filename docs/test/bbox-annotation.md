# BBox 标注与教学样例

先看真实页面的完整答案，再独立标注。工具是离线单 HTML，页面图像、标注界面和教学答案均内嵌；标注员不需要 Node、服务器或账号。生成文件、原始 PDF、图片与导出稿放在仓库的 `tmp/` 或仓库外，不提交媒体。

## 第一份示范

论文：**An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale**，[arXiv:2010.11929v2](https://arxiv.org/pdf/2010.11929v2)，第 9 页 Figure 7。此页只有一个范围内目标对象，已完整标注该对象。它是教学样例，未经过另一人独立复核，不冒充正式 benchmark gold；其他页面尚未标注。

| 标注 | 数量 | 边界与理由 |
| --- | --- | --- |
| 图本体，蓝框 | 1 | 包含三个子图、内部标题、坐标轴、色条与图例，不含主图注 |
| 子图，绿框 | 3 | 图注的 Left / Center / Right 是三个语义单位；左侧滤波器拼图不拆成 28 个，中央热图也不逐格拆分 |
| 主图注，橙框 | 1 | 从 Figure 7 开始到 details. 结束，包含完整五行，排除更下方正文 |
| 最终裁剪，黑虚线 | 自动生成 | 图本体与同页主图注的最小外接矩形；不是第四种要手画的真值框 |

先点「看完整答案」，再依次点「图本体 → 三个子图 → 主图注 → 最终裁剪框」。可以直接拖动修改，用「恢复示范答案」返回初始答案；该操作也支持撤销。

## 生成可交接的工具

维护者需要 Node 24 与仓库已有依赖。先将上面的固定版本 PDF 下载到 `tmp/bbox-pilot/vit-v2.pdf`，再执行：

```powershell
node scripts/bbox-annotator/prepare.mjs --pdf tmp/bbox-pilot/vit-v2.pdf --pages 9 --title "ViT Figure 7 标注示范" --source "https://arxiv.org/pdf/2010.11929v2" --example scripts/bbox-annotator/examples/vit-page9.json --out tmp/bbox-pilot/ViT-demo.html
```

`--example` 会检查 PDF SHA-256、页面范围、规则版本与标注完整性，防止换版本后错套坐标。省略它可生成空白标注任务；`--pages` 为从 1 开始的逗号分隔页码，省略则包含全文。输出包括一个 HTML 与不含图像的 manifest。标注 JSON 中页码从 0 开始，bbox 为左上角原点、0–1 页相对 `x/y/w/h`。对旋转 PDF，坐标以打包后实际显示的页面为准；接入原始 PDF 坐标前需应用对应页面旋转变换。

打开 HTML 后画框；选择模式移动选框，四角调整尺寸，方向键微调。跨页图注保持同一对象选中，切页画图注框；派生 crop 只合并同页图注，异页图注片段单独保留。工具范围为插图、表格和算法，v1 不包含公式或跨页图本体。

## 规则和多人交接

完整十条规则内置于界面，使用 `react-i18next` 提供独立工具的中英文资源。必须完整标注所有选中评估页的目标，逐页标为「已标全」或「无目标」。提交检查覆盖缺图本体、缺图注、子图越界、重复编号、未检查页与未解决争议；它无法代替人工确认目标是否遗漏。

先由至少两人独立标同一页，统一子图语义粒度和边界，再分配其他论文。各人保留独立 JSON，复核员用「对照另一份标注」查看紫色只读框，人工仲裁后记录说明。不能简单平均坐标替代仲裁。导入会校验 PDF、任务与页集合，不兼容文件拒绝替换当前草稿。

交接发送 HTML 加 JSON；标注稿不包含图像。浏览器草稿依赖浏览器与本地文件权限，不能替代导出备份。支持草稿、待复核、已复核三种导出；最后一种要求不同姓名的复核员与复核说明。姓名为自报，不是身份认证或防篡改审计。编辑真值内容会清除复核员并退回草稿。

选择此方案的原因是目前要求离线单文件与人工交接。[CVAT](https://github.com/cvat-ai/cvat) 的成熟画框、分工和[复核流程](https://docs.cvat.ai/docs/manual/advanced/analytics-and-monitoring/manual-qa/)更适合未来集中部署；当前不为单篇试标增加服务器与账号。这里复用项目的 PDFium 渲染、PNG helper、React、i18next、Zod 和 Toast，不改桌面产品 UI。

## 验证

```powershell
pnpm exec tsc -p scripts/bbox-annotator/tsconfig.json
pnpm exec vitest run test/bbox-annotator.test.ts
```

测试覆盖跨页图注不污染裁剪坐标、导入身份与页集合约束、标注矛盾以及已标好样例的结构和边界。工具不改 `src/` 模块依赖或 IPC 契约。
