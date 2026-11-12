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

describe("PDF comment rail keeps a fixed UI size", () => {
	it("lays out the rail in screen pixels without scaling the layer", () => {
		const html = renderToStaticMarkup(
			createElement(CommentCardsLayer, {
				items: [comment],
				pageWidthPx: 600,
				pageHeightPx: 800,
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
		// The rail box equals the rendered page box; zoom rescales nothing.
		expect(html).toContain("width:600px");
		expect(html).toContain("height:800px");
		expect(html).not.toContain("zoom:");
		expect(html).not.toContain("transform:scale(");
		// Cards hug their content under a hard height cap.
		expect(html).toContain("max-height:420px");
	});
});
