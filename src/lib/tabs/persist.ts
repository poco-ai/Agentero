import type { DocTab } from "@/lib/tabs/model";
import type { CenterViewMode } from "@/lib/viewer";

// --- Tab session persistence (per-window, best-effort localStorage) ---

const TABS_STORAGE_KEY = "agentero-open-tabs";

export type PersistedTab = { path: string; mode: CenterViewMode };
export type PersistedTabs = { tabs: PersistedTab[]; activeIndex: number };

/** Read and validate the previously persisted open tabs for this window. */
export function loadPersistedTabs(): PersistedTabs | null {
	try {
		const raw = localStorage.getItem(TABS_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as PersistedTabs;
		if (!parsed || !Array.isArray(parsed.tabs)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Persist the current open tabs and active index (best-effort). */
export function savePersistedTabs(
	tabs: DocTab[],
	activeTabId: string | null,
): void {
	try {
		const payload: PersistedTabs = {
			tabs: tabs.map((t) => ({ path: t.path, mode: t.mode })),
			activeIndex: Math.max(
				0,
				tabs.findIndex((t) => t.id === activeTabId),
			),
		};
		if (payload.tabs.length) {
			localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(payload));
		} else {
			localStorage.removeItem(TABS_STORAGE_KEY);
		}
	} catch {
		// localStorage may be unavailable; tab restore is best-effort.
	}
}
