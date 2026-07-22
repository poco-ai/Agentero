import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DocTab } from "@/lib/tabs";
import {
	getTabsState,
	setActiveTabId,
	setPdfHighlightsByTab,
	setTabs,
	tabsStore,
} from "@/stores/tabs-store";

function reset() {
	tabsStore.store.setState({
		tabs: [],
		activeTabId: null,
		pdfHighlightsByTab: {},
		pdfAsksByTab: {},
	});
}

const tab = (id: string): DocTab =>
	({ id, kind: "file", path: `/vault/${id}.md`, title: id }) as DocTab;

beforeEach(reset);
afterEach(reset);

describe("tabs-store", () => {
	it("sets tabs and active id with plain values", () => {
		setTabs([tab("a"), tab("b")]);
		setActiveTabId("b");
		expect(getTabsState().tabs.map((t) => t.id)).toEqual(["a", "b"]);
		expect(getTabsState().activeTabId).toBe("b");
	});

	it("supports updater functions and isolates slices", () => {
		setTabs([tab("a")]);
		setActiveTabId("a");
		setTabs((prev) => [...prev, tab("b")]);
		setPdfHighlightsByTab((prev) => ({ ...prev, a: [] }));

		const s = getTabsState();
		expect(s.tabs.map((t) => t.id)).toEqual(["a", "b"]);
		expect(s.activeTabId).toBe("a");
		expect(s.pdfHighlightsByTab).toHaveProperty("a");
	});
});
