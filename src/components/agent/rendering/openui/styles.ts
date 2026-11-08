/**
 * Shared visual language for read-only UI blocks.
 *
 * Radius ladder: upstream `Card` (rounded-xl) → nested surface (rounded-lg) →
 * pill / badge (rounded-md). Do not add per-component corner values; a block
 * that needs a new surface picks the matching rung.
 *
 * Colors come from theme tokens. `info` follows `--primary` and `danger`
 * follows `--destructive`; `success` / `warning` use the app-level semantic
 * tokens from `index.css`, so no block paints fixed emerald / amber shades
 * that ignore the active UI theme.
 */

export const OPENUI_TONES = [
	"neutral",
	"info",
	"success",
	"warning",
	"danger",
] as const;

export type OpenUiTone = (typeof OPENUI_TONES)[number];
export type OpenUiCalloutTone = Exclude<OpenUiTone, "neutral">;

export function resolveTone(value: string, fallback: OpenUiTone): OpenUiTone {
	return (OPENUI_TONES as readonly string[]).includes(value)
		? (value as OpenUiTone)
		: fallback;
}

/** Callout accepts tones without `neutral`; unknown values read as info. */
export function resolveCalloutTone(value: string): OpenUiCalloutTone {
	const tone = resolveTone(value, "info");
	return tone === "neutral" ? "info" : tone;
}

export const TONE_BADGE_CLASS: Record<OpenUiTone, string> = {
	neutral: "border-border bg-muted/60 text-muted-foreground",
	info: "border-primary/25 bg-primary/10 text-primary",
	success: "border-success/30 bg-success/10 text-success",
	warning: "border-warning/30 bg-warning/10 text-warning",
	danger: "border-destructive/30 bg-destructive/10 text-destructive",
};

export const TONE_SURFACE_CLASS: Record<OpenUiCalloutTone, string> = {
	info: "border-primary/20 bg-primary/5",
	success: "border-success/30 bg-success/10",
	warning: "border-warning/30 bg-warning/10",
	danger: "border-destructive/25 bg-destructive/5",
};

export const TONE_ICON_CLASS: Record<OpenUiCalloutTone, string> = {
	info: "text-primary",
	success: "text-success",
	warning: "text-warning",
	danger: "text-destructive",
};

/** Section title used by bare blocks that have no upstream CardTitle. */
export const BLOCK_TITLE_CLASS =
	"font-heading text-sm font-semibold text-foreground";

export const BLOCK_CAPTION_CLASS = "text-xs text-muted-foreground";

/** Level-two surface: callout, figure reference, claim row, empty state. */
export const NESTED_SURFACE_CLASS =
	"rounded-lg border border-border/60 bg-muted/20";

export const EMPTY_STATE_CLASS =
	"rounded-lg border border-border/60 border-dashed bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground";

/** Text link that opens a vault path or PDF fragment from a block. */
export const SOURCE_LINK_CLASS =
	"inline-flex w-fit items-center gap-0.5 rounded-md text-xs font-medium text-primary underline-offset-2 outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring/50";

/** Whole-row link used by Outline and SourceList. */
export const ROW_LINK_CLASS =
	"outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50";

/** Base shape shared by Badge / TagList / PaperCard tags. */
export const PILL_CLASS = "h-5 shrink-0 rounded-md px-1.5 text-[11px]";

export const TAG_PILL_CLASS =
	"border-border/60 bg-muted/50 font-normal text-foreground";
