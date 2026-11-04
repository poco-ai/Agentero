// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayoutTranslateParagraph } from "@/components/viewer/pdf/layers/layout-translate-overlay";
import {
	beginLinkPreviewDrag,
	holdLinkPreviewDrag,
	linkHoverSuppressed,
	linkPreviewDragActive,
	resetLinkPreviewDragForTests,
	subscribeLinkPreviewDrag,
} from "@/lib/pdf/link-preview-drag";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
	resetLinkPreviewDragForTests();
});

describe("link preview drag", () => {
	it("suppresses hover while the primary button is down", () => {
		expect(linkHoverSuppressed(1)).toBe(true);
		expect(linkHoverSuppressed(0)).toBe(false);
	});

	it("closes open previews when a translation drag starts and ignores a second pointerdown", () => {
		const clear = vi.fn();
		const unsubscribe = subscribeLinkPreviewDrag(clear);
		beginLinkPreviewDrag();
		beginLinkPreviewDrag();
		expect(linkPreviewDragActive()).toBe(true);
		expect(linkHoverSuppressed(0)).toBe(true);
		expect(clear).toHaveBeenCalledTimes(1);
		window.dispatchEvent(new Event("pointerup"));
		expect(linkPreviewDragActive()).toBe(false);
		expect(linkHoverSuppressed(0)).toBe(false);
		unsubscribe();
	});

	it("keeps previews suppressed after pointerup until the selection menu can take over", () => {
		const release = holdLinkPreviewDrag();
		beginLinkPreviewDrag();
		window.dispatchEvent(new Event("pointerup"));
		expect(linkPreviewDragActive()).toBe(true);
		release();
		expect(linkPreviewDragActive()).toBe(false);
		release();
		expect(linkPreviewDragActive()).toBe(false);
	});

	it("keeps a translated citation selectable and does not preview it mid-drag", async () => {
		const hover = vi.fn();
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root: Root = createRoot(host);
		await act(async () => {
			root.render(
				createElement(LayoutTranslateParagraph, {
					text: "见 [12] 所述",
					itemId: "block",
					initialFontSize: 12,
					boxWidthPx: 240,
					boxHeightPx: 48,
					isHeading: false,
					paperDark: false,
					tone: "white",
					linkAssignments: [{ start: 2, end: 6, text: "[12]", key: "cite.12" }],
					onHoverLink: hover,
				}),
			);
		});
		const link = host.querySelector("a[data-translated-link]");
		if (!(link instanceof HTMLAnchorElement)) {
			throw new Error("translated citation was not rendered");
		}
		expect(link.getAttribute("draggable")).toBe("false");
		link.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1 }),
		);
		expect(linkPreviewDragActive()).toBe(true);
		link.dispatchEvent(
			new PointerEvent("pointerover", { bubbles: true, buttons: 0 }),
		);
		expect(hover).not.toHaveBeenCalled();
		window.dispatchEvent(new Event("pointerup"));
		link.dispatchEvent(
			new PointerEvent("pointerover", { bubbles: true, buttons: 0 }),
		);
		expect(hover).toHaveBeenCalledTimes(1);
		await act(async () => {
			root.unmount();
		});
		host.remove();
	});
});
