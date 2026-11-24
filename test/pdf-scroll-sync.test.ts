import { describe, expect, it, vi } from "vitest";
import {
	alignScrollSyncFrom,
	beginZoomSync,
	cancelPendingViewportScroll,
	endZoomSync,
	followScrollSyncFrom,
	getScrollSyncElement,
	getScrollSyncPartner,
	getScrollSyncPeer,
	getScrollSyncRole,
	handleScrollSyncScroll,
	handleScrollSyncScrollEnd,
	holdScrollSync,
	invalidateScrollSyncGeometry,
	isScrollSyncFollower,
	mapScrollByContent,
	mergeSyncedScrollPosition,
	registerScrollSyncElement,
	registerScrollSyncPair,
	registerScrollSyncPeer,
	type ScrollSyncPeer,
	type SyncScrollMetrics,
	unregisterScrollSyncPair,
} from "@/lib/pdf/scroll-sync";

function metrics(
	partial: Partial<SyncScrollMetrics> &
		Pick<SyncScrollMetrics, "scrollTop" | "scrollHeight" | "clientHeight">,
): SyncScrollMetrics {
	return {
		scrollLeft: 0,
		scrollWidth: 100,
		clientWidth: 100,
		...partial,
	};
}

function createPeer(initial: {
	scrollTop?: number;
	scrollHeight?: number;
	clientHeight?: number;
	zoom?: number;
}): ScrollSyncPeer & {
	scrollTop: number;
	zoom: number;
} {
	let scrollTop = initial.scrollTop ?? 0;
	const scrollHeight = initial.scrollHeight ?? 1000;
	const clientHeight = initial.clientHeight ?? 200;
	let zoom = initial.zoom ?? 1;
	return {
		get scrollTop() {
			return scrollTop;
		},
		get zoom() {
			return zoom;
		},
		getMetrics: () => metrics({ scrollTop, scrollHeight, clientHeight }),
		scrollTo: ({ y }) => {
			scrollTop = y;
		},
		onScrollChange: () => () => {},
		getZoom: () => zoom,
		setZoom: (next) => {
			zoom = next;
		},
		onZoomChange: () => () => {},
	};
}

describe("mapScrollByContent", () => {
	it("aligns the same content at the same screen height when one pane has chrome above", () => {
		// The paper path bar pushes the source viewport 36px down. The target
		// is taller and starts at the panel top; the same content must land on
		// the same screen row, not on the two viewport centers.
		const mapped = mapScrollByContent(
			metrics({
				scrollTop: 600,
				scrollHeight: 4000,
				clientHeight: 200,
				viewportTop: 136,
			}),
			metrics({
				scrollTop: 0,
				scrollHeight: 4000,
				clientHeight: 300,
				viewportTop: 100,
			}),
		);
		expect(mapped).toEqual({ x: 0, y: 564 });
	});

	it("falls back to viewport centers when the screen tops are unknown", () => {
		// Same document in two panes with different viewport heights. The
		// source center sits on content y = 700; the target must aim its
		// center there too (700 - 150).
		const mapped = mapScrollByContent(
			metrics({
				scrollTop: 600,
				scrollHeight: 1000,
				clientHeight: 200,
			}),
			metrics({
				scrollTop: 0,
				scrollHeight: 1000,
				clientHeight: 300,
			}),
		);
		expect(mapped).toEqual({ x: 0, y: 550 });
	});

	it("clamps to the target's scrollable range", () => {
		const mapped = mapScrollByContent(
			metrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 }),
			metrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }),
		);
		// Source center is content y = 100; target top would be -100.
		expect(mapped).toEqual({ x: 0, y: 0 });
	});

	it("returns null while either viewport has no layout yet", () => {
		expect(
			mapScrollByContent(
				metrics({ scrollTop: 0, scrollHeight: 0, clientHeight: 200 }),
				metrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 }),
			),
		).toBeNull();
	});
});

describe("mergeSyncedScrollPosition", () => {
	it("does not move the source horizontally after a vertical translation-pane scroll", () => {
		const mapped = mapScrollByContent(
			metrics({
				scrollLeft: 180,
				scrollTop: 400,
				scrollWidth: 1600,
				clientWidth: 420,
				scrollHeight: 2400,
				clientHeight: 300,
			}),
			metrics({
				scrollLeft: 40,
				scrollTop: 300,
				scrollWidth: 1600,
				clientWidth: 620,
				scrollHeight: 2400,
				clientHeight: 300,
			}),
		);
		expect(mapped).toEqual({ x: 80, y: 400 });
		if (!mapped) throw new Error("expected mapped scroll position");
		expect(
			mergeSyncedScrollPosition(
				mapped,
				{ x: 40, y: 300 },
				{ x: false, y: true },
			),
		).toEqual({ x: 40, y: 400 });
	});

	it("keeps horizontal position when only the other pane scrolls vertically", () => {
		expect(
			mergeSyncedScrollPosition(
				{ x: 120, y: 480 },
				{ x: 37, y: 300 },
				{ x: false, y: true },
			),
		).toEqual({ x: 37, y: 480 });
	});

	it("keeps vertical position when only the other pane scrolls horizontally", () => {
		expect(
			mergeSyncedScrollPosition(
				{ x: 120, y: 480 },
				{ x: 37, y: 300 },
				{ x: true, y: false },
			),
		).toEqual({ x: 120, y: 300 });
	});
});

describe("scroll sync registry", () => {
	it("pairs source and target and exposes roles", () => {
		const groupId = registerScrollSyncPair("paper-a", "paper-a::translation");
		expect(getScrollSyncPartner("paper-a")).toBe("paper-a::translation");
		expect(getScrollSyncPartner("paper-a::translation")).toBe("paper-a");
		expect(getScrollSyncRole("paper-a")).toBe("source");
		expect(getScrollSyncRole("paper-a::translation")).toBe("target");
		unregisterScrollSyncPair(groupId);
		expect(getScrollSyncPartner("paper-a")).toBeNull();
	});

	it("replaces a stale pair for the same documents", () => {
		registerScrollSyncPair("paper-a", "paper-a::translation");
		registerScrollSyncPair("paper-a", "paper-a::translation");
		expect(getScrollSyncPartner("paper-a")).toBe("paper-a::translation");
	});

	it("registers peers and clears them on dispose", () => {
		const peer = createPeer({});
		const dispose = registerScrollSyncPeer("paper-a", peer);
		expect(getScrollSyncPeer("paper-a")).toBe(peer);
		dispose();
		expect(getScrollSyncPeer("paper-a")).toBeNull();
	});
});

describe("scroll sync across buffer revision suffixes", () => {
	// Bytes-backed viewers mount as `tab::r<n>` (fresh revision per ArrayBuffer
	// read) while pairs are registered with tab ids; every registry key strips
	// the revision so both forms resolve to the same entry.
	it("resolves a pair queried with either revision form", () => {
		registerScrollSyncPair("paper-a", "paper-a::translation");
		expect(getScrollSyncPartner("paper-a::r1")).toBe("paper-a::translation");
		expect(getScrollSyncPartner("paper-a::translation::r2")).toBe("paper-a");
		expect(getScrollSyncRole("paper-a::r1")).toBe("source");
		expect(getScrollSyncRole("paper-a::translation::r2")).toBe("target");
	});

	it("retires pairs left behind by earlier buffer revisions", () => {
		registerScrollSyncPair("paper-a::r1", "paper-a::translation::r2");
		registerScrollSyncPair("paper-a", "paper-a::translation");
		expect(getScrollSyncPartner("paper-a::r3")).toBe("paper-a::translation");
		expect(getScrollSyncPartner("paper-a::translation::r4")).toBe("paper-a");
	});

	it("stores peers and elements under the base id", () => {
		const peer = createPeer({});
		const disposePeer = registerScrollSyncPeer(
			"paper-a::translation::r2",
			peer,
		);
		expect(getScrollSyncPeer("paper-a::translation")).toBe(peer);
		expect(getScrollSyncPeer("paper-a::translation::r5")).toBe(peer);
		const element = {} as HTMLElement;
		const disposeElement = registerScrollSyncElement(
			"paper-a::translation::r2",
			element,
		);
		expect(getScrollSyncElement("paper-a::translation")).toBe(element);
		expect(getScrollSyncElement("paper-a::r1")).toBeNull();
		disposePeer();
		disposeElement();
		expect(getScrollSyncPeer("paper-a::translation")).toBeNull();
		expect(getScrollSyncElement("paper-a::translation")).toBeNull();
	});

	it("cancels a queued zoom scroll after the final gesture anchor lands", () => {
		const cancelPendingScroll = vi.fn();
		const dispose = registerScrollSyncElement(
			"zoom-paper::r2",
			{} as HTMLElement,
			{ cancelPendingScroll },
		);
		cancelPendingViewportScroll("zoom-paper::r2");
		expect(cancelPendingScroll).toHaveBeenCalledOnce();
		dispose();
		cancelPendingViewportScroll("zoom-paper::r2");
		expect(cancelPendingScroll).toHaveBeenCalledOnce();
	});
});

describe("dual-pane scroll mirror", () => {
	function surface(
		partial: Partial<SyncScrollMetrics> &
			Pick<SyncScrollMetrics, "scrollTop" | "clientHeight">,
	) {
		let cancels = 0;
		const element = {
			scrollLeft: 0,
			scrollWidth: 800,
			clientWidth: 400,
			scrollHeight: 4000,
			...partial,
		} as HTMLElement;
		return {
			element,
			get cancels() {
				return cancels;
			},
			hooks: {
				cancelPendingScroll: () => {
					cancels += 1;
				},
			},
		};
	}

	it("jumps the partner when the gesture ends and ignores the echo", () => {
		const group = registerScrollSyncPair("mirror-a", "mirror-a::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({
			scrollTop: 0,
			clientHeight: 300,
			clientWidth: 500,
		});
		const disposeSource = registerScrollSyncElement(
			"mirror-a::r1",
			source.element,
			source.hooks,
		);
		const disposeTranslation = registerScrollSyncElement(
			"mirror-a::translation::r2",
			translation.element,
			translation.hooks,
		);

		source.element.scrollTop = 600;
		handleScrollSyncScroll("mirror-a::r1");
		expect(translation.element.scrollTop).toBe(0);
		expect(translation.cancels).toBe(0);
		expect(source.element.scrollTop).toBe(600);

		handleScrollSyncScrollEnd("mirror-a::r1");
		// Source center is content y = 700. The taller translation pane aims
		// its own center there (700 - 150), not a scroll-ratio projection.
		expect(translation.element.scrollTop).toBe(550);
		expect(translation.cancels).toBe(1);

		handleScrollSyncScroll("mirror-a::translation::r2");
		expect(source.element.scrollTop).toBe(600);
		expect(translation.element.scrollTop).toBe(550);

		translation.element.scrollTop = 800;
		handleScrollSyncScroll("mirror-a::translation::r2");
		expect(source.element.scrollTop).toBe(600);
		handleScrollSyncScrollEnd("mirror-a::translation::r2");
		expect(source.element.scrollTop).toBe(850);
		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("keeps the partner's horizontal offset when only the vertical axis moves", () => {
		const group = registerScrollSyncPair("mirror-b", "mirror-b::translation");
		const source = surface({
			scrollTop: 100,
			scrollLeft: 40,
			clientHeight: 200,
		});
		const translation = surface({
			scrollTop: 100,
			scrollLeft: 90,
			clientHeight: 200,
			clientWidth: 620,
		});
		const disposeSource = registerScrollSyncElement(
			"mirror-b",
			source.element,
			source.hooks,
		);
		const disposeTranslation = registerScrollSyncElement(
			"mirror-b::translation",
			translation.element,
			translation.hooks,
		);

		source.element.scrollTop = 480;
		handleScrollSyncScroll("mirror-b");
		expect(translation.element.scrollTop).toBe(100);
		expect(translation.element.scrollLeft).toBe(90);

		handleScrollSyncScrollEnd("mirror-b");
		expect(translation.element.scrollTop).toBe(480);
		expect(translation.element.scrollLeft).toBe(90);
		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("does not let a zoom-layout scroll take leadership", () => {
		const group = registerScrollSyncPair("mirror-c", "mirror-c::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({ scrollTop: 0, clientHeight: 200 });
		const disposeSource = registerScrollSyncElement(
			"mirror-c",
			source.element,
			source.hooks,
		);
		const disposeTranslation = registerScrollSyncElement(
			"mirror-c::translation",
			translation.element,
			translation.hooks,
		);
		const release = holdScrollSync("mirror-c::translation");

		translation.element.scrollTop = 700;
		handleScrollSyncScroll("mirror-c::translation");
		expect(source.element.scrollTop).toBe(0);

		release();
		handleScrollSyncScroll("mirror-c::translation");
		expect(source.element.scrollTop).toBe(0);
		handleScrollSyncScrollEnd("mirror-c::translation");
		expect(source.element.scrollTop).toBe(700);
		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("force-aligns a pane that has not moved since it registered", () => {
		const group = registerScrollSyncPair("mirror-d", "mirror-d::translation");
		const source = surface({ scrollTop: 240, clientHeight: 200 });
		const translation = surface({ scrollTop: 0, clientHeight: 200 });
		const disposeSource = registerScrollSyncElement("mirror-d", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"mirror-d::translation",
			translation.element,
		);

		alignScrollSyncFrom("mirror-d", true);
		expect(translation.element.scrollTop).toBe(240);

		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});
});

describe("dual-pane live follow", () => {
	function surface(
		partial: Partial<SyncScrollMetrics> &
			Pick<SyncScrollMetrics, "scrollTop" | "clientHeight">,
	) {
		const element = {
			scrollLeft: 0,
			scrollWidth: 800,
			clientWidth: 400,
			scrollHeight: 4000,
			...partial,
		} as HTMLElement;
		return { element };
	}

	it("follows the leader every frame and still lands the final position", () => {
		const group = registerScrollSyncPair("live-a", "live-a::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({ scrollTop: 0, clientHeight: 200 });
		const disposeSource = registerScrollSyncElement("live-a", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"live-a::translation",
			translation.element,
		);
		source.element.scrollTop = 40;
		handleScrollSyncScroll("live-a");
		// The partner moves from the viewport frame, not from the handler.
		expect(translation.element.scrollTop).toBe(0);
		followScrollSyncFrom("live-a");
		expect(translation.element.scrollTop).toBe(40);

		source.element.scrollTop = 80;
		handleScrollSyncScroll("live-a");
		followScrollSyncFrom("live-a");
		expect(translation.element.scrollTop).toBe(80);

		// Final tick without a following frame: the settle pass still lands it.
		source.element.scrollTop = 90;
		handleScrollSyncScroll("live-a");
		handleScrollSyncScrollEnd("live-a");
		expect(translation.element.scrollTop).toBe(90);
		expect(source.element.scrollTop).toBe(90);

		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("treats a live-follow write as an echo, not user input", () => {
		const group = registerScrollSyncPair("live-b", "live-b::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({ scrollTop: 0, clientHeight: 200 });
		const disposeSource = registerScrollSyncElement("live-b", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"live-b::translation",
			translation.element,
		);
		source.element.scrollTop = 40;
		handleScrollSyncScroll("live-b");
		followScrollSyncFrom("live-b");
		// The follower's own scroll event for the position we just wrote.
		translation.element.scrollTop = 40;
		handleScrollSyncScroll("live-b::translation");

		source.element.scrollTop = 80;
		handleScrollSyncScroll("live-b");
		followScrollSyncFrom("live-b");
		expect(translation.element.scrollTop).toBe(80);
		expect(source.element.scrollTop).toBe(80);

		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("follows a taller partner by content center", () => {
		const group = registerScrollSyncPair("live-c", "live-c::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({
			scrollTop: 0,
			clientHeight: 300,
			clientWidth: 500,
		});
		const disposeSource = registerScrollSyncElement("live-c", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"live-c::translation",
			translation.element,
		);
		source.element.scrollTop = 600;
		handleScrollSyncScroll("live-c");
		followScrollSyncFrom("live-c");
		// Source center is content y = 700. The taller pane aims there.
		expect(translation.element.scrollTop).toBe(550);
		handleScrollSyncScrollEnd("live-c");
		expect(translation.element.scrollTop).toBe(550);
		expect(source.element.scrollTop).toBe(600);

		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("re-reads content metrics after a resize invalidation", () => {
		const group = registerScrollSyncPair("live-d", "live-d::translation");
		const source = surface({
			scrollTop: 0,
			clientHeight: 200,
			scrollHeight: 4000,
		});
		const translation = surface({
			scrollTop: 0,
			clientHeight: 300,
			scrollHeight: 4000,
		});
		const disposeSource = registerScrollSyncElement("live-d", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"live-d::translation",
			translation.element,
		);
		source.element.scrollTop = 3800;
		handleScrollSyncScroll("live-d");
		followScrollSyncFrom("live-d");
		// Clamped by the follower's current 4000px content box.
		expect(translation.element.scrollTop).toBe(3700);

		translation.element.scrollHeight = 8000;
		invalidateScrollSyncGeometry("live-d");
		source.element.scrollTop = 3801;
		handleScrollSyncScroll("live-d");
		followScrollSyncFrom("live-d");
		expect(translation.element.scrollTop).toBe(3751);

		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("keeps the same screen row when one pane carries the path bar", () => {
		const group = registerScrollSyncPair("live-bar", "live-bar::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({ scrollTop: 0, clientHeight: 200 });
		// The paper pane's viewport starts 36px lower because the path bar sits
		// above it; the translation pane has no bar.
		source.element.getBoundingClientRect = () =>
			({ top: 136 }) as unknown as DOMRect;
		translation.element.getBoundingClientRect = () =>
			({ top: 100 }) as unknown as DOMRect;
		const disposeSource = registerScrollSyncElement("live-bar", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"live-bar::translation",
			translation.element,
		);
		source.element.scrollTop = 600;
		handleScrollSyncScroll("live-bar");
		followScrollSyncFrom("live-bar");
		// Same content at the same screen height: the follower scrolls 36px less.
		expect(translation.element.scrollTop).toBe(564);

		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("lets the other pane take over without jumping onto the finger", () => {
		const group = registerScrollSyncPair("live-e", "live-e::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({ scrollTop: 0, clientHeight: 200 });
		const disposeSource = registerScrollSyncElement("live-e", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"live-e::translation",
			translation.element,
		);
		source.element.scrollTop = 100;
		handleScrollSyncScroll("live-e");
		followScrollSyncFrom("live-e");
		expect(translation.element.scrollTop).toBe(100);

		translation.element.scrollTop = 240;
		handleScrollSyncScroll("live-e::translation");
		// The pane that handed the gesture over is still coasting: leave it
		// alone until it stops instead of tugging it every frame.
		followScrollSyncFrom("live-e::translation");
		expect(translation.element.scrollTop).toBe(240);
		expect(source.element.scrollTop).toBe(100);

		source.element.scrollTop = 160;
		handleScrollSyncScroll("live-e");
		expect(source.element.scrollTop).toBe(160);

		handleScrollSyncScrollEnd("live-e::translation");
		expect(source.element.scrollTop).toBe(240);
		expect(translation.element.scrollTop).toBe(240);

		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("settles after a quiet gap when scrollend does not fire", () => {
		vi.useFakeTimers();
		const group = registerScrollSyncPair("live-f", "live-f::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({ scrollTop: 0, clientHeight: 200 });
		const disposeSource = registerScrollSyncElement("live-f", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"live-f::translation",
			translation.element,
		);
		try {
			source.element.scrollTop = 40;
			handleScrollSyncScroll("live-f");
			vi.advanceTimersByTime(50);
			expect(translation.element.scrollTop).toBe(0);
			source.element.scrollTop = 80;
			handleScrollSyncScroll("live-f");
			vi.advanceTimersByTime(89);
			expect(translation.element.scrollTop).toBe(0);
			vi.advanceTimersByTime(1);
			expect(translation.element.scrollTop).toBe(80);
			expect(source.element.scrollTop).toBe(80);
		} finally {
			disposeSource();
			disposeTranslation();
			unregisterScrollSyncPair(group);
			vi.useRealTimers();
		}
	});

	it("leaves a pane with no partner where it is", () => {
		const element = surface({ scrollTop: 40, clientHeight: 200 }).element;
		const dispose = registerScrollSyncElement("live-lone", element);
		element.scrollTop = 90;
		handleScrollSyncScroll("live-lone");
		handleScrollSyncScrollEnd("live-lone");
		expect(element.scrollTop).toBe(90);
		dispose();
	});

	it("suspends live follow while a zoom transition lands", () => {
		const group = registerScrollSyncPair("zoom-a", "zoom-a::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({
			scrollTop: 0,
			clientHeight: 200,
			scrollHeight: 4000,
		});
		const disposeSource = registerScrollSyncElement("zoom-a", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"zoom-a::translation",
			translation.element,
		);
		source.element.scrollTop = 40;
		handleScrollSyncScroll("zoom-a");
		followScrollSyncFrom("zoom-a");
		expect(translation.element.scrollTop).toBe(40);

		// While the panes sit at different scales the mapping is meaningless.
		beginZoomSync("zoom-a::translation");
		source.element.scrollTop = 80;
		handleScrollSyncScroll("zoom-a");
		followScrollSyncFrom("zoom-a");
		expect(translation.element.scrollTop).toBe(40);
		handleScrollSyncScrollEnd("zoom-a");
		expect(translation.element.scrollTop).toBe(40);

		// The target's own re-anchor scroll must not take the pair over.
		translation.element.scrollTop = 900;
		handleScrollSyncScroll("zoom-a::translation");
		expect(source.element.scrollTop).toBe(80);

		endZoomSync("zoom-a::translation");
		source.element.scrollTop = 120;
		handleScrollSyncScroll("zoom-a");
		followScrollSyncFrom("zoom-a");
		expect(translation.element.scrollTop).toBe(120);

		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("throttles only the pair whose leader is scrolling", () => {
		const liveGroup = registerScrollSyncPair(
			"throttle-a",
			"throttle-a::translation",
		);
		const otherGroup = registerScrollSyncPair(
			"throttle-b",
			"throttle-b::translation",
		);
		const liveSource = surface({ scrollTop: 0, clientHeight: 200 }).element;
		const liveTranslation = surface({
			scrollTop: 0,
			clientHeight: 200,
		}).element;
		const otherSource = surface({ scrollTop: 0, clientHeight: 200 }).element;
		const otherTranslation = surface({
			scrollTop: 0,
			clientHeight: 200,
		}).element;
		const disposeLiveSource = registerScrollSyncElement(
			"throttle-a",
			liveSource,
		);
		const disposeLiveTranslation = registerScrollSyncElement(
			"throttle-a::translation",
			liveTranslation,
		);
		const disposeOtherSource = registerScrollSyncElement(
			"throttle-b",
			otherSource,
		);
		const disposeOtherTranslation = registerScrollSyncElement(
			"throttle-b::translation",
			otherTranslation,
		);
		liveSource.scrollTop = 40;
		handleScrollSyncScroll("throttle-a");
		expect(isScrollSyncFollower("throttle-a::translation")).toBe(true);
		expect(isScrollSyncFollower("throttle-a")).toBe(false);
		expect(isScrollSyncFollower("throttle-b::translation")).toBe(false);
		expect(isScrollSyncFollower("throttle-b")).toBe(false);

		disposeLiveSource();
		disposeLiveTranslation();
		disposeOtherSource();
		disposeOtherTranslation();
		unregisterScrollSyncPair(liveGroup);
		unregisterScrollSyncPair(otherGroup);
	});
});
