// @vitest-environment jsdom

import { PDFDocument, StandardFonts } from "pdf-lib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LayoutTranslateOverlay } from "@/components/viewer/pdf/layers/layout-translate-overlay";
import {
	translationHitsFromRange,
	translationSelectionFromHits,
} from "@/lib/pdf/layout/layout-sentence-selection";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import { paragraphFromCharacters } from "@/lib/pdf/reflow/extract";
import { layoutParagraph } from "@/lib/pdf/reflow/layout";

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
					translatedOffset: 0,
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

it("maps a partial DOM selection through reflow layout to just its English sentence", async () => {
	const reflow = paragraphFromCharacters(
		"p",
		0,
		{ x: 10, y: 10, w: 30, h: 100 },
		[],
		[],
		false,
	);
	reflow.source = "First quote. Second quote. Third quote.";
	const translated = "One. Two. Three.";
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = {
		index: 0,
		width: 200,
		height: 200,
		paragraphs: [reflow],
		obstacles: [],
	};
	const item: LayoutTranslateItem = {
		id: "p",
		pageIndex: 0,
		kind: "text",
		bbox: { x: 0.05, y: 0.05, w: 0.15, h: 0.5 },
		source: reflow.source,
		translated,
		sentences: ["First quote.", "Second quote.", "Third quote."].map(
			(quote, i) => ({
				quote,
				source: quote,
				translated: ["One.", "Two.", "Three."][i],
			}),
		),
		status: "done",
		readingOrder: 0,
		reflow,
		reflowPreview: "blob:pdf-preview",
		reflowLayout: layoutParagraph(reflow, translated, page, {
			regular: font,
			bold: font,
			italic: font,
			boldItalic: font,
			cjk: font,
			cjkBold: font,
		}),
	};
	const root = document.createElement("div");
	root.innerHTML = renderToStaticMarkup(
		createElement(LayoutTranslateOverlay, {
			items: [item],
			pageWidthPx: 200,
			pageHeightPx: 200,
		}),
	);
	const second = root.querySelector('[data-sentence="1"]');
	expect(second?.textContent?.trim()).toBe("Two.");
	const firstLetter = second?.firstChild?.firstChild;
	if (!firstLetter) throw new Error("missing selectable glyph");
	const range = document.createRange();
	range.setStart(firstLetter, 0);
	range.setEnd(firstLetter, 1);
	const hits = translationHitsFromRange(range, root);
	expect(hits).toEqual([{ itemId: "p", sentenceIndex: 1 }]);
	const selection = translationSelectionFromHits(
		hits,
		[item],
		"en",
		range.toString(),
	);
	expect(selection?.quote).toBe("Second quote.");
	expect(selection?.copyText).toBe("T");
});
