---
name: openui-blocks
version: 1
# Bump when the component list or guidance changes; existing Vaults only
# auto-upgrade a bundled skill when this integer increases.
description: >-
  Write read-only OpenUI Lang UI blocks in Agentero chat replies. Use when a
  compact paper card, figure reference, claim list, outline, table, chart,
  steps or callout communicates better than prose.
  Not for interactive forms, buttons or stateful widgets.
---

# OpenUI Blocks

Reply with at most one fenced `openui-lang` block when a compact visual answer
clearly helps. Keep the normal prose answer outside the fence. Prefer Markdown
when it is enough, especially for a single table.

## Rules

- Fence info string: `openui-lang`. The root must be `root = Stack([...])`.
- Arguments are positional; strings use double quotes; arrays use `[...]`.
- Use only the components listed below. Do not invent props or components.
- `source` / `path` must be a Vault-relative file path or citation target:
  `papers/<id>/<id>.pdf#page=<N>`, `#figure=<N>`, `#formula=<N>`,
  `#section=<x.y>` (numbers are placeholders; only use anchors that exist).
  Numbered equations use `#formula=N`, never `#equation=`. Never put a
  human-readable label such as "Table 3, Section 4.2" there; use `label`,
  `caption` or `detail` for display text. Unrecognized targets stay as text.
- Never invent a numbered PDF anchor. `#figure=N`, `#table=N`, `#formula=N`,
  `#algorithm=N` and `#section=...` must exist in the paper's layout: check
  `agentero layout list <paper> --kind <kind> --json`, or read
  `{paper}/source/layout-index.json` when the CLI is unavailable. Formulas may
  also live as `\tag{N}` in `{paper}/source/layout.json`. Only a matching
  numbered id, title/caption, or `\tag{N}` counts; an unnumbered region of that
  kind is not a citation. If the number is not there, use a verified `#page=N`
  or omit `source`; a PDF existing is not the same as the anchor existing.
- `Outline` section `level` is **1-based** (1 = top, 2 = subsection);
  `Tree` `depth` is 0-based. Never use `level: 0`.
- Read-only v1: no state, bindings, queries, mutations, actions, HTML, scripts,
  or nested code fences.
- Keep data small: at most 8 table columns / 60 rows, 24 chart points, 12 steps,
  40 list items, 20 timeline items, 60 tree items, 20 tags or sources.
- If the app rejects the block, it shows the source and a short reason. Fall
  back to Markdown rather than retrying the same invalid program.
- One block per reply. Do not put a block inside a sentence.

## Example

```openui-lang
root = Stack([title, table, chart])
title = Text("Results", "heading")
table = Table(["Model", "Score"], [["A", "91"], ["B", "87"]])
chart = BarChart("Scores", ["A", "B"], [91, 87], "%")
```

## Components

<!-- BEGIN GENERATED COMPONENTS -->
- `Stack(children: (Text | Badge | Callout | KeyValue | Table | Stat | Progress | Steps | BarChart | LineChart | PaperCard | FigureRef | ClaimList | Outline | Timeline | Tree | TagList | SourceList | Row | Card)[], gap?: "sm" | "md" | "lg")` — vertical root container
- `Row(children: (Text | Badge | Callout | KeyValue | Table | Stat | Progress | Steps | BarChart | LineChart | PaperCard | FigureRef | ClaimList | Outline | Timeline | Tree | TagList | SourceList)[], gap?: "sm" | "md" | "lg")` — horizontal row; wraps on narrow screens
- `Card(title: string, children: (Text | Badge | Callout | KeyValue | Table | Stat | Progress | Steps | BarChart | LineChart | PaperCard | FigureRef | ClaimList | Outline | Timeline | Tree | TagList | SourceList | Row)[])` — titled container for a group of components
- `Text(markdown: string, variant?: "body" | "heading" | "caption")` — Markdown text; variant body|heading|caption
- `Badge(label: string, tone?: "neutral" | "info" | "success" | "warning" | "danger")` — small status pill
- `Callout(title: string, body: string, tone?: "info" | "success" | "warning" | "danger")` — short note with tone info|success|warning|danger
- `KeyValue(items: {label: string, value: string | number}[])` — label/value rows for metadata
- `Table(columns: string[], rows: string[][], caption?: string)` — data table; prefer a Markdown table when it is the whole answer
- `Stat(label: string, value: string, hint?: string)` — one key number with an optional hint
- `Progress(label: string, value: number, max?: number)` — progress bar; max defaults to 100
- `Steps(title: string, steps: string[])` — ordered steps
- `BarChart(title: string, labels: string[], values: number[], unit?: string)` — categorical bars; labels and values must be equal length
- `LineChart(title: string, labels: string[], values: number[], unit?: string)` — values over labels; labels and values must be equal length
- `PaperCard(paper: {title: string, authors: string, year?: string, venue?: string, path?: string, status?: "unread" | "reading" | "read" | "queued", tags?: string[]})` — paper identity card: title, authors, year, venue, status, tags and vault path
- `FigureRef(label: string, caption?: string, source?: string, kind?: "figure" | "table" | "formula" | "algorithm" | "section")` — reference card for a figure, table, formula (numbered equation), algorithm or section
- `ClaimList(title: string, claims: {claim: string, status: "supports" | "contradicts" | "mixed" | "unclear", evidence?: string, source?: string}[])` — claims with support/contradict/mixed/unclear status, evidence and source
- `Outline(title: string, sections: {title: string, level?: number, page?: number, source?: string}[])` — paper outline with nesting; section level is 1-based (1 = top, 2 = subsection), optional page and source
- `Timeline(title?: string, items: {title: string, description?: string}[])` — vertical timeline of titled items
- `Tree(title?: string, items: {label: string, depth?: number}[])` — indented tree; depth starts at 0
- `TagList(tags: string[])` — wrapped tag pills
- `SourceList(sources: {label: string, detail?: string, path?: string}[])` — source list with a label, optional detail and source path
<!-- END GENERATED COMPONENTS -->
