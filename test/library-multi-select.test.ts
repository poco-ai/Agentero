// @vitest-environment happy-dom

/**
 * Library multi-select wiring: checkbox toggling, tri-state select-all, and a
 * marquee drag that selects the rows it covers without opening a paper.
 *
 * The virtualizer is mocked so every row renders (happy-dom has no layout),
 * and row rects are stubbed to a fixed 52px band per index.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-virtual", () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getVirtualItems: () =>
			Array.from({ length: count }, (_, index) => ({
				index,
				start: index * 52,
				end: index * 52 + 52,
				size: 52,
				key: index,
				lane: 0,
			})),
		getTotalSize: () => count * 52,
		measureElement: () => {},
	}),
}));

import { PapersLibrary } from "@/components/library/papers-library";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PaperLibraryRow } from "@/lib/paper";
import { DEFAULT_LIBRARY_COLUMNS } from "@/lib/settings";

const ROW_HEIGHT = 52;
const ROW_TOP = 40;

function paper(id: string, title: string): PaperLibraryRow {
	return {
		path: `papers/${id}`,
		id,
		type: "arxiv",
		title,
		authors: ["A. Author"],
		tags: [],
		status: "completed",
		is_read: false,
		added_at: "2024-01-01T00:00:00Z",
		updated_at: "2024-01-01T00:00:00Z",
		has_pdf: true,
	};
}

let root: Root;
let container: HTMLDivElement;
let restoreRects: () => void;
const opened: string[] = [];

const rows = () => [
	...document.querySelectorAll<HTMLTableRowElement>("tr[data-index]"),
];
const selectedRows = () =>
	rows().filter((row) => row.hasAttribute("data-selected"));

function pointer(type: string, init: MouseEventInit) {
	return new MouseEvent(type, { bubbles: true, ...init });
}

async function click(element: Element) {
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

/** ⌘/Ctrl-click: the keyboard-only way into selection mode. */
async function modifierClick(element: Element) {
	await act(async () => {
		element.dispatchEvent(
			new MouseEvent("click", { bubbles: true, metaKey: true }),
		);
	});
}

async function rightClick(row: Element, clientY: number) {
	await act(async () => {
		row.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY }),
		);
	});
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	document.documentElement.style.fontSize = "16px";
	opened.length = 0;
	const original = Element.prototype.getBoundingClientRect;
	Element.prototype.getBoundingClientRect = function (this: Element) {
		if (this instanceof HTMLElement && this.matches("tr[data-index]")) {
			const index = Number(this.dataset.index);
			const top = ROW_TOP + index * ROW_HEIGHT;
			return {
				top,
				bottom: top + ROW_HEIGHT,
				left: 0,
				right: 800,
				width: 800,
				height: ROW_HEIGHT,
				x: 0,
				y: top,
				toJSON: () => ({}),
			} as DOMRect;
		}
		return {
			top: 0,
			bottom: 600,
			left: 0,
			right: 800,
			width: 800,
			height: 600,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		} as DOMRect;
	};
	restoreRects = () => {
		Element.prototype.getBoundingClientRect = original;
	};

	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root.render(
			createElement(
				TooltipProvider,
				null,
				createElement(PapersLibrary, {
					papers: [
						paper("a", "Alpha"),
						paper("b", "Beta"),
						paper("c", "Gamma"),
					],
					vaultPath: null,
					active: true,
					loading: false,
					query: "",
					columns: DEFAULT_LIBRARY_COLUMNS,
					onOpenPaper: (p) => opened.push(p.id),
				}),
			),
		),
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	restoreRects();
	vi.unstubAllGlobals();
});

describe("library multi-select", () => {
	const rowBoxes = () =>
		document.querySelectorAll('tr[data-index] [role="checkbox"]');
	const headerBox = () => document.querySelector('thead [role="checkbox"]');

	const wait = (ms: number) =>
		act(async () => {
			await new Promise((resolve) => setTimeout(resolve, ms));
		});

	const drag = async (row: Element, clientY: number) => {
		await act(async () => {
			row.dispatchEvent(pointer("pointerdown", { clientX: 30, clientY: 60 }));
			window.dispatchEvent(pointer("pointermove", { clientX: 60, clientY }));
			window.dispatchEvent(pointer("pointerup", {}));
		});
	};

	it("keeps the plain table until a selection gesture", () => {
		expect(rows()).toHaveLength(3);
		expect(rowBoxes()).toHaveLength(0);
		expect(headerBox()).toBeNull();
		expect(document.querySelector('[role="toolbar"]')).toBeNull();
	});

	it("reveals checkboxes and selects the rows a marquee covers", async () => {
		const [alpha, beta, gamma] = rows();
		await drag(alpha, 120);
		// Band 60..120 touches Alpha (40..92) and Beta (92..144).
		expect(selectedRows()).toHaveLength(2);
		expect(alpha.hasAttribute("data-selected")).toBe(true);
		expect(beta.hasAttribute("data-selected")).toBe(true);
		expect(gamma.hasAttribute("data-selected")).toBe(false);
		expect(rowBoxes()).toHaveLength(3);
		expect(headerBox()).not.toBeNull();
		expect(document.querySelector('[role="toolbar"]')).not.toBeNull();
	});

	it("toggles rows instead of opening them while rows are selected", async () => {
		await modifierClick(rows()[0]);
		expect(selectedRows()).toHaveLength(1);

		await click(rows()[1]);
		expect(selectedRows()).toHaveLength(2);
		await click(rows()[1]);
		expect(selectedRows()).toHaveLength(1);

		await wait(380);
		expect(opened).toEqual([]);
	});

	it("still opens a paper on a plain click when nothing is selected", async () => {
		await click(rows()[2]);
		await wait(380);
		expect(opened).toEqual(["c"]);
	});

	it("selects every visible row from the header checkbox", async () => {
		await modifierClick(rows()[0]);
		await click(headerBox() as Element);
		expect(selectedRows()).toHaveLength(3);
	});

	it("toggles a row from its checkbox", async () => {
		await modifierClick(rows()[0]);
		const boxes = rowBoxes();
		await click(boxes[2]);
		expect(selectedRows()).toHaveLength(2);
		await click(boxes[2]);
		expect(selectedRows()).toHaveLength(1);
	});

	it("drops selection mode when the selection is cleared", async () => {
		await modifierClick(rows()[0]);
		expect(rowBoxes()).toHaveLength(3);
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(selectedRows()).toHaveLength(0);
		expect(rowBoxes()).toHaveLength(0);
	});

	it("opens the single-row menu for an unselected row", async () => {
		await rightClick(rows()[0], 60);
		// No vault path here, so the only single-row action is "Open".
		expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
	});

	it("swaps to batch actions when right-clicking a selected row", async () => {
		await modifierClick(rows()[0]);
		await modifierClick(rows()[1]);
		await rightClick(rows()[1], 100);
		const items = [...document.querySelectorAll('[role="menuitem"]')];
		// add-to-chat + copy-to-folder + delete + clear (download needs edit
		// rights, i.e. a vault).
		expect(items).toHaveLength(4);
	});
});
