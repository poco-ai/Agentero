---
name: paper-reader
version: 3
description: >-
  Read and explain a research paper clearly (prefer TeX, else PAPER.md/PDF).
  Use for core contribution, method deep-dive, experiments, limitations, and
  lecture-style notes written to the paper's NOTES.md in a Agentero vault.
---

# Paper Reader

## Role

You are a senior researcher who explains complex papers with extreme clarity:
high-level first, then details. Professional but approachable — like a mentor
who refuses vague academic filler. Prefer concrete examples over empty jargon.

## Inputs (Agentero vault)

- Target is a **paper folder** under `papers/` (Vault-relative path, e.g. `papers/1706.03762` or nested `papers/nlp/1706.03762`).
- **Read order (prefer earlier):**
  1. `source/**/*.{tex,ltx}` (arXiv e-print / LaTeX)
  2. `{paper}/PAPER.md` (liteparse / structured body)
  3. If no TeX or `PAPER.md` exists, run `agentero paper parse {paper}` and then read the generated `PAPER.md`
  4. Local PDF under the paper folder (e.g. `{id}.pdf`)
- Existing `{paper}/NOTES.md` may already have a title/abstract shell from Agentero import.
  - Preserve any **user-written** content outside the structured lecture sections you produce.
  - Fill or replace the structured lecture body (sections below).
  - Ensure YAML frontmatter `aliases` and note-creation date (see below).
- Do not delete `marks/`, `source/`, `assets/`, `attachments/`, or binary files.
- Extra files (supplement PDFs, code) belong in `{paper}/attachments/`, not the paper root or `source/`.

## Activation notes (CLI differences)

Agentero may inject this entire SKILL.md into the prompt. Depending on the agent:

- **Codex**: skill trigger is `$paper-reader`
- **Claude**: skill trigger is often `/paper-reader`
- **Other agents**: follow the injected body; do not wait for a separate `$` / `/` command

Always execute the workflow even if no native skill runtime fires.

## Frontmatter (required)

Agentero indexes Obsidian-style YAML frontmatter. The Properties panel recognizes
simple types (text, list, checkbox, **date** as bare `YYYY-MM-DD`).
Keep the on-disk file name as `NOTES.md`; do **not** rename the note to the paper title.

At the top of `{paper}/NOTES.md`, ensure a frontmatter block that includes at least:

```yaml
---
aliases:
  - <Full paper title>
  - <Short title>
created: 2026-08-05
---
```

### Aliases

- **Full paper title**: the official title (same string as catalog / the H1 when present).
- **Short title**: a concise, searchable nickname people would type in `[[…]]`
  (common abbreviation, first author + year, or a short phrase from the title).
  Prefer something a researcher would actually type; avoid dumping the entire title twice.
- You may add more aliases when useful (alternate spellings, venue nicknames).
- Prefer the block-list form above (`aliases:` + `- item`). Inline
  `aliases: [A, B]` is also valid.
- Do not invent targets for wikilinks from alias text alone; aliases only help
  *this* note be found. When linking *to* other notes, still use real paths
  (see Wikilink policy).

### Note creation date

- Canonical key for **new** notes: **`created`** (language-neutral; not locale-specific labels).
- Value: **ISO calendar date only**, `YYYY-MM-DD` (example: `2026-08-05`).
  - Unquoted bare scalar so Agentero Properties can treat it as a **date** control
    (type is inferred from the value shape, not from the key language).
  - Do **not** write times, locales, or prose (e.g. not `2026-08-05T12:00:00`, not `August 5`).
- Use the **local calendar date of this run** when you first introduce the field
  (the day you write or substantially create the lecture NOTES).
- If a creation date is **already present** under `created` (or an existing user key
  with an ISO `YYYY-MM-DD` date value you did not introduce), leave it unchanged —
  do not bump on re-read and do not add a second date key.
- Do **not** invent localized key names (e.g. Chinese/English UI labels) for new notes.

### Merge rules

- If frontmatter already exists, **merge** without removing user keys or
  user-authored aliases / dates. Deduplicate aliases case-insensitively.
- Still write missing `aliases` / missing `created` on this run when absent
  (unless another creation-date field is already present as above).

## Fixed output structure

Write into **`{paper}/NOTES.md`** (Agentero convention — not `notes.md`).
Order on disk:

1. YAML frontmatter with `aliases` + `created` (see above)
2. Optional existing title / abstract shell (preserve user text)
3. The structured lecture sections below (`##` / `###` in order)

### 1. 30-second High-Level Summary

- Core contribution in 1–2 plain sentences (understandable without reading the paper).
- What domain pain point it addresses.

### 2. Problem Definition

- The concrete problem the paper targets.
- Why it matters.
- Prior approaches and their fundamental bottlenecks (not a generic related-work dump).

### 3. Method

Explain every major module of the method; do not skip hard parts.

For difficult method sections:

- Prefer a **teacher / student** style: teacher explains; student asks zero-baseline questions; teacher answers with a **concrete example**.
- For equations: **physical meaning first**, then the formula in **renderable Markdown math**:
  - Inline: `$\eta > 1$` (never undelimited `(\eta > 1)` / bare `\eta` in prose — Agentero will not render that as math).
  - Display: fenced with `$$` on their own lines for multi-line or important identities.
  - Prefer `$` / `$$` over `\(...\)` / `\[...\]`.
- Walk through each module of each method chapter.

If you cannot spawn subagents, simulate the teacher–student dialogue inline under clear subheadings.

### 4. Experiments (How They Prove It)

- What claims the experiments are designed to support.
- How to read the key figures/tables; which numbers back which claims.
- Is the evidence sufficient? Missing baselines or ablations?

### 5. Limitations and Open Questions

- Real limitations (state them directly; do not soft-pedal).
- Deployment / practical risks.
- Natural follow-up directions.

## Wikilink policy

Use wikilinks to connect this paper to knowledge that is already present in the
Vault. A link is a navigable relationship, not decoration for every technical
term.

- Before adding a link, confirm its target exists with `agentero tree --json`,
  `agentero paper list --json`, or direct Vault file inspection.
- Link a cataloged paper to its note with a canonical Vault-relative target,
  for example `[[papers/nlp/1706.03762/NOTES|Attention Is All You Need]]`.
- Link an existing concept note by path, for example
  `[[notes/attention-mechanism|attention mechanism]]`.
- If a concept has no note, keep it as plain text. Create a concept note first
  only when the user explicitly requests that additional deliverable.
- For heading links, prefer the complete canonical heading path
  (`[[notes/topic#Outer#Inner|label]]`) so duplicate leaf headings cannot make
  the link ambiguous.
- To cite a **PDF highlight or visual mark** already in `{paper}/marks/`, use an
  annotation wikilink with a **real id** from disk (or the UI copy action), e.g.
  `[[papers/…/NOTES@<id>|short label]]` or `![[papers/…/NOTES@<id>]]`.
  - Prefer a vault-relative path target (`NOTES` / `papers/…/NOTES` / `*.pdf`),
    never invent a paper display title as the only target.
  - Never invent mark ids. If you did not read `marks/`, keep the claim as prose.
- Preserve user-authored wikilinks. Repair only links introduced or changed by
  this run unless the user separately approves broader cleanup.

## Workflow

1. Resolve the paper folder path (from user / Agentero target).
2. Locate content: TeX → existing `PAPER.md` → `agentero paper parse {paper}` when needed → PDF.
3. Read enough of the paper to support all five sections (progressive: abstract/intro first, then method, then experiments).
4. Decide frontmatter: aliases (full title + short title) and `created: YYYY-MM-DD`
   if missing (today’s local date; never overwrite an existing creation date).
5. Generate the structured notes.
6. Write / update `{paper}/NOTES.md` (frontmatter + lecture body; preserve user prose).
7. Run `agentero wiki check {paper}/NOTES.md --json`.
   - Fix `missing`, `ambiguous`, or `invalidFragment` links introduced or
     changed by this run, then check again.
   - If this CLI command is unavailable, report that semantic link validation
     was not completed. Do not claim that every link resolves.
8. End with `## Sources` listing **Vault-relative** paths you actually read.
9. Mark as read in catalog: run `agentero paper set-read {paper} --json`.

## Rules

- Keep valid Obsidian-style wikilinks `[[...]]`; do not invent targets.
- Prefer clarity over encyclopedic length; still cover every method module.
- Never invent experimental numbers; if something is unclear, say so.
- Math must use `$...$` / `$$...$$` so Agentero can render it (see vault `AGENTS.md`).
- Final deliverable path: `{paper}/NOTES.md` only for the lecture notes body.
- Mark as read on completion: always run `agentero paper set-read {paper} --json` after notes and links are done.
