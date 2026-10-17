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
7. A known vault text file outside a paper record — CLI `file list/read` or MCP `file_list` / `file_read` (one file, not a tree dump)

Never dump an entire PDF/TeX/body into context by default.

## Paths and refs

- Prefer vault-relative paper paths (`papers/1706.03762`). Bare ids that match multiple rows are ambiguous — retry with the full path.
- Reject path traversal (`..`). Do not embed query strings (`?fields=…`) inside refs or ids.

## Writes and safety

- Confirm with the user before overwriting user-written `NOTES.md` or any other file (`replace`). Prefer `append` when unsure.
- CLI `file read/write` and MCP `file_read` / `file_write` take a vault-relative path (`drafts/main.tex`, `notes/idea.md`). They are UTF-8 text only. `file list` / `file_list` is one directory. Do not use them for `.agentero`, binaries, LaTeX build artifacts, marks, or layout indexes. `NOTES.md` writes go through CLI `paper notes write` or MCP `paper_notes_write`.
- Do not hand-edit `{paper}/marks/annotations.json` or `{paper}/source/layout-index.json`.
- Do not invent catalog metadata, layout bboxes, or mark coordinates. On `mark_locate_failed`, retry with a longer verbatim quote — never guess rects.
- If `layout_index_missing`, ask the user to open the paper in Agentero and run layout analysis; do not invent regions.
- Destructive deletes require explicit confirmation (`-y` / `--yes` on CLI).

## Surfaces

- **CLI**: full headless vault/catalog surface (no BYOA / paper-reader runtime).
- **MCP**: current open local vault only (App must be running). Start with resource `agentero://vault`, then tools. Paper tools use `ref`. Other vault text uses `file_list` / `file_read` / `file_write`.
- Lecture-style NOTES content is the agent's job (or the separate `paper-reader` skill), not the CLI/MCP.
"#
}
