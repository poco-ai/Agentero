// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	activeId: null as string | null,
	tabs: [] as { id: string; notesPath?: string | null }[],
	visible: [] as string[],
	companion: null as { id: string } | null,
}));

vi.mock("@/lib/workspace/store", () => ({
	getActiveTabId: () => state.activeId,
	getActiveTab: () =>
		state.tabs.find((tab) => tab.id === state.activeId) ?? null,
	getTabs: () => state.tabs,
}));

vi.mock("@/lib/workspace/dock-registry", () => ({
	dockHandle: () => ({ visiblePanelIds: () => state.visible }),
}));

vi.mock("@/lib/workspace/tabs/notes-split", () => ({
	findReadingCompanion: () => state.companion,
}));

import {
	activeMarkdownEditorId,
	toggleActiveMarkdownSource,
} from "@/lib/workspace/markdown-source-toggle";
import { registerMarkdownEditor } from "@/lib/workspace/viewer/markdown-editor-registry";

function register(tabId: string) {
	const toggleSource = vi.fn();
	const unregister = registerMarkdownEditor(tabId, {
		toggleSource,
		hasPendingSource: () => false,
		flushSource: async () => true,
	});
	return { toggleSource, unregister };
}

beforeEach(() => {
	state.activeId = null;
	state.tabs = [];
	state.visible = [];
	state.companion = null;
});

afterEach(() => {
	document.body.replaceChildren();
});

describe("Markdown source shortcut target", () => {
	it("toggles the NOTES editor while focus is in the PDF pane", () => {
		const pdf = document.createElement("div");
		pdf.tabIndex = 0;
		document.body.append(pdf);
		pdf.focus();
		expect(document.activeElement).toBe(pdf);

		const notes = register("notes-tab");
		state.tabs = [
			{ id: "pdf-tab", notesPath: "papers/x/NOTES.md" },
			{ id: "notes-tab", notesPath: "papers/x/NOTES.md" },
		];
		state.activeId = "pdf-tab";
		state.companion = { id: "notes-tab" };
		state.visible = ["pdf-tab", "notes-tab"];

		expect(activeMarkdownEditorId()).toBe("notes-tab");
		expect(toggleActiveMarkdownSource()).toBe(true);
		expect(notes.toggleSource).toHaveBeenCalledOnce();
		notes.unregister();
	});

	it("leaves a hidden NOTES editor alone when another tab fills its column", () => {
		const notes = register("notes-tab");
		state.tabs = [{ id: "pdf-tab", notesPath: "papers/x/NOTES.md" }];
		state.activeId = "pdf-tab";
		state.companion = { id: "notes-tab" };
		state.visible = ["pdf-tab", "other-tab"];

		expect(activeMarkdownEditorId()).toBeNull();
		expect(toggleActiveMarkdownSource()).toBe(false);
		expect(notes.toggleSource).not.toHaveBeenCalled();
		notes.unregister();
	});

	it("keeps the directly active editor working without a visible dock group", () => {
		const notes = register("notes-tab");
		state.tabs = [{ id: "notes-tab" }];
		state.activeId = "notes-tab";

		expect(toggleActiveMarkdownSource()).toBe(true);
		expect(notes.toggleSource).toHaveBeenCalledOnce();
		notes.unregister();
	});

	it("falls back to the only visible Markdown pane", () => {
		const notes = register("solo-tab");
		state.tabs = [{ id: "pdf-tab" }];
		state.activeId = "pdf-tab";
		state.visible = ["pdf-tab", "solo-tab"];

		expect(toggleActiveMarkdownSource()).toBe(true);
		expect(notes.toggleSource).toHaveBeenCalledOnce();
		notes.unregister();
	});
});
