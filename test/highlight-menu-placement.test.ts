import { describe, expect, it } from "vitest";

import {
	HIGHLIGHT_MENU_RIGHT_PIN,
	placeHighlightToolbar,
	unionHighlightBoxes,
} from "@/lib/pdf/highlight/menu-placement";

const viewport = { width: 1200, height: 800 };
const menu = { width: 180, height: 32 };

function intersects(
	top: number,
	height: number,
	selection: { top: number; bottom: number },
): boolean {
	return top < selection.bottom && top + height > selection.top;
}

describe("placeHighlightToolbar", () => {
	const selection = { left: 400, top: 200, right: 560, bottom: 220 };

	it("opens below the selection when that side fits", () => {
		const placed = placeHighlightToolbar({ selection, menu, viewport });
		expect(placed.side).toBe("below");
		expect(placed.top).toBe(selection.bottom + 6);
		expect(intersects(placed.top, menu.height, selection)).toBe(false);
	});

	it("flips above when the selection sits on the bottom edge", () => {
		const low = { left: 400, top: 760, right: 560, bottom: 784 };
		const placed = placeHighlightToolbar({
			selection: low,
			menu,
			viewport,
		});
		expect(placed.side).toBe("above");
		expect(placed.top + menu.height).toBeLessThanOrEqual(low.top);
		expect(intersects(placed.top, menu.height, low)).toBe(false);
	});

	it("keeps the bar off a tall selection instead of clamping onto it", () => {
		const tall = { left: 100, top: 40, right: 300, bottom: 760 };
		const placed = placeHighlightToolbar({
			selection: tall,
			menu,
			viewport,
		});
		expect(intersects(placed.top, menu.height, tall)).toBe(false);
	});

	it("pins the right edge just past the selection center", () => {
		const placed = placeHighlightToolbar({ selection, menu, viewport });
		const center = (selection.left + selection.right) / 2;
		expect(placed.left + menu.width).toBe(center + HIGHLIGHT_MENU_RIGHT_PIN);
	});
});

describe("unionHighlightBoxes", () => {
	it("drops an empty box and unions the rest", () => {
		expect(
			unionHighlightBoxes([
				{ left: 0, top: 0, right: 0, bottom: 10 },
				{ left: 4, top: 8, right: 20, bottom: 18 },
				{ left: 12, top: 2, right: 30, bottom: 12 },
			]),
		).toEqual({ left: 4, top: 2, right: 30, bottom: 18 });
	});
});
