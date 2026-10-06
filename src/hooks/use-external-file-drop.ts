import { useEffect } from "react";
import {
	isPhysicalPointInRect,
	subscribeTauriFileDrop,
} from "@/lib/agent/tauri-file-drop";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isVaultFileDragActive } from "@/lib/core/vault-file-drag";
import { dropLocalPdfs } from "@/lib/paper/import-actions";
import { currentLookupParentDir } from "@/lib/paper/library-actions";
import {
	dataTransferHasFiles,
	pdfsFromPaths,
} from "@/lib/shell/external-file-drop";
import { handleExternalPdfDrop } from "@/lib/shell/external-pdf-drop";

function nativeDropIsOverLibrary(position: { x: number; y: number }): boolean {
	return [...document.querySelectorAll("[data-library-drop-shell]")].some(
		(element) =>
			element instanceof HTMLElement &&
			isPhysicalPointInRect(position, element.getBoundingClientRect()),
	);
}

/**
 * Block OS file drops from navigating the webview away from the SPA.
 *
 * Windows/macOS use HTML5 DnD with `dragDropEnabled: false`; Linux also
 * enables native GTK file-path events to cover empty WebKitGTK FileLists.
 * Without preventDefault, dropping a PDF can navigate the webview to the
 * system viewer and freeze.
 *
 * Non-PDF drops: no app reaction (only navigation cancelled). PDF drops that
 * are not claimed by a more specific target handler use the current Papers
 * folder as their import destination.
 */
export function useExternalFileDrop(): void {
	useEffect(() => {
		const onDragOver = (e: DragEvent) => {
			if (!dataTransferHasFiles(e.dataTransfer)) return;
			// Required for drop to fire; also stops navigation preview.
			e.preventDefault();
		};

		const onDrop = (e: DragEvent) => {
			if (!dataTransferHasFiles(e.dataTransfer)) return;
			const parentDir = currentLookupParentDir();
			if (
				handleExternalPdfDrop(e, {
					onImport: (items) => dropLocalPdfs(items, parentDir),
					onError: (error) => notifyError(errorText(error)),
				})
			) {
				return;
			}
			// Always cancel — otherwise the webview navigates to the file.
			e.preventDefault();
		};

		// Bubble phase so target handlers (file-tree PDF import / moves) run first.
		window.addEventListener("dragover", onDragOver);
		window.addEventListener("drop", onDrop);
		return () => {
			window.removeEventListener("dragover", onDragOver);
			window.removeEventListener("drop", onDrop);
		};
	}, []);

	useEffect(() => {
		return subscribeTauriFileDrop(
			(payload) => {
				if (
					payload.type !== "drop" ||
					isVaultFileDragActive() ||
					nativeDropIsOverLibrary(payload.position)
				) {
					return false;
				}
				const pdfs = pdfsFromPaths(payload.paths);
				if (!pdfs.length) return false;
				dropLocalPdfs(pdfs, currentLookupParentDir());
				return true;
			},
			{ priority: -1 },
		);
	}, []);
}
