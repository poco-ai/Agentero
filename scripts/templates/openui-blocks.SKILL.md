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
<!-- END GENERATED COMPONENTS -->
