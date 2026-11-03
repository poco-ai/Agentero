// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { releaseNativeSelectionForPdfPointer } from "@/components/viewer/pdf/hooks/use-pdf-text-selection";

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
});
