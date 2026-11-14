import i18n from "@/i18n";
import {
	basenameOf,
	dirnameOf,
	joinPath,
	normalizePath,
	relativePathWithin,
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
	const abs = normalizePath(absPath);
	const relative = relativePathWithin(vaultRoot, absPath);
	if (relative !== null) return relative;
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

/**
 * True when a basename carries a file extension.
 * Dotfiles (`.env`) and trailing dots count as extensionless.
 */
export function hasVaultFileExtension(name: string): boolean {
	const dot = name.lastIndexOf(".");
	return dot > 0 && dot < name.length - 1;
}

export type VaultRenamePlan = {
	/** Vault-relative path the renamed entry lands on. */
	toRel: string;
	/** True when a file becomes a folder (see {@link planVaultRename}). */
	folderize: boolean;
	/** New folder path when `folderize` is true. */
	folderRel?: string;
};

/**
 * Plan an in-tree rename.
 *
 * Renaming a file to an extensionless name turns it into a folder (#759):
 * the typed name becomes the folder and the file keeps its original
 * extension(s) inside it (`notes/foo.md` → `notes/bar/bar.md`). Folders and
 * names that carry an extension stay a plain rename.
 */
export function planVaultRename(args: {
	parentRel: string;
	currentName: string;
	nextName: string;
	kind: FileNode["kind"];
}): VaultRenamePlan {
	const { parentRel, currentName, nextName, kind } = args;
	const join = (rel: string) => (parentRel ? `${parentRel}/${rel}` : rel);
	if (kind === "directory" || hasVaultFileExtension(nextName)) {
		return { toRel: join(nextName), folderize: false };
	}
	const dot = currentName.indexOf(".");
	const suffix = dot > 0 ? currentName.slice(dot) : "";
	return {
		toRel: join(`${nextName}/${nextName}${suffix}`),
		folderize: true,
		folderRel: join(nextName),
	};
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

/** Is `parentPath` (absolute, vault-rooted) inside the `papers/` folder? */
export function isPapersParent(parentPath: string, vaultRoot: string): boolean {
	const rel = vaultRelativePath(vaultRoot, parentPath);
	if (!rel) return false;
	return rel === "papers" || rel.startsWith("papers/");
}

export { basenameOf } from "@/lib/core/path";
