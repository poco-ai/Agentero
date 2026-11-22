import i18n from "@/i18n";
import {
	ERR_TRANSLATE_EXTRA_INVALID,
	ERR_TRANSLATE_EXTRA_RESERVED,
	ERR_TRANSLATE_INCOMPLETE,
	ERR_TRANSLATE_INDEX_PROMPT_ECHO,
	ERR_TRANSLATE_NO_BUILTIN_KEY,
	ERR_TRANSLATE_TERMINOLOGY,
	ERR_TRANSLATE_TIMEOUT,
} from "@/lib/translate/api";

/**
 * Transport-level failure markers: the request never reached the provider
 * (DNS/TLS/connection/timeout), as opposed to an HTTP status or a malformed
 * payload. Repeating the same request can only fail the same way.
 */
const TRANSPORT_ERROR_PATTERNS = [
	"error sending request",
	"timed out",
	"connection refused",
	"connection reset",
	"connection closed",
	"dns error",
	"network is unreachable",
	"certificate",
	"unexpected eof",
	"incomplete message",
];

/** Silence budget or one-shot deadline elapsed. Not a dead endpoint. */
export function isTranslateTimeout(
	message: string | null | undefined,
): boolean {
	if (!message) return false;
	return (
		message.includes(ERR_TRANSLATE_TIMEOUT) ||
		message.includes("timed out waiting for output")
	);
}

/** Model stopped on length or a filter. The returned text is unfinished. */
export function isTranslateIncomplete(
	message: string | null | undefined,
): boolean {
	if (!message) return false;
	return (
		message.includes(ERR_TRANSLATE_INCOMPLETE) ||
		message.includes("translation incomplete (finish_reason=")
	);
}

/** Provider HTTP status or an explicit upstream error payload. */
export function isTranslateUpstreamError(
	message: string | null | undefined,
): boolean {
	if (!message) return false;
	return /failed \(HTTP [^)]+\)|upstream error:/i.test(message);
}

/** True when a translation error means the provider endpoint is unreachable. */
export function isTranslateTransportError(
	message: string | null | undefined,
): boolean {
	if (!message) return false;
	if (isTranslateTimeout(message) || isTranslateIncomplete(message))
		return false;
	const text = message.toLowerCase();
	return TRANSPORT_ERROR_PATTERNS.some((pattern) => text.includes(pattern));
}

/**
 * User-facing text for translation failures: map known Host markers to i18n,
 * return anything else unchanged.
 */
export function displayTranslateError(error: string): string {
	if (error.includes("CAPABILITY_DISABLED"))
		return i18n.t("settings:translate.errors.noBuiltinKey");
	if (error.includes("CAPABILITY_SIGN_IN_REQUIRED"))
		return i18n.t("account:capabilities.signInRequired");
	if (error.includes("CAPABILITY_OPERATION_PENDING"))
		return i18n.t("account:capabilities.pending");
	if (error.includes(ERR_TRANSLATE_TERMINOLOGY))
		return i18n.t("settings:translate.errors.terminology");
	if (error.includes(ERR_TRANSLATE_EXTRA_INVALID))
		return i18n.t("settings:translate.providerConfig.extraRequestBody.invalid");
	if (error.includes(ERR_TRANSLATE_EXTRA_RESERVED))
		return i18n.t(
			"settings:translate.providerConfig.extraRequestBody.reserved",
		);
	if (error.includes(ERR_TRANSLATE_NO_BUILTIN_KEY))
		return i18n.t("settings:translate.errors.noBuiltinKey");
	if (isTranslateTimeout(error))
		return i18n.t("settings:translate.errors.timeout");
	if (isTranslateIncomplete(error))
		return i18n.t("settings:translate.errors.incomplete");
	if (error.includes(ERR_TRANSLATE_INDEX_PROMPT_ECHO))
		return i18n.t("settings:translate.errors.indexPromptEcho");
	// A dead endpoint surfaces as a reqwest/TLS string users cannot act on.
	if (isTranslateTransportError(error))
		return i18n.t("settings:translate.errors.unreachable");
	if (isTranslateUpstreamError(error))
		return i18n.t("settings:translate.errors.upstream", { detail: error });
	return error;
}
