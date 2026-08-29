import { useEffect, useState } from "react";
import { invokeApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";
import {
	isPaperTreeLabelMode,
	isPaperTreeSortMode,
} from "@/lib/paper/tree-modes";
import {
	DEFAULT_LAYOUT_SETTINGS,
	DEFAULT_MINERU_LANGUAGE,
	isLayoutBackend,
	isLayoutProviderId,
	isMineruLanguage,
	isParserBackend,
	type LayoutSettings,
} from "@/lib/pdf/layout/settings";
import {
	clampEditorLineHeight,
	DEFAULT_EMBEDDING_SETTINGS,
	DEFAULT_PDF_ASK_SETTINGS,
	DEFAULT_SETTINGS,
	DEFAULT_TRANSLATOR_BASE_URL,
	snapUiScale,
} from "@/lib/settings/defaults";
import { normalizeFontFamilyValue } from "@/lib/settings/fonts";
import {
	type AppSettings,
	DEFAULT_LIBRARY_COLUMNS,
	type EmbeddingSettings,
	isPaperNoteMode,
	LIBRARY_COLUMN_KEYS,
	type LibraryColumnKey,
	type LibraryColumnPref,
	type PdfAskSettings,
} from "@/lib/settings/types";
import { DEFAULT_TRANSLATE_SETTINGS } from "@/lib/translate/defaults";
import {
	isCommercialTranslateProvider,
	isTranslateProviderId,
} from "@/lib/translate/services";
import type {
	TranslateSettings,
	TranslateTargetLang,
} from "@/lib/translate/types";
import { isKnownUiTheme } from "@/lib/ui/theme";

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
	layout: { ...DEFAULT_SETTINGS.layout, providerConfigs: {} },
	pdfAsk: { ...DEFAULT_PDF_ASK_SETTINGS },
	embedding: { ...DEFAULT_EMBEDDING_SETTINGS },
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
		embedding: { ...s.embedding },
		translate: { ...s.translate },
		layout: { ...s.layout, providerConfigs: { ...s.layout.providerConfigs } },
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
				const res = await invokeApi<SettingsGetResult>(
					"settings_get",
					undefined,
					{
						fallback: "settings_get failed",
					},
				);
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

/** React hook that tracks the current `uiScale` without re-rendering on other
 *  settings changes. Useful for scale-aware virtualized lists. */
export function useUiScale(): number {
	const [scale, setScale] = useState(() => loadSettings().uiScale);
	useEffect(() => {
		return subscribeSettings((next) => {
			setScale((prev) => (prev === next.uiScale ? prev : next.uiScale));
		});
	}, []);
	return scale;
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
	const res = await invokeApi<AppSettings>(
		"settings_set",
		{ settings },
		{ fallback: "settings_set failed" },
	);
	return setCache(normalizeSettings(res));
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
		/** @deprecated pre-#242 single editor font preset */
		editorFontFamily?: string;
	},
): AppSettings {
	const {
		agentBaseUrl: _u,
		agentApiKey: _k,
		agentModel: _m,
		agentYolo: _y,
		downloadFulltextToLocal: _d1,
		downloadFulltextWhenNoRemotePreview: _d2,
		editorFontFamily: legacyEditorFontFamily,
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
	if (typeof parsed.networkProxyEnabled !== "boolean") {
		merged.networkProxyEnabled = DEFAULT_SETTINGS.networkProxyEnabled;
	}
	if (
		typeof parsed.networkProxyUrl !== "string" ||
		!parsed.networkProxyUrl.trim()
	) {
		merged.networkProxyUrl = DEFAULT_SETTINGS.networkProxyUrl;
	} else {
		merged.networkProxyUrl = parsed.networkProxyUrl.trim();
	}
	if (!isPaperTreeLabelMode(merged.paperTreeLabelMode)) {
		merged.paperTreeLabelMode = DEFAULT_SETTINGS.paperTreeLabelMode;
	}
	if (!isPaperTreeSortMode(merged.paperTreeSortMode)) {
		merged.paperTreeSortMode = DEFAULT_SETTINGS.paperTreeSortMode;
	}
	if (!isPaperNoteMode(merged.paperNoteMode)) {
		merged.paperNoteMode = DEFAULT_SETTINGS.paperNoteMode;
	}
	if (typeof parsed.autoOpenPaperNotes !== "boolean") {
		merged.autoOpenPaperNotes = DEFAULT_SETTINGS.autoOpenPaperNotes;
	}
	if (
		merged.autoUpdateInternalLinks !== "ask" &&
		merged.autoUpdateInternalLinks !== "always"
	) {
		merged.autoUpdateInternalLinks = DEFAULT_SETTINGS.autoUpdateInternalLinks;
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
	if (typeof parsed.mcpEnabled !== "boolean") {
		merged.mcpEnabled = DEFAULT_SETTINGS.mcpEnabled;
	}
	if (
		!Number.isInteger(merged.mcpPort) ||
		merged.mcpPort < 1 ||
		merged.mcpPort > 65535
	) {
		merged.mcpPort = DEFAULT_SETTINGS.mcpPort;
	}
	if (typeof merged.mcpTunnelId !== "string") {
		merged.mcpTunnelId = DEFAULT_SETTINGS.mcpTunnelId;
	}
	if (typeof merged.mcpTunnelApiKey !== "string") {
		merged.mcpTunnelApiKey = DEFAULT_SETTINGS.mcpTunnelApiKey;
	}
	if (typeof parsed.exportWatermarkEnabled !== "boolean") {
		merged.exportWatermarkEnabled = DEFAULT_SETTINGS.exportWatermarkEnabled;
	}
	if (typeof parsed.telemetryEnabled !== "boolean") {
		merged.telemetryEnabled = DEFAULT_SETTINGS.telemetryEnabled;
	}
	if (typeof parsed.plazaEnabled !== "boolean") {
		merged.plazaEnabled = DEFAULT_SETTINGS.plazaEnabled;
	}
	if (!Array.isArray(parsed.plazaHiddenSources)) {
		merged.plazaHiddenSources = DEFAULT_SETTINGS.plazaHiddenSources;
	} else {
		merged.plazaHiddenSources = [
			...new Set(
				parsed.plazaHiddenSources.filter(
					(id): id is string => typeof id === "string",
				),
			),
		];
	}
	if (typeof parsed.onboardingDone !== "boolean") {
		merged.onboardingDone = DEFAULT_SETTINGS.onboardingDone;
	}
	if (typeof parsed.featureTourDone !== "boolean") {
		merged.featureTourDone = DEFAULT_SETTINGS.featureTourDone;
	}
	if (
		!Number.isInteger(merged.batchImportConcurrency) ||
		merged.batchImportConcurrency < 1 ||
		merged.batchImportConcurrency > 10
	) {
		merged.batchImportConcurrency = DEFAULT_SETTINGS.batchImportConcurrency;
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
	if (!Number.isFinite(merged.uiScale)) {
		// Migrate the old per-icon-size setting (12–22 px, default 14) to a global
		// scale ratio. 14 px was 100%; snap to the closest preset.
		const oldIconSize = (parsed as { toolbarIconSize?: unknown })
			.toolbarIconSize;
		if (Number.isFinite(oldIconSize)) {
			merged.uiScale = snapUiScale(Number(oldIconSize) / 14);
		} else {
			merged.uiScale = DEFAULT_SETTINGS.uiScale;
		}
	} else {
		merged.uiScale = snapUiScale(merged.uiScale);
	}
	if (
		merged.locale !== "system" &&
		merged.locale !== "en" &&
		merged.locale !== "zh-CN"
	) {
		merged.locale = DEFAULT_SETTINGS.locale;
	}
	merged.interfaceFontFamily = normalizeFontFamilyValue(
		merged.interfaceFontFamily,
	);
	merged.textFontFamily = normalizeFontFamilyValue(merged.textFontFamily);
	merged.monoFontFamily = normalizeFontFamilyValue(merged.monoFontFamily);
	// Migrate short-lived editorFontFamily preset → textFontFamily when the
	// newer field was never set in storage.
	if (
		!parsed.textFontFamily &&
		typeof legacyEditorFontFamily === "string" &&
		legacyEditorFontFamily.trim() &&
		legacyEditorFontFamily !== "default"
	) {
		merged.textFontFamily = normalizeFontFamilyValue(legacyEditorFontFamily);
	}
	merged.editorLineHeight = clampEditorLineHeight(merged.editorLineHeight);
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
	merged.embedding = normalizeEmbeddingSettings(
		(parsed as { embedding?: Partial<EmbeddingSettings> }).embedding,
	);
	merged.translate = normalizeTranslateSettings(parsed.translate);
	merged.layout = normalizeLayoutSettings(parsed.layout);
	return merged;
}

function isTranslateTargetLang(v: unknown): v is TranslateTargetLang {
	return v === "ui" || v === "en" || v === "zh-CN";
}

/**
 * Reconcile stored column prefs against the canonical set:
 * drop unknown/duplicate keys, append missing columns (visible), and keep
 * `title` visible so rows stay identifiable.
 *
 * Migration: if the saved order matches the old canonical layout (before the
 * standalone publication column was added), adopt the new canonical order so
 * publication lands right after year. Custom user orders are preserved.
 */
function normalizeLibraryColumns(raw: unknown): LibraryColumnPref[] {
	const known = new Set<string>(LIBRARY_COLUMN_KEYS);
	const seen = new Set<LibraryColumnKey>();
	const saved: LibraryColumnPref[] = [];
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (!item || typeof item !== "object") continue;
			const key = (item as { key?: unknown }).key;
			if (typeof key !== "string" || !known.has(key)) continue;
			const k = key as LibraryColumnKey;
			if (seen.has(k)) continue;
			seen.add(k);
			const visible = (item as { visible?: unknown }).visible;
			saved.push({
				key: k,
				visible: typeof visible === "boolean" ? visible : true,
			});
		}
	}

	const oldCanonicalKeys: LibraryColumnKey[] = [
		"title",
		"authors",
		"year",
		"tags",
		"id",
	];
	const matchesOldLayout =
		saved.length >= oldCanonicalKeys.length &&
		oldCanonicalKeys.every((k, i) => saved[i]?.key === k);

	const out: LibraryColumnPref[] = [];
	if (matchesOldLayout) {
		for (const key of LIBRARY_COLUMN_KEYS) {
			const pref = saved.find((c) => c.key === key);
			out.push({ key, visible: pref?.visible ?? true });
		}
	} else {
		for (const key of LIBRARY_COLUMN_KEYS) {
			if (!seen.has(key)) out.push({ key, visible: true });
		}
		for (const c of saved) {
			if (seen.has(c.key)) out.push({ ...c });
		}
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

function normalizeEmbeddingSettings(
	raw: Partial<EmbeddingSettings> | undefined,
): EmbeddingSettings {
	const base = { ...DEFAULT_EMBEDDING_SETTINGS };
	if (!raw || typeof raw !== "object") return base;
	// No trailing-slash strip here: normalize runs on every keystroke save,
	// which would eat the "/" while typing e.g. ".../v1". The Host and the
	// settings UI onBlur already trim trailing slashes.
	if (typeof raw.baseUrl === "string") base.baseUrl = raw.baseUrl.trim();
	if (typeof raw.apiKey === "string") base.apiKey = raw.apiKey.trim();
	if (typeof raw.model === "string") base.model = raw.model.trim();
	return base;
}

function normalizeTranslateSettings(
	raw: Partial<TranslateSettings> | undefined,
): TranslateSettings {
	const base: TranslateSettings = {
		...DEFAULT_TRANSLATE_SETTINGS,
		providerConfigs: {},
	};
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
	base.providerConfigs = normalizeTranslateProviderConfigs(
		(raw as { providerConfigs?: unknown }).providerConfigs,
	);
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

function normalizeTranslateProviderConfigs(
	raw: unknown,
): TranslateSettings["providerConfigs"] {
	const out: TranslateSettings["providerConfigs"] = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [id, value] of Object.entries(raw)) {
		if (!isCommercialTranslateProvider(id)) continue;
		if (!value || typeof value !== "object") continue;
		const cfg = value as {
			apiKey?: unknown;
			baseUrl?: unknown;
			region?: unknown;
			model?: unknown;
		};
		out[id] = {
			apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "",
			// No trailing-slash strip here: this runs on every keystroke save,
			// which would eat the "/" while typing e.g. ".../v1". Host and the
			// settings UI onBlur already trim trailing slashes.
			baseUrl: typeof cfg.baseUrl === "string" ? cfg.baseUrl.trim() : "",
			region: typeof cfg.region === "string" ? cfg.region.trim() : "",
			model: typeof cfg.model === "string" ? cfg.model.trim() : "",
		};
	}
	return out;
}

function normalizeLayoutSettings(
	raw: Partial<LayoutSettings> | undefined,
): LayoutSettings {
	const base: LayoutSettings = {
		...DEFAULT_LAYOUT_SETTINGS,
		providerConfigs: {},
	};
	if (!raw || typeof raw !== "object") return base;
	if (isLayoutBackend(raw.backend)) {
		base.backend = raw.backend;
	}
	if (isParserBackend(raw.parserBackend)) {
		base.parserBackend = raw.parserBackend;
	}
	base.providerConfigs = normalizeLayoutProviderConfigs(
		(raw as { providerConfigs?: unknown }).providerConfigs,
	);
	return base;
}

function normalizeLayoutProviderConfigs(
	raw: unknown,
): LayoutSettings["providerConfigs"] {
	const out: LayoutSettings["providerConfigs"] = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [id, value] of Object.entries(raw)) {
		if (!isLayoutProviderId(id)) continue;
		if (!value || typeof value !== "object") continue;
		const cfg = value as {
			apiKey?: unknown;
			baseUrl?: unknown;
			model?: unknown;
			prompt?: unknown;
			language?: unknown;
			isOcr?: unknown;
		};
		const language =
			typeof cfg.language === "string" ? cfg.language.trim() : "";
		out[id] = {
			apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "",
			baseUrl: typeof cfg.baseUrl === "string" ? cfg.baseUrl.trim() : "",
			model: typeof cfg.model === "string" ? cfg.model.trim() : "",
			prompt: typeof cfg.prompt === "string" ? cfg.prompt.trim() : "",
			language: isMineruLanguage(language) ? language : DEFAULT_MINERU_LANGUAGE,
			isOcr: cfg.isOcr === true,
		};
	}
	return out;
}
