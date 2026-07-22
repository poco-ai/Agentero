import type { CachedModelCatalog } from "@/lib/agent/types";

const MODEL_PREF_KEY = "agentero-agent-model-pref";

/** Persist last chosen model id per agent. */
export function loadModelPref(agentId: string | null): string | null {
	if (!agentId) return null;
	try {
		const raw = localStorage.getItem(MODEL_PREF_KEY);
		if (!raw) return null;
		const map = JSON.parse(raw) as Record<string, string>;
		return map[agentId] ?? null;
	} catch {
		return null;
	}
}

export function saveModelPref(agentId: string, modelId: string): void {
	try {
		const raw = localStorage.getItem(MODEL_PREF_KEY);
		const map = (raw ? JSON.parse(raw) : {}) as Record<string, string>;
		map[agentId] = modelId;
		localStorage.setItem(MODEL_PREF_KEY, JSON.stringify(map));
	} catch {
		// ignore
	}
}

const MODEL_FAVORITES_KEY = "agentero-agent-model-favorites";

/** Per-agent ordered list of favorited model ids. */
export function loadModelFavorites(agentId: string | null): string[] {
	if (!agentId) return [];
	try {
		const raw = localStorage.getItem(MODEL_FAVORITES_KEY);
		if (!raw) return [];
		const map = JSON.parse(raw) as Record<string, string[]>;
		const list = map[agentId];
		return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
}

export function saveModelFavorites(agentId: string, ids: string[]): void {
	try {
		const raw = localStorage.getItem(MODEL_FAVORITES_KEY);
		const map = (raw ? JSON.parse(raw) : {}) as Record<string, string[]>;
		map[agentId] = ids;
		localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(map));
	} catch {
		// ignore
	}
}

const MODEL_CATALOG_KEY = "agentero-agent-model-catalog";

export function loadModelCatalog(
	agentId: string | null,
): CachedModelCatalog | null {
	if (!agentId) return null;
	try {
		const raw = localStorage.getItem(MODEL_CATALOG_KEY);
		if (!raw) return null;
		const map = JSON.parse(raw) as Record<string, CachedModelCatalog>;
		return map[agentId] ?? null;
	} catch {
		return null;
	}
}

export function saveModelCatalog(
	agentId: string,
	catalog: CachedModelCatalog,
): void {
	try {
		const raw = localStorage.getItem(MODEL_CATALOG_KEY);
		const map = (raw ? JSON.parse(raw) : {}) as Record<
			string,
			CachedModelCatalog
		>;
		map[agentId] = catalog;
		localStorage.setItem(MODEL_CATALOG_KEY, JSON.stringify(map));
	} catch {
		// ignore
	}
}
