import { useEffect } from "react";
import { isTauri } from "@/lib/core/tauri";
import { listenSafe } from "@/lib/core/tauri-events";
import { isPaperAssetPath, isUnderPapers } from "@/lib/paper/paths";
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
	/** Report a rename event that did not include a safe old/new path pair. */
	onUnverifiedRename?: (payload: VaultFileChangedPayload) => void;
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
	onUnverifiedRename,
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
		return listenSafe<VaultFileChangedPayload>(
			VAULT_FILE_CHANGED_EVENT,
			async (payload) => {
				if (shouldIgnoreEvent?.(payload)) return;
				if (onLibraryChange && payloadAffectsLibrary(payload)) {
					onLibraryChange();
				}
				if (payload.rename) {
					await onExternalRename?.(payload.rename, payload);
				} else if (payload.kind === "rename") {
					onUnverifiedRename?.(payload);
				}
				for (const p of payload.paths) {
					onDiskChange(p);
					onWikiChange?.(p);
				}
				// Structural changes affect the tree; plain content edits don't.
				if (payload.kind !== "modify") onStructuralChange(payload.paths);
			},
		);
	}, [
		onDiskChange,
		onExternalRename,
		onUnverifiedRename,
		onLibraryChange,
		onStructuralChange,
		onWikiChange,
		shouldIgnoreEvent,
	]);
}

function payloadAffectsLibrary(payload: VaultFileChangedPayload): boolean {
	// CLI/import tools materialize paper folders and metadata under papers/.
	// Plain content edits to NOTES.md should not hit the catalog path, and
	// asset writes (marks/source/assets) never change catalog rows at all.
	return (
		payload.kind !== "modify" &&
		payload.paths.some((p) => isUnderPapers(p) && !isPaperAssetPath(p))
	);
}
