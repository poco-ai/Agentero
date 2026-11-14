import { describe, expect, it, vi } from "vitest";
import {
	alignScrollSyncFrom,
	cancelPendingViewportScroll,
	getScrollSyncElement,
	getScrollSyncPartner,
	getScrollSyncPeer,
	getScrollSyncRole,
	handleScrollSyncScroll,
	handleScrollSyncScrollEnd,
	holdScrollSync,
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
	it("keeps both viewport centers on the same content point across differently sized panes", () => {
		// Same document in two panes with different viewport heights. The
		// source center sits on content y = 700; the target must aim its
		// center there too (700 - 150). The old ratio mapping landed the
		// target center on y = 675 instead.
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

describe("dual-pane settle jump", () => {
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

	it("jumps to the final position once, not to the intermediate ticks", () => {
		const group = registerScrollSyncPair("settle-a", "settle-a::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({ scrollTop: 0, clientHeight: 200 });
		const disposeSource = registerScrollSyncElement("settle-a", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"settle-a::translation",
			translation.element,
		);
		source.element.scrollTop = 40;
		handleScrollSyncScroll("settle-a");
		source.element.scrollTop = 80;
		handleScrollSyncScroll("settle-a");
		expect(translation.element.scrollTop).toBe(0);
		expect(source.element.scrollTop).toBe(80);

		handleScrollSyncScrollEnd("settle-a");
		expect(translation.element.scrollTop).toBe(80);
		expect(source.element.scrollTop).toBe(80);

		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("jumps a taller partner to the same content center", () => {
		const group = registerScrollSyncPair("settle-b", "settle-b::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({
			scrollTop: 0,
			clientHeight: 300,
			clientWidth: 500,
		});
		const disposeSource = registerScrollSyncElement("settle-b", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"settle-b::translation",
			translation.element,
		);
		source.element.scrollTop = 600;
		handleScrollSyncScroll("settle-b");
		expect(translation.element.scrollTop).toBe(0);
		handleScrollSyncScrollEnd("settle-b");
		// Source center is content y = 700. The taller pane aims there.
		expect(translation.element.scrollTop).toBe(550);
		expect(source.element.scrollTop).toBe(600);

		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("lets the other pane take over without jumping onto the finger", () => {
		const group = registerScrollSyncPair("settle-c", "settle-c::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({ scrollTop: 0, clientHeight: 200 });
		const disposeSource = registerScrollSyncElement("settle-c", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"settle-c::translation",
			translation.element,
		);
		source.element.scrollTop = 100;
		handleScrollSyncScroll("settle-c");
		translation.element.scrollTop = 240;
		handleScrollSyncScroll("settle-c::translation");
		expect(translation.element.scrollTop).toBe(240);
		expect(source.element.scrollTop).toBe(100);

		source.element.scrollTop = 160;
		handleScrollSyncScroll("settle-c");
		expect(translation.element.scrollTop).toBe(240);
		expect(source.element.scrollTop).toBe(160);

		handleScrollSyncScrollEnd("settle-c::translation");
		expect(source.element.scrollTop).toBe(240);
		expect(translation.element.scrollTop).toBe(240);

		disposeSource();
		disposeTranslation();
		unregisterScrollSyncPair(group);
	});

	it("jumps after a quiet gap when scrollend does not fire", () => {
		vi.useFakeTimers();
		const group = registerScrollSyncPair("settle-d", "settle-d::translation");
		const source = surface({ scrollTop: 0, clientHeight: 200 });
		const translation = surface({ scrollTop: 0, clientHeight: 200 });
		const disposeSource = registerScrollSyncElement("settle-d", source.element);
		const disposeTranslation = registerScrollSyncElement(
			"settle-d::translation",
			translation.element,
		);
		try {
			source.element.scrollTop = 40;
			handleScrollSyncScroll("settle-d");
			vi.advanceTimersByTime(100);
			expect(translation.element.scrollTop).toBe(0);
			source.element.scrollTop = 80;
			handleScrollSyncScroll("settle-d");
			vi.advanceTimersByTime(179);
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
		const dispose = registerScrollSyncElement("settle-lone", element);
		element.scrollTop = 90;
		handleScrollSyncScroll("settle-lone");
		handleScrollSyncScrollEnd("settle-lone");
		expect(element.scrollTop).toBe(90);
		dispose();
	});
});
