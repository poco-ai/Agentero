import { commands, type OpenWithApp } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";

export type { OpenWithApp } from "@/lib/core/bindings";

/**
 * Menu rows (file manager, installed editors, terminal), probed once per
 * session; the path bar menu is populated before it opens. A failed probe
 * clears the cache so a later open can retry.
 */
let appsPromise: Promise<OpenWithApp[]> | null = null;

/** Probe the curated menu list (file manager + installed editors + terminal). */
export function probeOpenWithApps(): Promise<OpenWithApp[]> {
	if (!appsPromise) {
		appsPromise = callApiResult(() => commands.pathOpenWithApps()).catch(
			(error: unknown) => {
				appsPromise = null;
				throw error;
			},
		);
	}
	return appsPromise;
}

/**
 * Open the paper folder with a probed row id (`"finder"`, an editor, or
 * `"terminal"`). A file path opens its parent directory.
 */
export async function openPaperFolderWith(
	appId: string,
	path: string,
): Promise<void> {
	await callApiResult(() => commands.pathOpenWith(appId, path));
}
