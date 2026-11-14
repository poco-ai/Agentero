/**
 * Zotero Connector server sync: bind the active vault + Library folder scope,
 * honor the settings toggle, and react to save/error events. Attachment
 * progress rows come from the JobCenter relay (`lib/paper/import/connector-tasks`).
 * Extracted from App so connector traffic never re-renders the shell.
 */

import { useEffect } from "react";
import {
	useLibraryStore,
	useSettings,
	useVaultStore,
} from "@/hooks/use-app-stores";
import i18n from "@/i18n";
import { events } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { listenEventSafe } from "@/lib/core/tauri-events";
import {
	connectorSetEnabled,
	connectorSetParentDir,
	connectorSetVault,
} from "@/lib/paper/import/connector";
import { connectorStatusError } from "@/lib/paper/import/connector-errors";
import { scheduleLibraryRefresh } from "@/lib/paper/library-store";
import { joinVaultPath } from "@/lib/vault";
import { getVaultPath, scheduleTreeRefresh } from "@/lib/vault/store";
import { openPaper } from "@/lib/workspace/actions";

export function useConnectorSync(): void {
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const libraryScopePath = useLibraryStore((s) => s.scopePath);
	const connectorEnabled = useSettings((s) => s.connectorEnabled);

	// Sync active vault into the Connector server (save target).
	useEffect(() => {
		if (!isTauri()) return;
		void connectorSetVault(vaultPath).catch((e) => {
			console.warn("[connector] setVault failed", e);
		});
	}, [vaultPath]);

	// Mirror Library folder scope → Connector default collection.
	useEffect(() => {
		if (!isTauri() || !connectorEnabled) return;
		const scope = libraryScopePath
			?.replace(/\\/g, "/")
			.replace(/^\/+|\/+$/g, "");
		const parent =
			scope && (scope === "papers" || scope.startsWith("papers/"))
				? scope
				: "papers";
		void connectorSetParentDir(parent).catch(() => {
			/* ignore */
		});
	}, [libraryScopePath, connectorEnabled]);

	// Restore Connector server from settings on launch / toggle.
	useEffect(() => {
		if (!isTauri()) return;
		void connectorSetEnabled(connectorEnabled)
			.then(async (st) => {
				const message = connectorStatusError(
					st,
					i18n.getFixedT(null, "settings"),
				);
				if (connectorEnabled && message) {
					notifyError(message);
				}
				// After the HTTP server starts, re-bind vault (Host may be unbound).
				if (connectorEnabled && getVaultPath()) {
					try {
						await connectorSetVault(getVaultPath());
					} catch (e) {
						console.warn("[connector] re-bind vault after enable failed", e);
					}
				}
			})
			.catch((e) => {
				notifyError(errorText(e));
			});
	}, [connectorEnabled]);

	// Refresh tree/library when the Connector saves into the vault; open the
	// paper tab (same as magic-wand import).
	useEffect(() => {
		const offs = [
			listenEventSafe(events.connectorItemSaved, (p) => {
				const vault = getVaultPath();
				if (vault) {
					// Debounced: import saves coalesce with the paper:imported
					// handler; non-import saves (upload, move) still refresh here.
					scheduleTreeRefresh();
					scheduleLibraryRefresh();
				}
				// Open/focus the paper tab (metadata save, upload, or move).
				const rel = (p?.path ?? "")
					.replace(/\\/g, "/")
					.replace(/^\/+|\/+$/g, "");
				if (vault && rel) {
					openPaper(joinVaultPath(vault, rel));
				}
			}),
			listenEventSafe(events.connectorError, (payload) => {
				const msg = payload?.message?.trim();
				if (msg) notifyError(msg);
			}),
		];
		return () => {
			for (const off of offs) off();
		};
	}, []);
}
