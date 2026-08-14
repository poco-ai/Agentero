import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/core/tauri";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

/** Payload of the `vault:file-changed` event emitted by the Host watcher. */
export type VaultFileChangedPayload = {
	/** Absolute paths touched by this (debounced) batch. */
	paths: string[];
	/** Coarse change kind. */
	kind: "create" | "modify" | "remove" | "rename" | "other";
	/** Present for every `rename`; incomplete name events are emitted as `other`. */
	rename?: { from: string; to: string };
};

/** Event name emitted by the Host filesystem watcher. */
export const VAULT_FILE_CHANGED_EVENT = "vault:file-changed";

/** Start (or restart) watching the given Vault directory for this window. */
export async function startVaultWatch(vaultPath: string): Promise<void> {
	if (!isTauri() || !vaultPath) return;
	// Remote vaults (`remote:<sessionId>`) have no local notify path.
	if (isRemoteVaultHandle(vaultPath)) return;
	await invoke("fs_watch_start", { vaultPath });
}

/** Stop watching the Vault for this window. */
export async function stopVaultWatch(): Promise<void> {
	if (!isTauri()) return;
	await invoke("fs_watch_stop");
}
