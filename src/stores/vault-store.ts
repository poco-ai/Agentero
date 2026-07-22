/**
 * Vault UI state: active vault root, the lazy file tree, tree selection, the
 * inline create-draft, and the recent-vaults list. Backed by a Zustand store so
 * event handlers can read the latest snapshot via {@link getVaultState} instead
 * of the `useRef` shadows the old `App.tsx` maintained.
 *
 * Setters mirror the React `useState` contract (accept a value or an updater)
 * so existing call sites move over unchanged.
 */

import type { TreeCreateDraft } from "@/components/layout/file-tree-helpers";
import { isTauri } from "@/lib/tauri";
import { type FileNode, getRecentVaults, getSavedVaultPath } from "@/lib/vault";
import { createAppStore } from "@/stores/create";
import { loadSettings } from "@/stores/settings-store";

export type VaultState = {
	/** Active vault root: local path, `remote:<id>` handle, or null (no vault). */
	vaultPath: string | null;
	/** Lazy vault file tree (eager under product roots, shallow elsewhere). */
	tree: FileNode[];
	treeLoading: boolean;
	/** File-tree selection / create-parent context. */
	treeSelectedPath: string | null;
	/** Inline new file/folder draft in the tree (IDE-style). */
	createDraft: TreeCreateDraft | null;
	/** MRU list of local vault roots for the switcher. */
	recentVaults: string[];
};

export const vaultStore = createAppStore<VaultState>(() => ({
	vaultPath: null,
	tree: [],
	treeLoading: false,
	treeSelectedPath: null,
	createDraft: null,
	recentVaults: [],
}));

type Updater<T> = T | ((prev: T) => T);

function apply<K extends keyof VaultState>(
	key: K,
	next: Updater<VaultState[K]>,
): void {
	vaultStore.store.setState((s) => {
		const value =
			typeof next === "function"
				? (next as (prev: VaultState[K]) => VaultState[K])(s[key])
				: next;
		return { [key]: value } as Pick<VaultState, K>;
	});
}

export function setVaultPath(next: Updater<string | null>): void {
	apply("vaultPath", next);
}

export function setTree(next: Updater<FileNode[]>): void {
	apply("tree", next);
}

export function setTreeLoading(next: Updater<boolean>): void {
	apply("treeLoading", next);
}

export function setTreeSelectedPath(next: Updater<string | null>): void {
	apply("treeSelectedPath", next);
}

export function setCreateDraft(next: Updater<TreeCreateDraft | null>): void {
	apply("createDraft", next);
}

export function setRecentVaults(next: Updater<string[]>): void {
	apply("recentVaults", next);
}

/** Read the live snapshot from async callbacks (replaces the old ref shadows). */
export function getVaultState(): VaultState {
	return vaultStore.store.getState();
}

/** Subscribe a component to the whole vault slice. */
export function useVaultState(): VaultState {
	return vaultStore.use((s) => s);
}

/**
 * Seed the store from storage + settings. Must run once at the first App render
 * (after `boot()` hydrated settings) to preserve the original restore-last-vault
 * timing; re-running recomputes from the same sources.
 */
export function initializeVaultStore(): void {
	const vaultPath = isTauri()
		? getSavedVaultPath({ allowRestore: loadSettings().restoreLastVault })
		: null;
	vaultStore.store.setState({
		vaultPath,
		treeLoading: Boolean(vaultPath),
		recentVaults: getRecentVaults(),
	});
}
