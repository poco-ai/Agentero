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

/** One block's settled share; finished states count as whole blocks. */
function settledShare(item: {
	status: LayoutTranslateItemStatus;
	progress?: number;
}) {
	if (
		item.status === "done" ||
		item.status === "error" ||
		item.status === "skipped"
	) {
		return 1;
	}
	if (item.status === "running" && Number.isFinite(item.progress)) {
		return Math.max(0, Math.min(1, item.progress ?? 0));
	}
	return 0;
}

/** Page-weighted translation progress with the counts the meter displays. */
export type LayoutTranslatePageProgress = {
	/** 0–1 across the run, every page weighing the same. */
	ratio: number;
	/** Pages whose blocks have all settled. */
	pagesDone: number;
	/** Pages this run touches; fixed when the run starts. */
	pagesTotal: number;
};

/**
 * Page-normalized text progress: a page advances by its own settled blocks, and
 * every page weighs the same, so a heavy page cannot dominate the run.
 *
 * Both denominator terms are fixed when the run starts (page count and each
 * page's block count), so the ratio only grows while a run is alive — the
 * percentage cannot step backwards because a block finished out of order.
 */
export function layoutTranslatePageProgress(
	items: readonly {
		id: string;
		pageIndex: number;
		status: LayoutTranslateItemStatus;
		progress?: number;
	}[],
	scopeIds: readonly string[] | null,
): LayoutTranslatePageProgress | null {
	const scoped = scopeIds
		? items.filter((item) => scopeIds.includes(item.id))
		: items;
	if (scoped.length === 0) return null;
	const pages = new Map<number, { settled: number; total: number }>();
	for (const item of scoped) {
		const page = pages.get(item.pageIndex) ?? { settled: 0, total: 0 };
		page.settled += settledShare(item);
		page.total += 1;
		pages.set(item.pageIndex, page);
	}
	let ratio = 0;
	let pagesDone = 0;
	for (const page of pages.values()) {
		const pageRatio = page.total > 0 ? page.settled / page.total : 0;
		ratio += pageRatio;
		if (pageRatio >= 1) pagesDone += 1;
	}
	return {
		ratio: ratio / pages.size,
		pagesDone,
		pagesTotal: pages.size,
	};
}

/** Generated pages for the typesetting stage. */
export type LayoutTranslateGeneratedPages = {
	done: number;
	total: number;
};

/**
 * Staged display ratio.
 *
 * Translating owns 0–70%, typesetting 70–100%: the text stage hands over exactly
 * when its last page lands, so the bar joins the two stages without a jump.
 * Both stages advance on fixed denominators, so the value is monotonic.
 */
export function layoutTranslateDisplayRatio(
	text: LayoutTranslatePageProgress | null,
	previewPending: boolean,
	generated: LayoutTranslateGeneratedPages | null,
	cacheOnly = false,
): number | null {
	if (text == null) return null;
	const built =
		generated && generated.total > 0
			? Math.max(0, Math.min(1, generated.done / generated.total))
			: 0;
	// Cache hits have nothing to translate: only page work is left.
	if (cacheOnly) return previewPending ? Math.min(0.99, built) : 1;
	const typeset = previewPending ? Math.min(0.99, built) : 1;
	return Math.min(previewPending ? 0.99 : 1, text.ratio * 0.7 + typeset * 0.3);
}
