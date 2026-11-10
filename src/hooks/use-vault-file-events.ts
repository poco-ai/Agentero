import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/core/tauri";
import { isPaperAssetPath, isUnderPapers } from "@/lib/paper/paths";
import { listenVaultFileChangedGated } from "@/lib/vault/file-change-gate";
import {
	startVaultWatch,
	stopVaultWatch,
	type VaultFileChangedPayload,
} from "@/lib/vault/fs-watch";
import { invalidateSeedCache } from "@/lib/vault/seed-cache";
import { isWritingManifestPath } from "@/lib/writing/project-manifest";
import { bumpWritingTreeRevision } from "@/lib/writing/tree-target";

type VaultFileEventsParams = {
	vaultPath: string | null;
	/** Reload the matching open editor(s) after a file's content changed on disk. */
	onDiskChange: (absPath: string) => void;
	/** Refresh the file tree after a structural change (create/delete/rename). */
	onStructuralChange: (changedAbsPaths: string[]) => void;
	/** Refresh catalog-backed Library state after external paper/catalog changes. */
	onLibraryChange?: (paths: string[]) => void;
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

	// PERF: hold the callbacks in a ref so inline arrows from the shell do not
	// re-subscribe on every render. Re-listening is not just wasteful: the
	// gated listener's disposer drops still-buffered events, so a re-render
	// while the window is unfocused could silently lose file changes.
	const handlersRef = useRef({
		onDiskChange,
		onStructuralChange,
		onLibraryChange,
		onWikiChange,
		shouldIgnoreEvent,
		onExternalRename,
		onUnverifiedRename,
	});
	handlersRef.current = {
		onDiskChange,
		onStructuralChange,
		onLibraryChange,
		onWikiChange,
		shouldIgnoreEvent,
		onExternalRename,
		onUnverifiedRename,
	};

	useEffect(() => {
		// Buffer while the window is hidden/unfocused; flush on return so refresh
		// work does not run against an invisible shell.
		return listenVaultFileChangedGated(async (payload) => {
			const h = handlersRef.current;
			if (h.shouldIgnoreEvent?.(payload)) return;
			if (h.onLibraryChange && payloadAffectsLibrary(payload)) {
				h.onLibraryChange(payload.paths);
			}
			if (payload.rename) {
				await h.onExternalRename?.(payload.rename, payload);
			} else if (payload.kind === "rename") {
				h.onUnverifiedRename?.(payload);
			}
			for (const p of payload.paths) {
				invalidateSeedCache(p);
				h.onDiskChange(p);
				h.onWikiChange?.(p);
			}
			if (
				vaultPath &&
				payload.paths.some((path) => isWritingManifestPath(vaultPath, path))
			) {
				bumpWritingTreeRevision();
			}
			// Structural changes affect the tree; plain content edits don't.
			if (payload.kind !== "modify") h.onStructuralChange(payload.paths);
		});
	}, [vaultPath]);
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
