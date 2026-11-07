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

function render(
	source: string,
	streaming = false,
	onOpenSource?: (source: string) => void,
) {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(
		createElement(OpenUiBlock, { source, streaming, onOpenSource }),
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

	it("renders Markdown inside Text", () => {
		const element = render(
			'root = Stack([text])\ntext = Text("**Bold** and $x^2$")',
		);
		expect(
			element.querySelector('[data-streamdown="strong"]')?.textContent,
		).toBe("Bold");
		expect(element.querySelector(".katex")).not.toBeNull();
	});

	it("renders the non-Markdown and research components", () => {
		const source = `root = Stack([card, badge, kv, progress, line, paper, figure, claims, outline, timeline, tree, tags, sources, row])
card = Card("Overview", [row])
row = Row([Text("A"), Text("B")])
badge = Badge("Stable", "success")
kv = KeyValue([{label: "Model", value: "A"}, {label: "Score", value: 91}])
progress = Progress("Coverage", 42, 100)
line = LineChart("Trend", ["Q1", "Q2"], [3, 5], "%")
paper = PaperCard({title: "Paper", authors: "A. Author", year: "2024", venue: "NeurIPS", path: "papers/x/x.pdf", status: "read", tags: ["LLM"]})
figure = FigureRef("Figure 2", "Architecture", "papers/x/x.pdf#figure=2", "figure")
claims = ClaimList("Claims", [{claim: "**Claim**", status: "supports", evidence: "Evidence", source: "papers/x/x.pdf#page=3"}])
outline = Outline("Outline", [{title: "Intro", level: 1, page: 1, source: "papers/x/x.pdf#page=1"}])
timeline = Timeline("History", [{title: "Start", description: "Begin"}])
tree = Tree("Tree", [{label: "Root"}, {label: "Child", depth: 1}])
tags = TagList(["a", "b"])
sources = SourceList([{label: "Paper", detail: "arXiv", path: "papers/x/x.pdf"}])`;
		const element = render(source, false, vi.fn());
		for (const name of [
			"Card",
			"Badge",
			"KeyValue",
			"Progress",
			"LineChart",
			"PaperCard",
			"FigureRef",
			"ClaimList",
			"Outline",
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
		expect(element.textContent).toContain("Paper");
		expect(element.textContent).toContain("Figure 2");
		expect(element.textContent).toContain("Intro");
		expect(element.querySelector('[role="progressbar"]')).not.toBeNull();
		expect(
			element.querySelector('[data-streamdown="strong"]')?.textContent,
		).toBe("Claim");
		expect(element.querySelector("button")).not.toBeNull();
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
