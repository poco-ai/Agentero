import { afterEach, describe, expect, it, vi } from "vitest";
import {
	registerScrollSyncElement,
	registerScrollSyncPair,
	unregisterScrollSyncPair,
} from "@/lib/pdf/scroll-sync";
import {
	beginPeerZoomPreview,
	clearPeerZoomPreview,
	commitPeerZoomPreview,
	finishPeerZoomPreview,
	peerZoomPreviewToken,
	settlePeerZoomPreview,
	updatePeerZoomPreview,
} from "@/lib/pdf/zoom-preview";

type Box = { left: number; top: number; width: number; height: number };

function domRect(box: Box): DOMRect {
	return {
		...box,
		right: box.left + box.width,
		bottom: box.top + box.height,
		x: box.left,
		y: box.top,
		toJSON: () => box,
	} as DOMRect;
}

function parseTransform(transform: string): {
	x: number;
	y: number;
	scale: number;
} {
	const translate = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(transform);
	const scale = /scale\(([-\d.]+)\)/.exec(transform);
	return {
		x: translate ? Number(translate[1]) : 0,
		y: translate ? Number(translate[2]) : 0,
		scale: scale ? Number(scale[1]) : 1,
	};
}

/**
 * Two 600x800 viewports side by side. The page starts 100px into the partner
 * scroller; the gesture points at page fraction (0.75, 0.5).
 */
function createScene() {
	const style: Record<string, string> = {};
	let elementBox: Box = { left: 700, top: 0, width: 600, height: 800 };
	let pageBox: Box = { left: 700, top: 100, width: 400, height: 600 };
	/** Page point's client position under the current transform. */
	const pagePoint = () => {
		const { x, y, scale } = parseTransform(style.transform ?? "");
		const localX = pageBox.left - elementBox.left + pageBox.width * 0.75;
		const localY = pageBox.top - elementBox.top + pageBox.height * 0.5;
		return {
			x: elementBox.left + x + scale * localX,
			y: elementBox.top + y + scale * localY,
		};
	};
	const element = {
		style,
		get offsetWidth() {
			return elementBox.width;
		},
		clientWidth: 600,
		isConnected: true,
		scrollLeft: 0,
		scrollTop: 0,
		getBoundingClientRect() {
			const { x, y, scale } = parseTransform(style.transform ?? "");
			return domRect({
				left: elementBox.left + x,
				top: elementBox.top + y,
				width: elementBox.width * scale,
				height: elementBox.height * scale,
			});
		},
	};
	const page = {
		isConnected: true,
		getBoundingClientRect() {
			const { x, y, scale } = parseTransform(style.transform ?? "");
			return domRect({
				left: elementBox.left + x + scale * (pageBox.left - elementBox.left),
				top: elementBox.top + y + scale * (pageBox.top - elementBox.top),
				width: pageBox.width * scale,
				height: pageBox.height * scale,
			});
		},
	};
	const partnerViewport = {
		firstElementChild: element,
		querySelector: () => page,
		getBoundingClientRect: () =>
			domRect({ left: 700, top: 0, width: 600, height: 800 }),
		clientWidth: 600,
		scrollLeft: 0,
		scrollTop: 0,
	};
	const sourceViewport = {
		getBoundingClientRect: () =>
			domRect({ left: 0, top: 0, width: 600, height: 800 }),
		clientWidth: 600,
		scrollLeft: 0,
		scrollTop: 0,
	};
	return {
		element,
		page,
		pagePoint,
		partnerViewport,
		sourceViewport,
		/** Simulate the real page DOM relayouting at a new zoom. */
		setLayout(next: { element?: Box; page?: Box }) {
			if (next.element) elementBox = next.element;
			if (next.page) pageBox = next.page;
		},
	};
}

function setup() {
	vi.stubGlobal("getComputedStyle", () => ({
		paddingLeft: "0px",
		paddingRight: "0px",
	}));
	const group = registerScrollSyncPair("preview-a", "preview-a::t");
	const scene = createScene();
	const disposeSource = registerScrollSyncElement(
		"preview-a",
		scene.sourceViewport as unknown as HTMLElement,
	);
	const disposePartner = registerScrollSyncElement(
		"preview-a::t",
		scene.partnerViewport as unknown as HTMLElement,
	);
	return {
		scene,
		dispose() {
			disposeSource();
			disposePartner();
			unregisterScrollSyncPair(group);
			vi.unstubAllGlobals();
		},
	};
}

describe("peer zoom preview", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("hands the previewed page point back to the real scroll", () => {
		const { scene, dispose } = setup();
		try {
			beginPeerZoomPreview("preview-a", { pageIndex: 0, x: 0.75, y: 0.5 });
			expect(peerZoomPreviewToken()).toBeGreaterThan(0);
			updatePeerZoomPreview("preview-a", 2, { x: 300, y: 400 });
			expect(scene.element.style.transform).toBe(
				"translate(-300px, -400px) scale(2)",
			);
			// Under the preview the anchored page point sits on the pointer.
			expect(scene.pagePoint()).toEqual({ x: 1000, y: 400 });

			commitPeerZoomPreview("preview-a::t");

			// The real page DOM grows toward the committed size while the
			// transform compensation keeps the same page point on screen.
			scene.setLayout({
				element: { left: 700, top: 0, width: 900, height: 1200 },
				page: { left: 700, top: 150, width: 600, height: 900 },
			});
			expect(settlePeerZoomPreview()).toBe(false);
			expect(scene.pagePoint()).toEqual({ x: 1000, y: 400 });

			scene.setLayout({
				element: { left: 700, top: 0, width: 1200, height: 1600 },
				page: { left: 700, top: 200, width: 800, height: 1200 },
			});
			expect(settlePeerZoomPreview()).toBe(true);

			// Dropping the transform scrolls the real layout by the exact same
			// delta, so the swap is a no-op for the eye.
			expect(finishPeerZoomPreview()).toBe(true);
			expect(scene.element.style.transform).toBe("");
			expect(scene.partnerViewport.scrollLeft).toBe(300);
			expect(scene.partnerViewport.scrollTop).toBe(400);
			expect(peerZoomPreviewToken()).toBe(0);
		} finally {
			dispose();
		}
	});

	it("does not mirror a gesture that started between pages", () => {
		const { scene, dispose } = setup();
		try {
			beginPeerZoomPreview("preview-a", null);
			updatePeerZoomPreview("preview-a", 2, { x: 300, y: 400 });
			expect(scene.element.style.transform ?? "").toBe("");
			expect(peerZoomPreviewToken()).toBe(0);
		} finally {
			dispose();
		}
	});

	it("only clears the preview its own commit started", () => {
		const { dispose } = setup();
		try {
			beginPeerZoomPreview("preview-a", { pageIndex: 0, x: 0.75, y: 0.5 });
			const token = peerZoomPreviewToken();
			beginPeerZoomPreview("preview-a", { pageIndex: 0, x: 0.75, y: 0.5 });
			const newer = peerZoomPreviewToken();
			expect(newer).toBeGreaterThan(token);

			clearPeerZoomPreview("preview-a::t", token);
			expect(peerZoomPreviewToken()).toBe(newer);

			clearPeerZoomPreview("preview-a::t", newer);
			expect(peerZoomPreviewToken()).toBe(0);
		} finally {
			dispose();
		}
	});
});
