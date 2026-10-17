// @vitest-environment happy-dom

import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetInViewPools, useInView } from "@/hooks/use-in-view";

type ObserverRecord = {
	callback: IntersectionObserverCallback;
	observed: Element[];
	disconnected: boolean;
};

let observers: ObserverRecord[] = [];

class MockIntersectionObserver {
	callback: IntersectionObserverCallback;
	observed: Element[] = [];
	disconnected = false;
	constructor(callback: IntersectionObserverCallback) {
		this.callback = callback;
		observers.push(this as unknown as ObserverRecord);
	}
	observe(element: Element) {
		this.observed.push(element);
	}
	unobserve(element: Element) {
		this.observed = this.observed.filter((item) => item !== element);
	}
	disconnect() {
		this.disconnected = true;
	}
}

let root: Root;
let container: HTMLDivElement;
let latest: boolean | null = null;

function Fixture({
	keepAlive,
	size = { width: 40, height: 12 },
}: {
	keepAlive: boolean;
	size?: { width: number; height: number };
}) {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, { keepAlive, rootMargin: "1200px 0px" });
	latest = inView;
	return createElement("div", {
		ref: (node: HTMLDivElement | null) => {
			ref.current = node;
			if (node) {
				node.getBoundingClientRect = () =>
					({
						width: size.width,
						height: size.height,
					}) as unknown as DOMRect;
			}
		},
		"data-in-view": String(inView),
	});
}

async function mount(props: Parameters<typeof Fixture>[0]) {
	await act(async () => {
		root.render(createElement(Fixture, props));
	});
}

/** Shared pools dispatch by `entry.target`, so entries must carry it. */
function feed(observer: ObserverRecord, isIntersecting: boolean) {
	observer.callback(
		[
			{
				isIntersecting,
				target: observer.observed[0],
			} as unknown as IntersectionObserverEntry,
		],
		observer as unknown as IntersectionObserver,
	);
}

beforeEach(() => {
	observers = [];
	latest = null;
	resetInViewPools();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	resetInViewPools();
	vi.unstubAllGlobals();
});

describe("useInView", () => {
	it("latches on the first hit with a single shared observer", async () => {
		await mount({ keepAlive: true });

		// One pool for the margin, shared by every consumer — not one observer per
		// hook (a math-heavy note would otherwise hold thousands).
		expect(observers).toHaveLength(1);
		const observer = observers[0];
		expect(observer.observed).toHaveLength(1);

		await act(async () => {
			feed(observer, true);
		});
		expect(latest).toBe(true);

		await act(async () => {
			feed(observer, false);
		});
		// Latched: the work is done once.
		expect(latest).toBe(true);
	});

	it("separates the enter and evict bands when keepAlive is false", async () => {
		await mount({ keepAlive: false });
		// Two margins => two shared observers: rendering changes the element's own
		// box, so a single threshold would evict and re-enter forever.
		expect(observers).toHaveLength(2);
		const [enter, exit] = observers;

		await act(async () => {
			feed(enter, true);
		});
		expect(latest).toBe(true);

		// Still inside the wider eviction band: must not flip — this is the dead
		// band that stops the boundary from oscillating.
		await act(async () => {
			feed(exit, true);
		});
		expect(latest).toBe(true);

		// Scrolled well past: the heavy content gives its nodes back.
		await act(async () => {
			feed(exit, false);
		});
		expect(latest).toBe(false);

		await act(async () => {
			feed(enter, true);
		});
		expect(latest).toBe(true);
	});

	it("shares one observer across many consumers on the same margin", async () => {
		const refA = { current: null } as React.RefObject<HTMLDivElement | null>;
		const refB = { current: null } as React.RefObject<HTMLDivElement | null>;
		// happy-dom boxes are zero-sized, which takes the "treat as visible"
		// shortcut instead of subscribing.
		const sized =
			(ref: React.RefObject<HTMLDivElement | null>) =>
			(node: HTMLDivElement | null) => {
				ref.current = node;
				if (node) {
					node.getBoundingClientRect = () =>
						({ width: 40, height: 12 }) as unknown as DOMRect;
				}
			};
		function Many() {
			useInView(refA, { keepAlive: false, rootMargin: "1200px 0px" });
			useInView(refB, { keepAlive: false, rootMargin: "1200px 0px" });
			return createElement("div", null, [
				createElement("div", { key: "a", ref: sized(refA) }),
				createElement("div", { key: "b", ref: sized(refB) }),
			]);
		}
		await act(async () => {
			root.render(createElement(Many));
		});

		// Still two pools total (enter + evict), each observing both elements.
		expect(observers).toHaveLength(2);
		expect(observers[0].observed).toHaveLength(2);
		expect(observers[1].observed).toHaveLength(2);
	});

	it("treats a zero-area target as visible so content cannot get stuck", async () => {
		await mount({ keepAlive: false, size: { width: 0, height: 0 } });

		expect(latest).toBe(true);
	});

	it("unobserves an element once its last listener goes away", async () => {
		await mount({ keepAlive: false });
		expect(observers[0].observed).toHaveLength(1);

		await act(async () => {
			root.unmount();
		});

		expect(observers[0].observed).toHaveLength(0);
		expect(observers[1].observed).toHaveLength(0);
	});
});
