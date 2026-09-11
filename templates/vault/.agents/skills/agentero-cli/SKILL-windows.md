---
name: agentero-cli
version: 14
description: >-
  Use the Agentero CLI (bin `agentero-cli` on Windows) to create, discover, and
  inspect a local research vault and catalog—list/get papers, import by id/URL,
  check wikilinks, layout regions (figures/tables/formulas), region-anchored
  marks, download assets, parse PAPER.md, export bib—without BYOA. Prefer --json.
  Use when managing a vault headless, scripting Motif/Agentero, or exploring
  papers via machine APIs ($agentero-cli / /agentero-cli).
---

# Agentero CLI (Windows)

## Role

You use the **`agentero-cli` CLI** as a stable machine interface to an Agentero
vault. The CLI is **not** a chat runtime: no BYOA, no ACP, no paper-reader.
Reading and writing lecture-style `NOTES.md` is **your** job (or use the separate
`paper-reader` skill / desktop Zap workflow).

Design reference (repo): `docs/backend/cli.md`.

## Prerequisites

- Binary name: **`agentero-cli`** (Windows). Desktop: 设置 → 关于 → 安装 CLI
  writes the `agentero-cli.cmd` shim and adds its install dir to the **user
  PATH**; already-running terminals must be restarted to see it. If missing from
  PATH, say so and fall back to reading Vault files directly; do not invent
  catalog rows.
- Shells: examples use **PowerShell**. Quote args containing spaces or cmd
  metacharacters: cmd `"..."`, PowerShell `'...'`.
- Prefer always passing **`--json`** (disables interactive prompts). JSON is a
  compact single line; `--pretty` pretty-prints for humans.
- Destructive deletes: pass **`-y` / `--yes`** under `--json` / non-TTY.
- Vault resolution (first wins): `--vault <path>` → env `AGENTERO_VAULT` → cwd
  walk-up (`.agentero/catalog.sqlite`).

## Hard boundaries

| Do | Do not |
|---|---|
| Call CLI for vault/catalog/import/assets | Spawn coding agents via CLI |
| Read files at returned paths | Assume CLI wrote full lecture NOTES |
| Progressive disclosure L0→L4 | Dump entire PDF/TeX into the prompt by default |
| Skip overwrite of user NOTES on re-import | Force-overwrite without explicit user ask |

## Progressive disclosure (same as Vault model)

1. **L0** — `AGENTS.md` (if present)
2. **L1** — `agentero-cli paper list --json` — returns only `id/path/title` per
   row; add `--fields year,tags,abstract,…` as needed, or `--full` for whole records
3. **L2** — `{paper}/NOTES.md`
4. **L2.5** — layout index + marks
   - `agentero-cli layout list <paper> --json` (sidebar figures/tables/algorithms/formulas)
   - `{paper}/marks/annotations.json` (highlights / 批注) + `{paper}/marks/<id>.json`
     (asks / translates) — write these through the CLI, never by hand
5. **L3** — `{paper}/PAPER.md` (if no TeX)
6. **L4** — `{paper}/source/**` (TeX preferred when present)

After `paper get --json`, use `data.assets` (`marksDir` = reader annotations),
`data.suggestedReads` / `paper paths`, then `read_file` those paths. Do **not**
paste whole sources unless needed.

**Highlight / 批注 / translate a sentence (the CLI resolves the position):**

```powershell
# highlight; add --comment to make it a 批注 (same as a desktop selection note)
agentero-cli mark add <paper> --kind highlight --quote "…verbatim sentence…" --page 3 --comment "…" --mark-color yellow --json

# pin a translation next to the sentence (free MT, no API key)
agentero-cli mark add <paper> --kind translate --quote "…" --to zh-CN --json

# plain text translation, no mark
agentero-cli translate "…" --to zh-CN --json

# note a question to raise later
agentero-cli mark add <paper> --kind ask --quote "…" --question "…" --json
```

The quote is located with the PDF text engine, so **copy it verbatim** from
`PAPER.md` / the TeX source and keep it long enough to be unique. Whitespace,
case, typographic quotes/dashes, f-ligatures and line-break hyphenation are all
tolerated; a quote spanning a **page** break is not (search is per page). If several places
match, add `--page N`, pick one with `--match-index N`, or mark them all with
`--all`. On `mark_locate_failed` retry with a longer or more distinctive sentence
— **never** guess coordinates.

**Figures / formulas (preferred over inventing coordinates):**

```powershell
agentero-cli layout list <paper> --kind figure --json
agentero-cli mark add <paper> --region figure-3 --comment "…" --json
```

Requires `{paper}/source/layout-index.json` (written when the desktop runs layout
analysis). If `layout_index_missing`, tell the user to open the paper in Agentero
and run Figures analysis — do not invent bboxes.

Highlights/批注 land in `{paper}/marks/annotations.json` (the EmbedPDF transfer
blob); ask/translate stay per-id `{paper}/marks/<id>.json`. Let the CLI write both
— never hand-edit the transfer blob. Marks appear in an already-open reader within
a second or two.

Reader marks under `{paper}/marks/` can be referenced from Markdown as annotation
wikilinks: `[[papers/…/NOTES@<id>|label]]` / `![[…@<id>]]`. Prefer real ids from
`marks/` or the desktop copy action; do not invent ids. `agentero-cli doctor wiki`
validates path + fragment **shape** for `@id` / `#@id`, but does **not** verify
the id still exists.

## Default agent protocol

```powershell
# 1) Confirm vault root
agentero-cli vault which --json

# 2) L1 index — slim rows (optional filters: --unread, --query, --tag)
agentero-cli paper list --json
agentero-cli paper tag list --json

# 3) One paper: meta + asset flags + suggested paths
agentero-cli paper get <path|id> --json

# 4) Read files yourself in order: NOTES → marks/ → PAPER.md / TeX

# 5) Import (exact id / DOI / URL) — creates shell NOTES, not lecture body
agentero-cli import id <arxiv|doi|url> --json
# place the new paper under a specific vault-relative parent (default: papers)
agentero-cli import id <arxiv|doi|url> --parent papers/nlp --json
# parse body from PDF to PAPER.md if no TeX is present
agentero-cli paper parse <path> --json

# 6) Note & Read: write {path}/NOTES.md (lecture notes), check wikilinks (`agentero-cli doctor wiki`),
# then close the loop by marking the paper as read in the catalog:
agentero-cli paper set-read <path> --json

# 7) Tags: paper tag set|add|rm <path|id> … --json (clear: tag set --clear)
```

Cite Vault-relative paths in your answer; end with `## Sources` when substantial.

## Command discovery

Command groups: `vault`, `tree`, `paper`, `import`, `export`,
`layout`, `mark`, `translate`, `doctor`, `open`.
Run **`agentero-cli <group> --help`** for exact flags — it is the source of truth.
There is **no** `agentero-cli graph` command; never invent subcommands.

## JSON contract

- Success: `{ "ok": true, "data": … }` on stdout (compact; `--pretty` indents).
- Failure: non-zero exit + `{ "ok": false, "error": { "code", "message", "details" } }`.
- Stdout = result; stderr = progress/diagnostics. Parse `error.code` when retrying.
- `doctor wiki` returns non-zero on `missing` / `ambiguous` / `invalidFragment`;
  the structured report is in `error.details`.

## Path / id resolution

- Prefer **Vault-relative `path`** (e.g. `papers/1706.03762`).
- Bare **id**: if multiple rows match, CLI errors with candidates — retry with full `path`.

## Activation notes

Depending on the agent: **Codex** `$agentero-cli`, **Claude** `/agentero-cli`,
others follow this body directly.

## Rules

- Keep Obsidian wikilinks `[[...]]` when you edit Markdown.
- Never invent catalog metadata; trust CLI / files.
- Never overwrite user-written NOTES without explicit request.
- Always run `agentero-cli paper set-read <path>` after finishing NOTES.md to update catalog read status.
- Prefer short tool loops: list → get → read files → answer.
