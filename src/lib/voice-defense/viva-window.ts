/**
 * Native singleton viva window (`?window=viva`).
 *
 * Desktop opens this instead of covering the main workbench with a portal.
 * Browser preview still uses the in-page overlay via `open-request.ts`.
 */

import i18n from "@/i18n";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { notifyError } from "@/lib/core/notify";
import { isMobileApp, isTauri } from "@/lib/core/tauri";
import { getVaultPath } from "@/lib/vault/store";

export const VIVA_WINDOW_LABEL = "viva";
export const VIVA_HANDOFF_EVENT = "viva:handoff";

export type VivaHandoffPayload = {
	selections: SelectionContext[];
	selectedAgentId: string | null;
	modelId: string | null;
};

export function isVivaWindowRoute(): boolean {
	try {
		return new URLSearchParams(window.location.search).get("window") === "viva";
	} catch {
		return false;
	}
}

export function readVivaWindowQuery(): {
	vaultPath: string | null;
	activePath: string | null;
	paperTitle: string | null;
} {
	try {
		const params = new URLSearchParams(window.location.search);
		return {
			vaultPath: params.get("vault_path"),
			activePath: params.get("active_path"),
			paperTitle: params.get("paper_title"),
		};
	} catch {
		return { vaultPath: null, activePath: null, paperTitle: null };
	}
}

/** True when this desktop session should spawn a native viva window. */
export function shouldOpenVivaAsWindow(): boolean {
	return isTauri() && !isMobileApp();
}

export async function openVivaWindow(): Promise<void> {
	if (!shouldOpenVivaAsWindow()) {
		notifyError(i18n.t("app:windows.featureDesktopOnly"));
		return;
	}
	try {
		const { getActiveTabId, getTabs } = await import("@/lib/workspace/store");
		const activeId = getActiveTabId();
		const active = activeId
			? (getTabs().find((tab) => tab.id === activeId) ?? null)
			: null;
		const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
		const existed = (await WebviewWindow.getByLabel(VIVA_WINDOW_LABEL)) != null;
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("viva_window_open", {
			vaultPath: getVaultPath(),
			activePath: active?.path ?? null,
			paperTitle: active?.paperMeta?.title ?? null,
			title: i18n.t("app:windows.titleViva"),
		});
		if (!existed) scheduleVivaHandoffFromMain();
	} catch (error) {
		notifyError(String(error));
	}
}

export async function closeCurrentVivaWindow(): Promise<boolean> {
	if (!isTauri()) return true;
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		// The user has already chosen to close. Force-destroy avoids re-entering
		// `onCloseRequested`, whose conditional handoff is only for native close
		// requests initiated from the system title bar.
		await getCurrentWindow().destroy();
		return true;
	} catch {
		return false;
	}
}

/** Snapshot main-window context for a newly created viva webview. */
export function scheduleVivaHandoffFromMain(): void {
	if (!isTauri()) return;
	void (async () => {
		try {
			const { selectionStore } = await import("@/lib/agent/selection-store");
			const { getAgentSessionState } = await import(
				"@/lib/agent/agent-session-store"
			);
			const { loadModelPref } = await import("@/lib/agent/api");
			const { active, pinned } = selectionStore.getState();
			const state = getAgentSessionState();
			const session =
				state.sessions.find((item) => item.id === state.activeTabId) ??
				state.sessions[0] ??
				null;
			const selectedAgentId = session?.agentId ?? null;
			const payload: VivaHandoffPayload = {
				selections: active ? [...pinned, active] : [...pinned],
				selectedAgentId,
				modelId: selectedAgentId ? loadModelPref(selectedAgentId) : null,
			};
			const { emit } = await import("@tauri-apps/api/event");
			const send = () => {
				void emit(VIVA_HANDOFF_EVENT, payload).catch(() => undefined);
			};
			if (
				typeof window === "undefined" ||
				typeof window.setTimeout !== "function"
			) {
				send();
				return;
			}
			for (const delay of [0, 120, 350, 900]) {
				window.setTimeout(send, delay);
			}
		} catch {
			// non-fatal
		}
	})();
}

export async function listenVivaHandoff(
	handler: (payload: VivaHandoffPayload) => void,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	const { listen } = await import("@tauri-apps/api/event");
	const unlisten = await listen<VivaHandoffPayload>(
		VIVA_HANDOFF_EVENT,
		(event) => {
			handler(event.payload);
		},
	);
	return unlisten;
}
