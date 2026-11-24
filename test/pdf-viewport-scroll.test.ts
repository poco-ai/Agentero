import { describe, expect, it, vi } from "vitest";
import {
	createPdfViewportMetricsScheduler,
	createPdfViewportScrollScheduler,
} from "@/lib/pdf/viewport-scroll";

function frameHarness() {
	let callback: FrameRequestCallback | null = null;
	return {
		requestFrame: vi.fn((next: FrameRequestCallback) => {
			callback = next;
			return 7;
		}),
		cancelFrame: vi.fn(() => {
			callback = null;
		}),
		flush: () => {
			const next = callback;
			callback = null;
			next?.(0);
		},
	};
}

describe("PDF viewport scroll scheduler", () => {
	it("drops a deferred page jump when native scrolling starts first", () => {
		const frames = frameHarness();
		const apply = vi.fn();
		const scheduler = createPdfViewportScrollScheduler({
			apply,
			requestFrame: frames.requestFrame,
			cancelFrame: frames.cancelFrame,
		});

		scheduler.schedule({ x: 0, y: 0, behavior: "instant" });
		// This is the native viewport scroll event produced by the user's wheel.
		scheduler.cancelPending();
		frames.flush();

		expect(apply).not.toHaveBeenCalled();
	});

	it("coalesces several same-frame requests to the latest target", () => {
		const frames = frameHarness();
		const apply = vi.fn();
		const scheduler = createPdfViewportScrollScheduler({
			apply,
			requestFrame: frames.requestFrame,
			cancelFrame: frames.cancelFrame,
		});

		scheduler.schedule({ x: 10, y: 100, behavior: "instant" });
		scheduler.schedule({ x: 20, y: 200, behavior: "instant" });
		frames.flush();

		expect(apply).toHaveBeenCalledTimes(1);
		expect(apply).toHaveBeenCalledWith({
			x: 20,
			y: 200,
			behavior: "instant",
		});

		// A virtual-page reorder, zoom relayout, or synchronized pane may emit
		// another programmatic target after the previous target was applied;
		// later requests must remain schedulable.
		scheduler.schedule({ x: 30, y: 300, behavior: "instant" });
		frames.flush();

		expect(apply).toHaveBeenLastCalledWith({
			x: 30,
			y: 300,
			behavior: "instant",
		});
	});
});

describe("PDF viewport metrics scheduler", () => {
	it("commits a leader on the next frame, once per frame", () => {
		const frames = frameHarness();
		const apply = vi.fn();
		const scheduler = createPdfViewportMetricsScheduler({
			apply,
			requestFrame: frames.requestFrame,
			cancelFrame: frames.cancelFrame,
		});

		scheduler.schedule(false);
		scheduler.schedule(false);
		expect(apply).not.toHaveBeenCalled();
		frames.flush();
		expect(apply).toHaveBeenCalledTimes(1);

		scheduler.schedule(false);
		frames.flush();
		expect(apply).toHaveBeenCalledTimes(2);
		scheduler.dispose();
	});

	it("throttles a follower and still commits its last position", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const frames = frameHarness();
		const apply = vi.fn();
		const scheduler = createPdfViewportMetricsScheduler({
			apply,
			requestFrame: frames.requestFrame,
			cancelFrame: frames.cancelFrame,
			now: () => Date.now(),
		});
		try {
			// The first follower event commits immediately so a newly paired
			// pane does not start a gesture without any metrics.
			scheduler.schedule(true);
			frames.flush();
			expect(apply).toHaveBeenCalledTimes(1);

			// Events inside the interval are coalesced, not committed per frame.
			vi.advanceTimersByTime(16);
			scheduler.schedule(true);
			vi.advanceTimersByTime(16);
			scheduler.schedule(true);
			frames.flush();
			expect(apply).toHaveBeenCalledTimes(1);

			// The trailing commit lands one interval after the first commit even
			// when the follower keeps firing scroll events.
			vi.advanceTimersByTime(68);
			frames.flush();
			expect(apply).toHaveBeenCalledTimes(2);

			// Traffic stops right after a commit: the trailing timer still
			// commits the last skipped position.
			vi.advanceTimersByTime(16);
			scheduler.schedule(true);
			vi.advanceTimersByTime(84);
			frames.flush();
			expect(apply).toHaveBeenCalledTimes(3);
		} finally {
			scheduler.dispose();
			vi.useRealTimers();
		}
	});

	it("commits immediately when a throttled pane becomes the leader", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const frames = frameHarness();
		const apply = vi.fn();
		const scheduler = createPdfViewportMetricsScheduler({
			apply,
			requestFrame: frames.requestFrame,
			cancelFrame: frames.cancelFrame,
			now: () => Date.now(),
		});
		try {
			scheduler.schedule(true);
			frames.flush();
			expect(apply).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(16);
			scheduler.schedule(true);
			// The user grabbed this pane: drop the throttle window.
			scheduler.schedule(false);
			frames.flush();
			expect(apply).toHaveBeenCalledTimes(2);
		} finally {
			scheduler.dispose();
			vi.useRealTimers();
		}
	});
});
