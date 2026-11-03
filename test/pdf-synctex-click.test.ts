// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	backward: vi
		.fn()
		.mockResolvedValue({ path: "/main.tex", line: 12, column: 1 }),
	navigate: vi.fn(),
	peer: null as null | { syncFromView(): boolean },
	layout: null as null | ((event: { documentId: string }) => void),
	scroll: {
		onLayoutReady: vi.fn(),
		forDocument: () => ({ getMetrics: () => ({ currentPage: 1 }) }),
	},
}));
vi.mock("@embedpdf/plugin-scroll/react", () => ({
	useScrollCapability: () => ({ provides: mocks.scroll }),
}));
vi.mock("@/components/viewer/pdf/coords", () => ({
	EMBED_PAGE_ATTR: "data-embed-pdf-page",
	pageElByIndex: (host: HTMLElement, index: number) =>
		host.querySelector(`[data-embed-pdf-page="${index}"]`),
}));
vi.mock("@/lib/tex/host", () => ({ syncTexBackward: mocks.backward }));
vi.mock("@/lib/tex/editor-navigation", () => ({
	navigateTexSource: mocks.navigate,
}));
vi.mock("@/lib/tex/synctex", () => ({
	registerTexPdfViewer: (_: string, peer: typeof mocks.peer) => {
		mocks.peer = peer;
		return () => {
			mocks.peer = null;
		};
	},
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/core/notify", () => ({ notifyError: vi.fn() }));

import { usePdfSyncTex } from "@/components/viewer/pdf/hooks/use-pdf-synctex";

it("uses the same PDF coordinates for a click + arrow and a modified click, even after zoom/scroll; resets for a new revision", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	const host = document.createElement("div");
	const page = document.createElement("div");
	page.setAttribute("data-embed-pdf-page", "0");
	host.append(page);
	document.body.append(container, host);
	let box = new DOMRect(0, 0, 600, 800);
	page.getBoundingClientRect = () => box;
	host.getBoundingClientRect = () => new DOMRect(0, 0, 600, 800);
	mocks.scroll.onLayoutReady.mockImplementation((fn) => {
		mocks.layout = fn;
		return () => {};
	});
	function Fixture({ docId }: { docId: string }) {
		usePdfSyncTex({
			docId,
			tabId: "writing",
			pdfPath: "/main.pdf",
			rootPath: "/main.tex",
			scope: "writing",
			isActive: true,
			hostRef: { current: host },
			navigate: vi.fn(),
			docCapRef: {
				current: {
					getDocumentState: () => ({
						document: {
							pages: [{ size: { width: 600, height: 800 }, rotation: 0 }],
						},
						rotation: 0,
					}),
				},
			} as Parameters<typeof usePdfSyncTex>[0]["docCapRef"],
		});
		return null;
	}
	const root = createRoot(container);
	try {
		await act(() => root.render(createElement(Fixture, { docId: "v1" })));
		mocks.layout?.({ documentId: "v1" });
		page.dispatchEvent(
			new MouseEvent("click", { bubbles: true, clientX: 120, clientY: 240 }),
		);
		expect(mocks.backward).not.toHaveBeenCalled();
		box = new DOMRect(-40, -100, 1200, 1600);
		await act(() => {
			mocks.peer?.syncFromView();
		});
		expect(mocks.backward).toHaveBeenLastCalledWith("/main.pdf", 1, 120, 240);
		await act(() => {
			page.dispatchEvent(
				new MouseEvent("click", {
					bubbles: true,
					ctrlKey: true,
					clientX: 200,
					clientY: 380,
				}),
			);
		});
		expect(mocks.backward).toHaveBeenLastCalledWith("/main.pdf", 1, 120, 240);
		expect(mocks.navigate).toHaveBeenCalledWith("/main.tex", 12, 1);
		mocks.backward.mockClear();
		await act(() => {
			for (const type of ["click", "click", "dblclick"]) {
				page.dispatchEvent(
					new MouseEvent(type, {
						bubbles: true,
						clientX: 260,
						clientY: 500,
					}),
				);
			}
		});
		expect(mocks.backward).toHaveBeenCalledExactlyOnceWith(
			"/main.pdf",
			1,
			150,
			300,
		);
		await act(() => {
			mocks.peer?.syncFromView();
		});
		expect(mocks.backward).toHaveBeenLastCalledWith("/main.pdf", 1, 150, 300);
		mocks.backward.mockClear();
		page.dispatchEvent(
			new MouseEvent("dblclick", {
				bubbles: true,
				ctrlKey: true,
				clientX: 260,
				clientY: 500,
			}),
		);
		expect(mocks.backward).not.toHaveBeenCalled();
		await act(() => root.render(createElement(Fixture, { docId: "v2" })));
		mocks.layout?.({ documentId: "v2" });
		await act(() => {
			mocks.peer?.syncFromView();
		});
		expect(mocks.backward).toHaveBeenLastCalledWith("/main.pdf", 1, 170, 250);
	} finally {
		await act(() => root.unmount());
		container.remove();
		host.remove();
		vi.unstubAllGlobals();
	}
});
