export { ERR_TRANSLATE_NO_BUILTIN_KEY } from "@/lib/translate/api";
export {
	displayTranslateError,
	isTranslateTransportError,
} from "@/lib/translate/errors";
export {
	langsFromSettings,
	resolveTargetLangCode,
	resolveTargetLangName,
	targetLangDisplayName,
} from "@/lib/translate/lang";
export type {
	CommercialMtProbeMap,
	FreeMtProbeMap,
	FreeMtProbeStatus,
} from "@/lib/translate/probe";
export {
	isCommercialProviderConfigured,
	probeCommercialMtProvider,
	probeFreeMtProviders,
} from "@/lib/translate/probe";
export type { TranslateTemplateIssue } from "@/lib/translate/prompt";
export {
	buildTranslateMessages,
	buildTranslatePrompt,
	DEFAULT_TRANSLATE_PROMPT_TEMPLATE,
	fillTranslateTextPlaceholder,
	hasNumberedMarkers,
	isShortColloquialPrompt,
	renderTranslatePromptTemplate,
	stripUnknownTranslatePlaceholders,
	translateSystemTemplateIssue,
	translateTemplateHasText,
	translateUserTemplateIssue,
	unknownTranslatePlaceholders,
} from "@/lib/translate/prompt";
export {
	listAvailableAgents,
	resolveConfiguredTranslateAgent,
	resolveTranslateAgent,
} from "@/lib/translate/resolve-agent";
export { prepareTranslateTask, runTranslate } from "@/lib/translate/run";
export {
	getTranslateService,
	isCommercialTranslateProvider,
	isFreeMtProvider,
	isTranslateProviderId,
	listSelectableProviders,
} from "@/lib/translate/services";
export {
	COMMERCIAL_MT_DEFAULT_BASE_URLS,
	COMMERCIAL_MT_DOCS_URLS,
	COMMERCIAL_MT_PROVIDER_IDS,
	FREE_MT_PROVIDER_IDS,
} from "@/lib/translate/types";
