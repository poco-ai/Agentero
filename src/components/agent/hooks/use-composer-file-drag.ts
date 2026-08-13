/**
 * Image drop highlight for the composer shell.
 *
 * HTML5 dragenter on the form is unreliable for macOS OS file drags, so we
 * hit-test the shell on document dragover plus Tauri `onDragDropEvent`.
 */
import type { DragEvent as ReactDragEvent, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	isClientPointInRect,
	isPhysicalPointInRect,
	subscribeTauriFileDrop,
} from "@/lib/agent/tauri-file-drop";
import {
	dataTransferLooksLikeImages,
	dataTransferLooksLikeOsFiles,
	dataTransferLooksLikeVaultMove,
	hasImageExtension,
} from "@/lib/core/file-accept";
import { isVaultFileDragActive } from "@/lib/shell/vault-file-drag";

export function useComposerFileDrag() {
	const shellRef = useRef<HTMLDivElement>(null);
	const tauriPathsRef = useRef<string[]>([]);
	const [isFileDragOver, setIsFileDragOver] = useState(false);

	const resetFileDragHighlight = useCallback(() => {
		setIsFileDragOver(false);
	}, []);

	const overShell = useCallback((x: number, y: number) => {
		const el = shellRef.current;
		if (!el) return false;
		return isClientPointInRect(x, y, el.getBoundingClientRect());
	}, []);

	useEffect(() => {
		const onDragOver = (event: DragEvent) => {
			if (
				isVaultFileDragActive() ||
				dataTransferLooksLikeVaultMove(event.dataTransfer)
			) {
				setIsFileDragOver(false);
				return;
			}
			if (!dataTransferLooksLikeOsFiles(event.dataTransfer)) {
				return;
			}
			if (!overShell(event.clientX, event.clientY)) {
				setIsFileDragOver(false);
				return;
			}
			if (!dataTransferLooksLikeImages(event.dataTransfer)) {
				setIsFileDragOver(false);
				return;
			}
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
			setIsFileDragOver(true);
		};
		const onDragLeave = (event: DragEvent) => {
			if (event.relatedTarget) return;
			setIsFileDragOver(false);
		};
		const clear = () => setIsFileDragOver(false);
		document.addEventListener("dragover", onDragOver);
		document.addEventListener("dragleave", onDragLeave);
		window.addEventListener("dragend", clear);
		window.addEventListener("drop", clear, true);
		return () => {
			document.removeEventListener("dragover", onDragOver);
			document.removeEventListener("dragleave", onDragLeave);
			window.removeEventListener("dragend", clear);
			window.removeEventListener("drop", clear, true);
		};
	}, [overShell]);

	useEffect(() => {
		return subscribeTauriFileDrop((payload) => {
			if (isVaultFileDragActive()) {
				setIsFileDragOver(false);
				return;
			}
			if (payload.type === "leave" || payload.type === "drop") {
				tauriPathsRef.current = [];
				setIsFileDragOver(false);
				return;
			}
			if (payload.type === "enter") {
				tauriPathsRef.current = payload.paths;
			}
			const paths = tauriPathsRef.current;
			// Empty paths are in-app HTML5 drags or unknown — do not flash overlay.
			if (!paths.some((path) => hasImageExtension(path))) {
				setIsFileDragOver(false);
				return;
			}
			const el = shellRef.current;
			const panel = document.querySelector("[data-agent-panel]");
			const overComposer =
				el != null &&
				isPhysicalPointInRect(payload.position, el.getBoundingClientRect());
			const overPanel =
				panel instanceof HTMLElement &&
				isPhysicalPointInRect(payload.position, panel.getBoundingClientRect());
			setIsFileDragOver(Boolean(overComposer || overPanel));
		});
	}, []);

	const onFileDragEnter = useCallback((event: ReactDragEvent) => {
		if (dataTransferLooksLikeVaultMove(event.dataTransfer)) return;
		if (!dataTransferLooksLikeImages(event.dataTransfer)) return;
		event.preventDefault();
		setIsFileDragOver(true);
	}, []);

	const onFileDragLeave = useCallback((event: ReactDragEvent) => {
		if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
			return;
		}
		setIsFileDragOver(false);
	}, []);

	const onFileDragOver = useCallback((event: ReactDragEvent) => {
		if (dataTransferLooksLikeVaultMove(event.dataTransfer)) return;
		if (!dataTransferLooksLikeImages(event.dataTransfer)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	}, []);

	const onFileDropHighlightEnd = useCallback(() => {
		resetFileDragHighlight();
	}, [resetFileDragHighlight]);

	return {
		shellRef: shellRef as RefObject<HTMLDivElement>,
		isFileDragOver,
		onFileDragEnter,
		onFileDragLeave,
		onFileDragOver,
		onFileDropHighlightEnd,
	};
}
