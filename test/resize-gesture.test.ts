import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createResizeGesture,
	hasResizeGesture,
	installResizeGesture,
	RESIZE_GESTURE_QUIET_MS,
	resetResizeGestureFanout,
	resizeGestureFor,
	subscribeResizeGesture,
} from "@/lib/workspace/resize-gesture";

/** happy-dom's ResizeObserver never fires; drive one by hand instead. */
class MockResizeObserver {
	static instances: MockResizeObserver[] = [];
	callback: ResizeObserverCallback;
	observed: Element[] = [];
	disconnected = false;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		MockResizeObserver.instances.push(this);
	}
	observe(element: Element) {
		this.observed.push(element);
	}
	unobserve() {}
	disconnect() {
		this.disconnected = true;
	}
	fire() {
		this.callback([], this as unknown as ResizeObserver);
	}
}

/** A root that exposes `nodeType` + `ownerDocument`, as the real element does. */
function fakeRoot() {
	const ownerDocument = { defaultView: { ResizeObserver: MockResizeObserver } };
	return { nodeType: 1, ownerDocument } as unknown as Element;
}

function lastObserver() {
	const observer = MockResizeObserver.instances.at(-1);
	if (!observer) throw new Error("observer was not constructed");
	return observer;
}

beforeEach(() => {
	vi.useFakeTimers();
	MockResizeObserver.instances = [];
	vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Resize gesture", () => {
	it("observes the root and ignores the priming callback", () => {
		const root = fakeRoot();
		const gesture = createResizeGesture(root);
		const seen: boolean[] = [];
		gesture.subscribe((active) => seen.push(active));

		expect(lastObserver().observed).toEqual([root]);
		lastObserver().fire();

		expect(seen).toEqual([]);
		expect(gesture.isActive()).toBe(false);
	});

	it("activates on a workspace resize and ends after the quiet window", () => {
		const gesture = createResizeGesture(fakeRoot());
		const seen: boolean[] = [];
		gesture.subscribe((active) => seen.push(active));
		lastObserver().fire();

		lastObserver().fire();
		expect(gesture.isActive()).toBe(true);

		vi.advanceTimersByTime(RESIZE_GESTURE_QUIET_MS - 1);
		expect(gesture.isActive()).toBe(true);

		vi.advanceTimersByTime(1);
		expect(gesture.isActive()).toBe(false);
		expect(seen).toEqual([true, false]);
	});

	it("extends the window while the workspace keeps resizing", () => {
		const gesture = createResizeGesture(fakeRoot());
		lastObserver().fire();

		lastObserver().fire();
		vi.advanceTimersByTime(100);
		lastObserver().fire();
		vi.advanceTimersByTime(100);
		// 200ms elapsed, but never a full quiet window.
		expect(gesture.isActive()).toBe(true);

		vi.advanceTimersByTime(RESIZE_GESTURE_QUIET_MS);
		expect(gesture.isActive()).toBe(false);
	});

	it("ref-counts explicit gestures so overlapping sources do not end early", () => {
		const gesture = createResizeGesture(fakeRoot());

		gesture.begin();
		gesture.begin();
		expect(gesture.isActive()).toBe(true);

		gesture.end();
		expect(gesture.isActive()).toBe(true);

		gesture.end();
		expect(gesture.isActive()).toBe(false);

		// An unmatched end must not drive the count negative.
		gesture.end();
		gesture.begin();
		expect(gesture.isActive()).toBe(true);
	});

	it("keeps an explicit gesture active across a stray quiet window", () => {
		const gesture = createResizeGesture(fakeRoot());
		gesture.begin();

		lastObserver().fire();
		vi.advanceTimersByTime(RESIZE_GESTURE_QUIET_MS * 2);

		// The auto signal expired, but the sash is still held.
		expect(gesture.isActive()).toBe(true);
	});

	it("reports only transitions", () => {
		const gesture = createResizeGesture(fakeRoot());
		const seen: boolean[] = [];
		gesture.subscribe((active) => seen.push(active));

		gesture.begin();
		gesture.begin();
		vi.advanceTimersByTime(1000);
		gesture.end();
		gesture.end();

		expect(seen).toEqual([true, false]);
	});

	it("stops listening on unsubscribe and dispose", () => {
		const gesture = createResizeGesture(fakeRoot());
		const seen: boolean[] = [];
		const unsubscribe = gesture.subscribe((active) => seen.push(active));

		unsubscribe();
		gesture.begin();
		expect(seen).toEqual([]);

		gesture.dispose();
		expect(lastObserver().disconnected).toBe(true);
		expect(gesture.isActive()).toBe(false);
	});

	it("resolves the gesture from the workspace element it was installed on", () => {
		const root = fakeRoot();
		const other = fakeRoot();
		const gesture = installResizeGesture(root);

		expect(resizeGestureFor(root)).toBe(gesture);
		expect(resizeGestureFor(other)).toBeNull();
		expect(resizeGestureFor(null)).toBeNull();
	});
});

describe("Resize gesture fan-out", () => {
	afterEach(() => {
		resetResizeGestureFanout();
	});

	it("delivers to a subscriber that registered before the workspace existed", () => {
		// The ordering that regressed the PDF gate: a child layout effect
		// subscribes before the parent's effect installs the gesture.
		const seen: boolean[] = [];
		subscribeResizeGesture((active) => seen.push(active));

		installResizeGesture(fakeRoot());
		const observer = lastObserver();
		observer.fire();
		observer.fire();

		expect(seen).toEqual([true]);
		vi.advanceTimersByTime(RESIZE_GESTURE_QUIET_MS);
		expect(seen).toEqual([true, false]);
	});

	it("re-attaches to a replacement gesture instead of going silent", () => {
		const seen: boolean[] = [];
		subscribeResizeGesture((active) => seen.push(active));

		installResizeGesture(fakeRoot());
		const first = lastObserver();
		installResizeGesture(fakeRoot());
		const second = lastObserver();

		second.fire();
		second.fire();
		expect(seen).toEqual([true]);

		// The replaced workspace's observer must no longer drive the fan-out.
		first.fire();
		expect(seen).toEqual([true]);
	});

	it("stops delivering after unsubscribe", () => {
		const seen: boolean[] = [];
		const unsubscribe = subscribeResizeGesture((active) => seen.push(active));

		installResizeGesture(fakeRoot());
		lastObserver().fire();
		lastObserver().fire();
		expect(seen).toEqual([true]);

		unsubscribe();
		vi.advanceTimersByTime(RESIZE_GESTURE_QUIET_MS * 2);
		expect(seen).toEqual([true]);
	});

	it("reports whether a gesture is installed", () => {
		expect(hasResizeGesture()).toBe(false);
		installResizeGesture(fakeRoot());
		expect(hasResizeGesture()).toBe(true);
		resetResizeGestureFanout();
		expect(hasResizeGesture()).toBe(false);
	});
});
