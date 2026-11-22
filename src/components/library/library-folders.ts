import { basenameOf, dirnameOf, normalizeRelPath } from "@/lib/core/path";
import { compareNaturalName } from "@/lib/core/sort";
import type { PaperLibraryRow } from "@/lib/paper";
import {
	normalizeLibraryScope,
	resolveLibraryScopePath,
} from "@/lib/paper/api";
import { isPaperDirectory } from "@/lib/paper/detect";
import {
	joinVaultPath,
	treeFindNode,
	vaultRelativePath,
} from "@/lib/vault/path";
import type { FileNode } from "@/lib/vault/types";

export function libraryBreadcrumbs(scopePath: string | null) {
	const segments = (resolveLibraryScopePath(scopePath) ?? "papers").split("/");
	return segments.slice(1).map((name, index) => ({
		name,
		path: segments.slice(0, index + 2).join("/"),
	}));
}

export function paperIsInLibraryFolder(
	path: string | null | undefined,
	scopePath: string | null,
) {
	if (!path) return !scopePath || normalizeLibraryScope(scopePath) === "papers";
	return (
		dirnameOf(normalizeLibraryScope(path)) ===
		normalizeLibraryScope(scopePath ?? "papers")
	);
}

export function libraryChildFolders(
	tree: FileNode[],
	vaultPath: string,
	scopePath: string | null,
	scopedPapers: PaperLibraryRow[],
) {
	const scope = scopePath ?? "papers";
	const scopeKey = normalizeLibraryScope(scope);
	const papers = new Set<string>();
	const folders = new Map<string, { name: string; path: string }>();
	for (const paper of scopedPapers) {
		if (!paper.path) continue;
		const path = normalizeRelPath(paper.path);
		const key = normalizeLibraryScope(path);
		papers.add(key);
		if (!key.startsWith(`${scopeKey}/`)) continue;
		const name = path.slice(scopeKey.length + 1).split("/")[0];
		if (name && dirnameOf(key) !== scopeKey) {
			const parent = `${scope}/${name}`;
			folders.set(normalizeLibraryScope(parent), { name, path: parent });
		}
	}
	const node = treeFindNode(tree, joinVaultPath(vaultPath, scope));
	for (const child of node?.children ?? []) {
		if (child.kind !== "directory") continue;
		const path = vaultRelativePath(vaultPath, child.path);
		if (!path) continue;
		const key = normalizeLibraryScope(path);
		if (isPaperDirectory(child.path, child.children)) {
			folders.delete(key);
			continue;
		}
		folders.set(key, { name: basenameOf(path), path });
	}
	return [...folders.values()]
		.filter(({ path }) => !papers.has(normalizeLibraryScope(path)))
		.sort((left, right) => compareNaturalName(left.name, right.name));
}
