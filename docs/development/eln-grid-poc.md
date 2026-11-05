# ELN：Plate + Glide 最小验证

状态：技术 PoC，仅内存；不写 Vault，不提供结构化数据持久化或 Markdown 往返。采用 `@glideapps/glide-data-grid@6.0.4-alpha24`（该发布包声明支持 React 19）。现有 MarkdownEditorKit 中插入独立 void block，网格在 `contentEditable=false` 边界内管理事件。普通 Markdown 编辑器不注册此插件。

启动：

```sh
VITE_ELN_GRID_POC=1 pnpm tauri dev
```

开发入口通过 `import.meta.env.DEV` 门控，生产构建不启用。关闭环境变量后恢复正常工作台。支持 10,000 / 100,000 行 × 30 列，数据按需生成，只保存修改过的单元格。它验证渲染与内存编辑，不代表 SQLite 查询、IPC 或全量数据加载性能。

## 操作与验证

- 聚焦首个单元格后 Enter 打开 Glide 浮层编辑器。正文在表格前后仍由 Plate 编辑。
- Excel 选取 A1:T1000，复制到网格；整个矩形写入形成一个事务。越出网格边界的单元格截断。保留最近 50 次网格事务。
- 退出单元格编辑后 Cmd/Ctrl+Z 撤销，Shift+Cmd/Ctrl+Z 重做；浮层输入框保留浏览器自己的文本撤销。正文撤销由 Plate 管理。
- “写入测试数据”调用同一个批量写入入口，但不等同于剪贴板验收。
- “采样 5 秒帧间隔”期间滚动网格。帧间隔包含空闲与交互，并非严格滚动 FPS 基准；`twoFramesMs` 是到第二次 rAF 回调的时间，不等同于 GPU 完成绘制。

## 2026-11-05 macOS 桌面实测

通过 `pnpm tauri dev` 编译启动真实 Tauri Host。为让原生自动化识别未打包的开发可执行文件，另在忽略目录 `target/debug/` 创建临时 `.app` 外壳，运行同一份 debug 二进制并连接同一 Vite dev server；不替换已安装应用。

| 项目 | 结果 |
|---|---|
| Plate 内嵌网格 | 正文、独立网格及浮层编辑器可显示 |
| 原生 TSV 中文矩形粘贴 | 通过，2 × 2 中文与数值正确拆分 |
| Excel 原生剪贴板 | 新建临时工作簿，使用区域 A1:T1000；复制 20,000 个中文单元格到 Tauri，末值 `Excel样品999-19` 正确 |
| Excel 批量写入耗时 | 一轮 apply 6 ms、第二次 rAF 回调 23 ms；另一轮 6 / 49 ms，非统计基准 |
| 整批撤销／重做 | 按钮及 Cmd+Z / Shift+Cmd+Z 恢复原值与整批写入值 |
| 100,000 × 30 | 可显示、滚动；一轮 5 秒采样 459 帧，帧间隔 p95 13 ms、max 74 ms |
| 真正中文 IME 组合输入 | **未通过验收**：自动化输入源尝试只产生拉丁文本，compositionend 始终 0；中文粘贴不能代替这一项 |
| Windows / WebView2 / 125% DPR | 未测 |

发现并修正：判断编辑状态时，不能用 `closest('[contenteditable=true]')`，因为它会命中外层 Plate，让网格快捷键撤销失效。改查实际输入框或事件目标自身的 `isContentEditable`。快速撤销时，先前批量写入的异步性能报告也不能覆盖新的操作状态。

## 判定与后续

结论是 **macOS 上嵌入与批量编辑初步可行，暂不完成生产选型验收**。余项：真实拼音候选选择/取消/连续输入、浮层内文本撤销与提交后事务撤销的交接、正文输入与撤销隔离的完整交互、Windows 矩形粘贴与缩放，以及更长时间的滚动/内存基准。确认后再设计持久化适配器和 Schema 单元格；不把 PoC 内存状态升级成业务数据源。

相关规划入口：[开发草稿](index.md)。
