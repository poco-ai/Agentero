import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionStore } from "@/lib/agent/agent-session-store";
import {
	annotationStore,
	releaseAnnotationAnchor,
} from "@/lib/agent/selection-annotations";
import {
	confirmSelectionChat,
	dismissSelectionChat,
	openAnnotationEditor,
	selectionChatStore,
	suspendSelectionChat,
	updateSelectionChatComment,
} from "@/lib/agent/selection-chat-store";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { clearSelections } from "@/lib/agent/selection-store";

const selection: SelectionContext = {
	id: "existing",
	text: "a quote",
	sourcePath: "notes/test.md",
	origin: "markdown",
	pinned: true,
	comment: "old",
};
const screen = { x: 100, y: 100 };
const bindAnnotation = (selections: SelectionContext[] = [selection]) => {
	const update = vi.fn();
	annotationStore.setState({ binding: { selections, update } });
	return update;
};
beforeEach(() => {
	selectionChatStore.setState({ draft: null, suspended: [] });
	agentSessionStore.setState({ activeTabId: "draft" });
	annotationStore.setState({ binding: null, releasedId: null });
	clearSelections();
});
describe("recoverable annotation drafts", () => {
	it("outside dismissal saves text; reopening recovers it, confirmation updates the composer token", () => {
		const update = bindAnnotation();
		openAnnotationEditor(selection, screen);
		updateSelectionChatComment("unfinished");
		suspendSelectionChat();
		expect(selectionChatStore.getState().draft).toBeNull();
		openAnnotationEditor(selection, { x: 200, y: 200 });
		expect(selectionChatStore.getState().draft).toMatchObject({
			comment: "unfinished",
			stage: "comment",
			editing: true,
			screen: { x: 200, y: 200 },
		});
		expect(confirmSelectionChat("finished")).toBe(true);
		expect(update).toHaveBeenCalledWith("existing", "finished");
		expect(selectionChatStore.getState().suspended).toEqual([]);
	});
	it("explicit cancel discards only this quote's draft", () => {
		bindAnnotation([selection, { ...selection, id: "other" }]);
		openAnnotationEditor(selection, screen);
		updateSelectionChatComment("keep");
		suspendSelectionChat();
		openAnnotationEditor({ ...selection, id: "other" }, screen);
		updateSelectionChatComment("discard");
		dismissSelectionChat();
		expect(selectionChatStore.getState().suspended).toHaveLength(1);
		openAnnotationEditor(selection, screen);
		expect(selectionChatStore.getState().draft?.comment).toBe("keep");
		dismissSelectionChat();
		openAnnotationEditor(selection, screen);
		expect(selectionChatStore.getState().draft?.comment).toBe("old");
	});
	it("isolates scratch text by conversation and preserves an intentional empty edit", () => {
		bindAnnotation();
		openAnnotationEditor(selection, screen);
		updateSelectionChatComment("session A");
		agentSessionStore.setState({ activeTabId: "other" });
		expect(selectionChatStore.getState().draft).toBeNull();
		agentSessionStore.setState({ activeTabId: "draft" });
		openAnnotationEditor(selection, screen);
		expect(selectionChatStore.getState().draft?.comment).toBe("session A");
		dismissSelectionChat();
		openAnnotationEditor(selection, screen);
		updateSelectionChatComment("");
		suspendSelectionChat();
		openAnnotationEditor(selection, screen);
		expect(selectionChatStore.getState().draft?.comment).toBe("");
		suspendSelectionChat();
		releaseAnnotationAnchor("existing");
		expect(selectionChatStore.getState().suspended).toEqual([]);
	});
});
