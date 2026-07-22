import type { PaperDownloadReason } from "@/lib/paper-metadata/types";
import type { FileNode } from "@/lib/vault";

const PDF_NAME_RE = /\.pdf$/i;
const TEX_NAME_RE = /\.(tex|ltx)$/i;
const PAPER_MD_RE = /^paper\.md$/i;

type TreeWalkNode = {
	name: string;
	kind?: string;
	path?: string;
	children?: Array<{
		name: string;
		kind?: string;
		path?: string;
		children?: unknown[];
	}>;
};

/** Walk tree node names for a matching extension. */
function treeHasFileExt(node: TreeWalkNode, re: RegExp): boolean {
	if (node.kind !== "directory" && re.test(node.name)) return true;
	for (const child of node.children ?? []) {
		if (treeHasFileExt(child as TreeWalkNode, re)) return true;
	}
	return false;
}

export function paperHasLocalPdf(node: TreeWalkNode): boolean {
	return treeHasFileExt(node, PDF_NAME_RE);
}

export function paperHasLocalTex(node: TreeWalkNode): boolean {
	return treeHasFileExt(node, TEX_NAME_RE);
}

/** True when the paper folder has a direct-child `PAPER.md` (any depth name match). */
export function paperHasLocalPaperMd(node: TreeWalkNode): boolean {
	if (node.kind !== "directory" && PAPER_MD_RE.test(node.name)) return true;
	for (const child of node.children ?? []) {
		if (paperHasLocalPaperMd(child as TreeWalkNode)) return true;
	}
	return false;
}

/** True when paper folder has a direct child directory named `source`. */
export function paperHasLocalSourceDir(node: TreeWalkNode): boolean {
	for (const child of node.children ?? []) {
		if (
			(child.kind === "directory" || !child.kind) &&
			/^source$/i.test(child.name)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Missing local assets that warrant a Download control:
 * - no PDF (at paper folder root or nested), or
 * - no TeX **and** no `PAPER.md` (either body form is sufficient; TeX preferred)
 *
 * Click: download PDF to paper folder root; arXiv TeX into `source/`; if no TeX → liteparse PAPER.md.
 * Note: `source/` is only required for TeX archives — PDF alone does not require `source/`.
 */
export function paperAssetDownloadReasons(
	node: TreeWalkNode,
): PaperDownloadReason[] {
	const reasons: PaperDownloadReason[] = [];
	if (!paperHasLocalPdf(node)) reasons.push("noPdf");
	// Body: TeX wins; only flag when neither TeX nor PAPER.md exists
	if (!paperHasLocalTex(node) && !paperHasLocalPaperMd(node)) {
		reasons.push("noBody");
	}
	return reasons;
}

/** Show file-tree Download when PDF / source / readable body is incomplete. */
export function paperNeedsAssetDownload(node: TreeWalkNode): boolean {
	return paperAssetDownloadReasons(node).length > 0;
}

/**
 * Local assets are complete enough for reading / paper-reader:
 * PDF present, and TeX or PAPER.md as readable body.
 */
export function paperAssetsComplete(node: TreeWalkNode): boolean {
	return paperAssetDownloadReasons(node).length === 0;
}

/**
 * Show file-tree Zap when assets are complete and catalog says not yet read.
 */
export function paperNeedsRead(
	node: TreeWalkNode,
	meta: { is_read?: boolean } | null | undefined,
): boolean {
	if (!paperAssetsComplete(node)) return false;
	return !(meta?.is_read === true);
}

/** Folder-name heuristic: looks like bare arXiv id. */
export function folderNameLooksLikeArxivId(name: string): boolean {
	return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(
		name.trim(),
	);
}

type NameKind = { name: string; kind?: "file" | "directory" | string };

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True when path is the `papers` directory itself (Vault-relative or absolute). */
export function isPapersRoot(path: string | null): boolean {
	if (!path) return false;
	const norm = normalizePath(path);
	return /(^|\/)papers$/i.test(norm);
}

/**
 * True when path is somewhere under a `papers` root (not the root itself).
 * Absolute: `…/papers/…` ; Vault-relative: `papers/…`.
 */
export function isUnderPapers(path: string | null): boolean {
	if (!path || isPapersRoot(path)) return false;
	const norm = normalizePath(path);
	return /(^|\/)papers\//i.test(norm);
}

/**
 * Vault-relative parent for magic-wand import: `papers` or `papers/<org>/…`.
 * Never returns a paper folder itself (uses parent of paper when selection is inside one).
 *
 * @see docs/backend/identifier-lookup.md §1.2
 */
export function resolvePapersParentDir(
	vaultRoot: string | null,
	selectedPath: string | null,
	tree: Array<{
		path: string;
		kind: "file" | "directory";
		children?: Array<{
			path: string;
			kind: "file" | "directory";
			name: string;
			children?: unknown[];
		}>;
	}>,
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

	const findNode = (
		nodes: typeof tree,
		absPath: string,
	): (typeof tree)[0] | null => {
		const key = normalizePath(absPath).toLowerCase();
		for (const n of nodes) {
			if (normalizePath(n.path).toLowerCase() === key) return n;
			if (n.children?.length) {
				const hit = findNode(n.children as typeof tree, absPath);
				if (hit) return hit;
			}
		}
		return null;
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

	const node = findNode(tree, selectedPath);
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

/** Whether direct children indicate a paper folder (minimal unit). */
export function directoryHasPaperMarkers(
	children: NameKind[] | undefined | null,
): boolean {
	if (!children?.length) return false;
	for (const c of children) {
		const name = c.name;
		const lower = name.toLowerCase();
		if (
			lower === "notes.md" ||
			lower === "paper.md" ||
			lower === "metadata.json"
		) {
			return true;
		}
		const isDir =
			c.kind === "directory" ||
			// name-only lists: treat known dir markers as dirs
			(!c.kind &&
				(lower === "source" || lower === "assets" || lower === "marks"));
		if (
			isDir &&
			(lower === "source" || lower === "assets" || lower === "marks")
		) {
			return true;
		}
	}
	return false;
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
	}

	// Known paper-root files → parent is paper folder
	const fileMarker = /\/(NOTES\.md|PAPER\.md|metadata\.json)$/i;
	if (fileMarker.test(norm)) {
		return norm.replace(fileMarker, "") || null;
	}

	// …/source|assets|marks/… → paper is parent of that segment
	const nestedAsset = norm.match(
		/^(.*\/papers\/.+?)\/(source|assets|marks)(?:\/|$)/i,
	);
	if (nestedAsset?.[1]) {
		return nestedAsset[1];
	}
	// Vault-relative without leading drive: papers/…/source|marks/…
	const nestedAssetRel = norm.match(
		/^(papers\/.+?)\/(source|assets|marks)(?:\/|$)/i,
	);
	if (nestedAssetRel?.[1]) {
		return nestedAssetRel[1];
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

/** Paper folders (at any depth) that still need an asset download, by path. */
export function collectPapersNeedingAssetDownload(nodes: FileNode[]): string[] {
	const out: string[] = [];
	const walk = (list: FileNode[]) => {
		for (const n of list) {
			if (n.kind === "directory" && isPaperDirectory(n.path, n.children)) {
				if (paperNeedsAssetDownload(n)) out.push(n.path);
			} else if (n.children?.length) {
				walk(n.children);
			}
		}
	};
	walk(nodes);
	return out;
}

export function metadataPathForPaper(paperDir: string): string {
	const sep = paperDir.endsWith("/") ? "" : "/";
	return `${paperDir}${sep}metadata.json`;
}

/** `<paperDir>/NOTES.md` — structured notes for the paper. */
export function notesPathForPaper(paperDir: string): string {
	const sep = paperDir.endsWith("/") ? "" : "/";
	return `${paperDir}${sep}NOTES.md`;
}
