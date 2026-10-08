/**
 * Listen for Host paper-open requests (`agentero paper open <ref>` /
 * `agentero://paper?vault=…&path=…`).
 *
 * Unlike a Vault open, a paper request names both the owning Vault and the
 * Vault-relative paper folder: switch the active Vault first when needed, then
 * open the paper in the Dockview workspace.
 */

import { useEffect } from "react";
import { takePendingPaperOpen } from "@/lib/cli/api";
import { events, type PaperOpenPayload } from "@/lib/core/bindings";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { listenEventSafe } from "@/lib/core/tauri-events";
import { openLocalVaultPath } from "@/lib/vault/actions";
import { joinVaultPath } from "@/lib/vault/path";
import { vaultStore } from "@/lib/vault/store";

function normalizeVault(path: string | null | undefined): string {
	return (path ?? "").replace(/[\\/]+$/, "");
}

export function usePaperOpenRequest(): void {
	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		/** In-flight key so event + pending take do not double-open. */
		let inflight: string | null = null;
		let generation = 0;

		const handle = async (payload: PaperOpenPayload | null | undefined) => {
			const vaultPath = payload?.vaultPath?.trim();
			const paperPath = payload?.paperPath?.trim();
			if (!vaultPath || !paperPath || cancelled) return;
			const key = `${vaultPath}::${paperPath}`;
			if (inflight === key) return;
			const gen = ++generation;
			inflight = key;
			try {
				// Host emits and also queues pending; drain the concurrent pair.
				try {
					await takePendingPaperOpen();
				} catch {
					// Older Host or no pending — fine.
				}
				if (cancelled || gen !== generation) return;

				if (
					normalizeVault(vaultStore.getState().vaultPath) !==
					normalizeVault(vaultPath)
				) {
					await openLocalVaultPath(vaultPath);
					if (cancelled || gen !== generation) return;
					// Switch may have failed (missing path) — do not open blindly.
					if (
						normalizeVault(vaultStore.getState().vaultPath) !==
						normalizeVault(vaultPath)
					) {
						return;
					}
				}

				const { openPaper } = await import("@/lib/workspace/actions");
				openPaper(joinVaultPath(vaultPath, paperPath));
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			} finally {
				if (gen === generation) {
					inflight = null;
				}
			}
		};

		const offOpen = listenEventSafe(events.paperOpenRequest, (payload) => {
			void handle(payload);
		});

		// Startup race: Host may have queued a request before we listened.
		void (async () => {
			try {
				const pending = await takePendingPaperOpen();
				if (!cancelled && pending) {
					await handle(pending);
				}
			} catch {
				// Non-fatal when the command is unavailable (older Host).
			}
		})();

		return () => {
			cancelled = true;
			offOpen();
		};
	}, []);
}
