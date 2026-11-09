import { beforeEach, describe, expect, it } from "vitest";
import {
	encodeSelectionToken,
	extractSelectionTokens,
	mergeSelectionDraftInput,
	plainTriggerSuffix,
	updateSelectionToken,
	withoutSelectionTokens,
} from "@/lib/agent/composer-inline-tokens";
import { annotationStore } from "@/lib/agent/selection-annotations";
import {
	confirmSelectionChat,
	dismissSelectionChat,
	openAnnotationEditor,
	openSelectionChat,
	selectionChatStore,
} from "@/lib/agent/selection-chat-store";
import { selectionsPromptBlock } from "@/lib/agent/selection-prompt";
import {
	clearActiveSelection,
	clearSelections,
	consumeSelections,
	currentSelections,
	pinActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import { vaultStore } from "@/lib/vault/store";

const screen = { x: 200, y: 120 };
describe("Add to chat selections", () => {
	beforeEach(() => {
		dismissSelectionChat();
		clearSelections();
	});
	it("pins a PDF snapshot and geometry after the live selection clears", () => {
		const rects = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }];
		publishSelection({
			text: "original quote",
			sourcePath: "papers/a",
			origin: "pdf",
			page: 3,
			rects,
			paperAbsPath: "/vault/papers/a",
		});
		pinActiveSelection();
		rects[0].x = 0.9;
		publishSelection({
			text: "unrelated",
			sourcePath: "notes/b.md",
			origin: "markdown",
		});
		clearActiveSelection();
		expect(consumeSelections()[0]).toMatchObject({
			text: "original quote",
			page: 3,
			rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
			paperAbsPath: "/vault/papers/a",
		});
	});
	it("keeps separate comments and source messages on identical chat quotes through composer tokens", () => {
		for (const [messageId, comment] of [
			["m1", "Explain"],
			["m2", "Disagree"],
		]) {
			publishSelection({
				text: "same text",
				sourcePath: "Chat session-1",
				origin: "chat",
				messageId,
				comment,
			});
			pinActiveSelection();
		}
		const selections = consumeSelections();
		const decoded = extractSelectionTokens(
			selections.map(encodeSelectionToken).join(" "),
		);
		expect(decoded).toHaveLength(2);
		const prompt = selectionsPromptBlock(decoded);
		expect(prompt).toContain(
			"Chat session-1 (message m1):\n> same text\n\nUser comment on this selection:\nExplain",
		);
		expect(prompt).toContain(
			"Chat session-1 (message m2):\n> same text\n\nUser comment on this selection:\nDisagree",
		);
	});
	it("preserves text-editor line provenance and comments in inline tokens", () => {
		publishSelection({
			text: "first\nsecond",
			sourcePath: "notes/a.md",
			origin: "markdown",
			lineFrom: 2,
			lineTo: 3,
			comment: "逐行解释",
		});
		pinActiveSelection();
		const decoded = extractSelectionTokens(
			encodeSelectionToken(consumeSelections()[0]),
		);
		expect(selectionsPromptBlock(decoded)).toContain("notes/a.md (lines 2-3)");
		expect(decoded[0]?.comment).toBe("逐行解释");
	});
	it("discards menu drafts on vault change", () => {
		const previous = vaultStore.getState().vaultPath;
		openSelectionChat(
			{ text: "quote", sourcePath: "a.md", origin: "markdown" },
			screen,
		);
		vaultStore.setState({ vaultPath: "/different-vault" });
		expect(selectionChatStore.getState().draft).toBeNull();
		expect(currentSelections()).toEqual([]);
		vaultStore.setState({ vaultPath: previous });
	});
});

describe("annotation draft editing", () => {
	it("edits/removes exactly the chosen quote and preserves prose and mention tokens", () => {
		const first = {
			id: "first",
			text: "same quote",
			sourcePath: "a.md",
			origin: "markdown" as const,
			pinned: true,
			comment: "old",
		};
		const second = { ...first, id: "second", comment: "keep" };
		const prose = "请解释 {{m:notes%2Fb.md}} @query";
		const original =
			encodeSelectionToken(first) + encodeSelectionToken(second) + prose;
		const updated = updateSelectionToken(original, first.id, "new");
		expect(extractSelectionTokens(updated).map((s) => s.comment)).toEqual([
			"new",
			"keep",
		]);
		expect(withoutSelectionTokens(updated)).toBe(prose);
		expect(
			extractSelectionTokens(updateSelectionToken(updated, first.id, null)),
		).toEqual([second]);
		expect(
			plainTriggerSuffix(mergeSelectionDraftInput(original, prose)),
		).toMatch(/@query$/);
	});
	it("keeps insertion order when adding a new quote through the visible input", () => {
		const first = {
			id: "one",
			text: "first",
			sourcePath: "a.md",
			origin: "markdown" as const,
			pinned: true,
		};
		const second = { ...first, id: "two", text: "second" };
		const result = mergeSelectionDraftInput(
			`${encodeSelectionToken(first)}draft`,
			`draft${encodeSelectionToken(second)}`,
		);
		expect(extractSelectionTokens(result).map((s) => s.id)).toEqual([
			"one",
			"two",
		]);
		expect(withoutSelectionTokens(result)).toBe("draft");
		expect(
			extractSelectionTokens(
				mergeSelectionDraftInput(
					result,
					`typed${encodeSelectionToken(second)}`,
				),
			),
		).toHaveLength(2);
	});
	it("cancel is inert and saving edits the owning composer instead of pinning another quote", () => {
		clearSelections();
		const selection = {
			id: "edit",
			text: "quote",
			sourcePath: "a.md",
			origin: "markdown" as const,
			pinned: true,
			comment: "old",
		};
		let value = encodeSelectionToken(selection);
		annotationStore.setState({
			binding: {
				selections: [selection],
				update: (id, comment) => {
					value = updateSelectionToken(value, id, comment);
				},
			},
		});
		openAnnotationEditor(selection, screen);
		dismissSelectionChat();
		expect(extractSelectionTokens(value)[0].comment).toBe("old");
		openAnnotationEditor(selection, screen);
		expect(confirmSelectionChat("updated")).toBe(true);
		expect(extractSelectionTokens(value)[0].comment).toBe("updated");
		expect(currentSelections()).toEqual([]);
		annotationStore.setState({ binding: null });
	});
});
