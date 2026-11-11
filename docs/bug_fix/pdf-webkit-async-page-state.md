# PDF 重建中的 WebKit 异步页状态串用

2026-11-09，WebKitGTK / JavaScriptCore 2.50.4，WSLg Tauri 桌面程序。

## 现象与定位

多文档轮换后，PRISMA 2020 的连续阅读从 131 块变成 797 块，正文拆成碎句。经济论文从 862 块变成 4,034 块。阅读模型与实际 DOM 块数一致，重试可恢复；原 PDF、版面区域和字符坐标均未改变。

逐层记录 `getPageTextRuns` 调用、队列、worker 响应及最终字符模型后确认：经济论文各页的 worker / API 返回值正确，但最终第 4–43 页的部分字符使用了首页 Arial 字体、字号与颜色。PRISMA 第 2 页有 5,016 个可对齐字符的字体与首页相同。故不能通过修改段落阈值、重试或针对论文调整区域解决。

WebKit 的 [bug 313499](https://bugs.webkit.org/show_bug.cgi?id=313499) 与 [上游修复 e6507c8](https://github.com/WebKit/WebKit/commit/e6507c8f6aa83fb37b02d3c4ceaf7e4f4eb661d3) 描述了对应机制：暂停的 async 函数恢复时，代码回收后重新创建的 SymbolTable 与原激活记录不同；JIT 对捕获变量的旧常量优化未失效，闭包会继续读旧值。

## 修复约束

`src/lib/pdf/reflow/extract.ts` 中，异步逐页循环只取 glyph、text runs、原始字符和光栅，再把当前页数据作为参数传给同步函数：

- `pageCharacters` 负责当前页字符索引、文本对象与字体映射。
- `reflowPage` 负责当前页可见性、段落、公式、表格及覆盖统计。
- 异步循环中的区域筛选与 text slice 构建使用普通循环，不让闭包捕获逐页变量。光栅返回后再次检查取消信号。

只移动字体映射仍不足：测试能得到字体正确但字符丢失的结果，因为段落筛选也捕获了异步页状态。必须把整页同步计算隔离。无需 PDF 特例、全局缓存、关闭 JIT 或修改 PDFium。

## 验证

在本机同一 `libjavascriptcoregtk-4.1.so` 上，用 C API 执行打包后的实际 `extractReflowDocument`，在第一个异步等待处通过 `VM::deleteAllCode` 触发代码回收。该诊断入口仅用于测试程序，不进入应用。四页各有 2,400 个字符，每页字体不同；测试检查字符完整数量和字体归属。

| 条件 | 结果 |
|---|---|
| 修改前、JIT 开启，3 次 | 每次均有错页字体或字符缺失；第 2 页仅余 66 个字符且全为首页字体 |
| 修改前、关闭 JIT，3 次 | 四页各 2,400 字符，字体全部正确 |
| 只隔离字体映射 | 字体恢复，但重复运行仍出现字符缺失，未接受此方案 |
| 整页同步隔离、JIT 开启，8 次 | 每次四页各 2,400 字符，错页字体 0 |

普通 Vitest 的 `test/pdf-reflow-page-fonts.test.ts` 检查相同多页输入的字符完整性与字体归属；Node/V8 不能代替上述 JavaScriptCore 缺陷复现。

Linux 安装 JavaScriptCoreGTK 4.1 开发库、`gcc`、`pkg-config` 并已有项目 Node 依赖后，在仓库根目录执行独立回归。产物放在系统临时目录，未修改系统库或运行中的应用：

```bash
regression_dir=$(mktemp -d /tmp/agentero-reflow-jsc.XXXXXX)
node -e 'require("node:module").createRequire(require.resolve("vite/package.json"))("esbuild").buildSync({entryPoints:["test/scripts/reflow-webkit-case.ts"],bundle:true,format:"iife",target:"es2022",outfile:process.argv[1]})' "$regression_dir/check.js"
gcc test/scripts/reflow-webkit-runner.c -o "$regression_dir/runner" \
  $(pkg-config --cflags --libs javascriptcoregtk-4.1) -ldl
ulimit -c 0
for attempt in 1 2 3; do
  JSC_useConcurrentJIT=false "$regression_dir/runner" "$regression_dir/check.js" || exit 1
done
```

该 runner 使用 Linux JavaScriptCore 的导出诊断符号；不提供该符号的构建会明确报错。每次必须输出 `PASS` 且退出码为 0，不能只确认字体后忽略丢字。

修复后，在无诊断钩子的全新桌面进程完成八篇论文两轮打开、首中末页滚动及模式切换。模型 / DOM 块数均与基准一致，各篇字符总数两轮一致。详细样本、引用验收与证据位置见 [跨领域回归](../test/2026-11-08-pdf-reader-crossfield.md)。

后续重构不要把同步页计算内联回 suspendable 循环。更换 WebKit 或构建工具后，需同时检查逐页内容及代码回收场景。

## 独立未决项

本次同时捕获 WebKit 因内存超过 8,192 MB 阈值主动终止页面进程的日志（9,408 / 10,429 MB）。该数值是 WebKit 的 footprint 判断，不等同于采样的 RSS；尚未定位占用来源，不能将正文修复等同于内存问题解决。修复后的短时干净进程验证也不能证明长期无泄漏。Windows WebView2 原生安装包未在本轮验证。

后续已将文档写入触发的开发页 reload 单独复现为 [Tailwind 扫描范围问题](tailwind-dev-reload.md)。无引擎钩子的轮换未重现阈值退出；关闭测试 PDF 后 PDFium 的文档和页缓存、引用计数、包装层跟踪分配均为零。该结果排除了当前现场的文档持有积压，但不能代替历史峰值归因，详见 [后续内存取证](../test/2026-11-08-pdf-reader-crossfield.md)。
