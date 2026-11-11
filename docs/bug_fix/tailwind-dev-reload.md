# 文档写入触发桌面开发页面刷新

2026-11-09，Vite 7.3.7、Tailwind CSS / `@tailwindcss/vite` 4.3.2。

## 现象与原因

桌面 PDF 验证中，Host 与 WebKit 页面进程 PID 不变，但出现 `frontend_boot`、阅读状态丢失和 navigation type `reload`。Vite 终端没有对应的 `page reload` 日志。

`src/index.css` 原来使用 `@import "tailwindcss";`，Tailwind 默认从工作目录（仓库根目录）扫描类名，连 `docs/`、`test/` 等目录也注册为样式依赖。其 Vite 插件在被扫描、但没有应用模块处理的文件变化时直接发送 `{ type: "full-reload" }`；该分支不经过 Vite 自身的刷新日志。

现场把 `docs/test/2026-11-08-pdf-reader-crossfield.md` 的原始字节原样写回，文件 SHA-256 不变，仍在约 0.1 秒内收到 `full-reload`、`vite:beforeFullReload`、`beforeunload` 和 `pagehide`，随后页面重新加载。这与此前多次修改报告后的刷新时间吻合。开发服务器断线重连也会刷新页面，应通过事件区分；这不等同于 WebKit 内存阈值终止。

上游依据：[4.3.2 Vite 插件的 `hotUpdate`](https://github.com/tailwindlabs/tailwindcss/blob/v4.3.2/packages/%40tailwindcss-vite/src/index.ts)、[Tailwind 类名来源配置](https://tailwindcss.com/docs/detecting-classes-in-source-files#setting-your-base-path)。

## 修复与复查

在 `src/index.css` 使用 `@import "tailwindcss" source(".");`，扫描基准相对样式表限定为 `src/`，再用 `@source "../index.html";` 显式纳入入口。依赖样式的原有 import 保留。

改变扫描范围后必须重启正在运行的 Vite：仅热更新 CSS 不会移除本次服务器生命周期已经注册的旧文件依赖，旧依赖仍可能触发 Vite 自身的刷新分支。无需重建 Rust Host。

实际核验：

- 重启后再次原样写回同一文档和 `test/pdf-reflow-page-fonts.test.ts`，页面标记保留，没有新的卸载或刷新事件；源文件哈希不变。
- 应用样式原样写回仍收到 `/src/index.css` 的 `vite:beforeUpdate`，页面标记保留，证明样式热更新仍有效。
- 用已安装 Tailwind 编译器和扫描器读取实际样式：扫描 1,211 个文件，包含 398 个 TSX 文件及入口 HTML；没有 `docs/`、`test/`、`scripts/`、`crates/`、`src-tauri/` 文件。连续阅读组件仍在扫描范围，CSS 生成成功。
- 桌面八篇论文两轮共 16 次打开、滚动和模式切换，343 秒内无刷新；模型 / DOM 块数及每篇字符总数均一致。PRISMA 第 2 页正文另看实际窗口截图。

证据保存在仓库外 `E:\Temp\agentero-reader-qa\runtime\`：`vite-hmr-wire.jsonl`、`reload-before-doc.json`、`reload-after-restart-doc.json`、`reload-after-restart-test.json`、`tailwind-source-check.json`、`memory-confirm-results.json`。图片和堆快照不提交。

以后新增位于 `src/` 外的实际界面模板时，显式注册对应 `@source`，不要恢复整仓扫描。开发页诊断同时记录 Vite 事件、页面存活标记和进程 PID；仅看 navigation type 或终端日志不足以归因。
