# 外部 MCP 服务

桌面端与 headless CLI 共享 `agentero-mcp` 的工具执行、JSON Schema 校验和 Vault 边界。CLI 支持 stdio 与 Streamable HTTP，桌面设置开启 loopback HTTP。Agentero 内的侧栏和 Zen 通过 CLI 使用会话授权的上下文。

## 启动与发现

```sh
agentero mcp serve --vault lab
agentero mcp serve --vault lab --allow write --allow online
agentero mcp serve --vault lab --transport http --listen 127.0.0.1:8765
agentero mcp tools --allow write --allow online --json
```

stdio 是默认传输，stdout 专用于 MCP 帧。HTTP 用 `--listen` 指定回环地址，端口 0 自动分配，实际地址写入 stderr。客户端必须携带 `Authorization: Bearer <token>`。首次启动会生成 `<Agentero 配置目录>/mcp.token`，CLI 只向 stderr 报告文件路径。需要使用自己的凭据时传 `--token-input <文件>`，或传 `--token-input -` 从 stdin 读取。

`--vault` 选择默认库，`--allow-vault` 可重复添加授权库。协议调用先用 `vault_list` 获取不透明 ID，再将 ID 传给其它工具的 `vault` 字段。服务只处理授权范围内的本地 Vault，不传输 Vault 的绝对路径。HTTP 和 stdio 采用相同的工具过滤和调用时鉴权。

## 权限

| 授权 | 能力 |
|---|---|
| 默认 | 13 个只读工具。题录、普通笔记和文件、表格、引文、批注、版面区域索引和有限长度的搜索摘录 |
| `--allow write` | 修改题录、笔记和标签，写文件，回收或恢复，修改批注和表格 |
| `--allow full-text` | 在已有读取工具上开放论文正文、分页及版面阅读 |
| `--allow online` | 在线文献发现；与 write 同时授权可按标识入库或使用在线翻译 |

桌面端在 **Settings → General → MCP server** 启用服务，默认端口 8765；`mcpExposePaperText` 控制论文全文读取。桌面 HTTP 默认只读。需要写入或联网时可启动单独的 CLI 服务并明确授权。

桌面可通过 OpenAI Secure MCP Tunnel 连接 ChatGPT。宿主将控制面 Runtime API key 和本机 MCP bearer 分开，后者以环境变量引用提供给 `tunnel-client --mcp.extra-headers`，仅发送至本机 MCP。隧道状态以控制面轮询结果为准，退出应用或关闭 MCP 开关将停止子进程。安装及连接步骤见[外部 Agent 接入指南](../usage/mcp.md)。

## 工具与数据契约

`tools/list` 返回当前权限可用的 schema、说明、annotations。`agentero mcp tools` 使用同一份目录。成功调用通过 `structuredContent` 返回对象；领域错误通过 `isError` 与带 `code` 的错误对象返回，非法工具参数为 JSON-RPC 参数错误。`resources/list` 发布 `agentero://guide`。客户端可从该资源了解查库、检索、展开出处和修改操作。

| 工具 | 作用 |
|---|---|
| `vault_list` | 查看允许的 Vault 并取得 ID |
| `evidence_search`、`evidence_read` | 检索可引用的证据卡，按引用、来源、页或版面区域展开 |
| `paper_list`、`paper_get`、`paper_update` | 查询和修改论文题录 |
| `paper_regions`、`paper_relations` | 查找图表区域和引用关系 |
| `paper_discover`、`paper_import` | 搜索在线论文，按标识入库 |
| `paper_tag_list`、`paper_tag_add`、`paper_tag_remove`、`paper_tag_set` | 查询、增删和替换标签 |
| `paper_note_append`、`paper_note_replace` | 维护论文 NOTES，保护 YAML frontmatter |
| `file_list`、`file_write`、`file_move`、`file_remove` | 浏览目录，写入文本或 Base64 文件，移动、回收文件 |
| `trash_list`、`trash_restore` | 查询可恢复条目，用条目 ID 还原 |
| `annotation_list`、`annotation_get`、`annotation_add`、`annotation_update`、`annotation_remove` | 阅读及维护科研批注 |
| `table_query`、`table_upsert`、`table_patch` | 按行查询研究数据，批量写行或改单元格 |

默认授权下，`evidence_read` 可重新打开本服务最近搜索返回的正文摘录。回读会检查来源版本，仅返回已展示的证据卡，不提供续读游标。打开整页或读取新的正文段落需要 `full-text`。题录中登记的论文目录（含自定义导入目录）里的研究表格同样按正文授权，普通 Vault 目录中的研究表格可直接查询。

读取返回的 `revision` 用于之后的条件更新。需要追加笔记、创建批注或写入表格时，调用方为一次操作生成 `request_id`，重试同一请求复用此 ID。移动和回收支持 `dry_run`。分页传回原查询的 `next_cursor`。查询条件或数据变化时重新查询。

`file_write` 默认创建文件，替换须传现有版本。文本和标准 Base64 的解码大小上限为 2 MiB。`table_query` 返回的行 ID 可直接用于更新，包含尚未分配登记号的旧行。新增行需要如 `trial-0003` 的登记号，前缀以 ASCII 字母开头且只含字母或数字，后缀至少四位数字。已有研究表格用行或单元格操作，论文笔记用专用写工具；系统目录、托管数据、锁定实验数据受到写保护。

参数、枚举、必填条件、输出字段和权限注解见[机器可读工具契约](../../crates/agentero-core/src/ops/mcp.json)。协议与核心回归可运行 `cargo test -p agentero-mcp`。
