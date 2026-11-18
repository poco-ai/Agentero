/**
 * Window fullscreen shared by F11 (Windows) and immersive reading (desktop).
 */

import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { notifyError } from "@/lib/core/notify";
import { isTauri, isWindows } from "@/lib/core/tauri";

/** Toggle Tauri `setFullscreen` on the focused window (no-op off Windows). */
export async function toggleBorderlessFullscreen(): Promise<void> {
	if (!isTauri() || !isWindows()) return;
	const current = await readBorderlessFullscreen();
	await setBorderlessFullscreen(!current);
}

/** Current window fullscreen flag. False outside the desktop shell. */
export async function readBorderlessFullscreen(): Promise<boolean> {
	if (!isTauri()) return false;
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		return await getCurrentWindow().isFullscreen();
	} catch (error) {
		logger.warn("read borderless fullscreen failed", {
			error: errorText(error),
		});
		return false;
	}
}

/**
 * Set window fullscreen on every desktop platform. Immersive reading uses
 * this; F11 stays Windows-only via {@link toggleBorderlessFullscreen}.
 */
export async function setBorderlessFullscreen(next: boolean): Promise<boolean> {
	if (!isTauri()) return true;
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		const win = getCurrentWindow();
		if ((await win.isFullscreen()) === next) return true;
		await win.setFullscreen(next);
		if ((await win.isFullscreen()) !== next) {
			throw new Error(`fullscreen state did not change to ${next}`);
		}
		return true;
	} catch (error) {
		logger.warn("set borderless fullscreen failed", {
			error: errorText(error),
		});
		notifyError(errorText(error));
		return false;
	}
}
