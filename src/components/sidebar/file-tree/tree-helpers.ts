import {
	isPaperDirectory,
	isPapersRoot,
	paperAttachmentChildren,
	paperHasVisibleAttachments,
	paperNeedsAssetDownload,
} from "@/lib/paper";
import { LIBRARY_VIRTUAL_PATH, TRASH_VIRTUAL_PATH } from "@/lib/paper/api";
import { isPlazaVirtualPath, PLAZA_VIRTUAL_PATH } from "@/lib/plaza";
import type { FileNode } from "@/lib/vault";
import { normalizePathKey } from "@/lib/vault/path";
import { isZoteroCollectionReferencePath } from "./zotero-collection-references";

/** Case-insensitive tree-path key (same normalization as vault path keys). */
export const pathKey = normalizePathKey;

/** Paper folders that need Download (no PDF / no source / no PAPER.md). */
export function collectPapersNeedingAssets(nodes: FileNode[]): FileNode[] {
	const out: FileNode[] = [];
	const walk = (list: FileNode[]) => {
		for (const n of list) {
			if (n.kind === "directory" && isPaperDirectory(n.path, n.children)) {
				if (paperNeedsAssetDownload(n)) {
					out.push(n);
				}
			} else if (n.children?.length) {
				walk(n.children);
			}
		}
	};
	walk(nodes);
	return out;
}

export const DOWNLOAD_REASON_KEYS = {
	noPdf: "fileTree.downloadReason.noPdf",
	noBody: "fileTree.downloadReason.noBody",
} as const;

export function isVirtualTreePath(path: string): boolean {
	return (
		path === LIBRARY_VIRTUAL_PATH ||
		path === TRASH_VIRTUAL_PATH ||
		isPlazaVirtualPath(path) ||
		isZoteroCollectionReferencePath(path)
	);
}

/**
 * Keep only top-level semantic targets from a tree selection.
 *
 * Selecting a folder already includes everything below it. Passing both the
 * folder and one of its descendants to move/delete would execute the same
 * intent twice and can leave the second operation targeting a path that no
 * longer exists. Input order is preserved for stable UI/action ordering.
 */
export function normalizeTreeSelection(paths: Iterable<string>): string[] {
	const entries: Array<{ path: string; key: string }> = [];
	const seen = new Set<string>();
	for (const path of paths) {
		const key = pathKey(path);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		entries.push({ path, key });
	}
	return entries
		.filter(
			(entry) =>
				!entries.some(
					(other) =>
						other.key !== entry.key && entry.key.startsWith(`${other.key}/`),
				),
		)
		.map((entry) => entry.path);
}

/**
 * Default open folders when a Vault is first opened:
 * expand `papers/` only so its first-level children (org folders) are listed,
 * but keep those subfolders collapsed. Deeper nesting, `notes/`, etc. stay
 * collapsed. 广场 also starts open so its sources are discoverable.
 */
export function collectDefaultExpanded(
	nodes: FileNode[],
	into: Set<string>,
): void {
	into.add(PLAZA_VIRTUAL_PATH);
	for (const n of nodes) {
		if (n.kind !== "directory" || !isPapersRoot(n.path)) continue;
		into.add(n.path);
		return;
	}
}

/**
 * Collapse-to-default: only expand `papers/` so its direct children are listed;
 * do **not** expand org subfolders. `notes/` etc. stay closed.
 */
export function collectPapersRootOnlyExpanded(
	nodes: FileNode[],
	into: Set<string>,
): void {
	for (const n of nodes) {
		if (n.kind !== "directory" || !isPapersRoot(n.path)) continue;
		into.add(n.path);
		return;
	}
}

/**
 * Children shown when a directory row is expanded.
 * Papers surface `{paper}/attachments/*` only — never source/marks/NOTES.
 */
export function visibleTreeChildren(node: FileNode): FileNode[] {
	if (node.kind !== "directory") return [];
	if (isPaperDirectory(node.path, node.children)) {
		return paperAttachmentChildren(node);
	}
	return node.children ?? [];
}

/** Directory that can show a chevron (org folder, or paper with attachments). */
export function isTreeExpandableDirectory(node: FileNode): boolean {
	if (node.kind !== "directory") return false;
	if (isPaperDirectory(node.path, node.children)) {
		return paperHasVisibleAttachments(node);
	}
	return true;
}

/** Parent directory paths of `target` (absolute), nearest-first excluded. Root-ward order. */
export function ancestorPaths(
	target: string,
	vaultRoot: string | null,
): string[] {
	const norm = target.replace(/\\/g, "/").replace(/\/+$/, "");
	const rootKey = vaultRoot ? pathKey(vaultRoot) : null;
	const out: string[] = [];
	let current = norm;
	while (true) {
		const idx = current.lastIndexOf("/");
		if (idx <= 0) break;
		current = current.slice(0, idx);
		if (rootKey && pathKey(current) === rootKey) break;
		if (current) out.push(current);
	}
	return out.reverse();
}
