/**
 * One source of truth for "is a pane resize gesture in flight".
 *
 * Every gate in the workspace used to arm itself from the same narrow signal:
 * `isDockviewSashTarget(event.target, root)`. That covers dragging a Dockview
 * divider and nothing else — dragging a shell rail (react-resizable-panels) or
 * resizing the native window edge produced no `.dv-sash` pointerdown, so the
 * Markdown freeze and the EmbedPDF viewport gate both stayed off and every
 * frame kept doing the expensive work.
 *
 * Two signals are OR-ed here:
 *
 * - **explicit** — `begin()` / `end()`, ref-counted. `dockview-sash.ts` reports
 *   the gesture when a divider is grabbed, and it is the only source that can
 *   hand over the pre-drag width (a sash move does not resize the workspace
 *   root, so the observer below cannot see it).
 * - **auto** — a `ResizeObserver` on the workspace root. Rails and native
 *   window resizes both resize that element. A quiet window ends the gesture.
 */

export const RESIZE_GESTURE_QUIET_MS = 140;

export type ResizeGesture = {
	/** Report an explicitly detected gesture (ref-counted). */
	begin: () => void;
	end: () => void;
	isActive: () => boolean;
	/** Fires only on transitions. Returns an unsubscribe. */
	subscribe: (listener: (active: boolean) => void) => () => void;
	dispose: () => void;
};

type GestureRoot = {
	ownerDocument?: Document | null;
	nodeType?: number;
};

export function createResizeGesture(
	root: GestureRoot,
	options: { quietMs?: number } = {},
): ResizeGesture {
	const quietMs = options.quietMs ?? RESIZE_GESTURE_QUIET_MS;
	const view = root.ownerDocument?.defaultView ?? null;
	const ResizeObserverCtor = view?.ResizeObserver;

	let explicit = 0;
	let auto = false;
	let active = false;
	let quietTimer: ReturnType<typeof setTimeout> | null = null;
	const listeners = new Set<(active: boolean) => void>();

	const emit = () => {
		const next = explicit > 0 || auto;
		if (next === active) return;
		active = next;
		// Copy: a listener may unsubscribe (or subscribe) while reacting.
		for (const listener of [...listeners]) listener(active);
	};

	const clearQuiet = () => {
		if (quietTimer === null) return;
		clearTimeout(quietTimer);
		quietTimer = null;
	};

	// The first callback is the observation itself, not a gesture.
	let primed = false;
	const observer =
		ResizeObserverCtor && typeof root.nodeType === "number"
			? new ResizeObserverCtor(() => {
					if (!primed) {
						primed = true;
						return;
					}
					auto = true;
					emit();
					clearQuiet();
					quietTimer = setTimeout(() => {
						quietTimer = null;
						auto = false;
						emit();
					}, quietMs);
				})
			: null;
	if (observer) observer.observe(root as unknown as Element);

	return {
		begin() {
			explicit += 1;
			emit();
		},
		end() {
			if (explicit === 0) return;
			explicit -= 1;
			emit();
		},
		isActive: () => active,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		dispose() {
			observer?.disconnect();
			clearQuiet();
			listeners.clear();
			explicit = 0;
			auto = false;
			active = false;
		},
	};
}

/**
 * The gesture is scoped to a workspace element, not to React context: the
 * consumers (the Markdown freeze and the PDF viewport gate) are imperative and
 * the PDF one already resolves its workspace via `closest(".agentero-dockview")`.
 */
const registry = new WeakMap<Element, ResizeGesture>();

/**
 * Fan-out for consumers that cannot look the gesture up by element.
 *
 * A child's `useLayoutEffect` runs before its parent's `useEffect`, so a panel
 * that resolves the gesture at mount can run before the workspace has installed
 * it — and a one-shot lookup then never recovers (that regressed the PDF gate,
 * which had no other arming path). Subscribing here is order-independent: the
 * listener is attached to whatever gesture is current, and re-attached when a
 * workspace replaces it.
 */
const fanout = new Set<(active: boolean) => void>();
let currentGesture: ResizeGesture | null = null;
let currentUnsubscribe: (() => void) | null = null;

export function installResizeGesture(
	root: Element,
	options: { quietMs?: number } = {},
): ResizeGesture {
	const gesture = createResizeGesture(root, options);
	registry.set(root, gesture);

	currentUnsubscribe?.();
	currentUnsubscribe = gesture.subscribe((active) => {
		for (const listener of [...fanout]) listener(active);
	});
	currentGesture = gesture;

	return gesture;
}

export function resizeGestureFor(
	element: Element | null | undefined,
): ResizeGesture | null {
	if (!element) return null;
	return registry.get(element) ?? null;
}

/** Subscribe without needing the workspace element. Returns an unsubscribe. */
export function subscribeResizeGesture(
	listener: (active: boolean) => void,
): () => void {
	fanout.add(listener);
	return () => {
		fanout.delete(listener);
	};
}

/** Test/diagnostic helper: is a gesture currently installed? */
export function hasResizeGesture(): boolean {
	return currentGesture !== null;
}

export function resetResizeGestureFanout(): void {
	currentUnsubscribe?.();
	currentUnsubscribe = null;
	currentGesture = null;
	fanout.clear();
}
