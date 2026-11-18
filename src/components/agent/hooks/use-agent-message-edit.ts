/**
 * Inline edit-and-resend of a sent user message (only when not running),
 * including the IME guard, editor autofocus, and the tab-switch reset of
 * edit state + ↑/↓ prompt-history browse.
 */
import { type RefObject, useEffect, useRef, useState } from "react";
import type { AgentPanelRefs } from "@/components/agent/hooks/use-agent-panel-context";
import type { SendOptions } from "@/components/agent/hooks/use-agent-send";
import { useImeGuard } from "@/hooks/use-ime-guard";
import type { ChatLine } from "@/lib/agent/chat-state";
import {
	extractVisualIds,
	retainTranscriptChips,
} from "@/lib/agent/composer-inline-tokens";

export type UseAgentMessageEditOptions = {
	refs: Pick<
		AgentPanelRefs,
		| "activeTabRef"
		| "promptHistoryAppliedRef"
		| "promptHistoryDraftRef"
		| "promptHistoryIndexRef"
		| "submittingRef"
		| "switchingRef"
	>;
	activeTabId: string;
	activeTabIsRunning: boolean;
	lines: ChatLine[];
	send: (text: string, options?: SendOptions) => Promise<boolean>;
};

export type AgentMessageEdit = {
	editingLineId: string | null;
	editingText: string;
	setEditingText: (text: string) => void;
	editTextareaRef: RefObject<HTMLTextAreaElement | null>;
	editCompositionProps: ReturnType<typeof useImeGuard>["compositionProps"];
	isEditBlockedByIme: ReturnType<typeof useImeGuard>["isBlockedByIme"];
	startEditingMessage: (lineId: string, text: string) => void;
	cancelEditingMessage: () => void;
	resendEditedMessage: (lineId: string) => Promise<void>;
};

export function useAgentMessageEdit({
	refs: {
		activeTabRef,
		promptHistoryAppliedRef,
		promptHistoryDraftRef,
		promptHistoryIndexRef,
		submittingRef,
		switchingRef,
	},
	activeTabId,
	activeTabIsRunning,
	lines,
	send,
}: UseAgentMessageEditOptions): AgentMessageEdit {
	const [editingLineId, setEditingLineId] = useState<string | null>(null);
	const [editingText, setEditingText] = useState("");
	const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const {
		isBlockedByIme: isEditBlockedByIme,
		compositionProps: editCompositionProps,
	} = useImeGuard();

	useEffect(() => {
		activeTabRef.current = activeTabId;
		// Leaving a conversation (tab switch, history open, new chat, vault
		// change) cancels any in-progress message edit so a stale editor never
		// reopens under a different line that reused the same id.
		setEditingLineId(null);
		setEditingText("");
		promptHistoryIndexRef.current = null;
		promptHistoryDraftRef.current = "";
		promptHistoryAppliedRef.current = null;
	}, [
		activeTabId,
		activeTabRef,
		promptHistoryAppliedRef,
		promptHistoryDraftRef,
		promptHistoryIndexRef,
	]);

	// Focus the inline editor (and place the caret at the end) when it opens.
	useEffect(() => {
		if (!editingLineId) return;
		const el = editTextareaRef.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, [editingLineId]);

	const startEditingMessage = (lineId: string, text: string) => {
		if (activeTabIsRunning || submittingRef.current || switchingRef.current)
			return;
		setEditingLineId(lineId);
		setEditingText(text);
	};

	const cancelEditingMessage = () => {
		setEditingLineId(null);
		setEditingText("");
	};

	// Resend an edited user message: drop everything from that message onward
	// (the stale answer / partial run) and start a fresh turn with the new text.
	// Preserve original visual crops / image attachments from that user line.
	const resendEditedMessage = async (lineId: string) => {
		const text = editingText.trim();
		if (
			!text ||
			activeTabIsRunning ||
			switchingRef.current ||
			submittingRef.current
		)
			return;
		const index = lines.findIndex(
			(line) => line.id === lineId && line.kind === "user",
		);
		if (index < 0) return;
		const original = lines[index];
		const baseLines = lines.slice(0, index);
		const resendImages =
			original?.kind === "user" && original.images?.length
				? original.images
				: undefined;
		// Preserve inline visual references and send each crop once. Older messages
		// without reference positions retain their plain image attachment path.
		const visualIds = new Set(
			extractVisualIds(
				original?.kind === "user" ? (original.markup ?? "") : "",
			),
		);
		const visualDrafts =
			original?.kind === "user"
				? (original.visualAnnotations ?? [])
						.filter((visual) => visualIds.has(visual.id))
						.map((visual) => ({
							...visual,
							paperPath: visual.paperPath ?? "",
							rects: [],
						}))
				: [];
		const visualAsImages =
			original?.kind === "user"
				? (original.visualAnnotations ?? [])
						.filter((item) => !visualIds.has(item.id))
						.map((item) => item.image)
				: [];
		const mergedImages = [
			...(resendImages ?? []),
			...visualAsImages.filter((img) => img.data.trim().length > 0),
		];
		setEditingLineId(null);
		setEditingText("");
		const payload =
			original?.kind === "user"
				? retainTranscriptChips(text, original.markup)
				: text;
		await send(payload, {
			baseLines,
			visualDrafts,
			selections: original?.kind === "user" ? (original.selections ?? []) : [],
			...(mergedImages.length ? { images: mergedImages } : {}),
		});
	};

	return {
		editingLineId,
		editingText,
		setEditingText,
		editTextareaRef,
		editCompositionProps,
		isEditBlockedByIme,
		startEditingMessage,
		cancelEditingMessage,
		resendEditedMessage,
	};
}
