/**
 * Open document tabs + active tab, plus the per-tab PDF annotation slices the
 * annotations panel reads. Backed by a Zustand store so event handlers read the
 * latest snapshot via {@link getTabsState} instead of `tabsRef`/`activeTabIdRef`.
 *
 * Setters mirror the React `useState` contract (value or updater) so existing
 * call sites move over unchanged. Pure tab reducers stay in `@/lib/tabs`.
 */

import type { PdfAskThread } from "@/lib/pdf-ask/types";
import type { PdfHighlight } from "@/lib/pdf-highlight/types";
import type { DocTab } from "@/lib/tabs";
import { createAppStore } from "@/stores/create";

export type TabsState = {
	/** Open documents in the center tab strip (browser-style multi-tab). */
	tabs: DocTab[];
	activeTabId: string | null;
	/** Latest highlights per PDF tab id, for the annotations panel. */
	pdfHighlightsByTab: Record<string, PdfHighlight[]>;
	/** Latest PDF ask threads per tab id (annotations panel conversations). */
	pdfAsksByTab: Record<string, PdfAskThread[]>;
};

export const tabsStore = createAppStore<TabsState>(() => ({
	tabs: [],
	activeTabId: null,
	pdfHighlightsByTab: {},
	pdfAsksByTab: {},
}));

type Updater<T> = T | ((prev: T) => T);

function apply<K extends keyof TabsState>(
	key: K,
	next: Updater<TabsState[K]>,
): void {
	tabsStore.store.setState((s) => {
		const value =
			typeof next === "function"
				? (next as (prev: TabsState[K]) => TabsState[K])(s[key])
				: next;
		return { [key]: value } as Pick<TabsState, K>;
	});
}

export function setTabs(next: Updater<DocTab[]>): void {
	apply("tabs", next);
}

export function setActiveTabId(next: Updater<string | null>): void {
	apply("activeTabId", next);
}

export function setPdfHighlightsByTab(
	next: Updater<Record<string, PdfHighlight[]>>,
): void {
	apply("pdfHighlightsByTab", next);
}

export function setPdfAsksByTab(
	next: Updater<Record<string, PdfAskThread[]>>,
): void {
	apply("pdfAsksByTab", next);
}

/** Read the live snapshot from async callbacks (replaces the old ref shadows). */
export function getTabsState(): TabsState {
	return tabsStore.store.getState();
}

/** Subscribe a component to the whole tabs slice. */
export function useTabsState(): TabsState {
	return tabsStore.use((s) => s);
}
