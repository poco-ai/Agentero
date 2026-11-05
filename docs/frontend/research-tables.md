# 科研表格

文件树右键「新建科研表格」创建 `*.table.json`，普通文件夹（包括 `data/`）均可使用。工作区自动识别并使用 Glide Data Grid 打开。旧的独立 PoC、模拟数据、性能按钮和环境变量入口已删除。

## 编辑与保存

- 表格区分「科研对象」和「实验结果」；当前是两种表格语义标签，还没有注册编号、执行 Run 或库存业务。
- 字段有稳定 ID，支持文本、有限数值、布尔、ISO 日期、单选。数值字段可配置单位，显示在列名中；单选和日期使用独立编辑控件。点击列头修改字段，字段可删除；保留至少一列。
- 字段改名保留 ID。已有非空数据时拒绝直接改类型或单位，避免把数值重解释为另一种测量。单选选项修改必须与已有取值兼容。
- 添加行后编辑，也可以从 Excel 复制矩形区域粘贴；必要时自动追加行。整个批次先校验再提交，一个错误值或额外列会拒绝整批，不截断后悄悄丢数据。
- 行有稳定 ID；选中行标后 Delete 删除行，普通单元格选区 Delete 清空值。
- 最近 20 次内存编辑可以撤销／重做，包括字段、行和批量粘贴。Cmd/Ctrl+Z 操作网格事务；浮层输入框保留自身文本撤销。它不是持久化审计历史。
- 800 ms 防抖保存、手动保存和关闭前 flush 共用工作区文本保存链路，维护 `textDirty`、种子和外部重载。表格保存严格比较上次保存内容，不使用 Markdown 的自身写入宽免；文件读失败时拒绝写入。当前沿用既有文件读后比较机制，不提供跨进程文件 CAS。
- 可导出 CSV（字段带单位），或复制 Markdown 引用。CSV 为扁平交换格式，不包含字段类型和稳定身份；完整保留结构应复制原 JSON 文件。

## Notebook 引用

复制引用后粘贴到普通 Markdown，或使用 `/table`（嵌入科研表格），填写 Vault 相对路径：

```markdown
::research-table{path="data/measurements.table.json"}
```

Plate 中显示实时只读预览，最多 20 行，并显示预览行数／总行数；「打开表格」进入完整编辑器。笔记和表格各自保存，笔记不复制整份数据。导出笔记时输出相同预览的 HTML 表格。没有固定历史快照语义，实验定稿应另导出结果文件。

引用路径禁止绝对路径、`..`、隐藏目录及跨平台分隔符歧义。引用目前按路径定位；移动或重命名表格后需更新指令中的路径。当前窗口保存表格会刷新其嵌入；外部程序修改后的笔记预览可点击刷新。

## 文件契约与 Agent

`src/lib/research-table/model.ts` 是首版契约与校验入口。结构文件本身是真源，尚未建立 SQLite 研究数据索引。每个 Vault 可包含多份表格；字段和行 ID 在编辑中不变，`revision` 随成功保存递增。空值为 `null` 或缺省字段，零和 false 不等于空值。

```json
{
  "format": "agentero-table",
  "version": 1,
  "id": "table-stable-id",
  "name": "循环测量",
  "kind": "result",
  "revision": 1,
  "fields": [
    {"id":"sample","name":"样品","type":"text","unit":"","options":[]},
    {"id":"capacity","name":"容量","type":"number","unit":"mAh","options":[]}
  ],
  "rows": [{"id":"row-stable-id","values":{"sample":"BAT-001","capacity":2.31}}]
}
```

Agent 可沿用 Vault 文件工具读取和生成此文件，并把引用写入实验 Markdown；现有 MCP 文本文件工具仍有 2 MiB 限制。这是开放文件接口，尚无专用 Schema／记录变更工具，也不把任意 JSON 文件写入等同于已通过服务端业务校验。重新打开时严格校验版本、身份唯一性和字段值；非法内容显示错误，不当作空表覆盖。

边界：最多 100,000 行、100 个字段、单次粘贴／编辑 100,000 单元格；整文件读写，不代表已完成最大规模性能验收。对象关系、原始文件逐值来源、科学单位换算、查询视图、图表和不可变审计历史属于后续 ELN 数据层。

## 同步

S3 / WebDAV 同步时，双侧都改动同一张 `.table.json` 会保留原文件与 `name (conflict 时间).table.json`，两份均可由表格编辑器打开，需人工核对合并；不按普通 JSON 的 LWW 丢弃一侧。Git 继续使用 Git 的冲突流程。文件夹内原始数据和普通笔记仍按原有规则同步。

## 验证

最小回归：`test/research-table.test.ts`、`test/research-table-markdown.test.ts`、`test/workspace-viewer-modes.test.ts`、`test/editor-slash-command.test.ts`；Rust `merge_divergent_research_tables_preserves_both_readable_files` 验证两种时间顺序下都保留可识别的完整扩展名。

Markdown 回归走实际的 `deserializeMarkdownBody`，覆盖预处理、插件选择和往返序列化，避免仅在裸 Plate 测试里通过、实际笔记却把指令大括号转成普通文本。

macOS Tauri 实测：打开真实 `.table.json`，新增行、撤销、自动保存后重载；粘贴包含中文与数值的 TSV 矩形并核对磁盘内容；Cmd+Z / Shift+Cmd+Z；非法数值弹出错误且拒绝整批；Plate 引用加载及刷新。当前回归 6 个测试文件、51 个用例通过，另有同步冲突 Rust 回归通过。中文粘贴不等于真实输入法组合输入验收；输入法候选词、Windows WebView2 和 100,000 行性能仍需专项验收。
