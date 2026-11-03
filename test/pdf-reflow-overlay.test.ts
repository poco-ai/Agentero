import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LayoutTranslateOverlay } from "@/components/viewer/pdf/layers/layout-translate-overlay";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import { paragraphFromCharacters } from "@/lib/pdf/reflow/extract";

it("renders PDF previews even when no legacy DOM paragraphs remain", () => {
	const reflow = paragraphFromCharacters(
		"p",
		0,
		{ x: 10, y: 10, w: 100, h: 40 },
		[],
		[],
		false,
	);
	const item: LayoutTranslateItem = {
		id: "p",
		pageIndex: 0,
		kind: "text",
		bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
		source: "Source",
		raw: "Source",
		translated: "译文",
		status: "done",
		readingOrder: 0,
		reflow,
		reflowPreview: "blob:pdf-preview",
		reflowLayout: {
			id: "p",
			pageIndex: 0,
			sourceBox: reflow.box,
			box: reflow.box,
			scale: 1,
			fits: true,
			units: [
				{
					text: "译文",
					x: 10,
					y: 20,
					width: 20,
					height: 10,
					font: "cjk",
					fontSize: 10,
					color: { r: 0, g: 0, b: 0 },
				},
			],
		},
	};
	const html = renderToStaticMarkup(
		createElement(LayoutTranslateOverlay, {
			items: [item],
			pageWidthPx: 200,
			pageHeightPx: 200,
		}),
	);
	expect(html).toContain('src="blob:pdf-preview"');
	expect(html).toContain('data-layout-item="p"');
	expect(html).toContain('data-reflow-selection="true"');
	expect(html).toContain("译文");
});
