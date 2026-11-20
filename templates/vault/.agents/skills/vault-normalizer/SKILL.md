---
name: vault-normalizer
version: 3
description: Normalize an existing research directory into an Agentero vault layout. Use when reorganizing files, papers, notes, PDFs, TeX sources, marks, assets, attachments, or legacy Zotero/Obsidian-style folders to match Agentero directory and catalog conventions.
---

# Vault Normalizer

## Goal

Convert an existing research directory into an Agentero-compatible Vault without losing user-written notes or original files.

## Safety rules

- Inspect first; do not move, rename, delete, or overwrite files until the user approves a concrete migration plan.
- Preserve user-written Markdown, PDFs, TeX/source archives, annotations, Obsidian `[[wikilinks]]`, and any existing `AGENTS.md` content.
- If a directory already has `AGENTS.md`, read it as local instructions and do not replace it; only propose an append/merge draft when the user asks.
- Prefer copying or staged moves when the source directory is not already a Vault.
- Never treat `.agentero/catalog.sqlite` as disposable cache; it is the authoritative paper collection and metadata store.
- Do not make root `PAPERS.md`, `library.bib`, or per-paper `metadata.json` the source of truth. They are optional exports or projections.
- Treat link repair as a separate, reviewable change. Do not invent missing
  notes, select an ambiguous candidate, or rewrite a user-authored link without
  approval.

## Target layout

```text
agentero-vault/
├── AGENTS.md
├── papers/
│   ├── <paper-id-or-citekey>/
│   │   ├── NOTES.md
│   │   ├── <id>.pdf
│   │   ├── PAPER.md        # optional derived readable body
│   │   ├── marks/          # optional JSON highlights / asks / translations
│   │   ├── source/         # optional original TeX / e-print
│   │   ├── assets/         # optional note images or derived figures
│   │   └── attachments/    # optional extras: supplement PDFs, slides, code repos
│   └── <topic>/.../<paper-id-or-citekey>/
├── notes/
├── plans/
├── assets/                 # optional non-paper media
├── .agents/
│   └── skills/
└── .agentero/
    ├── catalog.sqlite
    ├── config.json
    └── .trash/
```

## Directory rules

- `papers/` contains all cataloged papers. Topic folders are allowed at any depth.
- A paper folder is the smallest paper unit and is recognized by direct children such as `NOTES.md`, `PAPER.md`, `marks/`, `source/`, `assets/`, or transitional `metadata.json`.
- A topic folder under `papers/` is not a paper unless it directly contains a paper marker.
- Catalog identity is the Vault-relative paper folder path, e.g. `papers/nlp/transformers/1706.03762`, not just the leaf directory name.
- Local PDFs for a paper should live at the paper folder root, not inside `source/`. Extra PDFs (supplement, slides, reviews) belong in `{paper}/attachments/`, not the paper root.
- TeX, arXiv e-print contents, and original source archives belong in `{paper}/source/`. Do not put user extras there.
- Supporting materials (code repos, datasets, extra PDFs) belong in `{paper}/attachments/`. Create that directory only when adding files; do not create empty `attachments/` folders. `attachments/` is not a paper-identity marker.
- User notes about one paper belong in `{paper}/NOTES.md`.
- For new organization, prefer `notes/` for concept notes and cross-paper notes, and `plans/` for research plans, TODOs, and drafts; do not force-move existing folders that already work for the user.
- Markdown-embedded images belong beside the Markdown file in `./assets/` and should use relative links like `![alt](./assets/file.png)`.
- PDF selection artifacts belong in `{paper}/marks/*.json`; do not write them into the PDF binary or catalog body.
- `.agentero/` is application state and should not be shown or edited as ordinary notes.

## Normalization workflow

1. Resolve whether the target is already a Vault:
   - Minimum app structure: `papers/` plus `.agentero/catalog.sqlite` or an app/CLI path to initialize it. `notes/`, `plans/`, and `AGENTS.md` are recommended but not required for preserving an existing organization.
   - If `AGENTS.md` already exists, treat it as authoritative local guidance and keep it unchanged.
   - If `agentero` exists, prefer `agentero vault list --json` to see recorded vaults.
2. Inventory the existing directory:
   - Identify PDFs, paper folders, TeX/source folders, Markdown notes, images/assets, BibTeX files, exported `PAPERS.md`, Zotero exports, and loose attachments.
   - Separate user-authored files from generated files.
   - When `agentero wiki check --json` is available, run it before migration and
     retain the complete `missing` / `ambiguous` / `invalidFragment` baseline.
     The command is read-only; a non-zero result carries the report in
     `error.details`.
3. Propose a migration table before editing:
   - Current path → target Vault-relative path
   - Operation: keep, copy, move, merge, import, or ignore
   - Risk: overwrite, ambiguous paper identity, duplicate PDF, missing metadata,
     or a wikilink target affected by the move
4. Create or ensure the Vault skeleton:
   - Required app structure: `papers/`, `.agents/skills/`, `.agentero/`; create `notes/` and `plans/` only when useful for the user's organization.
   - Ensure `AGENTS.md` exists only if missing. If it already exists, keep it unchanged.
   - Use `agentero vault create <path> --json` when available; otherwise create only missing directories and ask the app/CLI to initialize catalog later.
5. Normalize paper units:
   - Put each paper under `papers/<topic...>/<id-or-citekey>/`.
   - Put the main PDF at `{paper}/{id}.pdf` when identity is known; otherwise keep the original filename and record ambiguity.
   - Move TeX/source material to `{paper}/source/`.
   - Move supplement PDFs, slides, and cloned code repos to `{paper}/attachments/`.
   - Merge existing notes into `{paper}/NOTES.md` only with user approval; otherwise preserve as separate Markdown files and report them.
6. Normalize non-paper knowledge:
   - Recommend `notes/` for concept notes and literature maps, and `plans/` for plans/TODOs/drafts, but keep existing folder names when preserving them is clearer or safer.
   - Keep Obsidian wikilinks intact.
7. Rebuild or repair catalog metadata:
   - Prefer `agentero paper import id <identifier> --into <papers/topic> --json` for known DOI/arXiv/URL items.
   - For disk folders that already contain papers, use the app Rescan or CLI catalog commands if available.
   - Do not invent title, authors, year, DOI, or tags; mark unknowns explicitly.
8. Verify:
   - Run `agentero vault list --json` if available.
   - Confirm that paper paths, local PDFs, `NOTES.md`, `PAPER.md`/`source/`, and `marks/` are discoverable.
   - Run `agentero wiki check --json` again. For a staged subset, pass its
     Vault-relative Markdown file or directory to isolate that scope.
   - Compare the post-migration report with the baseline and separate
     pre-existing issues from links broken by this migration.
   - If the CLI command is unavailable, report that semantic link validation
     was not completed; do not substitute a regex-only parser and claim parity
     with Agentero.
   - Summarize remaining ambiguities and any files intentionally left in place.

## Wikilink diagnostics

Classify every reported occurrence without guessing:

| Status | Meaning | Default action |
| --- | --- | --- |
| `missing` | No compatible target exists | Propose an existing target, plain text, or an explicitly approved new note |
| `ambiguous` | More than one target matches | Present candidates and require a canonical Vault-relative choice |
| `invalidFragment` | The file resolves but its heading or block does not | Propose an existing full heading path or removal of the stale fragment |

Report source path, line, raw target, candidates, and whether the issue existed
before migration. Link changes belong in the migration table and require the
same confirmation as moves or merges.

## Migration heuristics

| Existing pattern | Target |
| --- | --- |
| `*.pdf` with DOI/arXiv/citekey known | `papers/<topic>/<id>/<id>.pdf` |
| folder with one PDF plus notes | `papers/<topic>/<id>/` |
| arXiv extracted TeX tree | `{paper}/source/` |
| parsed full-text Markdown | `{paper}/PAPER.md` |
| human reading notes for one paper | `{paper}/NOTES.md` |
| highlights / annotation JSON | `{paper}/marks/*.json` |
| supplement PDF / slides / cloned code | `{paper}/attachments/` |
| cross-paper notes / idea docs | prefer `notes/*.md`, or keep existing folder if clearer |
| research plans / TODO docs | prefer `plans/*.md`, or keep existing folder if clearer |
| exported `PAPERS.md` / `library.bib` | keep as export only; do not edit as authority |
| images used by a Markdown note | `{mdDir}/assets/*` with relative links |

## Response format

When asked to normalize a directory, respond with:

1. Current-structure findings.
2. Proposed target tree.
3. Migration table.
4. Required confirmations for overwrites, merges, or destructive moves.
5. Wikilink baseline and proposed repairs.
6. Exact commands or file operations to execute after approval.
7. Verification results, newly introduced link issues, and unresolved ambiguities.
