/**
 * Cross-module "open the viva" request. Desktop opens a singleton native
 * window. Browser preview still latches until a mounted overlay consumes it.
 */

import {
	isVivaWindowRoute,
	openVivaWindow,
	shouldOpenVivaAsWindow,
} from "@/lib/voice-defense/viva-window";

let pending = false;
const listeners = new Set<() => void>();

export function requestOpenViva(): void {
	if (shouldOpenVivaAsWindow() && !isVivaWindowRoute()) {
		void openVivaWindow();
		return;
	}
	pending = true;
	for (const listener of [...listeners]) listener();
}

/** Returns true exactly once per request. */
export function consumeVivaOpenRequest(): boolean {
	const wasPending = pending;
	pending = false;
	return wasPending;
}

export function subscribeVivaOpenRequests(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
