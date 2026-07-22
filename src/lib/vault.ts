import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";

import i18n from "@/i18n";
import { ipc } from "@/lib/ipc";
import {
	getRemoteSessionMeta,
	isRemoteVaultHandle,
	parseRemoteJoinedPath,
	remoteEnsureVault,
	remoteList,
	remoteMkdir,
	remoteReadText,
	remoteRemove,
	remoteSessionIdFromHandle,
	remoteWriteBytes,
	remoteWriteText,
} from "@/lib/remote-vault";
import { isTauri } from "@/lib/tauri";
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

/** Per-window vault (sessionStorage — isolated across ⌘N windows). */
const SESSION_VAULT_KEY = "agentero-vault-path";
/** Last opened vault for “restore last vault” on the primary window. */
const LAST_VAULT_KEY = "agentero-vault-path";
/** MRU list for welcome screen (localStorage, shared). */
const RECENT_VAULTS_KEY = "agentero-recent-vaults";
const MAX_RECENT_VAULTS = 8;

/** True when this window was opened via ⌘N / New Window (`?fresh=1`). */
export function isFreshWindow(): boolean {
	try {
		return new URLSearchParams(window.location.search).get("fresh") === "1";
	} catch {
		return false;
	}
}

export function getSessionVaultPath(): string | null {
	try {
		return sessionStorage.getItem(SESSION_VAULT_KEY);
	} catch {
		return null;
	}
}

/**
 * Remote vault handles (`remote:<sessionId>`) are ephemeral: a new UUID is
 * issued on every SSH connect. They must not pollute the durable "recent local
 * vaults" list or "restore last vault" — remote recents live in
 * `agentero-recent-remote-vaults` (host + remotePath).
 */
function isEphemeralRemoteHandle(path: string): boolean {
	return path.startsWith("remote:");
}

/** Last vault path (localStorage) — used when restore-last is enabled. */
export function getLastVaultPath(): string | null {
	try {
		const last = localStorage.getItem(LAST_VAULT_KEY);
		// Drop stale remote handles left by older builds (session no longer exists).
		if (last && isEphemeralRemoteHandle(last)) return null;
		return last;
	} catch {
		return null;
	}
}

/**
 * Resolve initial vault for this window:
 * 1. Session path if already chosen in this window
 * 2. Never auto-open on fresh (⌘N) windows
 * 3. Otherwise last vault when caller enables restore
 */
export function getSavedVaultPath(opts?: {
	allowRestore?: boolean;
}): string | null {
	const session = getSessionVaultPath();
	// Keep whatever this window already opened (incl. live `remote:<id>` handle).
	if (session) return session;
	if (isFreshWindow()) return null;
	if (opts?.allowRestore === false) return null;
	// Cross-launch restore: local path only (remote needs SSH re-connect).
	return getLastVaultPath();
}

export function getRecentVaults(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_VAULTS_KEY);
		if (!raw) {
			// Migrate single last-vault into recents once.
			const last = getLastVaultPath();
			return last ? [last] : [];
		}
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		const list = parsed.filter(
			(p): p is string =>
				typeof p === "string" && p.length > 0 && !isEphemeralRemoteHandle(p),
		);
		// Self-heal: strip remote handles written by older builds.
		if (list.length !== parsed.length) {
			try {
				localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(list));
			} catch {
				// ignore
			}
		}
		return list;
	} catch {
		return [];
	}
}

export function rememberRecentVault(path: string): void {
	const normalized = path.replace(/[\\/]+$/, "");
	if (!normalized || isEphemeralRemoteHandle(normalized)) return;
	try {
		const next = [
			normalized,
			...getRecentVaults().filter(
				(p) => p.replace(/[\\/]+$/, "") !== normalized,
			),
		].slice(0, MAX_RECENT_VAULTS);
		localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(next));
	} catch {
		// ignore
	}
}

export function removeRecentVault(path: string): void {
	const normalized = path.replace(/[\\/]+$/, "");
	try {
		const next = getRecentVaults().filter(
			(p) => p.replace(/[\\/]+$/, "") !== normalized,
		);
		localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(next));
	} catch {
		// ignore
	}
}

export function saveVaultPath(path: string | null): void {
	try {
		if (path) {
			// Always keep window-session binding (local path or live remote handle).
			sessionStorage.setItem(SESSION_VAULT_KEY, path);
			// Durable "last / recent local" only for real filesystem roots.
			if (!isEphemeralRemoteHandle(path)) {
				localStorage.setItem(LAST_VAULT_KEY, path);
				rememberRecentVault(path);
			}
		} else {
			sessionStorage.removeItem(SESSION_VAULT_KEY);
		}
	} catch {
		// ignore quota / private mode
	}
}

/** Open a new Agentero window without restoring a vault (desktop only). */
export async function openNewWindow(): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.openDesktopOnly"));
	}
	await ipc<null>("window_new");
}

function joinPath(parent: string, name: string): string {
	if (!parent) return name;
	const sep = parent.includes("\\") ? "\\" : "/";
	return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

function sortNodes(nodes: FileNode[]): FileNode[] {
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
 * Build directory children.
 *
 * - `shallowOnly=false` (initial open): eager roots recurse fully; other dirs
 *   are listed **once** (one level of files + subdir shells with `childrenPending`).
 * - `shallowOnly=true` (inside a non-eager tree, or expand): files only; subdirs
 *   become pending shells (no further list until expand).
 *
 * `rel` is vault-relative (`""` at root). Local uses absolute `dirPath`.
 */
async function buildTreeLocal(
	dirPath: string,
	rel: string,
	depth = 0,
	shallowOnly = false,
): Promise<FileNode[]> {
	if (depth > 12) return [];

	const entries = await readDir(dirPath);
	const nodes: FileNode[] = [];

	for (const entry of entries) {
		if (!entry.name || shouldIgnoreTreeName(entry.name)) continue;

		const path = joinPath(dirPath, entry.name);
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory) {
			const node = await buildDirNodeLocal(
				path,
				entry.name,
				childRel,
				depth,
				shallowOnly,
			);
			nodes.push(node);
		} else if (entry.isFile) {
			nodes.push({
				id: path,
				name: entry.name,
				path,
				kind: "file",
			});
		}
	}

	return sortNodes(nodes);
}

async function buildDirNodeLocal(
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
		const children = await buildTreeLocal(path, childRel, depth + 1, false);
		return {
			id: path,
			name,
			path,
			kind: "directory",
			children,
		};
	}
	// Non-product dir: list exactly one level; nested dirs stay pending.
	const children = await buildTreeLocal(path, childRel, depth + 1, true);
	return {
		id: path,
		name,
		path,
		kind: "directory",
		children,
		childrenPending: false,
	};
}

async function buildTreeRemote(
	handle: string,
	rel: string,
	depth = 0,
	shallowOnly = false,
): Promise<FileNode[]> {
	if (depth > 12) return [];
	const sessionId = remoteSessionIdFromHandle(handle);
	if (!sessionId) return [];

	const entries = await remoteList(sessionId, rel);
	const nodes: FileNode[] = [];

	for (const entry of entries) {
		if (!entry.name || shouldIgnoreTreeName(entry.name)) continue;

		const childRel = entry.path;
		const path = joinRemotePath(handle, childRel);
		if (entry.isDir) {
			const node = await buildDirNodeRemote(
				handle,
				path,
				entry.name,
				childRel,
				depth,
				shallowOnly,
			);
			nodes.push(node);
		} else if (entry.isFile) {
			nodes.push({
				id: path,
				name: entry.name,
				path,
				kind: "file",
			});
		}
	}

	return sortNodes(nodes);
}

async function buildDirNodeRemote(
	handle: string,
	path: string,
	name: string,
	childRel: string,
	depth: number,
	shallowOnly: boolean,
): Promise<FileNode> {
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
		const children = await buildTreeRemote(handle, childRel, depth + 1, false);
		return {
			id: path,
			name,
			path,
			kind: "directory",
			children,
		};
	}
	const children = await buildTreeRemote(handle, childRel, depth + 1, true);
	return {
		id: path,
		name,
		path,
		kind: "directory",
		children,
		childrenPending: false,
	};
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
		const sessionId = remoteSessionIdFromHandle(rootPath);
		if (!sessionId) return [];
		const rel = remoteRelFromJoined(rootPath, dirAbsPath);
		// Expanding a non-eager folder: only one more level; subdirs stay pending.
		return buildTreeRemote(rootPath, rel, 0, true);
	}
	// Local: dirAbsPath is absolute; rel only used for eager checks (disabled here).
	return buildTreeLocal(dirAbsPath, "", 0, true);
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

export async function pickVaultDirectory(): Promise<string | null> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.openDesktopOnly"));
	}

	const selected = await open({
		directory: true,
		multiple: false,
		title: i18n.t("app:vault.dialogTitle"),
	});

	if (selected === null) return null;
	const path = Array.isArray(selected) ? selected[0] : selected;
	return path ?? null;
}

/** Pick a directory that will be scaffolded as a new Agentero vault. */
export async function pickCreateVaultDirectory(): Promise<string | null> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.createDesktopOnly"));
	}

	const selected = await open({
		directory: true,
		multiple: false,
		title: i18n.t("app:vault.createDialogTitle"),
	});

	if (selected === null) return null;
	const path = Array.isArray(selected) ? selected[0] : selected;
	return path ?? null;
}

/**
 * Scaffold a Agentero vault at `path` (Host: vault_create).
 * Creates papers/notes/plans/.agentero, AGENTS.md, catalog.sqlite.
 * Does not create PAPERS.md / library.bib. Does not overwrite existing files.
 */
export async function createVault(path: string): Promise<CreateVaultResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.createDesktopOnly"));
	}

	const { logOp } = await import("@/lib/logger");
	return logOp("createVault", { path }, () =>
		ipc<CreateVaultResult>("vault_create", { path }),
	);
}

/**
 * Idempotent ensure for an open vault (Host: vault_ensure).
 * Seeds any **missing** bundled skills under `.agents/skills/` after app updates;
 * never overwrites user-edited skill files. Safe to call on every open.
 */
export async function ensureVault(path: string): Promise<CreateVaultResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.createDesktopOnly"));
	}

	const { logOp } = await import("@/lib/logger");
	return logOp("ensureVault", { path }, async () => {
		const remoteSessionId = remoteSessionIdFromHandle(path);
		if (remoteSessionId) {
			return remoteEnsureVault(remoteSessionId);
		}
		return ipc<CreateVaultResult>("vault_ensure", { path });
	});
}

/**
 * Probe an existing vault dir and grant it to the webview fs scope
 * (Host: vault_authorize; persisted across restarts). Never creates
 * directories — safe as an existence check for restore/recent flows.
 * Remote vault handles bypass plugin-fs and are always authorized.
 */
export async function authorizeVault(path: string): Promise<boolean> {
	if (!isTauri()) return false;
	if (remoteSessionIdFromHandle(path)) return true;
	return ipc<boolean>("vault_authorize", { path });
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

/**
 * Build the vault file tree.
 *
 * - Eager recursive: `papers/`, `notes/`, `plans/`, `.agents/`
 * - Shallow elsewhere: vault-root extras (`src/`, `thesis/`, …) appear as
 *   one level with `childrenPending`; expand via {@link listVaultDirChildren}.
 * - Ignored names ({@link TREE_IGNORE_NAMES} / dots / `*.egg-info`) are never listed.
 */
export async function loadVaultTree(rootPath: string): Promise<FileNode[]> {
	if (isRemoteVaultHandle(rootPath)) {
		return buildTreeRemote(rootPath, "");
	}
	return buildTreeLocal(rootPath, "");
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

export async function readVaultFile(path: string): Promise<string> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.readDesktopOnly"));
	}

	const remoteRead = parseRemoteJoinedPath(path);
	if (remoteRead) {
		if (!remoteRead.rel) throw new Error("invalid remote path");
		return remoteReadText(remoteRead.sessionId, remoteRead.rel);
	}

	return readTextFile(path);
}

/** Write text file (creates parent dirs when possible). */
export async function writeVaultFile(
	path: string,
	content: string,
): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}

	const remoteWrite = parseRemoteJoinedPath(path);
	if (remoteWrite) {
		if (!remoteWrite.rel) throw new Error("invalid remote path");
		await remoteWriteText(remoteWrite.sessionId, remoteWrite.rel, content);
		return;
	}

	const { mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
	const parent = path.replace(/[\\/][^\\/]+$/, "");
	if (parent && parent !== path) {
		try {
			await mkdir(parent, { recursive: true });
		} catch {
			// Parent may already exist
		}
	}
	await writeTextFile(path, content);
}

/** Write binary file (creates parent dirs when possible). Used for Markdown `./assets/` images. */
export async function writeVaultBytes(
	path: string,
	bytes: Uint8Array,
): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}

	const remote = parseRemoteJoinedPath(path);
	if (remote) {
		if (!remote.rel) throw new Error("invalid remote path");
		await remoteWriteBytes(remote.sessionId, remote.rel, bytes);
		return;
	}

	const { mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
	const parent = path.replace(/[\\/][^\\/]+$/, "");
	if (parent && parent !== path) {
		try {
			await mkdir(parent, { recursive: true });
		} catch {
			// Parent may already exist
		}
	}
	await writeFile(path, bytes);
}

/** Create a directory (and parents) under the vault. */
export async function createVaultDirectory(path: string): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}

	const remote = parseRemoteJoinedPath(path);
	if (remote) {
		if (!remote.rel) throw new Error("invalid remote path");
		await remoteMkdir(remote.sessionId, remote.rel);
		return;
	}

	const { mkdir } = await import("@tauri-apps/plugin-fs");
	await mkdir(path, { recursive: true });
}

/**
 * Remove a file or directory under the vault.
 * Directories are removed recursively (including non-empty).
 * Remote vaults use SFTP remove (no recycle bin in MVP).
 */
export async function removeVaultPath(path: string): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}
	const trimmed = path.trim();
	if (!trimmed || trimmed.startsWith("agentero:")) {
		throw new Error(i18n.t("sidebar:fileTree.deleteInvalid"));
	}
	const remote = parseRemoteJoinedPath(trimmed);
	if (remote) {
		if (!remote.rel) throw new Error("invalid remote path");
		await remoteRemove(remote.sessionId, remote.rel, true);
		return;
	}
	const { remove } = await import("@tauri-apps/plugin-fs");
	await remove(trimmed, { recursive: true });
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

export function vaultDisplayName(rootPath: string | null): string {
	if (!rootPath) return i18n.t("app:vault.noVaultName");
	if (isRemoteVaultHandle(rootPath)) {
		const meta = getRemoteSessionMeta();
		if (meta?.displayName) return meta.displayName;
		return rootPath;
	}
	const parts = rootPath.replace(/[\\/]+$/, "").split(/[\\/]/);
	return parts[parts.length - 1] || rootPath;
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
