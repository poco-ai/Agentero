import type { ElementNode } from "@openuidev/lang-core";
import { describe, expect, it } from "vitest";
import { agentTextFromParts } from "@/lib/agent/chat-state";
import { prepareAgentMessageMarkdown } from "@/lib/agent/message-markdown";
import {
	BAR_CHART_WIDTH,
	buildBarChartGeometry,
	buildLineChartGeometry,
} from "@/lib/agent/openui/chart";
import {
	isOpenUiLanguage,
	OPENUI_MAX_SOURCE_CHARS,
} from "@/lib/agent/openui/config";
import { openUiTableToGfm } from "@/lib/agent/openui/format";
import {
	OPENUI_COMPONENT_NAMES,
	OPENUI_COMPONENT_SIGNATURES,
} from "@/lib/agent/openui/generated/catalog";
import {
	checkOpenUiLimits,
	createOpenUiParser,
	mergePartialTree,
	normalizeOpenUiTags,
	protectOpenUiBlocks,
	resolveOpenUiBlock,
	validateOpenUiShape,
} from "@/lib/agent/openui/parse";

const ALL_COMPONENTS = `root = Stack([heading, table, stats, chart, steps, note, row], "md")
heading = Text("Results", "heading")
table = Table(["Model", "Score"], [["A", "91"], ["B", "87"]], "Benchmark")
stats = Stat("Best", "91", "model A")
chart = BarChart("Scores", ["A", "B"], [91, 87], "%")
steps = Steps("Pipeline", ["Parse", "Evaluate"])
note = Callout("Note", "Small sample.", "warning")
row = Row([Text("Left"), Text("Right")], "sm")`;

function parseSettled(source: string) {
	const parser = createOpenUiParser();
	const result = parser.set(source, true);
	return {
		result,
		resolved: resolveOpenUiBlock({
			source,
			result,
			streaming: false,
			lastValid: null,
		}),
	};
}

describe("OpenUI block parsing", () => {
	it("keeps the documented signatures aligned with the parser catalog", () => {
		for (const name of OPENUI_COMPONENT_NAMES) {
			expect(OPENUI_COMPONENT_SIGNATURES[name]).toContain(name);
		}
	});

	it("parses the read-only catalog into an element tree", () => {
		const { resolved } = parseSettled(ALL_COMPONENTS);
		expect(resolved.view.kind).toBe("ready");
		if (resolved.view.kind !== "ready") return;

		expect(resolved.view.root.typeName).toBe("Stack");
		const children = resolved.view.root.props.children as ElementNode[];
		expect(children.map((child) => child.typeName)).toEqual([
			"Text",
			"Table",
			"Stat",
			"BarChart",
			"Steps",
			"Callout",
			"Row",
		]);
		expect(children[1]?.props.rows).toEqual([
			["A", "91"],
			["B", "87"],
		]);
		expect(resolved.lastValid).toBe(resolved.view.root);
	});

	it("falls back to source for unknown components and invalid props", () => {
		const unknown = parseSettled('root = Stack([bad])\nbad = Unknown("x")')
			.resolved.view;
		expect(unknown.kind).toBe("failed");
		if (unknown.kind === "failed") expect(unknown.reason).toBe("invalid");

		const wrongType = parseSettled("root = Stack([text])\ntext = Text(123)")
			.resolved.view;
		expect(wrongType.kind).toBe("failed");
		if (wrongType.kind === "failed") expect(wrongType.reason).toBe("invalid");
	});

	it("rejects state and query statements in the read-only surface", () => {
		const stateful = parseSettled(
			'$count = 1\nroot = Stack([text])\ntext = Text("Hello")',
		).resolved.view;
		expect(stateful.kind).toBe("failed");
		if (stateful.kind === "failed") expect(stateful.reason).toBe("invalid");

		const query = parseSettled(
			'root = Stack([data])\ndata = Query("tools", {}, [])\ntext = Text("Hello")',
		).resolved.view;
		expect(query.kind).toBe("failed");
	});

	it("accepts research components without optional source fields", () => {
		const { resolved } =
			parseSettled(`root = Stack([paper, figure, claims, outline])
paper = PaperCard({title: "Paper", authors: "A. Author"})
figure = FigureRef("Figure 1")
claims = ClaimList("Claims", [{claim: "A claim", status: "unclear"}])
outline = Outline("Outline", [{title: "Intro"}])`);
		expect(resolved.view.kind).toBe("ready");
	});

	it("rejects semantic refinements from the shared zod schema", () => {
		const progress = parseSettled(
			'root = Stack([p])\np = Progress("Coverage", 120, 100)',
		).resolved.view;
		expect(progress.kind).toBe("failed");
		if (progress.kind === "failed") expect(progress.reason).toBe("invalid");

		const line = parseSettled(
			'root = Stack([c])\nc = LineChart("Trend", ["A"], [1, 2])',
		).resolved.view;
		expect(line.kind).toBe("failed");
	});

	it("reports an unclosed block as incomplete instead of rendering stale data", () => {
		const source = 'root = Stack([text])\ntext = Text("Hi';
		const { resolved } = parseSettled(source);
		expect(resolved.view.kind).toBe("failed");
		if (resolved.view.kind === "failed") {
			expect(resolved.view.reason).toBe("incomplete");
		}
	});

	it("keeps malformed chart series out of the renderer", () => {
		const source =
			'root = Stack([chart])\nchart = BarChart("Scores", ["A", "B"], [1])';
		const { result } = parseSettled(source);
		expect(result.root).not.toBeNull();
		expect(validateOpenUiShape(result.root as ElementNode)).toBe("invalid");
		const { resolved } = parseSettled(source);
		expect(resolved.view.kind).toBe("failed");
	});

	it("falls back when table data exceeds the rendering limits", () => {
		const rows = Array.from({ length: 61 }, (_, index) => `["${index}"]`);
		const source = `root = Stack([table])\ntable = Table(["N"], [${rows.join(", ")}])`;
		const { result } = parseSettled(source);
		expect(checkOpenUiLimits(result.root as ElementNode)).toBe("tooLarge");
		const { resolved } = parseSettled(source);
		expect(resolved.view.kind).toBe("failed");
		if (resolved.view.kind === "failed") {
			expect(resolved.view.reason).toBe("tooLarge");
		}
	});

	it("rejects source larger than the hard cap before parsing", () => {
		const source = `root = Stack([])\n${" ".repeat(OPENUI_MAX_SOURCE_CHARS)}`;
		const { resolved } = parseSettled(source);
		expect(resolved.view.kind).toBe("failed");
		if (resolved.view.kind === "failed") {
			expect(resolved.view.reason).toBe("tooLarge");
		}
	});

	it("treats an empty fence as empty rather than a parse error", () => {
		const { resolved } = parseSettled("   ");
		expect(resolved.view.kind).toBe("failed");
		if (resolved.view.kind === "failed") {
			expect(resolved.view.reason).toBe("empty");
		}
	});
});

describe("OpenUI streaming props", () => {
	it("keeps the last complete props for a node that is still streaming", () => {
		const previous: ElementNode = {
			type: "element",
			typeName: "Stack",
			props: {
				children: [
					{
						type: "element",
						typeName: "Text",
						props: { text: "Hello" },
						partial: false,
						statementId: "title",
					},
				],
			},
			partial: false,
			statementId: "root",
		};
		const current: ElementNode = {
			type: "element",
			typeName: "Stack",
			props: {
				children: [
					{
						type: "element",
						typeName: "Text",
						props: { text: "Hel" },
						partial: true,
						statementId: "title",
					},
					{
						type: "element",
						typeName: "Text",
						props: { text: "New" },
						partial: false,
						statementId: "extra",
					},
				],
			},
			partial: true,
			statementId: "root",
		};

		const merged = mergePartialTree(current, previous);
		const children = merged?.props.children as ElementNode[];
		expect(children).toHaveLength(2);
		expect(children[0]?.props.text).toBe("Hello");
		expect(children[1]?.props.text).toBe("New");
	});

	it("emits a streaming placeholder until the root can be parsed", () => {
		const parser = createOpenUiParser();
		const source = 'x = Text("hi")';
		const result = parser.set(source, false);
		const resolved = resolveOpenUiBlock({
			source,
			result,
			streaming: true,
			lastValid: null,
		});
		expect(resolved.view.kind).toBe("streaming");
		if (resolved.view.kind === "streaming") {
			expect(resolved.view.root).toBeNull();
		}
	});
});

describe("OpenUI fence and tag normalization", () => {
	it("normalizes a standalone <openui-lang> tag into a fence", () => {
		const normalized = normalizeOpenUiTags(
			"before\n<openui-lang>\nroot = Stack([])\n</openui-lang>\nafter",
		);
		expect(normalized).toContain("```openui-lang\nroot = Stack([])\n```");
	});

	it("does not rewrite tags inside a Markdown fence", () => {
		const markdown =
			"```markdown\n<openui-lang>\nroot = Stack([])\n</openui-lang>\n```";
		expect(normalizeOpenUiTags(markdown)).toBe(markdown);
	});

	it("leaves an unclosed tag as an unclosed fence for streaming", () => {
		const normalized = normalizeOpenUiTags("<openui-lang>\nroot = Stack([])");
		expect(normalized.startsWith("```openui-lang\n")).toBe(true);
		expect(normalized.endsWith("```")).toBe(false);
	});

	it("keeps block source out of Markdown math and link preprocessing", () => {
		const normalized = normalizeOpenUiTags(
			'<openui-lang>\nroot = Stack([text])\ntext = Text("\\pi_\\theta")\n',
		);
		const protectedBlocks = protectOpenUiBlocks(normalized);
		const prepared = protectedBlocks.restore(
			prepareAgentMessageMarkdown(protectedBlocks.text),
		);
		expect(prepared).toContain('text = Text("\\pi_\\theta")');
		expect(prepared).not.toContain("$\\pi_\\theta$");
	});

	it("accepts both openui-lang and the shorter openui info string", () => {
		expect(isOpenUiLanguage("openui-lang")).toBe(true);
		expect(isOpenUiLanguage("openui")).toBe(true);
		expect(isOpenUiLanguage("markdown")).toBe(false);
	});
});

describe("OpenUI table and chart formatting", () => {
	it("generates the same GFM table shape the chat table renderer uses", () => {
		expect(
			openUiTableToGfm(
				["Model", "Note"],
				[
					["A", "pipe | inside"],
					["B", "line\nbreak"],
				],
			),
		).toBe(
			"| Model | Note |\n| --- | --- |\n| A | pipe \\| inside |\n| B | line break |",
		);
	});

	it("builds finite SVG geometry for chart bars", () => {
		const geometry = buildBarChartGeometry(["A", "B"], [10, 20], "%");
		expect(geometry.width).toBe(BAR_CHART_WIDTH);
		expect(geometry.bars).toHaveLength(2);
		expect(geometry.bars[0]?.valueLabel).toBe("10%");
		expect(geometry.bars[1]?.height).toBeGreaterThan(
			geometry.bars[0]?.height ?? 0,
		);
	});

	it("scales charts to the measured width and thins dense axis labels", () => {
		const labels = Array.from({ length: 12 }, (_, index) => `Run ${index + 1}`);
		const values = labels.map((_, index) => index + 1);
		const bar = buildBarChartGeometry(labels, values, "%", 320);
		expect(bar.width).toBe(320);
		expect(bar.labelStep).toBeGreaterThan(1);
		const line = buildLineChartGeometry(labels, values, "%", 320);
		expect(line.width).toBe(320);
		expect(line.labelStep).toBeGreaterThan(1);
	});
});

describe("OpenUI source retention", () => {
	it("keeps the fenced source in the text part used by copy and history replay", () => {
		const source = "Answer.\n\n```openui-lang\nroot = Stack([])\n```";
		expect(
			agentTextFromParts([{ type: "text", id: "part-1", text: source }]),
		).toBe(source);
	});
});
