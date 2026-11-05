/**
 * Host diagnostic tokens for a translation-service failure during web import.
 *
 * The shell translates these. The raw token stays in logs so a 503 / 1102
 * can be matched without guessing from a localized sentence.
 */
import i18n from "@/i18n";

export type LookupDiagnostic = {
	kind: "degraded" | "unavailable";
	status: string;
	code: string;
	mode?: "page" | "url_only";
	host?: string;
};

const DEGRADED =
	/translator_degraded\|(\d+)\|(\d+|-)\|(page|url_only)(?:\|(\S+))?/;
const UNAVAILABLE = /translator_unavailable\|(\d+)\|(\d+|-)\|(\S+)/;

export function parseLookupDiagnostic(text: string): LookupDiagnostic | null {
	const degraded = DEGRADED.exec(text);
	if (degraded) {
		return {
			kind: "degraded",
			status: degraded[1] ?? "0",
			code: degraded[2] ?? "-",
			mode: degraded[3] === "url_only" ? "url_only" : "page",
			host: degraded[4],
		};
	}
	const unavailable = UNAVAILABLE.exec(text);
	if (unavailable) {
		return {
			kind: "unavailable",
			status: unavailable[1] ?? "0",
			code: unavailable[2] ?? "-",
			host: unavailable[3],
		};
	}
	return null;
}

function detail(status: string, code: string): string {
	if (status === "0") return i18n.t("sidebar:lookup.translatorDetailDown");
	if (code === "-" || code === "0") {
		return i18n.t("sidebar:lookup.translatorDetailHttp", { status });
	}
	return i18n.t("sidebar:lookup.translatorDetailCode", { status, code });
}

/** Warning toast for an import that continued without the translator. */
export function lookupDegradedWarning(text: string): {
	message: string;
	description?: string;
	log: LookupDiagnostic;
} | null {
	const parsed = parseLookupDiagnostic(text);
	if (!parsed || parsed.kind !== "degraded") return null;
	const key =
		parsed.mode === "url_only"
			? "sidebar:lookup.translatorDegradedUrlOnly"
			: "sidebar:lookup.translatorDegraded";
	return {
		message: i18n.t(key, { detail: detail(parsed.status, parsed.code) }),
		description: parsed.host
			? i18n.t("sidebar:lookup.translatorHost", { host: parsed.host })
			: undefined,
		log: parsed,
	};
}

/** Replace a classified host error; leave every other message unchanged. */
export function formatLookupError(text: string): string {
	const parsed = parseLookupDiagnostic(text);
	if (!parsed || parsed.kind !== "unavailable") return text;
	const translated = i18n.t("sidebar:lookup.translatorUnavailable", {
		detail: detail(parsed.status, parsed.code),
	});
	const prefix = text.split("translator_unavailable|")[0]?.trim() ?? "";
	if (prefix.endsWith(":")) return `${prefix} ${translated}`;
	return translated;
}
