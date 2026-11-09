/** Ephemeral Add to chat draft, independent of the surface's live selection. */

import { createStore } from "zustand/vanilla";
import {
	createSelectionContext,
	pinSelection,
	type SelectionContext,
	type SelectionInput,
} from "@/lib/agent/selection-store";
import { toVaultRelative } from "@/lib/core/path";
import { vaultStore } from "@/lib/vault/store";
import { agentSessionStore } from "./agent-session-store";
import {
	annotationPdfAnchors,
	annotationRanges,
	annotationStore,
	editAnnotation,
	releaseAnnotationAnchor,
} from "./selection-annotations";

/** Viewport anchor plus the box cards must not cover. */
export type SelectionDraftScreen = {
	x: number;
	y: number;
	selectionBounds?: {
		left: number;
		top: number;
		right: number;
		bottom: number;
	};
};

export type SelectionChatDraft = {
	selection: SelectionContext;
	screen: SelectionDraftScreen;
	stage: "menu" | "comment";
	editing?: boolean;
	comment?: string;
	ownerId?: string;
};
export const selectionChatStore = createStore<{
	draft: SelectionChatDraft | null;
	suspended: SelectionChatDraft[];
	closedSource: { path: string } | null;
}>(() => ({ draft: null, suspended: [], closedSource: null }));

/** Invalidate transient actions when a mounted reader navigates or closes. */
export function closeSelectionSource(path: string): void {
	path = toVaultRelative(vaultStore.getState().vaultPath, path);
	const current = selectionChatStore.getState().draft;
	if (current?.stage === "menu" && current.selection.sourcePath === path)
		dismissSelectionChat();
	selectionChatStore.setState({ closedSource: { path } });
}

export function openSelectionChat(
	input: SelectionInput,
	screen: SelectionChatDraft["screen"],
	stage: SelectionChatDraft["stage"] = "comment",
): void {
	const selection = createSelectionContext(input);
	if (!selection) return;
	suspendSelectionChat();
	const ownerId = draftOwner();
	const saved = selectionChatStore
		.getState()
		.suspended.find(
			(item) =>
				item.ownerId === ownerId &&
				!item.editing &&
				sameQuote(item.selection, selection),
		);
	selectionChatStore.setState({
		draft: saved
			? { ...saved, screen: { ...screen }, stage: "comment" }
			: { selection, screen: { ...screen }, stage, ownerId },
	});
}
export function openAnnotationEditor(
	selection: SelectionContext,
	screen: SelectionChatDraft["screen"],
): void {
	suspendSelectionChat();
	const ownerId = draftOwner();
	const saved = selectionChatStore
		.getState()
		.suspended.find(
			(item) =>
				item.ownerId === ownerId &&
				item.editing &&
				item.selection.id === selection.id,
		);
	selectionChatStore.setState({
		draft: {
			selection,
			screen,
			stage: "comment",
			editing: true,
			ownerId,
			comment: saved?.comment ?? selection.comment ?? "",
		},
	});
}
export function dismissSelectionChat(): void {
	const id = selectionChatStore.getState().draft?.selection.id;
	selectionChatStore.setState((state) => ({
		draft: null,
		suspended: state.suspended.filter((item) => item.selection.id !== id),
	}));
}
export function beginSelectionComment(): void {
	const { draft } = selectionChatStore.getState();
	if (draft)
		selectionChatStore.setState({ draft: { ...draft, stage: "comment" } });
}
export function confirmSelectionChat(comment: string): boolean {
	const { draft } = selectionChatStore.getState();
	if (!draft) return false;
	if (draft.editing && !editAnnotation(draft.selection.id, comment.trim())) {
		dismissSelectionChat();
		return false;
	}
	if (!draft.editing)
		pinSelection({ ...draft.selection, comment: comment.trim() || undefined });
	dismissSelectionChat();
	return true;
}
annotationStore.subscribe((state, previous) => {
	if (!state.releasedId || state.releasedId === previous.releasedId) return;
	const id = state.releasedId;
	selectionChatStore.setState((current) => ({
		suspended: current.suspended.filter((item) => item.selection.id !== id),
		draft: current.draft?.selection.id === id ? null : current.draft,
	}));
});
// Quotes must never cross vault boundaries.
vaultStore.subscribe((state, previous) => {
	if (state.vaultPath !== previous.vaultPath) {
		dismissSelectionChat();
		selectionChatStore.setState({ suspended: [] });
		annotationStore.setState({ binding: null });
		annotationRanges.clear();
		annotationPdfAnchors.clear();
	}
});

function sameQuote(a: SelectionContext, b: SelectionContext): boolean {
	return (
		a.origin === b.origin &&
		a.sourcePath === b.sourcePath &&
		a.text === b.text &&
		a.messageId === b.messageId &&
		a.page === b.page &&
		a.lineFrom === b.lineFrom &&
		JSON.stringify(a.rects) === JSON.stringify(b.rects) &&
		JSON.stringify(a.textAnchor) === JSON.stringify(b.textAnchor)
	);
}
export function updateSelectionChatComment(comment: string): void {
	const draft = selectionChatStore.getState().draft;
	if (draft) selectionChatStore.setState({ draft: { ...draft, comment } });
}
export function suspendSelectionChat(): void {
	const draft = selectionChatStore.getState().draft;
	if (!draft) return;
	const changed =
		draft.stage === "comment" &&
		(draft.editing
			? (draft.comment ?? draft.selection.comment ?? "") !==
				(draft.selection.comment ?? "")
			: Boolean(draft.comment?.trim()));
	selectionChatStore.setState((state) => ({
		draft: null,
		suspended: [
			...state.suspended.filter(
				(item) => item.selection.id !== draft.selection.id,
			),
			...(changed ? [draft] : []),
		],
	}));
	// An abandoned empty comment owns no annotation or recoverable draft.
	if (!changed && !draft.editing && draft.stage === "comment")
		releaseAnnotationAnchor(draft.selection.id);
}
export function resumeSelectionChat(
	id: string,
	screen: SelectionChatDraft["screen"],
): void {
	const saved = selectionChatStore
		.getState()
		.suspended.find(
			(item) => item.selection.id === id && item.ownerId === draftOwner(),
		);
	if (!saved) return;
	suspendSelectionChat();
	selectionChatStore.setState({
		draft: { ...saved, screen, stage: "comment" },
	});
}

function draftOwner(state = agentSessionStore.getState()): string {
	return (
		state.sessions.find((session) => session.id === state.activeTabId)
			?.providerSessionId || state.activeTabId
	);
}
agentSessionStore.subscribe((state, previous) => {
	const nextOwner = draftOwner(state);
	const previousOwner = draftOwner(previous);
	if (nextOwner === previousOwner) return;
	const currentLines =
		state.sessions.find((session) => session.id === state.activeTabId)?.lines ??
		[];
	const continuingDraft =
		previous.activeTabId === "draft" &&
		previous.draftLines.some((line) =>
			currentLines.some((current) => current.id === line.id),
		);
	if (state.activeTabId === previous.activeTabId || continuingDraft) {
		selectionChatStore.setState((current) => ({
			draft:
				current.draft?.ownerId === previousOwner
					? { ...current.draft, ownerId: nextOwner }
					: current.draft,
			suspended: current.suspended.map((item) =>
				item.ownerId === previousOwner ? { ...item, ownerId: nextOwner } : item,
			),
		}));
	} else suspendSelectionChat();
});
