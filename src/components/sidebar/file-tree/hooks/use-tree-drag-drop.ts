/**
 * Tree drag and drop: internal vault move between rows, plus OS PDF drop onto
 * a `papers/` org folder (import confirm happens in the parent).
 */

import {
	type DragEvent as ReactDragEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	isPhysicalPointInRect,
	subscribeTauriFileDrop,
} from "@/lib/agent/tauri-file-drop";
import { errorText } from "@/lib/core/error";
import { dataTransferTypes } from "@/lib/core/file-accept";
import { notifyError } from "@/lib/core/notify";
import { dirnameOf } from "@/lib/core/path";
import {
	beginVaultFileDrag,
	endVaultFileDrag,
	VAULT_FILE_DRAG_TYPE,
} from "@/lib/core/vault-file-drag";
import { isPaperAssetPath, isPaperDirectory } from "@/lib/paper";
import {
	dataTransferHasFiles,
	resolveDroppedPdfPaths,
	snapshotDataTransfer,
} from "@/lib/shell/external-file-drop";
import type { FileNode } from "@/lib/vault";
import { isVirtualTreePath } from "../tree-helpers";
import type { TreeCreateDraft, TreeRenameDraft } from "../types";

export type TreeDragDrop = {
	/** Folder row to highlight as the current drop destination. */
	dropTarget: string | null;
	handleRowDragStart: (path: string, e: ReactDragEvent) => void;
	handleRowDragOver: (path: string, e: ReactDragEvent) => void;
	handleRowDrop: (path: string, e: ReactDragEvent) => void;
	handleRowDragEnd: () => void;
};

export function useTreeDragDrop({
	byPath,
	relPathForNode,
	createDraft,
	renameDraft,
	pathsForAction,
	onDropMove,
	onDropLocalPdfs,
}: {
	byPath: ReadonlyMap<string, FileNode>;
	relPathForNode: (absPath: string) => string;
	createDraft: TreeCreateDraft | null;
	renameDraft?: TreeRenameDraft | null;
	pathsForAction: (path: string) => string[];
	onDropMove?: (paths: string[], targetPath: string) => void;
	onDropLocalPdfs?: (
		items: Array<{ path: string; sourceName: string }>,
		parentDir: string,
	) => void;
}): TreeDragDrop {
	const { t } = useTranslation("sidebar");
	const [dragging, setDragging] = useState<string[] | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const draggingRef = useRef<string[] | null>(null);
	const moveClaimedRef = useRef(false);
	/**
	 * macOS delivers the native drop *after* DOM `dragend`, which clears
	 * `dragging`. Keep the paths alive briefly past dragend so that late drop
	 * can still complete the move.
	 */
	const dragPathsRef = useRef<string[] | null>(null);
	const dragPathsExpireRef = useRef(0);
	draggingRef.current = dragging;

	/** Org folder under papers/ (not a paper unit, not virtual). */
	const isPapersOrgFolder = useCallback(
		(targetPath: string): boolean => {
			if (isVirtualTreePath(targetPath)) return false;
			const node = byPath.get(targetPath);
			if (node?.kind !== "directory") return false;
			if (isPaperDirectory(node.path, node.children)) return false;
			if (isPaperAssetPath(targetPath)) return false;
			const rel = relPathForNode(targetPath);
			return rel === "papers" || rel.startsWith("papers/");
		},
		[byPath, relPathForNode],
	);

	/** A row is a valid vault-move target if it is a real file/folder and not a dragged path or its descendant. */
	const canDrop = useCallback(
		(targetPath: string, paths: string[]): boolean => {
			if (paths.length === 0 || isVirtualTreePath(targetPath)) return false;
			const node = byPath.get(targetPath);
			if (!node) return false;
			const norm = targetPath.replace(/\\/g, "/").replace(/\/+$/, "");
			return !paths.some((d) => {
				const dn = d.replace(/\\/g, "/").replace(/\/+$/, "");
				return norm === dn || norm.startsWith(`${dn}/`);
			});
		},
		[byPath],
	);

	/** Dragged paths, including the brief window after DOM `dragend`. */
	const liveDragPaths = useCallback((): string[] | null => {
		const live = draggingRef.current;
		if (live?.length) return live;
		const retained = dragPathsRef.current;
		if (retained?.length && Date.now() < dragPathsExpireRef.current) {
			return retained;
		}
		return null;
	}, []);

	const handleRowDragStart = useCallback(
		(path: string, e: ReactDragEvent) => {
			if (createDraft || renameDraft || isVirtualTreePath(path)) {
				e.preventDefault();
				return;
			}
			const paths = pathsForAction(path);
			moveClaimedRef.current = false;
			dragPathsRef.current = paths;
			dragPathsExpireRef.current = Number.POSITIVE_INFINITY;
			setDragging(paths);
			beginVaultFileDrag();
			e.dataTransfer.effectAllowed = "move";
			try {
				e.dataTransfer.setData(VAULT_FILE_DRAG_TYPE, paths.join("\n"));
				e.dataTransfer.setData("text/plain", paths.join("\n"));
			} catch {
				// some webviews restrict setData; state still drives the drop
			}
		},
		[createDraft, renameDraft, pathsForAction],
	);

	/**
	 * Folder an item lands in when dropped on this row. A paper unit is a leaf,
	 * so dropping on it (like a plain file) lands in its parent folder; only a
	 * plain/org directory accepts items into itself.
	 */
	const dropDirFor = useCallback(
		(path: string): string => {
			const node = byPath.get(path);
			if (
				node?.kind === "directory" &&
				!isPaperDirectory(node.path, node.children)
			) {
				return path;
			}
			return dirnameOf(path) ?? path;
		},
		[byPath],
	);

	const handleRowDragOver = useCallback(
		(path: string, e: ReactDragEvent) => {
			// Internal vault move takes priority while a tree drag is active.
			if (dragging && canDrop(path, dragging)) {
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				const highlightPath = dropDirFor(path);
				if (dropTarget !== highlightPath) {
					setDropTarget(highlightPath);
				}
				return;
			}
			// OS PDF → import parent (only when not mid vault-move).
			if (
				!dragging &&
				onDropLocalPdfs &&
				dataTransferHasFiles(e.dataTransfer) &&
				isPapersOrgFolder(path)
			) {
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer.dropEffect = "copy";
				if (dropTarget !== path) setDropTarget(path);
				return;
			}
			if (dropTarget) setDropTarget(null);
		},
		[
			dragging,
			dropTarget,
			canDrop,
			onDropLocalPdfs,
			isPapersOrgFolder,
			dropDirFor,
		],
	);

	const finishVaultMove = useCallback(
		(paths: string[], targetPath: string) => {
			if (moveClaimedRef.current) return;
			moveClaimedRef.current = true;
			dragPathsRef.current = null;
			dragPathsExpireRef.current = 0;
			setDragging(null);
			setDropTarget(null);
			endVaultFileDrag();
			if (!onDropMove || !canDrop(targetPath, paths)) return;
			onDropMove(paths, dropDirFor(targetPath));
		},
		[onDropMove, canDrop, dropDirFor],
	);

	const handleRowDrop = useCallback(
		(path: string, e: ReactDragEvent) => {
			e.preventDefault();
			const vaultMovePaths = dragging;
			const markedVault = dataTransferTypes(e.dataTransfer).includes(
				VAULT_FILE_DRAG_TYPE,
			);
			if (vaultMovePaths || markedVault) {
				const paths =
					vaultMovePaths ??
					e.dataTransfer
						.getData("text/plain")
						.split(/\r?\n/)
						.map((line) => line.trim())
						.filter(Boolean);
				finishVaultMove(paths, path);
				return;
			}

			setDragging(null);
			setDropTarget(null);
			endVaultFileDrag();

			// External PDF drop onto papers/ org folder → background import in App.
			// Snapshot DataTransfer **now** (WKWebView clears it after the handler).
			// Prefer nativeEvent — React synthetic DataTransfer can hide FileList.
			// Path-less Files are staged via Host `paper_stage_import_file`.
			if (
				onDropLocalPdfs &&
				dataTransferHasFiles(e.dataTransfer) &&
				isPapersOrgFolder(path)
			) {
				e.stopPropagation();
				const dest = relPathForNode(path) || "papers";
				const nativeDt =
					(e.nativeEvent as DragEvent | undefined)?.dataTransfer ??
					e.dataTransfer;
				const snap = snapshotDataTransfer(nativeDt);
				void (async () => {
					try {
						const pdfs = await resolveDroppedPdfPaths(snap);
						if (!pdfs.length) {
							notifyError(t("importLocalPdf.dropNoPath"));
							return;
						}
						onDropLocalPdfs(pdfs, dest);
					} catch (err) {
						notifyError(errorText(err));
					}
				})();
			}
		},
		[
			dragging,
			finishVaultMove,
			onDropLocalPdfs,
			relPathForNode,
			isPapersOrgFolder,
			t,
		],
	);

	/** Innermost tree row under a native drag position, if any. */
	const rowPathAtPoint = useCallback(
		(position: { x: number; y: number }): string | null => {
			let targetPath: string | null = null;
			for (const row of document.querySelectorAll("[data-path]")) {
				if (!(row instanceof HTMLElement)) continue;
				if (!isPhysicalPointInRect(position, row.getBoundingClientRect())) {
					continue;
				}
				const next = row.dataset.path;
				if (next) targetPath = next;
			}
			return targetPath;
		},
		[],
	);

	/**
	 * macOS-only route. wry overrides the WKWebView `NSDraggingDestination`
	 * protocol and Tauri's handler always returns true, so wry never forwards to
	 * `super` and the page receives no DOM dragover/drop — even for a drag that
	 * started inside the tree. Windows/Linux gate these events on a real file
	 * list, so in-app drags there keep flowing through the DOM handlers above.
	 */
	useEffect(() => {
		return subscribeTauriFileDrop((payload) => {
			const paths = liveDragPaths();
			if (!paths?.length) return;
			if (payload.type === "leave") {
				setDropTarget(null);
				return;
			}
			const targetPath = rowPathAtPoint(payload.position);
			if (payload.type === "enter" || payload.type === "over") {
				setDropTarget(
					targetPath && canDrop(targetPath, paths)
						? dropDirFor(targetPath)
						: null,
				);
				return;
			}
			if (payload.type !== "drop" || !targetPath) return;
			finishVaultMove(paths, targetPath);
		});
	}, [finishVaultMove, rowPathAtPoint, canDrop, dropDirFor, liveDragPaths]);

	const handleRowDragEnd = useCallback(() => {
		// WebKit fires this source-side event *before* wry delivers the native
		// drop, so keep the paths alive long enough for that drop to land.
		if (!moveClaimedRef.current) {
			dragPathsExpireRef.current = Date.now() + 1000;
		}
		setDragging(null);
		setDropTarget(null);
		endVaultFileDrag();
	}, []);

	return {
		dropTarget,
		handleRowDragStart,
		handleRowDragOver,
		handleRowDrop,
		handleRowDragEnd,
	};
}
