/**
 * Multi-selection (Ctrl/Cmd/Shift click), the explicit selection mode, row
 * activation, and the selection-scoped actions (batch delete, cut, paste).
 *
 * Selection is kept across background tree refreshes: on every tree identity
 * change we reconcile the selected paths against the tree that still exists
 * (see `byPath`), instead of clearing everything. A vault switch resets it.
 */
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { LIBRARY_VIRTUAL_PATH, TRASH_VIRTUAL_PATH } from "@/lib/paper/api";
import {
	isPlazaVirtualPath,
	type PlazaSource,
	plazaSourceForPath,
} from "@/lib/plaza";
import type { FileNode } from "@/lib/vault";
import { isVirtualTreePath, normalizeTreeSelection } from "../tree-helpers";
import type { TreeCreateDraft, TreeRenameDraft } from "../types";
import {
	isZoteroCollectionReferencePath,
	zoteroCollectionReferenceRelPath,
} from "../zotero-collection-references";

export type RowClickMods = { meta: boolean; ctrl: boolean; shift: boolean };

export type TreeSelection = {
	selected: Set<string>;
	/** Explicit selection mode: row clicks toggle instead of opening. */
	selectionMode: boolean;
	clearSelection: () => void;
	/** Enter / leave the explicit selection mode (leaving clears the rows). */
	toggleSelectionMode: () => void;
	/** Right-click “Select multiple…”: enter the mode with this row checked. */
	startSelectionForPath: (path: string) => void;
	prepareContextSelection: (path: string) => void;
	handleSelectRow: (path: string, mods: RowClickMods) => void;
	orderedSelected: () => string[];
	/** Action target: the whole selection when the row is part of it. */
	pathsForAction: (path: string) => string[];
	runBatchDelete: () => void;
	cutSelected: () => void;
	pasteIntoSelected: () => void;
};

export function useTreeSelection({
	vaultPath,
	selectedPath,
	selectableOrder,
	byPath,
	createDraft,
	renameDraft,
	containerRef,
	onSelectFile,
	onSelectLibrary,
	onSelectTrash,
	onSelectPlazaSource,
	onOpenZoteroCollectionPaper,
	onTogglePath,
	onDeletePath,
	onDeletePaths,
	onCutPaths,
	onPasteInto,
	onSelectionChange,
}: {
	vaultPath: string | null;
	selectedPath: string | null;
	selectableOrder: string[];
	byPath: ReadonlyMap<string, FileNode>;
	createDraft: TreeCreateDraft | null;
	renameDraft?: TreeRenameDraft | null;
	/** Tree surface used to scope keyboard shortcuts to the focused tree. */
	containerRef?: RefObject<HTMLElement | null>;
	onSelectFile: (node: FileNode) => void;
	onSelectLibrary?: () => void;
	onSelectTrash?: () => void;
	onSelectPlazaSource?: (source: PlazaSource) => void;
	/** Open the real paper behind a read-only Zotero collection reference. */
	onOpenZoteroCollectionPaper?: (relPath: string) => void;
	onTogglePath?: (path: string) => void;
	onDeletePath?: (path: string) => void | Promise<void>;
	onDeletePaths?: (paths: string[]) => void | Promise<void>;
	onCutPaths?: (paths: string[]) => void;
	onPasteInto?: (targetPath: string) => void;
	onSelectionChange?: (count: number, selectionMode: boolean) => void;
}): TreeSelection {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [anchor, setAnchor] = useState<string | null>(null);
	const [selectionMode, setSelectionMode] = useState(false);
	const previousVaultRef = useRef(vaultPath);

	const clearSelection = useCallback(() => {
		setSelected(new Set());
		setAnchor(null);
		setSelectionMode(false);
	}, []);

	const toggleSelectionMode = useCallback(() => {
		if (selectionMode) {
			clearSelection();
		} else {
			setSelectionMode(true);
		}
	}, [selectionMode, clearSelection]);

	const startSelectionForPath = useCallback((path: string) => {
		if (isVirtualTreePath(path)) return;
		setSelectionMode(true);
		setSelected((prev) => new Set(normalizeTreeSelection([...prev, path])));
		setAnchor(path);
	}, []);

	// A vault switch starts a new tree; never carry selection across vaults.
	useEffect(() => {
		if (previousVaultRef.current === vaultPath) return;
		previousVaultRef.current = vaultPath;
		setSelected(new Set());
		setAnchor(null);
		setSelectionMode(false);
	}, [vaultPath]);

	// Reconcile after every tree identity change instead of clearing: a
	// background refresh (watcher / remote sync / lazy children) keeps the
	// paths that still exist.
	useEffect(() => {
		setSelected((prev) => {
			if (prev.size === 0) return prev;
			const kept: string[] = [];
			for (const path of prev) {
				if (isVirtualTreePath(path)) continue;
				if (byPath.has(path)) kept.push(path);
			}
			const normalized = normalizeTreeSelection(kept);
			const unchanged =
				normalized.length === prev.size &&
				normalized.every((path) => prev.has(path));
			return unchanged ? prev : new Set(normalized);
		});
		setAnchor((prev) => (prev && byPath.has(prev) ? prev : null));
	}, [byPath]);

	useEffect(() => {
		onSelectionChange?.(selected.size, selectionMode);
	}, [onSelectionChange, selected.size, selectionMode]);

	const prepareContextSelection = useCallback(
		(path: string) => {
			// Virtual rows (trash / plaza) have row-scoped menus; never drop the
			// current selection just because the user right-clicked them.
			if (isVirtualTreePath(path)) return;
			if (selectionMode) return;
			if (selected.has(path)) return;
			setSelected(new Set([path]));
			setAnchor(path);
		},
		[selectionMode, selected],
	);

	const openRow = useCallback(
		(path: string) => {
			if (path === LIBRARY_VIRTUAL_PATH) {
				onSelectLibrary?.();
				return;
			}
			if (path === TRASH_VIRTUAL_PATH) {
				onSelectTrash?.();
				return;
			}
			// Plaza paths are virtual: they have no FileNode to fall through to.
			// The root node is a plain folder — it only expands/collapses.
			if (isPlazaVirtualPath(path)) {
				const source = plazaSourceForPath(path);
				if (source) onSelectPlazaSource?.(source);
				else onTogglePath?.(path);
				return;
			}
			if (isZoteroCollectionReferencePath(path)) {
				const paperRel = zoteroCollectionReferenceRelPath(path);
				if (paperRel) onOpenZoteroCollectionPaper?.(paperRel);
				return;
			}
			const node = byPath.get(path);
			if (!node) return;
			// Files, paper folders, and org folders (e.g. papers/nlp/pretrain) —
			// parent opens paper / scoped library via onSelectFile.
			onSelectFile(node);
		},
		[
			byPath,
			onSelectFile,
			onSelectLibrary,
			onSelectTrash,
			onSelectPlazaSource,
			onOpenZoteroCollectionPaper,
			onTogglePath,
		],
	);

	const toggleSelected = useCallback(
		(path: string, foldAnchor: boolean) => {
			setSelected((prev) => {
				const next = new Set(prev);
				// Fold the current open/anchored row into a fresh selection so the
				// count matches the highlighted rows when the mode starts from a
				// modifier click.
				if (
					foldAnchor &&
					next.size === 0 &&
					anchor &&
					anchor !== path &&
					selectableOrder.includes(anchor)
				) {
					next.add(anchor);
				}
				if (next.has(path)) next.delete(path);
				else next.add(path);
				return new Set(normalizeTreeSelection(next));
			});
		},
		[anchor, selectableOrder],
	);

	const handleSelectRow = useCallback(
		(path: string, mods: RowClickMods) => {
			if (createDraft || renameDraft) return;
			// Virtual rows are navigation targets: leaving the mode is expected.
			if (isVirtualTreePath(path)) {
				clearSelection();
				openRow(path);
				return;
			}
			// Shift extends the range in both normal and selection mode.
			if (mods.shift && anchor) {
				const from = selectableOrder.indexOf(anchor);
				const to = selectableOrder.indexOf(path);
				if (from !== -1 && to !== -1) {
					const [lo, hi] = from <= to ? [from, to] : [to, from];
					setSelected(
						new Set(normalizeTreeSelection(selectableOrder.slice(lo, hi + 1))),
					);
					setSelectionMode(true);
					return;
				}
			}
			if (selectionMode) {
				toggleSelected(path, false);
				setAnchor(path);
				return;
			}
			if (mods.meta || mods.ctrl) {
				// Old muscle memory: the first modifier click enters the mode.
				setSelectionMode(true);
				toggleSelected(path, true);
				setAnchor(path);
				return;
			}
			// Plain click: drop any selection / mode and open the row.
			clearSelection();
			setAnchor(path);
			openRow(path);
		},
		[
			anchor,
			clearSelection,
			createDraft,
			openRow,
			renameDraft,
			selectableOrder,
			selectionMode,
			toggleSelected,
		],
	);

	const orderedSelected = useCallback(() => {
		const visible = selectableOrder.filter((path) => selected.has(path));
		const visibleSet = new Set(visible);
		return normalizeTreeSelection([
			...visible,
			...[...selected].filter((path) => !visibleSet.has(path)),
		]);
	}, [selectableOrder, selected]);

	const pathsForAction = useCallback(
		(path: string): string[] =>
			selected.has(path) && selected.size > 0 ? orderedSelected() : [path],
		[selected, orderedSelected],
	);

	const runBatchDelete = useCallback(() => {
		const paths = orderedSelected();
		if (paths.length === 0) return;
		if (onDeletePaths) void onDeletePaths(paths);
		else if (onDeletePath && paths[0]) void onDeletePath(paths[0]);
	}, [orderedSelected, onDeletePaths, onDeletePath]);

	const cutSelected = useCallback(() => {
		const paths =
			selected.size > 0
				? orderedSelected()
				: selectedPath
					? [selectedPath]
					: [];
		if (paths.length > 0) {
			onCutPaths?.(paths);
		}
	}, [selected.size, selectedPath, orderedSelected, onCutPaths]);

	const pasteIntoSelected = useCallback(() => {
		if (selectedPath) {
			onPasteInto?.(selectedPath);
		}
	}, [selectedPath, onPasteInto]);

	// Keyboard: Escape / Delete / ⌘A are scoped to the tree surface so a
	// focused PDF or Dockview panel never deletes vault files.
	useEffect(() => {
		if (!selectionMode && selected.size === 0) return;
		const onKey = (event: KeyboardEvent) => {
			const el = event.target as HTMLElement | null;
			if (
				el &&
				(el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
			) {
				return;
			}
			const withinTree =
				containerRef?.current?.contains(document.activeElement) ?? false;
			const selectAllMod = event.metaKey || event.ctrlKey;
			if (event.key === "Escape") {
				// The explicit mode always closes on Esc; an implicit selection
				// only when the tree is the active surface.
				if (!selectionMode && !withinTree) return;
				event.preventDefault();
				clearSelection();
				return;
			}
			if (!withinTree) return;
			if (event.key === "Delete") {
				event.preventDefault();
				runBatchDelete();
				return;
			}
			if (selectionMode && selectAllMod && event.key.toLowerCase() === "a") {
				event.preventDefault();
				const rows = selectableOrder.filter((path) => !isVirtualTreePath(path));
				setSelected(new Set(normalizeTreeSelection(rows)));
				setAnchor(null);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [
		clearSelection,
		containerRef,
		runBatchDelete,
		selectableOrder,
		selected.size,
		selectionMode,
	]);

	return {
		selected,
		selectionMode,
		clearSelection,
		toggleSelectionMode,
		startSelectionForPath,
		prepareContextSelection,
		handleSelectRow,
		orderedSelected,
		pathsForAction,
		runBatchDelete,
		cutSelected,
		pasteIntoSelected,
	};
}
