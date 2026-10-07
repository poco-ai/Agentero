# Agent DX（CLI / MCP / Skill）

面向 AI agent 的机器接口约定。Human DX（彩色 help、交互确认）保留；Agent DX 强调可预测、可自省、默认瘦输出。

## 已落地（Phase 2 / 精简 3 / 4）

| 项 | 位置 |
|---|---|
| Curated ops 目录 | `agentero-core::ops` |
| CLI 自省 | `agentero describe [op] --json` |
| 同源 invariants | `ops::agent_invariants_markdown()` → MCP resource + Skill 指针 |
| layout-index 共享解析 | `agentero-core::features::pdf::layout_index` |
| MCP 瘦 `paper_list` + `fields`/`full` | `integration/mcp` |
| MCP `paper_set_read` / `layout_list` / `layout_get` | 同上 |
| MCP `file_list` / `file_read` / `file_write` | Vault 内 UTF-8 文本（Papers 外的 `.tex` 等）；拒绝 `.agentero`、二进制、NOTES 直写 |
| MCP `vault_search` | 全库 Markdown 关键词 AND；复用 Host 搜索，沿用 MCP 文件路径限制；返回 path/snippet/line/truncated，见 [backend/mcp](../backend/mcp.md) |
| MCP resources | `agentero://vault`、`agentero://agent-invariants`、`agentero://skills/agentero-cli` |
| Skill 削薄 | `templates/vault/.agents/skills/agentero-cli` v16（任务分支协议；`describe`/`set-read`/`vault list` 不再默认开场） |

## 刻意未做（后续）

- Phase 1：全局 `--dry-run`、对抗输入 fuzz
- MCP：`mark_*`、`doctor_wiki`、`export_bib`、stdio 传输
- clap `--help --json` 全树反射（由 `describe` 覆盖主路径）

## 原则

1. 一个内核（core ops + domain services），CLI / MCP 是适配器。
2. Skill 编码 invariants，不维护过期 flag 百科。
3. Agent 不是可信操作者：路径消毒、确认破坏操作、默认瘦列表。
