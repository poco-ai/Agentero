type ClosestTarget = {
	closest: (selector: string) => Element | null;
};

export type LatestFrameDispatcher<T> = {
	enqueue: (value: T) => void;
	flush: () => void;
	cancel: () => void;
};

function supportsClosest(
	target: EventTarget | null,
): target is EventTarget & ClosestTarget {
	return (
		target !== null &&
		typeof (target as Partial<ClosestTarget>).closest === "function"
	);
}

/**
 * Match only a sash owned by the current Dockview workspace. Application
 * sidebars and unrelated resizers retain their native pointer streams.
 */
export function isDockviewSashTarget(
	target: EventTarget | null,
	workspace: Pick<Element, "contains">,
): boolean {
	if (!supportsClosest(target)) return false;
	const sash = target.closest(".dv-sash");
	return sash !== null && workspace.contains(sash);
}

export function createLatestFrameDispatcher<T>({
	dispatch,
	requestFrame = (callback) => requestAnimationFrame(callback),
	cancelFrame = (handle) => cancelAnimationFrame(handle),
}: {
	dispatch: (value: T) => void;
	requestFrame?: (callback: FrameRequestCallback) => number;
	cancelFrame?: (handle: number) => void;
}): LatestFrameDispatcher<T> {
	let pending: T;
	let hasPending = false;
	let frame: number | null = null;

	const deliver = () => {
		if (!hasPending) return;
		hasPending = false;
		dispatch(pending);
	};

	return {
		enqueue(value) {
			pending = value;
			hasPending = true;
			if (frame !== null) return;
			frame = requestFrame(() => {
				frame = null;
				deliver();
			});
		},
		flush() {
			if (frame !== null) {
				cancelFrame(frame);
				frame = null;
			}
			deliver();
		},
		cancel() {
			if (frame !== null) cancelFrame(frame);
			frame = null;
			hasPending = false;
		},
	};
}

type PointerMoveSnapshot = PointerEventInit & {
	pointerId: number;
};

function latestPointerSnapshot(event: PointerEvent): PointerMoveSnapshot {
	const coalesced = event.getCoalescedEvents?.();
	const latest = coalesced?.at(-1) ?? event;
	return {
		bubbles: true,
		cancelable: true,
		composed: true,
		pointerId: latest.pointerId,
		pointerType: latest.pointerType,
		isPrimary: latest.isPrimary,
		width: latest.width,
		height: latest.height,
		pressure: latest.pressure,
		tangentialPressure: latest.tangentialPressure,
		tiltX: latest.tiltX,
		tiltY: latest.tiltY,
		twist: latest.twist,
		button: latest.button,
		buttons: latest.buttons,
		clientX: latest.clientX,
		clientY: latest.clientY,
		screenX: latest.screenX,
		screenY: latest.screenY,
		ctrlKey: latest.ctrlKey,
		shiftKey: latest.shiftKey,
		altKey: latest.altKey,
		metaKey: latest.metaKey,
	};
}

/**
 * Dockview 7 performs recursive split layout synchronously for every native
 * pointermove. High-frequency pointer devices can deliver several moves inside
 * one display frame, so forward only the latest coordinate per frame. The
 * pending final coordinate is flushed before pointerup reaches Dockview.
 *
 * `hooks` lets the workspace react to the gesture without this module knowing
 * what lives inside the pane — currently the Markdown re-wrap freeze
 * (`markdown-resize-freeze.ts`).
 */
export function installDockviewSashFrameLoop(
	root: HTMLElement,
	hooks: { onSashDragBegin?: () => void; onSashDragEnd?: () => void } = {},
): () => void {
	const ownerDocument = root.ownerDocument;
	const ownerWindow = ownerDocument.defaultView;
	const PointerEventCtor = ownerWindow?.PointerEvent ?? PointerEvent;
	const syntheticEvents = new WeakSet<Event>();
	let activePointerId: number | null = null;
	let activeSash: Element | null = null;

	const dispatcher = createLatestFrameDispatcher<PointerMoveSnapshot>({
		dispatch(snapshot) {
			const event = new PointerEventCtor("pointermove", snapshot);
			syntheticEvents.add(event);
			ownerDocument.dispatchEvent(event);
		},
		requestFrame: (callback) =>
			ownerWindow
				? ownerWindow.requestAnimationFrame(callback)
				: requestAnimationFrame(callback),
		cancelFrame: (handle) => {
			if (ownerWindow) ownerWindow.cancelAnimationFrame(handle);
			else cancelAnimationFrame(handle);
		},
	});

	const finish = (flush: boolean) => {
		if (activePointerId === null) return;
		if (flush) dispatcher.flush();
		else dispatcher.cancel();
		activePointerId = null;
		activeSash?.classList.remove("agentero-dock-sash-dragging");
		activeSash = null;
		root.classList.remove("agentero-dock-sash-active");
		// After the flush above, so the document re-wraps at the geometry the
		// gesture actually ended on.
		hooks.onSashDragEnd?.();
	};

	const handlePointerDown = (event: PointerEvent) => {
		if (activePointerId !== null || !isDockviewSashTarget(event.target, root)) {
			return;
		}
		activePointerId = event.pointerId;
		// `preventDefault` below suppresses `:active` and dockview does not set
		// pointer capture, so paint the dragged sash from an explicit class.
		activeSash = supportsClosest(event.target)
			? event.target.closest(".dv-sash")
			: null;
		activeSash?.classList.add("agentero-dock-sash-dragging");
		root.classList.add("agentero-dock-sash-active");
		// Before Dockview re-lays out, so the pre-gesture width is what gets
		// measured and pinned.
		hooks.onSashDragBegin?.();
		event.preventDefault();
	};
	const handlePointerMove = (event: PointerEvent) => {
		if (
			activePointerId === null ||
			event.pointerId !== activePointerId ||
			syntheticEvents.has(event)
		) {
			return;
		}
		dispatcher.enqueue(latestPointerSnapshot(event));
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	const handlePointerUp = (event: PointerEvent) => {
		if (event.pointerId === activePointerId) finish(true);
	};
	const handlePointerCancel = (event: PointerEvent) => {
		if (event.pointerId === activePointerId) finish(false);
	};
	const handleContextMenu = () => finish(true);
	const handleBlur = () => {
		if (activePointerId === null) return;
		// Dockview itself has no blur listener. Route a cancel through the same
		// document event stream so it restores panel pointer-events and removes
		// its temporary drag listeners as well.
		ownerDocument.dispatchEvent(
			new PointerEventCtor("pointercancel", {
				bubbles: true,
				cancelable: true,
				composed: true,
				pointerId: activePointerId,
			}),
		);
	};

	root.addEventListener("pointerdown", handlePointerDown, true);
	ownerDocument.addEventListener("pointermove", handlePointerMove, true);
	ownerDocument.addEventListener("pointerup", handlePointerUp, true);
	ownerDocument.addEventListener("pointercancel", handlePointerCancel, true);
	ownerDocument.addEventListener("contextmenu", handleContextMenu, true);
	ownerWindow?.addEventListener("blur", handleBlur);

	return () => {
		handleBlur();
		root.removeEventListener("pointerdown", handlePointerDown, true);
		ownerDocument.removeEventListener("pointermove", handlePointerMove, true);
		ownerDocument.removeEventListener("pointerup", handlePointerUp, true);
		ownerDocument.removeEventListener(
			"pointercancel",
			handlePointerCancel,
			true,
		);
		ownerDocument.removeEventListener("contextmenu", handleContextMenu, true);
		ownerWindow?.removeEventListener("blur", handleBlur);
		finish(false);
	};
}
