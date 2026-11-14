import { invokeTranslateText } from "@/lib/translate/api";
import type {
	FreeTranslateProviderId,
	TranslateService,
} from "@/lib/translate/types";

/**
 * Free MT engines call the Host, which owns validation (empty text,
 * length cap, provider dispatch) — no duplicated checks here.
 */
export function makeFreeMtService(
	id: FreeTranslateProviderId,
): TranslateService {
	return {
		id,
		type: "sentence",
		nameKey: id,
		requireSecret: false,
		kind: "free-mt",
		async translate(task, opts) {
			const result = await invokeTranslateText({
				text: task.text.trim(),
				sourceLang: task.sourceLang || "auto",
				targetLang: task.targetLang,
				provider: id,
				onDelta: opts.onDelta,
			});
			task.result = result;
		},
	};
}
