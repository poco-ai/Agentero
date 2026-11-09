// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectionChatPopover } from "@/components/selection/selection-chat-popover";
import { SelectionSurface } from "@/components/selection/selection-surface";
import {
	closeSelectionSource,
	dismissSelectionChat,
	openSelectionChat,
	selectionChatStore,
} from "@/lib/agent/selection-chat-store";
import { vaultStore } from "@/lib/vault/store";

vi.mock("@/components/selection/selection-actions", () => ({
	SelectionActions: () => null,
}));
vi.mock("@/components/selection/selection-annotation-badges", () => ({
	AnnotationBadges: () => null,
}));
vi.mock("@/lib/core/clipboard", () => ({ copyTextToClipboard: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
	vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
		new DOMRect(100, 200, 80, 20),
	);
	dismissSelectionChat();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(() =>
		root.render(
			createElement(
				Fragment,
				null,
				createElement(SelectionChatPopover),
				createElement(
					SelectionSurface,
					{
						source: {
							sourcePath: "https://example.org/paper",
							sourceUrl: "https://example.org/paper",
							sourceTitle: "Research digest",
							surface: "feed",
							origin: "markdown",
						},
					},
					createElement(
						"p",
						{ id: "evidence" },
						"First sentence. Second sentence.",
					),
					createElement("input", { "aria-label": "filter" }),
				),
				createElement(
					SelectionSurface,
					{ source: { sourcePath: "notes/second.md", origin: "markdown" } },
					createElement("p", { id: "other" }, "Other document."),
				),
			),
		),
	);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	window.getSelection()?.removeAllRanges();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function select(cross = false) {
	const start = container.querySelector("#evidence")?.firstChild;
	const end = cross ? container.querySelector("#other")?.firstChild : start;
	if (!start || !end) throw new Error("Missing test content");
	const range = document.createRange();
	range.setStart(start, 0);
	range.setEnd(end, 14);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
	await act(() =>
		start.parentElement?.dispatchEvent(
			new PointerEvent("pointerup", { bubbles: true, button: 0 }),
		),
	);
}
it("captures one source with quote context and clears its menu on Escape", async () => {
	await select();
	expect(selectionChatStore.getState().draft).toMatchObject({
		stage: "menu",
		selection: {
			text: "First sentence",
			sourceTitle: "Research digest",
			sourceUrl: "https://example.org/paper",
			surface: "feed",
		},
	});
	await act(() =>
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
	);
	expect(selectionChatStore.getState().draft).toBeNull();
});
it("does not capture cross-source selections or form-field drafts", async () => {
	await select(true);
	expect(selectionChatStore.getState().draft).toBeNull();
	container.querySelector("input")?.focus();
	await select();
	expect(selectionChatStore.getState().draft).toBeNull();
});
it("normalizes reader teardown paths to the frozen Vault-relative source", () => {
	const previous = vaultStore.getState().vaultPath;
	vaultStore.setState({ vaultPath: "/vault" });
	openSelectionChat(
		{ text: "quote", sourcePath: "/vault/notes/a.md", origin: "markdown" },
		{ x: 0, y: 0 },
		"menu",
	);
	closeSelectionSource("/vault/notes/a.md");
	expect(selectionChatStore.getState().draft).toBeNull();
	expect(selectionChatStore.getState().closedSource?.path).toBe("notes/a.md");
	vaultStore.setState({ vaultPath: previous });
});
