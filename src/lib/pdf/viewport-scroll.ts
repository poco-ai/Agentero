/**
 * Coalesce deferred viewport scroll requests. The viewport owner cancels a
 * request only after an explicit user-input precursor; native scroll events
 * themselves can also come from layout, zoom, or pane synchronization.
 *
 * EmbedPDF emits scroll requests synchronously, while the DOM viewport is
 * updated on the next frame. On Windows/WebView2 a user wheel event can land
 * in that gap; applying the old request afterwards makes the PDF jump to the
 * beginning or end of the document.
 */

export type PdfViewportScrollRequest = {
	x: number;
	y: number;
	behavior?: ScrollBehavior;
};

export type PdfViewportScrollScheduler = {
	schedule: (request: PdfViewportScrollRequest) => void;
	cancelPending: () => void;
	dispose: () => void;
};

export function createPdfViewportScrollScheduler({
	apply,
	requestFrame = (callback) => requestAnimationFrame(callback),
	cancelFrame = (handle) => cancelAnimationFrame(handle),
}: {
	apply: (request: PdfViewportScrollRequest) => void;
	requestFrame?: (callback: FrameRequestCallback) => number;
	cancelFrame?: (handle: number) => void;
}): PdfViewportScrollScheduler {
	let pending: PdfViewportScrollRequest | null = null;
	let frame: number | null = null;
	let disposed = false;

	const cancelPending = () => {
		pending = null;
		if (frame === null) return;
		cancelFrame(frame);
		frame = null;
	};

	return {
		schedule(request) {
			if (disposed) return;
			pending = request;
			if (frame !== null) return;
			frame = requestFrame(() => {
				frame = null;
				const next = pending;
				pending = null;
				if (!disposed && next) apply(next);
			});
		},
		cancelPending,
		dispose() {
			if (disposed) return;
			disposed = true;
			cancelPending();
		},
	};
}

export type PdfViewportMetricsScheduler = {
	/**
	 * Queue a metrics commit. The pane under the pointer commits on the next
	 * frame; a follower is held to one commit per interval, with a trailing
	 * commit so its last position still reaches the plugins.
	 */
	schedule: (follower: boolean) => void;
	dispose: () => void;
};

/**
 * Coalesce viewport scroll metrics commits for EmbedPDF's plugins.
 *
 * A scroll event per animation frame is cheap, but every metrics commit fans
 * out to plugin reducers, tile visibility recalculation and React scroll
 * subscribers. The pane under the pointer commits at frame rate; the paired
 * follower commits at `followerIntervalMs` so driving both panes visually
 * does not double that work (see scroll-sync.ts).
 */
export function createPdfViewportMetricsScheduler({
	apply,
	requestFrame = (callback) => requestAnimationFrame(callback),
	cancelFrame = (handle) => cancelAnimationFrame(handle),
	now = () => performance.now(),
	followerIntervalMs = 100,
}: {
	apply: () => void;
	requestFrame?: (callback: FrameRequestCallback) => number;
	cancelFrame?: (handle: number) => void;
	now?: () => number;
	followerIntervalMs?: number;
}): PdfViewportMetricsScheduler {
	let frame: number | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastApplied = Number.NEGATIVE_INFINITY;
	let disposed = false;

	const clearTimer = () => {
		if (timer === null) return;
		clearTimeout(timer);
		timer = null;
	};

	const clearFrame = () => {
		if (frame === null) return;
		cancelFrame(frame);
		frame = null;
	};

	const commit = () => {
		frame = null;
		lastApplied = now();
		apply();
	};

	const armFrame = () => {
		if (disposed || frame !== null) return;
		frame = requestFrame(commit);
	};

	return {
		schedule(follower) {
			if (disposed) return;
			if (!follower) {
				clearTimer();
				armFrame();
				return;
			}
			const remaining = followerIntervalMs - (now() - lastApplied);
			if (remaining <= 0) {
				clearTimer();
				armFrame();
				return;
			}
			if (frame !== null || timer !== null) return;
			timer = setTimeout(() => {
				timer = null;
				armFrame();
			}, remaining);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			clearTimer();
			clearFrame();
		},
	};
}
