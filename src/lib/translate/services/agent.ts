import { targetLangDisplayName } from "@/lib/translate/lang";
import { buildTranslatePrompt } from "@/lib/translate/prompt";
import type { TranslateService } from "@/lib/translate/types";

/**
 * BYOA Agent adapter.
 * Callers that need streaming (PDF popover) should use {@link buildTranslatePrompt}
 * + ACP directly; this path is for non-streaming `runTranslate`.
 *
 * Expects `task.targetLang` as a BCP-47 code (`zh-CN` / `en`); maps via
 * {@link targetLangDisplayName} for the prompt.
 */
export const AgentTranslateService: TranslateService = {
	id: "agent",
	type: "sentence",
	nameKey: "agent",
	requireSecret: false,
	requireExternalConfig: true,
	kind: "agent",
	async translate(task, opts) {
		const text = task.text.trim();
		if (!text) {
			throw new Error("Empty text");
		}
		if (!opts.agent?.runOnce) {
			throw new Error(
				"Agent translation requires a configured Agent runner (BYOA).",
			);
		}
		const prompt = buildTranslatePrompt({
			text,
			targetLangName: targetLangDisplayName(task.targetLang),
			page: task.context?.page,
			surface: task.context?.surface,
			customPrompt: opts.customPrompt,
			customSystem: opts.customSystem,
			customUser: opts.customUser,
		});
		const result = await opts.agent.runOnce(prompt);
		task.result = result.trim();
	},
};
