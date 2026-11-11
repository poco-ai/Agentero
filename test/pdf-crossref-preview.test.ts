// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PdfCrossrefPreview } from "@/components/viewer/pdf/cards/crossref-preview";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/viewer/pdf/hooks/use-pdf-paper-tone", () => ({
	usePdfPaperTone: () => ({ pdfTone: "sepia" }),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("keeps the destination page at its display scale and scrolls to the referenced point when the page arrives", async () => {
	// A long page at the current zoom must scroll rather than shrink to the
	// card's height. The target is in a side caption, outside the figure crop.
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(700);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
	vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1300);
	const props = {
		screen: { x: 500, y: 100 },
		kind: "figure" as const,
		page: 3,
		targetSize: { width: 900, height: 1300 },
		focusPoint: { x: 0.1, y: 0.6 },
		onPointerEnter: vi.fn(),
		onPointerLeave: vi.fn(),
	};
	await act(() =>
		root.render(createElement(PdfCrossrefPreview, { ...props, image: null })),
	);
	await act(() =>
		root.render(
			createElement(PdfCrossrefPreview, {
				...props,
				image: { mimeType: "image/png", data: "AA==" },
			}),
		),
	);
	const viewport = host.querySelector<HTMLElement>(
		"[data-pdf-crossref-scroll]",
	);
	expect(viewport).not.toBeNull();
	expect(viewport?.scrollLeft).toBe(0);
	expect(viewport?.scrollTop).toBe(580);
	const image = host.querySelector("img");
	expect(image?.style.width).toBe("900px");
	expect(image?.style.height).toBe("1300px");
	expect(image?.style.maxHeight).toBe("");
	expect(
		host.querySelectorAll('[data-slot="scroll-area-scrollbar"]'),
	).toHaveLength(2);
	await act(() => {
		viewport?.dispatchEvent(new Event("pointerenter", { bubbles: true }));
	});
	// Rendering another state must not reset a reader's scroll within the card.
	if (viewport) viewport.scrollTop = 700;
	await act(() =>
		root.render(
			createElement(PdfCrossrefPreview, {
				...props,
				image: { mimeType: "image/png", data: "AA==" },
			}),
		),
	);
	expect(viewport?.scrollTop).toBe(700);
});

it("shows a missing-member notice alongside the references it located", async () => {
	await act(() =>
		root.render(
			createElement(PdfCrossrefPreview, {
				screen: { x: 500, y: 100 },
				kind: "reference",
				page: 8,
				image: { mimeType: "image/png", data: "AA==" },
				referenceEntries: [11, 13],
				missingReferences: [12],
				onPointerEnter: vi.fn(),
				onPointerLeave: vi.fn(),
			}),
		),
	);
	expect(host.textContent).toContain("[11, 13]");
	expect(host.querySelector('[role="status"]')?.textContent).toBe(
		"crossref.missingReferences",
	);
	expect(host.querySelector("img")).not.toBeNull();
});
