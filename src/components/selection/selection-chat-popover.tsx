import { ArrowUp, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { agentSessionStore } from "@/lib/agent/agent-session-store";
import { presentAgentComposer } from "@/lib/agent/composer-focus";
import {
	annotationRanges,
	editAnnotation,
} from "@/lib/agent/selection-annotations";
import {
	confirmSelectionChat,
	dismissSelectionChat,
	openSelectionChat,
	resumeSelectionChat,
	type SelectionChatDraft,
	selectionChatStore,
	suspendSelectionChat,
	updateSelectionChatComment,
} from "@/lib/agent/selection-chat-store";
import {
	captureQuoteContext,
	normalizeQuoteContext,
} from "@/lib/agent/selection-context";
import {
	selectionFocusRect,
	selectionSideFromSelection,
} from "@/lib/agent/selection-side";
import {
	captureTextAnchor,
	resolveSelectionRange,
} from "@/lib/agent/selection-source";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { resolveMarkdownSelectionLinesForPath } from "@/lib/markdown/markdown-selection-lines-registry";
import { applyMarkdownTextareaShortcut } from "@/lib/markdown/textarea-shortcuts";
import { openRightTab } from "@/lib/shell/ui-window-actions";
import { SelectionActions } from "./selection-actions";
import { AnnotationBadges } from "./selection-annotation-badges";

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
		const capture = (event: Event) => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || !selection.rangeCount) {
				if (event instanceof PointerEvent && event.button === 0) {
					for (const saved of selectionChatStore.getState().suspended) {
						const range = resolveSelectionRange(saved.selection);
						if (
							range &&
							Array.from(range.getClientRects()).some(
								(rect) =>
									event.clientX >= rect.left &&
									event.clientX <= rect.right &&
									event.clientY >= rect.top &&
									event.clientY <= rect.bottom,
							)
						) {
							resumeSelectionChat(saved.selection.id, {
								x: event.clientX,
								y: event.clientY,
							});
							break;
						}
					}
				}
				return;
			}
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
				"menu",
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
			frame = requestAnimationFrame(() => capture(event));
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
			suspendSelectionChat();
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
			if (selectionChatStore.getState().draft?.stage === "menu")
				dismissSelectionChat();
		};
		const onSelectionChange = () => {
			if (
				selectionChatStore.getState().draft?.stage === "menu" &&
				selectionChatStore.getState().draft?.selection.textAnchor &&
				window.getSelection()?.isCollapsed
			)
				dismissSelectionChat();
		};
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing) return;
			if (selectionChatStore.getState().draft?.stage === "menu")
				dismissSelectionChat();
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
			<AnnotationBadges />
			<SelectionActions draft={draft} />
			{draft?.stage === "comment" && (
				<SelectionChatCard key={draft.selection.id} draft={draft} />
			)}
		</div>,
		document.body,
	);
}

function SelectionChatCard({ draft }: { draft: SelectionChatDraft }) {
	const { t } = useTranslation(["viewer", "common"]);
	const comment = draft.comment ?? draft.selection.comment ?? "";
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	const [cardHeight, setCardHeight] = useState(draft.editing ? 120 : 54);
	const priorFocus = useRef(document.activeElement);
	const [viewport, setViewport] = useState({
		width: window.innerWidth,
		height: window.innerHeight,
	});
	useEffect(() => {
		const resize = () =>
			setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	useEffect(() => {
		if (draft.stage === "comment")
			inputRef.current?.focus({ preventScroll: true });
	}, [draft.stage]);
	useEffect(() => {
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			dismissSelectionChat();
			if (
				priorFocus.current instanceof HTMLElement &&
				priorFocus.current.isConnected
			)
				priorFocus.current.focus({ preventScroll: true });
		};
		document.addEventListener("keydown", onEscape, true);
		return () => document.removeEventListener("keydown", onEscape, true);
	}, []);
	useEffect(() => {
		const range = resolveSelectionRange(draft.selection);
		if (
			draft.stage === "comment" &&
			range?.startContainer.isConnected &&
			typeof Highlight !== "undefined"
		)
			CSS.highlights.set("agentero-annotation-selection", new Highlight(range));
		return () => {
			CSS.highlights?.delete("agentero-annotation-selection");
		};
	}, [draft.stage, draft.selection]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Controlled text and viewport width change the textarea DOM scrollHeight.
	useLayoutEffect(() => {
		const input = inputRef.current;
		if (!input || draft.stage !== "comment") return;
		input.style.height = "0px";
		input.style.height = `${Math.min(128, Math.max(32, input.scrollHeight))}px`;
	}, [comment, draft.stage, viewport.width]);
	useLayoutEffect(() => {
		const card = cardRef.current;
		if (!card) return;
		const observer = new ResizeObserver(() =>
			setCardHeight(card.getBoundingClientRect().height),
		);
		observer.observe(card);
		return () => observer.disconnect();
	}, []);
	const width = Math.min(360, viewport.width - 24);
	const height = cardHeight;
	const left = Math.max(
		12,
		Math.min(draft.screen.x - width / 2, viewport.width - width - 12),
	);
	const preferredTop = draft.screen.y - height - 10;
	const top = Math.max(
		12,
		Math.min(
			preferredTop >= 12 ? preferredTop : draft.screen.y + 24,
			viewport.height - height - 12,
		),
	);
	const confirm = () => {
		const editing = Boolean(selectionChatStore.getState().draft?.editing);
		if (!confirmSelectionChat(comment)) return;
		if (editing) {
			openRightTab("agent");
			return;
		}
		presentAgentComposer({ preserveCaret: true });
	};
	return (
		<div
			ref={cardRef}
			role="dialog"
			aria-label={t("selection.addToChat")}
			className={`fixed z-50 border border-border bg-popover text-popover-foreground shadow-overlay ring-1 ring-foreground/10 ${!draft.editing ? "rounded-[1.75rem]" : "rounded-xl"}`}
			style={{ left, top, width }}
		>
			<form
				className={
					draft.editing
						? "flex flex-col gap-2 p-3"
						: "flex items-end gap-2 p-2 pl-4"
				}
				onSubmit={(event) => {
					event.preventDefault();
					confirm();
				}}
			>
				<textarea
					ref={inputRef}
					rows={1}
					aria-label={t("selection.chatCommentPlaceholder")}
					placeholder={t("selection.chatCommentPlaceholder")}
					className="min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-6 outline-none"
					value={comment}
					onChange={(event) => updateSelectionChatComment(event.target.value)}
					onKeyDown={(event) => {
						event.stopPropagation();
						if (
							applyMarkdownTextareaShortcut(event, updateSelectionChatComment)
						)
							return;
						if (
							event.key === "Enter" &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing &&
							event.keyCode !== 229
						) {
							event.preventDefault();
							confirm();
						}
					}}
				/>
				<div className="flex justify-end gap-1">
					{draft.editing && (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="mr-auto"
							aria-label={t("common:remove")}
							onClick={() => {
								editAnnotation(draft.selection.id, null);
								dismissSelectionChat();
							}}
						>
							<Trash2 className="size-4" />
						</Button>
					)}
					{draft.editing && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-label={t("common:cancel")}
							onClick={dismissSelectionChat}
						>
							{t("common:cancel")}
						</Button>
					)}
					<Button
						type="submit"
						className={
							draft.editing ? undefined : "size-9 shrink-0 rounded-full"
						}
						size={draft.editing ? "sm" : "icon-sm"}
						aria-label={
							draft.editing ? t("common:save") : t("selection.addToChat")
						}
					>
						{draft.editing ? t("common:save") : <ArrowUp className="size-4" />}
					</Button>
				</div>
			</form>
		</div>
	);
}
