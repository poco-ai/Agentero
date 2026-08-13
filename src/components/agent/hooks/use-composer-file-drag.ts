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
	hasImageExtension,
} from "@/lib/core/file-accept";

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
			if (payload.type === "leave" || payload.type === "drop") {
				tauriPathsRef.current = [];
				setIsFileDragOver(false);
				return;
			}
			if (payload.type === "enter") {
				tauriPathsRef.current = payload.paths;
			}
			const paths = tauriPathsRef.current;
			const imageLike =
				paths.length === 0 || paths.some((path) => hasImageExtension(path));
			if (!imageLike) {
				setIsFileDragOver(false);
				return;
			}
			const el = shellRef.current;
			const panel = document.querySelector("[data-agent-panel]");
			const overShell =
				el != null &&
				isPhysicalPointInRect(payload.position, el.getBoundingClientRect());
			const overPanel =
				panel instanceof HTMLElement &&
				isPhysicalPointInRect(payload.position, panel.getBoundingClientRect());
			// Coordinates may miss the input box; still hint while an image is
			// dragged over this window and the composer is mounted.
			setIsFileDragOver(Boolean(overShell || overPanel || el));
		});
	}, []);

	const onFileDragEnter = useCallback((event: ReactDragEvent) => {
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
