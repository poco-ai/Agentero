/**
 * Shared PDF floating chrome surfaces (Apple-style materials).
 *
 * Small chips (toolbars / find / bottom bar) are lighter glass.
 * Side panels are thicker (stronger blur + shadow).
 * Selection cards stay near-opaque for long-form readability.
 * Mark hosts with `data-pdf-chrome` so reduced-transparency can frost them.
 */

/** Compact HUD chips: top toolbars, bottom bar, find bar, page-edge tabs. */
export const PDF_CHROME_CHIP =
	"border border-border/50 bg-background/80 shadow-raised ring-1 ring-foreground/10 backdrop-blur-md backdrop-saturate-150 supports-backdrop-blur:bg-background/60 dark:border-white/10 dark:ring-white/10";

/** Auto-hide chrome: materialize (opacity + slight rise), not a plain fade. */
export const PDF_CHROME_VIS =
	"transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-opacity motion-reduce:duration-150";

export const PDF_CHROME_VIS_SHOW = "translate-y-0 scale-100 opacity-100";

export const PDF_CHROME_VIS_HIDE =
	"-translate-y-1 scale-[0.98] opacity-0 motion-reduce:translate-y-0 motion-reduce:scale-100";

/**
 * Left outline / references / figures panel.
 * Heavier material than chips; enters from the left (spatial consistency).
 * Reserve the bottom 4rem for the page / zoom bar and a clear gap.
 */
export const PDF_SIDE_PANEL =
	"absolute top-0 bottom-16 left-0 z-20 w-80 select-none border-r border-border/50 bg-background/90 pt-11 pb-2 shadow-overlay backdrop-blur-xl backdrop-saturate-150 supports-backdrop-blur:bg-background/75 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-2 motion-safe:duration-200 motion-reduce:animate-none";

/** Icon-only selection menu — glassier than long-form cards. */
export const PDF_SELECTION_MENU =
	"rounded-xl border border-border/50 bg-background/90 shadow-overlay ring-1 ring-foreground/10 backdrop-blur-md backdrop-saturate-150 supports-backdrop-blur:bg-background/75 dark:ring-white/10";

/** Ask / translate / preview cards — near-solid for dense text. */
export const PDF_FLOAT_CARD =
	"rounded-xl border border-border/60 bg-background/95 text-foreground shadow-overlay ring-1 ring-foreground/10 backdrop-blur-sm supports-backdrop-blur:bg-background/90 dark:ring-white/10";
