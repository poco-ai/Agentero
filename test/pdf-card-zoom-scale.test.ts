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

describe("PDF comment rail follows document zoom", () => {
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
