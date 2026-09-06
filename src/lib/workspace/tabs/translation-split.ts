import i18n from "@/i18n";
import { createPlaceholderTab, tabIdForPath } from "@/lib/workspace/tabs/model";
import type { DocTab } from "@/lib/workspace/tabs/types";

/**
 * Build a rendered-translation companion tab for a paper panel.
 * Returns null when the paper has no local folder path.
 */
export function createTranslationSplitPane(paperTab: DocTab): DocTab | null {
	if (!paperTab.path) return null;
	const baseId = tabIdForPath(paperTab.path);
	const translationId = `${baseId}::translation`;
	const title = paperTab.paperMeta?.title
		? i18n.t("viewer:pdf.translation.tabTitle", {
				title: paperTab.paperMeta.title,
			})
		: i18n.t("viewer:pdf.translation.title");
	return {
		...createPlaceholderTab(paperTab.path, "translation", translationId),
		kind: "paper",
		title,
		paperMeta: paperTab.paperMeta,
		// If the source pane opened from local bytes, keep using bytes in the
		// translation pane. Do not reuse a source-side blob: URL here: blob leases
		// are scoped to the creating pane and may not resolve for the second
		// viewer (or may be revoked when the first pane closes).
		pdfUrl:
			paperTab.pdfUrl && !paperTab.pdfUrl.startsWith("blob:")
				? paperTab.pdfUrl
				: null,
		// Copy the PDF bytes so each pane owns its own buffer. EmbedPDF's worker
		// may transfer the underlying ArrayBuffer, so sharing the same reference
		// between panes can leave the second pane with a detached buffer.
		pdfBytes: paperTab.pdfBytes ? paperTab.pdfBytes.slice(0) : null,
		notesPath: paperTab.notesPath,
		loaded: true,
	};
}

/** Place the translation tab as a right split of the source paper panel. */
export function translationSplitPlacement(
	paperTabId: string,
	_tabs: DocTab[],
): { direction: "right"; referencePanelId: string } {
	return { direction: "right", referencePanelId: paperTabId };
}
