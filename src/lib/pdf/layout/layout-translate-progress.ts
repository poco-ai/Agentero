import type {
	LayoutTranslateItem,
	LayoutTranslateItemStatus,
} from "@/lib/pdf/layout/types";

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

/** No page is waiting for its translated page. */
const NO_PAGES: ReadonlySet<number> = new Set();

/**
 * Pages whose text is fully translated while their translated page (the reflow
 * preview) has not been painted yet.
 *
 * `items` must be the session-decorated items: `ReflowPreviewSession.decorate`
 * attaches `reflowPreview` to every block on a page once that page's preview is
 * published. `previewExpected` is the caller's gate — a cancelled run or a
 * failed final build must retract the loading state instead of leaving it up
 * forever.
 */
export function layoutTranslatePagesAwaitingPreview(
	items: readonly LayoutTranslateItem[],
	previewExpected: boolean,
): ReadonlySet<number> {
	if (!previewExpected) return NO_PAGES;
	const pages = new Map<
		number,
		{ translated: boolean; reflow: boolean; preview: boolean }
	>();
	for (const item of items) {
		const page = pages.get(item.pageIndex) ?? {
			translated: false,
			reflow: false,
			preview: false,
		};
		if (item.status === "done" && item.translated?.trim()) {
			page.translated = true;
			if (item.reflow) page.reflow = true;
		}
		if (item.reflowPreview) page.preview = true;
		pages.set(item.pageIndex, page);
	}
	const awaiting = new Set<number>();
	for (const [pageIndex, page] of pages) {
		// One finished paragraph is enough: until the page raster lands every
		// block on that page still shows source text and waits for the same paint.
		if (page.translated && page.reflow && !page.preview)
			awaiting.add(pageIndex);
	}
	return awaiting;
}

/** Visible page status; failed blocks keep a page out of the completed state. */
export type LayoutTranslatePageState = {
	active: boolean;
	running: boolean;
	status: "pending" | "running" | "done" | "error";
	/** Text is translated but this page's translated page has not painted yet. */
	previewPending: boolean;
};

export function layoutTranslatePageStates(
	items: readonly LayoutTranslateItem[],
	hiddenPages: ReadonlySet<number>,
	awaitingPreviewPages: ReadonlySet<number> = NO_PAGES,
): ReadonlyMap<number, LayoutTranslatePageState> {
	const states = new Map<number, LayoutTranslatePageState>();
	for (const item of items) {
		if (hiddenPages.has(item.pageIndex) || item.status === "skipped") continue;
		const status =
			item.status === "done" && !item.translated?.trim()
				? "pending"
				: item.status;
		const state = states.get(item.pageIndex);
		const rank = { done: 0, pending: 1, error: 2, running: 3 };
		states.set(item.pageIndex, {
			active: Boolean(
				state?.active || item.status === "running" || item.translated?.trim(),
			),
			running: Boolean(state?.running || item.status === "running"),
			status:
				state && rank[state.status] > rank[status] ? state.status : status,
			previewPending: false,
		});
	}
	for (const [pageIndex, state] of states) {
		if (!awaitingPreviewPages.has(pageIndex)) continue;
		state.previewPending = true;
		// The source page is still on screen: keep the loading icon instead of
		// reporting a completion the reader cannot see yet.
		if (state.status === "done") {
			state.running = true;
			state.status = "running";
		}
	}
	return states;
}

/**
 * Stage the in-page translate tab reports while a page is still working.
 *
 * `previewPending` means the page's text is translated and its translated page
 * is still being generated (typeset); the tab separates that wait from the
 * translation wait so a reader can tell what the remaining loading ring is for.
 */
export type LayoutTranslatePageStage = "translating" | "typesetting";

export function layoutTranslatePageStage(
	state: Pick<LayoutTranslatePageState, "running" | "previewPending">,
): LayoutTranslatePageStage | null {
	if (!state.running) return null;
	return state.previewPending ? "typesetting" : "translating";
}
