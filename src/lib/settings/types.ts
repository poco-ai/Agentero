import type {
	PaperTreeLabelMode,
	PaperTreeSortMode,
} from "@/lib/paper/tree-modes";
import type {
	CommercialTranslateProviderId,
	TranslateProviderConfig,
	TranslateProviderId,
	TranslateSettings,
	TranslateTargetLang,
} from "@/lib/translate/types";

export type {
	CommercialTranslateProviderId,
	PaperTreeLabelMode,
	PaperTreeSortMode,
	TranslateProviderConfig,
	TranslateProviderId,
	TranslateSettings,
	TranslateTargetLang,
};

export type ThemePreference = "system" | "light" | "dark";

export type LocalePreference = "system" | "en" | "zh-CN";

/** Sortable / customizable columns in the papers Library table. */
export type LibraryColumnKey =
	| "title"
	| "authors"
	| "year"
	| "tags"
	| "type"
	| "id";

/** Per-column display preference: order comes from array position. */
export type LibraryColumnPref = {
	key: LibraryColumnKey;
	visible: boolean;
};

/** Canonical column order (also the source of truth for reconciliation). */
export const LIBRARY_COLUMN_KEYS: LibraryColumnKey[] = [
	"title",
	"authors",
	"year",
	"tags",
	"type",
	"id",
];

/** Default: every column visible, in canonical order. */
export const DEFAULT_LIBRARY_COLUMNS: LibraryColumnPref[] =
	LIBRARY_COLUMN_KEYS.map((key) => ({ key, visible: true }));

/**
 * How Agentero responds to agent permission escalations.
 * - `restricted`: decline requests (Codex uses workspace-write).
 * - `ask`: forward each request to the user for an explicit decision.
 * - `auto`: auto-approve every request (YOLO; Codex uses danger-full-access).
 */
export type AgentPermissionMode = "restricted" | "ask" | "auto";

/**
 * Language every agent response (and notes written to files) should use.
 * Independent from the UI `locale`. `auto` injects no directive (agent decides).
 */
export type AiResponseLanguage = "auto" | "en" | "zh-CN";

/** How a verified external local rename may repair resolved internal links. */
export type AutoUpdateInternalLinks = "ask" | "always";

export const AUTO_UPDATE_INTERNAL_LINKS: AutoUpdateInternalLinks[] = [
	"ask",
	"always",
];

export type AppSettings = {
	// General
	/**
	 * Translator Runtime base URL for magic-wand / identifier import.
	 * Default: hosted poco-ai service.
	 */
	translatorBaseUrl: string;
	/** Process-wide HTTP(S)/SOCKS proxy for Host requests and Agent traffic. */
	networkProxyEnabled: boolean;
	networkProxyUrl: string;
	/**
	 * How paper folders are labeled in the file tree (display-only).
	 * Default: title · author.
	 */
	paperTreeLabelMode: PaperTreeLabelMode;
	/**
	 * How siblings under each folder are ordered in the file tree (display-only).
	 * Default: display name A–Z (matches paperTreeLabelMode labels).
	 */
	paperTreeSortMode: PaperTreeSortMode;
	/** Default `ask`: external local renames are previewed before Markdown writes. */
	autoUpdateInternalLinks: AutoUpdateInternalLinks;
	/**
	 * Papers Library table columns: order (array position) + visibility.
	 * Reconciled against {@link LIBRARY_COLUMN_KEYS}; `title` is always visible.
	 */
	libraryColumns: LibraryColumnPref[];
	/**
	 * Host local HTTP server compatible with the official Zotero Connector
	 * (loopback :23119). Default **off**; mutually exclusive with Zotero desktop.
	 */
	connectorEnabled: boolean;
	connectorPort: number;
	/**
	 * Zotero data directory (contains `zotero.sqlite` + `storage/`) used by
	 * bidirectional sync. Empty = auto-detect `~/Zotero` or pick in the dialog.
	 */
	zoteroSyncDir: string;
	/**
	 * Max concurrent identifier imports in a single magic-wand batch.
	 * Clamped to 1–10; higher values download more papers in parallel but
	 * increase rate-limit risk.
	 */
	batchImportConcurrency: number;
	/**
	 * Opt-out switch for diagnostics reporting (crash/error logs, app & OS
	 * version, installed agents). Default **on**; no-op unless the Host was
	 * built with a telemetry endpoint.
	 */
	telemetryEnabled: boolean;
	/**
	 * Prefill the Markdown export dialog's "Agentero watermark" checkbox.
	 * Default **off**; per-export choice can still override.
	 */
	exportWatermarkEnabled: boolean;
	// Appearance
	theme: ThemePreference;
	/**
	 * Bundled tweakcn color theme name; `"default"` keeps the built-in look.
	 * See src/lib/ui/theme.ts.
	 */
	uiTheme: string;
	locale: LocalePreference;
	editorFontSize: number;
	/**
	 * Global UI scale multiplier. Affects font-size, spacing, and the title bar,
	 * so toolbar buttons grow together with the rest of the interface.
	 * Must be one of {@link UI_SCALE_PRESETS}; default 1.0 (100%).
	 */
	uiScale: number;
	/** Show the WYSIWYG formatting toolbar above Markdown/notes editors. */
	showEditorToolbar: boolean;
	// Agent (local UI prefs; registry lives in Host agents.json)
	/** Global permission handling applied to every agent run. */
	agentPermissionMode: AgentPermissionMode;
	/**
	 * After magic-wand import / single-paper Download, auto-run paper-reader
	 * when assets are ready and catalog `is_read` is false.
	 * Default **off**; Zap still works for manual runs.
	 */
	autoPaperReader: boolean;
	/** Language forced onto every agent response and generated notes. */
	aiResponseLanguage: AiResponseLanguage;
	/**
	 * Free-form user preference instructions injected into every agent
	 * prompt envelope (Composer, paper-reader, workflows, …). Empty = off.
	 */
	agentPersonalPrompt: string;
	/**
	 * Agent seat + model for PDF selection Ask dialogs (划词提问).
	 * Independent of Chat's current agent and of translate.agentId.
	 * Empty agentId / modelId = follow app default agent / that agent's model pref.
	 */
	pdfAsk: PdfAskSettings;
	/** Application-level translation service (free MT + BYOA Agent). */
	translate: TranslateSettings;
};

/** PDF selection Ask (question popover) agent/model prefs. */
export type PdfAskSettings = {
	/** Empty = follow registry default agent. */
	agentId: string;
	/** Empty = follow loadModelPref(agentId). */
	modelId: string;
};
