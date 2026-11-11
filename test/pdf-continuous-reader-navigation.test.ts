// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PdfContinuousReader } from "@/components/viewer/pdf/continuous-reader";
import type { PdfNavigationTarget } from "@/lib/pdf/pending-pdf-page";
import type { ReadingBlock } from "@/lib/pdf/reading/blocks";
import { DEFAULT_READING_SETTINGS } from "@/lib/pdf/reading/settings";

vi.mock("react-i18next", async (original) => ({
	...(await original<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: (key: string) => key }),
}));

it("follows different and repeated regions on one page without resetting user scrolling on translation updates", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const blocks: ReadingBlock[] = [0.1, 0.5, 0.8].map((y, index) => ({
		id: `paragraph-${index}`,
		pageIndex: 0,
		kind: "text",
		bbox: { x: 0.1, y, w: 0.4, h: 0.1 },
		readingOrder: index,
		source: `Paragraph ${index}`,
		text: `Paragraph ${index}`,
	}));
	const props = {
		blocks,
		settings: DEFAULT_READING_SETTINGS,
		preparing: false,
		error: null,
		currentPage: 1,
		onPageChange: vi.fn(),
		onShowSource: vi.fn(),
		onRetry: vi.fn(),
		context: () => null,
	};
	try {
		await act(() => root.render(createElement(PdfContinuousReader, props)));
		const reader = host.querySelector<HTMLElement>("[data-pdf-reader]");
		if (!reader) throw new Error("Reader did not mount");
		vi.spyOn(reader, "getBoundingClientRect").mockImplementation(
			() => new DOMRect(0, 0, 600, 500),
		);
		for (const [index, element] of Array.from(
			host.querySelectorAll<HTMLElement>("[data-reader-block]"),
		).entries()) {
			vi.spyOn(element, "getBoundingClientRect").mockImplementation(
				() => new DOMRect(0, 100 + index * 600 - reader.scrollTop, 500, 400),
			);
		}
		const first: PdfNavigationTarget = { page: 1, region: blocks[0] };
		await act(() =>
			root.render(
				createElement(PdfContinuousReader, {
					...props,
					navigationTarget: first,
				}),
			),
		);
		expect(reader.scrollTop).toBe(52);
		const second: PdfNavigationTarget = { page: 1, region: blocks[1] };
		await act(() =>
			root.render(
				createElement(PdfContinuousReader, {
					...props,
					navigationTarget: second,
				}),
			),
		);
		expect(reader.scrollTop).toBe(652);
		reader.scrollTop = 900;
		await act(() =>
			root.render(
				createElement(PdfContinuousReader, {
					...props,
					blocks: blocks.map((block) => ({ ...block, translated: "译文" })),
					navigationTarget: second,
				}),
			),
		);
		expect(reader.scrollTop).toBe(900);
		await act(() =>
			root.render(
				createElement(PdfContinuousReader, {
					...props,
					navigationTarget: { ...second },
				}),
			),
		);
		expect(reader.scrollTop).toBe(652);
		await act(() =>
			root.render(
				createElement(PdfContinuousReader, {
					...props,
					navigationTarget: {
						page: 1,
						region: {
							id: "citation",
							pageIndex: 0,
							bbox: { x: 0.1, y: 0.79, w: 0.4, h: 0.1 },
						},
					},
				}),
			),
		);
		expect(reader.scrollTop).toBe(1252);
		// A citation jump returns to the exact paragraph offset, including when
		// the PDF remains on the same page in the other pane.
		await act(() =>
			root.render(
				createElement(PdfContinuousReader, {
					...props,
					navigationTarget: second,
					readerRestore: {
						x: 0,
						y: 0,
						page: 1,
						reader: { blockId: blocks[0].id, top: -250, scrollTop: 350 },
					},
				}),
			),
		);
		expect(reader.scrollTop).toBe(350);
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

it.each([
	false,
	true,
])("opens at the current page without replaying an earlier jump (delayed blocks: %s)", async (delayed) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const blocks: ReadingBlock[] = [2, 5].map((page) => ({
		id: `page-${page}`,
		pageIndex: page - 1,
		kind: "text",
		bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
		readingOrder: 0,
		source: `Page ${page}`,
		text: `Page ${page}`,
	}));
	const props = {
		blocks: delayed ? [] : blocks,
		settings: DEFAULT_READING_SETTINGS,
		preparing: delayed,
		error: null,
		currentPage: 5,
		navigationTarget: { page: 2 },
		onPageChange: vi.fn(),
		onShowSource: vi.fn(),
		onRetry: vi.fn(),
		context: () => null,
	};
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		function (this: HTMLElement) {
			const reader = this.closest<HTMLElement>("[data-pdf-reader]");
			const page = Number(this.dataset.readerPage);
			return new DOMRect(
				0,
				page ? page * 100 - (reader?.scrollTop ?? 0) : 0,
				600,
				100,
			);
		},
	);
	try {
		await act(() => root.render(createElement(PdfContinuousReader, props)));
		if (delayed) {
			await act(() =>
				root.render(
					createElement(PdfContinuousReader, {
						...props,
						blocks,
						preparing: false,
					}),
				),
			);
		}
		const reader = host.querySelector<HTMLElement>("[data-pdf-reader]");
		expect(reader?.scrollTop).toBe(452);
		await act(() =>
			root.render(
				createElement(PdfContinuousReader, {
					...props,
					blocks,
					preparing: false,
					navigationTarget: { page: 2 },
				}),
			),
		);
		expect(reader?.scrollTop).toBe(152);
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
