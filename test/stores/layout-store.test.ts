import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getLayoutState,
	layoutStore,
	setRightSidebarOpen,
	setRightSidebarTab,
	setShowNotes,
	setSidebarCollapsed,
} from "@/stores/layout-store";

function reset() {
	layoutStore.store.setState({
		sidebarCollapsed: false,
		showNotes: true,
		rightSidebarOpen: false,
		rightSidebarTab: "agent",
		agentZenMode: false,
		pdfZenMode: false,
		agentPanelMounted: false,
	});
}

beforeEach(reset);
afterEach(reset);

describe("layout-store", () => {
	it("toggles chrome flags independently", () => {
		setSidebarCollapsed(true);
		setShowNotes(false);
		setRightSidebarOpen(true);
		setRightSidebarTab("backlinks");

		const s = getLayoutState();
		expect(s.sidebarCollapsed).toBe(true);
		expect(s.showNotes).toBe(false);
		expect(s.rightSidebarOpen).toBe(true);
		expect(s.rightSidebarTab).toBe("backlinks");
		// Untouched flags keep defaults.
		expect(s.agentZenMode).toBe(false);
		expect(s.pdfZenMode).toBe(false);
	});

	it("supports updater form", () => {
		setSidebarCollapsed((prev) => !prev);
		expect(getLayoutState().sidebarCollapsed).toBe(true);
	});
});
