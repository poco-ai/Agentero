import { DEFAULT_LAYOUT_SETTINGS } from "@/lib/pdf/layout/settings";
import type {
	AppSettings,
	EmbeddingSettings,
	PdfAskSettings,
} from "@/lib/settings/types";
import { DEFAULT_LIBRARY_COLUMNS } from "@/lib/settings/types";
import { DEFAULT_TRANSLATE_SETTINGS } from "@/lib/translate/defaults";
import { DEFAULT_UI_THEME } from "@/lib/ui/theme";

export const DEFAULT_PDF_ASK_SETTINGS: PdfAskSettings = {
	agentId: "",
	modelId: "",
};

export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
	baseUrl: "",
	apiKey: "",
	model: "",
};

/** Default Translator Runtime endpoint (overridable in Settings). */
export const DEFAULT_TRANSLATOR_BASE_URL = "https://translator.philfan.cn";
export const DEFAULT_NETWORK_PROXY_URL = "http://127.0.0.1:7890";

/**
 * Discrete UI scale presets exposed in Settings. Keyboard shortcuts and the
 * settings UI move between these values instead of using a continuous slider.
 */
export const UI_SCALE_PRESETS = [0.8, 0.9, 1, 1.25, 1.5] as const;

/** Markdown editor line-height slider bounds (unitless). */
export const EDITOR_LINE_HEIGHT_MIN = 1.4;
export const EDITOR_LINE_HEIGHT_MAX = 2.0;
export const EDITOR_LINE_HEIGHT_STEP = 0.1;
export const DEFAULT_EDITOR_LINE_HEIGHT = 1.6;

/** Clamp and snap line-height to the supported slider range (0.1 steps). */
export function clampEditorLineHeight(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_EDITOR_LINE_HEIGHT;
	const clamped = Math.min(
		EDITOR_LINE_HEIGHT_MAX,
		Math.max(EDITOR_LINE_HEIGHT_MIN, value),
	);
	return Math.round(clamped * 10) / 10;
}

export const DEFAULT_SETTINGS: AppSettings = {
	translatorBaseUrl: DEFAULT_TRANSLATOR_BASE_URL,
	networkProxyEnabled: false,
	networkProxyUrl: DEFAULT_NETWORK_PROXY_URL,
	paperTreeLabelMode: "title-author",
	paperTreeSortMode: "folder",
	autoUpdateInternalLinks: "ask",
	paperNoteMode: "standard",
	autoOpenPaperNotes: true,
	libraryColumns: DEFAULT_LIBRARY_COLUMNS.map((c) => ({ ...c })),
	connectorEnabled: false,
	connectorPort: 23119,
	mcpEnabled: false,
	mcpPort: 8765,
	mcpTunnelId: "",
	mcpTunnelApiKey: "",
	zoteroSyncDir: "",
	batchImportConcurrency: 5,
	exportWatermarkEnabled: false,
	telemetryEnabled: true,
	plazaEnabled: true,
	plazaHiddenSources: [],
	onboardingDone: false,
	featureTourDone: false,
	theme: "system",
	uiTheme: DEFAULT_UI_THEME,
	locale: "system",
	editorFontSize: 14,
	interfaceFontFamily: "",
	textFontFamily: "",
	monoFontFamily: "",
	editorLineHeight: DEFAULT_EDITOR_LINE_HEIGHT,
	uiScale: 1,
	showEditorToolbar: true,
	agentPermissionMode: "restricted",
	autoPaperReader: false,
	aiResponseLanguage: "auto",
	agentPersonalPrompt: "",
	pdfAsk: { ...DEFAULT_PDF_ASK_SETTINGS },
	embedding: { ...DEFAULT_EMBEDDING_SETTINGS },
	translate: { ...DEFAULT_TRANSLATE_SETTINGS },
	layout: { ...DEFAULT_LAYOUT_SETTINGS, providerConfigs: {} },
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
