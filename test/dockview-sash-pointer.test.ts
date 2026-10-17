import { describe, expect, it, vi } from "vitest";
import {
	createLatestFrameDispatcher,
	installDockviewSashFrameLoop,
	isDockviewSashTarget,
} from "@/lib/workspace/dockview-sash";

function frameHarness() {
	let callback: FrameRequestCallback | null = null;
	return {
		requestFrame: vi.fn((next: FrameRequestCallback) => {
			callback = next;
			return 9;
		}),
		cancelFrame: vi.fn(() => {
			callback = null;
		}),
		flushFrame: () => {
			const next = callback;
			callback = null;
			next?.(0);
		},
	};
}

class FakePointerEvent extends Event {
	readonly pointerId: number;
	readonly pointerType: string;
	readonly isPrimary: boolean;
	readonly clientX: number;
	readonly clientY: number;
	readonly screenX: number;
	readonly screenY: number;
	readonly width: number;
	readonly height: number;
	readonly pressure: number;
	readonly tangentialPressure: number;
	readonly tiltX: number;
	readonly tiltY: number;
	readonly twist: number;
	readonly button: number;
	readonly buttons: number;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;

	constructor(type: string, init: PointerEventInit = {}) {
		super(type, init);
		this.pointerId = init.pointerId ?? 0;
		this.pointerType = init.pointerType ?? "";
		this.isPrimary = init.isPrimary ?? false;
		this.clientX = init.clientX ?? 0;
		this.clientY = init.clientY ?? 0;
		this.screenX = init.screenX ?? 0;
		this.screenY = init.screenY ?? 0;
		this.width = init.width ?? 1;
		this.height = init.height ?? 1;
		this.pressure = init.pressure ?? 0;
		this.tangentialPressure = init.tangentialPressure ?? 0;
		this.tiltX = init.tiltX ?? 0;
		this.tiltY = init.tiltY ?? 0;
		this.twist = init.twist ?? 0;
		this.button = init.button ?? 0;
		this.buttons = init.buttons ?? 0;
		this.ctrlKey = init.ctrlKey ?? false;
		this.shiftKey = init.shiftKey ?? false;
		this.altKey = init.altKey ?? false;
		this.metaKey = init.metaKey ?? false;
	}
}

describe("Dockview sash pointer scheduling", () => {
	it("recognizes only sashes inside the owning workspace", () => {
		const ownedSash = {} as Element;
		const foreignSash = {} as Element;
		const workspace = {
			contains: vi.fn((element: Element) => element === ownedSash),
		};

		const ownedTarget = {
			closest: vi.fn(() => ownedSash),
		} as unknown as EventTarget;
		const foreignTarget = {
			closest: vi.fn(() => foreignSash),
		} as unknown as EventTarget;

		expect(isDockviewSashTarget(ownedTarget, workspace)).toBe(true);
		expect(isDockviewSashTarget(foreignTarget, workspace)).toBe(false);
		expect(isDockviewSashTarget(null, workspace)).toBe(false);
	});

	it("delivers only the latest pointer position in each frame", () => {
		const frames = frameHarness();
		const dispatch = vi.fn();
		const scheduler = createLatestFrameDispatcher<number>({
			dispatch,
			requestFrame: frames.requestFrame,
			cancelFrame: frames.cancelFrame,
		});

		scheduler.enqueue(10);
		scheduler.enqueue(20);
		scheduler.enqueue(30);
		expect(frames.requestFrame).toHaveBeenCalledTimes(1);

		frames.flushFrame();
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch).toHaveBeenLastCalledWith(30);
	});

	it("flushes the final coordinate before pointerup and can cancel stale work", () => {
		const frames = frameHarness();
		const dispatch = vi.fn();
		const scheduler = createLatestFrameDispatcher<number>({
			dispatch,
			requestFrame: frames.requestFrame,
			cancelFrame: frames.cancelFrame,
		});

		scheduler.enqueue(40);
		scheduler.enqueue(50);
		scheduler.flush();
		expect(frames.cancelFrame).toHaveBeenCalledWith(9);
		expect(dispatch).toHaveBeenLastCalledWith(50);

		scheduler.enqueue(60);
		scheduler.cancel();
		frames.flushFrame();
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("blocks native move bursts and flushes the latest move through Dockview", () => {
		const frames = frameHarness();
		const ownerDocument = new EventTarget() as EventTarget & {
			defaultView: EventTarget & {
				PointerEvent: typeof FakePointerEvent;
				requestAnimationFrame: typeof frames.requestFrame;
				cancelAnimationFrame: typeof frames.cancelFrame;
			};
		};
		const ownerWindow = Object.assign(new EventTarget(), {
			PointerEvent: FakePointerEvent,
			requestAnimationFrame: frames.requestFrame,
			cancelAnimationFrame: frames.cancelFrame,
		});
		ownerDocument.defaultView = ownerWindow;

		const sashClasses = new Set<string>();
		const sash = {
			classList: {
				add: (name: string) => sashClasses.add(name),
				remove: (name: string) => sashClasses.delete(name),
			},
		} as unknown as Element;
		const classes = new Set<string>();
		const root = Object.assign(new EventTarget(), {
			ownerDocument,
			classList: {
				add: (name: string) => classes.add(name),
				remove: (name: string) => classes.delete(name),
			},
			closest: (selector: string) => (selector === ".dv-sash" ? sash : null),
			contains: (element: Element) => element === sash,
		}) as unknown as HTMLElement;

		const dispose = installDockviewSashFrameLoop(root);
		const dockviewMoves: number[] = [];
		let dockviewEnds = 0;
		const onDockviewMove = (event: Event) => {
			dockviewMoves.push((event as FakePointerEvent).clientX);
		};
		const stopDockviewDrag = () => {
			dockviewEnds += 1;
			ownerDocument.removeEventListener("pointermove", onDockviewMove);
			ownerDocument.removeEventListener("pointerup", stopDockviewDrag);
			ownerDocument.removeEventListener("pointercancel", stopDockviewDrag);
		};
		root.addEventListener("pointerdown", () => {
			ownerDocument.addEventListener("pointermove", onDockviewMove);
			ownerDocument.addEventListener("pointerup", stopDockviewDrag);
			ownerDocument.addEventListener("pointercancel", stopDockviewDrag);
		});

		const pointerDown = new FakePointerEvent("pointerdown", {
			cancelable: true,
			pointerId: 4,
			clientX: 10,
		});
		root.dispatchEvent(pointerDown);
		expect(classes.has("agentero-dock-sash-active")).toBe(true);
		expect(sashClasses.has("agentero-dock-sash-dragging")).toBe(true);
		expect(pointerDown.defaultPrevented).toBe(true);

		for (const clientX of [20, 30, 40]) {
			const pointerMove = new FakePointerEvent("pointermove", {
				cancelable: true,
				pointerId: 4,
				clientX,
			});
			ownerDocument.dispatchEvent(pointerMove);
			expect(pointerMove.defaultPrevented).toBe(true);
		}
		expect(dockviewMoves).toEqual([]);

		frames.flushFrame();
		expect(dockviewMoves).toEqual([40]);

		ownerDocument.dispatchEvent(
			new FakePointerEvent("pointermove", { pointerId: 4, clientX: 50 }),
		);
		ownerDocument.dispatchEvent(
			new FakePointerEvent("pointerup", { pointerId: 4, clientX: 50 }),
		);
		expect(dockviewMoves).toEqual([40, 50]);
		expect(classes.has("agentero-dock-sash-active")).toBe(false);
		expect(sashClasses.has("agentero-dock-sash-dragging")).toBe(false);
		expect(dockviewEnds).toBe(1);

		root.dispatchEvent(
			new FakePointerEvent("pointerdown", { pointerId: 5, clientX: 60 }),
		);
		ownerDocument.dispatchEvent(
			new FakePointerEvent("pointermove", { pointerId: 5, clientX: 70 }),
		);
		ownerWindow.dispatchEvent(new Event("blur"));
		expect(classes.has("agentero-dock-sash-active")).toBe(false);
		expect(sashClasses.has("agentero-dock-sash-dragging")).toBe(false);
		expect(dockviewEnds).toBe(2);

		dispose();
	});

	it("announces the gesture so the pane can freeze its re-wrap", () => {
		const frames = frameHarness();
		const ownerWindow = Object.assign(new EventTarget(), {
			PointerEvent: FakePointerEvent,
			requestAnimationFrame: frames.requestFrame,
			cancelAnimationFrame: frames.cancelFrame,
		});
		const ownerDocument = new EventTarget() as EventTarget & {
			defaultView: typeof ownerWindow;
		};
		ownerDocument.defaultView = ownerWindow;

		const sash = {
			classList: { add: () => {}, remove: () => {} },
		} as unknown as Element;
		const classes = new Set<string>();
		let sashTarget = true;
		const root = Object.assign(new EventTarget(), {
			ownerDocument,
			classList: {
				add: (name: string) => classes.add(name),
				remove: (name: string) => classes.delete(name),
			},
			closest: (selector: string) =>
				sashTarget && selector === ".dv-sash" ? sash : null,
			contains: (element: Element) => element === sash,
		}) as unknown as HTMLElement;

		// The pinned width must be measured before Dockview lays anything out,
		// and released only after the final coordinate has been forwarded.
		const order: string[] = [];

		installDockviewSashFrameLoop(root, {
			onSashDragBegin: () => order.push("begin"),
			onSashDragEnd: () => order.push("end"),
		});
		// Registered after install: listeners on the same target run in
		// registration order, so this sees only what Dockview itself would see
		// (the loop stops immediate propagation on the native bursts).
		ownerDocument.addEventListener("pointermove", () => {
			order.push("dockview-move");
		});

		// A pointerdown outside any sash must not arm the freeze.
		sashTarget = false;
		root.dispatchEvent(new FakePointerEvent("pointerdown", { pointerId: 1 }));
		expect(order).toEqual([]);
		sashTarget = true;

		root.dispatchEvent(
			new FakePointerEvent("pointerdown", { cancelable: true, pointerId: 2 }),
		);
		expect(order).toEqual(["begin"]);

		// A second pointerdown during the gesture must not re-arm it.
		root.dispatchEvent(new FakePointerEvent("pointerdown", { pointerId: 3 }));
		expect(order).toEqual(["begin"]);

		ownerDocument.dispatchEvent(
			new FakePointerEvent("pointermove", { pointerId: 2, clientX: 20 }),
		);
		frames.flushFrame();
		expect(order).toEqual(["begin", "dockview-move"]);

		ownerDocument.dispatchEvent(
			new FakePointerEvent("pointermove", { pointerId: 2, clientX: 30 }),
		);
		ownerDocument.dispatchEvent(
			new FakePointerEvent("pointerup", { pointerId: 2, clientX: 30 }),
		);
		// Flush of the pending move, then the release.
		expect(order).toEqual(["begin", "dockview-move", "dockview-move", "end"]);

		// Losing the window mid-drag must still release the freeze.
		root.dispatchEvent(new FakePointerEvent("pointerdown", { pointerId: 4 }));
		order.length = 0;
		ownerWindow.dispatchEvent(new Event("blur"));
		expect(order).toEqual(["end"]);
	});
});
