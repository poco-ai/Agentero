# PDF 版面解析导致 WebView 崩溃循环

## 现象

打开论文后点击"开始语音答辩"（或仅停留在论文页面），后台"解析插图、表格、文字"任务运行期间界面整体白屏重启，看起来像应用崩溃；重启后解析任务自动重新入队，几分钟后再次崩溃，形成循环。语音答辩准备（材料快照 + 两个 ACP 子任务）叠加内存压力时崩溃更快，因此体感为"每次点开语音答辩就崩"。

## 原因

应用日志中每次崩溃都对应 `tauri_runtime_wry` 的 `webview reloaded`，即 wry 在 WKWebView `WebContent` 渲染进程被 macOS 终止（内存超限）后自动重载页面。链路：

1. 打开论文 Tab 即自动入队 PP-DocLayoutV3 版面解析，解析在主 WebView 的 `WebContent` 进程内运行：整本 PDF 读入 `ArrayBuffer`、PDFium wasm 以 2x 比例逐页渲染、ONNX 推理，叠加每个论文 Tab 常驻的 PDF 字节副本，内存触顶后进程被系统终止；
2. 解析入队去重只依赖模块级内存 `Set`，重载后清零；恢复的论文 Tab 挂载 PDF viewer 时发现 sidecar（`source/layout.json`）仍不存在，无条件重新入队解析——上一次崩溃的分析从头再跑，再次触顶，循环往复。

## 修复

新增 `src/lib/pdf/layout/crash-guard.ts` 崩溃守卫，用 `localStorage` 记录"进行中"的解析尝试：

- ONNX 分析真正开跑前写入 in-flight 记录（含尝试计数），成功、失败、取消等任何正常结束都会清除记录；重载后仍处于 in-flight 的记录即代表上次解析把 WebView 压崩；
- 同一论文累计 2 次中途崩溃后，自动路径（论文 Tab 挂载的 headless 入队、viewer 静默解析）不再重跑，`run-analysis` 与 `enqueue-paper-layout` 双重拦截——后者在整本 PDF 读入内存之前就跳过；
- 右侧栏"检测配图、表格与公式"手动入口传 `trigger: "manual"`，重置守卫并照常执行，用户始终可以手动重试；
- 崩溃记录 7 天过期，过期后自动解析恢复；Figures 面板通过 i18n 文案（`viewer:pdf.layout.crashLoopSkipped`，中英双语）说明已暂停及手动重试方式。

## 回归

- 新增 `test/pdf-layout-crash-guard.test.ts`：覆盖正常结束不计数、单次崩溃允许重试、两次崩溃后跳过、成功清零、手动重置、路径规范化、记录过期、损坏存储与无 `localStorage` 环境；
- 前端全量测试（90 个文件 / 735 例）与 TypeScript 类型检查通过，Biome 对改动文件无警告。

## 遗留

版面解析仍运行在主 WebView 进程内，超大 PDF 首次解析在内存紧张的机器上仍可能触发一次崩溃（守卫会阻断循环并保留手动重试）。彻底解决需要把 PDFium 渲染与 ONNX 推理移出 `WebContent` 进程（独立窗口或 Host 侧执行），已记入 Roadmap 观察项。
