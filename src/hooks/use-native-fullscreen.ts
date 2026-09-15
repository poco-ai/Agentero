import { useEffect, useState } from "react";
import { isMacOS, isTauri } from "@/lib/core/tauri";

/**
 * Whether the current window is in native (green-button) fullscreen.
 *
 * macOS hides the traffic lights there, so title-bar chrome that reserves a
 * strip for them must collapse instead of leaving a stranded gap. tao re-emits
 * a window resize on both `windowDidEnterFullscreen` and
 * `windowDidExitFullscreen`, so resync on `onResized` rather than polling.
 *
 * Always `false` outside macOS desktop (Windows/Linux keep native decorations).
 */
export function useNativeFullscreen(): boolean {
	const [fullscreen, setFullscreen] = useState(false);

	useEffect(() => {
		if (!(isTauri() && isMacOS())) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;

		void (async () => {
			try {
				const { getCurrentWindow } = await import("@tauri-apps/api/window");
				const win = getCurrentWindow();
				const sync = async () => {
					try {
						const next = await win.isFullscreen();
						if (!disposed) setFullscreen(next);
					} catch {
						// Window torn down mid-transition: keep the last known state.
					}
				};
				await sync();
				if (disposed) return;
				unlisten = await win.onResized(() => void sync());
				// `onResized` resolves after a Host round-trip; a StrictMode
				// unmount before that would otherwise leak the listener.
				if (disposed) unlisten();
			} catch {
				// Not a Tauri window (or the permission is missing): keep the default strip.
			}
		})();

		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	return fullscreen;
}
