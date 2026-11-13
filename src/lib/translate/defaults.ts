import type {
	TranslateProviderConfig,
	TranslateSettings,
} from "@/lib/translate/types";

export const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = {
	/** Prefer Tencent Transmart: current no-key default with better availability. */
	provider: "tencenttransmart",
	targetLang: "ui",
	sourceLang: "auto",
	providerConfigs: {},
	autoTranslateSelection: false,
	dualPaneTranslate: false,
	displayMode: "overlay",
	dualPaneSource: "pdf",
	agentId: "",
	modelId: "",
	customPrompt: "",
	customSystem: "",
	customUser: "",
	cacheReflowIr: true,
	cacheReflowFinal: false,
	autoTranslateImport: false,
	autoTranslateImportConcurrency: 1,
};

/** Blank commercial provider config (missing draft/stored entry fallback). */
export const EMPTY_TRANSLATE_PROVIDER_CONFIG: TranslateProviderConfig = {
	apiKey: "",
	baseUrl: "",
	region: "",
	model: "",
	extraRequestBody: "",
};
