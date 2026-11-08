---
name: openui-blocks
version: 2
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
  `papers/<id>/<id>.pdf#page=3`, `#figure=2`, `#section=4.2`. Never put a
  human-readable label such as "Table 3, Section 4.2" there; use `label`,
  `caption` or `detail` for display text. Unrecognized targets stay as text.
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
