/**
 * Application-level translation service types.
 * Architecture mirrors zotero-pdf-translate's pluggable TranslateService table.
 */

/**
 * Free MT engines (no user-supplied API keys). `agentero` is the built-in
 * provider: the Host injects its compiled-in credential, so the frontend keeps
 * no BYOK config for it and it reuses the keyless free-engine plumbing.
 */
export type FreeTranslateProviderId =
	| "agentero"
	| "google"
	| "googleapi"
	| "deeplx"
	| "cnki"
	| "huoshanweb"
	| "tencenttransmart";

/** Commercial BYOK engines called directly by the Tauri Host. */
export type CommercialTranslateProviderId =
	| "deepl"
	| "azure"
	| "googleCloud"
	| "aimlapi"
	| "openaiCompatible";

export type HostTranslateProviderId =
	| FreeTranslateProviderId
	| CommercialTranslateProviderId;

export type TranslateProviderId = HostTranslateProviderId | "agent";

export type TranslateTargetLang = "ui" | "en" | "zh-CN";

export type TranslateSourceLang = "auto";

export type TranslateSettings = {
	/** App-wide default provider. */
	provider: TranslateProviderId;
	targetLang: TranslateTargetLang;
	sourceLang: TranslateSourceLang;
	/**
	 * Per-provider BYOK config. Stored in the app settings file, not in Vault.
	 */
	providerConfigs: Partial<
		Record<CommercialTranslateProviderId, TranslateProviderConfig>
	>;
	/** PDF consumer: auto-run translate after selection (default off). */
	autoTranslateSelection: boolean;
	/**
	 * Open a secondary window with the rendered full-document translation so the
	 * original PDF stays on the left and the translation stays on the right.
	 * @deprecated Use `displayMode` instead; kept for migration.
	 */
	dualPaneTranslate: boolean;
	/**
	 * How full-document translation is displayed.
	 * - `overlay`: in-place translation layer over the source PDF.
	 * - `dualPane`: side-by-side source + translation panes.
	 */
	displayMode: TranslationDisplayMode;
	/**
	 * Which source drives the left pane when `displayMode === "dualPane"`.
	 * - `pdf`: the rendered PDF.
	 * - `latex`: the arXiv LaTeX source.
	 */
	dualPaneSource: DualPaneSource;
	/**
	 * Agent seat for provider === "agent".
	 * Empty = follow registry defaultId.
	 */
	agentId: string;
	/**
	 * ACP model id for provider === "agent".
	 * Empty = follow loadModelPref(agentId) / agent current.
	 */
	modelId: string;
	/**
	 * Legacy single template. Kept so older settings.json still apply.
	 * Empty when `customSystem` is set. A one-line colloquial value is an
	 * extra preference; anything longer replaces the academic style block
	 * only. Engine rules always stay. Max 8000 chars.
	 */
	customPrompt: string;
	/**
	 * Custom system style or preference. Wins over `customPrompt`.
	 * Placeholders: targetLang, sourceLang, and text.
	 */
	customSystem: string;
	/**
	 * Custom user template. Used only when it contains the text placeholder;
	 * otherwise the source is still quoted. Max 8000 chars.
	 */
	customUser: string;
	/**
	 * Persist extracted reflow character IR pages under the app cache directory
	 * (default on). Off = extraction runs again on every open and nothing is
	 * written; existing files stay until the cache is cleared.
	 */
	cacheReflowIr: boolean;
	/**
	 * Persist the finished translated PDF under the app cache directory
	 * (default off: each final is ~25 MB).
	 */
	cacheReflowFinal: boolean;
	/**
	 * Translate a paper's full text in the background once it is imported and
	 * its layout analysis succeeds (default off: it spends provider quota).
	 */
	autoTranslateImport: boolean;
	/**
	 * How many papers the import-triggered background translation runs at
	 * once (1–5, default 1). Seeded into the JobCenter `layoutTranslate` cap.
	 */
	autoTranslateImportConcurrency: number;
};

export type TranslateProviderConfig = {
	apiKey: string;
	/** Optional API base URL / endpoint override. */
	baseUrl: string;
	/** Azure subscription region; ignored by most providers. */
	region: string;
	/** OpenAI-compatible model id. */
	model: string;
	/** JSON object replacing automatic request options; blank uses model defaults. */
	extraRequestBody?: string;
};

export type TranslateServiceType = "sentence" | "word";

/** Mutable task state (aligned with Zotero PDF Translate `data`). */
export type TranslateTask = {
	text: string;
	sourceLang: string;
	targetLang: string;
	result?: string;
	error?: string;
	context?: {
		page?: number;
		paperId?: string;
		quote?: string;
		/** e.g. "pdf-selection" */
		surface?: string;
	};
};

export type TranslateRunOptions = {
	/** Override settings.provider for this call. */
	providerId?: TranslateProviderId;
	/** Current BYOK provider config, resolved from settings. */
	providerConfig?: TranslateProviderConfig;
	/**
	 * Agent path: custom prompt override; defaults to
	 * settings.translate.customPrompt (set by `runTranslate`).
	 */
	customPrompt?: string;
	/** Wins over `customPrompt`. Defaults to settings.translate.customSystem. */
	customSystem?: string;
	/** Defaults to settings.translate.customUser. */
	customUser?: string;
	/**
	 * Agent path: inject runner so lib/ does not depend on ACP wiring.
	 * Streaming is the caller's concern; this returns the final string when used.
	 */
	agent?: {
		runOnce: (prompt: string) => Promise<string>;
	};
};

export type TranslateService = {
	id: TranslateProviderId;
	type: TranslateServiceType;
	/** i18n key under settings:translate.provider.* */
	nameKey: string;
	requireSecret: boolean;
	requireExternalConfig?: boolean;
	/** MT engines call Host; agent uses ACP. */
	kind: "free-mt" | "commercial-mt" | "agent";
	translate: (task: TranslateTask, opts: TranslateRunOptions) => Promise<void>;
};

/** Ordered list for settings UI (free engines). */
export const FREE_MT_PROVIDER_IDS: FreeTranslateProviderId[] = [
	"agentero",
	"tencenttransmart",
	"huoshanweb",
	"deeplx",
	"cnki",
	"googleapi",
	"google",
];

/** Ordered list for settings UI (commercial BYOK engines). */
export const COMMERCIAL_MT_PROVIDER_IDS: CommercialTranslateProviderId[] = [
	"deepl",
	"azure",
	"googleCloud",
	"aimlapi",
	"openaiCompatible",
];

/**
 * Default API roots when `baseUrl` is empty (Host appends the path suffix).
 * Keep in sync with `optional_endpoint` defaults in
 * `src-tauri/src/features/translate/mod.rs`.
 */
export const COMMERCIAL_MT_DEFAULT_BASE_URLS: Record<
	CommercialTranslateProviderId,
	string
> = {
	deepl: "https://api-free.deepl.com",
	azure: "https://api.cognitive.microsofttranslator.com",
	googleCloud: "https://translation.googleapis.com",
	aimlapi: "https://api.aimlapi.com/v1",
	openaiCompatible: "https://api.openai.com/v1",
};

/**
 * Model used when the card's Model field is empty. Keep in sync with
 * `AIMLAPI_DEFAULT_MODEL` in `openai_compatible.rs`.
 */
export const COMMERCIAL_MT_DEFAULT_MODELS: Partial<
	Record<CommercialTranslateProviderId, string>
> = {
	aimlapi: "deepseek/deepseek-v4-flash",
};

/** Providers that speak OpenAI Chat Completions (model + extra JSON fields). */
export function isChatCompletionsProvider(
	id: CommercialTranslateProviderId,
): boolean {
	return id === "openaiCompatible" || id === "aimlapi";
}

/** Official docs / console pages for obtaining keys (settings UI external link). */
export const COMMERCIAL_MT_DOCS_URLS: Record<
	CommercialTranslateProviderId,
	string
> = {
	deepl: "https://www.deepl.com/pro-api",
	azure:
		"https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/TextTranslation",
	googleCloud:
		"https://console.cloud.google.com/apis/library/translate.googleapis.com",
	aimlapi: "https://aimlapi.com/app/keys",
	openaiCompatible: "https://platform.openai.com/api-keys",
};

/** How full-document translation is rendered. */
export type TranslationDisplayMode = "overlay" | "dualPane";

/** Canonical display modes in UI order. */
export const TRANSLATION_DISPLAY_MODES: TranslationDisplayMode[] = [
	"overlay",
	"dualPane",
];

/** Source pane type for dual-pane full-document translation. */
export type DualPaneSource = "pdf" | "latex";

/** Canonical dual-pane source values in UI order. */
export const DUAL_PANE_SOURCES: DualPaneSource[] = ["pdf", "latex"];
