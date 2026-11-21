import { describe, expect, it, vi } from "vitest";
import { bindPanDragGesture, type PanDragTarget } from "@/lib/pdf/pan-drag";

class FakePointerEvent extends Event {
	readonly pointerId: number;
	readonly pointerType: string;
	readonly button: number;
	readonly clientX: number;
	readonly clientY: number;
	/** Shadows `Event#target`: the harness calls listeners directly, never dispatching. */
	override readonly target: EventTarget | null;
	stopPropagationCalls = 0;

	constructor(
		type: string,
		init: PointerEventInit = {},
		target: EventTarget | null = null,
	) {
		super(type, init);
		this.pointerId = init.pointerId ?? 0;
		this.pointerType = init.pointerType ?? "mouse";
		this.button = init.button ?? 0;
		this.clientX = init.clientX ?? 0;
		this.clientY = init.clientY ?? 0;
		this.target = target;
	}

	override stopPropagation(): void {
		this.stopPropagationCalls += 1;
		super.stopPropagation();
	}
}

type RegisteredListener = {
	listener: (event: FakePointerEvent) => void;
	capture: boolean;
};

/** Fake scroll container: listener registry plus mutable scroll offsets. */
function panTargetHarness() {
	const listeners = new Map<string, RegisteredListener[]>();
	const captured = new Set<number>();
	const target = {
		scrollLeft: 100,
		scrollTop: 200,
		addEventListener: (
			type: string,
			listener: (event: FakePointerEvent) => void,
			options?: boolean | AddEventListenerOptions,
		) => {
			const capture =
				options === true ||
				(typeof options === "object" && options?.capture === true);
			listeners.set(type, [
				...(listeners.get(type) ?? []),
				{ listener, capture },
			]);
		},
		removeEventListener: (
			type: string,
			listener: (event: FakePointerEvent) => void,
		) => {
			const entries = listeners.get(type);
			if (!entries) return;
			const next = entries.filter((entry) => entry.listener !== listener);
			if (next.length > 0) listeners.set(type, next);
			else listeners.delete(type);
		},
		setPointerCapture: (pointerId: number) => {
			captured.add(pointerId);
		},
		releasePointerCapture: (pointerId: number) => {
			captured.delete(pointerId);
		},
		hasPointerCapture: (pointerId: number) => captured.has(pointerId),
	};

	return {
		target: target as unknown as PanDragTarget,
		dispatch(
			type: string,
			init: PointerEventInit = {},
			target: EventTarget | null = null,
		) {
			const event = new FakePointerEvent(
				type,
				{
					cancelable: true,
					...init,
				},
				target,
			);
			for (const { listener } of listeners.get(type) ?? []) listener(event);
			return event;
		},
		scroll: () => ({ left: target.scrollLeft, top: target.scrollTop }),
		isCaptured: (pointerId: number) => captured.has(pointerId),
		isDownCaptured: () =>
			(listeners.get("pointerdown") ?? []).every((entry) => entry.capture),
		listenerCount: () =>
			[...listeners.values()].reduce(
				(total, entries) => total + entries.length,
				0,
			),
	};
}

function bind(harness: ReturnType<typeof panTargetHarness>, armed = false) {
	const states: string[] = [];
	const binding = bindPanDragGesture({
		target: harness.target,
		isLeftDragArmed: () => armed,
		isExcludedTarget: () => false,
		onStateChange: (state) => states.push(state),
	});
	return { binding, states };
}

describe("PDF drag-to-pan gesture", () => {
	it("pans both axes with the middle button, content following the cursor", () => {
		const harness = panTargetHarness();
		const { states } = bind(harness);

		const down = harness.dispatch("pointerdown", {
			button: 1,
			pointerId: 3,
			clientX: 50,
			clientY: 60,
		});
		expect(down.defaultPrevented).toBe(true);
		// Capture-phase stopPropagation is what keeps EmbedPDF selection out.
		expect(down.stopPropagationCalls).toBe(1);
		expect(harness.isDownCaptured()).toBe(true);
		expect(harness.isCaptured(3)).toBe(true);
		expect(states).toEqual(["panning"]);

		harness.dispatch("pointermove", {
			pointerId: 3,
			clientX: 20,
			clientY: 90,
		});
		expect(harness.scroll()).toEqual({ left: 130, top: 170 });

		harness.dispatch("pointerup", { pointerId: 3 });
		expect(states).toEqual(["panning", "idle"]);
		expect(harness.isCaptured(3)).toBe(false);

		harness.dispatch("pointermove", {
			pointerId: 3,
			clientX: 0,
			clientY: 0,
		});
		expect(harness.scroll()).toEqual({ left: 130, top: 170 });
	});

	it("leaves an unarmed left drag to text selection", () => {
		const harness = panTargetHarness();
		const { states } = bind(harness);

		const down = harness.dispatch("pointerdown", {
			button: 0,
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		expect(down.defaultPrevented).toBe(false);
		expect(states).toEqual([]);

		harness.dispatch("pointermove", {
			pointerId: 1,
			clientX: 60,
			clientY: 60,
		});
		expect(harness.scroll()).toEqual({ left: 100, top: 200 });
	});

	it("pans with the left button once Space arms the hand tool", () => {
		const harness = panTargetHarness();
		const { states } = bind(harness, true);

		harness.dispatch("pointerdown", {
			button: 0,
			pointerId: 2,
			clientX: 40,
			clientY: 40,
		});
		harness.dispatch("pointermove", {
			pointerId: 2,
			clientX: 90,
			clientY: 15,
		});
		expect(harness.scroll()).toEqual({ left: 50, top: 225 });
		expect(states).toEqual(["panning"]);
	});

	it("ignores excluded targets, but pans an armed left drag from anywhere else", () => {
		const harness = panTargetHarness();
		const states: string[] = [];
		const editor = new EventTarget();
		const isExcludedTarget = vi.fn(
			(target: EventTarget | null) => target === editor,
		);
		bindPanDragGesture({
			target: harness.target,
			isLeftDragArmed: () => true,
			isExcludedTarget,
			onStateChange: (state) => states.push(state),
		});

		const editable = harness.dispatch(
			"pointerdown",
			{ button: 0, pointerId: 1 },
			editor,
		);
		expect(editable.defaultPrevented).toBe(false);
		expect(isExcludedTarget).toHaveBeenCalledWith(editor);
		expect(states).toEqual([]);

		// Armed, the left button is a hand tool like the middle one: an interactive
		// element under the pointer does not get to opt out of the pan.
		const armed = harness.dispatch(
			"pointerdown",
			{ button: 0, pointerId: 2, clientX: 40, clientY: 40 },
			new EventTarget(),
		);
		expect(armed.defaultPrevented).toBe(true);
		harness.dispatch("pointermove", {
			pointerId: 2,
			clientX: 90,
			clientY: 15,
		});
		expect(harness.scroll()).toEqual({ left: 50, top: 225 });
		expect(states).toEqual(["panning"]);
	});

	it("pans with the right button, except on chrome that keeps its context menu", () => {
		const harness = panTargetHarness();
		const states: string[] = [];
		const chrome = new EventTarget();
		bindPanDragGesture({
			target: harness.target,
			isLeftDragArmed: () => false,
			isExcludedTarget: () => false,
			isRightDragExcludedTarget: (target) => target === chrome,
			onStateChange: (state) => states.push(state),
		});

		const down = harness.dispatch("pointerdown", {
			button: 2,
			pointerId: 2,
			clientX: 40,
			clientY: 50,
		});
		expect(down.defaultPrevented).toBe(true);
		harness.dispatch("pointermove", {
			pointerId: 2,
			clientX: 10,
			clientY: 20,
		});
		expect(harness.scroll()).toEqual({ left: 130, top: 230 });
		// This right press owns the page's context menu (WebKit fires it while the
		// button is still down), so no native menu interrupts the pan.
		const menu = harness.dispatch("contextmenu", { button: 2 });
		expect(menu.defaultPrevented).toBe(true);
		harness.dispatch("pointerup", { pointerId: 2 });
		expect(states).toEqual(["panning", "idle"]);

		// WebView2 dispatches the menu only after the release; that press still
		// owns it, so the next contextmenu is suppressed as well.
		harness.dispatch("pointerdown", {
			button: 2,
			pointerId: 5,
			clientX: 40,
			clientY: 100,
		});
		harness.dispatch("pointerup", { pointerId: 5 });
		const lateMenu = harness.dispatch("contextmenu", { button: 2 });
		expect(lateMenu.defaultPrevented).toBe(true);
		expect(states).toEqual(["panning", "idle", "panning", "idle"]);

		// Chrome opts out of the right drag and keeps its own right click, e.g.
		// right-clicking a highlight swatch to flip its shape.
		const chromeDown = harness.dispatch(
			"pointerdown",
			{ button: 2, pointerId: 3 },
			chrome,
		);
		expect(chromeDown.defaultPrevented).toBe(false);
		harness.dispatch("pointermove", { pointerId: 3, clientX: 0, clientY: 0 });
		expect(harness.scroll()).toEqual({ left: 130, top: 230 });
		const chromeMenu = harness.dispatch("contextmenu", { button: 2 }, chrome);
		expect(chromeMenu.defaultPrevented).toBe(false);

		const touch = harness.dispatch("pointerdown", {
			button: 1,
			pointerId: 4,
			pointerType: "touch",
		});
		expect(touch.defaultPrevented).toBe(false);
		expect(states).toEqual(["panning", "idle", "panning", "idle"]);
	});

	it("ignores a second pointer while a drag is in flight", () => {
		const harness = panTargetHarness();
		const { states } = bind(harness);

		harness.dispatch("pointerdown", {
			button: 1,
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		harness.dispatch("pointerdown", {
			button: 1,
			pointerId: 2,
			clientX: 500,
			clientY: 500,
		});
		expect(states).toEqual(["panning"]);

		harness.dispatch("pointermove", {
			pointerId: 2,
			clientX: 600,
			clientY: 600,
		});
		expect(harness.scroll()).toEqual({ left: 100, top: 200 });
	});

	it("suppresses the compatibility mousedown behind the middle and right buttons", () => {
		const harness = panTargetHarness();
		bind(harness);

		harness.dispatch("pointerdown", { button: 1, pointerId: 2 });
		const middle = harness.dispatch("mousedown", { button: 1 });
		expect(middle.defaultPrevented).toBe(true);
		expect(middle.stopPropagationCalls).toBe(1);
		harness.dispatch("pointerup", { pointerId: 2 });

		harness.dispatch("pointerdown", { button: 2, pointerId: 3 });
		const right = harness.dispatch("mousedown", { button: 2 });
		expect(right.defaultPrevented).toBe(true);
		expect(right.stopPropagationCalls).toBe(1);
		harness.dispatch("pointerup", { pointerId: 3 });

		const left = harness.dispatch("mousedown", { button: 0 });
		expect(left.defaultPrevented).toBe(false);
	});

	it("ends the drag on pointercancel but pans through a dropped capture", () => {
		const harness = panTargetHarness();
		const { binding, states } = bind(harness);

		harness.dispatch("pointerdown", {
			button: 1,
			pointerId: 4,
			clientX: 10,
			clientY: 10,
		});
		harness.dispatch("pointercancel", { pointerId: 4 });
		expect(states).toEqual(["panning", "idle"]);
		expect(harness.isCaptured(4)).toBe(false);

		harness.dispatch("pointerdown", {
			button: 1,
			pointerId: 5,
			clientX: 10,
			clientY: 10,
		});
		// WebKit releases capture right after a default-prevented pointerdown; the
		// gesture must not treat that as the end of the drag.
		harness.dispatch("lostpointercapture", { pointerId: 5 });
		expect(states).toEqual(["panning", "idle", "panning"]);

		harness.dispatch("pointermove", {
			pointerId: 5,
			clientX: 40,
			clientY: 50,
		});
		expect(harness.scroll()).toEqual({ left: 70, top: 160 });

		binding.cancel();
		expect(states).toEqual(["panning", "idle", "panning", "idle"]);
	});

	it("still pans when setPointerCapture throws", () => {
		const harness = panTargetHarness();
		const states: string[] = [];
		// Override on the harness's own target so the scroll writes stay observable.
		const target = harness.target as {
			setPointerCapture: (pointerId: number) => void;
		};
		target.setPointerCapture = () => {
			throw new Error("NotFoundError");
		};
		bindPanDragGesture({
			target: harness.target,
			isLeftDragArmed: () => true,
			isExcludedTarget: () => false,
			onStateChange: (state) => states.push(state),
		});

		harness.dispatch("pointerdown", {
			button: 0,
			pointerId: 9,
			clientX: 20,
			clientY: 20,
		});
		harness.dispatch("pointermove", {
			pointerId: 9,
			clientX: 60,
			clientY: 5,
		});
		expect(states).toEqual(["panning"]);
		expect(harness.scroll()).toEqual({ left: 60, top: 215 });
	});

	it("cancel ends an in-flight drag but keeps the binding alive", () => {
		const harness = panTargetHarness();
		const { binding, states } = bind(harness);

		harness.dispatch("pointerdown", {
			button: 1,
			pointerId: 6,
			clientX: 30,
			clientY: 30,
		});
		binding.cancel();
		expect(states).toEqual(["panning", "idle"]);
		expect(harness.listenerCount()).toBe(6);

		harness.dispatch("pointermove", {
			pointerId: 6,
			clientX: 90,
			clientY: 90,
		});
		expect(harness.scroll()).toEqual({ left: 100, top: 200 });

		harness.dispatch("pointerdown", {
			button: 1,
			pointerId: 7,
			clientX: 30,
			clientY: 30,
		});
		harness.dispatch("pointermove", {
			pointerId: 7,
			clientX: 10,
			clientY: 50,
		});
		expect(harness.scroll()).toEqual({ left: 120, top: 180 });
	});

	it("dispose releases an in-flight drag and removes every listener", () => {
		const harness = panTargetHarness();
		const { binding, states } = bind(harness);

		harness.dispatch("pointerdown", {
			button: 1,
			pointerId: 8,
			clientX: 10,
			clientY: 10,
		});
		expect(harness.listenerCount()).toBe(6);

		binding.dispose();
		expect(states).toEqual(["panning", "idle"]);
		expect(harness.listenerCount()).toBe(0);
		expect(harness.isCaptured(8)).toBe(false);

		binding.dispose();
		expect(states).toEqual(["panning", "idle"]);
	});
});
