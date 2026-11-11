# PDF 与连续阅读扩展回归

2026-11-08，从本机 Zotero 文库新增 15 篇、209 页样本，在运行的 Tauri 桌面应用中检查 PDF 与连续阅读。全页扫描核对 3,671 处内部链接，无漏挂；图表悬停、参考文献裁剪和代表页视觉检查另行执行。最早的 25 页综述、7 页热仿真论文、11 页 NV 论文另作关键回归。

环境为 Windows 上的 WSLg / X11 / WebKitGTK，前端修改通过 Vite 热更新加载。本记录不代表 Windows 原生 WebView2 安装包验收，也不代表 209 页逐页视觉无损。

## 样本与覆盖

| 样本 | 页数 | 原生内部链接 | 已执行的悬停预览 |
|---|---:|---:|---:|
| Low On-Resistance H-Diamond MOSFETs，IEEE 2020 | 7 | 0 | 无原生链接；检查版面与曲线 |
| Direct-bonded diamond membranes，Nature 2024 | 9 | 95 | 30 |
| Smart Cut Transfer of Wide-Bandgap Materials，Wiley 2026 | 12 | 113 | 43 |
| 多晶金刚石薄膜硅空位色心形成机理及调控，2023 | 9 | 98 | 41 |
| UVMarvel，ACM 2026 | 7 | 81 | 20 |
| Record-Low Thermal Boundary Resistance，ACS 2021 | 8 | 111 | 21 |
| Hydrogen-terminated diamond MOSFET with buried p+ electrodes，2026 | 6 | 63 | 16 |
| Single-molecule scale magnetic resonance spectroscopy，2024 | 68 | 2,577 | 12 个分布于正文、图表和附表的抽查点 |
| Characteristics of H-terminated single crystalline diamond FETs，2017 | 8 | 47 | 22 |
| Uncovering piezoelectric effect，Science Advances 2026 | 10 | 167 | 34；另 3 处作者单位链接仅导航 |
| Boron-doped diamond MOSFETs up to 400 °C，2025 | 7 | 71 | 19 |
| Over 400 V field-plate diamond Schottky diodes，2026 | 11 | 83 | 38；另 3 处作者单位链接仅导航 |
| Extreme Enhancement-Mode diamond FETs，2025 | 10 | 77 | 39 |
| Entanglement of nanophotonic quantum memory nodes，Nature 2024 | 14 | 88 | 23 |
| Nonblocking Assignments in Verilog，Cummings 2000 | 23 | 0 | 无原生链接；检查代码、时序和电路图 |

链接扫描结果：3,489 处挂到正文，164 处挂到图表或算法裁剪，18 处为同位置同目标的重复原生标注。逐项/抽样鼠标悬停共检查 358 个文献或图表预览；另 6 个作者单位链接不应弹出文献卡片。预览检查先核对有图和目标页，再对典型病例人工查看截图；不能据此声称每一条预览的每行都经过人工核对。

## 发现与通用修复

| 触发条件 | 原因 | 修复与证据 |
|---|---|---|
| 原文数字、上标、作者年份链接漏挂 | 标记匹配不能涵盖原 PDF 的所有写法 | 原文可对齐时按真实逐字符几何映射 native annotation；图像裁剪复用链接层。15 篇全页扫描完成 |
| 公式黑块、白底、无 Unicode 字形方框 | PDF 自绘纸色不受透明画布参数影响；控制码不能直接显示 | 从裁剪图恢复纸色透明度；不可解码字形保留原图。MOSFET 公式与 NV 能量公式实际截图确认 |
| 等宽代码重复、endmodule 缺失 | 检测框与文本片段重叠、相邻代码被分块 | 同左边界且无正文隔断时合并，覆盖去重，按真实字形补边界。Verilog 第 4/8 页确认 |
| 多子图拆开、两栏图注丢首半段 | 正文先领取了重叠图注的字符 | 明确编号图注先领取字形；只用高度重叠的检测框补薄边缘，抑制图内短标签重复正文。Nature 第 2 页确认 |
| 引用指向正确页但不弹预览 | XYZ 纵向位置与实际参考文献条目相距很远 | 目标编号唯一且同列有连续编号时按编号校正；重复或孤立编号不放宽。`[4]` 在 PDF/阅读两模式通过 |
| `24.M...` 无法识别，齐左参考文献截断 | 标号后强制空白；强制悬挂缩进 | 允许标号贴作者名；仅实际采用悬挂缩进时才用缩进判断边界。第 24 篇完整显示 |
| 作者年份参考文献缺末行 | 多行作者名单末尾的姓氏和年份被当成新条目 | 同栏缩进优先于作者年份模式。68 页长文表内引用显示作者、期刊、卷页完整三行 |
| PDF 表格引用被批注区域挡住 | 两层均为 z-2，较晚绘制的大图表按钮赢得命中 | 链接在图表批注命中框后绘制，仍低于译文纸面。实测 `[24]` 命中链接，表格空白仍命中批注 |

所有判断基于文字角色、字形、版面和原生链接，不依赖标题、DOI 或固定页码。旧版面缓存用文字几何版本号重走文字层，无须重新调用版面模型。

## 原问题与交互回归

- 7 页热仿真论文：`[8–11,15–18]` 在命中 8 时显示 8/9/10/11，命中 15 时显示 15/16/17/18；`[1,12,17]` 命中 12 只显示第 12 篇。PDF 模式另外确认 8–11、12 和 Fig.11；阅读模式确认 Fig.1。
- 25 页综述：阅读模式 11–13 范围及单篇 48，PDF 原文模式单篇 49；没有把后续条目合入范围。
- 11 页 NV 论文：阅读模式 20–22、Fig.1 和第 7 页公式；PDF 模式 Table II。点击图号后 Jump back 的 scrollTop 从 9560 跳到 10424，再回到 9560。
- X11 XTest 生成的真实 Ctrl+滚轮事件到达 WebView，`isTrusted=true`。字号 17.6 px → 19.489948 px，反向输入并保存后回到 17.6 px。普通滚轮字号保持 17.6 px，scrollTop 增加 102 px。Windows user32 注入未到达 WSL 窗口，未把那次无事件记为通过。
- 阅读区纵向滚动条可见，宽度 10 px。跨模式的在线翻译质量未纳入本轮；没有发送新的翻译或 AI 请求。

## 自动检查

121 个测试文件：942 项通过，10 项跳过，0 项失败。TypeScript `--noEmit`、本轮 20 个源码/测试文件的 Biome 检查及 `git diff --check` 通过。实际新增缺陷用例先观察失败，再验证修复；简单图层顺序调整通过真实指针命中和截图验证。

原 Zotero/桌面 PDF 未修改，测试使用临时文库副本。运行中没有重新构建覆盖桌面 `libpdfium.so`，本轮启动禁用 core dump。Git 作者身份缺失，因此改动未提交。

## 证据位置与边界

本机证据目录：`E:\Temp\agentero-reader-qa`。`QA-RESULTS.json` 包含 15 篇原始文件的完整路径、扫描计数与证据位置；`final-vitest.json` 为测试结果。图片和临时副本不进入仓库。

关键截图文件：

- `final-thermal-reader-8-11.png`、`final-thermal-reader-15-18.png`、`final-thermal-reader-ref12.png`
- `final-thermal-pdf-8-11.png`、`final-thermal-pdf-ref12.png`、`final-thermal-pdf-fig11.png`
- `final-extra7-ref24-pdf.png`、`final-extra8-ref4.png`、`final-long-table-ref-fixed.png`
- `final-nature-network.png`、`final-verilog-code.png`、`final-nv-equation.png`

尚未覆盖的范围：扫描件 OCR、任意 PDF 的逐页视觉无损、跨页参考文献范围收集、新论文的在线翻译和打包安装验证。代码块为保留排列的原图，不能当作可选中的重排代码文本使用。
