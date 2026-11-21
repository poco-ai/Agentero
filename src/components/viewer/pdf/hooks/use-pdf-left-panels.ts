/**
 * The PDF reader's left overlay rail: outline / references / figures.
 *
 * One panel owns the rail at a time, so the three toggles cannot fight over
 * the same slot and every panel closes the same way. The open slot is
 * remembered per document (`pdfPath`, or the embed document id for loose
 * PDFs): saving a bookmark rewrites the PDF bytes and remounts the viewer,
 * and the outline must stay open while the reader edits it. References and
 * figures restore with it, so the rail has one behavior instead of one
 * remembered panel and two forgetful ones.
 */

import { useCallback, useState } from "react";

/** The three panels that share the reader's left overlay rail. */
export type PdfLeftPanel = "outline" | "references" | "figures";

/** Open rail per document, so a viewer remount keeps the reader's panel. */
const openPanels = new Map<string, PdfLeftPanel>();

export type PdfLeftPanels = {
	/** Which rail is showing; null when the reading surface is unobstructed. */
	activePanel: PdfLeftPanel | null;
	openPanel: (panel: PdfLeftPanel) => void;
	togglePanel: (panel: PdfLeftPanel) => void;
	/** Dismiss the rail without remembering it (reading-surface click). */
	closePanel: () => void;
};

export function usePdfLeftPanels(panelKey: string): PdfLeftPanels {
	const [activePanel, setActivePanel] = useState<PdfLeftPanel | null>(
		() => openPanels.get(panelKey) ?? null,
	);

	const commit = useCallback(
		(next: PdfLeftPanel | null) => {
			if (next) openPanels.set(panelKey, next);
			else openPanels.delete(panelKey);
			setActivePanel(next);
		},
		[panelKey],
	);

	const openPanel = useCallback(
		(panel: PdfLeftPanel) => commit(panel),
		[commit],
	);
	const closePanel = useCallback(() => commit(null), [commit]);
	const togglePanel = useCallback(
		(panel: PdfLeftPanel) => commit(activePanel === panel ? null : panel),
		[activePanel, commit],
	);

	return { activePanel, openPanel, togglePanel, closePanel };
}
