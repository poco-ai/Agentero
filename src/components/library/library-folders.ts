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

export type LibraryFolder = {
	name: string;
	path: string;
	paperCount: number;
	previews: { path: string; revision: string }[];
};

const MAX_FOLDER_PREVIEWS = 3;

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
	const folders = new Map<string, LibraryFolder>();
	for (const paper of scopedPapers) {
		if (!paper.path) continue;
		const path = normalizeRelPath(paper.path);
		const key = normalizeLibraryScope(path);
		papers.add(key);
		if (!key.startsWith(`${scopeKey}/`)) continue;
		const name = path.slice(scopeKey.length + 1).split("/")[0];
		if (name && dirnameOf(key) !== scopeKey) {
			const parent = `${scope}/${name}`;
			const folderKey = normalizeLibraryScope(parent);
			let folder = folders.get(folderKey);
			if (!folder) {
				folder = { name, path: parent, paperCount: 0, previews: [] };
				folders.set(folderKey, folder);
			}
			folder.paperCount += 1;
			if (
				paper.has_pdf !== false &&
				folder.previews.length < MAX_FOLDER_PREVIEWS
			) {
				folder.previews.push({ path, revision: paper.updated_at });
			}
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
		const folder = folders.get(key);
		folders.set(key, {
			name: basenameOf(path),
			path,
			paperCount: folder?.paperCount ?? 0,
			previews: folder?.previews ?? [],
		});
	}
	return [...folders.values()]
		.filter(({ path }) => !papers.has(normalizeLibraryScope(path)))
		.sort((left, right) => compareNaturalName(left.name, right.name));
}
