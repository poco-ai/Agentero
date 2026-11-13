import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { loadSettings } from "@/lib/settings";
import { langsFromSettings } from "@/lib/translate/lang";
import {
	getTranslateService,
	isCommercialTranslateProvider,
} from "@/lib/translate/services";
import type {
	TranslateProviderId,
	TranslateRunOptions,
	TranslateTask,
} from "@/lib/translate/types";

/**
 * App-wide translation entry: resolve default provider, run service, return text.
 */
export async function runTranslate(
	partial: Pick<TranslateTask, "text"> &
		Partial<Omit<TranslateTask, "text" | "result" | "error">>,
	opts: TranslateRunOptions = {},
): Promise<string> {
	const text = partial.text?.trim() ?? "";
	if (!text) {
		throw new Error("Empty text");
	}

	const settings = loadSettings();
	const langs = langsFromSettings(settings.translate, i18n.language ?? "en");
	const providerId: TranslateProviderId =
		opts.providerId ?? settings.translate.provider;

	const service = getTranslateService(providerId);
	if (!service) {
		throw new Error(`Unknown translation provider: ${providerId}`);
	}

	// Always keep BCP-47 codes on the task; Agent service maps to display names.
	const task: TranslateTask = {
		text,
		sourceLang: partial.sourceLang ?? langs.sourceLang,
		targetLang: partial.targetLang ?? langs.targetLang,
		context: partial.context,
	};

	const runOpts: TranslateRunOptions = {
		...opts,
		providerConfig:
			opts.providerConfig ??
			(isCommercialTranslateProvider(providerId)
				? settings.translate.providerConfigs[providerId]
				: undefined),
		customPrompt: opts.customPrompt ?? settings.translate.customPrompt,
		customSystem: opts.customSystem ?? settings.translate.customSystem,
		customUser: opts.customUser ?? settings.translate.customUser,
	};

	try {
		await service.translate(task, runOpts);
	} catch (e) {
		const message = errorText(e);
		task.error = message;
		throw e instanceof Error ? e : new Error(message);
	}

	const result = task.result?.trim();
	if (!result) {
		throw new Error("Empty translation result");
	}
	return result;
}

/** Build a task with settings-resolved languages (for consumers that branch UI). */
export function prepareTranslateTask(
	partial: Pick<TranslateTask, "text"> &
		Partial<Omit<TranslateTask, "text" | "result" | "error">>,
): {
	task: TranslateTask;
	providerId: TranslateProviderId;
	targetLangName: string;
	/** Legacy settings prompt (empty = built-in instructions). */
	customPrompt: string;
	customSystem: string;
	customUser: string;
} {
	const settings = loadSettings();
	const langs = langsFromSettings(settings.translate, i18n.language ?? "en");
	return {
		providerId: settings.translate.provider,
		targetLangName: langs.targetLangName,
		customPrompt: settings.translate.customPrompt,
		customSystem: settings.translate.customSystem,
		customUser: settings.translate.customUser,
		task: {
			text: partial.text,
			sourceLang: partial.sourceLang ?? langs.sourceLang,
			targetLang: partial.targetLang ?? langs.targetLang,
			context: partial.context,
		},
	};
}
