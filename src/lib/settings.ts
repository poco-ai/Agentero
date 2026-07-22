import { ipc } from "@/lib/ipc";
import {
	isPaperTreeLabelMode,
	isPaperTreeSortMode,
	type PaperTreeLabelMode,
	type PaperTreeSortMode,
} from "@/lib/paper-metadata";
import { isTauri } from "@/lib/tauri";
import { DEFAULT_TRANSLATE_SETTINGS } from "@/lib/translate/defaults";
import { isTranslateProviderId } from "@/lib/translate/services";
import type {
	TranslateProviderId,
	TranslateSettings,
	TranslateTargetLang,
} from "@/lib/translate/types";
import { DEFAULT_UI_THEME, isKnownUiTheme } from "@/lib/ui-theme";

export type {
	PaperTreeLabelMode,
	PaperTreeSortMode,
	TranslateProviderId,
	TranslateSettings,
	TranslateTargetLang,
};

export type ThemePreference = "system" | "light" | "dark";

export type LocalePreference = "system" | "en" | "zh-CN";

/** Sortable / customizable columns in the papers Library table. */
export type LibraryColumnKey =
	| "title"
	| "authors"
	| "year"
	| "tags"
	| "type"
	| "id";

/** Per-column display preference: order comes from array position. */
export type LibraryColumnPref = {
	key: LibraryColumnKey;
	visible: boolean;
};

/** Canonical column order (also the source of truth for reconciliation). */
export const LIBRARY_COLUMN_KEYS: LibraryColumnKey[] = [
	"title",
	"authors",
	"year",
	"tags",
	"type",
	"id",
];

/** Default: every column visible, in canonical order. */
export const DEFAULT_LIBRARY_COLUMNS: LibraryColumnPref[] =
	LIBRARY_COLUMN_KEYS.map((key) => ({ key, visible: true }));

/**
 * How Agentero responds to agent permission escalations.
 * - `restricted`: decline requests (Codex uses workspace-write).
 * - `ask`: forward each request to the user for an explicit decision.
 * - `auto`: auto-approve every request (YOLO; Codex uses danger-full-access).
 */
export type AgentPermissionMode = "restricted" | "ask" | "auto";

/**
 * Language every agent response (and notes written to files) should use.
 * Independent from the UI `locale`. `auto` injects no directive (agent decides).
 */
export type AiResponseLanguage = "auto" | "en" | "zh-CN";

export type AppSettings = {
	// General
	restoreLastVault: boolean;
	confirmBeforeClose: boolean;
	/**
	 * Translator Runtime base URL for magic-wand / identifier import.
	 * Default: hosted poco-ai service.
	 */
	translatorBaseUrl: string;
	/**
	 * How paper folders are labeled in the file tree (display-only).
	 * Default: title · author.
	 */
	paperTreeLabelMode: PaperTreeLabelMode;
	/**
	 * How siblings under each folder are ordered in the file tree (display-only).
	 * Default: display name A–Z (matches paperTreeLabelMode labels).
	 */
	paperTreeSortMode: PaperTreeSortMode;
	/**
	 * Papers Library table columns: order (array position) + visibility.
	 * Reconciled against {@link LIBRARY_COLUMN_KEYS}; `title` is always visible.
	 */
	libraryColumns: LibraryColumnPref[];
	/**
	 * Host local HTTP server compatible with the official Zotero Connector
	 * (loopback :23119). Default **off**; mutually exclusive with Zotero desktop.
	 */
	connectorEnabled: boolean;
	connectorPort: number;
	// Appearance
	theme: ThemePreference;
	/**
	 * Bundled tweakcn color theme name; `"default"` keeps the built-in look.
	 * See src/lib/ui-theme.ts.
	 */
	uiTheme: string;
	locale: LocalePreference;
	editorFontSize: number;
	/** Show the WYSIWYG formatting toolbar above Markdown/notes editors. */
	showEditorToolbar: boolean;
	// Agent (local UI prefs; registry lives in Host agents.json)
	agentEnabled: boolean;
	/** Global permission handling applied to every agent run. */
	agentPermissionMode: AgentPermissionMode;
	/**
	 * After magic-wand import / single-paper Download, auto-run paper-reader
	 * when assets are ready and catalog `is_read` is false.
	 * Default **off**; Zap still works for manual runs.
	 */
	autoPaperReader: boolean;
	/** Language forced onto every agent response and generated notes. */
	aiResponseLanguage: AiResponseLanguage;
	/**
	 * Free-form user preference instructions injected into every agent
	 * prompt envelope (Composer, paper-reader, workflows, …). Empty = off.
	 */
	agentPersonalPrompt: string;
	/**
	 * Agent seat + model for PDF selection Ask dialogs (划词提问).
	 * Independent of Chat's current agent and of translate.agentId.
	 * Empty agentId / modelId = follow app default agent / that agent's model pref.
	 */
	pdfAsk: PdfAskSettings;
	// Privacy
	analyticsEnabled: boolean;
	shareCrashReports: boolean;
	/** Application-level translation service (free MT + BYOA Agent). */
	translate: TranslateSettings;
};

/** PDF selection Ask (question popover) agent/model prefs. */
export type PdfAskSettings = {
	/** Empty = follow registry default agent. */
	agentId: string;
	/** Empty = follow loadModelPref(agentId). */
	modelId: string;
};

export const DEFAULT_PDF_ASK_SETTINGS: PdfAskSettings = {
	agentId: "",
	modelId: "",
};

/** Default Translator Runtime endpoint (overridable in Settings). */
export const DEFAULT_TRANSLATOR_BASE_URL = "https://translator.philfan.cn";

export const DEFAULT_SETTINGS: AppSettings = {
	restoreLastVault: true,
	confirmBeforeClose: false,
	translatorBaseUrl: DEFAULT_TRANSLATOR_BASE_URL,
	paperTreeLabelMode: "title-author",
	paperTreeSortMode: "folder",
	libraryColumns: DEFAULT_LIBRARY_COLUMNS.map((c) => ({ ...c })),
	connectorEnabled: false,
	connectorPort: 23119,
	theme: "system",
	uiTheme: DEFAULT_UI_THEME,
	locale: "system",
	editorFontSize: 14,
	showEditorToolbar: true,
	agentEnabled: true,
	agentPermissionMode: "restricted",
	autoPaperReader: false,
	aiResponseLanguage: "auto",
	agentPersonalPrompt: "",
	pdfAsk: { ...DEFAULT_PDF_ASK_SETTINGS },
	analyticsEnabled: false,
	shareCrashReports: false,
	translate: { ...DEFAULT_TRANSLATE_SETTINGS },
};

/** Legacy browser key — only used once to migrate into Host `settings.json`. */
const LEGACY_SETTINGS_KEY = "agentero-settings";

type SettingsGetResult = {
	settings: AppSettings;
	path: string;
	existed: boolean;
};

/** In-memory snapshot (source of truth between Host round-trips). */
let cache: AppSettings = {
	...DEFAULT_SETTINGS,
	libraryColumns: DEFAULT_LIBRARY_COLUMNS.map((c) => ({ ...c })),
	translate: { ...DEFAULT_TRANSLATE_SETTINGS },
	pdfAsk: { ...DEFAULT_PDF_ASK_SETTINGS },
};
let loaded = false;
let loadPromise: Promise<AppSettings> | null = null;
/** Absolute path reported by Host (empty until loaded in Tauri). */
let settingsFilePath = "";

function cloneSettings(s: AppSettings): AppSettings {
	return {
		...s,
		libraryColumns: s.libraryColumns.map((c) => ({ ...c })),
		pdfAsk: { ...s.pdfAsk },
		translate: { ...s.translate },
	};
}

function setCache(s: AppSettings): AppSettings {
	cache = cloneSettings(s);
	return cache;
}

/**
 * Synchronous read of the in-memory cache.
 * Call {@link ensureSettingsLoaded} at boot so this reflects the file on disk.
 */
export function loadSettings(): AppSettings {
	return cloneSettings(cache);
}

/** Absolute path to Host settings file, if known. */
export function getSettingsFilePath(): string {
	return settingsFilePath;
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
				settingsFilePath = res.path;
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
				setCache(next);
			} else {
				// Browser-only dev: no XDG file; keep in-memory defaults
				// (optional one-shot hydrate from legacy key for web preview).
				const legacy = readLegacyLocalStorage();
				if (legacy) setCache(normalizeSettings(legacy));
			}
		} catch (e) {
			console.warn("[settings] load failed, using defaults", e);
			setCache({ ...DEFAULT_SETTINGS });
		} finally {
			loaded = true;
		}
		return loadSettings();
	})();
	return loadPromise;
}

/**
 * Update cache and persist to Host `settings.json` (Tauri).
 * Fire-and-forget on the write path so UI stays snappy; errors are logged.
 */
export function saveSettings(settings: AppSettings): void {
	const next = normalizeSettings(settings);
	setCache(next);
	if (!isTauri()) return;
	void persistToHost(next).catch((e) => {
		console.warn("[settings] save failed", e);
	});
}

type SettingsListener = (settings: AppSettings) => void;

const settingsListeners = new Set<SettingsListener>();

/** Subscribe to settings changes coming from other windows. Returns unsubscribe. */
export function subscribeSettings(listener: SettingsListener): () => void {
	settingsListeners.add(listener);
	return () => {
		settingsListeners.delete(listener);
	};
}

/** Apply a settings snapshot broadcast by the Host (`settings:changed`). */
export function applyExternalSettings(raw: AppSettings): void {
	const next = normalizeSettings(raw);
	setCache(next);
	for (const listener of settingsListeners) {
		try {
			listener(loadSettings());
		} catch (e) {
			console.warn("[settings] listener failed", e);
		}
	}
}

let syncStarted = false;

/**
 * Start listening for cross-window `settings:changed` broadcasts (Tauri only).
 * Called once at boot; keeps this window's cache + subscribers fresh when the
 * settings window (or another main window) persists changes.
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

/** Awaitable save (settings UI / tests). */
export async function saveSettingsAsync(
	settings: AppSettings,
): Promise<AppSettings> {
	const next = normalizeSettings(settings);
	setCache(next);
	if (!isTauri()) return loadSettings();
	return persistToHost(next);
}

async function persistToHost(settings: AppSettings): Promise<AppSettings> {
	const saved = await ipc<AppSettings>("settings_set", { settings });
	return setCache(normalizeSettings(saved));
}

function readLegacyLocalStorage(): AppSettings | null {
	try {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<AppSettings> & {
			agentBaseUrl?: string;
			agentApiKey?: string;
			agentModel?: string;
			agentYolo?: boolean;
			downloadFulltextToLocal?: boolean;
			downloadFulltextWhenNoRemotePreview?: boolean;
		};
		return normalizePartial(parsed);
	} catch {
		return null;
	}
}

function clearLegacyLocalStorage(): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.removeItem(LEGACY_SETTINGS_KEY);
	} catch {
		// ignore
	}
}

function normalizeSettings(raw: AppSettings): AppSettings {
	return normalizePartial(raw);
}

function normalizePartial(
	parsed: Partial<AppSettings> & {
		agentBaseUrl?: string;
		agentApiKey?: string;
		agentModel?: string;
		agentYolo?: boolean;
		downloadFulltextToLocal?: boolean;
		downloadFulltextWhenNoRemotePreview?: boolean;
	},
): AppSettings {
	const {
		agentBaseUrl: _u,
		agentApiKey: _k,
		agentModel: _m,
		agentYolo: _y,
		downloadFulltextToLocal: _d1,
		downloadFulltextWhenNoRemotePreview: _d2,
		...rest
	} = parsed;
	const merged = { ...DEFAULT_SETTINGS, ...rest };
	if (
		parsed.agentYolo !== undefined &&
		rest.agentPermissionMode === undefined
	) {
		merged.agentPermissionMode = parsed.agentYolo ? "auto" : "restricted";
	}
	if (!merged.translatorBaseUrl?.trim()) {
		merged.translatorBaseUrl = DEFAULT_TRANSLATOR_BASE_URL;
	} else {
		merged.translatorBaseUrl = merged.translatorBaseUrl
			.trim()
			.replace(/\/+$/, "");
	}
	if (!isPaperTreeLabelMode(merged.paperTreeLabelMode)) {
		merged.paperTreeLabelMode = DEFAULT_SETTINGS.paperTreeLabelMode;
	}
	if (!isPaperTreeSortMode(merged.paperTreeSortMode)) {
		merged.paperTreeSortMode = DEFAULT_SETTINGS.paperTreeSortMode;
	}
	merged.libraryColumns = normalizeLibraryColumns(merged.libraryColumns);
	if (typeof parsed.autoPaperReader !== "boolean") {
		merged.autoPaperReader = DEFAULT_SETTINGS.autoPaperReader;
	}
	if (typeof parsed.agentPersonalPrompt !== "string") {
		merged.agentPersonalPrompt = DEFAULT_SETTINGS.agentPersonalPrompt;
	} else {
		// Cap extreme values from hand-edited storage; UI does not enforce a hard max.
		merged.agentPersonalPrompt = parsed.agentPersonalPrompt.slice(0, 8000);
	}
	if (typeof parsed.connectorEnabled !== "boolean") {
		merged.connectorEnabled = DEFAULT_SETTINGS.connectorEnabled;
	}
	if (
		merged.theme !== "system" &&
		merged.theme !== "light" &&
		merged.theme !== "dark"
	) {
		merged.theme = DEFAULT_SETTINGS.theme;
	}
	if (!isKnownUiTheme(merged.uiTheme)) {
		merged.uiTheme = DEFAULT_SETTINGS.uiTheme;
	}
	if (
		merged.locale !== "system" &&
		merged.locale !== "en" &&
		merged.locale !== "zh-CN"
	) {
		merged.locale = DEFAULT_SETTINGS.locale;
	}
	if (
		merged.agentPermissionMode !== "restricted" &&
		merged.agentPermissionMode !== "ask" &&
		merged.agentPermissionMode !== "auto"
	) {
		merged.agentPermissionMode = DEFAULT_SETTINGS.agentPermissionMode;
	}
	if (
		merged.aiResponseLanguage !== "auto" &&
		merged.aiResponseLanguage !== "en" &&
		merged.aiResponseLanguage !== "zh-CN"
	) {
		merged.aiResponseLanguage = DEFAULT_SETTINGS.aiResponseLanguage;
	}
	merged.pdfAsk = normalizePdfAskSettings(
		(parsed as { pdfAsk?: Partial<PdfAskSettings> }).pdfAsk,
	);
	merged.translate = normalizeTranslateSettings(parsed.translate);
	return merged;
}

function isTranslateTargetLang(v: unknown): v is TranslateTargetLang {
	return v === "ui" || v === "en" || v === "zh-CN";
}

/**
 * Reconcile stored column prefs against the canonical set:
 * drop unknown/duplicate keys, append missing columns (visible), and keep
 * `title` visible so rows stay identifiable.
 */
function normalizeLibraryColumns(raw: unknown): LibraryColumnPref[] {
	const known = new Set<string>(LIBRARY_COLUMN_KEYS);
	const seen = new Set<LibraryColumnKey>();
	const out: LibraryColumnPref[] = [];
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (!item || typeof item !== "object") continue;
			const key = (item as { key?: unknown }).key;
			if (typeof key !== "string" || !known.has(key)) continue;
			const k = key as LibraryColumnKey;
			if (seen.has(k)) continue;
			seen.add(k);
			const visible = (item as { visible?: unknown }).visible;
			out.push({
				key: k,
				visible: typeof visible === "boolean" ? visible : true,
			});
		}
	}
	for (const key of LIBRARY_COLUMN_KEYS) {
		if (!seen.has(key)) out.push({ key, visible: true });
	}
	for (const c of out) {
		if (c.key === "title") c.visible = true;
	}
	return out;
}

function normalizePdfAskSettings(
	raw: Partial<PdfAskSettings> | undefined,
): PdfAskSettings {
	const base = { ...DEFAULT_PDF_ASK_SETTINGS };
	if (!raw || typeof raw !== "object") return base;
	if (typeof raw.agentId === "string") {
		base.agentId = raw.agentId.trim();
	}
	if (typeof raw.modelId === "string") {
		base.modelId = raw.modelId.trim();
	}
	return base;
}

function normalizeTranslateSettings(
	raw: Partial<TranslateSettings> | undefined,
): TranslateSettings {
	const base = { ...DEFAULT_TRANSLATE_SETTINGS };
	if (!raw || typeof raw !== "object") return base;
	if (raw.provider && isTranslateProviderId(raw.provider)) {
		base.provider = raw.provider;
	}
	if (raw.targetLang && isTranslateTargetLang(raw.targetLang)) {
		base.targetLang = raw.targetLang;
	}
	if (raw.sourceLang === "auto") {
		base.sourceLang = "auto";
	}
	if (typeof raw.freeBaseUrl === "string") {
		base.freeBaseUrl = raw.freeBaseUrl.trim().replace(/\/+$/, "");
	}
	if (typeof raw.autoTranslateSelection === "boolean") {
		base.autoTranslateSelection = raw.autoTranslateSelection;
	}
	if (typeof raw.agentId === "string") {
		base.agentId = raw.agentId.trim();
	}
	if (typeof raw.modelId === "string") {
		base.modelId = raw.modelId.trim();
	}
	return base;
}
