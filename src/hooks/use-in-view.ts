import { type RefObject, useEffect, useState } from "react";

/** One callback per observed element; several hooks can share an element. */
type InViewListener = (inView: boolean) => void;

type ObserverPool = {
	observer: IntersectionObserver;
	listeners: Map<Element, Set<InViewListener>>;
};

/**
 * Shared observers, keyed by rootMargin.
 *
 * A per-hook observer does not scale here: a math-heavy note holds thousands of
 * equations, and with an enter *and* an evict band that was ~11k observers and
 * ~11k observed targets, re-evaluated by the browser on every scroll and layout
 * pass. That alone kept the main thread busy and fed the shake. Two observers
 * per margin for the whole app is free by comparison.
 */
const pools = new Map<string, ObserverPool>();

function poolFor(rootMargin: string): ObserverPool | null {
	if (typeof IntersectionObserver === "undefined") return null;
	const existing = pools.get(rootMargin);
	if (existing) return existing;
	const listeners = new Map<Element, Set<InViewListener>>();
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				const set = listeners.get(entry.target);
				if (!set) continue;
				for (const listener of [...set]) listener(entry.isIntersecting);
			}
		},
		{ rootMargin },
	);
	const pool = { observer, listeners };
	pools.set(rootMargin, pool);
	return pool;
}

function subscribe(
	rootMargin: string,
	element: Element,
	listener: InViewListener,
): () => void {
	const pool = poolFor(rootMargin);
	if (!pool) return () => {};
	let set = pool.listeners.get(element);
	if (!set) {
		set = new Set();
		pool.listeners.set(element, set);
		pool.observer.observe(element);
	}
	set.add(listener);
	return () => {
		const current = pool.listeners.get(element);
		if (!current) return;
		current.delete(listener);
		if (current.size === 0) {
			pool.listeners.delete(element);
			pool.observer.unobserve(element);
		}
	};
}

/** Test helper: drop every shared observer so counts are per-test. */
export function resetInViewPools(): void {
	for (const pool of pools.values()) pool.observer.disconnect();
	pools.clear();
}

/** Double every px length in a `rootMargin`, for the eviction band. */
function widenMargin(margin: string, factor = 2): string {
	return margin.replace(
		/(-?\d+(?:\.\d+)?)px/g,
		(_match, value: string) => `${Number(value) * factor}px`,
	);
}

/**
 * True once `ref`'s element is within `rootMargin` of the viewport (or
 * immediately when `enabled` is false / IntersectionObserver is unavailable).
 *
 * Used to defer expensive leaf work (image bytes, Mermaid, KaTeX) until the
 * block is about to be seen, so a long document does not pay for every heavy
 * node on first paint.
 *
 * `keepAlive` (default true) latches on the first hit: the work is done once.
 * Pass `false` for content whose *presence* itself is the cost — a rendered
 * KaTeX formula is hundreds of nodes, so a math-heavy note that has been
 * scrolled through would otherwise keep every formula in the DOM forever and
 * make each later style/layout pass (a pane resize, a theme switch) cost
 * hundreds of milliseconds.
 *
 * Eviction uses a second, wider band (`evictRootMargin`, default twice
 * `rootMargin`). A single threshold oscillates: rendering changes the element's
 * own box, which moves it back across the same threshold, which evicts it, which
 * moves it back — the document visibly shakes at the boundary. The dead band
 * between the two margins absorbs the size change.
 */
export function useInView(
	ref: RefObject<Element | null>,
	options?: {
		enabled?: boolean;
		rootMargin?: string;
		evictRootMargin?: string;
		keepAlive?: boolean;
	},
): boolean {
	const enabled = options?.enabled ?? true;
	const keepAlive = options?.keepAlive ?? true;
	const rootMargin = options?.rootMargin ?? "800px 0px";
	const evictRootMargin =
		options?.evictRootMargin ?? widenMargin(rootMargin, 2);
	const [inView, setInView] = useState(!enabled);

	useEffect(() => {
		if (!enabled) {
			setInView(true);
			return;
		}
		const element = ref.current;
		// A zero-area target (e.g. an empty placeholder) cannot be observed
		// reliably; treat it as visible so its content is never stuck unrendered.
		const rect = element?.getBoundingClientRect();
		if (!element || typeof IntersectionObserver === "undefined") {
			setInView(true);
			return;
		}
		if (rect && rect.width === 0 && rect.height === 0) {
			setInView(true);
			return;
		}
		if (keepAlive) {
			if (inView) return;
			return subscribe(rootMargin, element, (hit) => {
				if (hit) setInView(true);
			});
		}
		const unsubscribeEnter = subscribe(rootMargin, element, (hit) => {
			if (hit) setInView(true);
		});
		const unsubscribeExit = subscribe(evictRootMargin, element, (hit) => {
			if (!hit) setInView(false);
		});
		return () => {
			unsubscribeEnter();
			unsubscribeExit();
		};
	}, [enabled, inView, keepAlive, ref, rootMargin, evictRootMargin]);

	return inView;
}
