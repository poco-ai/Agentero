/**
 * PDF viewer imperative handles by tab id (component-layer registry so the
 * annotations panel can drive the active viewer without React prop threading).
 */

import type { PdfViewerHandle } from "@/components/viewer/pdf/pdf-viewer";
import {
	paperAbsFromWorkspaceTab,
	pdfTabIdForPaper,
} from "@/lib/pdf/annotation-ref";
import { getVaultPath, vaultStore } from "@/lib/vault/store";
import { getActiveTab } from "@/lib/workspace/store";

const handles = new Map<string, PdfViewerHandle>();

export function registerPdfHandle(
	tabId: string,
	handle: PdfViewerHandle | null,
): void {
	if (handle) handles.set(tabId, handle);
	else handles.delete(tabId);
}

export function pdfHandleFor(tabId: string | null): PdfViewerHandle | null {
	if (!tabId) return null;
	return handles.get(tabId) ?? null;
}

/**
 * Handle for the paper the user is currently reading.
 *
 * Handles are keyed by the PDF **body** tab id. With the default PDF|NOTES
 * split, Dockview often leaves NOTES as `activeTabId` even while the PDF pane
 * is visible — callers must not require `activeTab.mode === "pdf"`.
 * Same fallback pattern as the annotations side panel.
 */
export function resolveActivePdfHandle(): PdfViewerHandle | null {
	const active = getActiveTab();
	const candidates: string[] = [];

	if (active?.mode === "pdf") {
		candidates.push(active.id);
	}

	const paperAbs = paperAbsFromWorkspaceTab(
		active,
		getVaultPath(),
		vaultStore.getState().paperFolders,
	);
	if (paperAbs) {
		const bodyId = pdfTabIdForPaper(paperAbs);
		if (!candidates.includes(bodyId)) candidates.push(bodyId);
	}

	for (const id of candidates) {
		const handle = handles.get(id);
		if (handle) return handle;
	}
	return null;
}
