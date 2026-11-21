// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { extractTableDataFromElement, tableDataToMarkdown } from "streamdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageResponse } from "@/components/agent/message";
import { OpenUiBlock } from "@/components/agent/rendering/openui/openui-block";

vi.mock("react-i18next", () => import("./helpers/i18n"));
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

function renderMessage(
	children: string,
	enableOpenUiBlocks?: boolean,
	isAnimating = false,
) {
	return renderToStaticMarkup(
		createElement(
			MessageResponse as never,
			{
				children,
				enableOpenUiBlocks,
				isAnimating,
			} as never,
		),
	);
}

let host: HTMLDivElement | null = null;

function renderBlock(
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

describe("MessageResponse OpenUI integration", () => {
	it("renders an opt-in openui-lang fence as a structured block", () => {
		const html = renderMessage(
			'Prose before.\n\n```openui-lang\nroot = Stack([title])\ntitle = Text("Hello")\n```',
			true,
		);
		expect(html).toContain("data-openui-block");
		expect(html).toContain("Hello");
		expect(html).toContain("Prose before.");
	});

	it("keeps the plain Markdown path when the surface does not opt in", () => {
		const html = renderMessage(
			'```openui-lang\nroot = Stack([title])\ntitle = Text("Hello")\n```',
		);
		expect(html).not.toContain("data-openui-block");
		expect(html).toContain("openui-lang");
	});

	it("does not treat a fence nested inside another code block as a block", () => {
		const html = renderMessage(
			'````markdown\n```openui-lang\nroot = Stack([title])\ntitle = Text("Nested")\n```\n````',
			true,
		);
		expect(html).not.toContain("data-openui-block");
		expect(html).toContain("openui-lang");
	});

	it("accepts the shorter openui alias", () => {
		const html = renderMessage(
			'```openui\nroot = Stack([title])\ntitle = Text("Short")\n```',
			true,
		);
		expect(html).toContain("data-openui-block");
		expect(html).toContain("Short");
	});

	it("normalizes the <openui-lang> tag form only with opt-in", () => {
		const source =
			'<openui-lang>\nroot = Stack([title])\ntitle = Text("Tagged")\n</openui-lang>';
		expect(renderMessage(source, true)).toContain("data-openui-block");
		expect(renderMessage(source, true)).toContain("Tagged");
		expect(renderMessage(source)).not.toContain("data-openui-block");
	});

	it("keeps streaming state for an unclosed fence", () => {
		const html = renderMessage(
			'```openui-lang\nroot = Stack([title])\ntitle = Text("Hel',
			true,
			true,
		);
		expect(html).toContain("data-openui-block");
		expect(html).toContain('data-openui-state="streaming"');
		expect(html).toContain("Hel");
	});

	it("renders a mermaid fence through the shared editor Mermaid block", () => {
		const html = renderMessage("```mermaid\ngraph LR\n  A --> B\n```");
		expect(html).toContain("group/mermaid");
	});

	it("falls back to the source plus a short reason for invalid blocks", () => {
		const html = renderMessage(
			'```openui-lang\nroot = Stack([bad])\nbad = Unknown("x")\n```',
			true,
		);
		expect(html).toContain('data-openui-fallback="invalid"');
		expect(html).toContain("uiBlock.invalid");
		expect(html).toContain("bad = Unknown");
	});
});

describe("OpenUI rendering", () => {
	it("renders Markdown inside Text", () => {
		const element = renderBlock(
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
		const element = renderBlock(source, false, vi.fn());
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
		const element = renderBlock(ALL_COMPONENTS);
		const table = element.querySelector("table");
		expect(table).not.toBeNull();
		const data = extractTableDataFromElement(table as HTMLTableElement);
		expect(tableDataToMarkdown(data)).toContain(
			"| Model | Score |\n| --- | --- |\n| A | 91 |\n| B | 87 |",
		);
	});

	it("keeps non-path source labels as text instead of broken links", () => {
		const element = renderBlock(
			'root = Stack([figure])\nfigure = FigureRef("Table 3", "Results", "Table 3, Section 4.2", "table")',
			false,
			vi.fn(),
		);
		expect(element.querySelector("button")).toBeNull();
		expect(element.textContent).toContain("Table 3, Section 4.2");
	});

	it("shows a source action for a recognized citation target", () => {
		const element = renderBlock(
			'root = Stack([figure])\nfigure = FigureRef("Figure 2", "Architecture", "papers/x/x.pdf#figure=2", "figure")',
			false,
			vi.fn(),
		);
		expect(element.querySelector("button")).not.toBeNull();
	});

	it("shows fixed copy for an empty table and an empty chart", () => {
		const emptyTable = renderBlock(
			'root = Stack([table])\ntable = Table(["A"], [])',
		);
		expect(emptyTable.textContent).toContain("uiBlock.tableEmpty");

		const emptyChart = renderBlock(
			'root = Stack([chart])\nchart = BarChart("Scores", [], [])',
		);
		expect(emptyChart.textContent).toContain("uiBlock.chartEmpty");
	});

	it("falls back to the exact source with a short reason", () => {
		const source = 'root = Stack([bad])\nbad = Unknown("x")';
		const element = renderBlock(source);
		expect(
			element.querySelector('[data-openui-fallback="invalid"]'),
		).not.toBeNull();
		expect(element.textContent).toContain("uiBlock.invalid");
		expect(element.textContent).toContain('bad = Unknown("x")');
	});

	it("shows a streaming placeholder before a root statement exists", () => {
		const element = renderBlock('x = Text("hi")', true);
		expect(element.querySelector("[data-openui-streaming]")).not.toBeNull();
		expect(element.textContent).toContain("uiBlock.streaming");
	});
});
