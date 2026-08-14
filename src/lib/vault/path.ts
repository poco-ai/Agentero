import i18n from "@/i18n";
import {
	basenameOf,
	dirnameOf,
	joinPath,
	normalizePath,
	toVaultRelative,
} from "@/lib/core/path";
import { isMarkdownPath } from "@/lib/vault/fs";
import {
	getRemoteSessionMeta,
	isRemoteVaultHandle,
} from "@/lib/vault/remote/remote-vault";
import type { FileNode } from "@/lib/vault/types";

export function vaultRelativePath(
	vaultRoot: string,
	absPath: string,
): string | null {
	const root = normalizePath(vaultRoot);
	const abs = normalizePath(absPath);
	if (abs === root) return "";
	const prefix = `${root}/`;
	if (abs.startsWith(prefix)) return abs.slice(prefix.length);
	if (abs === "papers" || abs.startsWith("papers/")) return abs;
	return null;
}

/**
 * Join vault root (or any parent abs path) with a vault-relative child.
 * Preserves Windows backslash roots so fs opens stay valid (see joinPath).
 */
export function joinVaultPath(parent: string, name: string): string {
	return joinPath(parent, name);
}

/** True if name is a single path segment (no separators / traversal). */
export function isValidVaultEntryName(name: string): boolean {
	const trimmed = name.trim();
	if (!trimmed) return false;
	if (trimmed === "." || trimmed === "..") return false;
	if (/[\\/]/.test(trimmed)) return false;
	return true;
}

export function vaultDisplayName(rootPath: string | null): string {
	if (!rootPath) return i18n.t("app:vault.noVaultName");
	if (isRemoteVaultHandle(rootPath)) {
		const meta = getRemoteSessionMeta();
		if (meta?.displayName) return meta.displayName;
		return rootPath;
	}
	return basenameOf(rootPath) || rootPath;
}

// --- File-tree path helpers (unit-tested in test/vault-tree.test.ts) ---

/** Normalize an absolute path for case-insensitive equality (forward slashes, no trailing slash). */
export function normalizePathKey(path: string): string {
	return normalizePath(path).toLowerCase();
}

/** Find a tree node by absolute path (case-insensitive, separator-agnostic). */
export function treeFindNode(
	nodes: FileNode[],
	path: string,
): FileNode | undefined {
	const key = normalizePathKey(path);
	const walk = (list: FileNode[]): FileNode | undefined => {
		for (const n of list) {
			if (normalizePathKey(n.path) === key) return n;
			if (n.children?.length) {
				const hit = walk(n.children);
				if (hit) return hit;
			}
		}
		return undefined;
	};
	return walk(nodes);
}

/** Parent dir for a new file/folder: selected folder, or parent of selected file, else vault root. */
export function resolveCreateParent(
	vaultRoot: string,
	selectedPath: string | null,
	tree: FileNode[],
): string {
	if (!selectedPath) return vaultRoot;
	const node = treeFindNode(tree, selectedPath);
	if (node?.kind === "directory") return selectedPath;
	const parent = dirnameOf(selectedPath);
	return parent && parent !== selectedPath ? parent : vaultRoot;
}

/** Flatten the tree to vault-relative Markdown paths (for wikilink resolution). */
export function collectMarkdownRelPaths(
	nodes: FileNode[],
	vaultPath: string | null,
): string[] {
	const out: string[] = [];
	const walk = (list: FileNode[]) => {
		for (const n of list) {
			if (n.kind === "directory" && n.children) walk(n.children);
			else if (n.kind === "file" && isMarkdownPath(n.path)) {
				out.push(toVaultRelative(vaultPath, n.path));
			}
		}
	};
	walk(nodes);
	return out;
}

/** Files the defense snapshot pipeline can fingerprint and expose to ACP workers. */
export function collectDefenseMaterialRelPaths(
	nodes: FileNode[],
	vaultPath: string | null,
): string[] {
	const supported =
		/\.(md|mdx|markdown|txt|rst|org|pdf|tex|ltx|bib|bbl|png|jpe?g|webp|gif|bmp|tiff?|svg|csv|tsv|jsonl?|ya?ml|xml|parquet|arrow|npy|npz)$/i;
	const out: string[] = [];
	const walk = (list: FileNode[]) => {
		for (const node of list) {
			if (node.kind === "directory") {
				if (node.children) walk(node.children);
			} else if (supported.test(node.path)) {
				out.push(toVaultRelative(vaultPath, node.path));
			}
		}
	};
	walk(nodes);
	return out;
}

/**
 * Flatten the tree to vault-relative **directory** paths
 * (Agent composer context chips / drop targets use this for folder icons).
 */
export function collectDirectoryRelPaths(
	nodes: FileNode[],
	vaultPath: string | null,
): string[] {
	const out: string[] = [];
	const walk = (list: FileNode[]) => {
		for (const n of list) {
			if (n.kind !== "directory") continue;
			out.push(toVaultRelative(vaultPath, n.path));
			if (n.children) walk(n.children);
		}
	};
	walk(nodes);
	return out;
}

/** Vault-relative paper folder path derived from a `.../NOTES.md` absolute path. */
export function paperRelFromNotes(
	notesPath: string | null,
	vaultPath: string | null,
): string | null {
	if (!notesPath || !vaultPath) return null;
	const abs = normalizePath(notesPath.replace(/[\\/]NOTES\.md$/i, ""));
	const root = normalizePath(vaultPath);
	if (abs === root) return "";
	if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
	return abs;
}

export { basenameOf } from "@/lib/core/path";
