/**
 * PDF viewer imperative handles by tab id.
 *
 * Lib-layer registry (no JSX) so business logic — workspace actions, the
 * annotations panel, the command palette — can drive the active viewer without
 * React prop threading and without lib importing components. The
 * {@link PdfViewerHandle} contract lives here (not on the component) so this
 * module never imports `components/viewer/pdf/pdf-viewer`; the component side
 * re-exports the type from here.
 */

import type { PromptImage } from "@/lib/agent/api";
import {
	paperAbsFromWorkspaceTab,
	pdfTabIdForPaper,
} from "@/lib/pdf/annotation-ref";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import type { PdfLayoutKind } from "@/lib/pdf/layout";
import { getVaultPath, vaultStore } from "@/lib/vault/store";
import { getActiveTab, getTabs } from "@/lib/workspace/store";

/** Imperative surface consumed through the pdf viewer registry. */
export type PdfViewerHandle = {
	getHighlights: () => PdfHighlight[];
	scrollToHighlight: (id: string) => void;
	editComment: (id: string) => void;
	deleteHighlight: (id: string) => void;
	/** Jump to an ask pin and reopen its conversation card. */
	scrollToAsk: (id: string) => void;
	deleteAsk: (id: string) => void;
	/** Jump to a visual agent-trace pin and open its preview card. */
	scrollToVisualTrace: (id: string) => void;
	deleteVisualTrace: (id: string) => void;
	/** Toggle visual-region annotation mode (⌘.). */
	toggleVisualAnnotation: () => void;
	/** Toggle full-text (layout) translation (⌥A), dual-pane aware. */
	toggleLayoutTranslate: () => void;
	/** Run EmbedPDF layout analysis for figures / tables / formulas. */
	analyzeLayout: () => void;
	/** Jump to a layout region (0-based page) and focus its overlay. */
	scrollToLayoutRegion: (region: {
		id: string;
		pageIndex: number;
		bbox: PdfAskNormalizedRect;
		/** When set, paints the focus outline without a layout-store id lookup. */
		kind?: PdfLayoutKind;
	}) => void;
	/** Crop a normalized page region (for figure sidebar thumbnails). */
	renderRegion: (args: {
		pageIndex: number;
		bbox: PdfAskNormalizedRect;
		maxEdgePx?: number;
	}) => Promise<PromptImage | null>;
	/** Export the current PDF with embedded highlights/comments to a file. */
	exportAnnotatedPdf: () => Promise<void>;
};

const handles = new Map<string, PdfViewerHandle>();
const listeners = new Set<() => void>();

function emitPdfHandleChange(): void {
	for (const listener of listeners) listener();
}

export function subscribePdfHandles(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function registerPdfHandle(
	tabId: string,
	handle: PdfViewerHandle | null,
): void {
	const previous = handles.get(tabId) ?? null;
	if (handle) handles.set(tabId, handle);
	else handles.delete(tabId);
	const next = handles.get(tabId) ?? null;
	if (previous !== next) emitPdfHandleChange();
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
		const bodyId = pdfTabIdForPaper(paperAbs, getTabs());
		if (bodyId && !candidates.includes(bodyId)) candidates.push(bodyId);
	}

	for (const id of candidates) {
		const handle = handles.get(id);
		if (handle) return handle;
	}
	return null;
}
