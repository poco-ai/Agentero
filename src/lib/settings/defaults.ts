import type { AppSettings, PdfAskSettings } from "@/lib/settings/types";
import { DEFAULT_LIBRARY_COLUMNS } from "@/lib/settings/types";
import { DEFAULT_TRANSLATE_SETTINGS } from "@/lib/translate/defaults";
import { DEFAULT_UI_THEME } from "@/lib/ui/theme";

export const DEFAULT_PDF_ASK_SETTINGS: PdfAskSettings = {
	agentId: "",
	modelId: "",
};

/** Default Translator Runtime endpoint (overridable in Settings). */
export const DEFAULT_TRANSLATOR_BASE_URL = "https://translator.philfan.cn";
export const DEFAULT_NETWORK_PROXY_URL = "http://127.0.0.1:7890";

/**
 * Discrete UI scale presets exposed in Settings. Keyboard shortcuts and the
 * settings UI move between these values instead of using a continuous slider.
 */
export const UI_SCALE_PRESETS = [0.8, 0.9, 1, 1.25, 1.5] as const;

export const DEFAULT_SETTINGS: AppSettings = {
	translatorBaseUrl: DEFAULT_TRANSLATOR_BASE_URL,
	networkProxyEnabled: false,
	networkProxyUrl: DEFAULT_NETWORK_PROXY_URL,
	paperTreeLabelMode: "title-author",
	paperTreeSortMode: "folder",
	autoUpdateInternalLinks: "ask",
	libraryColumns: DEFAULT_LIBRARY_COLUMNS.map((c) => ({ ...c })),
	connectorEnabled: false,
	connectorPort: 23119,
	zoteroSyncDir: "",
	batchImportConcurrency: 5,
	telemetryEnabled: true,
	exportWatermarkEnabled: false,
	theme: "system",
	uiTheme: DEFAULT_UI_THEME,
	locale: "system",
	editorFontSize: 14,
	uiScale: 1,
	showEditorToolbar: true,
	agentPermissionMode: "restricted",
	autoPaperReader: false,
	aiResponseLanguage: "auto",
	agentPersonalPrompt: "",
	pdfAsk: { ...DEFAULT_PDF_ASK_SETTINGS },
	translate: { ...DEFAULT_TRANSLATE_SETTINGS },
};

/** Snap an arbitrary scale value to the closest supported preset. */
export function snapUiScale(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_SETTINGS.uiScale;
	let closest: number = UI_SCALE_PRESETS[0];
	let best = Infinity;
	for (const preset of UI_SCALE_PRESETS) {
		const d = Math.abs(preset - value);
		if (d < best) {
			best = d;
			closest = preset;
		}
	}
	return closest;
}
