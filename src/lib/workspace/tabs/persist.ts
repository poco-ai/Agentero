import { perfActive } from "@/lib/core/perf";
import {
	readStorageRaw,
	removeStorageKey,
	writeJsonStorage,
	writeStorageRaw,
} from "@/lib/core/storage";
import { isRemoteArxivPath } from "@/lib/paper";
import { tabIdForPath } from "@/lib/workspace/tabs/model";
import type {
	DocTab,
	PanelPersistParams,
	PersistedTab,
	PersistedTabs,
} from "@/lib/workspace/tabs/types";
import { isCenterViewMode } from "@/lib/workspace/viewer";

const TABS_STORAGE_KEY = "agentero-open-tabs";
const TABS_ROLLBACK_KEY = "agentero-open-tabs.rollback";

/**
 * Last primary-key read was corrupt or yielded no tabs.
 * A later null layout write must not delete that key.
 */
let retainUnreadableLayout = false;

export function persistedLayoutIsUnreadable(): boolean {
	return retainUnreadableLayout;
}

/** False when a null layout would erase a key the last read could not restore. */
export function shouldWritePersistedLayout(layout: unknown | null): boolean {
	if (layout == null && retainUnreadableLayout) return false;
	return true;
}

/** Copy the primary key's raw text into the rollback key once, before overwrite. */
function retainPrimaryRawForRollback(): void {
	if (readStorageRaw(TABS_ROLLBACK_KEY).status !== "missing") return;
	const current = readStorageRaw(TABS_STORAGE_KEY);
	if (current.status !== "present") return;
	writeStorageRaw(TABS_ROLLBACK_KEY, current.raw);
}

export function panelPersistParams(tab: DocTab): PanelPersistParams {
	return {
		panelId: tab.id,
		path: tab.path,
		mode: tab.mode,
		title: tab.title,
		...(tab.texLive ? { texLive: true } : {}),
		...(tab.texRoot ? { texRoot: tab.texRoot } : {}),
	};
}

type LayoutPanelState = {
	id?: string;
	params?: {
		panelId?: string;
		path?: string;
		mode?: string;
		title?: string;
		texLive?: boolean;
		texRoot?: string;
	};
};

type LayoutLeafData = {
	id?: string;
	views?: string[];
	activeView?: string;
};

/**
 * Walk a SerializedDockview grid for the active panel id
 * (activeGroup → leaf activeView).
 */
function findActivePanelIdInLayout(layout: {
	activeGroup?: string;
	grid?: { root?: unknown };
}): string | null {
	const activeGroup = layout.activeGroup;
	const walk = (node: unknown): string | null => {
		if (!node || typeof node !== "object") return null;
		const n = node as { type?: string; data?: unknown };
		if (n.type === "leaf" && n.data && typeof n.data === "object") {
			const data = n.data as LayoutLeafData;
			if (activeGroup && data.id !== activeGroup) return null;
			return data.activeView ?? data.views?.[0] ?? null;
		}
		if (n.type === "branch" && Array.isArray(n.data)) {
			for (const child of n.data) {
				const hit = walk(child);
				if (hit) return hit;
			}
		}
		return null;
	};
	return walk(layout.grid?.root) ?? null;
}

/**
 * Derive flat panel list + active id from a dockview `toJSON()` snapshot.
 * Prefers `params.path` / `params.mode`; falls back to panel id as path.
 */
export function extractTabsFromLayout(layout: unknown): {
	tabs: PersistedTab[];
	activeId: string | null;
} {
	if (!layout || typeof layout !== "object") {
		return { tabs: [], activeId: null };
	}
	const l = layout as {
		panels?: Record<string, LayoutPanelState>;
		activeGroup?: string;
		grid?: { root?: unknown };
	};
	if (!l.panels || typeof l.panels !== "object") {
		return { tabs: [], activeId: null };
	}
	const tabs: PersistedTab[] = [];
	const seen = new Set<string>();
	for (const [id, panel] of Object.entries(l.panels)) {
		const path =
			typeof panel.params?.path === "string" && panel.params.path
				? panel.params.path
				: id;
		if (isRemoteArxivPath(path)) continue;
		const mode = isCenterViewMode(panel.params?.mode)
			? panel.params.mode
			: "markdown";
		const panelId =
			typeof panel.params?.panelId === "string" && panel.params.panelId
				? panel.params.panelId
				: id;
		const title =
			typeof panel.params?.title === "string" && panel.params.title.trim()
				? panel.params.title
				: undefined;
		if (seen.has(panelId)) continue;
		seen.add(panelId);
		tabs.push({
			id: panelId,
			path,
			mode,
			title,
			...(panel.params?.texLive === true ? { texLive: true } : {}),
			...(typeof panel.params?.texRoot === "string" &&
			panel.params.texRoot.trim()
				? { texRoot: panel.params.texRoot }
				: {}),
		});
	}
	const activeId = findActivePanelIdInLayout(l);
	return {
		tabs,
		activeId:
			activeId && seen.has(activeId)
				? activeId
				: tabs[0]
					? (tabs[0].id ?? tabIdForPath(tabs[0].path))
					: null,
	};
}

/** Read the previously persisted workspace for this window. */
export function loadPersistedTabs(): PersistedTabs | null {
	const stored = readStorageRaw(TABS_STORAGE_KEY);
	if (stored.status === "missing" || stored.status === "unavailable") {
		retainUnreadableLayout = false;
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stored.raw);
	} catch {
		retainUnreadableLayout = true;
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		retainUnreadableLayout = true;
		return null;
	}

	const record = parsed as {
		layout?: unknown | null;
		/** @deprecated layout-only storage; still accepted for one-shot restore */
		tabs?: Array<{ path?: string; mode?: string }>;
		/** @deprecated */
		activeIndex?: number;
	};

	// Preferred: layout alone (params carry path/mode). An unknown `version`
	// is ignored when a usable layout or tabs list is still present.
	if (record.layout != null && typeof record.layout === "object") {
		const extracted = extractTabsFromLayout(record.layout);
		if (!extracted.tabs.length) {
			retainUnreadableLayout = true;
			return null;
		}
		retainUnreadableLayout = false;
		return {
			tabs: extracted.tabs,
			activeId: extracted.activeId,
			layout: record.layout,
		};
	}

	// Legacy: explicit tabs[] without layout (pre layout-only storage).
	if (!Array.isArray(record.tabs) || !record.tabs.length) {
		retainUnreadableLayout = true;
		return null;
	}
	const flat: PersistedTab[] = [];
	const seen = new Set<string>();
	for (const pt of record.tabs) {
		if (!pt || typeof pt.path !== "string" || !pt.path) continue;
		if (isRemoteArxivPath(pt.path)) continue;
		const id = tabIdForPath(pt.path);
		if (seen.has(id)) continue;
		seen.add(id);
		flat.push({
			path: pt.path,
			mode: isCenterViewMode(pt.mode) ? pt.mode : "markdown",
		});
	}
	if (!flat.length) {
		retainUnreadableLayout = true;
		return null;
	}
	retainUnreadableLayout = false;
	const idx = Math.min(Math.max(0, record.activeIndex ?? 0), flat.length - 1);
	const activePath = flat[idx]?.path;
	return {
		tabs: flat,
		activeId: activePath ? tabIdForPath(activePath) : null,
		layout: null,
	};
}

/**
 * Persist dockview layout only (panel list, order, active, path/mode in params).
 * Empty / missing layout clears storage.
 */
export function savePersistedTabs(layout: unknown | null): void {
	// A perf run shares WebView storage with the daily app. Do not replace
	// the user's open tabs, and do not clear them when this process starts empty.
	if (perfActive()) return;
	retainPrimaryRawForRollback();
	if (layout == null || typeof layout !== "object") {
		removeStorageKey(TABS_STORAGE_KEY);
		return;
	}
	const panels = (layout as { panels?: Record<string, unknown> }).panels;
	if (!panels || !Object.keys(panels).length) {
		removeStorageKey(TABS_STORAGE_KEY);
		return;
	}
	// localStorage may be unavailable; tab restore is best-effort.
	writeJsonStorage(TABS_STORAGE_KEY, { layout });
}
