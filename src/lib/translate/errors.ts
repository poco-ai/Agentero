import i18n from "@/i18n";
import {
	ERR_TRANSLATE_EXTRA_INVALID,
	ERR_TRANSLATE_EXTRA_RESERVED,
	ERR_TRANSLATE_NO_BUILTIN_KEY,
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

/** True when a translation error means the provider endpoint is unreachable. */
export function isTranslateTransportError(
	message: string | null | undefined,
): boolean {
	if (!message) return false;
	const text = message.toLowerCase();
	return TRANSPORT_ERROR_PATTERNS.some((pattern) => text.includes(pattern));
}

/**
 * User-facing text for translation failures: map known Host markers to i18n,
 * return anything else unchanged.
 */
export function displayTranslateError(error: string): string {
	if (error.includes(ERR_TRANSLATE_EXTRA_INVALID))
		return i18n.t("settings:translate.providerConfig.extraRequestBody.invalid");
	if (error.includes(ERR_TRANSLATE_EXTRA_RESERVED))
		return i18n.t(
			"settings:translate.providerConfig.extraRequestBody.reserved",
		);
	if (error.includes(ERR_TRANSLATE_NO_BUILTIN_KEY))
		return i18n.t("settings:translate.errors.noBuiltinKey");
	// A dead endpoint surfaces as a reqwest/TLS string users cannot act on.
	if (isTranslateTransportError(error))
		return i18n.t("settings:translate.errors.unreachable");
	return error;
}
