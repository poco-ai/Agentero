import i18n from "@/i18n";
import { langsFromSettings } from "@/lib/translate/lang";
import { getTranslateService } from "@/lib/translate/services";
import type {
	TranslateProviderId,
	TranslateRunOptions,
	TranslateTask,
} from "@/lib/translate/types";
import { loadSettings } from "@/stores/settings-store";

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

	const task: TranslateTask = {
		text,
		sourceLang: partial.sourceLang ?? langs.sourceLang,
		targetLang: partial.targetLang ?? langs.targetLang,
		context: partial.context,
	};

	// Agent prompts prefer human language names
	if (providerId === "agent" && !partial.targetLang) {
		task.targetLang = langs.targetLangName;
	}

	const runOpts: TranslateRunOptions = {
		...opts,
		freeBaseUrl: opts.freeBaseUrl ?? settings.translate.freeBaseUrl ?? "",
	};

	try {
		await service.translate(task, runOpts);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
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
} {
	const settings = loadSettings();
	const langs = langsFromSettings(settings.translate, i18n.language ?? "en");
	return {
		providerId: settings.translate.provider,
		targetLangName: langs.targetLangName,
		task: {
			text: partial.text,
			sourceLang: partial.sourceLang ?? langs.sourceLang,
			targetLang: partial.targetLang ?? langs.targetLang,
			context: partial.context,
		},
	};
}
