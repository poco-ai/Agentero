import { describe, expect, it } from "vitest";
import {
	acquireSelectionOverlay,
	isSelectionOverlayActive,
} from "@/lib/workspace/selection-overlay";

describe("selection overlay guard", () => {
	it("stays active until the last overlay releases", () => {
		expect(isSelectionOverlayActive()).toBe(false);

		const releaseMenu = acquireSelectionOverlay();
		expect(isSelectionOverlayActive()).toBe(true);

		const releaseCard = acquireSelectionOverlay();
		expect(isSelectionOverlayActive()).toBe(true);

		releaseMenu();
		expect(isSelectionOverlayActive()).toBe(true);

		releaseCard();
		expect(isSelectionOverlayActive()).toBe(false);
	});

	it("releases idempotently and cannot underflow the count", () => {
		const release = acquireSelectionOverlay();
		release();
		release();
		expect(isSelectionOverlayActive()).toBe(false);

		const next = acquireSelectionOverlay();
		expect(isSelectionOverlayActive()).toBe(true);
		next();
		expect(isSelectionOverlayActive()).toBe(false);
	});
});
