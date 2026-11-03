/** Navigation is scoped to a viewer/tab; requests wait for layout, never timer-replay. */
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import type { PdfLayoutKind } from "@/lib/pdf/layout/types";

export type PdfNavigationRegion = {
	id: string;
	pageIndex: number;
	bbox: PdfAskNormalizedRect;
	kind?: PdfLayoutKind;
};
export type PdfNavigationTarget = {
	page: number;
	region?: PdfNavigationRegion;
};
export type PdfNavigationIntent = {
	readonly token: symbol;
	readonly key: string;
	target: PdfNavigationTarget | null;
};

const pending = new Map<string, PdfNavigationIntent>();
const owners = new Map<string, () => void>();
const normalizeKey = (key: string) =>
	key.replace(/\\/g, "/").replace(/\/+$/, "");

function clearIntent(intent: PdfNavigationIntent): void {
	if (pending.get(intent.key)?.token === intent.token)
		pending.delete(intent.key);
}

/** Reserve the latest request before asynchronous citation resolution starts. */
export function beginPdfNavigation(key: string): PdfNavigationIntent {
	const intent: PdfNavigationIntent = {
		token: Symbol(),
		key: normalizeKey(key),
		target: null,
	};
	pending.set(intent.key, intent);
	return intent;
}

export function completePdfNavigation(
	intent: PdfNavigationIntent,
	target: PdfNavigationTarget,
): void {
	if (pending.get(intent.key)?.token !== intent.token) return;
	intent.target = target;
	owners.get(intent.key)?.();
}

export function cancelPdfNavigation(intent: PdfNavigationIntent): void {
	clearIntent(intent);
	owners.get(intent.key)?.();
}

/** Closing a tab must also cancel requests made before its viewer mounted. */
export function cancelPdfNavigationForTab(key: string): void {
	const intent = pending.get(normalizeKey(key));
	if (intent) clearIntent(intent);
}

/** Layout-ready is the sole gate for both requested jumps and reading restore. */
export function registerPdfNavigationOwner(
	key: string,
	options: {
		navigate(target: PdfNavigationTarget): boolean;
		restore(totalPages: number): boolean;
	},
) {
	const normalized = normalizeKey(key);
	let totalPages = 0;
	let restored = false;
	let disposed = false;
	let localTarget: PdfNavigationTarget | null = null;
	const flush = () => {
		if (disposed || totalPages <= 0) return;
		// Local toolbar/outline/handle requests always belong to this instance.
		// External citations are routed by the canonical workspace tab id.
		const intent =
			owners.get(normalized) === flush ? pending.get(normalized) : undefined;
		if (!localTarget && intent && !intent.target) return;
		const target = localTarget ?? intent?.target;
		if (target) {
			if (
				Number.isInteger(target.page) &&
				target.page >= 1 &&
				target.page <= totalPages
			) {
				if (!options.navigate(target)) return;
				restored = true;
				localTarget = null;
				if (intent) clearIntent(intent);
				return;
			}
			localTarget = null;
			if (intent) clearIntent(intent);
		}
		if (!restored) restored = options.restore(totalPages);
	};
	owners.set(normalized, flush);
	return {
		layoutReady(pages: number) {
			totalPages = pages;
			flush();
		},
		request(target: PdfNavigationTarget) {
			if (disposed) return;
			if (owners.get(normalized) === flush) {
				const intent = pending.get(normalized);
				if (intent) clearIntent(intent);
			}
			localTarget = target;
			flush();
		},
		dispose() {
			disposed = true;
			if (owners.get(normalized) !== flush) return;
			owners.delete(normalized);
			const intent = pending.get(normalized);
			if (intent) {
				// StrictMode may immediately mount a replacement owner. A real
				// unmount cancels only this request, never a newer one.
				queueMicrotask(() => {
					if (!owners.has(normalized)) clearIntent(intent);
				});
			}
		},
	};
}
