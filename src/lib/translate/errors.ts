import i18n from "@/i18n";
import {
	ERR_TRANSLATE_EXTRA_INVALID,
	ERR_TRANSLATE_EXTRA_RESERVED,
	ERR_TRANSLATE_NO_BUILTIN_KEY,
} from "@/lib/translate/api";

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
	return error.includes(ERR_TRANSLATE_NO_BUILTIN_KEY)
		? i18n.t("settings:translate.errors.noBuiltinKey")
		: error;
}
