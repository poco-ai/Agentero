import { createSlateEditor } from "platejs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeadingElement } from "@/components/editor/nodes/block/heading-node";
import { queryTocHeadings } from "@/components/editor/overlays/toc-sidebar";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";

describe("Markdown table of contents", () => {
	it("mirrors each Plate heading node id to its DOM id for scroll tracking", () => {
		const headingId = "heading-node-id";
		const markup = renderToStaticMarkup(
			createElement(HeadingElement, {
				attributes: {},
				children: "Heading",
				editor: {
					api: {
						isBlock: () => true,
					},
				},
				element: {
					id: headingId,
					type: "h2",
					children: [{ text: "Heading" }],
				},
				variant: "h2",
			} as unknown as Parameters<typeof HeadingElement>[0]),
		);

		expect(markup).toContain(`id="${headingId}"`);
	});
});

describe("Markdown TOC heading query", () => {
	const createEditor = () =>
		createSlateEditor({
			plugins: MarkdownKit,
			value: [
				{ id: "alpha", type: "h1", children: [{ text: "Alpha" }] },
				{ id: "body", type: "p", children: [{ text: "body" }] },
				{
					id: "quote",
					type: "blockquote",
					children: [{ id: "beta", type: "h2", children: [{ text: "Beta" }] }],
				},
				{ id: "untitled", type: "h3", children: [{ text: "" }] },
			],
		});

	it("collects nested headings in document order and skips untitled ones", () => {
		const headings = queryTocHeadings(createEditor());

		expect(
			headings.map((heading) => [heading.id, heading.depth, heading.path]),
		).toEqual([
			["alpha", 1, [0]],
			["beta", 2, [2, 0]],
		]);
	});

	it("holds the list reference across an edit that leaves headings untouched", () => {
		const editor = createEditor();
		const first = queryTocHeadings(editor);

		editor.tf.insertText("!", { at: { path: [1, 0], offset: 4 } });

		expect(queryTocHeadings(editor)).toBe(first);
	});

	it("refreshes stale heading paths after a block is inserted above them", () => {
		const editor = createEditor();
		const first = queryTocHeadings(editor);

		editor.tf.insertNodes(
			{ id: "lead", type: "p", children: [{ text: "lead" }] },
			{ at: [0] },
		);
		const next = queryTocHeadings(editor);

		// Same headings, so the reference is held for the sidebar and its observer.
		expect(next).toBe(first);
		expect(next.map((heading) => heading.path)).toEqual([[1], [3, 0]]);
	});

	it("rebuilds the list when a heading title changes", () => {
		const editor = createEditor();
		const first = queryTocHeadings(editor);

		editor.tf.insertText("!", { at: { path: [0, 0], offset: 5 } });
		const next = queryTocHeadings(editor);

		expect(next).not.toBe(first);
		expect(next.map((heading) => heading.title)).toEqual(["Alpha!", "Beta"]);
	});
});
