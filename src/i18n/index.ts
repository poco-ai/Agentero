import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { LocalePreference } from "@/lib/settings";
import enAccount from "./locales/en/account.json";
import enAgent from "./locales/en/agent.json";
import enAiElements from "./locales/en/aiElements.json";
import enApp from "./locales/en/app.json";
import enCommon from "./locales/en/common.json";
import enEditor from "./locales/en/editor.json";
import enLatexBuild from "./locales/en/latexBuild.json";
import enLatexLanguage from "./locales/en/latexLanguage.json";
import enLatexPdf from "./locales/en/latexPdf.json";
import enMobile from "./locales/en/mobile.json";
import enOnboarding from "./locales/en/onboarding.json";
import enSettings from "./locales/en/settings.json";
import enShortcuts from "./locales/en/shortcuts.json";
import enSidebar from "./locales/en/sidebar.json";
import enViewer from "./locales/en/viewer.json";
import viAccount from "./locales/vi/account.json";
import viAgent from "./locales/vi/agent.json";
import viAiElements from "./locales/vi/aiElements.json";
import viApp from "./locales/vi/app.json";
import viCommon from "./locales/vi/common.json";
import viEditor from "./locales/vi/editor.json";
import viLatexBuild from "./locales/vi/latexBuild.json";
import viLatexLanguage from "./locales/vi/latexLanguage.json";
import viLatexPdf from "./locales/vi/latexPdf.json";
import viMobile from "./locales/vi/mobile.json";
import viOnboarding from "./locales/vi/onboarding.json";
import viSettings from "./locales/vi/settings.json";
import viShortcuts from "./locales/vi/shortcuts.json";
import viSidebar from "./locales/vi/sidebar.json";
import viViewer from "./locales/vi/viewer.json";
import zhAccount from "./locales/zh-CN/account.json";
import zhAgent from "./locales/zh-CN/agent.json";
import zhAiElements from "./locales/zh-CN/aiElements.json";
import zhApp from "./locales/zh-CN/app.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhEditor from "./locales/zh-CN/editor.json";
import zhLatexBuild from "./locales/zh-CN/latexBuild.json";
import zhLatexLanguage from "./locales/zh-CN/latexLanguage.json";
import zhLatexPdf from "./locales/zh-CN/latexPdf.json";
import zhMobile from "./locales/zh-CN/mobile.json";
import zhOnboarding from "./locales/zh-CN/onboarding.json";
import zhSettings from "./locales/zh-CN/settings.json";
import zhShortcuts from "./locales/zh-CN/shortcuts.json";
import zhSidebar from "./locales/zh-CN/sidebar.json";
import zhViewer from "./locales/zh-CN/viewer.json";

const SUPPORTED_LOCALES = ["en", "zh-CN", "vi"] as const;
type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_NS = "common";

export const resources = {
	en: {
		account: enAccount,
		common: enCommon,
		app: enApp,
		settings: enSettings,
		agent: enAgent,
		sidebar: enSidebar,
		viewer: enViewer,
		editor: enEditor,
		latexBuild: enLatexBuild,
		latexLanguage: enLatexLanguage,
		latexPdf: enLatexPdf,
		shortcuts: enShortcuts,
		aiElements: enAiElements,
		mobile: enMobile,
		onboarding: enOnboarding,
	},
	"zh-CN": {
		account: zhAccount,
		common: zhCommon,
		app: zhApp,
		settings: zhSettings,
		agent: zhAgent,
		sidebar: zhSidebar,
		viewer: zhViewer,
		editor: zhEditor,
		latexBuild: zhLatexBuild,
		latexLanguage: zhLatexLanguage,
		latexPdf: zhLatexPdf,
		shortcuts: zhShortcuts,
		aiElements: zhAiElements,
		mobile: zhMobile,
		onboarding: zhOnboarding,
	},
	vi: {
		account: viAccount,
		common: viCommon,
		app: viApp,
		settings: viSettings,
		agent: viAgent,
		sidebar: viSidebar,
		viewer: viViewer,
		editor: viEditor,
		latexBuild: viLatexBuild,
		latexLanguage: viLatexLanguage,
		latexPdf: viLatexPdf,
		shortcuts: viShortcuts,
		aiElements: viAiElements,
		mobile: viMobile,
		onboarding: viOnboarding,
	},
} as const;

/** Resolve a stored preference to a concrete BCP-47 locale we ship. */
function resolveLocale(pref: LocalePreference): Locale {
	if (pref === "en" || pref === "zh-CN" || pref === "vi") return pref;
	const nav = (
		typeof navigator !== "undefined" && navigator.language
			? navigator.language
			: "en"
	).toLowerCase();
	if (nav.startsWith("zh")) return "zh-CN";
	if (nav.startsWith("vi")) return "vi";
	return "en";
}

/**
 * Apply a locale preference to i18n + `<html lang>`.
 * Used at boot and whenever settings.locale changes (including the
 * lightweight settings window, which does not mount `useAppBootstrap`).
 */
export function applyLocale(pref: LocalePreference): Locale {
	const resolved = resolveLocale(pref);
	void i18n.changeLanguage(resolved);
	if (typeof document !== "undefined") {
		document.documentElement.lang = resolved;
	}
	return resolved;
}

// Locale is applied in `main.tsx` after `ensureSettingsLoaded()` (XDG file).
// Boot with English until then to avoid a flash of the wrong language on first paint.
i18n.use(initReactI18next).init({
	resources,
	lng: "en",
	fallbackLng: "en",
	defaultNS: DEFAULT_NS,
	ns: Object.keys(resources.en),
	interpolation: { escapeValue: false },
	returnNull: false,
});

/**
 * Locale-formatted timestamp for UI display (session lists, sync status, …).
 * Omit `locale` to use the host default locale.
 */
export function formatLocaleTimestamp(
	date: Date | number | string,
	locale?: string,
): string {
	return new Date(date).toLocaleString(locale);
}

export default i18n;
