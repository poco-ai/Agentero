import { normalizePath } from "@/lib/core/path";
import {
	isPaperInternalDirName,
	isPapersRoot,
	isUnderPapers,
	notesPathForPaper,
} from "@/lib/paper/paths";
import { vaultPathExists } from "@/lib/vault/fs";
import { treeFindNode } from "@/lib/vault/path";
import type { FileNode } from "@/lib/vault/types";

type NameKind = {
	name: string;
	kind?: "file" | "directory" | string;
	children?: NameKind[];
};

const PAPER_FILE_MARKERS = new Set(["notes.md", "paper.md"]);
const PAPER_DIR_MARKERS = new Set(["source", "assets", "marks"]);

function isDirectoryEntry(entry: NameKind): boolean {
	const lower = entry.name.toLowerCase();
	return (
		entry.kind === "directory" ||
		(!entry.kind &&
			(PAPER_DIR_MARKERS.has(lower) || isPaperInternalDirName(lower)))
	);
}

/**
 * An index/overview note may live beside nested paper folders. Treat the
 * nearest paper-like descendants as leaves and keep their parents as org dirs.
 * Internal paper dirs are skipped because they can contain arbitrary assets.
 */
function hasNestedPaperDirectory(children: NameKind[]): boolean {
	return children.some((child) => {
		if (!isDirectoryEntry(child)) return false;
		const lower = child.name.toLowerCase();
		if (isPaperInternalDirName(lower)) return false;
		if (child.children?.length && directoryHasPaperMarkers(child.children)) {
			return true;
		}
		return Boolean(
			child.children?.length && hasNestedPaperDirectory(child.children),
		);
	});
}

export function resolvePapersParentDir(
	vaultRoot: string | null,
	selectedPath: string | null,
	tree: FileNode[],
): string {
	const papersRel = "papers";
	if (!vaultRoot) return papersRel;

	const rootNorm = normalizePath(vaultRoot);
	const toRel = (abs: string): string => {
		const n = normalizePath(abs);
		if (n === rootNorm) return "";
		const prefix = `${rootNorm}/`;
		if (n.startsWith(prefix)) return n.slice(prefix.length);
		// Already vault-relative?
		if (n === "papers" || n.startsWith("papers/")) return n;
		return n;
	};

	const paperFolders = collectPaperFoldersFromTree(tree);
	if (!selectedPath) return papersRel;

	const paperRoot = paperDirFromPath(selectedPath, paperFolders);
	if (paperRoot) {
		const parentAbs = paperRoot.replace(/[\\/][^\\/]+$/, "");
		const rel = toRel(parentAbs);
		if (
			!rel ||
			rel === "papers" ||
			isPapersRoot(rel) ||
			isPapersRoot(parentAbs)
		) {
			return papersRel;
		}
		if (rel.startsWith("papers/") || isUnderPapers(parentAbs)) {
			return rel.replace(/\\/g, "/");
		}
		return papersRel;
	}

	const node = treeFindNode(tree, selectedPath);
	if (node?.kind === "directory") {
		const rel = toRel(selectedPath);
		if (isPapersRoot(selectedPath) || rel === "papers" || isPapersRoot(rel)) {
			return papersRel;
		}
		if (isUnderPapers(selectedPath) || rel.startsWith("papers/")) {
			return rel.replace(/\\/g, "/");
		}
	} else {
		const parentAbs = selectedPath.replace(/[\\/][^\\/]+$/, "");
		if (parentAbs && parentAbs !== selectedPath) {
			const rel = toRel(parentAbs);
			if (isPapersRoot(parentAbs) || rel === "papers") return papersRel;
			if (isUnderPapers(parentAbs) || rel.startsWith("papers/")) {
				return rel.replace(/\\/g, "/");
			}
		}
	}

	return papersRel;
}

/**
 * Whether direct children indicate a paper folder (minimal unit).
 *
 * `NOTES.md` remains a legacy-compatible marker, but an organization folder
 * containing nested paper folders wins over its own index/overview note.
 */
export function directoryHasPaperMarkers(
	children: NameKind[] | undefined | null,
): boolean {
	if (!children?.length) return false;
	let hasDirectMarker = false;
	for (const c of children) {
		const name = c.name;
		const lower = name.toLowerCase();
		if (PAPER_FILE_MARKERS.has(lower)) hasDirectMarker = true;
		if (isDirectoryEntry(c) && PAPER_DIR_MARKERS.has(lower)) {
			hasDirectMarker = true;
		}
	}
	return hasDirectMarker && !hasNestedPaperDirectory(children);
}

/**
 * True when `path` is a paper folder (minimal unit under `papers/`).
 * Prefer passing `children` from the file tree so nested org folders are not treated as papers.
 * Path-only: returns false for bare directories (use markers or `paperDirFromPath` for files).
 */
export function isPaperDirectory(
	path: string | null,
	children?: NameKind[] | null,
): boolean {
	if (!path || !isUnderPapers(path)) return false;
	if (children !== undefined && children !== null) {
		return directoryHasPaperMarkers(children);
	}
	return false;
}

/**
 * Extract the paper folder path from any file/dir path under that paper.
 * Supports nested layout: `…/papers/topic/1706.03762/NOTES.md` → `…/papers/topic/1706.03762`.
 *
 * Uses path structure (known internal files / source|assets), not a single path segment.
 * Optional `paperFolders` (sorted vault-relative or absolute paper roots) picks the longest matching prefix.
 */
export function paperDirFromPath(
	path: string | null,
	paperFolders?: string[] | null,
): string | null {
	if (!path || !isUnderPapers(path)) return null;
	const norm = normalizePath(path);

	if (paperFolders?.length) {
		const folders = [...paperFolders]
			.map(normalizePath)
			.filter(Boolean)
			.sort((a, b) => b.length - a.length);
		for (const folder of folders) {
			if (norm === folder || norm.startsWith(`${folder}/`)) {
				return folder;
			}
		}
		// Once the tree has produced a non-empty paper list, it is authoritative
		// for path ownership. Do not reclassify an org-level NOTES.md via the
		// legacy filename fallback below.
		return null;
	}

	// Known paper-root files → parent is paper folder
	const fileMarker = /\/(NOTES\.md|PAPER\.md|metadata\.json)$/i;
	if (fileMarker.test(norm)) {
		return norm.replace(fileMarker, "") || null;
	}

	// …/source|assets|marks/… → paper is parent of that segment
	const nestedAsset = norm.match(
		/^(.*\/papers\/.+?)\/(source|assets|marks|attachments)(?:\/|$)/i,
	);
	if (nestedAsset?.[1]) {
		return nestedAsset[1];
	}
	// Vault-relative without leading drive: papers/…/source|marks|attachments/…
	const nestedAssetRel = norm.match(
		/^(papers\/.+?)\/(source|assets|marks|attachments)(?:\/|$)/i,
	);
	if (nestedAssetRel?.[1]) {
		return nestedAssetRel[1];
	}

	// Main / loose files sitting on the paper root (e.g. `papers/vla/id/id.pdf`).
	// Parent of that file is the paper folder.
	const rootFileAbs = norm.match(/^(.*\/papers\/.+?)\/([^/]+\.[^/]+)$/i);
	if (rootFileAbs?.[1]) {
		return rootFileAbs[1];
	}
	const rootFileRel = norm.match(/^(papers\/.+?)\/([^/]+\.[^/]+)$/i);
	if (rootFileRel?.[1]) {
		return rootFileRel[1];
	}

	// Path is a directory under papers with no further hint → not enough to claim paper unit
	return null;
}

/**
 * Collect paper folder paths from a file tree (any depth under `papers/`).
 */
export function collectPaperFoldersFromTree(
	nodes: Array<{
		path: string;
		kind: "file" | "directory";
		children?: unknown[];
		name?: string;
	}>,
): string[] {
	const out: string[] = [];
	const walk = (
		list: Array<{
			path: string;
			kind: "file" | "directory";
			children?: Array<{
				path: string;
				kind: "file" | "directory";
				name: string;
				children?: unknown[];
			}>;
			name?: string;
		}>,
	) => {
		for (const n of list) {
			if (n.kind === "directory") {
				const children = n.children as
					| Array<{ name: string; kind: "file" | "directory" }>
					| undefined;
				if (isUnderPapers(n.path) && directoryHasPaperMarkers(children)) {
					out.push(normalizePath(n.path));
					// Do not walk into paper internals for nested papers
					continue;
				}
				if (n.children?.length) {
					walk(
						n.children as Array<{
							path: string;
							kind: "file" | "directory";
							children?: Array<{
								path: string;
								kind: "file" | "directory";
								name: string;
								children?: unknown[];
							}>;
							name?: string;
						}>,
					);
				}
			}
		}
	};
	walk(
		nodes as Array<{
			path: string;
			kind: "file" | "directory";
			children?: Array<{
				path: string;
				kind: "file" | "directory";
				name: string;
				children?: unknown[];
			}>;
			name?: string;
		}>,
	);
	return out;
}

export async function detectPaperDirectory(path: string): Promise<boolean> {
	if (!isUnderPapers(path) || isPapersRoot(path)) return false;
	const notesPath = notesPathForPaper(path);
	return (
		(await vaultPathExists(notesPath).catch(() => false)) ||
		vaultPathExists(notesPath.replace(/NOTES\.md$/i, "PAPER.md")).catch(
			() => false,
		)
	);
}

/**
 * How paper folders are labeled in the file tree (Settings → General).
 * Disk folder names stay unchanged; this is display-only.
 */
