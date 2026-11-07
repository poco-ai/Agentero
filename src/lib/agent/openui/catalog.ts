import {
	createLibrary,
	defineComponent,
	type LibraryJSONSchema,
} from "@openuidev/lang-core";
import { z } from "zod";

/**
 * Single source of truth for the read-only OpenUI catalog.
 *
 * `blockProps` is used twice:
 * - `defineComponent` turns the same Zod object into parser schemas and prompt
 *   signatures, so positional argument order and types cannot drift.
 * - post-parse validation (`validateOpenUiShape`) reuses the schema after the
 *   parser has materialized the element tree.
 *
 * Child slots use `z.json()` here and typed component refs in the parser
 * definitions below; this keeps the render tree loose while the language knows
 * which parents accept which components.
 */
const node = z.json();
const nodes = z.array(node);

const gap = z.enum(["sm", "md", "lg"]);
const textVariant = z.enum(["body", "heading", "caption", "code"]);
const tone = z.enum(["info", "success", "warning", "danger"]);

export const blockProps = {
	Stack: z.object({
		children: nodes,
		gap: gap.optional(),
	}),
	Row: z.object({
		children: nodes,
		gap: gap.optional(),
	}),
	Text: z.object({
		text: z.string(),
		variant: textVariant.optional(),
	}),
	Table: z.object({
		columns: z.array(z.string()).min(1),
		rows: z.array(z.array(z.string())),
		caption: z.string().optional(),
	}),
	Stat: z.object({
		label: z.string(),
		value: z.string(),
		hint: z.string().optional(),
	}),
	BarChart: z
		.object({
			title: z.string(),
			labels: z.array(z.string()),
			values: z.array(z.number()),
			unit: z.string().optional(),
		})
		.refine((value) => value.labels.length === value.values.length, {
			message: "labels and values must have the same length",
		})
		.refine((value) => value.values.every((item) => item >= 0), {
			message: "values must be non-negative",
		}),
	Steps: z.object({
		title: z.string(),
		steps: z.array(z.string()),
	}),
	Callout: z.object({
		title: z.string(),
		body: z.string(),
		tone: tone.optional(),
	}),
} as const;

export type BlockName = keyof typeof blockProps;

export const OPENUI_COMPONENT_NAMES = Object.keys(blockProps) as BlockName[];

const Text = defineComponent({
	name: "Text",
	description: "plain text; variant body|heading|caption|code",
	props: blockProps.Text,
	component: null,
});
const Table = defineComponent({
	name: "Table",
	description:
		"data table; prefer a Markdown table when it is the whole answer",
	props: blockProps.Table,
	component: null,
});
const Stat = defineComponent({
	name: "Stat",
	description: "one key number with an optional hint",
	props: blockProps.Stat,
	component: null,
});
const BarChart = defineComponent({
	name: "BarChart",
	description: "categorical bars; labels and values must be equal length",
	props: blockProps.BarChart,
	component: null,
});
const Steps = defineComponent({
	name: "Steps",
	description: "ordered steps",
	props: blockProps.Steps,
	component: null,
});
const Callout = defineComponent({
	name: "Callout",
	description: "short note with tone info|success|warning|danger",
	props: blockProps.Callout,
	component: null,
});

const leafRefs = [
	Text.ref,
	Table.ref,
	Stat.ref,
	BarChart.ref,
	Steps.ref,
	Callout.ref,
] as const;
const leaf = z.union(leafRefs);

const Row = defineComponent({
	name: "Row",
	description: "horizontal row; wraps on narrow screens",
	props: blockProps.Row.extend({
		children: z.array(leaf),
	}),
	component: null,
});

const Stack = defineComponent({
	name: "Stack",
	description: "vertical root container",
	props: blockProps.Stack.extend({
		children: z.array(z.union([...leafRefs, Row.ref])),
	}),
	component: null,
});

export const uiBlockLibrary = createLibrary({
	components: [Stack, Row, Text, Table, Stat, BarChart, Steps, Callout],
	root: "Stack",
});

/** JSON Schema handed to the streaming parser at module scope. */
export const OPENUI_SCHEMA: LibraryJSONSchema = uiBlockLibrary.toJSONSchema();
