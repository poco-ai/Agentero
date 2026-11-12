import { DEFAULT_LAYOUT_SETTINGS } from "@/lib/pdf/layout/settings";
import type {
	AppSettings,
	DecisionProviderId,
	DecisionSettings,
	EmbeddingSettings,
	PaperReaderSettings,
	PdfAskSettings,
} from "@/lib/settings/types";
import { DEFAULT_LIBRARY_COLUMNS } from "@/lib/settings/types";
import { DEFAULT_TRANSLATE_SETTINGS } from "@/lib/translate/defaults";
import { DEFAULT_UI_THEME } from "@/lib/ui/theme";

export const DEFAULT_PDF_ASK_SETTINGS: PdfAskSettings = {
	agentId: "",
	modelId: "",
};

export const DEFAULT_PAPER_READER_SETTINGS: PaperReaderSettings = {
	agentId: "",
	modelId: "",
};

export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
	source: "custom",
	baseUrl: "",
	apiKey: "",
	model: "",
};

/** Default System One endpoint (TypeSafe jEV). */
export const DEFAULT_DECISION_BASE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_DECISION_MODEL = "jev-latest";

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
	provider: "jev",
	apiKey: "",
	baseUrl: DEFAULT_DECISION_BASE_URL,
	model: DEFAULT_DECISION_MODEL,
	smartHighlight: false,
};

/** Default OpenAI Decisions endpoint + model. */
export const DEFAULT_OPENAI_DECISIONS_BASE_URL =
	"https://api.openai.com/v1/decisions";
export const DEFAULT_OPENAI_DECISIONS_MODEL = "gpt-6-luna";

/**
 * Per-provider defaults applied when the user switches the decision provider.
 * Clef still needs a user-supplied Cloudflare Worker URL (account id). OpenAI
 * Decisions is public: preset fills `/v1/decisions` + `gpt-6-luna`.
 */
export const DECISION_PROVIDER_PRESETS: Record<
	DecisionProviderId,
	{ baseUrl: string; model: string; keyUrl: string; consoleUrl: string }
> = {
	jev: {
		baseUrl: DEFAULT_DECISION_BASE_URL,
		model: DEFAULT_DECISION_MODEL,
		keyUrl: "https://console.typesafe.ai/keys",
		consoleUrl: "",
	},
	clef: {
		baseUrl: "",
		model: "clef",
		keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
		consoleUrl: "",
	},
	openai: {
		baseUrl: DEFAULT_OPENAI_DECISIONS_BASE_URL,
		model: DEFAULT_OPENAI_DECISIONS_MODEL,
		keyUrl: "https://platform.openai.com/api-keys",
		consoleUrl: "https://platform.openai.com/playground/decisions",
	},
	custom: {
		baseUrl: "",
		model: "",
		keyUrl: "",
		consoleUrl: "",
	},
};

/** Official Translator Runtime endpoint (hardcoded; not user-configurable). */
export const DEFAULT_TRANSLATOR_BASE_URL =
	"https://translation-server.agentero.app";
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

/** Wiki-embed body font, px before UI scale. Matches the old `text-sm` (13px). */
export const WIKI_EMBED_FONT_SIZE_MIN = 12;
export const WIKI_EMBED_FONT_SIZE_MAX = 20;
export const DEFAULT_WIKI_EMBED_FONT_SIZE = 13;

/** Clamp wiki-embed body size onto the settings slider (integer px). */
export function clampWikiEmbedFontSize(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_WIKI_EMBED_FONT_SIZE;
	const rounded = Math.round(value);
	return Math.min(
		WIKI_EMBED_FONT_SIZE_MAX,
		Math.max(WIKI_EMBED_FONT_SIZE_MIN, rounded),
	);
}

/**
 * Markdown column width presets (CSS px). `0` is full pane width and the
 * default. Values outside the list fall back to full width.
 */
export const MARKDOWN_MAX_WIDTH_PRESETS = [640, 720, 800, 960, 1120] as const;
export const DEFAULT_MARKDOWN_MAX_WIDTH = 0;

/** Keep only full width or a listed preset. */
export function clampMarkdownMaxWidth(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_MARKDOWN_MAX_WIDTH;
	const rounded = Math.round(value);
	return (MARKDOWN_MAX_WIDTH_PRESETS as readonly number[]).includes(rounded)
		? rounded
		: DEFAULT_MARKDOWN_MAX_WIDTH;
}

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
	shortcutOverrides: {},
	easyScholarKey: "",
	zhihuAccessSecret: "",
	institutionProxyPrefix: "",
	institutionProxyCookie: "",
	institutionProxyType: "auto",
	networkProxyEnabled: false,
	networkProxyUrl: DEFAULT_NETWORK_PROXY_URL,
	paperTreeLabelMode: "title-author",
	paperTreeSortMode: "folder",
	autoUpdateInternalLinks: "ask",
	terminalApp: "",
	pdfScrollStrategy: "vertical",
	pdfVimKeys: true,
	vimMode: true,
	hintModeEnabled: true,
	pdfSpreadMode: "none",
	paperNoteMode: "standard",
	autoOpenPaperNotes: true,
	autoIngest: true,
	replaceCurrentTabOnOpenPaper: false,
	libraryColumns: DEFAULT_LIBRARY_COLUMNS.map((c) => ({ ...c })),
	connectorEnabled: false,
	connectorPort: 23119,
	mcpEnabled: false,
	mcpPort: 8765,
	mcpExposePaperText: false,
	mcpTunnelId: "",
	mcpTunnelApiKey: "",
	zoteroSyncDir: "",
	batchImportConcurrency: 5,
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
	wikiEmbedFontSize: DEFAULT_WIKI_EMBED_FONT_SIZE,
	markdownMaxWidth: DEFAULT_MARKDOWN_MAX_WIDTH,
	agentPermissionMode: "restricted",
	autoPaperReader: false,
	aiResponseLanguage: "auto",
	agentPersonalPrompt: "",
	pdfAsk: { ...DEFAULT_PDF_ASK_SETTINGS },
	paperReader: { ...DEFAULT_PAPER_READER_SETTINGS },
	embedding: { ...DEFAULT_EMBEDDING_SETTINGS },
	translate: { ...DEFAULT_TRANSLATE_SETTINGS },
	layout: { ...DEFAULT_LAYOUT_SETTINGS, providerConfigs: {} },
	dismissedReminders: [],
	decision: { ...DEFAULT_DECISION_SETTINGS },
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
