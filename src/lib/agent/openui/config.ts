/**
 * Central switch for read-only OpenUI Lang blocks in agent replies.
 *
 * Set to `false` to disable the whole feature: assistant Markdown is passed to
 * Streamdown unchanged, so `openui-lang` fences render as ordinary code blocks.
 * No settings UI is exposed in Phase 1. The Host-side guidance lives in
 * `src-tauri/src/features/agent/prompt/envelope.rs` (`UI_BLOCKS_GUIDANCE`);
 * when this switch is off, those fences still fall back to ordinary Markdown.
 */
export const AGENT_OPENUI_BLOCKS_ENABLED = true;

/** Root statement the prompt asks the model to emit. */
export const OPENUI_ROOT_COMPONENT = "Stack";

/**
 * Fence info strings accepted by the renderer. `openui` is accepted for
 * compatibility with models that omit the `-lang` suffix; `<openui-lang>` tags
 * are normalized to fenced blocks before Markdown parsing.
 */
export const OPENUI_LANGUAGES = ["openui-lang", "openui"] as const;

/** Hard cap before parsing; large source falls back without blocking the UI. */
export const OPENUI_MAX_SOURCE_CHARS = 24_000;

/**
 * Rendering limits. Data beyond these limits is not truncated silently: the
 * block falls back to its source so the reader can still inspect every value.
 */
export const OPENUI_LIMITS = {
	maxNodes: 200,
	maxChildren: 40,
	maxTextChars: 4_000,
	maxTableColumns: 8,
	maxTableRows: 60,
	maxTableCells: 400,
	maxTableCellChars: 500,
	maxChartPoints: 24,
	maxChartLabelChars: 80,
	maxSteps: 12,
	maxStepChars: 400,
	maxCalloutBodyChars: 2_000,
	maxShortTextChars: 200,
} as const;

export function isOpenUiLanguage(language: string): boolean {
	const normalized = language.trim().toLowerCase();
	return OPENUI_LANGUAGES.some((candidate) => candidate === normalized);
}
