# Wiley 引用完整性与 Zotero 方法对照

## 样本与判定方式

2026-11-10，先基于 Agentero 0.15.4 排查，随后完整迁移到 0.15.5 固定提交 `66ecc12675b55612221e077161009ae3b914b198`，分别执行 Windows WebView2 开发桌面与独立成品验收。用户提供两篇 AI Magazine 后，另下载七篇 Wiley 论文，共九篇 134 页。源 PDF 保留 SHA256；导入、批注和翻译只在隔离 Vault 副本运行。此前“42 篇”包含老样本、不同目的的抽样和代表悬停，不能据此声称所有出版社、所有引用通过。

| 样本 | DOI | 页数 | 原生引用出现位置 |
|---|---|---:|---:|
| Human and machine intelligence: Insights from children | 10.1002/aaai.70118 | 6 | 33 |
| Safety in numbers | 10.1002/aaai.70124 | 17 | 152 |
| Field Emission Enhancement in Graphene/Cu Cathodes | 10.1002/advs.78333 | 13 | 39 |
| Multiband Optical Physical Unclonable Functions | 10.1002/advs.78505 | 14 | 42 |
| Human Tolerance in Romanian Brown Bears | 10.1002/ece3.74359 | 11 | 70 |
| Climate-Driven Distribution Modeling of the Glacial Apollo Butterfly | 10.1002/ece3.74412 | 20 | 175 |
| Eye movements reveal atypical complex cognitive processing | 10.1111/bjop.70121 | 20 | 98 |
| AI-driven perception management and political soft power | 10.1002/aaai.70052 | 14 | 81 |
| An actionable framework for AI-ready data | 10.1002/aaai.70054 | 19 | 80 |

完整算法扫描：770 处 annotation，展开 1,544 个引用成员；均找到裁剪，没有遗漏被悬停 annotation 的目标 key。使用当前 Pdfium 与生产解析模块，并保存每个成员的文字、目标、裁剪框。此层检查不等于桌面预览或逐字人工校对；桌面必须另验，并对照多篇组的数量、作者/年份和条目尾部。

## 本轮修复

- InDesign 颠倒矩形先归一，完整命名 key 识别；内部 bib 序号不推断印刷序号。
- 作者年份括号组跨行/跨栏保留所有原生成员，同作者同年按原生目标区分。复姓软连字符、机构作者和提取层缺空格统一恢复；不按题名、DOI、固定页码特判。
- 局部作者名单缺首作者、编辑者等只有在全部名字、精确年份及原生锚点共同支持时解析；单独年份不猜论文。
- 页码尾行 `124. https://...` 不把作者年份参考文献误判为编号列表。带跨行作者的正文不在第一个短行停止；网址文件名不借下一条文献的年份成为假作者。
- 条目延伸到下一栏/下一页时，从列尾接到下一列顶部，直到下一条参考文献。已真实复验长 URL 的最后两行，不再只截前半段。
- 新引用组规则暴露的 `etal.`、`Zhang,Zou` 和 `andWang` 都有先失败后通过的回归。测试检查被悬停 key 是否在结果里，防止“其他成员都找到了”掩盖漏项。
- 逐位置 Windows 验收继续发现数据集编号尾部混入作者名，以及 `vanDiggelen` 连写导致组合引用漏项。作者匹配增加真实词边界，并恢复姓氏前缀分隔；相同文献的每次出现均单独检查，不能用某一处成功替代其他位置。
- 独立 PyMuPDF 条目尾部审计发现出版社行借用下一篇年份、标题中年份被误作新条目，以及跨页续接侵入右栏的问题。现以作者结构和实际栏边界判断，包含下一篇作者名被提取成 `Zizk a , A .` 的额外空格变体。修复覆盖整类排版，不写论文例外。
- 不同条目的裁剪重叠审计另外拦住了编辑者后缀、单字母开头机构作者和跨行长作者名单边界。原先仅用锚点附近的行识别下一条，漏掉缩进续行中的年份；现在以整页分栏文字识别条目，再按锚点选择目标。覆盖 `ed.`、`R Core Team`、作者省略号以及 `2 023` 这类字形空格。各缺陷均保留先失败后通过的回归。
- Windows 原生 PDFium 与离线 WASM 的字形空格输出并不完全相同。保存九篇全部 134 页原生字形，再用生产模块重扫 770 个位置；正文悬停另行验证。旧 `all-occurrences-verified.json` 保留为失败调查前的算法证据，成员解析保存于 `native-glyph-final-all.json`，最终裁剪使用 `native-final-recrops5.json`，不拿旧扫描冒充新结果。

- 成品逐位置审计还发现相邻行重复引用同一篇时，入口错误合并两处年份，丢掉已解析的单篇作者身份；明确的单篇和组合身份现在共用同一路径，避免退回两行几何裁剪。

## Zotero 参考来源

本机 Zotero 10.0.8 / PDF.js 5.7.0 的安装资源与公开源码分别留档，不能视为同一版本。参考的是方法和边界：native destination、几何与文本联合判定、组合引用整体校验、缓存及迟到请求取消；未复制 AGPL 源码进本项目。

- [reader PR #265](https://github.com/zotero/reader/pull/265)：引用 popup 与整组匹配，审阅时仍未合并，固定 head `da93cf8bc8555952454a741d626781aa599c502b`。
- [PR #273](https://github.com/zotero/reader/pull/273)：阅读图片化块批注定位，未合并。
- [PR #274](https://github.com/zotero/reader/pull/274)：批注输入更新合并和迟到状态处理，未合并。
- [PR #229](https://github.com/zotero/reader/pull/229)：隐藏标签释放 canvas 的提案，关闭但未合并；其内存描述不是 Agentero 实测。

此次上游更新已完整迁入：除 Mermaid 交互视口和长论文 slug 唯一性外，还包括 #1064 完整译文缓存跳过队列、#1066 部分缓存先显示且手动补全、#1061 后台标签骨架卸载以及 #1063 文献库多选/框选/批量操作。PDF 缓存分支保留官方行为，并继续支持本地阅读和对照视图；文献库的新行结构保留阅读时长。后续 PR 仍需对照提交当时的主分支。没有借“Zotero 也有限制”来跳过当前可复现缺陷。

## 证据

外部根目录 `D:/agentero-migration-20261110`：`citation-stress/downloaded-manifest.json`、`native-glyph-final-all.json`、`native-final-recrops5.json`、`results/`、`zotero-reference-study/`。截图和论文不进 git。对 622 个不同 key/成员身份另外执行 PyMuPDF 条目尾部审计，178 个候选边界逐项分类；相对前轮新增或变化的 11 个边界均查看原 PDF 图像，确认后续行为下一篇文献开头。此前发现的出版社行截断、标题内年份和邻栏串入已修复。记录为 `tail-final-review5.json`；不同条目裁剪面积重叠超过 25% 的审计为 0 项。此审计会漏过较小的重叠，且不等于逐字人工校对全文。

独立 PyMuPDF 身份审计：622 个不同成员中 619 个直接满足编号或作者/年份文本核对，另外三个查看源 PDF 与原生目标后确认：APA 是 American Psychiatric Association 的缩写；Haraç 正文 `Bradshow (2015)` 对应参考文献 `Bradshaw, S. 2015`；Majithia 正文 `Casilli et al. 2024` 的原生目标条目印为 2025。后两项是文件内不一致，预览保留条目原文，不修改姓名或年份。证据为 `independent-identities.json`、`independent-identity-review.json` 与 `source-identity-evidence/`。身份核对也不能代替条目尾部完整性检查。

最终成品引用结果、内存和包哈希集中在[上游迁移试用报告](2026-11-10-upstream-reader-trial.md)。
