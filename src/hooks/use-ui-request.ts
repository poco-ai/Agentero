/**
 * Listen for Host workspace UI requests (`agentero paper open`, `agentero ui …`,
 * `agentero://ui?action=…`).
 *
 * A request addresses the workspace without the Host knowing the frontend's tab
 * registry: switch the active Vault when needed, then dispatch to the same
 * open/close primitives the UI uses.
 */

import { useEffect } from "react";
import { takePendingUiRequest } from "@/lib/cli/api";
import { events, type UiRequestPayload } from "@/lib/core/bindings";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { listenEventSafe } from "@/lib/core/tauri-events";
import { openLocalVaultPath } from "@/lib/vault/actions";
import { joinVaultPath } from "@/lib/vault/path";
import { vaultStore } from "@/lib/vault/store";

function normalizeVault(path: string | null | undefined): string {
	return (path ?? "").replace(/[\\/]+$/, "");
}

/** Switch the active Vault when the request targets a different one. */
async function ensureVault(vaultPath: string): Promise<boolean> {
	if (
		normalizeVault(vaultStore.getState().vaultPath) ===
		normalizeVault(vaultPath)
	) {
		return true;
	}
	await openLocalVaultPath(vaultPath);
	return (
		normalizeVault(vaultStore.getState().vaultPath) ===
		normalizeVault(vaultPath)
	);
}

async function dispatch(payload: UiRequestPayload): Promise<void> {
	const vaultPath = payload.vaultPath?.trim();
	const rel = payload.path?.trim();

	switch (payload.action) {
		case "open-paper": {
			if (!vaultPath || !rel) return;
			if (!(await ensureVault(vaultPath))) return;
			const { openPaper } = await import("@/lib/workspace/actions");
			openPaper(joinVaultPath(vaultPath, rel));
			return;
		}
		case "open-path": {
			if (!vaultPath || !rel) return;
			if (!(await ensureVault(vaultPath))) return;
			const { openVaultRel } = await import("@/lib/workspace/actions");
			openVaultRel(rel);
			return;
		}
		case "close-path": {
			if (!vaultPath || !rel) return;
			// Closing only makes sense inside the active Vault.
			if (
				normalizeVault(vaultStore.getState().vaultPath) !==
				normalizeVault(vaultPath)
			) {
				return;
			}
			const { closeTabsUnderPath } = await import("@/lib/workspace/actions");
			closeTabsUnderPath(joinVaultPath(vaultPath, rel));
			return;
		}
		case "open-window": {
			const view = payload.window?.trim();
			if (view === "settings") {
				const { openSettingsWindow } = await import(
					"@/lib/shell/settings-window"
				);
				openSettingsWindow(payload.section?.trim() || "general");
				return;
			}
			if (view === "agent" || view === "annotations") {
				const { openFeatureWindow } = await import(
					"@/lib/shell/feature-window"
				);
				await openFeatureWindow(view);
			}
			return;
		}
	}
}

export function useUiRequest(): void {
	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		/** In-flight key so event + pending take do not double-open. */
		let inflight: string | null = null;
		let generation = 0;

		const handle = async (payload: UiRequestPayload | null | undefined) => {
			if (!payload?.action || cancelled) return;
			const key = JSON.stringify(payload);
			if (inflight === key) return;
			const gen = ++generation;
			inflight = key;
			try {
				// Host emits and also queues pending; drain the concurrent pair.
				try {
					await takePendingUiRequest();
				} catch {
					// Older Host or no pending — fine.
				}
				if (cancelled || gen !== generation) return;
				await dispatch(payload);
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			} finally {
				if (gen === generation) {
					inflight = null;
				}
			}
		};

		const off = listenEventSafe(events.uiRequest, (payload) => {
			void handle(payload);
		});

		// Startup race: Host may have queued a request before we listened.
		void (async () => {
			try {
				const pending = await takePendingUiRequest();
				if (!cancelled && pending) {
					await handle(pending);
				}
			} catch {
				// Non-fatal when the command is unavailable (older Host).
			}
		})();

		return () => {
			cancelled = true;
			off();
		};
	}, []);
}
