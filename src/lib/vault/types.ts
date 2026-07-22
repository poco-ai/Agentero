import { toVaultRelative } from "@/lib/wiki";

export type CreateVaultResult = {
	path: string;
	created: string[];
	openPath: string;
};

export type FileNode = {
	id: string;
	name: string;
	path: string;
	kind: "file" | "directory";
	children?: FileNode[];
	/**
	 * Directory whose children have not been listed yet (lazy tree).
	 * `true` → show as folder; load on expand. Omit / `false` when loaded
	 * (including empty dirs, which use `children: []`).
	 */
	childrenPending?: boolean;
};

/**
 * Names never listed in the file tree (local or remote).
 * Includes VCS, build/cache, virtualenvs, and Host-only `.agentero`.
 */
export const TREE_IGNORE_NAMES = new Set([
	".git",
	".DS_Store",
	"node_modules",
	"target",
	"dist",
	".agentero",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	".eggs",
	".codex",
	".idea",
	".vscode",
	"site-packages",
]);

/**
 * Vault-root segment names that are fully recursive on open (product surface).
 * Everything else at the vault root is shallow (one level) until expanded.
 */
export const TREE_EAGER_ROOT_NAMES = new Set([
	"papers",
	"notes",
	"plans",
	".agents",
]);

/**
 * Dot-directories that are still part of the product surface (not ignored).
 * Must stay in sync with {@link TREE_EAGER_ROOT_NAMES} where applicable.
 */
const TREE_ALLOWED_DOT_NAMES = new Set([".env.example", ".agents"]);

/** True when this basename should never appear in the tree. */
export function shouldIgnoreTreeName(name: string): boolean {
	if (!name) return true;
	if (TREE_IGNORE_NAMES.has(name)) return true;
	if (TREE_ALLOWED_DOT_NAMES.has(name)) return false;
	// Other hidden entries (`.git`, `.venv`, `.codex`, …).
	if (name.startsWith(".")) return true;
	// Python packaging / build noise.
	if (name.endsWith(".egg-info")) return true;
	return false;
}

/**
 * Whether a directory under the vault should be fully walked on open.
 * - Under `papers/` / `notes/` / `plans/` / `.agents/`: always eager (markers, skills).
 * - Other vault-root trees (`src/`, `thesis/`, …): shallow only until user expands.
 */
export function isEagerTreeRel(rel: string): boolean {
	const r = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!r) return true; // vault root itself is always listed
	const top = r.split("/")[0]?.toLowerCase() ?? "";
	return TREE_EAGER_ROOT_NAMES.has(top);
}

/** Join parent + name using the parent's path separator style. */
export function joinPath(parent: string, name: string): string {
	if (!parent) return name;
	const sep = parent.includes("\\") ? "\\" : "/";
	return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

/** Directories first, then case-insensitive name order. */
export function sortNodes(nodes: FileNode[]): FileNode[] {
	return [...nodes].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	});
}

/** Absolute-style path under a remote handle: `remote:<id>/papers/...` */
export function joinRemotePath(handle: string, rel: string): string {
	const r = rel.replace(/^\/+/, "").replace(/\\/g, "/");
	if (!r) return handle;
	return `${handle}/${r}`;
}

/** Vault-relative path from a remote absolute-style path. */
export function remoteRelFromJoined(handle: string, joined: string): string {
	if (joined === handle) return "";
	const prefix = `${handle}/`;
	if (joined.startsWith(prefix)) return joined.slice(prefix.length);
	return joined.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Paths of directory nodes that still need listing, among `expandedPaths`.
 * Used to load children when the user expands a lazy folder.
 */
export function pendingDirsAmongExpanded(
	nodes: FileNode[],
	expandedPaths: ReadonlySet<string>,
): string[] {
	const out: string[] = [];
	const walk = (list: FileNode[]) => {
		for (const n of list) {
			if (n.kind !== "directory") continue;
			if (n.childrenPending && expandedPaths.has(n.path)) {
				out.push(n.path);
			}
			if (n.children?.length) walk(n.children);
		}
	};
	walk(nodes);
	return out;
}

/** Immutable replace of a directory node's children (by absolute path). */
export function replaceTreeNodeChildren(
	nodes: FileNode[],
	dirPath: string,
	children: FileNode[],
): FileNode[] {
	const key = normalizePathKey(dirPath);
	const walk = (list: FileNode[]): FileNode[] =>
		list.map((n) => {
			if (normalizePathKey(n.path) === key && n.kind === "directory") {
				return {
					...n,
					children,
					childrenPending: false,
				};
			}
			if (n.children?.length) {
				return { ...n, children: walk(n.children) };
			}
			return n;
		});
	return walk(nodes);
}

/** True if any directory under `nodes` still needs listing. */
export function treeHasPendingChildren(nodes: FileNode[]): boolean {
	for (const n of nodes) {
		if (n.kind === "directory" && n.childrenPending) return true;
		if (n.children?.length && treeHasPendingChildren(n.children)) return true;
	}
	return false;
}

/**
 * Skill package ids newly written under `.agents/skills/<id>/…`
 * (from `CreateVaultResult.created`). Ignores top-level README/LICENSE.
 */
export function seededSkillIdsFromCreated(created: string[]): string[] {
	const ids = new Set<string>();
	for (const raw of created) {
		const rel = raw.replace(/\\/g, "/");
		const m = /^\.agents\/skills\/([^/]+)\//.exec(rel);
		if (m?.[1]) ids.add(m[1]);
	}
	return [...ids].sort((a, b) => a.localeCompare(b));
}

export function isMarkdownPath(path: string): boolean {
	return /\.(md|mdx|markdown)$/i.test(path);
}

export function isTextOpenable(path: string): boolean {
	return (
		isMarkdownPath(path) ||
		/\.(txt|json|bib|tex|html?|css|ts|tsx|js|jsx|rs|toml|yaml|yml)$/i.test(path)
	);
}

/** Vault-relative path from absolute path, or null if outside vault. */
export function vaultRelativePath(
	vaultRoot: string,
	absPath: string,
): string | null {
	const root = vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	const abs = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
	if (abs === root) return "";
	const prefix = `${root}/`;
	if (abs.startsWith(prefix)) return abs.slice(prefix.length);
	if (abs === "papers" || abs.startsWith("papers/")) return abs;
	return null;
}

/** Join parent + name with the parent's path separator style. */
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

// --- File-tree path helpers (unit-tested in test/vault-tree.test.ts) ---

/** Normalize an absolute path for case-insensitive equality (forward slashes, no trailing slash). */
export function normalizePathKey(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
	const parent = selectedPath.replace(/[\\/][^\\/]+$/, "");
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
	const abs = notesPath.replace(/[\\/]NOTES\.md$/i, "").replace(/\\/g, "/");
	const root = vaultPath.replace(/\\/g, "/").replace(/\/$/, "");
	if (abs === root) return "";
	if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
	return abs;
}
