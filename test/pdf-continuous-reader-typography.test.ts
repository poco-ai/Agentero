// @vitest-environment happy-dom
import {
	type PdfDocumentObject,
	type PdfEngine,
	type PdfLinkAnnoObject,
	PdfZoomMode,
} from "@embedpdf/models";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfContinuousReader } from "@/components/viewer/pdf/continuous-reader";
import { ReaderText } from "@/components/viewer/pdf/reader-text";
import { resetLinkPreviewDragForTests } from "@/lib/pdf/link-preview-drag";
import type { ReadingBlock } from "@/lib/pdf/reading/blocks";
import { DEFAULT_READING_SETTINGS } from "@/lib/pdf/reading/settings";
import type { Formula, Paragraph } from "@/lib/pdf/reflow/types";

const { crop } = vi.hoisted(() => ({
	crop: vi.fn(
		async () => new Blob([new Uint8Array([0])], { type: "image/png" }),
	),
}));
vi.mock("react-i18next", async (original) => ({
	...(await original<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/viewer/pdf/region-crop", () => ({
	renderPdfRegionImageBlob: crop,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let observations: { callback: IntersectionObserverCallback; target: Element }[];
beforeEach(() => {
	observations = [];
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(private callback: IntersectionObserverCallback) {}
			observe(target: Element) {
				observations.push({ callback: this.callback, target });
				this.callback(
					[{ isIntersecting: true, target } as IntersectionObserverEntry],
					this as unknown as IntersectionObserver,
				);
			}
			disconnect() {}
		},
	);
	vi.clearAllMocks();
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:reader-crop");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	resetLinkPreviewDragForTests();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function render(
	formulas: Formula[],
	showTranslations = true,
	extra: Partial<Parameters<typeof PdfContinuousReader>[0]> = {},
) {
	const paragraph: Paragraph = {
		id: "body",
		pageIndex: 0,
		box: { x: 20, y: 20, w: 500, h: 100 },
		characters: [],
		formulas,
		styles: {},
		source: "Power and references",
		protectedText: `Power ${formulas.map((f) => `⟪F${f.id}⟫`).join(" ")}`,
		style: {
			font: "Times",
			size: 10,
			bold: false,
			italic: false,
			color: { r: 0, g: 0, b: 0 },
		},
		firstLineIndent: 0,
		heading: false,
	};
	const block: ReadingBlock = {
		id: paragraph.id,
		pageIndex: 0,
		kind: "text",
		bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
		readingOrder: 0,
		source: paragraph.protectedText,
		text: paragraph.source,
		translated: "功率和引用",
		item: {
			id: paragraph.id,
			pageIndex: 0,
			kind: "text",
			bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
			readingOrder: 0,
			source: paragraph.protectedText,
			translated: paragraph.protectedText.replace("Power", "功率"),
			status: "done",
			reflow: paragraph,
		},
	};
	const context = () => ({
		engine: {} as PdfEngine,
		document: {
			pages: [{ index: 0, size: { width: 600, height: 800 } }],
		} as PdfDocumentObject,
	});
	await act(async () => {
		root.render(
			createElement(PdfContinuousReader, {
				blocks: [block],
				settings: DEFAULT_READING_SETTINGS,
				preparing: false,
				error: null,
				currentPage: 1,
				onPageChange: vi.fn(),
				onShowSource: vi.fn(),
				onRetry: vi.fn(),
				context,
				showTranslations,
				...extra,
			}),
		);
	});
}

describe("continuous reader inline typography", () => {
	it("keeps bare URLs without mapping character geometry in an unlinked paragraph", async () => {
		const source = "See https://example.org/paper and values 1, 2, 3.";
		const character = {
			index: 0,
			text: "S",
			get box() {
				return { x: 10, y: 10, w: 5, h: 10 };
			},
			visualBox: { x: 10, y: 12, w: 5, h: 7 },
			style: {
				font: "Times",
				size: 10,
				bold: false,
				italic: false,
				color: { r: 0, g: 0, b: 0 },
			},
		};
		const readBox = vi.spyOn(character, "box", "get");
		const paragraph: Paragraph = {
			id: "body",
			pageIndex: 0,
			box: { x: 0, y: 0, w: 600, h: 100 },
			characters: [character],
			formulas: [],
			styles: {},
			source,
			protectedText: source,
			style: character.style,
			firstLineIndent: 0,
			heading: false,
		};
		const bbox = { x: 0, y: 0, w: 1, h: 0.2 };
		await act(() =>
			root.render(
				createElement(ReaderText, {
					block: {
						id: "body",
						pageIndex: 0,
						kind: "text",
						readingOrder: 0,
						bbox,
						source,
						text: source,
						item: {
							id: "body",
							pageIndex: 0,
							kind: "text",
							readingOrder: 0,
							bbox,
							source,
							status: "pending",
							reflow: paragraph,
						},
					},
					pageSize: { width: 600, height: 800 },
					settings: DEFAULT_READING_SETTINGS,
					links: { boxes: [], byId: new Map() },
					handlers: {},
					renderFormula: () => null,
				}),
			),
		);
		expect(host.textContent).toBe(source);
		expect(host.querySelector("a")?.getAttribute("href")).toBe(
			"https://example.org/paper",
		);
		expect(readBox).not.toHaveBeenCalled();
	});
	it("releases offscreen crops and recreates them on return without changing the reading layout", async () => {
		await render(
			[
				{
					id: "0",
					text: "x/y",
					box: { x: 120, y: 40, w: 20, h: 7 },
					baselineOffset: 1,
					characterIndexes: [],
				},
			],
			false,
		);
		const observation = observations[0];
		const layout = observation.target.getAttribute("style");
		expect(host.querySelector("[data-reader-math-mask]")).not.toBeNull();
		await act(() =>
			observation.callback(
				[
					{
						target: observation.target,
						isIntersecting: false,
					} as IntersectionObserverEntry,
				],
				{} as IntersectionObserver,
			),
		);
		expect(host.querySelector("[data-reader-math-mask]")).toBeNull();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:reader-crop");
		expect(observation.target.getAttribute("style")).toBe(layout);
		await act(() =>
			observation.callback(
				[
					{
						target: observation.target,
						isIntersecting: true,
					} as IntersectionObserverEntry,
				],
				{} as IntersectionObserver,
			),
		);
		expect(host.querySelector("[data-reader-math-mask]")).not.toBeNull();
		expect(crop).toHaveBeenCalledTimes(2);
		await act(() => root.unmount());
		expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
		root = createRoot(host);
	});
	it("discards a crop that finishes after scrolling away", async () => {
		let finish!: (blob: Blob) => void;
		crop.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await render(
			[
				{
					id: "0",
					text: "x/y",
					box: { x: 120, y: 40, w: 20, h: 7 },
					baselineOffset: 1,
					characterIndexes: [],
				},
			],
			false,
		);
		const observation = observations[0];
		await act(() =>
			observation.callback(
				[
					{
						target: observation.target,
						isIntersecting: false,
					} as IntersectionObserverEntry,
				],
				{} as IntersectionObserver,
			),
		);
		await act(() => finish(new Blob(["image"], { type: "image/png" })));
		expect(host.querySelector("[data-reader-math-mask]")).toBeNull();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});
	it("keeps cropped table links interactive in original page coordinates", async () => {
		const link = {
			id: "table-ref",
			pageIndex: 0,
			rect: { origin: { x: 110, y: 180 }, size: { width: 20, height: 10 } },
			target: {
				type: "destination",
				destination: {
					pageIndex: 2,
					zoom: { mode: PdfZoomMode.XYZ, params: { x: 40, y: 400 } },
					view: [],
				},
			},
		} as unknown as PdfLinkAnnoObject;
		const outside = {
			...link,
			id: "outside",
			rect: { origin: { x: 10, y: 20 }, size: { width: 20, height: 10 } },
		};
		const partial = {
			...link,
			id: "partial",
			rect: { origin: { x: 350, y: 180 }, size: { width: 20, height: 10 } },
		};
		const block: ReadingBlock = {
			id: "table",
			pageIndex: 0,
			kind: "table",
			bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
			readingOrder: 0,
			source: "",
			text: "",
			image: {
				id: "table",
				pageIndex: 0,
				kind: "table",
				bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
				score: 1,
			},
		};
		const onLinkHover = vi.fn(),
			onLinkActivate = vi.fn(),
			onUrlActivate = vi.fn();
		await render([], false, {
			blocks: [block],
			linkSource: {
				citationLinks: new Map([[0, [link, outside, partial]]]),
				textLinks: new Map([
					[
						0,
						[
							{
								url: "https://example.org/source",
								rect: {
									origin: { x: 80, y: 200 },
									size: { width: 40, height: 10 },
								},
							},
						],
					],
				]),
				inkByKey: new Map(),
				glyphRunsByPage: new Map(),
			},
			onLinkHover,
			onLinkActivate,
			onUrlActivate,
		});
		const targets = host.querySelectorAll<HTMLButtonElement>(
			"button[data-pdf-link]",
		);
		expect(targets).toHaveLength(2);
		expect(targets[0].style.left).toBe(`${(50 / 300) * 100}%`);
		expect(targets[0].style.top).toBe(`${(20 / 240) * 100}%`);
		expect(targets[1].style.width).toBe(`${(10 / 300) * 100}%`);
		vi.spyOn(targets[1], "getBoundingClientRect").mockReturnValue({
			left: 100,
			top: 200,
			width: 20,
			height: 20,
			bottom: 220,
		} as DOMRect);
		await act(() =>
			targets[1].dispatchEvent(
				new PointerEvent("pointerover", {
					bubbles: true,
					clientX: 110,
					clientY: 210,
				}),
			),
		);
		expect(onLinkHover).toHaveBeenCalledWith(
			partial,
			expect.objectContaining({ sourcePoint: { x: 355, y: 185 } }),
		);
		await act(() => targets[0].click());
		expect(onLinkActivate).toHaveBeenCalledExactlyOnceWith(link);
		await act(() =>
			host.querySelector<HTMLButtonElement>("button[data-url]")?.click(),
		);
		expect(onUrlActivate).toHaveBeenCalledExactlyOnceWith(
			"https://example.org/source",
		);
	});
	it("binds both panel links when ink centers differ but advance boxes share a baseline", async () => {
		const text = "Figures 4(a) and 4(b) NV0";
		const chars = [...text].map((text, index) => ({
			index,
			text,
			box: { x: index * 5, y: 10, w: 5, h: 11 },
			visualBox: {
				x: index * 5,
				y: index === 23 ? 10 : /[A-Z\d()bd]/.test(text) ? 12 : 14,
				w: 5,
				h: index === 23 ? 5 : /[A-Z\d()bdg]/.test(text) ? 7 : 5,
			},
			style: {
				font: "Times",
				size: 10,
				bold: false,
				italic: false,
				color: { r: 0, g: 0, b: 0 },
			},
		}));
		const paragraph: Paragraph = {
			id: "p",
			pageIndex: 0,
			box: { x: 0, y: 8, w: 150, h: 20 },
			characters: chars,
			formulas: [],
			styles: {},
			source: text,
			protectedText: text,
			style: chars[0].style,
			firstLineIndent: 0,
			heading: false,
		};
		const bbox = { x: 0, y: 0, w: 1, h: 1 };
		await act(() =>
			root.render(
				createElement(ReaderText, {
					block: {
						id: "p",
						pageIndex: 0,
						kind: "text",
						source: text,
						text,
						bbox,
						readingOrder: 0,
						item: {
							id: "p",
							pageIndex: 0,
							kind: "text",
							source: text,
							bbox,
							readingOrder: 0,
							status: "pending",
							reflow: paragraph,
						},
					},
					pageSize: { width: 200, height: 100 },
					settings: DEFAULT_READING_SETTINGS,
					handlers: {},
					renderFormula: () => null,
					links: {
						boxes: [8, 17].map((i, n) => ({
							key: `link-${n}`,
							kind: "goto",
							box: { x: (i * 5) / 200, y: 0.1, w: 20 / 200, h: 0.11 },
						})),
						byId: new Map(),
					},
				}),
			),
		);
		expect(
			[...host.querySelectorAll("a")].map((a) => [
				a.textContent,
				a.dataset.readerLink,
			]),
		).toEqual([
			["4(a)", "link-0"],
			["4(b)", "link-1"],
		]);
	});
	it("renders small inline math with enough pixels for enlarged reading text", async () => {
		await render(
			[
				{
					id: "0",
					text: "x/y",
					box: { x: 120, y: 40, w: 20, h: 7 },
					baselineOffset: 1,
					characterIndexes: [],
				},
			],
			false,
			{ settings: { ...DEFAULT_READING_SETTINGS, fontScale: 2 } },
		);
		// A 10 pt source displayed in a 32 px em needs at least 3.2 pixels/pt.
		expect(crop.mock.calls[0][0].scaleFactor).toBeGreaterThanOrEqual(3.2);
	});
	it("renders standalone equations with transparent ink in the reading theme", async () => {
		const bbox = { x: 0.1, y: 0.3, w: 0.2, h: 0.04 };
		await render([], false, {
			blocks: [
				{
					id: "equation",
					pageIndex: 0,
					kind: "formula",
					bbox,
					source: "",
					text: "",
					readingOrder: 0,
					image: {
						id: "equation",
						pageIndex: 0,
						kind: "formula",
						bbox,
						rect: { x: 60, y: 240, w: 120, h: 32 },
						label: "formula",
						score: 0.9,
						readingOrder: 0,
					},
				},
			],
		});
		expect(crop).toHaveBeenCalledWith(
			expect.objectContaining({ transparentBackground: true, region: bbox }),
		);
		expect(host.querySelector("[data-reader-math-mask]")).not.toBeNull();
		expect(host.querySelector("img")).toBeNull();
	});
	it("zooms reading text with Ctrl+wheel without changing inline formula proportions or normal scrolling", async () => {
		await render([
			{
				id: "0",
				text: "MW = 10⁶ W",
				box: { x: 120, y: 40, w: 60, h: 12 },
				baselineOffset: 2,
				characterIndexes: [],
			},
		]);
		const reader = host.querySelector<HTMLElement>("[data-pdf-reader]");
		const article = host.querySelector<HTMLElement>("article");
		if (!reader || !article) throw new Error("No reading view");
		const size = () => Number.parseFloat(article.style.fontSize);
		const initial = size();
		const wheel = async (deltaY: number, ctrlKey = true) => {
			const event = new WheelEvent("wheel", {
				deltaY,
				ctrlKey,
				bubbles: true,
				cancelable: true,
			});
			// happy-dom's WheelEvent does not populate MouseEvent modifiers.
			Object.defineProperty(event, "ctrlKey", { value: ctrlKey });
			expect(event.ctrlKey).toBe(ctrlKey);
			await act(() => {
				reader.dispatchEvent(event);
			});
			return event;
		};
		expect((await wheel(-120)).defaultPrevented).toBe(true);
		expect(size()).toBeGreaterThan(initial);
		expect(
			host.querySelector("[data-reader-math-mask]")?.parentElement?.style.width,
		).toBe("6em");
		await wheel(120);
		expect(size()).toBeCloseTo(initial, 3);
		expect((await wheel(-120, false)).defaultPrevented).toBe(false);
		expect(size()).toBeCloseTo(initial, 3);
	});
	it("switches to original text without losing the translation or its formula geometry", async () => {
		const formulas: Formula[] = [
			{
				id: "0",
				text: "MW = 10⁶ W",
				box: { x: 120, y: 40, w: 60, h: 12 },
				baselineOffset: 2,
				characterIndexes: [],
			},
		];
		await render(formulas, false);
		expect(host.textContent).not.toContain("功率");
		expect(host.querySelectorAll("[data-reader-math-mask]")).toHaveLength(1);
		await render(formulas, true);
		expect(host.textContent).toContain("功率");
		expect(host.querySelectorAll("[data-reader-math-mask]")).toHaveLength(2);
		expect(
			host
				.querySelector("[data-reader-translation]")
				?.classList.contains("border-l-2"),
		).toBe(true);
	});
	it("sizes a formula relative to the paragraph font and aligns its original baseline in both languages", async () => {
		await render([
			{
				id: "0",
				text: "MW = 10⁶ W",
				box: { x: 120, y: 40, w: 60, h: 12 },
				baselineOffset: 2,
				characterIndexes: [],
			},
		]);
		const images = host.querySelectorAll<HTMLElement>(
			"[data-reader-math-mask]",
		);
		expect(images).toHaveLength(2);
		for (const image of images) {
			const container = image.parentElement;
			expect(container?.style.width).toBe("6em");
			expect(container?.style.height).toBe("1.2em");
			expect(container?.style.verticalAlign).toBe("-0.2em");
			expect(container?.style.lineHeight).toBe("0");
			expect(image.className).not.toContain("max-h-");
		}
	});
	it("renders selectable body-sized and superscript citations without white image tiles", async () => {
		await render([
			{
				id: "0",
				text: "[57]",
				box: { x: 120, y: 40, w: 15, h: 8 },
				baselineOffset: 1,
				characterIndexes: [],
			},
			{
				id: "1",
				text: "[58]",
				box: { x: 140, y: 35, w: 10, h: 5 },
				baselineOffset: -3,
				characterIndexes: [],
			},
		]);
		expect(host.querySelectorAll("img")).toHaveLength(0);
		expect(host.textContent).toContain("[57] [58]");
		const refs = host.querySelectorAll<HTMLElement>(
			"[data-reader-inline-text]",
		);
		expect(refs[0].style.fontSize).toBe("1em");
		expect(refs[1].style.fontSize).toBe("0.7em");
		expect(Number.parseFloat(refs[1].style.top) * 0.7).toBeCloseTo(-0.3);
		expect(crop).not.toHaveBeenCalled();
	});
	it("shares native citation hover and navigation for original and translated text, suppressing selection drags", async () => {
		const link = {
			id: "cite57",
			pageIndex: 0,
			rect: { origin: { x: 120, y: 100 }, size: { width: 15, height: 8 } },
			target: {
				type: "destination",
				destination: {
					pageIndex: 8,
					zoom: { mode: PdfZoomMode.XYZ, params: { x: 50, y: 400 } },
					view: [],
				},
			},
		} as unknown as PdfLinkAnnoObject;
		const onLinkHover = vi.fn(),
			onLinkActivate = vi.fn();
		await render(
			[
				{
					id: "0",
					text: "[57]",
					box: { x: 120, y: 40, w: 15, h: 8 },
					baselineOffset: 1,
					characterIndexes: [],
				},
			],
			true,
			{
				linkSource: {
					citationLinks: new Map([[0, [link]]]),
					textLinks: new Map(),
					inkByKey: new Map(),
					glyphRunsByPage: new Map(),
				},
				onLinkHover,
				onLinkActivate,
			},
		);
		const anchors = host.querySelectorAll<HTMLAnchorElement>(
			"a[data-reader-link]",
		);
		expect(anchors).toHaveLength(2);
		await act(() =>
			anchors[1].dispatchEvent(
				new PointerEvent("pointerover", { bubbles: true }),
			),
		);
		expect(onLinkHover).toHaveBeenCalledWith(
			link,
			expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
		);
		await act(() => anchors[1].click());
		expect(onLinkActivate).toHaveBeenCalledExactlyOnceWith(link);
		onLinkHover.mockClear();
		await act(() =>
			anchors[0].dispatchEvent(
				new PointerEvent("pointerdown", {
					button: 0,
					buttons: 1,
					bubbles: true,
				}),
			),
		);
		await act(() =>
			anchors[0].dispatchEvent(
				new PointerEvent("pointerover", { bubbles: true }),
			),
		);
		expect(onLinkHover).not.toHaveBeenCalledWith(link, expect.anything());
		window.dispatchEvent(new PointerEvent("pointerup"));
		const range = document.createRange();
		range.selectNodeContents(anchors[0]);
		window.getSelection()?.addRange(range);
		await act(() => anchors[0].click());
		expect(onLinkActivate).toHaveBeenCalledTimes(1);
		window.getSelection()?.removeAllRanges();
	});
	it("requests alpha when rasterizing mathematical glyphs", async () => {
		await render([
			{
				id: "0",
				text: "R = ΔT∕J",
				box: { x: 120, y: 40, w: 42, h: 9 },
				baselineOffset: -0.8,
				characterIndexes: [],
			},
		]);
		expect(crop).toHaveBeenCalledWith(
			expect.objectContaining({ transparentBackground: true }),
		);
		expect(
			host.querySelector<HTMLElement>("[data-reader-math-mask]")?.style
				.backgroundColor,
		).toBe("currentcolor");
	});
});
