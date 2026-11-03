// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommentCardsLayer } from "@/components/viewer/pdf/layers/comment-cards-layer";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/agent/message", () => ({
	MessageResponse: () => null,
}));

let root: Root;
let container: HTMLDivElement;
const onCommit = vi.fn();
const onDismiss = vi.fn();
const noop = () => {};
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
	vi.stubGlobal("cancelAnimationFrame", noop);
	onCommit.mockClear();
	onDismiss.mockClear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(() =>
		root.render(
			createElement(
				StrictMode,
				null,
				createElement(CommentCardsLayer, {
					items: [],
					pageWidthPx: 600,
					pageHeightPx: 800,
					editingId: null,
					wikiTarget: null,
					hoveredId: null,
					selectionDraft: {
						page: 1,
						anchorY: 0.2,
						quote: "selected",
						pages: [],
					},
					onCommitSelectionComment: onCommit,
					onDismissSelectionComment: onDismiss,
					onOpen: noop,
					onSave: noop,
					onCancel: noop,
					onDelete: noop,
					onCopyLink: noop,
					onCopyEmbed: noop,
					onAddToChat: noop,
					onHover: noop,
					onLeave: noop,
				}),
			),
		),
	);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});
function editor(): HTMLTextAreaElement {
	const element = container.querySelector("textarea");
	if (!element) throw new Error("Note editor missing");
	return element;
}
async function type(text: string) {
	const field = editor();
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	setter?.call(field, text);
	await act(() => field.dispatchEvent(new Event("input", { bubbles: true })));
}
it("focuses immediately and stays open when the pointer leaves an empty note", async () => {
	expect(document.activeElement).toBe(editor());
	await act(() =>
		container
			.querySelector("[data-selection-comment]")
			?.dispatchEvent(new PointerEvent("pointerout", { bubbles: true })),
	);
	expect(document.activeElement).toBe(editor());
	expect(onDismiss).not.toHaveBeenCalled();
});

it("keeps an embedded note editor inside the page and saves through the same callback", async () => {
	await act(() =>
		root.render(
			createElement(CommentCardsLayer, {
				inset: true,
				items: [],
				pageWidthPx: 600,
				pageHeightPx: 800,
				editingId: null,
				hoveredId: null,
				wikiTarget: null,
				selectionDraft: { page: 1, anchorY: 0.2, quote: "selected", pages: [] },
				onCommitSelectionComment: onCommit,
				onDismissSelectionComment: onDismiss,
				onOpen: noop,
				onSave: noop,
				onCancel: noop,
				onDelete: noop,
				onCopyLink: noop,
				onCopyEmbed: noop,
				onAddToChat: noop,
				onHover: noop,
				onLeave: noop,
			}),
		),
	);
	const card = container.querySelector<HTMLElement>("[data-selection-comment]");
	expect(card?.style.right).toBe("8px");
	expect(card?.style.left).toBe("");
	await type("embedded note");
	await act(() =>
		editor().dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				key: "Enter",
				metaKey: true,
			}),
		),
	);
	expect(onCommit).toHaveBeenCalledExactlyOnceWith("embedded note");
});
it("commits typed text once on the save shortcut, including a later blur", async () => {
	await type("a note");
	await act(() =>
		editor().dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				key: "Enter",
				metaKey: true,
			}),
		),
	);
	await act(() => editor().blur());
	expect(onCommit).toHaveBeenCalledExactlyOnceWith("a note");
});
it("dismisses an empty note on blur", async () => {
	await act(() => editor().blur());
	expect(onDismiss).toHaveBeenCalledOnce();
	expect(onCommit).not.toHaveBeenCalled();
});
it("cancels through Escape without committing on the resulting blur", async () => {
	await type("unfinished");
	await act(() =>
		editor().dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
		),
	);
	expect(onDismiss).toHaveBeenCalledOnce();
	expect(onCommit).not.toHaveBeenCalled();
});
it("saves typed text on outside click", async () => {
	await type("outside save");
	await act(() =>
		document.body.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true }),
		),
	);
	expect(onCommit).toHaveBeenCalledExactlyOnceWith("outside save");
});
