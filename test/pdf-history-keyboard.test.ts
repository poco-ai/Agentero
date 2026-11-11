// @vitest-environment happy-dom

import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PdfHistoryKeyHandler } from "@/components/viewer/pdf/viewport/pdf-history-key-handler";

it("routes undo/redo to the owning PDF and preserves text editing, menus and IME", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const first = createRef<HTMLDivElement>();
	const second = createRef<HTMLDivElement>();
	const undoFirst = vi.fn();
	const undoSecond = vi.fn();
	const root = createRoot(container);
	const key = (target: Element, options: KeyboardEventInit = {}) => {
		const event = new KeyboardEvent("keydown", {
			key: "z",
			metaKey: true,
			bubbles: true,
			cancelable: true,
			...options,
		});
		target.dispatchEvent(event);
		return event;
	};
	try {
		await act(async () =>
			root.render(
				createElement(
					"div",
					null,
					createElement(
						"div",
						{ ref: first, "data-pdf-viewport": true },
						createElement("textarea"),
						createElement("div", { contentEditable: true }),
					),
					createElement("div", { ref: second, "data-pdf-viewport": true }),
					createElement(PdfHistoryKeyHandler, {
						active: true,
						hostRef: first,
						onReplay: undoFirst,
					}),
					createElement(PdfHistoryKeyHandler, {
						active: false,
						hostRef: second,
						onReplay: undoSecond,
					}),
				),
			),
		);
		if (!first.current || !second.current) throw new Error("PDF hosts missing");
		vi.spyOn(first.current, "matches").mockImplementation(() => false);
		vi.spyOn(second.current, "matches").mockImplementation(() => false);
		expect(key(document.body).defaultPrevented).toBe(true);
		expect(undoFirst).toHaveBeenLastCalledWith(false);
		key(document.body, { shiftKey: true });
		expect(undoFirst).toHaveBeenLastCalledWith(true);
		key(document.body, { metaKey: false, ctrlKey: true });
		expect(undoFirst).toHaveBeenCalledTimes(3);
		const input = first.current.querySelector("textarea");
		const editor = first.current.querySelector("[contenteditable]");
		if (!input || !editor) throw new Error("Editors missing");
		input.focus();
		expect(key(document.body).defaultPrevented).toBe(false);
		input.blur();
		expect(key(editor).defaultPrevented).toBe(false);
		key(document.body, { isComposing: true });
		key(document.body, { altKey: true });
		expect(undoFirst).toHaveBeenCalledTimes(3);
		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		first.current.append(menu);
		expect(key(menu).defaultPrevented).toBe(false);
		// The inactive split owns its hovered PDF; the active split must yield.
		vi.mocked(second.current.matches).mockImplementation(
			(selector) => selector === ":hover",
		);
		key(document.body, { shiftKey: true });
		expect(undoSecond).toHaveBeenCalledExactlyOnceWith(true);
		expect(undoFirst).toHaveBeenCalledTimes(3);
	} finally {
		await act(async () => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	}
});
