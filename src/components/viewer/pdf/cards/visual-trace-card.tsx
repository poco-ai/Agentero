import {
	ArrowUpIcon,
	ExternalLink,
	MessageSquarePlus,
	MessagesSquare,
	NotebookPen,
	SquareIcon,
	Trash2Icon,
	X,
} from "lucide-react";
import {
	type KeyboardEvent,
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	Message,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { useAgentSessionStore } from "@/lib/agent/agent-session-store";
import { agentTextFromParts, type ChatLine } from "@/lib/agent/chat-state";
import { stripPromptEnvelopeForDisplay } from "@/lib/agent/prompt-display";
import { cn } from "@/lib/core/utils";
import { traceMessages } from "@/lib/pdf/agent-trace/schema";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace/types";

/** Note mode matches text AnnotationEditor footprint. */
const NOTE_SIZE = { width: 240, height: 200 } as const;
/** Compact pin-hover chat size (before pointer enters the card). */
const CHAT_COMPACT = { width: 280, height: 260 } as const;
/** Expanded interactive chat size (pointer on the card). */
const CHAT_EXPANDED = { width: 360, height: 440 } as const;

type CardMode = "note" | "chat";

type VisualTraceCardProps = {
	trace: PdfVisualSessionTrace;
	screen: ScreenPoint;
	preferRight?: boolean;
	error?: string | null;
	/**
	 * Start expanded chat (e.g. just created via Agent). Pin hover stays
	 * compact until the pointer enters the card.
	 */
	initialExpanded?: boolean;
	/** Force initial mode; default: note when no agent thread, else chat. */
	initialMode?: CardMode;
	onOpenSession: () => void;
	/** Add this mark’s crop to the Agent sidebar composer. */
	onAddToChat: () => void;
	/** Persist an edited note (note mode Save). */
	onSaveComment: (comment: string) => void;
	onSend: (question: string) => void;
	onDelete: () => void;
	onHide: () => void;
	onStop?: () => void;
	onPointerEnter?: () => void;
	onPointerLeave?: () => void;
};

/** True when the mark has (or had) an Agent thread worth showing as chat. */
function hasAgentConversation(trace: PdfVisualSessionTrace): boolean {
	const agent = trace.agent;
	if (!agent) return false;
	if (agent.agentId === "pending" || agent.runtimeSessionId === "pending") {
		// Provisional pin created for an in-flight first turn.
		return true;
	}
	return true;
}

/**
 * Lightweight local-state input — intentionally NOT PromptInput.
 * memo + local text state: parent stream/list updates must not remount this.
 */
const VisualTraceFooter = memo(function VisualTraceFooter({
	streaming,
	placeholder,
	sendLabel,
	stopLabel,
	onSend,
	onHide,
	onStop,
	onFocusInput,
}: {
	streaming: boolean;
	placeholder: string;
	sendLabel: string;
	stopLabel: string;
	onSend: (question: string) => void;
	onHide: () => void;
	onStop?: () => void;
	onFocusInput: () => void;
}) {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const { isBlockedByIme, compositionProps } = useImeGuard();

	const submit = useCallback(() => {
		const el = textareaRef.current;
		const q = (el?.value ?? "").trim();
		if (streaming || !q) return;
		onFocusInput();
		onSend(q);
		if (el) el.value = "";
	}, [streaming, onFocusInput, onSend]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			onHide();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !isBlockedByIme(e)) {
			e.preventDefault();
			submit();
		}
	};

	return (
		<div className="flex w-full items-center gap-1 rounded-full border border-border/80 bg-background px-1.5 py-0.5">
			<textarea
				ref={textareaRef}
				defaultValue=""
				placeholder={placeholder}
				disabled={streaming}
				rows={1}
				className="min-h-8 max-h-8 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
				onFocus={onFocusInput}
				onKeyDown={onKeyDown}
				{...compositionProps}
			/>
			{streaming ? (
				<Button
					type="button"
					size="icon-xs"
					variant="secondary"
					className="shrink-0 rounded-full"
					aria-label={stopLabel}
					onClick={() => onStop?.()}
				>
					<SquareIcon className="size-3.5" />
				</Button>
			) : (
				<Button
					type="button"
					size="icon-xs"
					className="shrink-0 rounded-full"
					aria-label={sendLabel}
					disabled={streaming}
					onClick={submit}
				>
					<ArrowUpIcon className="size-3.5" />
				</Button>
			)}
		</div>
	);
});

type ModalTraceMessage = {
	id: string;
	role: "user" | "assistant";
	content: string;
};

function chatLinesToTraceMessages(lines: ChatLine[]): ModalTraceMessage[] {
	const out: ModalTraceMessage[] = [];
	for (const line of lines) {
		if (line.kind === "user") {
			const content = stripPromptEnvelopeForDisplay(line.text);
			if (!content) continue;
			out.push({
				id: line.id,
				role: "user",
				content,
			});
			continue;
		}
		if (line.kind === "agent") {
			const content = agentTextFromParts(line.parts);
			out.push({
				id: line.id,
				role: "assistant",
				content,
			});
		}
	}
	return out;
}

/**
 * Visual mark pin card:
 * - **Note mode** (default for note-only marks): same as text 批注备注 —
 *   editable field + 取消/保存; header action = 加入侧边栏对话.
 * - **Chat mode** (when an Agent thread exists): transcript + continue input;
 *   header includes switch → note mode.
 */
export const VisualTraceCard = memo(function VisualTraceCard({
	trace,
	screen,
	preferRight = true,
	error = null,
	initialExpanded = false,
	initialMode,
	onOpenSession,
	onAddToChat,
	onSaveComment,
	onSend,
	onDelete,
	onHide,
	onStop,
	onPointerEnter,
	onPointerLeave,
}: VisualTraceCardProps) {
	const { t } = useTranslation("viewer");
	const canChat = hasAgentConversation(trace);
	const [mode, setMode] = useState<CardMode>(
		() => initialMode ?? (canChat ? "chat" : "note"),
	);
	const [expanded, setExpanded] = useState(initialExpanded && canChat);
	const [noteText, setNoteText] = useState(trace.comment);
	const noteRef = useRef<HTMLTextAreaElement>(null);
	const { isBlockedByIme, compositionProps } = useImeGuard();

	// Re-sync note field when switching marks or external comment updates.
	// Include id so two marks with the same comment still re-bind the field.
	// biome-ignore lint/correctness/useExhaustiveDependencies: id forces rebind across pins
	useEffect(() => {
		setNoteText(trace.comment);
	}, [trace.id, trace.comment]);

	// If a note-only mark later gains an agent thread, stay in note unless user
	// already chose chat; provisional Agent open forces chat via initialMode.
	useEffect(() => {
		if (initialMode) setMode(initialMode);
	}, [initialMode]);

	useEffect(() => {
		if (mode === "note") {
			// Focus note field when entering note mode.
			requestAnimationFrame(() => noteRef.current?.focus());
		}
	}, [mode]);

	const boundSessionId = useAgentSessionStore(
		(s) =>
			s.sessions.find((item) => item.visualTraceId === trace.id)?.id ?? null,
	);
	const boundLines = useAgentSessionStore((s) => {
		const session = s.sessions.find((item) => item.visualTraceId === trace.id);
		return session?.lines ?? null;
	});
	const boundStatus = useAgentSessionStore(
		(s) =>
			s.sessions.find((item) => item.visualTraceId === trace.id)?.status ??
			null,
	);
	const storeSubmitting = useAgentSessionStore((s) => s.submitting);
	const activeTabId = useAgentSessionStore((s) => s.activeTabId);
	const streaming =
		boundStatus === "running" ||
		(storeSubmitting &&
			boundSessionId !== null &&
			boundSessionId === activeTabId);
	const messages = useMemo(() => {
		return boundLines && boundLines.length > 0
			? chatLinesToTraceMessages(boundLines)
			: traceMessages(trace).map((m) => ({
					id: m.id,
					role: m.role === "user" ? ("user" as const) : ("assistant" as const),
					content: m.content,
				}));
	}, [boundLines, trace]);

	const userAnchorId = useMemo(() => {
		const firstUser = messages.find((m) => m.role === "user");
		return firstUser?.id ?? messages[0]?.id ?? null;
	}, [messages]);
	const scrolledForTraceRef = useRef<string | null>(null);
	const scrollPortRef = useRef<HTMLDivElement | null>(null);
	const scrollTopBeforeExpandRef = useRef(0);
	const lastStreamingId =
		streaming && messages[messages.length - 1]?.role === "assistant"
			? messages[messages.length - 1]?.id
			: null;

	useEffect(() => {
		if (mode !== "chat") return;
		if (scrolledForTraceRef.current === trace.id) return;
		if (!userAnchorId) return;
		const port = scrollPortRef.current;
		const el = document.getElementById(`visual-trace-msg-${userAnchorId}`);
		if (!port || !el) return;
		scrolledForTraceRef.current = trace.id;
		requestAnimationFrame(() => {
			const portTop = port.getBoundingClientRect().top;
			const elTop = el.getBoundingClientRect().top;
			port.scrollTop += elTop - portTop - 8;
		});
	}, [mode, trace.id, userAnchorId]);

	useEffect(() => {
		if (initialExpanded && canChat) {
			setExpanded(true);
			setMode("chat");
		}
	}, [initialExpanded, canChat]);

	const expandCard = useCallback(() => {
		setExpanded((prev) => {
			if (prev) return prev;
			const port = scrollPortRef.current;
			if (port) scrollTopBeforeExpandRef.current = port.scrollTop;
			requestAnimationFrame(() => {
				const next = scrollPortRef.current;
				if (next) next.scrollTop = scrollTopBeforeExpandRef.current;
			});
			return true;
		});
	}, []);

	const saveNote = useCallback(() => {
		onSaveComment(noteText);
		// Match text 批注备注: Save closes the floating editor.
		onHide();
	}, [noteText, onSaveComment, onHide]);

	const noteActions = useMemo(() => {
		const items: Array<{
			label: string;
			onClick: () => void;
			icon: ReactNode;
			destructive?: boolean;
		}> = [];
		// When a conversation exists, allow switching back to chat from note mode.
		if (canChat) {
			items.push({
				label: t("pdfExplain.switchToChat"),
				onClick: () => setMode("chat"),
				icon: (<MessagesSquare className="size-3.5" />) as ReactNode,
			});
		}
		items.push(
			{
				label: t("pdfExplain.addToSidebarChat"),
				onClick: onAddToChat,
				icon: (<MessageSquarePlus className="size-3.5" />) as ReactNode,
			},
			{
				label: t("annotations.delete"),
				onClick: onDelete,
				icon: (<Trash2Icon className="size-3.5" />) as ReactNode,
				destructive: true,
			},
			{
				label: t("annotations.close"),
				onClick: onHide,
				icon: (<X className="size-3.5" />) as ReactNode,
			},
		);
		return items;
	}, [t, onAddToChat, onDelete, onHide, canChat]);

	const chatActions = useMemo(() => {
		return [
			{
				label: t("pdfExplain.switchToNote"),
				onClick: () => setMode("note"),
				icon: (<NotebookPen className="size-3.5" />) as ReactNode,
			},
			{
				label: t("pdfExplain.traceOpenSession"),
				onClick: onOpenSession,
				icon: (<ExternalLink className="size-3.5" />) as ReactNode,
			},
			{
				label: t("annotations.delete"),
				onClick: onDelete,
				icon: (<Trash2Icon className="size-3.5" />) as ReactNode,
				destructive: true,
			},
			{
				label: t("annotations.close"),
				onClick: onHide,
				icon: (<X className="size-3.5" />) as ReactNode,
			},
		];
	}, [t, onOpenSession, onDelete, onHide]);

	// ── Note mode: same shell as AnnotationEditor ──────────────────────────
	if (mode === "note") {
		return (
			<SelectionCard
				screen={screen}
				width={NOTE_SIZE.width}
				height={NOTE_SIZE.height}
				preferRight={preferRight}
				title={t("annotations.editorLabel")}
				icon={NotebookPen}
				ariaLabel={t("annotations.editorLabel")}
				onPointerEnter={onPointerEnter}
				onPointerLeave={onPointerLeave}
				bodyClassName="gap-2 px-3 py-2.5"
				actions={noteActions}
				footer={
					<div className="flex items-center justify-end gap-1">
						<Button type="button" variant="ghost" size="sm" onClick={onHide}>
							{t("annotations.cancel")}
						</Button>
						<Button type="button" size="sm" onClick={saveNote}>
							{t("annotations.save")}
						</Button>
					</div>
				}
			>
				<textarea
					ref={noteRef}
					className="min-h-16 w-full min-w-0 flex-1 resize-none rounded-md border border-border/80 bg-transparent p-2 text-sm text-foreground/80 outline-none placeholder:text-muted-foreground/80 focus:ring-1 focus:ring-ring"
					placeholder={t("annotations.placeholder")}
					value={noteText}
					onChange={(e) => setNoteText(e.target.value)}
					// Keep pin auto-hide from closing while editing the note.
					onFocus={onPointerEnter}
					onPointerDown={onPointerEnter}
					{...compositionProps}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							e.preventDefault();
							onHide();
							return;
						}
						if (e.key === "Enter" && !e.shiftKey && !isBlockedByIme(e)) {
							e.preventDefault();
							saveNote();
						}
					}}
				/>
			</SelectionCard>
		);
	}

	// ── Chat mode ──────────────────────────────────────────────────────────
	const size = expanded ? CHAT_EXPANDED : CHAT_COMPACT;

	return (
		<SelectionCard
			screen={screen}
			width={size.width}
			height={size.height}
			placementWidth={CHAT_EXPANDED.width}
			placementHeight={CHAT_EXPANDED.height}
			lockHeight
			preferRight={preferRight}
			title={t("pdfExplain.traceCardTitle")}
			icon={MessagesSquare}
			ariaLabel={t("pdfExplain.traceCardTitle")}
			onPointerEnter={() => {
				expandCard();
				onPointerEnter?.();
			}}
			onPointerLeave={() => {
				// Collapse compact preview only; parent scheduleHoverHide handles close.
				// Keep calling onPointerLeave so pin→gap→card timers still work.
				if (!streaming) setExpanded(false);
				onPointerLeave?.();
			}}
			bodyClassName="min-h-0 overflow-hidden p-0"
			className="origin-top-left transition-[width,height,max-height] duration-150 ease-out"
			actions={chatActions}
			footer={
				<VisualTraceFooter
					streaming={streaming}
					placeholder={t("pdfExplain.traceContinuePlaceholder")}
					sendLabel={t("pdfExplain.traceSend")}
					stopLabel={t("pdfExplain.traceStop")}
					onSend={onSend}
					onHide={onHide}
					onStop={onStop}
					onFocusInput={expandCard}
				/>
			}
		>
			<div
				ref={scrollPortRef}
				className={cn(
					"agentero-scroll h-full min-h-0 flex-1 overflow-x-hidden overflow-y-auto",
					"[scrollbar-gutter:stable]",
				)}
				role="log"
			>
				<div
					className={cn(
						"flex flex-col gap-2.5 px-3 py-2.5",
						!expanded && "gap-2",
					)}
				>
					{messages.length === 0 ? (
						<p className="text-muted-foreground text-xs leading-relaxed">
							{t("pdfExplain.traceEmptyMessages")}
						</p>
					) : (
						messages.map((m) => {
							const from = m.role === "user" ? "user" : "assistant";
							const isLive = from === "assistant" && m.id === lastStreamingId;
							const isEmptyAssistant = isLive && !m.content.trim();
							const clamp =
								!expanded && from === "assistant"
									? "line-clamp-4"
									: !expanded && from === "user"
										? "line-clamp-2"
										: null;
							const bodyText = m.content.trim();
							if (from === "user" && !bodyText) {
								return null;
							}
							return (
								<Message
									key={m.id}
									id={`visual-trace-msg-${m.id}`}
									from={from}
									className="max-w-full"
								>
									{from === "user" && !bodyText ? null : (
										<MessageContent
											className={cn(
												"text-sm",
												from === "user" && "px-3 py-2",
												from === "assistant" && "w-full max-w-full",
												clamp,
											)}
										>
											{isEmptyAssistant ? (
												<Shimmer className="text-sm" as="p">
													{t("pdfExplain.traceThinking")}
												</Shimmer>
											) : bodyText ? (
												expanded && from === "assistant" && !isLive ? (
													<MessageResponse>{bodyText}</MessageResponse>
												) : (
													<span className="whitespace-pre-wrap break-words">
														{bodyText}
													</span>
												)
											) : null}
										</MessageContent>
									)}
								</Message>
							);
						})
					)}
					{error ? (
						<p className="text-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
					{trace.agent?.status === "failed" && trace.agent.error && !error ? (
						<p className="text-destructive text-xs leading-relaxed">
							{trace.agent.error}
						</p>
					) : null}
				</div>
			</div>
		</SelectionCard>
	);
});
