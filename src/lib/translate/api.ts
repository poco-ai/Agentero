import { ipc } from "@/lib/ipc";
import { isTauri } from "@/lib/tauri";

export type TranslateTextResult = {
	text: string;
	provider?: string;
};

/**
 * Host free-MT command. `provider` selects the web engine
 * (googleapi / bing / youdao / …).
 */
export async function invokeTranslateText(args: {
	text: string;
	sourceLang: string;
	targetLang: string;
	provider: string;
	freeBaseUrl?: string;
	/** Host request timeout (ms); clamped 1s–30s server-side. */
	timeoutMs?: number;
}): Promise<string> {
	if (!isTauri()) {
		throw new Error("Free translation requires the Tauri desktop app.");
	}
	const res = await ipc<TranslateTextResult>("translate_text", {
		args: {
			text: args.text,
			sourceLang: args.sourceLang,
			targetLang: args.targetLang,
			provider: args.provider,
			freeBaseUrl: args.freeBaseUrl?.trim() || null,
			timeoutMs: args.timeoutMs ?? null,
		},
	});
	return res.text;
}
