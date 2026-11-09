// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
	type PdfTextSelection,
	type UsePdfTextSelectionOptions,
	usePdfTextSelection,
} from "@/components/viewer/pdf/hooks/use-pdf-text-selection";

it("clears a PDF toolbar when its mounted tab becomes inactive", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const clear = vi.fn();
	const options = {
		selectionCap: {
			clear,
			forDocument: () => ({
				onBeginSelection: () => () => {},
				onEndSelection: () => () => {},
				onSelectionChange: () => () => {},
			}),
		},
		docCap: {},
		docId: "paper",
		hostRef: { current: container },
		zoomRef: { current: 1 },
		paperRelPath: "paper.pdf",
		paperAbsPath: null,
	} as Omit<UsePdfTextSelectionOptions, "isActive">;
	let selection!: PdfTextSelection;
	function Probe({ active }: { active: boolean }) {
		selection = usePdfTextSelection({ ...options, isActive: active });
		return null;
	}
	try {
		await act(() => root.render(createElement(Probe, { active: true })));
		await act(() =>
			selection.setSelectionMenu({
				screen: { x: 100, y: 100 },
				anchor: { page: 1, quote: "selected text", rects: [] },
				pages: [],
			}),
		);
		expect(selection.selectionMenu?.anchor.quote).toBe("selected text");
		await act(() => root.render(createElement(Probe, { active: false })));
		expect(selection.selectionMenu).toBeNull();
		expect(clear).toHaveBeenCalledWith("paper");
		await act(() => root.render(createElement(Probe, { active: true })));
		expect(selection.selectionMenu).toBeNull();
	} finally {
		await act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
