// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PdfVimKeyHandler } from "@/components/viewer/pdf/viewport/pdf-vim-key-handler";

const fixture = vi.hoisted(() => ({ viewport: null as HTMLElement | null }));
vi.mock("@embedpdf/plugin-viewport/react", () => ({
	useViewportElement: () => ({ current: fixture.viewport }),
}));
vi.mock("@embedpdf/plugin-scroll/react", () => ({
	useScrollCapability: () => ({ provides: { forDocument: () => ({}) } }),
}));
vi.mock("@/hooks/use-app-stores", () => ({ useSettings: () => "vertical" }));
vi.mock("@/lib/settings", () => ({
	loadSettings: () => ({ vimMode: true, pdfVimKeys: true }),
}));
vi.mock("@/lib/pdf/scroll-sync", () => ({ handleScrollSyncIntent: vi.fn() }));

it("scrolls the focused reader while preserving independent source scrolling in split view", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const host = document.createElement("div");
	host.innerHTML =
		'<div data-pdf-viewport tabindex="0"></div><div data-pdf-reader tabindex="0"></div>';
	document.body.append(host);
	const source = host.firstElementChild as HTMLElement;
	const reader = host.lastElementChild as HTMLElement;
	fixture.viewport = source;
	Object.defineProperty(reader, "clientHeight", { value: 600 });
	const root = createRoot(document.createElement("div"));
	try {
		await act(() =>
			root.render(
				createElement(PdfVimKeyHandler, {
					documentId: "paper",
					active: true,
					hostRef: { current: host },
				}),
			),
		);
		reader.focus();
		reader.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "j",
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(reader.scrollTop).toBe(72);
		expect(source.scrollTop).toBe(0);
		reader.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "d",
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(reader.scrollTop).toBe(372);
		source.focus();
		source.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "j",
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(source.scrollTop).toBe(72);
		expect(reader.scrollTop).toBe(372);
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});
