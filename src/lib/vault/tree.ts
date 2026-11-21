import { commands, type VaultTreeNode_Serialize } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { toVaultRelative } from "@/lib/core/path";
import { perfOp } from "@/lib/core/perf";
import { compareNaturalName } from "@/lib/core/sort";
import { normalizePathKey } from "@/lib/vault/path";
import {
	isRemoteVaultHandle,
	remoteList,
	remoteSessionIdFromHandle,
} from "@/lib/vault/remote/remote-vault";
import { joinRemotePath, remoteRelFromJoined } from "@/lib/vault/remote-path";
import { ensureLocalFsScope } from "@/lib/vault/scope";
import type { FileNode } from "@/lib/vault/types";
import { isWikiTargetPath } from "@/lib/wiki/target-path";

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
export const TREE_EAGER_ROOT_NAMES = new Set(["papers", "notes", ".agents"]);

/**
 * Dot-directories that are still part of the product surface (not ignored).
 * Must stay in sync with {@link TREE_EAGER_ROOT_NAMES} where applicable.
 */
const TREE_ALLOWED_DOT_NAMES = new Set([".env.example", ".agents"]);

/**
 * Cloud-sync store artifacts (`blobs/`, `manifests/`, `HEAD`, `vault.json` —
 * see Host `integration/sync/engine.rs`). When a WebDAV sync target is a
 * cloud folder a desktop client mirrors back into the vault, these land at
 * the vault root. Hidden at the root only — nested same-named folders are
 * user content — mirroring the Host tree rule
 * (`agentero-core/features/vault/tree.rs`).
 */
const TREE_SYNC_STORE_ARTIFACT_NAMES = new Set([
	"blobs",
	"manifests",
	"HEAD",
	"vault.json",
]);

/** Any of these marks a directory as a paper unit whose `source/` is lazy. */
const PAPER_MARKER_FILE_NAMES = new Set(["NOTES.md", "PAPER.md"]);

/** Paper-internal directory markers (mirrors `src/lib/paper/paths.ts`). */
const PAPER_MARKER_DIR_NAMES = new Set(["source", "assets", "marks"]);

/** Paper subdirectory listed lazily (arXiv e-prints hold hundreds of files). */
const LAZY_PAPER_DIR_NAME = "source";

/**
 * App-owned rebuildable sidecars written inside a paper's `source/` bucket
 * (reference sidecar and PDF layout sidecars). They
 * are never user content, so the tree blinds itself to them — mirrors the Host
 * rule in `crates/agentero-core/src/features/vault/tree.rs` (#747).
 */
const PAPER_SOURCE_ARTIFACT_NAMES = new Set([
	"agentero-cite.json",
	"agentero-figures.json",
	"layout.json",
	"layout-index.json",
	"layout-translate.json",
]);

/** Last segment of a vault-relative path (`""` at the vault root). */
function lastRelSegment(rel: string): string {
	const trimmed = rel.replace(/^\/+|\/+$/g, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** True when a vault-relative path sits at or below `papers/`. */
function isUnderPapersRel(rel: string): boolean {
	const r = rel.replace(/^\/+|\/+$/g, "");
	return r === "papers" || r.startsWith("papers/");
}

/** Paper unit: under `papers/` and carrying a paper marker (file or dir). */
function isPaperUnitRel(
	rel: string,
	hasPaperMarkerFile: boolean,
	entries: TreeListEntry[],
): boolean {
	return (
		isUnderPapersRel(rel) &&
		(hasPaperMarkerFile ||
			entries.some((e) => e.isDir && PAPER_MARKER_DIR_NAMES.has(e.name)))
	);
}

/** One-level probe: the directory holds nothing but the app's own sidecars. */
async function isAppSidecarOnlyDir(
	adapter: TreeAdapter,
	dirPath: string,
	dirRel: string,
): Promise<boolean> {
	let entries: TreeListEntry[];
	try {
		entries = await listTreeEntries(adapter, dirPath, dirRel);
	} catch {
		return false;
	}
	let sawSidecar = false;
	for (const entry of entries) {
		if (PAPER_SOURCE_ARTIFACT_NAMES.has(entry.name)) {
			sawSidecar = true;
			continue;
		}
		if (shouldIgnoreTreeName(entry.name)) continue;
		return false;
	}
	return sawSidecar;
}

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
 * - Under `papers/` / `notes/` / `.agents/`: always eager (markers, skills).
 * - Other vault-root trees (`src/`, `thesis/`, …): shallow only until user expands.
 */
export function isEagerTreeRel(rel: string): boolean {
	const r = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!r) return true; // vault root itself is always listed
	const top = r.split("/")[0]?.toLowerCase() ?? "";
	return TREE_EAGER_ROOT_NAMES.has(top);
}

export function compareVaultTreeNodes(a: FileNode, b: FileNode): number {
	if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
	return compareNaturalName(a.name, b.name);
}

function sortNodes(nodes: FileNode[]): FileNode[] {
	return [...nodes].sort(compareVaultTreeNodes);
}

/**
 * Build directory children.
 *
 * - `shallowOnly=false` (initial open): eager roots recurse fully; other dirs
 *   are listed **once** (one level of files + subdir shells with `childrenPending`).
 * - `shallowOnly=true` (inside a non-eager tree, or expand): files only; subdirs
 *   become pending shells (no further list until expand).
 *
 * `rel` is vault-relative (`""` at root). Local uses absolute `dirPath`.
 */
type TreeListEntry = {
	name: string;
	childPath: string;
	childRel: string;
	isDir: boolean;
	isFile: boolean;
};

type TreeAdapter = {
	list(dirPath: string, rel: string): Promise<TreeListEntry[]>;
};

/**
 * True when an FS / SFTP error means the path is gone (or never existed).
 * Matches Host local tree semantics: missing dirs list as empty, not hard fail.
 */
export function isPathMissingError(error: unknown): boolean {
	const msg = errorText(error).toLowerCase();
	return (
		msg.includes("no such file") ||
		msg.includes("nosuchfile") ||
		msg.includes("not found") ||
		msg.includes("enoent") ||
		msg.includes("does not exist")
	);
}

function remoteTreeAdapter(handle: string): TreeAdapter {
	const sessionId = remoteSessionIdFromHandle(handle);
	return {
		async list(_dirPath, rel) {
			if (!sessionId) return [];
			const entries = await remoteList(sessionId, rel);
			return entries.map((e) => ({
				name: e.name,
				childPath: joinRemotePath(handle, e.path),
				childRel: e.path,
				isDir: e.isDir,
				isFile: e.isFile,
			}));
		},
	};
}

/** List via adapter; missing paths yield `[]` (local Host `read_dir` parity). */
async function listTreeEntries(
	adapter: TreeAdapter,
	dirPath: string,
	rel: string,
): Promise<TreeListEntry[]> {
	try {
		return await adapter.list(dirPath, rel);
	} catch (e) {
		if (isPathMissingError(e)) return [];
		throw e;
	}
}

async function buildTree(
	adapter: TreeAdapter,
	dirPath: string,
	rel: string,
	depth = 0,
	shallowOnly = false,
): Promise<FileNode[]> {
	if (depth > 12) return [];

	const entries = await listTreeEntries(adapter, dirPath, rel);
	const nodes: FileNode[] = [];
	const hasPaperMarker = entries.some(
		(e) => e.isFile && PAPER_MARKER_FILE_NAMES.has(e.name),
	);
	// Under `papers/` with a paper marker the folder is a paper unit: its
	// `source/` bucket keeps its current handling (lazy shell, hidden by the
	// renderer for paper rows).
	const isPaperUnit = isPaperUnitRel(rel, hasPaperMarker, entries);

	for (const entry of entries) {
		if (shouldIgnoreTreeName(entry.name)) continue;
		// Mirrored sync-store artifacts only ever sit at the vault root
		// (`rel` is the listed directory's vault-relative path).
		if (!rel && TREE_SYNC_STORE_ARTIFACT_NAMES.has(entry.name)) continue;
		// The app's own sidecars inside a paper's `source/` bucket are never
		// user content (references + PDF layout sidecars).
		if (
			lastRelSegment(rel) === LAZY_PAPER_DIR_NAME &&
			PAPER_SOURCE_ARTIFACT_NAMES.has(entry.name)
		) {
			continue;
		}

		if (entry.isDir) {
			// Paper `source/` (arXiv e-print) is listed lazily on expand.
			if (
				!shallowOnly &&
				hasPaperMarker &&
				entry.name === LAZY_PAPER_DIR_NAME
			) {
				// One-level probe so asset detection still sees TeX archives.
				const sourceEntries = await listTreeEntries(
					adapter,
					entry.childPath,
					entry.childRel,
				);
				nodes.push({
					id: entry.childPath,
					name: entry.name,
					path: entry.childPath,
					kind: "directory",
					children: [],
					childrenPending: true,
					hasTex: sourceEntries.some(
						(e) => e.isFile && /\.(tex|ltx)$/i.test(e.name),
					),
				});
				continue;
			}
			// Outside a paper unit the `source/` bucket exists only to hold the
			// app's rebuildable sidecars — skip it instead of surfacing an empty
			// folder (#747).
			if (
				entry.name === LAZY_PAPER_DIR_NAME &&
				!isPaperUnit &&
				(await isAppSidecarOnlyDir(adapter, entry.childPath, entry.childRel))
			) {
				continue;
			}
			const node = await buildDirNode(
				adapter,
				entry.childPath,
				entry.name,
				entry.childRel,
				depth,
				shallowOnly,
			);
			nodes.push(node);
		} else if (entry.isFile) {
			nodes.push({
				id: entry.childPath,
				name: entry.name,
				path: entry.childPath,
				kind: "file",
			});
		}
	}

	return sortNodes(nodes);
}

async function buildDirNode(
	adapter: TreeAdapter,
	path: string,
	name: string,
	childRel: string,
	depth: number,
	shallowOnly: boolean,
): Promise<FileNode> {
	// Already one level into a non-eager tree (or expand): do not list further.
	if (shallowOnly) {
		return {
			id: path,
			name,
			path,
			kind: "directory",
			children: [],
			childrenPending: true,
		};
	}
	if (isEagerTreeRel(childRel)) {
		const children = await buildTree(adapter, path, childRel, depth + 1, false);
		return {
			id: path,
			name,
			path,
			kind: "directory",
			children,
		};
	}
	// Non-product dir: list exactly one level; nested dirs stay pending.
	const children = await buildTree(adapter, path, childRel, depth + 1, true);
	return {
		id: path,
		name,
		path,
		kind: "directory",
		children,
		childrenPending: false,
	};
}

/** Map Host `vault_tree_build` / `vault_tree_children` nodes to `FileNode`s,
 *  sorting each level like {@link sortNodes}. */
function mapHostTreeNodes(nodes: VaultTreeNode_Serialize[]): FileNode[] {
	return sortNodes(
		nodes.map((n) => {
			const node: FileNode = {
				id: n.path,
				name: n.name,
				path: n.path,
				kind: n.kind === "directory" ? "directory" : "file",
			};
			if (n.children) node.children = mapHostTreeNodes(n.children);
			if (n.childrenPending != null) node.childrenPending = n.childrenPending;
			if (n.hasTex != null) node.hasTex = n.hasTex;
			if (n.needsSource != null) node.needsSource = n.needsSource;
			return node;
		}),
	);
}

/**
 * List one directory level only (used when expanding a lazy folder).
 * Nested directories stay `childrenPending` (expand again to go deeper).
 */
export async function listVaultDirChildren(
	rootPath: string,
	dirAbsPath: string,
): Promise<FileNode[]> {
	if (isRemoteVaultHandle(rootPath)) {
		const rel = remoteRelFromJoined(rootPath, dirAbsPath);
		// Expanding a non-eager folder: only one more level; subdirs stay pending.
		return buildTree(remoteTreeAdapter(rootPath), dirAbsPath, rel, 0, true);
	}
	// Local: single IPC; the Host applies the same eager/lazy semantics.
	const nodes = await callApiResult(() =>
		commands.vaultTreeChildren(rootPath, dirAbsPath),
	);
	return mapHostTreeNodes(nodes);
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

/**
 * Insert or replace one child under a loaded parent. Other children stay,
 * so a new paper does not re-list `papers/`.
 */
export function upsertTreeChild(
	nodes: FileNode[],
	parentPath: string,
	child: FileNode,
): FileNode[] {
	const parentKey = normalizePathKey(parentPath);
	const childKey = normalizePathKey(child.path);
	const walk = (list: FileNode[]): FileNode[] =>
		list.map((node) => {
			if (
				normalizePathKey(node.path) === parentKey &&
				node.kind === "directory"
			) {
				const children = (node.children ?? []).filter(
					(existing) => normalizePathKey(existing.path) !== childKey,
				);
				children.push(child);
				sortNodes(children);
				return { ...node, children, childrenPending: false };
			}
			if (node.children?.length) {
				return { ...node, children: walk(node.children) };
			}
			return node;
		});
	return walk(nodes);
}

export function directoryIsLoaded(nodes: FileNode[], path: string): boolean {
	const key = normalizePathKey(path);
	const walk = (list: FileNode[]): boolean => {
		for (const node of list) {
			if (normalizePathKey(node.path) === key) {
				return node.kind === "directory" && !node.childrenPending;
			}
			if (node.children?.length && walk(node.children)) return true;
		}
		return false;
	};
	return walk(nodes);
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

/**
 * Remove a node (file or directory) and any of its descendants from the tree.
 * Used after delete / when a lazy expand finds the path already gone remotely.
 */
export function removeTreeNode(
	nodes: FileNode[],
	targetPath: string,
): FileNode[] {
	const key = normalizePathKey(targetPath);
	const walk = (list: FileNode[]): FileNode[] => {
		const out: FileNode[] = [];
		for (const n of list) {
			const nKey = normalizePathKey(n.path);
			if (nKey === key || nKey.startsWith(`${key}/`)) continue;
			if (n.children?.length) {
				out.push({ ...n, children: walk(n.children) });
			} else {
				out.push(n);
			}
		}
		return out;
	};
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

/** Max targeted refreshes per debounce window before falling back to a full rebuild. */
const MAX_TREE_REFRESH_TARGETS = 8;

/**
 * Map watcher-changed absolute paths to the loaded directory nodes that need
 * re-listing (targeted refresh instead of a full tree rebuild).
 *
 * Returns `null` when a full rebuild is required (change at the vault root,
 * no loaded ancestor, or too many distinct targets). Returns `[]` when every
 * change is invisible to the tree (e.g. only ignored names).
 */
export function collectTreeRefreshTargets(
	nodes: FileNode[],
	vaultPath: string,
	changedAbsPaths: string[],
): string[] | null {
	const rootKey = normalizePathKey(vaultPath);

	// Loaded (non-pending) directory nodes, keyed for case-insensitive lookup.
	const loadedDirs = new Map<string, string>();
	const walk = (list: FileNode[]) => {
		for (const n of list) {
			if (n.kind !== "directory") continue;
			if (!n.childrenPending) loadedDirs.set(normalizePathKey(n.path), n.path);
			if (n.children?.length) walk(n.children);
		}
	};
	walk(nodes);

	const targetKeys = new Set<string>();
	for (const changed of changedAbsPaths) {
		const key = normalizePathKey(changed);
		if (key === rootKey) return null;
		if (!key.startsWith(`${rootKey}/`)) continue;
		const relSegments = key.slice(rootKey.length + 1).split("/");
		if (relSegments.some((s) => shouldIgnoreTreeName(s))) continue;

		let dirKey = key.slice(0, key.lastIndexOf("/"));
		while (dirKey.length > rootKey.length) {
			if (loadedDirs.has(dirKey)) {
				targetKeys.add(dirKey);
				break;
			}
			dirKey = dirKey.slice(0, dirKey.lastIndexOf("/"));
		}
		// Nearest loaded ancestor is the vault root: needs a full rebuild.
		if (dirKey.length <= rootKey.length) return null;
	}

	// Drop targets covered by an ancestor target whose refresh recurses (eager).
	const keys = [...targetKeys].sort((a, b) => a.length - b.length);
	const kept: string[] = [];
	for (const key of keys) {
		const covered = kept.some(
			(k) =>
				key.startsWith(`${k}/`) && isEagerTreeRel(k.slice(rootKey.length + 1)),
		);
		if (!covered) kept.push(key);
	}
	if (kept.length > MAX_TREE_REFRESH_TARGETS) return null;
	return kept.map((k) => loadedDirs.get(k) ?? k);
}

/** Flatten the loaded tree to Vault-relative internal-link targets. */
export function collectWikiTargetRelPaths(
	nodes: FileNode[],
	vaultPath: string | null,
): string[] {
	const out: string[] = [];
	const walk = (list: FileNode[]) => {
		for (const node of list) {
			if (node.kind === "directory" && node.children) {
				walk(node.children);
			} else if (node.kind === "file" && isWikiTargetPath(node.path)) {
				out.push(toVaultRelative(vaultPath, node.path));
			}
		}
	};
	walk(nodes);
	return out;
}

/**
 * Build the vault file tree.
 *
 * - Eager recursive: `papers/`, `notes/`, `.agents/`
 * - Shallow elsewhere: vault-root extras (`src/`, `thesis/`, …) appear as
 *   one level with `childrenPending`; expand via {@link listVaultDirChildren}.
 * - Ignored names ({@link TREE_IGNORE_NAMES} / dots / `*.egg-info`) are never listed.
 */
export async function loadVaultTree(rootPath: string): Promise<FileNode[]> {
	return perfOp("vault_tree_build", async () => {
		if (isRemoteVaultHandle(rootPath)) {
			return buildTree(remoteTreeAdapter(rootPath), rootPath, "");
		}
		await ensureLocalFsScope(rootPath);
		// Local: the Host walks the vault in-process and returns the tree in one IPC.
		const nodes = await callApiResult(() => commands.vaultTreeBuild(rootPath));
		return mapHostTreeNodes(nodes);
	});
}
