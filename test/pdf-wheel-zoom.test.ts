import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindZoomGesture, wheelDeltaToZoomRatio } from "@/lib/pdf/wheel-zoom";

/** Records listeners per type and dispatches wheel events to the wheel one. */
function wheelTargetHarness() {
	const listeners = new Map<string, (event: WheelEvent) => void>();
	let attachedPassive: boolean | undefined;
	return {
		target: {
			addEventListener: vi.fn(
				(
					type: string,
					next: (event: WheelEvent) => void,
					options?: AddEventListenerOptions,
				) => {
					listeners.set(type, next);
					if (type === "wheel") attachedPassive = options?.passive;
				},
			),
			removeEventListener: vi.fn((type: string, prev: unknown) => {
				if (listeners.get(type) === prev) listeners.delete(type);
			}),
		} as unknown as HTMLElement,
		isPassive: () => attachedPassive,
		hasListener: () => listeners.has("wheel"),
		dispatch: (init: { deltaY: number; ctrlKey?: boolean }) => {
			const preventDefault = vi.fn();
			listeners.get("wheel")?.({
				deltaY: init.deltaY,
				ctrlKey: init.ctrlKey ?? false,
				metaKey: false,
				cancelable: true,
				clientX: 40,
				clientY: 60,
				preventDefault,
			} as unknown as WheelEvent);
			return preventDefault;
		},
	};
}

describe("PDF wheel zoom gesture binding", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("binds one started gesture per Ctrl+wheel stream and ends it on idle", () => {
		const harness = wheelTargetHarness();
		const onZoomStart = vi.fn();
		const onZoomChange = vi.fn();
		const onZoomEnd = vi.fn();
		bindZoomGesture({
			target: harness.target,
			onZoomStart,
			onZoomChange,
			onZoomEnd,
			idleMs: 150,
		});

		harness.dispatch({ deltaY: -50, ctrlKey: true });
		harness.dispatch({ deltaY: -50, ctrlKey: true });
		expect(onZoomStart).toHaveBeenCalledTimes(1);
		expect(onZoomStart).toHaveBeenCalledWith({ x: 40, y: 60 });
		// Magnification accumulates across the ticks of one gesture.
		expect(onZoomChange).toHaveBeenCalledTimes(2);
		expect(onZoomChange.mock.calls[1][0]).toBeCloseTo(
			wheelDeltaToZoomRatio(-50) ** 2,
			10,
		);
		expect(onZoomEnd).not.toHaveBeenCalled();

		vi.advanceTimersByTime(150);
		expect(onZoomEnd).toHaveBeenCalledTimes(1);

		// The next tick starts a fresh gesture with its own ratio baseline.
		harness.dispatch({ deltaY: -50, ctrlKey: true });
		expect(onZoomStart).toHaveBeenCalledTimes(2);
		expect(onZoomChange.mock.calls[2][0]).toBeCloseTo(
			wheelDeltaToZoomRatio(-50),
			10,
		);
	});

	it("starts non-passive so a cold pinch can cancel platform zoom", () => {
		const harness = wheelTargetHarness();
		const onZoomChange = vi.fn();
		bindZoomGesture({
			target: harness.target,
			onZoomStart: vi.fn(),
			onZoomChange,
			onZoomEnd: vi.fn(),
		});

		expect(harness.isPassive()).toBe(false);
		const preventDefault = harness.dispatch({ deltaY: -40, ctrlKey: true });
		expect(preventDefault).toHaveBeenCalledTimes(1);
		expect(onZoomChange).toHaveBeenCalledTimes(1);
		expect(harness.isPassive()).toBe(false);
	});

	it("goes passive for a plain scroll gesture and back after it idles", () => {
		const harness = wheelTargetHarness();
		const onZoomChange = vi.fn();
		bindZoomGesture({
			target: harness.target,
			onZoomStart: vi.fn(),
			onZoomChange,
			onZoomEnd: vi.fn(),
			idleMs: 200,
		});

		harness.dispatch({ deltaY: 30 });
		expect(harness.isPassive()).toBe(true);
		expect(onZoomChange).not.toHaveBeenCalled();

		// Continued scrolling keeps the listener passive.
		vi.advanceTimersByTime(150);
		harness.dispatch({ deltaY: 30 });
		vi.advanceTimersByTime(150);
		expect(harness.isPassive()).toBe(true);

		vi.advanceTimersByTime(200);
		expect(harness.isPassive()).toBe(false);
	});

	it("still zooms when a pinch starts mid-scroll, without a passive preventDefault", () => {
		const harness = wheelTargetHarness();
		const onZoomChange = vi.fn();
		bindZoomGesture({
			target: harness.target,
			onZoomStart: vi.fn(),
			onZoomChange,
			onZoomEnd: vi.fn(),
		});

		harness.dispatch({ deltaY: 30 });
		expect(harness.isPassive()).toBe(true);

		const preventDefault = harness.dispatch({ deltaY: -40, ctrlKey: true });
		expect(preventDefault).not.toHaveBeenCalled();
		expect(onZoomChange).toHaveBeenCalledTimes(1);
		// Next tick of the same pinch is cancelable again.
		expect(harness.isPassive()).toBe(false);
	});

	it("dispose detaches the listener and drops the idle timer", () => {
		const harness = wheelTargetHarness();
		const binding = bindZoomGesture({
			target: harness.target,
			onZoomStart: vi.fn(),
			onZoomChange: vi.fn(),
			onZoomEnd: vi.fn(),
		});

		harness.dispatch({ deltaY: 30 });
		binding.dispose();
		expect(harness.hasListener()).toBe(false);
		// wheel + 3 WebKit gesture listeners, plus one passive-toggle re-add.
		expect(harness.target.addEventListener).toHaveBeenCalledTimes(5);
	});

	it("dispose drops a pending end-of-gesture timer", () => {
		const harness = wheelTargetHarness();
		const onZoomEnd = vi.fn();
		const binding = bindZoomGesture({
			target: harness.target,
			onZoomStart: vi.fn(),
			onZoomChange: vi.fn(),
			onZoomEnd,
		});

		harness.dispatch({ deltaY: -40, ctrlKey: true });
		binding.dispose();
		vi.advanceTimersByTime(1000);
		expect(onZoomEnd).not.toHaveBeenCalled();
	});
});

/** Records listeners per event type so gesture events can be dispatched. */
function gestureTargetHarness() {
	const listeners = new Map<string, (event: unknown) => void>();
	return {
		target: {
			addEventListener: vi.fn(
				(type: string, listener: (event: unknown) => void) => {
					listeners.set(type, listener);
				},
			),
			removeEventListener: vi.fn((type: string) => {
				listeners.delete(type);
			}),
		} as unknown as HTMLElement,
		dispatch: (
			type: string,
			scale: number,
			point?: { x: number; y: number },
		) => {
			const preventDefault = vi.fn();
			listeners.get(type)?.({
				scale,
				clientX: point?.x,
				clientY: point?.y,
				preventDefault,
			});
			return preventDefault;
		},
		hasListener: (type: string) => listeners.has(type),
	};
}

describe("PDF wheel zoom WebKit gesture binding", () => {
	it("reports the pinch magnification relative to the gesture start", () => {
		const harness = gestureTargetHarness();
		const onZoomStart = vi.fn();
		const onZoomChange = vi.fn();
		const onZoomEnd = vi.fn();
		bindZoomGesture({
			target: harness.target,
			onZoomStart,
			onZoomChange,
			onZoomEnd,
		});

		const startPrevent = harness.dispatch("gesturestart", 1, { x: 12, y: 34 });
		expect(startPrevent).toHaveBeenCalledTimes(1);
		expect(onZoomStart).toHaveBeenCalledWith({ x: 12, y: 34 });

		// Magnification is cumulative, not per-event: 1 → 1.25 → 1.5.
		harness.dispatch("gesturechange", 1.25);
		expect(onZoomChange).toHaveBeenLastCalledWith(1.25);
		harness.dispatch("gesturechange", 1.5);
		expect(onZoomChange).toHaveBeenLastCalledWith(1.5);

		harness.dispatch("gestureend", 1.5);
		expect(onZoomEnd).toHaveBeenCalledTimes(1);
	});

	it("resets the scale baseline when the gesture ends", () => {
		const harness = gestureTargetHarness();
		const onZoomChange = vi.fn();
		bindZoomGesture({
			target: harness.target,
			onZoomStart: vi.fn(),
			onZoomChange,
			onZoomEnd: vi.fn(),
		});

		harness.dispatch("gesturestart", 1);
		harness.dispatch("gesturechange", 2);
		harness.dispatch("gestureend", 2);
		onZoomChange.mockClear();

		// A fresh gesture starts from its own baseline, not the previous 2.
		harness.dispatch("gesturestart", 1);
		harness.dispatch("gesturechange", 1.1);
		expect(onZoomChange).toHaveBeenLastCalledWith(1.1);
	});

	it("dispose detaches the gesture listeners", () => {
		const harness = gestureTargetHarness();
		const onZoomChange = vi.fn();
		const binding = bindZoomGesture({
			target: harness.target,
			onZoomStart: vi.fn(),
			onZoomChange,
			onZoomEnd: vi.fn(),
		});

		expect(harness.hasListener("gesturestart")).toBe(true);
		expect(harness.hasListener("gesturechange")).toBe(true);
		expect(harness.hasListener("gestureend")).toBe(true);

		binding.dispose();
		expect(harness.hasListener("gesturestart")).toBe(false);
		expect(harness.hasListener("gesturechange")).toBe(false);
		expect(harness.hasListener("gestureend")).toBe(false);

		harness.dispatch("gesturechange", 2);
		expect(onZoomChange).not.toHaveBeenCalled();
	});
});

describe("PDF wheel delta to zoom ratio", () => {
	it("inverts the magnification a pinch reports", () => {
		// A wheel tick that reports a 1.25× pinch magnification.
		const delta = -1000 * Math.log(1.25);
		expect(wheelDeltaToZoomRatio(delta)).toBeCloseTo(1.25, 10);
	});

	it("zooms in for negative deltas and out for positive ones", () => {
		expect(wheelDeltaToZoomRatio(-100)).toBeGreaterThan(1);
		expect(wheelDeltaToZoomRatio(100)).toBeLessThan(1);
	});
});
