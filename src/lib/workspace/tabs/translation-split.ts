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
		pdfUrl: paperTab.pdfUrl,
		pdfBytes: paperTab.pdfBytes,
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
