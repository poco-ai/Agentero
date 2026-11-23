import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => false,
	isMacOS: () => false,
	isMobileApp: () => false,
	getPlatformOS: () => "other",
}));

import {
	clearUiVaultState,
	setAlphaXivOpen,
	setZoteroOpen,
	uiStore,
} from "@/lib/shell/ui-store";

beforeEach(() => {
	uiStore.setState({
		zoteroOpen: false,
		zoteroParentDir: null,
		alphaxivOpen: false,
		alphaxivParentDir: null,
	});
});

it("pins the folder where the library blank menu was opened", () => {
	setAlphaXivOpen(true, " papers/nlp ");
	setZoteroOpen(true, "papers/cv");

	expect(uiStore.getState().alphaxivOpen).toBe(true);
	expect(uiStore.getState().alphaxivParentDir).toBe("papers/nlp");
	expect(uiStore.getState().zoteroOpen).toBe(true);
	expect(uiStore.getState().zoteroParentDir).toBe("papers/cv");
});

it("leaves the knowledge-menu dialogs on their own default folder", () => {
	setAlphaXivOpen(true, "papers/nlp");
	setZoteroOpen(true, "papers/cv");
	setAlphaXivOpen(true);
	setZoteroOpen(true, "   ");

	expect(uiStore.getState().alphaxivOpen).toBe(true);
	expect(uiStore.getState().alphaxivParentDir).toBeNull();
	expect(uiStore.getState().zoteroOpen).toBe(true);
	expect(uiStore.getState().zoteroParentDir).toBeNull();
});

it("drops the captured folder when the dialog closes or the vault changes", () => {
	setAlphaXivOpen(true, "papers/nlp");
	setZoteroOpen(true, "papers/cv");
	setAlphaXivOpen(false);
	setZoteroOpen(false);

	expect(uiStore.getState().alphaxivParentDir).toBeNull();
	expect(uiStore.getState().zoteroParentDir).toBeNull();

	setAlphaXivOpen(true, "papers/nlp");
	setZoteroOpen(true, "papers/cv");
	clearUiVaultState();

	const state = uiStore.getState();
	expect(state.alphaxivOpen).toBe(false);
	expect(state.zoteroOpen).toBe(false);
	expect(state.alphaxivParentDir).toBeNull();
	expect(state.zoteroParentDir).toBeNull();
});
