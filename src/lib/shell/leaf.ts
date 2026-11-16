/**
 * Window-move helpers for documents and feature views.
 */

import { isZenVirtualPath } from "@/lib/agent/zen-path";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import { openDocWindow } from "@/lib/shell/doc-window";
import {
	type FeatureViewType,
	openFeatureWindow,
} from "@/lib/shell/feature-window";

/** Move (or open) a feature view in its singleton native window. */
export async function moveFeatureToWindow(
	view: FeatureViewType,
): Promise<void> {
	await openFeatureWindow(view);
}

/**
 * Move a document path into a dedicated native window and close the source
 * dock panel when present.
 */
export async function moveDocToWindow(
	path: string,
	mode?: string,
): Promise<void> {
	if (
		isLibraryVirtualPath(path) ||
		isTrashVirtualPath(path) ||
		isZenVirtualPath(path)
	) {
		return;
	}
	const { getTabs } = await import("@/lib/workspace/store");
	const { tabIdForPath } = await import("@/lib/workspace/tabs");
	const id = tabIdForPath(path);
	const tab = getTabs().find((t) => t.id === id);
	await openDocWindow(path, mode, { title: tab?.title ?? null });
	const { closeTab } = await import("@/lib/workspace/actions");
	closeTab(id);
}
