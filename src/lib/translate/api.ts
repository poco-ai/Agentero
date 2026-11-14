import { Channel } from "@tauri-apps/api/core";
import { commands } from "@/lib/core/bindings";
import { isTauri } from "@/lib/core/tauri";

/** Host marker for "the built-in provider has no compiled-in key". */
export const ERR_TRANSLATE_NO_BUILTIN_KEY = "translate.no_builtin_key";
export const ERR_TRANSLATE_EXTRA_INVALID = "translate.extra_parameters_invalid";
export const ERR_TRANSLATE_TERMINOLOGY = "translate.terminology_not_preserved";
export const ERR_TRANSLATE_EXTRA_RESERVED =
	"translate.extra_parameters_reserved";

/**
 * Host MT command via the generated typed binding (tauri-specta pilot).
 * `provider` selects a free web engine or a commercial BYOK engine.
 * Regenerate bindings: `cargo test -p agentero export_typescript_bindings`.
 */
export async function invokeTranslateText(args: {
	text: string;
	sourceLang: string;
	targetLang: string;
	provider: string;
	apiKey?: string;
	baseUrl?: string;
	region?: string;
	model?: string;
	dictionary?: boolean;
	dictionarySurrounding?: string;
	dictionaryReference?: string;
	extraRequestBody?: string;
	/** Host request timeout (ms); clamped 1s–30s server-side. */
	timeoutMs?: number;
	/** Receives each increment when the provider streams; others call it never. */
	onDelta?: (chunk: string) => void;
}): Promise<string> {
	if (!isTauri()) {
		throw new Error("Free translation requires the Tauri desktop app.");
	}
	const request = {
		text: args.text,
		sourceLang: args.sourceLang,
		targetLang: args.targetLang,
		provider: args.provider,
		apiKey: args.apiKey?.trim() || null,
		baseUrl: args.baseUrl?.trim() || null,
		region: args.region?.trim() || null,
		model: args.model?.trim() || null,
		dictionary: args.dictionary ?? false,
		dictionarySurrounding: args.dictionarySurrounding || null,
		dictionaryReference: args.dictionaryReference || null,
		extraRequestBody: args.extraRequestBody?.trim() || null,
		timeoutMs: args.timeoutMs ?? null,
	};
	const onDelta = args.onDelta;
	let res: Awaited<ReturnType<typeof commands.translateText>>;
	if (onDelta) {
		const channel = new Channel<string>();
		channel.onmessage = onDelta;
		res = await commands.translateTextStream(request, channel);
	} else {
		res = await commands.translateText(request);
	}
	if (!res.ok || !res.data) {
		// Only a known domain marker is surfaced verbatim for `displayTranslateError`
		// to map. `AppError::code()` also yields generic codes (`io`, `json`,
		// `sqlite`), so treating "not `message`" as a marker would eventually show
		// users a bare code instead of the Host's human text.
		const code = res.error?.code;
		throw new Error(
			code === ERR_TRANSLATE_NO_BUILTIN_KEY ||
				code === ERR_TRANSLATE_TERMINOLOGY ||
				code === ERR_TRANSLATE_EXTRA_INVALID ||
				code === ERR_TRANSLATE_EXTRA_RESERVED
				? code
				: (res.error?.message ?? "translate failed"),
		);
	}
	return res.data.text;
}
