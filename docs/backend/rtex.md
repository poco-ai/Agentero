# 实时 TeX 预览（rtex）

基于 [realtime-tex](https://github.com/HenryXiaoYang/realtime-tex) 0.0.6 的 LuaLaTeX 边打边看预览。编辑 `.tex` 时，当前段落由常驻 live engine 重排并回传 display list，整页/分页/交叉引用由后台完整编译更新。

## 范围

- 仅 **LuaLaTeX**：LaTeX 面板的实时预览在本机有 `lualatex` 时出现。它不改 latexmk 用的编译引擎。
- 仅 **本地 Vault**：rtex 需要本地 `lualatex` 子进程；远程 Vault / iOS / Android 不可用（模块按 target gate 掉）。
- 正式 PDF 仍走 latexmk；实时预览是独立 tab，和编译 PDF 共用项目配置后的输出路径。

## Host 结构

`src-tauri/src/features/rtex/`

| 文件 | 作用 |
|---|---|
| `mod.rs` | `RtexSessions`（按 root 的会话表）、命令、事件转发、资源读取 allow-list |
| `rtex_start` | 打开 `Session`，一个 root 一个会话；事件线程 `poll(32ms)` 后 `emit_to("rtex:event")` |
| `rtex_edit` / `rtex_set_document` | 编辑器增量 / 全量同步（UTF-8 字节区间） |
| `rtex_status` | lualatex + support files 检测 |
| `rtex_kpsewhich` / `rtex_read_tex_file` | 渲染器取字体/map/图片/layout PDF；只允许 kpsewhich 结果、项目根、`.agentero/rtex`、TeX Live 根 |

依赖：`rtex-core`（git tag `v0.0.6`，`src-tauri/Cargo.toml`），仅桌面非移动 target 编译。support files 从 `realtime-tex/tex` 复制到 `src-tauri/rtex/tex`，由 `bundle.resources` 打包；运行时设置 `RTEX_TEXDIR`。GUI 的 PATH 不含 TeX Live，`prepare_environment` 还会设置 `RTEX_TEXLIVE_BIN` 并把它的 bin 目录前置到 PATH。

**build_dir 固定为 `<vault>/.agentero/rtex/<root-hash>`**：`.agentero` 已被文件树、watcher、sync 和 LaTeX root 反向扫描忽略，后台 pass 的 aux/PDF 不会污染项目或触发刷新。

## 前端

`src/lib/tex-live/`

- `session.ts`：会话表（root → session）、编辑器注册、文件 → session 映射、编辑队列。
- `byte-index.ts`：CodeMirror UTF-16 偏移 → rtex UTF-8 字节偏移。按行缓存；一次 transaction 的所有 change 用旧文档计算后倒序发送。

`src/components/viewer/texlive/`

- `tex-live-viewer.tsx`：画布预览、缩放/滚动、状态、PDF fallback。
- `render/render.ts`、`model.ts`、`type1.ts` 移植自 realtime-tex 的 VS Code 插件（MIT）；`resources.ts` 改为走上面的 Tauri 命令。

实时预览标签在文件名右上角、关闭按钮左侧显示状态圆点（`size-1.5`，与左侧栏一致；横向占位 `w-3`，紧凑排列）：绿色为实时预览就绪，橙色为启动、等待完整编译或引擎重启，红色为失败。悬浮或键盘聚焦圆点可查看具体状态及错误信息；状态标记不占页面布局空间。共享状态按预览 pane 分别登记和清理；关闭同一项目的其中一个分屏不会清除其他存活分屏的状态，最后一个 pane 卸载时才移除该项目状态。

事件：

| 事件 | 处理 |
|---|---|
| `LayoutUpdate` | `PreviewModel.applyLayout`；更新页数/placement；加载字体/图片；degraded 页读 `pdf_fallback` |
| `ParagraphUpdate` | 覆盖当前 unit；`pagination_stale` 等下一轮 layout 修正 |
| `EngineState` / `BackgroundScheduled` | 状态栏；不当作错误 |
| `Diagnostics` | 预览状态栏计数（后续可接 lint footer） |

## 打开流程

1. LaTeX 面板的「实时预览」。再点一次关闭，回到已有 PDF，不跑 latexmk。
2. `openTexLive` flush 编辑器 → `resolveTexRoot`。
3. 打开/复用 项目输出 PDF tab，置 `texLive: true`（`texRoot` 记录 .tex）。
4. 预览组件启动 `rtex_start`，挂载编辑器并 `set_document`；之后每次 change 走 `rtex_edit`。
5. 编译和查看 PDF 通过 `openTexPdf` 清掉 `texLive` 回到编译 PDF。关掉实时预览（`closeTexLive`）只退出画布。手动 ⌘S 的静默编译在 live tab 下跳过。

## 限制与排查

- rtex 0.0.6 API/display list 仍可能变；升级时固定 tag 并核对 `display-list.md`。
- 首次 session 要等完整 pass（小文档约 1–3 s，字体缓存冷启动更久）；之后段落约毫秒级。
- TikZ/旋转页/RTL 由 display list 无法完整描述，页面走 layout PDF；缺失字体也会降级。
- 中文/ctex/luatexja 需要实测字体解析与速度。
- 预览画布目前无文本选择/搜索；需要这些能力时切回编译 PDF。
