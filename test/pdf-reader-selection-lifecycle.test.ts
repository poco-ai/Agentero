// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePdfReaderSelection } from "@/components/viewer/pdf/hooks/use-pdf-reader-selection";
import type { SelectionMenuState } from "@/components/viewer/pdf/types";
import {
	linkPreviewDragActive,
	resetLinkPreviewDragForTests,
} from "@/lib/pdf/link-preview-drag";
import type { ReadingBlock } from "@/lib/pdf/reading/blocks";

vi.mock("react-i18next", async (original) => ({
	...(await original<typeof import("react-i18next")>()),
	useTranslation: () => ({ i18n: { language: "en" } }),
}));
vi.mock("@/lib/agent/selection-store", () => ({ publishSelection: vi.fn() }));
vi.mock("@/lib/settings/store", () => ({
	loadSettings: () => ({ translate: {} }),
}));
vi.mock("@/lib/translate/lang", () => ({
	langsFromSettings: () => ({ targetLang: "zh" }),
}));

afterEach(() => {
	window.getSelection()?.removeAllRanges();
	document.body.replaceChildren();
	resetLinkPreviewDragForTests();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("opens source actions without page DOM and abandons pending glyph work on scroll or unmount", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	const host = document.createElement("div");
	host.innerHTML =
		'<div data-pdf-reader><section data-reader-block="p"><p data-reader-text-root><span data-reader-start="0" data-reader-end="10">alpha beta</span></p></section></div>';
	document.body.append(host);
	const leaf = host.querySelector("span");
	if (!leaf?.firstChild) throw new Error("fixture missing");
	vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
		new DOMRect(30, 40, 80, 18),
	);
	const b: ReadingBlock = {
		id: "p",
		pageIndex: 0,
		kind: "text",
		bbox: { x: 0, y: 0, w: 1, h: 1 },
		readingOrder: 0,
		source: "alpha beta",
		text: "alpha beta",
	};
	const menu = vi.fn<(value: SelectionMenuState | null) => void>();
	const hostRef = { current: host };
	let resolveGlyphs: ((v: unknown[]) => void) | undefined;
	const glyphs = Array.from(b.text, (_, i) => ({
		origin: { x: 10 + i * 5, y: 20 },
		size: { width: 5, height: 10 },
	}));
	const context = {
		engineRef: {
			current: {
				getPageGlyphs: () => ({
					toPromise: () =>
						new Promise<unknown[]>((resolve) => {
							resolveGlyphs = resolve;
						}),
				}),
				getTextSlices: () => ({ toPromise: async () => Array.from(b.text) }),
			},
		},
		docCapRef: {
			current: {
				getDocument: () => ({ pages: [{ size: { width: 600, height: 800 } }] }),
			},
		},
	};
	function Probe() {
		usePdfReaderSelection({
			enabled: true,
			hostRef,
			docId: "doc",
			blocks: [b],
			setSelectionMenu: menu,
			closeSelectionMenu: vi.fn(),
			paperAbsPath: null,
			paperRelPath: null,
			...context,
		} as unknown as Parameters<typeof usePdfReaderSelection>[0]);
		return null;
	}
	const root = createRoot(document.createElement("div"));
	const select = async () => {
		await act(() => {
			leaf.dispatchEvent(
				new PointerEvent("pointerdown", { button: 0, bubbles: true }),
			);
			const range = document.createRange();
			range.setStart(leaf.firstChild as Node, 6);
			range.setEnd(leaf.firstChild as Node, 10);
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
			window.dispatchEvent(new PointerEvent("pointerup", { button: 0 }));
		});
		await act(() => vi.advanceTimersByTimeAsync(30));
	};
	try {
		await act(() => root.render(createElement(Probe)));
		await select();
		expect(linkPreviewDragActive()).toBe(true);
		await act(async () => resolveGlyphs?.(glyphs));
		expect(menu.mock.calls.at(-1)?.[0]).toMatchObject({
			fromReader: { blockId: "p" },
			anchor: { quote: "beta" },
			pages: [{ pageIndex: 0, segmentRects: [{ origin: { x: 40, y: 20 } }] }],
		});
		expect(linkPreviewDragActive()).toBe(false);
		await select();
		await act(() =>
			host
				.querySelector("[data-pdf-reader]")
				?.dispatchEvent(new Event("scroll")),
		);
		expect(linkPreviewDragActive()).toBe(false);
		menu.mockClear();
		await act(async () => resolveGlyphs?.(glyphs));
		expect(menu).not.toHaveBeenCalled();
		await select();
		await act(() => root.unmount());
		menu.mockClear();
		await act(async () => resolveGlyphs?.(glyphs));
		expect(menu).not.toHaveBeenCalled();
		expect(linkPreviewDragActive()).toBe(false);
	} finally {
		await act(() => root.unmount());
	}
});
