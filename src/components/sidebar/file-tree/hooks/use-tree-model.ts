/**
 * Pure derivations over the vault tree: path indexes, display order, the
 * highlighted row, and the flattened row list consumed by the virtualizer.
 */
import { useCallback, useMemo } from "react";
import {
	isPaperDirectory,
	isPapersRoot,
	isUnderPaperAttachments,
	type PaperMetadata,
	type PaperTreeLabelMode,
	type PaperTreeSortMode,
	paperAttachmentsNode,
	sortFileTreeNodes,
} from "@/lib/paper";
import { LIBRARY_VIRTUAL_PATH } from "@/lib/paper/api";
import { PLAZA_VIRTUAL_PATH, visiblePlazaSources } from "@/lib/plaza";
import type { FileNode } from "@/lib/vault";
import { toVaultRelative } from "@/lib/wiki";
import {
	isVirtualTreePath,
	pathKey,
	visibleTreeChildren,
} from "../tree-helpers";
import type { FlatRow, TreeCreateDraft } from "../types";
import type { ZoteroCollectionReference } from "../zotero-collection-references";

export type TreeIndex = {
	byPath: ReadonlyMap<string, FileNode>;
	/** Case-insensitive path → node (selection resolve / ancestor expand). */
	byPathKey: ReadonlyMap<string, FileNode>;
	relPathForNode: (absPath: string) => string;
	/** Siblings ordered per Settings → paperTreeSortMode. */
	displayNodes: FileNode[];
	/**
	 * Row to highlight / scroll to:
	 * - virtual Library / Trash as-is;
	 * - a surfaced attachment under `{paper}/attachments/` → that file/folder;
	 * - any other path under a paper folder → that paper;
	 * - otherwise the path itself if present, else nearest existing ancestor.
	 */
	treeSelectedPath: string | undefined;
};

export function useTreeIndex({
	nodes,
	vaultPath,
	selectedPath,
	paperMetaByRelPath,
	paperTreeLabelMode,
	paperTreeSortMode,
}: {
	nodes: FileNode[];
	vaultPath: string | null;
	selectedPath: string | null;
	paperMetaByRelPath?: ReadonlyMap<string, PaperMetadata>;
	paperTreeLabelMode: PaperTreeLabelMode;
	paperTreeSortMode: PaperTreeSortMode;
}): TreeIndex {
	const byPath = useMemo(() => {
		const map = new Map<string, FileNode>();
		const walk = (list: FileNode[]) => {
			for (const n of list) {
				map.set(n.path, n);
				if (n.children) walk(n.children);
			}
		};
		walk(nodes);
		return map;
	}, [nodes]);

	const byPathKey = useMemo(() => {
		const map = new Map<string, FileNode>();
		const walk = (list: FileNode[]) => {
			for (const n of list) {
				map.set(pathKey(n.path), n);
				if (n.children) walk(n.children);
			}
		};
		walk(nodes);
		return map;
	}, [nodes]);

	const relPathForNode = useCallback(
		(absPath: string): string => toVaultRelative(vaultPath, absPath),
		[vaultPath],
	);

	const displayNodes = useMemo(
		() =>
			sortFileTreeNodes(
				nodes,
				paperTreeSortMode,
				paperMetaByRelPath,
				relPathForNode,
				paperTreeLabelMode,
			),
		[
			nodes,
			paperTreeSortMode,
			paperMetaByRelPath,
			relPathForNode,
			paperTreeLabelMode,
		],
	);

	const treeSelectedPath = useMemo(() => {
		if (!selectedPath) return undefined;
		return resolveTreeHighlightPath(selectedPath, byPathKey);
	}, [selectedPath, byPathKey]);

	return {
		byPath,
		byPathKey,
		relPathForNode,
		displayNodes,
		treeSelectedPath,
	};
}

/**
 * Which tree row should highlight for `selectedPath`.
 * Surfaced attachments keep their own row; other paper internals map to the paper.
 */
export function resolveTreeHighlightPath(
	selectedPath: string,
	byPathKey: ReadonlyMap<string, FileNode>,
): string {
	// The library is now the `papers/` row: highlight that folder instead of a
	// dedicated virtual row.
	if (selectedPath === LIBRARY_VIRTUAL_PATH) {
		const papersRoot = [...byPathKey.values()].find(
			(node) => node.kind === "directory" && isPapersRoot(node.path),
		);
		if (papersRoot) return papersRoot.path;
	}
	if (isVirtualTreePath(selectedPath)) return selectedPath;

	let cursor = selectedPath.replace(/\\/g, "/").replace(/\/+$/, "");
	while (cursor) {
		const node = byPathKey.get(pathKey(cursor));
		if (
			node &&
			node.kind === "directory" &&
			isPaperDirectory(node.path, node.children)
		) {
			if (isUnderPaperAttachments(selectedPath, node.path)) {
				const exact = byPathKey.get(pathKey(selectedPath));
				if (exact) return exact.path;
				let up = selectedPath.replace(/\\/g, "/").replace(/\/+$/, "");
				while (true) {
					const idx = up.lastIndexOf("/");
					if (idx <= 0) break;
					up = up.slice(0, idx);
					if (!isUnderPaperAttachments(up, node.path)) break;
					const found = byPathKey.get(pathKey(up));
					if (found) return found.path;
				}
			}
			return node.path;
		}
		const idx = cursor.lastIndexOf("/");
		if (idx <= 0) break;
		cursor = cursor.slice(0, idx);
	}

	const exact = byPathKey.get(pathKey(selectedPath));
	if (exact) return exact.path;

	cursor = selectedPath.replace(/\\/g, "/").replace(/\/+$/, "");
	while (true) {
		const idx = cursor.lastIndexOf("/");
		if (idx <= 0) break;
		cursor = cursor.slice(0, idx);
		const node = byPathKey.get(pathKey(cursor));
		if (node) return node.path;
	}
	return selectedPath;
}

export type TreeRows = {
	/** Visible, selectable rows in display order (papers expand only for attachments). */
	selectableOrder: string[];
	/** Flattened rows in display order (respects expand state + inline drafts). */
	flatRows: FlatRow[];
};

export function useTreeRows({
	displayNodes,
	expanded,
	createDraft,
	vaultPath,
	plazaEnabled,
	plazaHiddenSources,
	zoteroCollectionReferences,
}: {
	displayNodes: FileNode[];
	expanded: ReadonlySet<string>;
	createDraft: TreeCreateDraft | null;
	vaultPath: string | null;
	plazaEnabled: boolean;
	plazaHiddenSources: readonly string[];
	zoteroCollectionReferences: ReadonlyMap<string, ZoteroCollectionReference[]>;
}): TreeRows {
	const selectableOrder = useMemo(() => {
		const out: string[] = [];
		const walk = (list: FileNode[]) => {
			for (const n of list) {
				out.push(n.path);
				if (n.kind === "directory" && expanded.has(n.path)) {
					const kids = visibleTreeChildren(n);
					if (kids.length) walk(kids);
					for (const reference of zoteroCollectionReferences.get(n.path) ??
						[]) {
						out.push(reference.path);
					}
				}
			}
		};
		walk(displayNodes);
		return out;
	}, [displayNodes, expanded, zoteroCollectionReferences]);

	const flatRows = useMemo<FlatRow[]>(() => {
		// Virtual rows sit at the top: Recycle Bin, then 广场 + its sources.
		// The library has no virtual row — the `papers/` folder row represents it.
		const out: FlatRow[] = [{ key: "__trash__", kind: "trash" }];
		if (plazaEnabled) {
			out.push({ key: "__plaza__", kind: "plaza" });
			if (expanded.has(PLAZA_VIRTUAL_PATH)) {
				for (const source of visiblePlazaSources(plazaHiddenSources)) {
					out.push({
						key: `__plaza__${source.id}`,
						kind: "plazaSource",
						source,
					});
				}
			}
		}
		const draftAt = (parent: string) =>
			Boolean(
				createDraft && pathKey(createDraft.parentPath) === pathKey(parent),
			);
		if (vaultPath && draftAt(vaultPath)) {
			out.push({ key: "__create_root__", kind: "create", depth: 0 });
		}
		const walk = (list: FileNode[], depth: number) => {
			for (const n of list) {
				const paper =
					n.kind === "directory" && isPaperDirectory(n.path, n.children);
				out.push({
					key: n.id,
					kind: "node",
					depth,
					node: n,
					paperLeaf: paper,
				});
				const attachmentsDir = paper ? paperAttachmentsNode(n) : null;
				const showDraft =
					n.kind === "directory" &&
					(draftAt(n.path) ||
						Boolean(attachmentsDir && draftAt(attachmentsDir.path)));
				if (showDraft) {
					out.push({
						key: `create-${n.path}`,
						kind: "create",
						depth: depth + 1,
					});
				}
				if (n.kind === "directory" && expanded.has(n.path)) {
					const kids = visibleTreeChildren(n);
					if (kids.length) walk(kids, depth + 1);
					for (const reference of zoteroCollectionReferences.get(n.path) ??
						[]) {
						out.push({
							key: `zotero-reference-${reference.path}`,
							kind: "zoteroCollectionReference",
							depth: depth + 1,
							path: reference.path,
							paper: reference.paper,
						});
					}
				}
			}
		};
		walk(displayNodes, 0);
		return out;
	}, [
		displayNodes,
		expanded,
		createDraft,
		vaultPath,
		plazaEnabled,
		plazaHiddenSources,
		zoteroCollectionReferences,
	]);

	return { selectableOrder, flatRows };
}
