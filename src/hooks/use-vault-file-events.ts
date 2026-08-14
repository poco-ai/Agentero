import { useEffect } from "react";
import { toVaultRelative } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { isUnderPapers } from "@/lib/paper/paths";
import {
	startVaultWatch,
	stopVaultWatch,
	VAULT_FILE_CHANGED_EVENT,
	type VaultFileChangedPayload,
} from "@/lib/vault/fs-watch";

type VaultFileEventsParams = {
	vaultPath: string | null;
	/** Reload the matching open editor(s) after a file's content changed on disk. */
	onDiskChange: (absPath: string) => void;
	/** Refresh the file tree after a structural change (create/delete/rename). */
	onStructuralChange: (changedAbsPaths: string[]) => void;
	/** Refresh catalog-backed Library state after external paper/catalog changes. */
	onLibraryChange?: () => void;
	/**
	 * Any touched path (content or structural). Used to (debounced) rebuild the
	 * wiki / backlinks / graph index so it never goes stale after external writes.
	 */
	onWikiChange?: (absPath: string) => void;
	/** Ignore a known self-authored transaction event so it does not re-run refresh work. */
	shouldIgnoreEvent?: (payload: VaultFileChangedPayload) => boolean;
	/** Inspect a trustworthy external rename pair before the regular index rebuild. */
	onExternalRename?: (
		rename: NonNullable<VaultFileChangedPayload["rename"]>,
		payload: VaultFileChangedPayload,
	) => Promise<void> | void;
};

/**
 * Start/stop the Host filesystem watcher for the active vault and reload open
 * editors + file tree when files change on disk (external tools / Agent writes).
 */
export function useVaultFileEvents({
	vaultPath,
	onDiskChange,
	onStructuralChange,
	onLibraryChange,
	onWikiChange,
	shouldIgnoreEvent,
	onExternalRename,
}: VaultFileEventsParams): void {
	// start() replaces any existing watcher for this window, so a Vault switch needs
	// only a fresh start (no cleanup-stop, which could race the new start). Window
	// close is handled by the Host's on_window_event(Destroyed).
	useEffect(() => {
		if (!isTauri()) return;
		if (!vaultPath) {
			void stopVaultWatch().catch(() => {});
			return;
		}
		// watcher is best-effort; editor still works without live reload
		void startVaultWatch(vaultPath).catch(() => {});
	}, [vaultPath]);

	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		let unsub: (() => void) | undefined;
		void (async () => {
			const { listen } = await import("@tauri-apps/api/event");
			if (cancelled) return;
			unsub = await listen<VaultFileChangedPayload>(
				VAULT_FILE_CHANGED_EVENT,
				async ({ payload }) => {
					if (shouldIgnoreEvent?.(payload)) return;
					if (onLibraryChange && payloadAffectsLibrary(vaultPath, payload)) {
						onLibraryChange();
					}
					if (payload.rename) {
						await onExternalRename?.(payload.rename, payload);
					}
					for (const p of payload.paths) {
						onDiskChange(p);
						onWikiChange?.(p);
					}
					// Structural changes affect the tree; plain content edits don't.
					if (payload.kind !== "modify") onStructuralChange(payload.paths);
				},
			);
		})();
		return () => {
			cancelled = true;
			unsub?.();
		};
	}, [
		onDiskChange,
		onExternalRename,
		onLibraryChange,
		onStructuralChange,
		onWikiChange,
		shouldIgnoreEvent,
		vaultPath,
	]);
}

function payloadAffectsLibrary(
	vaultPath: string | null,
	payload: VaultFileChangedPayload,
): boolean {
	if (payload.paths.some((p) => isCatalogStoragePath(vaultPath, p)))
		return true;
	// CLI/import tools materialize paper folders and metadata under papers/.
	// Plain content edits to NOTES.md should not hit the catalog path.
	return (
		payload.kind !== "modify" && payload.paths.some((p) => isUnderPapers(p))
	);
}

function isCatalogStoragePath(
	vaultPath: string | null,
	absPath: string,
): boolean {
	const rel = toVaultRelative(vaultPath, absPath).toLowerCase();
	return (
		rel === ".agentero/catalog.sqlite" ||
		rel === ".agentero/catalog.sqlite-wal" ||
		rel === ".agentero/catalog.sqlite-shm" ||
		rel === ".agentero/catalog.sqlite-journal"
	);
}
