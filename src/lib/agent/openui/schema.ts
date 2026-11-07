import type { LibraryJSONSchema } from "@openuidev/lang-core";

/**
 * Read-only component catalog for Phase 1. The order of `properties` is the
 * positional argument order in OpenUI Lang, and `required` drives the parser's
 * validation. Keep this in sync with the Rust guidance and docs.
 */
export const OPENUI_COMPONENT_NAMES = [
	"Stack",
	"Row",
	"Text",
	"Table",
	"Stat",
	"BarChart",
	"Steps",
	"Callout",
] as const;

export type OpenUiComponentName = (typeof OPENUI_COMPONENT_NAMES)[number];

const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const stringProp = { type: "string" } as const;
const stringArray = { type: "array", items: stringProp } as const;

export const OPENUI_SCHEMA = {
	$defs: {
		Stack: {
			type: "object",
			properties: {
				children: {
					type: "array",
					items: { anyOf: OPENUI_COMPONENT_NAMES.map((name) => ref(name)) },
				},
				gap: { type: "string", enum: ["sm", "md", "lg"] },
			},
			required: ["children"],
		},
		Row: {
			type: "object",
			properties: {
				children: {
					type: "array",
					items: { anyOf: OPENUI_COMPONENT_NAMES.map((name) => ref(name)) },
				},
				gap: { type: "string", enum: ["sm", "md", "lg"] },
			},
			required: ["children"],
		},
		Text: {
			type: "object",
			properties: {
				text: stringProp,
				variant: {
					type: "string",
					enum: ["body", "heading", "caption", "code"],
				},
			},
			required: ["text"],
		},
		Table: {
			type: "object",
			properties: {
				columns: stringArray,
				rows: {
					type: "array",
					items: { type: "array", items: stringProp },
				},
				caption: stringProp,
			},
			required: ["columns", "rows"],
		},
		Stat: {
			type: "object",
			properties: {
				label: stringProp,
				value: stringProp,
				hint: stringProp,
			},
			required: ["label", "value"],
		},
		BarChart: {
			type: "object",
			properties: {
				title: stringProp,
				labels: stringArray,
				values: { type: "array", items: { type: "number" } },
				unit: stringProp,
			},
			required: ["title", "labels", "values"],
		},
		Steps: {
			type: "object",
			properties: {
				title: stringProp,
				steps: stringArray,
			},
			required: ["title", "steps"],
		},
		Callout: {
			type: "object",
			properties: {
				title: stringProp,
				body: stringProp,
				tone: {
					type: "string",
					enum: ["info", "success", "warning", "danger"],
				},
			},
			required: ["title", "body"],
		},
		Any: {
			anyOf: OPENUI_COMPONENT_NAMES.map((name) => ref(name)),
		},
	},
	properties: Object.fromEntries(
		OPENUI_COMPONENT_NAMES.map((name) => [name, ref(name)]),
	),
} satisfies LibraryJSONSchema;

/**
 * Human-readable signatures used by docs and tests. The Rust prompt carries a
 * shorter version; keep both in sync when the catalog changes.
 */
export const OPENUI_COMPONENT_SIGNATURES: Record<OpenUiComponentName, string> =
	{
		Stack: "Stack(children: UIBlock[], gap?: sm|md|lg)",
		Row: "Row(children: UIBlock[], gap?: sm|md|lg)",
		Text: "Text(text: string, variant?: body|heading|caption|code)",
		Table: "Table(columns: string[], rows: string[][], caption?: string)",
		Stat: "Stat(label: string, value: string, hint?: string)",
		BarChart:
			"BarChart(title: string, labels: string[], values: number[], unit?: string)",
		Steps: "Steps(title: string, steps: string[])",
		Callout:
			"Callout(title: string, body: string, tone?: info|success|warning|danger)",
	};
