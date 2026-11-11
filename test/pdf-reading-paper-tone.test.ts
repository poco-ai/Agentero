// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { usePdfPaperTone } from "@/components/viewer/pdf/hooks/use-pdf-paper-tone";
import {
	DEFAULT_READING_SETTINGS,
	writeReadingSettings,
} from "@/lib/pdf/reading/settings";

it("applies the shared reading theme to existing PDF pages and preserves custom paper colors", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	localStorage.clear();
	let root = createRoot(document.createElement("div"));
	let view!: ReturnType<typeof usePdfPaperTone>;
	function Probe() {
		view = usePdfPaperTone();
		return null;
	}
	try {
		await act(() => root.render(createElement(Probe)));
		await act(() =>
			writeReadingSettings({ ...DEFAULT_READING_SETTINGS, theme: "sepia" }),
		);
		expect(view.pdfTone).toBe("sepia");
		await act(() => root.unmount());
		root = createRoot(document.createElement("div"));
		await act(() => root.render(createElement(Probe)));
		expect(view.pdfTone).toBe("sepia");
		await act(() => view.setPdfTone("white"));
		await act(() =>
			writeReadingSettings({ ...DEFAULT_READING_SETTINGS, theme: "original" }),
		);
		await act(() => view.setPdfTone("sepia"));
		await act(() =>
			writeReadingSettings({
				...DEFAULT_READING_SETTINGS,
				theme: "original",
				fontScale: 1.2,
			}),
		);
		expect(view.pdfTone).toBe("sepia");
		await act(() =>
			writeReadingSettings({ ...DEFAULT_READING_SETTINGS, theme: "black" }),
		);
		expect(view.pdfTone).toBe("black");
		await act(() =>
			writeReadingSettings({ ...DEFAULT_READING_SETTINGS, theme: "snow" }),
		);
		expect(view.pdfTone).toBe("snow");
		await act(() =>
			writeReadingSettings({
				...DEFAULT_READING_SETTINGS,
				theme: "custom",
				background: "#f5eed7",
			}),
		);
		expect(view.pdfTone).toBe("custom");
		expect(
			document.documentElement.style.getPropertyValue("--pdf-custom-paper"),
		).toBe("#f5eed7");
	} finally {
		await act(() => root.unmount());
		localStorage.clear();
		vi.unstubAllGlobals();
	}
});
