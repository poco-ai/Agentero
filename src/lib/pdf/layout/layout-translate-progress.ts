import type { LayoutTranslateItemStatus } from "@/lib/pdf/layout/types";

/**
 * Share of a translation job that has already settled.
 *
 * Running blocks include their settled sentence share. Done, failed, and skipped
 * blocks are finished work, so a failed block does not pin the meter open.
 * No blocks yet means the total is unknown.
 */
export function layoutTranslateSettledRatio(
	items: readonly { status: LayoutTranslateItemStatus; progress?: number }[],
): number | null {
	if (items.length === 0) return null;
	let settled = 0;
	for (const item of items) {
		if (
			item.status === "done" ||
			item.status === "error" ||
			item.status === "skipped"
		) {
			settled += 1;
		} else if (item.status === "running" && Number.isFinite(item.progress)) {
			settled += Math.max(0, Math.min(1, item.progress ?? 0));
		}
	}
	return settled / items.length;
}

/** Translation and page generation report real work; cache hits only generate pages. */
export function layoutTranslateDisplayRatio(
	settled: number | null,
	previewPending: boolean,
	reflowProgress = 0,
	cacheOnly = false,
): number | null {
	if (settled == null) return null;
	if (!previewPending) return settled;
	const built = Number.isFinite(reflowProgress)
		? Math.max(0, Math.min(1, reflowProgress))
		: 0;
	if (cacheOnly) return Math.min(0.99, built);
	// Leave 100% for the committed output, not just PDF byte generation, but
	// never claim more than the document has settled: a partial run would peak
	// above its share while pages build and drop back when the preview lands.
	return Math.min(0.99, settled, settled * 0.7 + built * 0.3);
}
