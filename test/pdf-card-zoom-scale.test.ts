// @vitest-environment happy-dom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({
		t: (key: string) => key,
	}),
}));

import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import { CommentCardsLayer } from "@/components/viewer/pdf/layers/comment-cards-layer";
import type { PageAnnotationComment } from "@/components/viewer/pdf/types";

const comment: PageAnnotationComment = {
	id: "c1",
	pageIndex: 0,
	anchorY: 0.5,
	rects: [{ x: 0.1, y: 0.5, w: 0.3, h: 0.02 }],
	quote: "quoted text",
	comment: "note",
	color: "yellow",
	kind: "highlight",
	linkAlias: null,
};

describe("PDF cards follow document zoom", () => {
	it("scales the floating card shell and its placement footprint", () => {
		vi.stubGlobal("innerWidth", 1400);
		vi.stubGlobal("innerHeight", 2000);
		const html = renderToStaticMarkup(
			createElement(
				SelectionCard,
				{
					screen: { x: 700, y: 300 },
					width: 340,
					height: 480,
					scale: 0.5,
					title: "Translation",
				},
				"body",
			),
		);
		// 340 / 480 are the unscaled content box; transform halves the result.
		expect(html).toContain("width:340px");
		expect(html).toContain("max-height:480px");
		expect(html).toContain("transform:scale(0.5)");
	});

	it("lays out the comment rail in page space and zooms the layer", () => {
		const html = renderToStaticMarkup(
			createElement(CommentCardsLayer, {
				items: [comment],
				pageWidthPx: 600,
				pageHeightPx: 800,
				scale: 0.5,
				editingId: null,
				wikiTarget: null,
				hoveredId: null,
				onOpen: vi.fn(),
				onSave: vi.fn(),
				onCancel: vi.fn(),
				onDelete: vi.fn(),
				onCopyLink: vi.fn(),
				onCopyEmbed: vi.fn(),
				onAddToChat: vi.fn(),
				onHover: vi.fn(),
				onLeave: vi.fn(),
			}),
		);
		// Unscaled page box doubles, then layout zoom halves the rendered result.
		expect(html).toContain("width:1200px");
		expect(html).toContain("height:1600px");
		expect(html).toContain("zoom:0.5");
		expect(html).not.toContain("transform:scale(");
	});
});
