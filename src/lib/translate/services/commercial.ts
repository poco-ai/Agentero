import { isSecretMask } from "@/lib/core/secret-mask";
import { invokeTranslateText } from "@/lib/translate/api";
import type {
	CommercialTranslateProviderId,
	TranslateService,
} from "@/lib/translate/types";

/**
 * Commercial BYOK engines are called by the Host so secrets never cross an
 * app-owned relay. Provider-specific validation still lives server-side.
 * After Confirm, the frontend only holds a same-length `*`-mask; Host injects
 * the real key from settings when `apiKey` is omitted or masked.
 */
export function makeCommercialMtService(
	id: CommercialTranslateProviderId,
): TranslateService {
	return {
		id,
		type: "sentence",
		nameKey: id,
		requireSecret: true,
		kind: "commercial-mt",
		async translate(task, opts) {
			const cfg = opts.providerConfig;
			const rawKey = cfg?.apiKey?.trim() ?? "";
			const result = await invokeTranslateText({
				text: task.text.trim(),
				sourceLang: task.sourceLang || "auto",
				targetLang: task.targetLang,
				provider: id,
				dictionary: task.context?.surface?.endsWith("-selection") ?? false,
				dictionarySurrounding: task.context?.dictionarySurrounding,
				dictionaryReference: task.context?.dictionaryReference,
				// Never send the mask token as if it were a key.
				apiKey: rawKey && !isSecretMask(rawKey) ? rawKey : undefined,
				baseUrl: cfg?.baseUrl,
				region: cfg?.region,
				model: cfg?.model,
				extraRequestBody: cfg?.extraRequestBody,
			});
			task.result = result;
		},
	};
}
