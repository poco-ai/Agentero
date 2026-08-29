/**
 * Deferred cell-copy for the library table.
 *
 * Single-click a cell schedules a copy after a short delay; the second half
 * of a double-click (or the row `dblclick` that opens the paper) cancels it
 * so opening never writes the clipboard.
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { CellT } from "@/components/library/library-row-utils";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import type { PaperMetadata } from "@/lib/paper";

/**
 * Delay before committing a cell-copy click.
 * Must outlast a typical double-click interval so the first half of a
 * double-click does not copy before `detail > 1` / `dblclick` can cancel it.
 */
const CELL_COPY_CLICK_DELAY_MS = 320;

export function useCellCopy({
	t,
	onOpenPaper,
}: {
	t: CellT;
	onOpenPaper: (paper: PaperMetadata) => void;
}) {
	/** Pending cell-copy timer — cleared when a double-click opens the paper. */
	const pendingCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	const cancelPendingCopy = useCallback(() => {
		if (pendingCopyTimerRef.current != null) {
			clearTimeout(pendingCopyTimerRef.current);
			pendingCopyTimerRef.current = null;
		}
	}, []);

	useEffect(() => () => cancelPendingCopy(), [cancelPendingCopy]);

	/** Single-click a cell → copy that field; skip empty values. */
	const copyField = useCallback(
		async (text: string | null | undefined, label: string) => {
			const value = text?.trim();
			if (!value) return;
			await copyTextToClipboard(value, {
				successMessage: t("papersLibrary.copied", { label }),
				errorMessage: t("papersLibrary.copyFailed"),
				successNotify: {
					duration: 1500,
					id: "papers-library-copied",
				},
			});
		},
		[t],
	);

	/**
	 * Cell click → schedule copy. Double-click fires a second click with
	 * `detail > 1` plus `dblclick` on the row; both cancel the pending copy
	 * so opening a paper does not also write the clipboard.
	 */
	const onCellCopy = useCallback(
		(e: ReactMouseEvent, text: string | null | undefined, label: string) => {
			// Second (or later) click of a multi-click: abort any scheduled copy.
			if (e.detail > 1) {
				cancelPendingCopy();
				return;
			}
			cancelPendingCopy();
			pendingCopyTimerRef.current = setTimeout(() => {
				pendingCopyTimerRef.current = null;
				void copyField(text, label);
			}, CELL_COPY_CLICK_DELAY_MS);
		},
		[cancelPendingCopy, copyField],
	);

	const openPaperFromRow = useCallback(
		(paper: PaperMetadata) => {
			cancelPendingCopy();
			onOpenPaper(paper);
		},
		[cancelPendingCopy, onOpenPaper],
	);

	return { onCellCopy, openPaperFromRow };
}
