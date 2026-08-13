import { useEffect } from "react";
import { dataTransferHasFiles } from "@/lib/shell/external-file-drop";

/**
 * Block OS file drops from navigating the webview away from the SPA.
 *
 * Safety net if an OS file drop still reaches HTML5 (Tauri also emits
 * `onDragDropEvent` when `dragDropEnabled` is true). Without preventDefault,
 * dropping a PDF can navigate the webview to the system viewer and freeze.
 *
 * Non-PDF drops: no app reaction (only navigation cancelled).
 * PDF drops onto a `papers/` folder: handled by the file tree → confirm dialog.
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
}
