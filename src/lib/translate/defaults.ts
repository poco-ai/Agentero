import type {
	TranslateProviderConfig,
	TranslateSettings,
} from "@/lib/translate/types";

export const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = {
	/** Prefer Bilibili Translate 2B: free, no-key and fast for short passages. */
	provider: "indextranslate2b",
	dictionary: { mode: "auto" },
	targetLang: "ui",
	sourceLang: "auto",
	providerConfigs: {},
	autoTranslateSelection: false,
	agentId: "",
	modelId: "",
	customPrompt: "",
	customSystem: "",
	customUser: "",
	cacheReflowIr: true,
	cacheReflowFinal: false,
	autoTranslateImport: false,
	autoTranslateImportConcurrency: 1,
	alwaysShowTranslateCard: false,
};

/**
 * Full-document translation batch pool size (settings UI offers 1–8). Only the
 * OpenAI-compatible provider exposes it; other providers keep the old fixed 2.
 */
export const TRANSLATE_CONCURRENCY_MIN = 1;
export const TRANSLATE_CONCURRENCY_MAX = 8;
/** Matches the previous fixed pool so upgrading does not change throughput. */
export const DEFAULT_TRANSLATE_CONCURRENCY = 2;

/** Select options for Settings → Translate → OpenAI-compatible. */
export const TRANSLATE_CONCURRENCY_CHOICES = Array.from(
	{ length: TRANSLATE_CONCURRENCY_MAX - TRANSLATE_CONCURRENCY_MIN + 1 },
	(_, i) => TRANSLATE_CONCURRENCY_MIN + i,
);

/** Clamp a stored concurrency to the supported range; invalid → default. */
export function normalizeTranslateConcurrency(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_TRANSLATE_CONCURRENCY;
	}
	const rounded = Math.round(value);
	return rounded >= TRANSLATE_CONCURRENCY_MIN &&
		rounded <= TRANSLATE_CONCURRENCY_MAX
		? rounded
		: DEFAULT_TRANSLATE_CONCURRENCY;
}

/** Blank commercial provider config (missing draft/stored entry fallback). */
export const EMPTY_TRANSLATE_PROVIDER_CONFIG: TranslateProviderConfig = {
	apiKey: "",
	baseUrl: "",
	region: "",
	model: "",
	extraRequestBody: "",
	concurrency: DEFAULT_TRANSLATE_CONCURRENCY,
};
