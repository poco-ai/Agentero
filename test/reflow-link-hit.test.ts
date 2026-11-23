// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayoutTranslateParagraph } from "@/components/viewer/pdf/layers/layout-translate-overlay";
import { ReflowPageOverlay } from "@/components/viewer/pdf/layers/reflow-page-overlay";
import { TRANSLATED_LINK_HOVER_GAP_MS } from "@/lib/pdf/layout/translated-link-gesture";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import { resetLinkPreviewDragForTests } from "@/lib/pdf/link-preview-drag";
import type { PlacedUnit } from "@/lib/pdf/reflow/types";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
	resetLinkPreviewDragForTests();
});

function unit(text: string, x: number, y: number): PlacedUnit {
	return {
		text,
		translatedOffset: 0,
		x,
		y,
		width: 8,
		height: 12,
		font: "regular",
		fontSize: 12,
		color: { r: 0, g: 0, b: 1 },
	};
}

function reflowItem(
	chars: readonly { text: string; x: number; y: number }[],
	source = "See [12].",
): LayoutTranslateItem {
	return {
		id: "p",
		pageIndex: 0,
		bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
		kind: "text",
		readingOrder: 0,
		source,
		raw: "See Fig-\n3.",
		status: "done",
		translated: chars.map((char) => char.text).join(""),
		reflow: {
			id: "p",
			pageIndex: 0,
			box: { x: 0, y: 0, w: 300, h: 80 },
			characters: [],
			formulas: [],
			styles: {},
			source,
			protectedText: source,
			style: {
				font: "serif",
				size: 12,
				bold: false,
				italic: false,
				color: { r: 0, g: 0, b: 0 },
			},
			firstLineIndent: 0,
			heading: false,
		},
		reflowLayout: {
			id: "p",
			pageIndex: 0,
			sourceBox: { x: 0, y: 0, w: 300, h: 80 },
			box: { x: 40, y: 40, w: 220, h: 80 },
			scale: 1,
			fits: true,
			units: chars.map((char) => unit(char.text, char.x, char.y)),
		},
	};
}

const cite = {
	key: "cite",
	kind: "goto" as const,
	box: { x: 0.2, y: 0.15, w: 0.05, h: 0.02 },
};

async function renderOverlay(
	item: LayoutTranslateItem,
	handlers: {
		onOpenLink?: (assignment: { key: string | null; text: string }) => void;
		onHoverLink?: (assignment: { key: string | null } | null) => void;
	},
) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root: Root = createRoot(host);
	await act(async () => {
		root.render(
			createElement(ReflowPageOverlay, {
				items: [item],
				preview: "",
				pageIndex: 0,
				zoom: 1,
				width: 600,
				height: 400,
				links: [cite],
				onOpenLink: handlers.onOpenLink,
				onHoverLink: handlers.onHoverLink,
			}),
		);
	});
	return {
		host,
		async unmount() {
			await act(async () => {
				root.unmount();
			});
			host.remove();
		},
	};
}

function clickLink(link: Element, from: number, to: number) {
	link.dispatchEvent(
		new PointerEvent("pointerdown", {
			bubbles: true,
			button: 0,
			clientX: from,
			clientY: 10,
		}),
	);
	link.dispatchEvent(
		new MouseEvent("click", {
			bubbles: true,
			clientX: to,
			clientY: 10,
			detail: 1,
		}),
	);
}

describe("reflow translated link hits", () => {
	it("uses one hit target per line and keeps the dwell while the pointer crosses glyphs", async () => {
		const hover = vi.fn();
		const chars = ["见", " ", "[", "1", "2", "]"].map((text, index) => ({
			text,
			x: 50 + index * 8,
			y: text === "]" ? 80 : 60,
		}));
		const view = await renderOverlay(reflowItem(chars), { onHoverLink: hover });
		const links = [...view.host.querySelectorAll("a[data-translated-link]")];
		expect(links).toHaveLength(2);
		expect(links[0]?.textContent).toBe("[12");
		expect(links[1]?.textContent).toBe("]");
		const glyphs = links[0]?.querySelectorAll("span");
		expect(glyphs?.length).toBe(3);

		links[0]?.dispatchEvent(
			new PointerEvent("pointerover", { bubbles: true, buttons: 0 }),
		);
		expect(hover).toHaveBeenCalledTimes(1);
		expect(hover.mock.calls[0]?.[0]).toMatchObject({
			key: "cite",
			text: "[12]",
		});

		glyphs?.[0]?.dispatchEvent(
			new PointerEvent("pointerout", {
				bubbles: true,
				relatedTarget: glyphs[1],
			}),
		);
		expect(hover).toHaveBeenCalledTimes(1);

		const first = links[0];
		const second = links[1];
		if (!first || !second)
			throw new Error("wrapped link lines were not rendered");
		// The gap between the two line boxes is not part of either anchor.
		first.dispatchEvent(
			new PointerEvent("pointerout", {
				bubbles: true,
				relatedTarget: view.host,
			}),
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 40));
		});
		expect(hover).toHaveBeenCalledTimes(1);
		second.dispatchEvent(
			new PointerEvent("pointerover", { bubbles: true, buttons: 0 }),
		);
		expect(hover).toHaveBeenCalledTimes(1);

		second.dispatchEvent(
			new PointerEvent("pointerout", {
				bubbles: true,
				relatedTarget: view.host,
			}),
		);
		await act(async () => {
			await new Promise((resolve) =>
				setTimeout(resolve, TRANSLATED_LINK_HOVER_GAP_MS + 20),
			);
		});
		expect(hover).toHaveBeenCalledTimes(2);
		expect(hover.mock.calls[1]?.[0]).toBeNull();
		await view.unmount();
	});

	it("follows a stationary click and ignores a drag, even when the glyph is selected", async () => {
		const open = vi.fn();
		const chars = ["[", "1", "2", "]"].map((text, index) => ({
			text,
			x: 50 + index * 8,
			y: 60,
		}));
		const view = await renderOverlay(reflowItem(chars, "See [12]."), {
			onOpenLink: open,
		});
		const link = view.host.querySelector("a[data-translated-link]");
		if (!(link instanceof HTMLAnchorElement)) {
			throw new Error("translated citation was not rendered");
		}
		expect(link.textContent).toBe("[12]");
		const range = document.createRange();
		range.selectNodeContents(link);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		expect(selection?.toString()).toBe("[12]");

		clickLink(link, 10, 12);
		expect(open).toHaveBeenCalledTimes(1);
		expect(open.mock.calls[0]?.[0]).toMatchObject({ key: "cite" });

		clickLink(link, 10, 40);
		expect(open).toHaveBeenCalledTimes(1);
		await view.unmount();
	});
});

describe("block translated link clicks", () => {
	it("follows a stationary click when the token text is selected", async () => {
		const open = vi.fn();
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
					tone: "white",
					linkAssignments: [{ start: 2, end: 6, text: "[12]", key: "cite.12" }],
					onOpenLink: open,
				}),
			);
		});
		const link = host.querySelector("a[data-translated-link]");
		if (!(link instanceof HTMLAnchorElement)) {
			throw new Error("translated citation was not rendered");
		}
		const range = document.createRange();
		range.selectNodeContents(link);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
		clickLink(link, 8, 9);
		expect(open).toHaveBeenCalledTimes(1);
		clickLink(link, 8, 30);
		expect(open).toHaveBeenCalledTimes(1);
		await act(async () => {
			root.unmount();
		});
		host.remove();
	});
});
