/**
 * Window-move helpers for documents and feature views.
 *
 * A document move is Prepare → Open → Accept → Commit. The clicked view stays
 * until the target window says its content is loaded. Commit removes only
 * that view id and must not call `closeTab` (that would also close NOTES).
 * The source window stays usable while it waits; there is no blocking overlay.
 */

import i18n from "@/i18n";
import { isZenVirtualPath } from "@/lib/agent/zen-path";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import { removeTabAnnotations } from "@/lib/pdf/annotations-store";
import { cancelPdfNavigationForTab } from "@/lib/pdf/pending-pdf-page";
import {
	docWindowLabel,
	openDocWindow,
	requestDocMoveAccept,
} from "@/lib/shell/doc-window";
import {
	type FeatureViewType,
	openFeatureWindow,
} from "@/lib/shell/feature-window";
import { dockHandle } from "@/lib/workspace/dock-registry";
import { currentWindowLabel, getTabs, setTabs } from "@/lib/workspace/store";
import { tabsAfterMovedView } from "@/lib/workspace/tabs/model";
import { revokeTabMediaSources } from "@/lib/workspace/tabs/resources";
import { markdownEditorFor } from "@/lib/workspace/viewer/markdown-editor-registry";

/** Move (or open) a feature view in its singleton native window. */
export async function moveFeatureToWindow(
	view: FeatureViewType,
): Promise<void> {
	await openFeatureWindow(view);
}

type PreparedDocMove = {
	sourceLabel: string;
	viewId: string;
	path: string;
	mode: string;
	title: string | null;
};

/**
 * Prepare: the source window label and the clicked view.
 * The path is only for the target window's identity (its label is the path hash).
 * Library, Trash, and Zen stay here. Plaza may move.
 */
function prepareDocMove(viewId: string): PreparedDocMove | null {
	const tab = getTabs().find((candidate) => candidate.id === viewId);
	if (!tab) return null;
	if (!tab.path.trim()) return null;
	if (
		tab.kind === "library" ||
		tab.kind === "trash" ||
		tab.kind === "zen" ||
		isLibraryVirtualPath(tab.path) ||
		isTrashVirtualPath(tab.path) ||
		isZenVirtualPath(tab.path)
	) {
		return null;
	}
	return {
		sourceLabel: currentWindowLabel(),
		viewId,
		path: tab.path,
		mode: tab.mode,
		title: tab.title ?? null,
	};
}

/**
 * Markdown source mode of this view only. Plate, CodeMirror, and Excalidraw
 * do not get a save gate here. Failure leaves the view open; the save path
 * already reports the error.
 */
async function flushMovedViewSource(viewId: string): Promise<boolean> {
	const handle = markdownEditorFor(viewId);
	if (!handle?.hasPendingSource()) return true;
	try {
		return await handle.flushSource();
	} catch {
		return false;
	}
}

/**
 * Commit: delete this one view from the tab store, then drop its dock panel.
 * NOTES is a different id and stays. `closeTab` is intentionally not used.
 */
function commitMovedDocView(viewId: string): void {
	const removed = getTabs().find((tab) => tab.id === viewId) ?? null;
	setTabs((prev) => tabsAfterMovedView(prev, viewId));
	if (removed) revokeTabMediaSources(removed);
	cancelPdfNavigationForTab(viewId);
	removeTabAnnotations([viewId]);
	dockHandle()?.removePanel(viewId);
}

function notifyMoveKept(reason: "unsaved" | "load" | "timeout"): void {
	notifyError(
		i18n.t(
			reason === "unsaved"
				? "app:windows.moveUnsaved"
				: "app:windows.moveFailed",
		),
	);
}

/**
 * Move the clicked view into the document window for its path.
 * `viewId` is the dock panel that was clicked, not “the canonical tab for this path”.
 */
export async function moveDocToWindow(viewId: string): Promise<void> {
	const prepared = prepareDocMove(viewId);
	if (!prepared) return;

	const opened = await openDocWindow(prepared.path, prepared.mode, {
		title: prepared.title,
	});
	if (!opened) return;

	let outcome: Awaited<ReturnType<typeof requestDocMoveAccept>>;
	try {
		outcome = await requestDocMoveAccept(await docWindowLabel(prepared.path), {
			requestId: moveRequestId(),
			path: prepared.path,
			sourceLabel: prepared.sourceLabel,
		});
	} catch (error) {
		notifyError(errorText(error));
		return;
	}
	if (outcome.status !== "accept") {
		notifyMoveKept(outcome.status === "timeout" ? "timeout" : outcome.reason);
		return;
	}

	const flushed = await flushMovedViewSource(prepared.viewId);
	if (!flushed) return;

	const current = getTabs().find((tab) => tab.id === prepared.viewId);
	if (!current || current.path !== prepared.path) return;
	commitMovedDocView(prepared.viewId);
}

function moveRequestId(): string {
	const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
	if (randomUUID) return randomUUID();
	return `move-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
