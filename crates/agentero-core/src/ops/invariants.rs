//! Agent invariants split by surface: interface-independent rules shared by
//! the CLI and MCP, plus surface-specific sections. Each entry point serves
//! only its own combination so clients never see the other surface's commands
//! (issue #1141). CLI-specific guidance lives in the bundled agentero-cli skill.

/// Interface-independent rules every agent surface must follow.
pub fn common_invariants_markdown() -> &'static str {
    r#"## Progressive disclosure (token discipline)

1. L0 — vault `AGENTS.md` (if present)
2. L1 — paper list (default: only `id` / `path` / `title`; add `fields` or `full` only when needed)
3. L2 — `{paper}/NOTES.md`
4. L2.5 — layout index and marks (never hand-edit their JSON files)
5. L3 — `{paper}/PAPER.md` when no TeX
6. L4 — `{paper}/source/**` (prefer TeX)
7. A known vault text file outside a paper record — list, then read one file, not a tree dump

Never dump an entire PDF/TeX/body into context by default.

## Paths and refs

- Prefer vault-relative paper paths (`papers/1706.03762`). Bare ids that match multiple rows are ambiguous — retry with the full path.
- Reject path traversal (`..`). Do not embed query strings (`?fields=…`) inside refs or ids.

## Writes and safety

- Confirm with the user before overwriting user-written `NOTES.md` or any other file (`replace`). Prefer `append` when unsure.
- Destructive deletes require explicit confirmation.
- Do not hand-edit `{paper}/marks/annotations.json` or `{paper}/source/layout-index.json`.
- Do not invent catalog metadata, layout bboxes, or mark coordinates. On `mark_locate_failed`, retry with a longer verbatim quote — never guess rects.
- If `layout_index_missing`, ask the user to open the paper in Agentero and run layout analysis; do not invent regions.
- Lecture-style NOTES content is the agent's job (or the separate `paper-reader` skill), not the tool surface.
"#
}

/// MCP-only rules. Served with the common section by the loopback MCP server;
/// must not reference CLI commands — MCP clients may have no shell on the
/// server host.
pub fn mcp_invariants_markdown() -> &'static str {
    r#"# Agentero agent invariants (MCP)

These rules apply to the loopback MCP server. Use the MCP resources and tools below; do not run shell commands — your environment may have no shell on the host running this server.

## Discovery

- Start with resources `agentero://vault` and `agentero://agent-invariants`, then the tools.
- Do not invent MCP tools. Use only the tools this server lists.

## Tools

- `vault_list` returns every local vault the user has opened. Pass its path as `vault` to target one; the open vault remains the default. Unknown paths are rejected.
- Paper tools use `ref` (a paper id or vault-relative path).
- Layout regions use `layout_list` / `layout_get` / `page_read`; they require desktop layout analysis to have run.
- `file_read` / `file_write` take a vault-relative path (`drafts/main.tex`, `notes/idea.md`). `file_read` is UTF-8 text only. `file_write` defaults to UTF-8 text; use `encoding: "base64"` for images and other binaries (standard padded Base64, no data URL prefix, replace only, at most 2 MiB decoded). `file_list` is one directory. Do not use them for `.agentero`, LaTeX build artifacts, marks, or layout indexes. `NOTES.md` writes still go through `paper_notes_write`.
- Research tables (`*.table.json`) use `table_query`, `table_upsert`, and `table_update_cells`. Do not `file_write` an existing `*.table.json`. `expectedRevision` comes from `table_query`. Cells are addressed by registry id and field name. `file_read` still returns a table under 2 MiB; larger tables use `table_query`. `vault_search` includes `*.table.json`; a hit path may be that file, and `table_query` is how you read the matching rows. `file_write` refuses to replace or append a Markdown note whose frontmatter is `type: experiment` and `status: locked` (`experiment_locked`). Creating a new file is allowed.
- `paper_move` moves a paper/org folder under `papers/` (optionally to another vault); `file_move` is the generic exact-path move/rename. Both update wiki links and catalog paths.
- `file_delete` defaults to the vault recycle bin (undoable); `permanent=true` is destructive and needs explicit confirmation.
- `paper_tag_set` replaces user tags while keeping internal `@zotero:` / `@arxiv:` tags; `paper_tag_list` is the catalog inventory.
- Marks have no MCP write tool; ask the user to create them in the Agentero app. Never hand-edit mark JSON.

## Surface

Local vaults only (App must be running). Start with resource `agentero://vault`, then tools. Use `vault_list` to discover vaults; pass `vault` to target one other than the open vault. Paper tools use `ref`. Other vault text uses `file_list` / `file_read` / `file_write`; `file_move` and `file_delete` handle moves and recycle-bin deletes. Research tables use `table_query` / `table_upsert` / `table_update_cells`.
"#
}
