/**
 * Native singleton feature windows (Agent / Annotations).
 *
 * Policy: at most one surface per view. If a feature window is open, all open
 * intents focus that window and the main right-rail must not host
 * a second instance of the same view.
 *
 * Note: do not statically import `@/lib/shell/ui-store` — that store module is
 * read here; the opening actions that import this file live in
 * `ui-window-actions` (ui-window-actions → feature-window → ui-store).
 */

import i18n from "@/i18n";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { getVaultPath } from "@/lib/vault/store";

/** Same set as right-rail tabs / leaf feature views. */
export type FeatureViewType = "agent" | "annotations";

const FEATURE_TAB_ORDER: FeatureViewType[] = ["agent", "annotations"];

function featureWindowTitle(view: FeatureViewType): string {
	switch (view) {
		case "agent":
			return i18n.t("app:windows.titleAgent");
		case "annotations":
			return i18n.t("app:windows.titleAnnotations");
	}
}

export function featureWindowLabel(view: FeatureViewType): string {
	return `feature-${view}`;
}

/**
 * Drop main-window *content* for a view that now lives in a singleton window
 * (avoids dual Agent panels, etc.). Does **not** collapse the right rail —
 * title-bar feature switcher buttons must stay available for other views.
 */
async function clearMainHostForFeature(view: FeatureViewType): Promise<void> {
	const ui = await import("@/lib/shell/ui-store");
	ui.setFeaturePoppedOut(view, true);
	if (view === "agent") {
		ui.setAgentPanelMounted(false);
	}
	// Rail stays open. If the selected rail tab is the one now in a window,
	// switch to another non-popped-out tab so the switcher + content remain usable.
	const { rightSidebarTab, featurePoppedOut } = ui.uiStore.getState();
	if (rightSidebarTab !== view) return;
	const next = FEATURE_TAB_ORDER.find(
		(t) => t !== view && !featurePoppedOut[t],
	);
	if (!next) return;
	ui.setRightSidebarTab(next);
	if (next === "agent") ui.setAgentPanelMounted(true);
}

/** Open or focus the singleton feature window for `view`. */
export async function openFeatureWindow(view: FeatureViewType): Promise<void> {
	if (!isTauri()) {
		notifyError(i18n.t("app:windows.featureDesktopOnly"));
		return;
	}
	try {
		const { getActiveTabId, getTabs } = await import("@/lib/workspace/store");
		const activeId = getActiveTabId();
		const active = activeId
			? (getTabs().find((t) => t.id === activeId) ?? null)
			: null;
		const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
		const existed =
			(await WebviewWindow.getByLabel(featureWindowLabel(view))) != null;
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("feature_window_open", {
			view,
			vaultPath: getVaultPath(),
			activePath: active?.path ?? null,
			paperTitle: active?.paperMeta?.title ?? null,
			title: featureWindowTitle(view),
		});
		await clearMainHostForFeature(view);
		// Existing feature windows only get focused — re-broadcast so they follow.
		const { broadcastWorkspaceActive, scheduleAgentSessionHandoffFromMain } =
			await import("@/lib/shell/workspace-broadcast");
		broadcastWorkspaceActive({
			path: active?.path ?? null,
			vaultPath: getVaultPath(),
			paperTitle: active?.paperMeta?.title ?? null,
		});
		// New Agent window only: push the open conversation so the popout
		// continues the same chat (do not re-handoff on focus — would clobber
		// in-window progress with a stale main snapshot).
		if (view === "agent" && !existed) {
			scheduleAgentSessionHandoffFromMain();
		}
	} catch (e) {
		notifyError(String(e));
	}
}

/**
 * Probe whether the singleton feature Webview exists and focus it.
 * Only clears `featurePoppedOut` when the label is confirmed missing — not on
 * transient focus/API errors (avoids opening a second rail instance).
 */
export async function focusFeatureWindow(
	view: FeatureViewType,
): Promise<boolean> {
	if (!isTauri()) return false;
	let win: Awaited<
		ReturnType<
			typeof import("@tauri-apps/api/webviewWindow")["WebviewWindow"]["getByLabel"]
		>
	> = null;
	try {
		const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
		win = await WebviewWindow.getByLabel(featureWindowLabel(view));
	} catch {
		// Lookup failed — keep poppedOut flag; do not open a rail duplicate.
		return false;
	}
	if (!win) {
		const { setFeaturePoppedOut } = await import("@/lib/shell/ui-store");
		setFeaturePoppedOut(view, false);
		return false;
	}
	try {
		await win.setFocus();
		await clearMainHostForFeature(view);
		return true;
	} catch {
		// Window still exists; leave featurePoppedOut true.
		return false;
	}
}

/**
 * Prefer an existing singleton feature window over the main right rail.
 * Returns true when the window was found and focused.
 */
export async function preferFeatureWindow(
	view: FeatureViewType,
): Promise<boolean> {
	return focusFeatureWindow(view);
}

/** True when this webview is a feature popout (`?window=feature`). */
export function isFeatureWindowRoute(): boolean {
	try {
		return (
			new URLSearchParams(window.location.search).get("window") === "feature"
		);
	} catch {
		return false;
	}
}

export function isFeatureViewType(
	value: string | null | undefined,
): value is FeatureViewType {
	return FEATURE_TAB_ORDER.includes(value as FeatureViewType);
}

export function readFeatureWindowView(): FeatureViewType | null {
	try {
		const view = new URLSearchParams(window.location.search).get("view");
		return isFeatureViewType(view) ? view : null;
	} catch {
		return null;
	}
}

export async function isFeaturePoppedOut(
	view: FeatureViewType,
): Promise<boolean> {
	const { uiStore } = await import("@/lib/shell/ui-store");
	return uiStore.getState().featurePoppedOut[view] === true;
}
