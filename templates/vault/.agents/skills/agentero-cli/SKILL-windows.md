---
name: agentero-cli
version: 18
description: >-
  Use the Agentero CLI (bin `agentero-cli` on Windows) to create, discover, and
  inspect a local research vault and catalog—list/get papers, import by id/URL/PDF,
  layout regions, reading marks, download assets, parse PAPER.md, export bib—
  without BYOA. Prefer --json. Discover unknown flags via `agentero-cli describe`.
  Use when managing a vault headless, scripting Motif/Agentero, or exploring
  papers via machine APIs ($agentero-cli / /agentero-cli).
---

# Agentero CLI (Windows)

## Role

You use the **`agentero-cli` CLI** as a stable machine interface to an Agentero
vault. The CLI is **not** a chat runtime: no BYOA, no ACP, no paper-reader.
Reading and writing lecture-style `NOTES.md` is **your** job (or use the separate
`paper-reader` skill / desktop manual read workflow).

## Prerequisites

- Binary name: **`agentero-cli`** (Windows). Desktop: 设置 → 关于 → 安装 CLI
  writes the `agentero-cli.cmd` shim and adds its install dir to the **user
  PATH**; already-running terminals must be restarted to see it. If missing from
  PATH, say so and fall back to reading Vault files directly; do not invent
  catalog rows.
- Shells: examples use **PowerShell**. Quote args containing spaces or cmd
  metacharacters: cmd `"..."`, PowerShell `'...'`.
- Prefer always passing **`--json`** (disables interactive prompts). JSON is a
  compact single line; `--pretty` pretty-prints for humans (avoid in tool loops).
- Destructive deletes: pass **`-y` / `--yes`** under `--json` / non-TTY.
- Vault resolution (first wins): `--vault <path>` → env `AGENTERO_VAULT` → cwd
  walk-up (`.agentero/catalog.sqlite`). When cwd is already the vault, do **not**
  start with `vault list`.

## Command discovery

Use `describe` only when you do **not** already know the flags:

```powershell
agentero-cli describe --json
agentero-cli describe paper.list --json
agentero-cli <group> --help
```

Do **not** invent subcommands. There is no `agentero-cli graph`. Do **not** pair
`describe` with every `list`/`get` call.

## Hard boundaries

| Do | Do not |
|---|---|
| Call CLI for vault/catalog/import/layout/marks | Spawn coding agents via CLI |
| Read files at returned paths | Assume CLI wrote full lecture NOTES |
| Progressive disclosure L0→L4 | Dump entire PDF/TeX into the prompt by default |
| Skip overwrite of user NOTES on re-import | Force-overwrite without explicit user ask |
| Use `describe` when flags are unknown | Hand-edit `marks/annotations.json` or `layout-index.json` |

## Progressive disclosure

1. **L0** — `AGENTS.md` (if present; usually already in context)
2. **L1** — only when discovering the collection: `agentero-cli paper list --json`
   (default rows: `id/path/title`; add `--fields` / `--full` only if needed)
3. **L2** — `{paper}/NOTES.md` when the user asks about a known paper
4. **L2.5** — `agentero-cli layout list <paper>` / `agentero-cli mark *`
5. **L3** — `{paper}/PAPER.md` (if no TeX)
6. **L4** — `{paper}/source/**` (TeX preferred when present)

Skip levels you do not need. A known paper path does **not** require `paper list`
or `vault list` first.

## Task protocols (pick one)

**Known paper path (QA / summary / short claim)** — prefer files; CLI only if you
need catalog fields the files lack:

```powershell
agentero-cli paper get papers/<shelf>/<id> --json
# then read NOTES.md → (TeX | PAPER.md) as needed
```

**Explore / list the collection:**

```powershell
agentero-cli paper list --json
```

**Import / download / parse / tag:**

```powershell
agentero-cli import id <arxiv|doi|url> --json
agentero-cli import pdf <path...> --json
agentero-cli paper download papers/<…> --json
agentero-cli paper parse papers/<…> --json
agentero-cli paper tag add papers/<…> "label:color" --json
```

**Layout / marks** — paper path is **required**:

```powershell
agentero-cli layout list papers/<…> --json
agentero-cli layout list papers/<…> --kind figure --json
agentero-cli mark list papers/<…> --json
```

**After a paper-reader / explicit “mark as read” workflow only:**

```powershell
agentero-cli paper set-read papers/<…> --json
```

Do **not** run `set-read` after ordinary Q&A or summary that did not finish NOTES.

## JSON contract

- Success: `{ "ok": true, "data": … }` on stdout (compact; `--pretty` indents).
- Failure: non-zero exit + `{ "ok": false, "error": { "code", "message", "details" } }`.
- Stdout = result; stderr = progress/diagnostics. Parse `error.code` when retrying.

## Path / id resolution

- Prefer **Vault-relative `path`** (e.g. `papers/nlp/1706.03762`).
- Bare **id** may hit `paper_ambiguous` when the same id exists under multiple
  shelves — retry immediately with a `path` from `error.details.candidates`.
- Prefer path from the user / `@` mention / prior `paper list` row; do not probe
  with bare id when a path is already known.

## Invariants

- On `mark_locate_failed`, retry with a longer verbatim quote — **never** guess coordinates.
- On `layout_index_missing`, ask the user to open the paper in Agentero and run Figures analysis — do not invent bboxes.
- Keep Obsidian wikilinks `[[...]]` when you edit Markdown.
- Never invent catalog metadata; trust CLI / files.
- Prefer short tool loops: the fewest CLI/file reads that answer the question.

## Activation notes

Depending on the agent: **Codex** `$agentero-cli`, **Claude** `/agentero-cli`,
**Pi** `/skill:agentero-cli`, others follow this body directly.
