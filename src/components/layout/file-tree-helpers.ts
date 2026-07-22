import {
	FileCode2,
	FileImage,
	FileJson,
	FileText,
	FileType2,
} from "lucide-react";

import {
	isPaperDirectory,
	isPapersRoot,
	paperNeedsAssetDownload,
} from "@/lib/paper-metadata";
import { LIBRARY_VIRTUAL_PATH, TRASH_VIRTUAL_PATH } from "@/lib/papers-api";
import type { FileNode } from "@/lib/vault";

export type TreeCreateKind = "file" | "folder";

export type TreeCreateDraft = {
	kind: TreeCreateKind;
	/** Absolute path of the parent directory (vault root or folder). */
	parentPath: string;
};

/** One flattened, windowable tree row in display order. */
export type FlatRow =
	| { key: string; kind: "library" }
	| { key: string; kind: "trash" }
	| { key: string; kind: "create"; depth: number }
	| {
			key: string;
			kind: "node";
			depth: number;
			node: FileNode;
			paperLeaf: boolean;
	  };

export const DOWNLOAD_REASON_KEYS = {
	noPdf: "fileTree.downloadReason.noPdf",
	noBody: "fileTree.downloadReason.noBody",
} as const;

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

export function isVirtualTreePath(path: string): boolean {
	return path === LIBRARY_VIRTUAL_PATH || path === TRASH_VIRTUAL_PATH;
}

export function fileIcon(name: string) {
	if (/\.pdf$/i.test(name)) return FileType2;
	if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(name)) return FileImage;
	if (/\.json$/i.test(name)) return FileJson;
	if (/\.(ts|tsx|js|jsx|rs|toml)$/i.test(name)) return FileCode2;
	return FileText;
}

export function pathKey(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Default open folders when a Vault is first opened:
 * expand `papers/` and its first-level children (org folders) so papers one
 * level down are visible. Deeper nesting, `notes/`, etc. stay collapsed.
 * Paper folders are never expanded (they render as leaves).
 */
export function collectDefaultExpanded(nodes: FileNode[], into: Set<string>) {
	for (const n of nodes) {
		if (n.kind !== "directory" || !isPapersRoot(n.path)) continue;
		into.add(n.path);
		for (const child of n.children ?? []) {
			if (child.kind !== "directory") continue;
			// Paper units are leaves — expanding them is a no-op for the UI.
			if (isPaperDirectory(child.path, child.children)) continue;
			into.add(child.path);
		}
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
) {
	for (const n of nodes) {
		if (n.kind !== "directory" || !isPapersRoot(n.path)) continue;
		into.add(n.path);
		return;
	}
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
