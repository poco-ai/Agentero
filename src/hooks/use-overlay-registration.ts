import { useEffect, useRef } from "react";

import { overlayStore, pushOverlay } from "@/stores/overlay-store";

/**
 * While `open` is true, register this overlay on the app stack so
 * Esc / ⌘W can dismiss it via {@link closeTopOverlay}.
 */
export function useOverlayRegistration(
	id: string,
	open: boolean,
	close: () => void,
): void {
	const closeRef = useRef(close);
	closeRef.current = close;

	useEffect(() => {
		if (!open) return;
		return pushOverlay({
			id,
			close: () => {
				closeRef.current();
			},
		});
	}, [id, open]);
}

/** True when any registered app overlay (settings, dialogs, palette…) is open. */
export function useAnyOverlayOpen(): boolean {
	return overlayStore.use((s) => s.stack.length > 0);
}

/** Debug / tests: current stack ids top-last. */
export function useOverlayStackIds(): string[] {
	return overlayStore.useShallow((s) => s.stack.map((h) => h.id));
}
