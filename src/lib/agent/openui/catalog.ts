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
const calloutTone = z.enum(["info", "success", "warning", "danger"]);
const badgeTone = z.enum(["neutral", "info", "success", "warning", "danger"]);

const chartProps = {
	title: z.string(),
	labels: z.array(z.string()),
	values: z.array(z.number()),
	unit: z.string().optional(),
};

const equalChartSeries = (value: { labels: string[]; values: number[] }) =>
	value.labels.length === value.values.length;
const nonNegativeValues = (value: { values: number[] }) =>
	value.values.every((item) => item >= 0);

export const blockProps = {
	Stack: z.object({
		children: nodes,
		gap: gap.optional(),
	}),
	Row: z.object({
		children: nodes,
		gap: gap.optional(),
	}),
	Card: z.object({
		title: z.string(),
		children: nodes,
	}),
	Text: z.object({
		text: z.string(),
		variant: textVariant.optional(),
	}),
	Badge: z.object({
		label: z.string(),
		tone: badgeTone.optional(),
	}),
	Callout: z.object({
		title: z.string(),
		body: z.string(),
		tone: calloutTone.optional(),
	}),
	KeyValue: z.object({
		items: z.array(
			z.object({
				label: z.string(),
				value: z.union([z.string(), z.number()]),
			}),
		),
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
	Progress: z
		.object({
			label: z.string(),
			value: z.number(),
			max: z.number().positive().optional(),
		})
		.refine((value) => value.value >= 0, {
			message: "value must be non-negative",
		})
		.refine((value) => value.value <= (value.max ?? 100), {
			message: "value must not exceed max",
		}),
	Steps: z.object({
		title: z.string(),
		steps: z.array(z.string()),
	}),
	BarChart: z
		.object(chartProps)
		.refine(equalChartSeries, {
			message: "labels and values must have the same length",
		})
		.refine(nonNegativeValues, {
			message: "values must be non-negative",
		}),
	LineChart: z
		.object(chartProps)
		.refine(equalChartSeries, {
			message: "labels and values must have the same length",
		})
		.refine(nonNegativeValues, {
			message: "values must be non-negative",
		}),
	Quote: z.object({
		text: z.string(),
		source: z.string().optional(),
	}),
	Code: z.object({
		code: z.string(),
		language: z.string().optional(),
	}),
	Math: z.object({
		tex: z.string(),
		display: z.boolean().optional(),
	}),
	Divider: z.object({
		label: z.string().optional(),
	}),
	List: z.object({
		items: z.array(z.string()),
		ordered: z.boolean().optional(),
	}),
	Timeline: z.object({
		title: z.string().optional(),
		items: z.array(
			z.object({
				title: z.string(),
				description: z.string().optional(),
			}),
		),
	}),
	Tree: z.object({
		title: z.string().optional(),
		items: z.array(
			z.object({
				label: z.string(),
				depth: z.number().int().nonnegative().optional(),
			}),
		),
	}),
	TagList: z.object({
		tags: z.array(z.string()),
	}),
	SourceList: z.object({
		sources: z.array(
			z.object({
				label: z.string(),
				detail: z.string().optional(),
			}),
		),
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
const Badge = defineComponent({
	name: "Badge",
	description: "small status pill",
	props: blockProps.Badge,
	component: null,
});
const Callout = defineComponent({
	name: "Callout",
	description: "short note with tone info|success|warning|danger",
	props: blockProps.Callout,
	component: null,
});
const KeyValue = defineComponent({
	name: "KeyValue",
	description: "label/value rows for metadata",
	props: blockProps.KeyValue,
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
const Progress = defineComponent({
	name: "Progress",
	description: "progress bar; max defaults to 100",
	props: blockProps.Progress,
	component: null,
});
const Steps = defineComponent({
	name: "Steps",
	description: "ordered steps",
	props: blockProps.Steps,
	component: null,
});
const BarChart = defineComponent({
	name: "BarChart",
	description: "categorical bars; labels and values must be equal length",
	props: blockProps.BarChart,
	component: null,
});
const LineChart = defineComponent({
	name: "LineChart",
	description: "values over labels; labels and values must be equal length",
	props: blockProps.LineChart,
	component: null,
});
const Quote = defineComponent({
	name: "Quote",
	description: "short quotation with an optional source",
	props: blockProps.Quote,
	component: null,
});
const Code = defineComponent({
	name: "Code",
	description: "read-only code block with language highlighting",
	props: blockProps.Code,
	component: null,
});
const MathFormula = defineComponent({
	name: "Math",
	description: "display or inline TeX formula",
	props: blockProps.Math,
	component: null,
});
const Divider = defineComponent({
	name: "Divider",
	description: "horizontal separator with an optional label",
	props: blockProps.Divider,
	component: null,
});
const List = defineComponent({
	name: "List",
	description: "bullet or numbered list",
	props: blockProps.List,
	component: null,
});
const Timeline = defineComponent({
	name: "Timeline",
	description: "vertical timeline of titled items",
	props: blockProps.Timeline,
	component: null,
});
const Tree = defineComponent({
	name: "Tree",
	description: "indented tree; depth starts at 0",
	props: blockProps.Tree,
	component: null,
});
const TagList = defineComponent({
	name: "TagList",
	description: "wrapped tag pills",
	props: blockProps.TagList,
	component: null,
});
const SourceList = defineComponent({
	name: "SourceList",
	description: "source list with a label and optional detail",
	props: blockProps.SourceList,
	component: null,
});

const leafRefs = [
	Text.ref,
	Badge.ref,
	Callout.ref,
	KeyValue.ref,
	Table.ref,
	Stat.ref,
	Progress.ref,
	Steps.ref,
	BarChart.ref,
	LineChart.ref,
	Quote.ref,
	Code.ref,
	MathFormula.ref,
	Divider.ref,
	List.ref,
	Timeline.ref,
	Tree.ref,
	TagList.ref,
	SourceList.ref,
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

const Card = defineComponent({
	name: "Card",
	description: "titled container for a group of components",
	props: blockProps.Card.extend({
		children: z.array(z.union([...leafRefs, Row.ref])),
	}),
	component: null,
});

const Stack = defineComponent({
	name: "Stack",
	description: "vertical root container",
	props: blockProps.Stack.extend({
		children: z.array(z.union([...leafRefs, Row.ref, Card.ref])),
	}),
	component: null,
});

export const uiBlockLibrary = createLibrary({
	components: [
		Stack,
		Row,
		Card,
		Text,
		Badge,
		Callout,
		KeyValue,
		Table,
		Stat,
		Progress,
		Steps,
		BarChart,
		LineChart,
		Quote,
		Code,
		MathFormula,
		Divider,
		List,
		Timeline,
		Tree,
		TagList,
		SourceList,
	],
	root: "Stack",
});

/** JSON Schema handed to the streaming parser at module scope. */
export const OPENUI_SCHEMA: LibraryJSONSchema = uiBlockLibrary.toJSONSchema();
