//! Shared agent invariants (MCP instructions / resource + Skill pointers).

/// Short Markdown agents should follow. English to match vault AGENTS.md / skills.
pub fn agent_invariants_markdown() -> &'static str {
    r#"# Agentero agent invariants

These rules apply to both the `agentero` CLI and the loopback MCP server.

## Discovery

- Prefer machine contracts: CLI `agentero describe [op] --json`, or MCP resources `agentero://vault` and `agentero://agent-invariants`.
- Do not invent subcommands or MCP tools. Exact flags: `agentero describe <op> --json` or `agentero <group> --help`.
- Prefer `--json` on every CLI call (compact single-line envelope).

## Progressive disclosure (token discipline)

1. L0 — vault `AGENTS.md` (if present)
2. L1 — `paper list` / `paper_list` (default: only `id` / `path` / `title`; add `fields` or `full` only when needed)
3. L2 — `{paper}/NOTES.md`
4. L2.5 — layout index (`layout list` / `layout_list`) and marks (via CLI `mark`, not by hand-editing JSON)
5. L3 — `{paper}/PAPER.md` when no TeX
6. L4 — `{paper}/source/**` (prefer TeX)
7. A known vault text file outside a paper record — MCP `file_list` / `file_read` (one file, not a tree dump)

Never dump an entire PDF/TeX/body into context by default.

## Paths and refs

- Prefer vault-relative paper paths (`papers/1706.03762`). Bare ids that match multiple rows are ambiguous — retry with the full path.
- Reject path traversal (`..`). Do not embed query strings (`?fields=…`) inside refs or ids.

## Writes and safety

- Confirm with the user before overwriting user-written `NOTES.md` or any other file (`replace`). Prefer `append` when unsure.
- MCP `file_read` / `file_write` take a vault-relative path (`drafts/main.tex`, `notes/idea.md`). They are UTF-8 text only. `file_list` is one directory. Do not use them for `.agentero`, binaries, LaTeX build artifacts, marks, or layout indexes. `NOTES.md` writes still go through `paper_notes_write`.
- MCP `file_write_binary` saves an image or other binary file from base64 (`contentBase64`, at most 10 MiB decoded) and replaces an existing file; confirm before replacing.
- MCP `vault_list` returns every local vault the user has opened. Pass its path as `vault` to target one; the open vault remains the default. Unknown paths are rejected.
- MCP `paper_move` moves a paper/org folder under `papers/` (optionally to another vault); `file_move` is the generic exact-path move/rename. Both update wiki links and catalog paths.
- MCP `file_delete` defaults to the vault recycle bin (undoable); `permanent=true` is destructive and needs explicit confirmation.
- MCP `paper_tag_set` replaces user tags while keeping internal `@zotero:` / `@arxiv:` tags; `paper_tag_list` is the catalog inventory.
- Do not hand-edit `{paper}/marks/annotations.json` or `{paper}/source/layout-index.json`.
- Do not invent catalog metadata, layout bboxes, or mark coordinates. On `mark_locate_failed`, retry with a longer verbatim quote — never guess rects.
- If `layout_index_missing`, ask the user to open the paper in Agentero and run layout analysis; do not invent regions.
- Destructive deletes require explicit confirmation (`-y` / `--yes` on CLI).

## Surfaces

- **CLI**: full headless vault/catalog surface (no BYOA / paper-reader runtime).
- **MCP**: local vaults only (App must be running). Start with resource `agentero://vault`, then tools. Use `vault_list` to discover vaults; pass `vault` to target one other than the open vault. Paper tools use `ref`. Other vault text uses `file_list` / `file_read` / `file_write`, and binary files `file_write_binary`; `file_move` and `file_delete` handle moves and recycle-bin deletes.
- Lecture-style NOTES content is the agent's job (or the separate `paper-reader` skill), not the CLI/MCP.
"#
}
