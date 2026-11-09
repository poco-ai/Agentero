import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { isLikelyNetworkFailure, notifyError } from "@/lib/core/notify";
import { openSettingsWindow } from "@/lib/shell/settings-window";

// The updater plugin and CLI Host can flatten reqwest's transport errors.
const TRANSPORT_ERROR_RE =
	/\berror sending request for url\b|\brequest or response body error\b|^download body error:/i;

export function notifyReleaseDownloadError(
	message: string,
	error: unknown,
	description?: string,
): void {
	const reason = errorText(error);
	if (TRANSPORT_ERROR_RE.test(reason) || isLikelyNetworkFailure(reason)) {
		notifyError(i18n.t("settings:about.downloadNetworkError.title"), {
			action: {
				label: i18n.t("settings:about.downloadNetworkError.openSettings"),
				onClick: () => openSettingsWindow("general"),
			},
		});
		return;
	}
	notifyError(message, { description });
}
