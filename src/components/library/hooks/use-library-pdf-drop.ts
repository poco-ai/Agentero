/**
 * PDF drop highlight + import for the Library table.
 *
 * HTML5 dragenter is unreliable for macOS Finder files, so we hit-test the
 * shell on document dragover plus Tauri `onDragDropEvent`. Overlay only when
 * the payload is a PDF (one or more); images / other types stay ignored.
 * Drops are accepted only when the pointer is over the Library panel so
 * file-tree `papers/` imports are not stolen.
 */
import type { DragEvent as ReactDragEvent, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	isClientPointInRect,
	isPhysicalPointInRect,
	subscribeTauriFileDrop,
} from "@/lib/agent/tauri-file-drop";
import {
	dataTransferLooksLikeOsFiles,
	dataTransferLooksLikePdfs,
	dataTransferLooksLikeVaultMove,
	hasPdfExtension,
	isPdfMimeOrUti,
} from "@/lib/core/file-accept";
import { notifyError } from "@/lib/core/notify";
import { basenameOf } from "@/lib/core/path";
import { isVaultFileDragActive } from "@/lib/core/vault-file-drag";
import { libraryDropParentDir } from "@/lib/paper/api";
import { dropLocalPdfs } from "@/lib/paper/import-actions";
import { currentLookupParentDir } from "@/lib/paper/library-actions";
import {
	type ResolvedDropPdf,
	resolveDroppedPdfPaths,
	snapshotDataTransfer,
} from "@/lib/shell/external-file-drop";

function snapshotLooksLikePdf(
	snap: ReturnType<typeof snapshotDataTransfer>,
): boolean {
	if (snap.paths.some((path) => hasPdfExtension(path))) return true;
	return snap.files.some(
		(file) =>
			isPdfMimeOrUti(file.type) ||
			hasPdfExtension(file.name) ||
			(file.path != null && hasPdfExtension(file.path)),
	);
}

function destForLibraryDrop(scopePath: string | null | undefined): string {
	return libraryDropParentDir(scopePath, currentLookupParentDir());
}

export function useLibraryPdfDrop(scopePath: string | null | undefined) {
	const { t } = useTranslation("sidebar");
	const shellRef = useRef<HTMLDivElement>(null);
	const tauriPathsRef = useRef<string[]>([]);
	const scopePathRef = useRef(scopePath);
	scopePathRef.current = scopePath;
	const [isPdfDragOver, setIsPdfDragOver] = useState(false);

	const overShell = useCallback((x: number, y: number) => {
		const el = shellRef.current;
		if (!el) return false;
		return isClientPointInRect(x, y, el.getBoundingClientRect());
	}, []);

	const importPdfs = useCallback((items: ResolvedDropPdf[]) => {
		if (!items.length) return;
		dropLocalPdfs(items, destForLibraryDrop(scopePathRef.current));
	}, []);

	useEffect(() => {
		const onDragOver = (event: DragEvent) => {
			if (
				isVaultFileDragActive() ||
				dataTransferLooksLikeVaultMove(event.dataTransfer)
			) {
				setIsPdfDragOver(false);
				return;
			}
			if (!dataTransferLooksLikeOsFiles(event.dataTransfer)) return;
			if (!overShell(event.clientX, event.clientY)) {
				setIsPdfDragOver(false);
				return;
			}
			if (!dataTransferLooksLikePdfs(event.dataTransfer)) {
				setIsPdfDragOver(false);
				return;
			}
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
			setIsPdfDragOver(true);
		};
		const onDragLeave = (event: DragEvent) => {
			if (event.relatedTarget) return;
			setIsPdfDragOver(false);
		};
		const clear = () => setIsPdfDragOver(false);
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
				setIsPdfDragOver(false);
				return;
			}
			if (payload.type === "leave" || payload.type === "drop") {
				if (payload.type === "drop") {
					const pdfPaths = payload.paths.filter((path) =>
						hasPdfExtension(path),
					);
					const el = shellRef.current;
					if (
						pdfPaths.length > 0 &&
						el != null &&
						isPhysicalPointInRect(payload.position, el.getBoundingClientRect())
					) {
						importPdfs(
							pdfPaths.map((path) => ({
								path,
								sourceName: basenameOf(path),
							})),
						);
					}
				}
				tauriPathsRef.current = [];
				setIsPdfDragOver(false);
				return;
			}
			if (payload.type === "enter") {
				tauriPathsRef.current = payload.paths;
			}
			const paths = tauriPathsRef.current;
			if (!paths.some((path) => hasPdfExtension(path))) {
				setIsPdfDragOver(false);
				return;
			}
			const el = shellRef.current;
			const over =
				el != null &&
				isPhysicalPointInRect(payload.position, el.getBoundingClientRect());
			setIsPdfDragOver(over);
		});
	}, [importPdfs]);

	const onPdfDragEnter = useCallback((event: ReactDragEvent) => {
		if (dataTransferLooksLikeVaultMove(event.dataTransfer)) return;
		if (!dataTransferLooksLikePdfs(event.dataTransfer)) return;
		event.preventDefault();
		setIsPdfDragOver(true);
	}, []);

	const onPdfDragLeave = useCallback((event: ReactDragEvent) => {
		if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
			return;
		}
		setIsPdfDragOver(false);
	}, []);

	const onPdfDragOver = useCallback((event: ReactDragEvent) => {
		if (dataTransferLooksLikeVaultMove(event.dataTransfer)) return;
		if (!dataTransferLooksLikePdfs(event.dataTransfer)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	}, []);

	const onPdfDrop = useCallback(
		(event: ReactDragEvent) => {
			const dt =
				(event.nativeEvent as DragEvent | undefined)?.dataTransfer ??
				event.dataTransfer;
			if (dataTransferLooksLikeVaultMove(dt) || isVaultFileDragActive()) {
				return;
			}
			if (!dataTransferLooksLikeOsFiles(dt) && !dataTransferLooksLikePdfs(dt)) {
				return;
			}
			const snap = snapshotDataTransfer(dt);
			if (!snapshotLooksLikePdf(snap)) return;
			event.preventDefault();
			event.stopPropagation();
			setIsPdfDragOver(false);
			void resolveDroppedPdfPaths(snap)
				.then((pdfs) => {
					importPdfs(pdfs);
				})
				.catch((error) => {
					notifyError(
						error instanceof Error
							? error.message
							: t("importLocalPdf.dropNoPath"),
					);
				});
		},
		[importPdfs, t],
	);

	return {
		shellRef: shellRef as RefObject<HTMLDivElement>,
		isPdfDragOver,
		onPdfDragEnter,
		onPdfDragLeave,
		onPdfDragOver,
		onPdfDrop,
	};
}
