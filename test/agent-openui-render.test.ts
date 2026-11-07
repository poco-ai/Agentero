// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { extractTableDataFromElement, tableDataToMarkdown } from "streamdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenUiBlock } from "@/components/agent/rendering/openui/openui-block";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, args?: { title?: string }) =>
			args?.title ? `${key}:${args.title}` : key,
	}),
}));
vi.mock("@/hooks/use-highlighted-code", () => ({
	useHighlightedCode: (code: string) => code.split("\n"),
}));
vi.mock("@/lib/core/clipboard", () => ({
	copyTextToClipboard: vi.fn(async () => true),
}));

const ALL_COMPONENTS = `root = Stack([heading, table, stats, chart, steps, note, row])
heading = Text("Results", "heading")
table = Table(["Model", "Score"], [["A", "91"], ["B", "87"]], "Benchmark")
stats = Stat("Best", "91", "model A")
chart = BarChart("Scores", ["A", "B"], [91, 87], "%")
steps = Steps("Pipeline", ["Parse", "Evaluate"])
note = Callout("Note", "Small sample.", "warning")
row = Row([Text("Left"), Text("Right")], "sm")`;

let host: HTMLDivElement | null = null;

function render(source: string, streaming = false) {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(
		createElement(OpenUiBlock, { source, streaming }),
	);
	document.body.append(container);
	host = container;
	return container;
}

afterEach(() => {
	host?.remove();
	host = null;
});

describe("OpenUI rendering", () => {
	it("renders the eight read-only components with theme primitives", () => {
		const element = render(ALL_COMPONENTS);
		expect(element.querySelector('[data-openui-state="ready"]')).not.toBeNull();
		expect(element.textContent).toContain("Results");
		expect(element.textContent).toContain("Benchmark");
		expect(element.textContent).toContain("Best");
		expect(element.textContent).toContain("Scores");
		expect(element.textContent).toContain("Pipeline");
		expect(element.textContent).toContain("Small sample.");
		expect(element.textContent).toContain("Left");
		expect(element.textContent).toContain("Right");
		expect(
			element.querySelector('[data-openui-component="Stat"]'),
		).not.toBeNull();
		expect(element.querySelector("svg[role='img']")).not.toBeNull();
	});

	it("renders the remaining read-only components", () => {
		const source = `root = Stack([card, badge, kv, progress, line, quote, code, math, divider, list, timeline, tree, tags, sources, row])
card = Card("Overview", [row])
row = Row([Text("A"), Text("B")])
badge = Badge("Stable", "success")
kv = KeyValue([{label: "Model", value: "A"}, {label: "Score", value: 91}])
progress = Progress("Coverage", 42, 100)
line = LineChart("Trend", ["Q1", "Q2"], [3, 5], "%")
quote = Quote("A quote", "Source")
code = Code("print(1)", "python")
math = Math("x^2", true)
divider = Divider("Section")
list = List(["one", "two"], true)
timeline = Timeline("History", [{title: "Start", description: "Begin"}])
tree = Tree("Tree", [{label: "Root"}, {label: "Child", depth: 1}])
tags = TagList(["a", "b"])
sources = SourceList([{label: "Paper", detail: "arXiv"}])`;
		const element = render(source);
		for (const name of [
			"Card",
			"Badge",
			"KeyValue",
			"Progress",
			"LineChart",
			"Quote",
			"Code",
			"Math",
			"Divider",
			"List",
			"Timeline",
			"Tree",
			"TagList",
			"SourceList",
		]) {
			expect(
				element.querySelector(`[data-openui-component="${name}"]`),
			).not.toBeNull();
		}
		expect(element.textContent).toContain("Overview");
		expect(element.textContent).toContain("Stable");
		expect(element.textContent).toContain("Coverage");
		expect(element.textContent).toContain("A quote");
		expect(element.textContent).toContain("print(1)");
		expect(element.textContent).toContain("Paper");
		expect(element.querySelector('[role="progressbar"]')).not.toBeNull();
		expect(element.querySelector("blockquote")).not.toBeNull();
	});

	it("reuses the chat table renderer and its copy payload", () => {
		const element = render(ALL_COMPONENTS);
		const table = element.querySelector("table");
		expect(table).not.toBeNull();
		const data = extractTableDataFromElement(table as HTMLTableElement);
		expect(tableDataToMarkdown(data)).toContain(
			"| Model | Score |\n| --- | --- |\n| A | 91 |\n| B | 87 |",
		);
	});

	it("shows fixed copy for an empty table and an empty chart", () => {
		const emptyTable = render(
			'root = Stack([table])\ntable = Table(["A"], [])',
		);
		expect(emptyTable.textContent).toContain("uiBlock.tableEmpty");

		const emptyChart = render(
			'root = Stack([chart])\nchart = BarChart("Scores", [], [])',
		);
		expect(emptyChart.textContent).toContain("uiBlock.chartEmpty");
	});

	it("falls back to the exact source with a short reason", () => {
		const source = 'root = Stack([bad])\nbad = Unknown("x")';
		const element = render(source);
		expect(
			element.querySelector('[data-openui-fallback="invalid"]'),
		).not.toBeNull();
		expect(element.textContent).toContain("uiBlock.invalid");
		expect(element.textContent).toContain('bad = Unknown("x")');
	});

	it("shows a streaming placeholder before a root statement exists", () => {
		const element = render('x = Text("hi")', true);
		expect(element.querySelector("[data-openui-streaming]")).not.toBeNull();
		expect(element.textContent).toContain("uiBlock.streaming");
	});
});
