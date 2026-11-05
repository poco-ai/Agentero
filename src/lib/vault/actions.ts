/**
 * Vault actions: vault switching, tree CRUD (create/trash/move/rename),
 * Finder/terminal reveal, and recycle-bin maintenance. Cross-domain effects
 * (open tabs, wiki links, library rows) flow through the domain stores.
 */

import i18n from "@/i18n";
import { clearSelections } from "@/lib/agent/selection-store";
import { clearVisualDrafts } from "@/lib/agent/visual-context-store";
import { errorText } from "@/lib/core/error";
import {
	notifyAction,
	notifyError,
	notifySuccess,
	notifyWarning,
} from "@/lib/core/notify";
import { dirnameOf, displayPath } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { isPaperDirectory, isPapersRoot, isUnderPapers } from "@/lib/paper";
import {
	isLibraryVirtualPath,
	isTrashVirtualPath,
	listTrash,
	movePaperFolder,
	purgeAllTrash,
	trashPaths,
} from "@/lib/paper/api";
import { isZoteroDataDir } from "@/lib/paper/import/zotero-migrate";
import {
	bumpTrashReloadSignal,
	refreshLibrary,
	setLibraryQuery,
	setLibraryScopePath,
} from "@/lib/paper/library-store";
import { setZoteroOpen } from "@/lib/shell/ui-store";
import type { FileNode } from "@/lib/vault";
import {
	createVault,
	createVaultDirectory,
	ensureLocalFsScope,
	ensureVault,
	isValidVaultEntryName,
	joinVaultPath,
	openNewWindow,
	pickCreateVaultDirectory,
	pickVaultDirectory,
	planVaultRename,
	removeRecentVault,
	removeTreeNode,
	removeVaultPath,
	saveVaultPath,
	seededSkillIdsFromCreated,
	treeFindNode,
	vaultPathExists,
	vaultRelativePath,
	writeVaultFile,
} from "@/lib/vault";
import { normalizePathKey as pathKey } from "@/lib/vault/path";
import {
	clearRemoteSessionMeta,
	isRemoteVaultHandle,
	rememberRecentRemoteVault,
	remoteConnect,
	remoteDisconnect,
	remoteSessionIdFromHandle,
	saveRemoteSessionMeta,
} from "@/lib/vault/remote/remote-vault";
import { openInTerminal, revealInFileManager } from "@/lib/vault/reveal";
import type { TreeCreateKind } from "@/lib/vault/store";
import {
	bumpTreeGeneration,
	clearCutPaths,
	getVaultPath,
	refreshRecentVaults,
	refreshTree,
	setCreateDraft,
	setCutPaths,
	setRenameDraft,
	setTree,
	setTreeLoading,
	setTreeSelectedPath,
	setVaultBusy,
	setVaultPath,
	vaultStore,
} from "@/lib/vault/store";
import { moveVaultPath, normalizeVaultRel } from "@/lib/wiki";
import { syncMovedPaths } from "@/lib/wiki/actions";
import {
	rebuildWikiAndNotify,
	trackInternalRenamePaths,
} from "@/lib/wiki/store";
import {
	closeTabsUnderPath,
	dirtyVaultPaths,
	openPath,
} from "@/lib/workspace/actions";
import {
	clearClosedTabs,
	setActiveTabId,
	setTabs,
} from "@/lib/workspace/store";
import { basenameOf } from "@/lib/workspace/tabs";
import { isExcalidrawPath } from "@/lib/workspace/viewer";

export async function activateVault(path: string): Promise<void> {
	// Tear down previous remote session so work catalogs are flushed.
	const prev = getVaultPath();
	if (prev && isRemoteVaultHandle(prev) && prev !== path) {
		const prevId = remoteSessionIdFromHandle(prev);
		if (prevId) {
			await remoteDisconnect(prevId);
		}
		clearRemoteSessionMeta();
	}
	bumpTreeGeneration();
	setTree([]);
	setTreeLoading(true);
	saveVaultPath(path);
	setVaultPath(path);
	void import("@/lib/activity").then(({ track }) => {
		track("vault.open");
	});
	setTabs([]);
	setActiveTabId(null);
	clearClosedTabs();
	setTreeSelectedPath(null);
	setLibraryQuery("");
	setLibraryScopePath(null);
	// Ephemeral composer context is vault-scoped in practice; clear so drafts
	// never write marks into the previous vault after a switch.
	clearVisualDrafts();
	clearSelections();
	refreshRecentVaults();
	// Wiki rebuild needs local fs watcher semantics; remote is best-effort.
	if (!isRemoteVaultHandle(path)) {
		await rebuildWikiAndNotify(path);
	}
}

export async function openVault(): Promise<void> {
	try {
		if (!isTauri()) {
			notifyError(i18n.t("app:errors.openVaultDesktopOnly"));
			return;
		}
		setVaultBusy(true);
		const path = await pickVaultDirectory();
		if (!path) return;
		await activateVault(path);
	} catch (e) {
		notifyError(errorText(e));
	} finally {
		setVaultBusy(false);
	}
}

export async function openRemoteVault(args: {
	host: string;
	user?: string;
	remotePath: string;
}): Promise<void> {
	try {
		if (!isTauri()) {
			notifyError(i18n.t("app:errors.openVaultDesktopOnly"));
			return;
		}
		setVaultBusy(true);
		const info = await remoteConnect(args);
		try {
			await activateVault(info.vaultHandle);
		} catch (error) {
			await remoteDisconnect(info.sessionId);
			throw error;
		}
		saveRemoteSessionMeta(info);
		rememberRecentRemoteVault({
			kind: "remote",
			host: args.host,
			user: args.user,
			remotePath: args.remotePath,
			label: info.displayName,
		});
	} catch (e) {
		notifyError(
			e instanceof Error ? e.message : i18n.t("app:vault.remoteConnectFailed"),
		);
	} finally {
		setVaultBusy(false);
	}
}

export async function openRecentVault(path: string): Promise<void> {
	await openLocalVaultPath(path, { missingAsRecentError: true });
}

/**
 * Open a local directory as the active Vault (picker, recent, deep link, CLI).
 * Host validates deep-link paths before emit; still re-check existence here.
 */
export async function openLocalVaultPath(
	path: string,
	opts?: { missingAsRecentError?: boolean },
): Promise<void> {
	const trimmed = path?.trim();
	if (!trimmed) return;
	try {
		if (!isTauri()) {
			notifyError(i18n.t("app:errors.openVaultDesktopOnly"));
			return;
		}
		setVaultBusy(true);
		await ensureLocalFsScope(trimmed);
		const { exists } = await import("@tauri-apps/plugin-fs");
		if (!(await exists(trimmed))) {
			if (opts?.missingAsRecentError) {
				removeRecentVault(trimmed);
				refreshRecentVaults();
				notifyError(i18n.t("app:vault.recentMissing", { path: trimmed }));
			} else {
				notifyError(i18n.t("app:vault.openPathMissing", { path: trimmed }));
			}
			return;
		}
		// Skip no-op switch to the already-active vault (normalize trailing slash).
		const current = (getVaultPath() ?? "").replace(/[\\/]+$/, "");
		const next = trimmed.replace(/[\\/]+$/, "");
		if (current && current === next) {
			return;
		}
		await activateVault(trimmed);
	} catch (e) {
		notifyError(errorText(e));
	} finally {
		setVaultBusy(false);
	}
}

export function removeRecent(path: string): void {
	removeRecentVault(path);
	refreshRecentVaults();
}

export async function newWindow(): Promise<void> {
	try {
		if (!isTauri()) {
			notifyError(i18n.t("app:errors.openVaultDesktopOnly"));
			return;
		}
		await openNewWindow();
	} catch (e) {
		notifyError(errorText(e));
	}
}

/** Full refresh: tree, wiki index, library rows. */
export function refreshAll(): void {
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	void (async () => {
		await refreshTree(vaultPath);
		// Wiki rebuild needs local fs semantics; a remote handle always fails.
		if (!isRemoteVaultHandle(vaultPath)) {
			await rebuildWikiAndNotify(vaultPath);
		}
		await refreshLibrary();
	})();
}

/**
 * After app updates, seed new bundled skills and safely upgrade managed
 * first-party skills (frontmatter `version` only). User-owned files
 * (no/higher/same version) stay put.
 */
export function seedVaultSkills(path: string): void {
	if (!isTauri() || !path) return;
	void (async () => {
		try {
			// A restored vault may have been moved/deleted since the path was
			// persisted; never seed (and thus scaffold) a missing local path.
			if (!isRemoteVaultHandle(path)) {
				const { exists } = await import("@tauri-apps/plugin-fs");
				if (!(await exists(path))) return;
			}
			const result = await ensureVault(path, i18n.language);
			const installed = seededSkillIdsFromCreated(result.created);
			const updated = seededSkillIdsFromCreated(result.updated);
			if (installed.length === 0 && updated.length === 0) return;
			// Path may have changed while ensure was in flight.
			if (getVaultPath() !== path) return;
			if (installed.length > 0) {
				notifySuccess(
					i18n.t("app:vault.skillsSeeded", {
						count: installed.length,
						names: installed.join(", "),
					}),
					{ id: "vault-skills-seeded" },
				);
			}
			if (updated.length > 0) {
				notifySuccess(
					i18n.t("app:vault.skillsUpdated", {
						count: updated.length,
						names: updated.join(", "),
					}),
					{ id: "vault-skills-updated" },
				);
			}
		} catch {
			// Best-effort: opening the vault must not fail if seed is blocked.
		}
	})();
}

/** ⌥⌘R — reveal selected vault path in Finder / Explorer. */
export function revealSelectedInFinder(): void {
	const { treeSelectedPath, vaultPath } = vaultStore.getState();
	const path = treeSelectedPath;
	if (!path || isLibraryVirtualPath(path) || isTrashVirtualPath(path)) return;
	if (isRemoteVaultHandle(vaultPath) || isRemoteVaultHandle(path)) {
		notifyWarning(i18n.t("app:vault.remoteNoFinder"));
		return;
	}
	if (!isTauri()) {
		notifyError(i18n.t("sidebar:fileTree.revealDesktopOnly"));
		return;
	}
	void (async () => {
		try {
			await revealInFileManager(path);
		} catch {
			notifyError(i18n.t("sidebar:fileTree.revealFailed"));
		}
	})();
}

/** ⌥⌘T — open system terminal at selected path (dir = self, file = parent). */
export function openSelectedInTerminal(): void {
	const { treeSelectedPath, vaultPath } = vaultStore.getState();
	const path = treeSelectedPath;
	if (!path || isLibraryVirtualPath(path) || isTrashVirtualPath(path)) return;
	if (isRemoteVaultHandle(vaultPath) || isRemoteVaultHandle(path)) {
		notifyWarning(i18n.t("app:vault.remoteNoTerminal"));
		return;
	}
	if (!isTauri()) {
		notifyError(i18n.t("sidebar:fileTree.openInTerminalDesktopOnly"));
		return;
	}
	void (async () => {
		try {
			await openInTerminal(path);
		} catch {
			notifyError(i18n.t("sidebar:fileTree.openInTerminalFailed"));
		}
	})();
}

/** Delete vault paths into the recycle bin (`.agentero/.trash/`). */
export async function trashPathsAndNotify(absPaths: string[]): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath || !isTauri()) {
		notifyError(i18n.t("sidebar:fileTree.deleteDesktopOnly"));
		return;
	}
	const rootNorm = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
	const valid = absPaths
		.map((p) => p.replace(/\\/g, "/").replace(/\/+$/, ""))
		.filter(
			(p) =>
				p &&
				!isLibraryVirtualPath(p) &&
				!isTrashVirtualPath(p) &&
				p !== rootNorm &&
				p.startsWith(`${rootNorm}/`),
		);
	if (valid.length === 0) return;
	setVaultBusy(true);
	trackInternalRenamePaths(valid, Number.POSITIVE_INFINITY);
	try {
		const rels = valid
			.map((p) => vaultRelativePath(vaultPath, p))
			.filter((r): r is string => Boolean(r));
		await trashPaths(vaultPath, rels);
		for (const p of valid) closeTabsUnderPath(p);
		// Optimistic prune so a concurrent remote list of the deleted path
		// cannot leave a ghost folder while refresh rebuilds.
		let pruned = vaultStore.getState().tree;
		for (const p of valid) {
			pruned = removeTreeNode(pruned, p);
		}
		setTree(pruned);
		const treeNorm = vaultStore
			.getState()
			.treeSelectedPath?.replace(/\\/g, "/")
			.replace(/\/+$/, "");
		if (
			treeNorm &&
			valid.some((p) => treeNorm === p || treeNorm.startsWith(`${p}/`))
		) {
			setTreeSelectedPath(null);
		}
		await refreshTree(vaultPath);
		if (!isRemoteVaultHandle(vaultPath)) {
			await rebuildWikiAndNotify(vaultPath);
		}
		await refreshLibrary();
	} catch (e) {
		notifyError(
			e instanceof Error ? e.message : i18n.t("sidebar:fileTree.deleteFailed"),
		);
	} finally {
		trackInternalRenamePaths(valid, Date.now() + 2000);
		setVaultBusy(false);
	}
}

export function deleteSelectedPath(): void {
	const path = vaultStore.getState().treeSelectedPath;
	if (!path || isLibraryVirtualPath(path) || isTrashVirtualPath(path)) {
		notifyError(i18n.t("sidebar:fileTree.deleteNeedsSelection"));
		return;
	}
	void trashPathsAndNotify([path]);
}

/** Refresh tree / library / wiki after a recycle-bin restore. */
export async function handleTrashChanged(): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	setTreeSelectedPath(null);
	await refreshTree(vaultPath);
	// Wiki rebuild needs local fs semantics; a remote handle always fails.
	if (!isRemoteVaultHandle(vaultPath)) {
		await rebuildWikiAndNotify(vaultPath);
	}
	await refreshLibrary();
}

/** Empty recycle bin from the trash node context menu (confirm + purge). */
export async function emptyTrash(): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath || !isTauri()) return;
	try {
		const items = await listTrash(vaultPath);
		if (items.length === 0) return;
		if (
			!window.confirm(
				i18n.t("sidebar:recycleBin.emptyConfirm", { count: items.length }),
			)
		) {
			return;
		}
		await purgeAllTrash(vaultPath);
		bumpTrashReloadSignal();
	} catch (e) {
		notifyError(
			e instanceof Error ? e.message : i18n.t("sidebar:recycleBin.purgeFailed"),
		);
	}
}

/** Core move loop reused by the dialog and by drag-and-drop. */
export async function movePathsTo(
	rawPaths: string[],
	destParentRel: string,
): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	const paths = rawPaths.filter(
		(p) => !isLibraryVirtualPath(p) && !isTrashVirtualPath(p),
	);
	if (paths.length === 0) return;
	setVaultBusy(true);
	let failed = 0;
	try {
		for (const path of paths) {
			const rel = vaultRelativePath(vaultPath, path);
			if (!rel) {
				failed++;
				continue;
			}
			const destinationParent = normalizeVaultRel(destParentRel) || "papers";
			const expectedToRel = `${destinationParent}/${basenameOf(rel)}`;
			// Already at the requested destination; nothing to do.
			if (normalizeVaultRel(expectedToRel) === normalizeVaultRel(rel)) {
				continue;
			}
			const pendingEventPaths = [path, joinVaultPath(vaultPath, expectedToRel)];
			trackInternalRenamePaths(pendingEventPaths, Number.POSITIVE_INFINITY);
			try {
				const result = await movePaperFolder(
					vaultPath,
					rel,
					destParentRel,
					dirtyVaultPaths(vaultPath),
				);
				const toAbs = joinVaultPath(vaultPath, result.newRel);
				syncMovedPaths(
					vaultPath,
					path,
					toAbs,
					rel,
					result.newRel,
					result.linkUpdate,
				);
			} catch {
				trackInternalRenamePaths(pendingEventPaths, Date.now() + 2000);
				failed++;
			}
		}
		await refreshTree(vaultPath);
		await refreshLibrary();
		if (failed > 0) {
			notifyWarning(
				i18n.t("sidebar:fileTree.movedWithErrors", { count: failed }),
			);
		}
	} catch (e) {
		notifyError(
			e instanceof Error ? e.message : i18n.t("sidebar:fileTree.moveFailed"),
		);
	} finally {
		setVaultBusy(false);
	}
}

/** Find a tree node by absolute path (case-insensitive). */
function findTreeNode(tree: FileNode[], target: string): FileNode | undefined {
	const key = pathKey(target);
	let found: FileNode | undefined;
	const walk = (nodes: FileNode[]) => {
		for (const n of nodes) {
			if (pathKey(n.path) === key) {
				found = n;
				return;
			}
			if (n.children) walk(n.children);
		}
	};
	walk(tree);
	return found;
}

/** Stage non-virtual vault paths for a subsequent paste (Cut). */
export function cutSelectedPaths(rawPaths: string[]): void {
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(i18n.t("sidebar:fileTree.needsVault"));
		return;
	}
	if (!isTauri()) {
		notifyError(i18n.t("sidebar:fileTree.cutDesktopOnly"));
		return;
	}
	if (isRemoteVaultHandle(vaultPath)) {
		notifyWarning(i18n.t("sidebar:fileTree.remoteCutPasteDisabled"));
		return;
	}
	const rootKey = pathKey(vaultPath);
	const valid = rawPaths
		.map((p) => p.replace(/\\/g, "/").replace(/\/+$/, ""))
		.filter(
			(p) =>
				p &&
				pathKey(p).startsWith(`${rootKey}/`) &&
				!isLibraryVirtualPath(p) &&
				!isTrashVirtualPath(p),
		);
	if (valid.length === 0) {
		notifyError(i18n.t("sidebar:fileTree.cutNeedsSelection"));
		return;
	}
	setCutPaths(valid);
	notifyAction(i18n.t("sidebar:fileTree.cutItems", { count: valid.length }), {
		id: "file-tree-cut",
		duration: 6000,
		actionLabel: i18n.t("sidebar:fileTree.clearCut"),
		onAction: () => clearCutPaths(),
	});
}

/** Resolve the destination parent folder for a paste or drop target. */
export function resolvePasteDestination(
	vaultPath: string,
	tree: FileNode[],
	targetPath: string | null | undefined,
): { abs: string; rel: string; isPaperLeaf: boolean } | null {
	if (
		!targetPath ||
		isLibraryVirtualPath(targetPath) ||
		isTrashVirtualPath(targetPath)
	) {
		// No selection / virtual target → paste at vault root.
		return { abs: vaultPath, rel: "", isPaperLeaf: false };
	}
	const norm = targetPath.replace(/\\/g, "/").replace(/\/+$/, "");
	const rootKey = pathKey(vaultPath);
	if (pathKey(norm) === rootKey) {
		return { abs: vaultPath, rel: "", isPaperLeaf: false };
	}
	const node = findTreeNode(tree, norm);
	const isPaperLeaf =
		node?.kind === "directory" && isPaperDirectory(node.path, node.children);

	// Paper folders are minimal catalog units: never paste inside them.
	if (isPaperLeaf) {
		const parentAbs = dirnameOf(norm);
		if (!parentAbs || pathKey(parentAbs) === rootKey) {
			return { abs: vaultPath, rel: "", isPaperLeaf: true };
		}
		return {
			abs: parentAbs,
			rel: vaultRelativePath(vaultPath, parentAbs) || "",
			isPaperLeaf: true,
		};
	}

	if (node?.kind === "directory") {
		return {
			abs: norm,
			rel: vaultRelativePath(vaultPath, norm) || "",
			isPaperLeaf: false,
		};
	}

	// File → use parent directory.
	const parentAbs = dirnameOf(norm);
	if (!parentAbs || pathKey(parentAbs) === rootKey) {
		return { abs: vaultPath, rel: "", isPaperLeaf: false };
	}
	return {
		abs: parentAbs,
		rel: vaultRelativePath(vaultPath, parentAbs) || "",
		isPaperLeaf: false,
	};
}

type PasteDestination = {
	abs: string;
	rel: string;
	isPaperLeaf: boolean;
};

/** A source path and the absolute path it now lives at. */
export type MovedPathPair = { from: string; to: string };

/** Move a list of absolute source paths into a resolved destination parent. */
async function movePathsToDestination(
	vaultPath: string,
	srcAbsPaths: string[],
	dest: PasteDestination,
): Promise<{ failed: string[]; blocked: string[]; moved: MovedPathPair[] }> {
	const destRel = normalizeVaultRel(dest.rel);
	const destUnderPapers = destRel === "papers" || destRel.startsWith("papers/");
	const rootKey = pathKey(vaultPath);
	const failed: string[] = [];
	const blocked: string[] = [];
	const moved: MovedPathPair[] = [];

	for (const srcAbs of srcAbsPaths) {
		const normSrc = srcAbs.replace(/\\/g, "/").replace(/\/+$/, "");
		if (!normSrc || pathKey(normSrc) === rootKey) {
			failed.push(srcAbs);
			continue;
		}
		const srcRel = vaultRelativePath(vaultPath, normSrc);
		if (!srcRel) {
			failed.push(srcAbs);
			continue;
		}

		// Reject moving papers/ root itself.
		if (isPapersRoot(srcRel)) {
			failed.push(srcAbs);
			continue;
		}

		// Reject descendant moves (pasting into the source or its child).
		const destAbsKey = pathKey(dest.abs);
		const srcKey = pathKey(normSrc);
		if (destAbsKey === srcKey || destAbsKey.startsWith(`${srcKey}/`)) {
			failed.push(srcAbs);
			continue;
		}

		// Keep items currently under papers/ inside papers/ to preserve catalog integrity.
		if (isUnderPapers(srcRel) && !destUnderPapers) {
			notifyWarning(
				i18n.t("sidebar:fileTree.paperMoveOutsidePapers", {
					name: basenameOf(srcRel),
				}),
			);
			blocked.push(srcAbs);
			continue;
		}

		const base = basenameOf(srcRel);
		const toRel = destRel ? `${destRel}/${base}` : base;
		const toAbs = joinVaultPath(vaultPath, toRel);
		// Already at the resolved destination; nothing to do.
		if (pathKey(toAbs) === srcKey) {
			continue;
		}
		const pendingEventPaths = [normSrc, toAbs];
		trackInternalRenamePaths(pendingEventPaths, Number.POSITIVE_INFINITY);

		try {
			if (destUnderPapers && isUnderPapers(srcRel)) {
				const result = await movePaperFolder(
					vaultPath,
					srcRel,
					destRel || "papers",
					dirtyVaultPaths(vaultPath),
				);
				syncMovedPaths(
					vaultPath,
					normSrc,
					toAbs,
					srcRel,
					result.newRel,
					result.linkUpdate,
				);
			} else {
				const result = await moveVaultPath(
					vaultPath,
					srcRel,
					toRel,
					dirtyVaultPaths(vaultPath),
				);
				syncMovedPaths(vaultPath, normSrc, toAbs, srcRel, toRel, result);
			}
		} catch {
			trackInternalRenamePaths(pendingEventPaths, Date.now() + 2000);
			failed.push(srcAbs);
			continue;
		}
		moved.push({ from: normSrc, to: toAbs });
	}

	return { failed, blocked, moved };
}

/** Paste previously cut paths into the given target (folder, file, or vault root). */
export async function pasteCutPaths(
	targetPath: string | null | undefined,
): Promise<MovedPathPair[]> {
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(i18n.t("sidebar:fileTree.needsVault"));
		return [];
	}
	if (!isTauri()) {
		notifyError(i18n.t("sidebar:fileTree.pasteDesktopOnly"));
		return [];
	}
	if (isRemoteVaultHandle(vaultPath)) {
		notifyWarning(i18n.t("sidebar:fileTree.remoteCutPasteDisabled"));
		return [];
	}

	const { cutPaths } = vaultStore.getState();
	if (cutPaths.length === 0) return [];

	const { tree } = vaultStore.getState();
	const dest = resolvePasteDestination(vaultPath, tree, targetPath);
	if (!dest) {
		notifyError(i18n.t("sidebar:fileTree.pasteNeedsSelection"));
		return [];
	}

	setVaultBusy(true);
	let moved: MovedPathPair[] = [];

	try {
		const {
			failed,
			blocked,
			moved: applied,
		} = await movePathsToDestination(vaultPath, cutPaths, dest);
		moved = applied;
		// Clear successfully moved items; keep failed/blocked ones staged so the
		// user sees what did not move.
		setCutPaths([...failed, ...blocked]);
		await refreshTree(vaultPath);
		await refreshLibrary();
		if (!isRemoteVaultHandle(vaultPath)) {
			await rebuildWikiAndNotify(vaultPath);
		}
		if (failed.length > 0 || blocked.length > 0) {
			notifyWarning(
				i18n.t("sidebar:fileTree.pastedWithErrors", {
					count: failed.length + blocked.length,
				}),
			);
		}
	} catch (e) {
		notifyError(
			e instanceof Error ? e.message : i18n.t("sidebar:fileTree.pasteFailed"),
		);
	} finally {
		setVaultBusy(false);
	}
	return moved;
}

/** Move a list of paths to the destination implied by the drop target. */
export async function dropMovePaths(
	rawPaths: string[],
	targetPath: string | null | undefined,
): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(i18n.t("sidebar:fileTree.needsVault"));
		return;
	}
	if (!isTauri()) {
		notifyError(i18n.t("sidebar:fileTree.moveDesktopOnly"));
		return;
	}
	if (isRemoteVaultHandle(vaultPath)) {
		notifyWarning(i18n.t("sidebar:fileTree.remoteCutPasteDisabled"));
		return;
	}

	const { tree } = vaultStore.getState();
	const dest = resolvePasteDestination(vaultPath, tree, targetPath);
	if (!dest) {
		notifyError(i18n.t("sidebar:fileTree.pasteNeedsSelection"));
		return;
	}

	setVaultBusy(true);

	try {
		const { failed, blocked } = await movePathsToDestination(
			vaultPath,
			rawPaths,
			dest,
		);
		await refreshTree(vaultPath);
		await refreshLibrary();
		if (!isRemoteVaultHandle(vaultPath)) {
			await rebuildWikiAndNotify(vaultPath);
		}
		if (failed.length > 0 || blocked.length > 0) {
			notifyWarning(
				i18n.t("sidebar:fileTree.movedWithErrors", {
					count: failed.length + blocked.length,
				}),
			);
		}
	} catch (e) {
		notifyError(
			e instanceof Error ? e.message : i18n.t("sidebar:fileTree.moveFailed"),
		);
	} finally {
		setVaultBusy(false);
	}
}

/** Start inline rename for a tree path. */
export function startRenamePath(path: string): void {
	const vaultPath = getVaultPath();
	if (!vaultPath || isRemoteVaultHandle(vaultPath)) {
		notifyWarning(i18n.t("app:vault.remoteNoAutoLinkRepair"));
		return;
	}
	const fromRel = vaultRelativePath(vaultPath, path);
	if (!fromRel) return;
	setRenameDraft({ path, currentName: basenameOf(path) });
}

export function cancelRenamePath(): void {
	setRenameDraft(null);
}

export async function confirmRenamePath(
	path: string,
	nextName: string,
): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	const trimmed = nextName.trim();
	if (!isValidVaultEntryName(trimmed)) {
		notifyError(i18n.t("sidebar:fileTree.invalidName"));
		setRenameDraft(null);
		return;
	}
	const fromRel = vaultRelativePath(vaultPath, path);
	if (!fromRel) {
		notifyError(i18n.t("sidebar:fileTree.renameFailed"));
		setRenameDraft(null);
		return;
	}
	const currentName = basenameOf(fromRel);
	if (trimmed === currentName) {
		setRenameDraft(null);
		return;
	}
	const parent = fromRel.includes("/")
		? fromRel.slice(0, fromRel.lastIndexOf("/"))
		: "";
	const node = treeFindNode(vaultStore.getState().tree, path);
	const plan = planVaultRename({
		parentRel: parent,
		currentName,
		nextName: trimmed,
		kind: node?.kind ?? "directory",
	});
	const toRel = plan.toRel;
	const toAbs = joinVaultPath(vaultPath, toRel);
	const folderAbs = plan.folderRel
		? joinVaultPath(vaultPath, plan.folderRel)
		: null;
	const pendingEventPaths = folderAbs
		? [path, folderAbs, toAbs]
		: [path, toAbs];
	trackInternalRenamePaths(pendingEventPaths, Number.POSITIVE_INFINITY);
	setVaultBusy(true);
	let createdFolder = false;
	try {
		if (folderAbs && !(await vaultPathExists(folderAbs))) {
			await createVaultDirectory(folderAbs);
			createdFolder = true;
		}
		const result = await moveVaultPath(
			vaultPath,
			fromRel,
			toRel,
			dirtyVaultPaths(vaultPath),
		);
		syncMovedPaths(vaultPath, path, toAbs, fromRel, toRel, result);
		await refreshTree(vaultPath);
		await refreshLibrary();
		setRenameDraft(null);
		notifySuccess(
			i18n.t("sidebar:fileTree.renamedLinks", {
				count: result.updatedSources.length,
			}),
		);
	} catch (error) {
		if (createdFolder && folderAbs) {
			// Do not leave an empty folder behind when the move is rejected.
			try {
				await removeVaultPath(folderAbs);
				await refreshTree(vaultPath);
			} catch {
				// Best-effort cleanup; the original error is more useful.
			}
		}
		trackInternalRenamePaths(pendingEventPaths, Date.now() + 2000);
		notifyError(
			error instanceof Error
				? error.message
				: i18n.t("sidebar:fileTree.renameFailed"),
		);
	} finally {
		setVaultBusy(false);
	}
}

export function startCreate(kind: TreeCreateKind, parentPath: string): void {
	if (!getVaultPath() || !isTauri()) {
		notifyError(i18n.t("sidebar:fileTree.needsVault"));
		return;
	}
	setCreateDraft({ kind, parentPath });
}

export function cancelCreate(): void {
	setCreateDraft(null);
}

export async function confirmCreate(name: string): Promise<void> {
	const { createDraft } = vaultStore.getState();
	const vaultPath = getVaultPath();
	if (!createDraft || !vaultPath || !isTauri()) {
		setCreateDraft(null);
		return;
	}
	const trimmed = name.trim();
	if (!isValidVaultEntryName(trimmed)) {
		notifyError(i18n.t("sidebar:fileTree.invalidName"));
		setCreateDraft(null);
		return;
	}
	const full = joinVaultPath(createDraft.parentPath, trimmed);
	const kind = createDraft.kind;
	// Clear draft first so the tree can re-render after create.
	setCreateDraft(null);
	try {
		setVaultBusy(true);
		// Use vault-aware exists: local FS plugin cannot see `remote:<id>/…`.
		if (await vaultPathExists(full)) {
			notifyError(i18n.t("sidebar:fileTree.alreadyExists", { name: trimmed }));
			return;
		}
		if (kind !== "folder") {
			const { createResearchTable, isResearchTablePath } = await import(
				"@/lib/research-table/model"
			);
			const table = isResearchTablePath(trimmed)
				? createResearchTable(trimmed.slice(0, -11))
				: null;
			if (table) table.fields[0].name = i18n.t("editor:researchTable.name");
			const initialContent = table
				? `${JSON.stringify(table, null, 2)}\n`
				: isExcalidrawPath(trimmed)
					? JSON.stringify({
							type: "excalidraw",
							version: 2,
							source: "https://excalidraw.com",
							elements: [],
							appState: { collaborators: [] },
						})
					: "";
			await writeVaultFile(full, initialContent);
			await refreshTree(vaultPath);
			openPath(full);
		} else {
			await createVaultDirectory(full);
			await refreshTree(vaultPath);
			setTreeSelectedPath(full);
		}
	} catch (e) {
		notifyError(errorText(e));
	} finally {
		setVaultBusy(false);
	}
}

export async function createNewVault(): Promise<void> {
	try {
		if (!isTauri()) {
			notifyError(i18n.t("app:errors.openVaultDesktopOnly"));
			return;
		}
		setVaultBusy(true);
		const path = await pickCreateVaultDirectory();
		if (!path) return;
		const result = await createVault(path, i18n.language);
		const root = result.path || path;
		await activateVault(root);
		const sep = root.includes("\\") ? "\\" : "/";
		const openRel = result.openPath || "AGENTS.md";
		const openAbs = `${root.replace(/[\\/]+$/, "")}${sep}${openRel.replace(/\//g, sep)}`;
		openPath(openAbs);
	} catch (e) {
		notifyError(errorText(e));
	} finally {
		setVaultBusy(false);
	}
}

/** Welcome-page entry: create a vault, then open the Zotero migrate dialog. */
export async function migrateZoteroFromWelcome(): Promise<void> {
	try {
		if (!isTauri()) {
			notifyError(i18n.t("app:errors.openVaultDesktopOnly"));
			return;
		}
		setVaultBusy(true);
		const path = await pickCreateVaultDirectory(
			i18n.t("app:vault.zoteroVaultDialogTitle"),
		);
		if (!path) return;
		if (await isZoteroDataDir(path)) {
			notifyError(i18n.t("sidebar:zoteroMigrate.vaultIsZotero"));
			return;
		}
		const result = await createVault(path, i18n.language);
		const root = result.path || path;
		await activateVault(root);
		setZoteroOpen(true);
	} catch (e) {
		notifyError(errorText(e));
	} finally {
		setVaultBusy(false);
	}
}

/**
 * Validate a restored local Vault: the path can remain in localStorage after
 * the directory is deleted. Clears all vault state when missing.
 *
 * Resolves once the check settles so callers can order work after it.
 */
export function validateRestoredVault(): Promise<void> {
	const restoredPath = getVaultPath();
	if (!isTauri() || !restoredPath || isRemoteVaultHandle(restoredPath)) {
		return Promise.resolve();
	}
	return ensureLocalFsScope(restoredPath)
		.then(() => import("@tauri-apps/plugin-fs"))
		.then(({ exists }) => exists(restoredPath))
		.then((pathExists) => {
			if (pathExists || getVaultPath() !== restoredPath) return;
			saveVaultPath(null);
			setVaultPath(null);
			setTree([]);
			setTabs([]);
			setActiveTabId(null);
			clearClosedTabs();
			setTreeSelectedPath(null);
			notifyError(
				i18n.t("app:vault.restoredVaultMissing", {
					path: displayPath(restoredPath),
				}),
			);
		})
		.catch(() => {
			// Leave the restored state intact when the existence check fails.
		});
}
