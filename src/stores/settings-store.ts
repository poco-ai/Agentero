/**
 * Live application settings, backed by a Zustand store.
 *
 * The schema, defaults, and normalization live in `@/lib/settings` (pure); this
 * module owns the *state*: the in-memory snapshot, Host persistence
 * (`settings_get` / `settings_set`), and cross-window sync via the
 * `settings:changed` broadcast. React components read it with {@link useSettings};
 * non-React callers read the synchronous {@link loadSettings} snapshot.
 */

import { ipc } from "@/lib/ipc";
import {
	type AppSettings,
	clearLegacyLocalStorage,
	cloneSettings,
	DEFAULT_SETTINGS,
	normalizeSettings,
	readLegacyLocalStorage,
} from "@/lib/settings";
import { isTauri } from "@/lib/tauri";
import { createAppStore } from "@/stores/create";

type SettingsState = {
	settings: AppSettings;
};

type SettingsGetResult = {
	settings: AppSettings;
	path: string;
	existed: boolean;
};

export const settingsStore = createAppStore<SettingsState>(() => ({
	settings: cloneSettings(DEFAULT_SETTINGS),
}));

let loaded = false;
let loadPromise: Promise<AppSettings> | null = null;
let syncStarted = false;

function currentSettings(): AppSettings {
	return settingsStore.store.getState().settings;
}

/** Replace the live snapshot with a cloned, already-normalized value. */
function commit(next: AppSettings): AppSettings {
	const settings = cloneSettings(next);
	settingsStore.store.setState({ settings });
	return settings;
}

/**
 * Synchronous read of the in-memory settings (clone).
 * Call {@link ensureSettingsLoaded} at boot so this reflects the file on disk.
 */
export function loadSettings(): AppSettings {
	return cloneSettings(currentSettings());
}

/** React hook: subscribe to the live settings snapshot. */
export function useSettings(): AppSettings {
	return settingsStore.use((s) => s.settings);
}

/**
 * Load settings from Host XDG config (`settings.json`).
 * One-shot: migrates legacy `localStorage` when the file does not exist yet.
 */
export async function ensureSettingsLoaded(): Promise<AppSettings> {
	if (loaded) return loadSettings();
	if (loadPromise) return loadPromise;
	loadPromise = (async () => {
		try {
			if (isTauri()) {
				const res = await ipc<SettingsGetResult>("settings_get");
				let next = normalizeSettings(res.settings);

				if (!res.existed) {
					const legacy = readLegacyLocalStorage();
					if (legacy) {
						next = normalizeSettings(legacy);
						await persistToHost(next);
					}
				}
				// Drop dual-source: file is authoritative after first load.
				clearLegacyLocalStorage();
				commit(next);
			} else {
				// Browser-only dev: no XDG file; keep in-memory defaults
				// (optional one-shot hydrate from legacy key for web preview).
				const legacy = readLegacyLocalStorage();
				if (legacy) commit(normalizeSettings(legacy));
			}
		} catch (e) {
			console.warn("[settings] load failed, using defaults", e);
			commit({ ...DEFAULT_SETTINGS });
		} finally {
			loaded = true;
		}
		return loadSettings();
	})();
	return loadPromise;
}

/**
 * Update the snapshot and persist to Host `settings.json` (Tauri).
 * Fire-and-forget on the write path so UI stays snappy; errors are logged.
 */
export function saveSettings(settings: AppSettings): void {
	const next = normalizeSettings(settings);
	commit(next);
	if (!isTauri()) return;
	void persistToHost(next).catch((e) => {
		console.warn("[settings] save failed", e);
	});
}

async function persistToHost(settings: AppSettings): Promise<AppSettings> {
	const saved = await ipc<AppSettings>("settings_set", { settings });
	return commit(normalizeSettings(saved));
}

/**
 * Apply a settings snapshot broadcast by the Host (`settings:changed`).
 * Skips no-op echoes of a value this window just persisted so equal broadcasts
 * do not churn subscribers.
 */
export function applyExternalSettings(raw: AppSettings): void {
	const next = normalizeSettings(raw);
	if (JSON.stringify(currentSettings()) === JSON.stringify(next)) return;
	commit(next);
}

/**
 * Start listening for cross-window `settings:changed` broadcasts (Tauri only).
 * Called once at boot; keeps this window's snapshot fresh when the settings
 * window (or another main window) persists changes.
 */
export function initSettingsSync(): void {
	if (syncStarted || !isTauri()) return;
	syncStarted = true;
	void (async () => {
		try {
			const { listen } = await import("@tauri-apps/api/event");
			await listen<AppSettings>("settings:changed", (event) => {
				applyExternalSettings(event.payload);
			});
		} catch (e) {
			console.warn("[settings] sync listener failed", e);
		}
	})();
}
