import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { agentSessionStore } from "@/lib/agent/agent-session-store";
import { annotationRanges } from "@/lib/agent/selection-annotations";
import {
	dismissSelectionChat,
	openSelectionChat,
	selectionChatStore,
} from "@/lib/agent/selection-chat-store";
import {
	captureQuoteContext,
	normalizeQuoteContext,
} from "@/lib/agent/selection-context";
import {
	selectionFocusRect,
	selectionSideFromSelection,
} from "@/lib/agent/selection-side";
import { captureTextAnchor } from "@/lib/agent/selection-source";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { resolveMarkdownSelectionLinesForPath } from "@/lib/markdown/markdown-selection-lines-registry";
import { SelectionActions } from "./selection-actions";

const SURFACE = "[data-selection-chat-source]";

function surfaceOf(node: Node | null): HTMLElement | null {
	const element = node instanceof Element ? node : node?.parentElement;
	return element?.closest<HTMLElement>(SURFACE) ?? null;
}

/** One host per window: survives PDF selection teardown and portalled editors. */
export function SelectionChatPopover() {
	const draft = useStore(selectionChatStore, (state) => state.draft);
	const popoverRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let frame = 0;
		const capture = () => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || !selection.rangeCount) return;
			const source = surfaceOf(selection.anchorNode);
			if (!source || source !== surfaceOf(selection.focusNode)) return;
			// Source editors may contain nested form controls; never quote their drafts.
			if (document.activeElement?.matches("input, textarea")) return;
			const origin = source.dataset.selectionChatOrigin;
			if (origin !== "markdown" && origin !== "chat") return;
			const range = selection.getRangeAt(0);
			const rect = range.getBoundingClientRect();
			if (!rect.width && !rect.height) return;
			const context = captureQuoteContext(source, range);
			if (origin === "chat") {
				const state = agentSessionStore.getState();
				const lines =
					state.sessions.find(
						(session) =>
							`Chat ${session.id}` === source.dataset.selectionChatSource,
					)?.lines ??
					(source.dataset.selectionChatSource === "Chat draft"
						? state.draftLines
						: []);
				const index = lines.findIndex(
					(line) => line.id === source.dataset.selectionChatMessage,
				);
				const question = lines
					.slice(0, Math.max(0, index))
					.reverse()
					.find((line) => line.kind === "user");
				if (lines[index]?.kind !== "user" && question?.kind === "user")
					context.question = question.text;
			}
			const sourcePath = source.dataset.selectionChatSource ?? "";
			const markdownLines =
				origin === "markdown"
					? resolveMarkdownSelectionLinesForPath(sourcePath)
					: null;
			openSelectionChat(
				{
					text: selection.toString(),
					sourcePath,
					sourceTitle: source.dataset.selectionChatTitle,
					sourceUrl: source.dataset.selectionChatUrl,
					surface: source.dataset
						.selectionChatSurface as SelectionContext["surface"],
					origin,
					messageId: source.dataset.selectionChatMessage,
					chatSessionId:
						origin === "chat"
							? (agentSessionStore
									.getState()
									.sessions.find(
										(session) =>
											`Chat ${session.id}` ===
											source.dataset.selectionChatSource,
									)?.providerSessionId ??
								source.dataset.selectionChatSource?.slice(5))
							: undefined,
					context: normalizeQuoteContext(context),
					textAnchor: captureTextAnchor(source, range),
					...(markdownLines != null
						? {
								lineFrom: markdownLines.lineFrom,
								lineTo: markdownLines.lineTo,
							}
						: {}),
				},
				{
					x: rect.left + rect.width / 2,
					y: rect.top,
					side: selectionSideFromSelection(selection),
					cursorX: selectionFocusRect(selection)?.left,
					// Keep result cards outside the highlighted lines.
					selectionBounds: {
						left: rect.left,
						top: rect.top,
						right: rect.right,
						bottom: rect.bottom,
					},
				},
			);
			const draft = selectionChatStore.getState().draft;
			if (source.dataset.selectionAutoCopy === "true")
				void copyTextToClipboard(selection.toString());
			if (draft) {
				annotationRanges.set(draft.selection.id, range.cloneRange());
				if (annotationRanges.size > 256) {
					const oldest = annotationRanges.keys().next().value;
					if (oldest) annotationRanges.delete(oldest);
				}
			}
		};
		const scheduleCapture = (event: Event) => {
			if (event instanceof PointerEvent && event.button !== 0) return;
			if (
				event.target instanceof Node &&
				(popoverRef.current?.contains(event.target) ||
					(event.target instanceof Element &&
						event.target.closest(
							"[data-annotation-ui], [data-selection-ui], [data-pdf-chrome]",
						)))
			)
				return;
			if (
				event instanceof KeyboardEvent &&
				(event.isComposing ||
					!(
						event.key === "Shift" ||
						event.key.startsWith("Arrow") ||
						((event.metaKey || event.ctrlKey) && event.code === "KeyA")
					))
			)
				return;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(capture);
		};
		const onDown = (event: PointerEvent) => {
			if (
				event.target instanceof Node &&
				(popoverRef.current?.contains(event.target) ||
					(event.target instanceof Element &&
						event.target.closest(
							"[data-annotation-ui], [data-selection-ui], [data-pdf-chrome]",
						)))
			)
				return;
			dismissSelectionChat();
		};
		const onScroll = (event: Event) => {
			if (
				event.target instanceof Node &&
				(popoverRef.current?.contains(event.target) ||
					(event.target instanceof Element &&
						event.target.closest(
							"[data-annotation-ui], [data-selection-ui], [data-pdf-chrome]",
						)))
			)
				return;
			if (selectionChatStore.getState().draft) dismissSelectionChat();
		};
		const onSelectionChange = () => {
			if (
				selectionChatStore.getState().draft?.selection.textAnchor &&
				window.getSelection()?.isCollapsed
			)
				dismissSelectionChat();
		};
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing) return;
			if (selectionChatStore.getState().draft) dismissSelectionChat();
		};
		document.addEventListener("pointerdown", onDown, true);
		document.addEventListener("pointerup", scheduleCapture);
		document.addEventListener("keyup", scheduleCapture);
		// Capture: editors can consume Escape before it bubbles, but they must not
		// leave the app-owned toolbar stranded.
		document.addEventListener("keydown", onEscape, true);
		document.addEventListener("selectionchange", onSelectionChange);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("pointerdown", onDown, true);
			document.removeEventListener("pointerup", scheduleCapture);
			document.removeEventListener("keyup", scheduleCapture);
			document.removeEventListener("keydown", onEscape, true);
			document.removeEventListener("selectionchange", onSelectionChange);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, []);

	return createPortal(
		<div ref={popoverRef}>
			<SelectionActions draft={draft} />
		</div>,
		document.body,
	);
}
