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
import { ReflowPageOverlay } from "@/components/viewer/pdf/layers/reflow-page-overlay";
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

it.each([
	"",
	"⟪S0⟫𝑥⟪/S0⟫ ",
])("gives each number inside one protected formula its own rectangle after prefix %s", (prefix) => {
	const formula = {
		id: "0",
		text: "[48,49]",
		box: { x: 100, y: 100, w: 35, h: 10 },
		baselineOffset: 0,
		characterIndexes: [],
	};
	const reflow = paragraphFromCharacters(
		"p",
		0,
		{ x: 0, y: 0, w: 600, h: 800 },
		[],
		[],
		false,
	);
	const html = renderToStaticMarkup(
		createElement(ReflowPageOverlay, {
			items: [
				{
					id: "p",
					pageIndex: 0,
					kind: "text",
					readingOrder: 0,
					bbox: { x: 0, y: 0, w: 1, h: 1 },
					source: "⟪F0⟫",
					raw: formula.text,
					translated: `${prefix}⟪F0⟫`,
					status: "done",
					reflow,
					reflowLayout: {
						id: "p",
						pageIndex: 0,
						sourceBox: reflow.box,
						box: reflow.box,
						scale: 1,
						fits: true,
						units: [
							{
								text: formula.text,
								translatedOffset: prefix.length,
								formula,
								x: 100,
								y: 110,
								width: 35,
								height: 10,
								font: "regular",
								fontSize: 10,
								color: { r: 0, g: 0, b: 0 },
							},
						],
					},
				},
			],
			links: [
				{
					key: "cite48",
					kind: "goto",
					box: { x: 0.175, y: 0.125, w: 0.017, h: 0.013 },
				},
				{
					key: "cite49",
					kind: "goto",
					box: { x: 0.2, y: 0.125, w: 0.017, h: 0.013 },
				},
			],
			glyphRuns: [
				{
					text: formula.text,
					box: { x: 1 / 6, y: 0.125, w: 35 / 600, h: 10 / 800 },
				},
			],
			preview: "blob:preview",
			pageIndex: 0,
			zoom: 2,
			width: 1200,
			height: 1600,
		}),
	);
	expect(html).toContain('data-translated-link="cite48"');
	expect(html).toContain('data-translated-link="cite49"');
	expect(html).toContain('aria-label="48"');
	expect(html).toContain('aria-label="49"');
});

it("writes continuous source line highlights for the selected reflow sentences", async () => {
	const sourceStyle = {
		font: "Helvetica",
		size: 12,
		bold: false,
		italic: false,
		color: { r: 0, g: 0, b: 0 },
	};
	const characters = ["First quote. Second", "quote. Third quote."].flatMap(
		(line, row) =>
			[...line].map((text, column) => {
				const box = { x: 10 + column * 4, y: 10 + row * 18, w: 4, h: 12 };
				return {
					index: row * 20 + column,
					text,
					box,
					visualBox: { x: box.x + 1, y: box.y + 2, w: 3, h: 8 },
					style: sourceStyle,
				};
			}),
	);
	const reflow = paragraphFromCharacters(
		"p",
		0,
		{ x: 10, y: 10, w: 80, h: 30 },
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
		bbox: { x: 0.05, y: 0.05, w: 0.4, h: 0.15 },
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
			runAnnotationBatch: (action) => action(),
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
		expect(pages[0].segmentRects).toEqual([
			{ origin: { x: 63, y: 12 }, size: { width: 23, height: 8 } },
			{ origin: { x: 11, y: 30 }, size: { width: 23, height: 8 } },
		]);

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
		expect(notePages[0].segmentRects).toEqual([
			{ origin: { x: 11, y: 12 }, size: { width: 75, height: 8 } },
			{ origin: { x: 11, y: 30 }, size: { width: 23, height: 8 } },
		]);
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

it("uses a newer page preview instead of the retained document only on that page", () => {
	const reflow = paragraphFromCharacters(
		"p",
		0,
		{ x: 10, y: 10, w: 100, h: 40 },
		[],
		[],
		false,
	);
	const html = renderToStaticMarkup(
		createElement(LayoutTranslateOverlay, {
			items: [
				{
					id: "p",
					pageIndex: 0,
					kind: "text",
					readingOrder: 0,
					bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
					source: "Source",
					translated: "new",
					status: "done",
					reflow,
					reflowPreview: "blob:new-page",
					reflowPreviewSources: new WeakSet([{ id: 2 }]),
				},
			],
			pageWidthPx: 200,
			pageHeightPx: 200,
			reflowDocumentId: "old-document",
			reflowDocumentVersion: { id: 1 },
		}),
	);
	expect(html).toContain('src="blob:new-page"');
	// A document render would mount EmbedPDF hooks, which this static tree lacks.
});

it("writes continuous source line highlights for the selected reflow sentences", async () => {
	const sourceStyle = {
		font: "Helvetica",
		size: 12,
		bold: false,
		italic: false,
		color: { r: 0, g: 0, b: 0 },
	};
	const characters = ["First quote. Second", "quote. Third quote."].flatMap(
		(line, row) =>
			[...line].map((text, column) => {
				const box = { x: 10 + column * 4, y: 10 + row * 18, w: 4, h: 12 };
				return {
					index: row * 20 + column,
					text,
					box,
					visualBox: { x: box.x + 1, y: box.y + 2, w: 3, h: 8 },
					style: sourceStyle,
				};
			}),
	);
	const reflow = paragraphFromCharacters(
		"p",
		0,
		{ x: 10, y: 10, w: 80, h: 30 },
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
		bbox: { x: 0.05, y: 0.05, w: 0.4, h: 0.15 },
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
			runAnnotationBatch: (action) => action(),
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
		expect(pages[0].segmentRects).toEqual([
			{ origin: { x: 63, y: 12 }, size: { width: 23, height: 8 } },
			{ origin: { x: 11, y: 30 }, size: { width: 23, height: 8 } },
		]);

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
		expect(notePages[0].segmentRects).toEqual([
			{ origin: { x: 11, y: 12 }, size: { width: 75, height: 8 } },
			{ origin: { x: 11, y: 30 }, size: { width: 23, height: 8 } },
		]);
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
