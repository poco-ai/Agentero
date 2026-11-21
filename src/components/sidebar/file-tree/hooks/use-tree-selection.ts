/**
 * Multi-selection (Ctrl/Cmd/Shift click), row activation, and the
 * selection-scoped actions (batch delete, cut, paste).
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
	clearSelection: () => void;
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
}): TreeSelection {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [anchor, setAnchor] = useState<string | null>(null);
	const previousVaultRef = useRef(vaultPath);

	const clearSelection = useCallback(() => {
		setSelected(new Set());
		setAnchor(null);
	}, []);

	// A vault switch starts a new tree; never carry selection across vaults.
	useEffect(() => {
		if (previousVaultRef.current === vaultPath) return;
		previousVaultRef.current = vaultPath;
		setSelected(new Set());
		setAnchor(null);
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

	const prepareContextSelection = useCallback(
		(path: string) => {
			if (isVirtualTreePath(path)) {
				clearSelection();
				return;
			}
			if (selected.has(path)) return;
			setSelected(new Set([path]));
			setAnchor(path);
		},
		[clearSelection, selected],
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
		(path: string) => {
			setSelected((prev) => {
				const next = new Set(prev);
				// Fold the current open/anchored row into a fresh multi-selection
				// so the count matches the highlighted rows.
				if (
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
			if (isVirtualTreePath(path)) {
				clearSelection();
				openRow(path);
				return;
			}
			if (mods.shift && anchor) {
				const from = selectableOrder.indexOf(anchor);
				const to = selectableOrder.indexOf(path);
				if (from !== -1 && to !== -1) {
					const [lo, hi] = from <= to ? [from, to] : [to, from];
					setSelected(
						new Set(normalizeTreeSelection(selectableOrder.slice(lo, hi + 1))),
					);
					return;
				}
			}
			if (mods.meta || mods.ctrl) {
				toggleSelected(path);
				setAnchor(path);
				return;
			}
			// Plain click: drop any multi-selection and open the row.
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

	// Escape clears; Delete is scoped to the tree surface so a focused PDF or
	// Dockview panel never deletes vault files. The tree no longer owns
	// ⌘⌫ — App routes that single shortcut to batch delete.
	useEffect(() => {
		if (selected.size === 0) return;
		const onKey = (event: KeyboardEvent) => {
			const el = event.target as HTMLElement | null;
			if (
				el &&
				(el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
			) {
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				clearSelection();
				return;
			}
			const withinTree =
				containerRef?.current?.contains(document.activeElement) ?? false;
			if (withinTree && event.key === "Delete") {
				event.preventDefault();
				runBatchDelete();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [clearSelection, containerRef, runBatchDelete, selected.size]);

	return {
		selected,
		clearSelection,
		prepareContextSelection,
		handleSelectRow,
		orderedSelected,
		pathsForAction,
		runBatchDelete,
		cutSelected,
		pasteIntoSelected,
	};
}
