// @vitest-environment jsdom

import { PDFDocument, StandardFonts } from "pdf-lib";
import { act, createElement, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
	type PdfSelectionActions,
	type UsePdfSelectionActionsOptions,
	usePdfSelectionActions,
} from "@/components/viewer/pdf/hooks/use-pdf-selection-actions";
import {
	type UsePdfTranslationSelectionOptions,
	usePdfTranslationSelection,
} from "@/components/viewer/pdf/hooks/use-pdf-translation-selection";
import { LayoutTranslateOverlay } from "@/components/viewer/pdf/layers/layout-translate-overlay";
import type { SelectionMenuState } from "@/components/viewer/pdf/types";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import { paragraphFromCharacters } from "@/lib/pdf/reflow/extract";
import { layoutParagraph } from "@/lib/pdf/reflow/layout";

vi.mock("react-i18next", async (load) => ({
	...(await load<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

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

it("writes reflow highlights and notes with only the selected source sentence geometry", async () => {
	const source = "First quote. Second quote. Third quote.";
	const sourceStyle = {
		font: "Helvetica",
		size: 12,
		bold: false,
		italic: false,
		color: { r: 0, g: 0, b: 0 },
	};
	const characters = [...source].map((text, index) => {
		const box = { x: 10 + index * 4, y: 10, w: 4, h: 12 };
		return { index, text, box, visualBox: box, style: sourceStyle };
	});
	const reflow = paragraphFromCharacters(
		"p",
		0,
		{ x: 10, y: 10, w: 160, h: 12 },
		characters,
		[],
		false,
	);
	reflow.layoutBox = { x: 10, y: 10, w: 30, h: 100 };
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
		bbox: { x: 0.05, y: 0.05, w: 0.8, h: 0.06 },
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
	const itemsByPage = new Map([[0, [item]]]);
	const docCap = {
		getDocument: () => ({ pages: [{ size: { width: 200, height: 200 } }] }),
	} as UsePdfTranslationSelectionOptions["docCapRef"]["current"];
	const createHighlights = vi.fn<
		UsePdfSelectionActionsOptions["createHighlights"]
	>(() => [{ pageIndex: 0, id: "mark" }]);
	const updateHighlightComment = vi.fn();
	let menu: SelectionMenuState | null = null;
	let actions: PdfSelectionActions | undefined;
	function Reader({ enabled }: { enabled: boolean }) {
		const hostRef = useRef<HTMLDivElement>(null);
		const [selectionMenu, setSelectionMenu] =
			useState<SelectionMenuState | null>(null);
		const closeSelectionMenu = useCallback(() => setSelectionMenu(null), []);
		usePdfTranslationSelection({
			enabled,
			hostRef,
			zoomRef: useRef(1),
			engineRef: useRef(null),
			docCapRef: useRef(docCap),
			docId: "pdf",
			itemsByPage,
			selectionMenu,
			setSelectionMenu,
			closeSelectionMenu,
			paperRelPath: "paper.pdf",
			paperAbsPath: null,
		});
		actions = usePdfSelectionActions({
			selectionMenu,
			closeSelectionMenu,
			createHighlights,
			updateHighlightComment,
			docId: "pdf",
			startFromAnchor: vi.fn(),
			translateSelection: vi.fn(),
			paperRelPath: "paper.pdf",
			paperAbsPath: null,
		});
		menu = selectionMenu;
		return createElement(
			"div",
			{ ref: hostRef },
			createElement(
				"div",
				{ "data-embed-pdf-page": "0" },
				createElement(LayoutTranslateOverlay, {
					items: [item],
					pageWidthPx: 200,
					pageHeightPx: 200,
				}),
			),
		);
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const bounds = new DOMRect(0, 0, 200, 200);
	const pick = async (startIndex: number, endIndex: number) => {
		const glyph = (index: number) =>
			host.querySelector(`[data-sentence="${index}"]`)?.firstChild?.firstChild;
		const from = glyph(startIndex);
		const to = glyph(endIndex);
		if (!from || !to) throw new Error("missing selectable glyph");
		const range = document.createRange();
		range.setStart(from, 0);
		range.setEnd(to, 1);
		range.getClientRects = () =>
			[new DOMRect(15, 15, 12, 10)] as unknown as DOMRectList;
		await act(async () => {
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
			from.dispatchEvent(new Event("pointerup", { bubbles: true }));
		});
		return menu;
	};
	const actEnvironment = globalThis as typeof globalThis & {
		IS_REACT_ACT_ENVIRONMENT?: boolean;
	};
	actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const geometry = vi
		.spyOn(HTMLElement.prototype, "getBoundingClientRect")
		.mockReturnValue(bounds);
	try {
		await act(() => root.render(createElement(Reader, { enabled: true })));
		expect(host.querySelector('[data-sentence="1"]')?.textContent?.trim()).toBe(
			"Two.",
		);
		const single = await pick(1, 1);
		expect(single?.anchor.quote).toBe("Second quote.");
		expect(single?.copyText).toBe("T");
		await act(() => actions?.handleHighlight("yellow"));
		const [pages, , quote] = createHighlights.mock.calls[0];
		expect(quote).toBe("Second quote.");
		expect(pages[0].segmentRects.map((rect) => rect.origin.x)).toEqual(
			characters
				.slice(13, 26)
				.filter((c) => c.text.trim())
				.map((c) => c.box.x),
		);

		const pair = await pick(0, 1);
		expect(pair?.anchor.quote).toBe("First quote. Second quote.");
		if (!pair) throw new Error("missing selection menu");
		await act(() =>
			actions?.handleCommitSelectionNote(
				{
					pages: pair.pages,
					quote: pair.anchor.quote ?? "",
					visiblePages: pair.visiblePages,
				},
				" My note ",
			),
		);
		const [notePages, , noteQuote, translatedPages] =
			createHighlights.mock.calls[1];
		expect(noteQuote).toBe("First quote. Second quote.");
		expect(notePages[0].segmentRects.map((rect) => rect.origin.x)).toEqual(
			characters
				.slice(0, 26)
				.filter((c) => c.text.trim())
				.map((c) => c.box.x),
		);
		expect(translatedPages?.[0].rects).toHaveLength(1);
		expect(updateHighlightComment).toHaveBeenCalledWith(0, "mark", "My note");

		reflow.characters = [];
		const unmatched = await pick(1, 1);
		expect(unmatched?.anchor.quote).toBe("Second quote.");
		expect(unmatched?.copyText).toBe("T");
		expect(unmatched?.pages).toEqual([]);
		await act(() => actions?.handleHighlight("yellow"));
		expect(createHighlights).toHaveBeenCalledTimes(2);

		await act(() => root.render(createElement(Reader, { enabled: false })));
		expect(menu).toBeNull();
	} finally {
		await act(() => root.unmount());
		geometry.mockRestore();
		window.getSelection()?.removeAllRanges();
		host.remove();
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	}
});
