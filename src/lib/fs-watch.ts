import { ipc } from "@/lib/ipc";
import { isTauri } from "@/lib/tauri";

/** Payload of the `vault:file-changed` event emitted by the Host watcher. */
export type VaultFileChangedPayload = {
	/** Absolute paths touched by this (debounced) batch. */
	paths: string[];
	/** Coarse change kind. */
	kind: "create" | "modify" | "remove" | "rename" | "other";
};

/** Event name emitted by the Host filesystem watcher. */
export const VAULT_FILE_CHANGED_EVENT = "vault:file-changed";

/** Start (or restart) watching the given Vault directory for this window. */
export async function startVaultWatch(vaultPath: string): Promise<void> {
	if (!isTauri() || !vaultPath) return;
	// Remote vaults (`remote:<sessionId>`) have no local notify path.
	if (vaultPath.startsWith("remote:")) return;
	await ipc("fs_watch_start", { vaultPath });
}

/** Stop watching the Vault for this window. */
export async function stopVaultWatch(): Promise<void> {
	if (!isTauri()) return;
	await ipc("fs_watch_stop");
}
