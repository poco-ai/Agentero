import { DEFAULT_LAYOUT_SETTINGS } from "@/lib/pdf/layout/settings";
import type {
	AppSettings,
	DecisionProviderId,
	DecisionSettings,
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

/**
 * Per-provider defaults applied when the user switches the decision provider.
 * Clef / OpenAI need a user-supplied endpoint (Cloudflare includes the account
 * id; OpenAI is not public yet), so their base URL stays empty.
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
		baseUrl: "",
		model: "",
		keyUrl: "https://platform.openai.com/api-keys",
		consoleUrl: "",
	},
	custom: {
		baseUrl: "",
		model: "",
		keyUrl: "",
		consoleUrl: "",
	},
};

/** Default Translator Runtime endpoint (overridable in Settings). */
export const DEFAULT_TRANSLATOR_BASE_URL =
	"https://translation-server.agentero.app";
export const DEFAULT_NETWORK_PROXY_URL = "http://127.0.0.1:7890";

/**
 * Built-in URL-prefix GitHub mirrors. The user picks from this list instead of
 * typing a custom URL. All entries must support `{base}/{canonical_github_url}`.
 * Availability of public mirrors varies, so this list is maintained in-code.
 */
export const GITHUB_MIRROR_PRESETS = [
	"https://gh.llkk.cc",
	"https://mirror.ghproxy.com",
	"https://ghproxy.net",
	"https://github.moeyy.xyz",
] as const;

/** Gateway flavour for the institution proxy (`institutionProxyType`). */
export type InstitutionProxyKind = "ezproxy" | "wengine";

export type InstitutionProxyPreset = {
	id: string;
	kind: InstitutionProxyKind;
	/** Gateway origin only — the rewrite logic appends the path/query form. */
	prefix: string;
};

/**
 * Built-in institution WebVPN gateways offered as quick-fill presets beside the
 * free-text prefix field. Only gateways confirmed to run the wengine
 * path-rewriting engine are listed: the AES key is engine-wide, so the origin
 * is all we need and both gateway kinds still accept a hand-typed prefix.
 * Covers the "preset school table" deferred from the first institution-proxy
 * PR (#677). Labels live at `general.institutionProxy.presets.{id}`.
 */
export const INSTITUTION_PROXY_PRESETS = [
	{ id: "zju", kind: "wengine", prefix: "https://webvpn.zju.edu.cn" },
	{ id: "ustc", kind: "wengine", prefix: "https://webvpn.ustc.edu.cn" },
	{ id: "xjtu", kind: "wengine", prefix: "https://webvpn.xjtu.edu.cn" },
	{ id: "neu", kind: "wengine", prefix: "https://webvpn.neu.edu.cn" },
	{ id: "zjnu", kind: "wengine", prefix: "https://webvpn.zjnu.edu.cn" },
	{ id: "sjzu", kind: "wengine", prefix: "https://webvpn.sjzu.edu.cn" },
	{ id: "zqu", kind: "wengine", prefix: "https://webvpn.zqu.edu.cn" },
] as const satisfies readonly InstitutionProxyPreset[];

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
	easyScholarKey: "",
	institutionProxyPrefix: "",
	institutionProxyCookie: "",
	institutionProxyType: "ezproxy",
	networkProxyEnabled: false,
	networkProxyUrl: DEFAULT_NETWORK_PROXY_URL,
	githubMirrorEnabled: false,
	githubMirrorBaseUrl: GITHUB_MIRROR_PRESETS[0],
	paperTreeLabelMode: "title-author",
	paperTreeSortMode: "folder",
	autoUpdateInternalLinks: "ask",
	pdfScrollStrategy: "vertical",
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
	agentPermissionMode: "restricted",
	autoPaperReader: false,
	aiResponseLanguage: "auto",
	agentPersonalPrompt: "",
	pdfAsk: { ...DEFAULT_PDF_ASK_SETTINGS },
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
