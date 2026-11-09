// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import { SelectionActions } from "@/components/selection/selection-actions";
import {
	dismissSelectionChat,
	openSelectionChat,
	selectionChatStore,
} from "@/lib/agent/selection-chat-store";
import { SELECTION_DISMISS_EVENT } from "@/lib/agent/selection-dismiss";

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/pdf/translate/run-selection", () => ({
	runSelectionTranslate: vi.fn(),
}));
vi.mock("@/lib/pdf/ask/run-turn", () => ({
	resolveAskAgent: vi.fn(),
	runAskTurn: vi.fn(),
	resendBaseMessages: vi.fn(),
}));
vi.mock("@/lib/core/clipboard", () => ({ copyTextToClipboard: vi.fn() }));

function Host() {
	const draft = useStore(selectionChatStore, (state) => state.draft);
	return createElement(SelectionActions, { draft });
}

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	dismissSelectionChat();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(() => root.render(createElement(Host)));
	await act(() =>
		openSelectionChat(
			{
				text: "quoted text",
				sourcePath: "https://example.org/a",
				origin: "markdown",
			},
			{ x: 100, y: 200 },
		),
	);
});

afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	dismissSelectionChat();
	vi.unstubAllGlobals();
});

it("closes the selection UI when an embedded frame relays Escape", async () => {
	expect(selectionChatStore.getState().draft).not.toBeNull();
	await act(() =>
		window.dispatchEvent(new CustomEvent(SELECTION_DISMISS_EVENT)),
	);
	expect(selectionChatStore.getState().draft).toBeNull();
});
