import { afterEach, describe, expect, it, vi } from "vitest";

import {
	closeOverlayById,
	closeTopOverlay,
	getOverlayStackSnapshot,
	isAnyOverlayOpen,
	pushOverlay,
} from "@/stores/overlay-store";

afterEach(() => {
	while (isAnyOverlayOpen()) {
		closeTopOverlay();
	}
});

describe("overlay-store", () => {
	it("pushes and closes top first (LIFO)", () => {
		const a = vi.fn();
		const b = vi.fn();
		pushOverlay({ id: "a", close: a });
		pushOverlay({ id: "b", close: b });

		expect(isAnyOverlayOpen()).toBe(true);
		expect(getOverlayStackSnapshot().map((h) => h.id)).toEqual(["a", "b"]);

		expect(closeTopOverlay()).toBe(true);
		expect(b).toHaveBeenCalledTimes(1);
		expect(a).not.toHaveBeenCalled();
		expect(getOverlayStackSnapshot().map((h) => h.id)).toEqual(["a"]);

		expect(closeTopOverlay()).toBe(true);
		expect(a).toHaveBeenCalledTimes(1);
		expect(isAnyOverlayOpen()).toBe(false);
		expect(closeTopOverlay()).toBe(false);
	});

	it("re-push moves an id to the top", () => {
		pushOverlay({ id: "a", close: () => {} });
		pushOverlay({ id: "b", close: () => {} });
		pushOverlay({ id: "a", close: () => {} });

		expect(getOverlayStackSnapshot().map((h) => h.id)).toEqual(["b", "a"]);
	});

	it("closeOverlayById targets a specific layer", () => {
		const a = vi.fn();
		const b = vi.fn();
		pushOverlay({ id: "a", close: a });
		pushOverlay({ id: "b", close: b });

		expect(closeOverlayById("a")).toBe(true);
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).not.toHaveBeenCalled();
		expect(getOverlayStackSnapshot().map((h) => h.id)).toEqual(["b"]);
	});

	it("disposer returned by pushOverlay removes its own layer", () => {
		const dispose = pushOverlay({ id: "a", close: () => {} });
		pushOverlay({ id: "b", close: () => {} });

		dispose();
		expect(getOverlayStackSnapshot().map((h) => h.id)).toEqual(["b"]);
		// Idempotent: a second call is a no-op.
		dispose();
		expect(getOverlayStackSnapshot().map((h) => h.id)).toEqual(["b"]);
	});
});
