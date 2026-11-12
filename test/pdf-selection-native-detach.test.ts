// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type PdfTextSelection,
	releaseNativeSelectionForPdfPointer,
	type UsePdfTextSelectionOptions,
	usePdfTextSelection,
} from "@/components/viewer/pdf/hooks/use-pdf-text-selection";
import type { SelectionMenuState } from "@/components/viewer/pdf/types";

function selectText(node: Text): void {
	const range = document.createRange();
	range.selectNodeContents(node);
	const selection = window.getSelection();
	if (!selection) throw new Error("selection unavailable");
	selection.removeAllRanges();
	selection.addRange(range);
}

afterEach(() => {
	document.body.innerHTML = "";
	window.getSelection()?.removeAllRanges();
	vi.unstubAllGlobals();
});

describe("PDF pointer selection isolation", () => {
	it("drops a native selection started in another editable surface", () => {
		document.body.innerHTML = `
			<div id="source" contenteditable="true">source text</div>
			<div id="pdf"><canvas></canvas></div>
		`;
		const source = document.getElementById("source") as HTMLElement;
		const pdf = document.getElementById("pdf") as HTMLElement;
		const text = source.firstChild as Text;
		source.focus();
		selectText(text);
		expect(window.getSelection()?.rangeCount).toBe(1);

		releaseNativeSelectionForPdfPointer({
			host: pdf,
			target: pdf.querySelector("canvas"),
		});

		expect(window.getSelection()?.rangeCount).toBe(0);
		expect(document.activeElement).not.toBe(source);
	});

	it("keeps selections on DOM-text PDF overlays", () => {
		document.body.innerHTML = `
			<div id="pdf">
				<p class="pdf-translate-selection" id="translation">译文</p>
			</div>
		`;
		const pdf = document.getElementById("pdf") as HTMLElement;
		const translation = document.getElementById("translation") as HTMLElement;
		selectText(translation.firstChild as Text);

		releaseNativeSelectionForPdfPointer({
			host: pdf,
			target: translation.firstChild,
		});

		expect(window.getSelection()?.rangeCount).toBe(1);
		expect(window.getSelection()?.toString()).toBe("译文");
	});
	it("keeps native reader selection beside the PDF pane", () => {
		document.body.innerHTML = `
			<div id="pdf"><canvas></canvas><article data-pdf-reader><p>Reader text</p></article></div>
		`;
		const pdf = document.getElementById("pdf") as HTMLElement;
		const text = pdf.querySelector("p")?.firstChild as Text;
		selectText(text);

		releaseNativeSelectionForPdfPointer({ host: pdf, target: text });

		expect(window.getSelection()?.toString()).toBe("Reader text");
	});
	it("hands clipboard and pointer ownership to native reader text in split mode", async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		document.body.innerHTML = `<div id="pdf"><canvas></canvas><article data-pdf-reader><p>Reader text</p></article></div>`;
		const host = document.getElementById("pdf") as HTMLDivElement;
		const paragraph = host.querySelector("p") as HTMLElement;
		const clear = vi.fn();
		const copyToClipboard = vi.fn();
		const options = {
			docId: "doc",
			hostRef: { current: host },
			zoomRef: { current: 1 },
			isActive: true,
			paperRelPath: null,
			paperAbsPath: null,
			docCap: {},
			selectionCap: {
				clear,
				copyToClipboard,
				forDocument: () => ({
					onBeginSelection: () => () => {},
					onEndSelection: () => () => {},
					onSelectionChange: () => () => {},
				}),
			},
		} as unknown as UsePdfTextSelectionOptions;
		let api!: PdfTextSelection;
		function Fixture() {
			api = usePdfTextSelection(options);
			return null;
		}
		const root = createRoot(document.createElement("div"));
		try {
			await act(() => root.render(createElement(Fixture)));
			await act(() =>
				api.setSelectionMenu({
					anchor: { quote: "Stale PDF text" },
					pages: [],
				} as unknown as SelectionMenuState),
			);
			selectText(paragraph.firstChild as Text);
			const copy = new Event("copy", { bubbles: true, cancelable: true });
			paragraph.dispatchEvent(copy);
			const shortcut = new KeyboardEvent("keydown", {
				key: "c",
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			});
			paragraph.dispatchEvent(shortcut);
			expect(copy.defaultPrevented).toBe(false);
			expect(shortcut.defaultPrevented).toBe(false);
			expect(copyToClipboard).not.toHaveBeenCalled();
			await act(() => {
				paragraph.dispatchEvent(
					new PointerEvent("pointerdown", { button: 0, bubbles: true }),
				);
			});
			expect(clear).toHaveBeenCalledWith("doc");
			expect(api.selectionMenu).toBeNull();
			expect(window.getSelection()?.toString()).toBe("Reader text");
		} finally {
			await act(() => root.unmount());
		}
	});

	it("prevents a native drag from starting on PDF raster without blocking comment editing or translation", () => {
		document.body.innerHTML = `<div id="pdf"><div data-embed-pdf-page="0"><canvas></canvas><div data-pdf-chrome><textarea></textarea></div><p class="pdf-translate-selection">译文</p></div></div>`;
		const host = document.getElementById("pdf") as HTMLElement;
		for (const selector of ["canvas", "textarea", ".pdf-translate-selection"]) {
			const event = new MouseEvent("pointerdown", { cancelable: true });
			releaseNativeSelectionForPdfPointer({
				host,
				target: host.querySelector(selector),
				event,
			});
			expect(event.defaultPrevented).toBe(selector === "canvas");
		}
	});

	it("moves keyboard focus from a focused list to the PDF viewport", () => {
		document.body.innerHTML = `
			<div role="tree"><div role="treeitem" id="tree-item" tabindex="0">Paper</div></div>
			<div id="pdf">
				<div data-pdf-viewport tabindex="-1">
					<div data-embed-pdf-page="0"><canvas></canvas></div>
				</div>
			</div>
		`;
		const treeItem = document.getElementById("tree-item") as HTMLElement;
		const host = document.getElementById("pdf") as HTMLElement;
		const viewport = host.querySelector("[data-pdf-viewport]") as HTMLElement;
		treeItem.focus();
		expect(document.activeElement).toBe(treeItem);

		const event = new MouseEvent("pointerdown", { cancelable: true });
		releaseNativeSelectionForPdfPointer({
			host,
			target: host.querySelector("canvas"),
			event,
		});

		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(viewport);
	});
});
