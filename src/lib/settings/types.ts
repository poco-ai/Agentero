import type {
	PaperTreeLabelMode,
	PaperTreeSortMode,
} from "@/lib/paper/tree-modes";
import type { LayoutSettings } from "@/lib/pdf/layout/settings";
import type {
	CommercialTranslateProviderId,
	TranslateProviderConfig,
	TranslateProviderId,
	TranslateSettings,
	TranslateTargetLang,
} from "@/lib/translate/types";

export type {
	LayoutBackend,
	LayoutProviderConfig,
	LayoutProviderId,
	LayoutSettings,
} from "@/lib/pdf/layout/settings";
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
	| "publication"
	| "tags"
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
	"publication",
	"tags",
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

/**
 * How NOTES.md is initialized when a paper is imported.
 * - `standard`: built-in structured skeleton
 * - `title-only`: title heading only
 * - `blank`: empty file
 * - `custom`: copy the vault template `.agentero/templates/NOTES.md`
 */
export type PaperNoteMode = "standard" | "title-only" | "blank" | "custom";

export const PAPER_NOTE_MODES: readonly PaperNoteMode[] = [
	"standard",
	"title-only",
	"blank",
	"custom",
] as const;

export function isPaperNoteMode(v: unknown): v is PaperNoteMode {
	return (
		typeof v === "string" && (PAPER_NOTE_MODES as readonly string[]).includes(v)
	);
}

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
	 * How NOTES.md is initialized on paper import. `custom` copies the vault
	 * template `.agentero/templates/NOTES.md`. Default: built-in skeleton.
	 */
	paperNoteMode: PaperNoteMode;
	/**
	 * Open a paper's NOTES.md in the reading split whenever a paper is opened.
	 * Default **on**; off opens only the PDF/HTML body — NOTES is still one
	 * `⌘\` / "Open notes" away.
	 */
	autoOpenPaperNotes: boolean;
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
	 * Host loopback Streamable HTTP MCP server (`http://127.0.0.1:{port}/mcp`).
	 * Default **off**. Local vault only.
	 */
	mcpEnabled: boolean;
	mcpPort: number;
	/**
	 * OpenAI Secure MCP Tunnel id (`tunnel_` + 32 hex). Empty = not configured.
	 */
	mcpTunnelId: string;
	/**
	 * OpenAI control-plane Runtime API key. Masked on read like other keys.
	 */
	mcpTunnelApiKey: string;
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
	 * Prefill the Markdown export dialog's "Agentero watermark" checkbox.
	 * Default **off**; per-export choice can still override.
	 */
	exportWatermarkEnabled: boolean;
	/**
	 * Anonymous product analytics (app version + device info) via PostHog.
	 * Default **on**; takes effect from the next launch.
	 */
	telemetryEnabled: boolean;
	/**
	 * Plaza discovery sources (Cool Papers, feeds, Skill picks) in the sidebar.
	 * Default **on**. Off hides the node and does not mount Plaza panels.
	 */
	plazaEnabled: boolean;
	/**
	 * Plaza source ids hidden from the sidebar and Plaza home page
	 * (e.g. `"cool-papers"`). Right-click a source row to hide it, the Plaza
	 * parent row to restore. Empty = show all sources.
	 */
	plazaHiddenSources: string[];
	/**
	 * First-run setup wizard completed (welcome → theme → agent →
	 * translate/layout → create vault / Zotero import). `false` shows the
	 * onboarding overlay on the main window for fresh installs.
	 */
	onboardingDone: boolean;
	/**
	 * Post-vault feature tour (driver.js highlight walkthrough) completed or
	 * skipped. `false` starts the tour the first time a vault is open.
	 */
	featureTourDone: boolean;
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
	 * UI chrome font (sidebars, toolbars, settings). Empty = app default (Geist).
	 * Also accepts built-in stacks (`system` | `serif` | `mono`) or a system
	 * family name discovered via `list_system_fonts`.
	 */
	interfaceFontFamily: string;
	/**
	 * Markdown / notes body font. Empty = inherit interface / app default.
	 * Same value vocabulary as {@link interfaceFontFamily}.
	 */
	textFontFamily: string;
	/**
	 * Monospace font for code blocks, frontmatter, and `font-mono` UI.
	 * Empty = app default mono stack. Same value vocabulary as above.
	 */
	monoFontFamily: string;
	/**
	 * Markdown editor body line-height (unitless multiplier). Orthogonal to
	 * {@link uiScale}. Typical range 1.4–2.0; default 1.6.
	 */
	editorLineHeight: number;
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
	/**
	 * OpenAI-compatible embedding endpoint (BYOK) for arxiv daily recommendation
	 * and other semantic features. All fields empty = feature disabled.
	 */
	embedding: EmbeddingSettings;
	/** Application-level translation service (free MT + BYOA Agent). */
	translate: TranslateSettings;
	/** PDF layout-analysis backend (local ONNX or remote PP-StructureV3). */
	layout: LayoutSettings;
};

/** PDF selection Ask (question popover) agent/model prefs. */
export type PdfAskSettings = {
	/** Empty = follow registry default agent. */
	agentId: string;
	/** Empty = follow loadModelPref(agentId). */
	modelId: string;
};

/** OpenAI-compatible embedding endpoint (BYOK). All-empty = disabled. */
export type EmbeddingSettings = {
	/** Endpoint base, e.g. `https://api.openai.com/v1`. Empty = unset. */
	baseUrl: string;
	/** BYOK secret; masked (`*`) when echoed back from the Host. */
	apiKey: string;
	/** Embedding model id, e.g. `text-embedding-3-small`, `BAAI/bge-m3`. */
	model: string;
};
