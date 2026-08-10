import { describe, expect, it } from "vitest";

import {
	SELECTION_CARD_EDGE as EDGE,
	placeSelectionCard,
} from "@/components/viewer/pdf/cards/selection-card";

/**
 * placeSelectionCard falls back to 1200×800 when `window` is missing
 * (Node / vitest without happy-dom). Tests use the same defaults.
 */
const VW = 1200;
const VH = 800;

describe("placeSelectionCard", () => {
	it("keeps the card fully inside the viewport near the bottom-right", () => {
		const width = 360;
		const preferredH = 420;

		const { left, top, maxHeight } = placeSelectionCard(
			{ x: VW - 20, y: VH - 10 },
			{ width, height: preferredH },
		);

		expect(left).toBeGreaterThanOrEqual(EDGE);
		expect(left + Math.min(width, VW - EDGE * 2)).toBeLessThanOrEqual(
			VW - EDGE + 0.5,
		);
		expect(top).toBeGreaterThanOrEqual(EDGE);
		expect(top + maxHeight).toBeLessThanOrEqual(VH - EDGE + 0.5);
		expect(maxHeight).toBeGreaterThan(0);
		expect(maxHeight).toBeLessThanOrEqual(preferredH);
	});

	it("keeps the card fully inside the viewport near the top-left", () => {
		const width = 320;
		const preferredH = 360;

		const { left, top, maxHeight } = placeSelectionCard(
			{ x: 4, y: 4 },
			{ width, height: preferredH, preferRight: true },
		);

		expect(left).toBeGreaterThanOrEqual(EDGE);
		expect(top).toBeGreaterThanOrEqual(EDGE);
		expect(top + maxHeight).toBeLessThanOrEqual(VH - EDGE + 0.5);
		expect(left + Math.min(width, VW - EDGE * 2)).toBeLessThanOrEqual(
			VW - EDGE + 0.5,
		);
	});

	it("shrinks maxHeight when the preferred height exceeds the viewport", () => {
		const { top, maxHeight } = placeSelectionCard(
			{ x: 100, y: 100 },
			{ width: 280, height: 10_000 },
		);

		expect(maxHeight).toBeLessThanOrEqual(VH - EDGE * 2);
		expect(top + maxHeight).toBeLessThanOrEqual(VH - EDGE + 0.5);
	});

	it("flips to the left when there is no room on the right", () => {
		const width = 360;
		const screenX = VW - 30;

		const { left } = placeSelectionCard(
			{ x: screenX, y: 200 },
			{ width, height: 220, preferRight: true },
		);

		// Prefer left of anchor when right side would overflow.
		expect(left + width).toBeLessThanOrEqual(screenX + 1);
	});

	it("plans side from placementWidth so compact cards open on the stable side", () => {
		// Compact (280) would still fit on the right near the edge; expanded (360)
		// would not. Without placementWidth the card would open right then flip.
		const compact = 280;
		const expanded = 360;
		const gap = 4;
		// Right room for compact only: expanded overflows, compact does not.
		const screenX = VW - EDGE - compact - gap - 10;

		const withoutPlan = placeSelectionCard(
			{ x: screenX, y: 200 },
			{ width: compact, height: 260, preferRight: true },
		);
		// Sanity: compact alone prefers the right of the anchor.
		expect(withoutPlan.left).toBe(screenX + gap);

		const compactPlaced = placeSelectionCard(
			{ x: screenX, y: 200 },
			{
				width: compact,
				height: 260,
				placementWidth: expanded,
				preferRight: true,
			},
		);
		const expandedPlaced = placeSelectionCard(
			{ x: screenX, y: 200 },
			{
				width: expanded,
				height: 440,
				placementWidth: expanded,
				preferRight: true,
			},
		);

		// Both sizes share the same left (open left of pin from the start).
		expect(compactPlaced.left).toBe(expandedPlaced.left);
		expect(compactPlaced.left + expanded).toBeLessThanOrEqual(screenX + 1);
		// Expanding must not move left — avoids pointer leave thrash.
		expect(expandedPlaced.left).toBe(compactPlaced.left);
	});

	it("opens fully left of the pin when preferRight is false", () => {
		const width = 320;
		const gap = 4;
		const screenX = 500;
		const { left } = placeSelectionCard(
			{ x: screenX, y: 200 },
			{ width, height: 220, preferRight: false, gap },
		);
		// Card occupies [left, left+width] entirely to the left of the pin.
		expect(left + width).toBeLessThanOrEqual(screenX - gap + 0.5);
	});

	it("plans top from placementHeight so expand does not re-anchor vertically", () => {
		const compactH = 260;
		const expandedH = 440;
		const screenY = VH - EDGE - compactH + 20;

		const compactPlaced = placeSelectionCard(
			{ x: 100, y: screenY },
			{
				width: 280,
				height: compactH,
				placementHeight: expandedH,
				preferRight: true,
			},
		);
		const expandedPlaced = placeSelectionCard(
			{ x: 100, y: screenY },
			{
				width: 360,
				height: expandedH,
				placementHeight: expandedH,
				preferRight: true,
			},
		);

		expect(compactPlaced.top).toBe(expandedPlaced.top);
		expect(expandedPlaced.top + expandedPlaced.maxHeight).toBeLessThanOrEqual(
			VH - EDGE + 0.5,
		);
	});

	it("trackPin follows the anchor on scroll instead of pre-shifting by full height", () => {
		const width = 320;
		const preferredH = 280;

		const mid = placeSelectionCard(
			{ x: 200, y: 400 },
			{ width, height: preferredH, trackPin: true },
		);
		const lower = placeSelectionCard(
			{ x: 200, y: 520 },
			{ width, height: preferredH, trackPin: true },
		);
		const planned = placeSelectionCard(
			{ x: 200, y: 400 },
			{ width, height: preferredH, trackPin: false },
		);

		// trackPin keeps top near the pin (screen.y - 8).
		expect(mid.top).toBe(400 - 8);
		expect(lower.top).toBe(520 - 8);
		// Default plan mode would often clamp both to the same top for tall cards.
		expect(mid.top).not.toBe(lower.top);
		// Without trackPin, a mid-viewport pin with height 280 is still clamped
		// less aggressively than 420 — but mid should still track pin.
		expect(mid.top).toBeLessThanOrEqual(planned.top + 1);
		expect(mid.top + mid.maxHeight).toBeLessThanOrEqual(VH - EDGE + 0.5);
		expect(lower.top + lower.maxHeight).toBeLessThanOrEqual(VH - EDGE + 0.5);
	});
});
