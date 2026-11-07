import {
	Check,
	ChevronDownIcon,
	CopyIcon,
	Pencil,
	Terminal,
} from "lucide-react";
import type { RefObject } from "react";
import {
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { AgentThinkingOrb } from "@/components/agent/agent-thinking-orb";
import { ChatSelectionReferences } from "@/components/agent/chat-selection-references";
import {
	ChatAttachedImages,
	ChatVisualAnnotations,
	formatUserLineForCopy,
} from "@/components/agent/chat-visual-annotations";
import { ContextSourceLinks } from "@/components/agent/context-source-links";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/agent/conversation";
import {
	Checkpoint,
	CheckpointIcon,
	CheckpointTrigger,
} from "@/components/agent/elements/checkpoint";
import {
	Plan,
	PlanAction,
	PlanContent,
	PlanDescription,
	PlanHeader,
	PlanStep,
	PlanTitle,
	PlanTrigger,
} from "@/components/agent/elements/plan";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/agent/elements/reasoning";
import { Suggestion } from "@/components/agent/elements/suggestion";
import {
	Tool,
	ToolContent,
	ToolHeader,
	ToolInput,
	ToolOutput,
} from "@/components/agent/elements/tool";
import {
	transcriptLineKey,
	useTranscriptVirtualizer,
} from "@/components/agent/hooks/use-transcript-virtualizer";
import { InlineChipText } from "@/components/agent/inline-chip-text";
import {
	Message,
	MessageAction,
	MessageActions,
	MessageContent,
	MessageResponse,
} from "@/components/agent/message";
import { TerminalTool } from "@/components/agent/rendering/terminal-tool";
import { ZhihuDiscussions } from "@/components/agent/zhihu-discussions";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	MessageScrollerContent,
	MessageScrollerItem,
	useMessageScroller,
} from "@/components/ui/message-scroller";
import { Shimmer } from "@/components/ui/shimmer";
import { Skeleton } from "@/components/ui/skeleton";
import { useActiveChatLines } from "@/lib/agent/agent-session-store";
import {
	type AgentPhaseState,
	isAgentAuthFailure,
	isChatOnlyAgentTemplate,
} from "@/lib/agent/api";
import {
	type AgentPart,
	type AskUserQuestion,
	agentTextFromParts,
	type ChatLine,
	copyText,
	isPendingAskUserToolStatus,
	parseAskUserQuestions,
	streamingLabel,
	suggestionItems,
	type ToolAskUserRecord,
	type ToolUiState,
	toolPartState,
} from "@/lib/agent/chat-state";
import {
	hasTranscriptChips,
	inlineMarkupToPlain,
	stripInlineTokens,
} from "@/lib/agent/composer-inline-tokens";
import { stripPromptEnvelopeForDisplay } from "@/lib/agent/prompt-display";
import { selectionNavigationStore } from "@/lib/agent/selection-navigation-state";
import { selectionsPromptBlock } from "@/lib/agent/selection-prompt";
import { terminalToolData } from "@/lib/agent/terminal-tool";
import { cn } from "@/lib/core/utils";
import type { PaperMetadata } from "@/lib/paper";
import { workspaceStore } from "@/lib/workspace/store";
import { isTexPath } from "@/lib/workspace/viewer";

/** Compact note: interactive form is docked below, not inside the tool card. */
function AskUserToolPendingNote() {
	const { t } = useTranslation("agent");
	return (
		<ToolContent>
			<p className="text-xs text-muted-foreground">
				{t("askUserQuestion.pendingInComposer")}
			</p>
		</ToolContent>
	);
}

/** Answered questionnaire shown in the transcript tool card (Grok / OpenCode / elicitation). */
function AskUserToolAnswers({
	record,
	questions,
	className,
}: {
	record?: ToolAskUserRecord;
	questions: AskUserQuestion[];
	className?: string;
}) {
	const { t } = useTranslation("agent");
	return (
		<ToolContent className={className}>
			<dl className="space-y-2">
				{questions.map((question, index) => {
					const raw = record?.answers[index];
					const answer = Array.isArray(raw) ? raw.join(", ") : raw;
					const text = answer?.trim();
					return (
						<div
							key={`${question.id ?? ""}:${question.question}`}
							className="space-y-0.5"
						>
							<dt className="text-xs text-muted-foreground">
								{question.question}
							</dt>
							<dd
								className={cn(
									"whitespace-pre-wrap text-sm",
									!text && "text-muted-foreground",
								)}
							>
								{text ||
									(record?.cancelled
										? t("askUserQuestion.cancelled")
										: t("askUserQuestion.noAnswer"))}
							</dd>
						</div>
					);
				})}
			</dl>
		</ToolContent>
	);
}

function isNonTextPart(part: AgentPart): boolean {
	return (
		part.type === "reasoning" || part.type === "plan" || part.type === "tool"
	);
}

/**
 * PERF: parseAskUserQuestions JSON.parses tool input, and the streaming row
 * re-renders every flush — cache parsed results keyed by the input value.
 * mergeToolState keeps `input` referentially stable across status patches,
 * so one entry covers the whole streaming lifetime of a tool part. Bounded:
 * cleared wholesale on overflow (re-parsing on cache miss is cheap).
 */
const askUserQuestionsCache = new Map<unknown, AskUserQuestion[] | null>();
const ASK_USER_QUESTIONS_CACHE_MAX = 256;

function cachedAskUserQuestions(input: unknown): AskUserQuestion[] | null {
	if (askUserQuestionsCache.size >= ASK_USER_QUESTIONS_CACHE_MAX) {
		askUserQuestionsCache.clear();
	}
	if (!askUserQuestionsCache.has(input)) {
		askUserQuestionsCache.set(input, parseAskUserQuestions(input));
	}
	return askUserQuestionsCache.get(input) ?? null;
}

/** On tab switch, jump to the latest messages instead of keeping the old scroll position. */
function TabScrollToBottom({ activeTabId }: { activeTabId: string }) {
	const { scrollToEnd } = useMessageScroller();
	const prevTabIdRef = useRef(activeTabId);

	useEffect(() => {
		if (prevTabIdRef.current !== activeTabId) {
			prevTabIdRef.current = activeTabId;
			scrollToEnd({ behavior: "instant" });
		}
	}, [activeTabId, scrollToEnd]);

	return null;
}

function HistorySessionShimmer() {
	const { t } = useTranslation("agent");
	return (
		<div className="flex w-full flex-col gap-6 pt-2" aria-live="polite">
			<div className="flex justify-end">
				<div className="flex w-[78%] max-w-[32rem] flex-col gap-2 rounded-lg bg-muted px-3 py-2.5">
					<Skeleton className="h-4 w-11/12 bg-muted-foreground/15" />
					<Skeleton className="h-4 w-7/12 bg-muted-foreground/15" />
				</div>
			</div>
			<div className="flex w-full max-w-[38rem] flex-col gap-3">
				<Shimmer className="text-sm" as="p">
					{t("history.restoring")}
				</Shimmer>
				<div className="flex flex-col gap-2">
					<Skeleton className="h-4 w-10/12" />
					<Skeleton className="h-4 w-full" />
					<Skeleton className="h-4 w-8/12" />
				</div>
			</div>
		</div>
	);
}

type AgentProcessCollapsibleProps = {
	rowKey: string;
	partOpenState: Record<string, boolean>;
	onPartOpenChange: (key: string, open: boolean) => void;
	children: ReactNode;
};

/** Fold reasoning/plan/tool parts into one "Chain of Thought" block once the turn is done. */
function AgentProcessCollapsible({
	rowKey,
	partOpenState,
	onPartOpenChange,
	children,
}: AgentProcessCollapsibleProps) {
	const { t } = useTranslation("aiElements");
	const processKey = `${rowKey}:__process__`;
	const open = partOpenState[processKey] ?? false;

	return (
		<Collapsible
			open={open}
			onOpenChange={(next) => onPartOpenChange(processKey, next)}
			className="not-prose w-full"
		>
			<CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground">
				<span className="font-medium">{t("chainOfThought.title")}</span>
				<ChevronDownIcon
					className={cn(
						"size-4 shrink-0 transition-transform",
						open && "rotate-180",
					)}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="p-2">
				<div className="flex flex-col gap-1 rounded-lg border bg-muted/20 p-2">
					{children}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** Compact activity line shown while assistant is streaming reasoning/tool calls. */
function StreamingActivityRow({
	parts,
	streaming,
	phase = null,
	expanded = false,
	onToggle,
}: {
	parts: AgentPart[];
	streaming: boolean;
	/** Backend loading phase (starting / waiting-model / reconnecting) outranks part-derived labels. */
	phase?: AgentPhaseState | null;
	/** Whether the synchronized live parts are currently shown. */
	expanded?: boolean;
	/** When provided, the row toggles the live reasoning/tool parts. */
	onToggle?: () => void;
}) {
	const { t } = useTranslation("agent");
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		if (!streaming) return;
		const start = Date.now();
		setElapsed(0);
		const timer = setInterval(() => {
			setElapsed(Math.floor((Date.now() - start) / 1000));
		}, 1000);
		return () => clearInterval(timer);
	}, [streaming]);

	if (!streaming) return null;

	const label = streamingLabel(phase, parts, t);
	const content = (
		<>
			<AgentThinkingOrb
				parts={parts}
				streaming={streaming}
				phase={phase}
				showLabel={false}
			/>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			<span className="text-xs tabular-nums">
				{t("streaming.elapsed", { count: elapsed })}
			</span>
			{onToggle ? (
				<ChevronDownIcon
					className={cn(
						"size-3.5 shrink-0 transition-transform",
						expanded && "rotate-180",
					)}
				/>
			) : null}
		</>
	);

	if (!onToggle) {
		return (
			<div className="flex w-full items-center gap-2 text-muted-foreground text-sm">
				{content}
			</div>
		);
	}

	return (
		<button
			type="button"
			aria-expanded={expanded}
			aria-label={t(
				expanded ? "streaming.collapseProcess" : "streaming.expandProcess",
			)}
			title={t(
				expanded ? "streaming.collapseProcess" : "streaming.expandProcess",
			)}
			onClick={onToggle}
			className="flex w-full items-center gap-2 rounded-md text-left text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
		>
			{content}
		</button>
	);
}

type ImeGuardEvent = {
	nativeEvent?: { isComposing?: boolean; keyCode?: number };
	isComposing?: boolean;
	keyCode?: number;
};

/**
 * Row callbacks bundled behind one identity-stable object so memoized rows
 * bail out during streaming. Wrappers read the latest handler from a ref, so
 * stability never means stale closures.
 */
type RowHandlers = {
	isEditBlockedByIme: (event: ImeGuardEvent) => boolean;
	onEditingTextChange: (text: string) => void;
	onCancelEditing: () => void;
	onResendEdited: (lineId: string) => void;
	onStartEditing: (lineId: string, text: string) => void;
	onSendSuggestion: (label: string, workflow?: string) => void;
	onAgentLogin?: () => void;
	onOpenSource?: (source: string) => void;
	editCompositionProps: {
		onCompositionStart?: () => void;
		onCompositionEnd?: () => void;
	};
};

/**
 * Copy button with a brief checkmark feedback state. Takes a lazy getter so
 * heavy payload assembly (full-text joins, selection quote blocks) only runs
 * on click instead of on every row render.
 */
function CopyAction({ getText }: { getText: () => string }) {
	const { t } = useTranslation("agent");
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		try {
			await copyText(getText());
			setCopied(true);
		} catch {
			// Keep the existing silent failure behavior.
		}
	}, [getText]);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);

	return (
		<MessageAction
			tooltip={copied ? t("copied") : t("copy")}
			label={copied ? t("copied") : t("copy")}
			onClick={handleCopy}
		>
			{copied ? (
				<Check className="size-3.5 text-green-600" />
			) : (
				<CopyIcon className="size-3.5" />
			)}
		</MessageAction>
	);
}

/**
 * One transcript line. Memoized so a streaming update to the last line does
 * not re-render the whole history: `updateSessionLines` keeps unchanged line
 * references stable, and every other prop is either a primitive or the
 * identity-stable handlers object.
 */
function delegateField(value: unknown, key: string): string {
	if (typeof value === "string") {
		try {
			return delegateField(JSON.parse(value), key);
		} catch {
			return "";
		}
	}
	if (typeof value === "object" && value !== null && key in value) {
		const field = (value as Record<string, unknown>)[key];
		return typeof field === "string" ? field : "";
	}
	return "";
}

function delegateToolTitle(
	tool: ToolUiState,
	t: (
		key:
			| "delegate.targets"
			| "delegate.result"
			| "delegate.cancel"
			| "delegate.run"
			| "delegate.status.running"
			| "delegate.status.completed"
			| "delegate.status.failed"
			| "delegate.status.cancelled",
		options?: Record<string, string>,
	) => string,
): string | null {
	const name = `${tool.kind} ${tool.title}`;
	if (!name.includes("remote_")) return null;
	if (name.includes("remote_targets")) return t("delegate.targets");
	if (name.includes("remote_delegate_cancel")) return t("delegate.cancel");
	if (name.includes("remote_delegate_result")) return t("delegate.result");
	if (!name.includes("remote_delegate")) return null;
	const host =
		delegateField(tool.output, "destination") ||
		delegateField(tool.input, "target") ||
		"…";
	const agent =
		delegateField(tool.output, "agentId") ||
		delegateField(tool.input, "agentId") ||
		"…";
	const status =
		delegateField(tool.output, "status") ||
		(tool.status === "failed" ? "failed" : "running");
	const statusLabel =
		status === "completed"
			? t("delegate.status.completed")
			: status === "failed"
				? t("delegate.status.failed")
				: status === "cancelled"
					? t("delegate.status.cancelled")
					: t("delegate.status.running");
	return t("delegate.run", { host, agent, status: statusLabel });
}

const ChatTranscriptRow = memo(function ChatTranscriptRow({
	line,
	activeTabId,
	activeTabIsRunning,
	submitting,
	switching,
	isEditing,
	editingText,
	editTextareaRef,
	handlers,
	partOpenState,
	onPartOpenChange,
	phase = null,
}: {
	line: ChatLine;
	activeTabId: string;
	activeTabIsRunning: boolean;
	submitting: boolean;
	switching: boolean;
	isEditing: boolean;
	/** Empty string for non-editing rows so keystrokes only re-render the edited row. */
	editingText: string;
	editTextareaRef: RefObject<HTMLTextAreaElement | null>;
	handlers: RowHandlers;
	/**
	 * Lifted Reasoning/Tool/Plan open state (key = `${rowKey}:${part.id}`) so
	 * virtualized rows keep their fold state across unmount/remount.
	 */
	partOpenState: Record<string, boolean>;
	onPartOpenChange: (key: string, open: boolean) => void;
	/** Loading phase, only passed to the last streaming agent row. */
	phase?: AgentPhaseState | null;
}) {
	const { t } = useTranslation("agent");
	const { onOpenSource } = handlers;

	if (line.kind === "user") {
		const visuals = line.visualAnnotations ?? [];
		const attachedImages = line.images ?? [];
		const chipMarkup =
			line.markup && hasTranscriptChips(line.markup) ? line.markup : undefined;
		if (isEditing) {
			return (
				<Message from="user">
					{/* Chips sit above the bubble, matching composer context chips. */}
					{chipMarkup ? (
						<div className="ml-auto flex w-fit max-w-full flex-wrap justify-end">
							<InlineChipText
								markup={chipMarkup}
								onOpenPath={onOpenSource}
								chipsOnly
							/>
						</div>
					) : null}
					{visuals.length > 0 ? (
						<ChatVisualAnnotations annotations={visuals} />
					) : null}
					{attachedImages.length > 0 ? (
						<ChatAttachedImages images={attachedImages} />
					) : null}
					<div className="ml-auto flex w-full flex-col gap-2 rounded-lg bg-black/5 px-3 py-2.5 ring-1 ring-black/10 dark:bg-white/10 dark:ring-white/15">
						<textarea
							ref={editTextareaRef}
							className="max-h-60 min-h-16 w-full resize-none overflow-y-auto bg-transparent text-foreground text-sm leading-6 outline-none"
							value={editingText}
							onChange={(event) =>
								handlers.onEditingTextChange(event.currentTarget.value)
							}
							{...handlers.editCompositionProps}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									handlers.onCancelEditing();
								} else if (
									event.key === "Enter" &&
									!event.shiftKey &&
									!handlers.isEditBlockedByIme(event)
								) {
									event.preventDefault();
									handlers.onResendEdited(line.id);
								}
							}}
						/>
						<div className="flex items-center justify-end gap-2">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={handlers.onCancelEditing}
							>
								{t("edit.cancel")}
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={!editingText.trim() || submitting || switching}
								onClick={() => handlers.onResendEdited(line.id)}
							>
								{t("edit.resend")}
							</Button>
						</div>
					</div>
				</Message>
			);
		}
		const userDisplay = stripPromptEnvelopeForDisplay(
			stripInlineTokens(line.text),
		);
		// Never render Codex env / Host system envelopes as user bubbles.
		if (
			!userDisplay &&
			!chipMarkup &&
			visuals.length === 0 &&
			attachedImages.length === 0 &&
			!line.selections?.length
		)
			return null;
		// PERF: copy payload joins the full selection quote block — build it
		// lazily in the copy handler instead of on every row render.
		const copyText = chipMarkup ? inlineMarkupToPlain(chipMarkup) : userDisplay;
		const buildCopyPayload = () =>
			[
				formatUserLineForCopy({
					text: copyText,
					visualAnnotations: visuals,
					images: attachedImages,
				}),
				selectionsPromptBlock(line.selections ?? []),
			]
				.filter(Boolean)
				.join("\n\n");
		return (
			<Message from="user" className="max-w-[85%]">
				<ChatSelectionReferences selections={line.selections ?? []} />
				{/* Visual chips above the text bubble (not inside it). */}
				{visuals.length > 0 ? (
					<ChatVisualAnnotations annotations={visuals} />
				) : null}
				{/*
				 * Right-anchored content block. Hover actions float at its
				 * bottom-left corner, out of layout flow — a hidden action row
				 * used to add a blank line between the user turn and the reply.
				 */}
				<div className="relative ml-auto w-fit max-w-full">
					{attachedImages.length > 0 ? (
						<ChatAttachedImages images={attachedImages} />
					) : null}
					{/* Free-text only: skip empty bubble when the turn is image/visual-only. */}
					{chipMarkup || userDisplay ? (
						<MessageContent
							className="rounded-2xl px-4 py-2.5"
							data-selection-chat-source={`Chat ${activeTabId}`}
							data-selection-chat-origin="chat"
							data-selection-chat-message={line.id}
						>
							{chipMarkup ? (
								<InlineChipText markup={chipMarkup} onOpenPath={onOpenSource} />
							) : (
								<MessageResponse className="text-base leading-relaxed">
									{userDisplay}
								</MessageResponse>
							)}
						</MessageContent>
					) : null}
					{/* Hovers beside the bubble's bottom-left, outside the box. */}
					<MessageActions className="absolute right-full bottom-0 mr-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
						{activeTabIsRunning || !userDisplay ? null : (
							<MessageAction
								tooltip={t("edit.action")}
								label={t("edit.action")}
								disabled={submitting || switching}
								onClick={() => handlers.onStartEditing(line.id, userDisplay)}
							>
								<Pencil className="size-3.5" />
							</MessageAction>
						)}
						<CopyAction getText={buildCopyPayload} />
					</MessageActions>
				</div>
			</Message>
		);
	}
	if (line.kind === "agent") {
		// Include activeTabId so per-part Reasoning/Tool state never
		// leaks across sessions when history line ids collide
		// (e.g. Codex thread message ids).
		const rowKey = `${activeTabId}:${line.id}`;
		const liveKey = `${rowKey}:__live__`;
		const showLiveProcess = partOpenState[liveKey] ?? false;
		const parts = line.parts;
		const lastIndex = parts.length - 1;
		// PERF: agentTextFromParts joins the whole reply on every render of
		// the streaming row — gate on a cheap scan and build text on copy.
		const hasAgentText = parts.some(
			(part) => part.type === "text" && part.text.length > 0,
		);
		const isStreaming = Boolean(line.streaming);

		const renderAgentPart = (
			part: AgentPart,
			index: number,
			insideProcess: boolean,
		) => {
			const partKey = `${rowKey}:${part.id}`;
			if (part.type === "reasoning") {
				const streaming = Boolean(line.streaming) && index === lastIndex;
				if (!part.text.trim() && !streaming) return null;
				return (
					<Reasoning
						key={partKey}
						className={insideProcess ? "mb-0" : "mb-2"}
						isStreaming={streaming}
						// Collapsed by default; the compact activity row above the
						// parts carries the live one-line progress. Expand on click
						// while streaming to read the full thought. Open state is
						// lifted to ChatTranscript so virtualized rows survive unmount.
						defaultOpen={false}
						open={partOpenState[partKey] ?? false}
						onOpenChange={(open) => onPartOpenChange(partKey, open)}
					>
						<ReasoningTrigger
							className={insideProcess ? "px-2 py-1.5 text-xs" : undefined}
							swapIconOnHover={insideProcess}
						/>
						<ReasoningContent
							className={insideProcess ? "mt-2 px-2 pb-2" : undefined}
							onOpenSource={onOpenSource}
						>
							{part.text}
						</ReasoningContent>
					</Reasoning>
				);
			}
			if (part.type === "plan") {
				const plan = part.entries;
				if (plan.length === 0) return null;
				const planStreaming =
					Boolean(line.streaming) && plan.some((p) => p.status !== "completed");
				return (
					<Plan
						key={partKey}
						className={cn(
							"shadow-none",
							insideProcess
								? "mb-0 rounded-none border-0 bg-transparent"
								: "mb-2",
						)}
						isStreaming={planStreaming}
						open={partOpenState[partKey] ?? true}
						onOpenChange={(open) => onPartOpenChange(partKey, open)}
					>
						<PlanHeader className={insideProcess ? "px-2 py-2" : undefined}>
							<div className="min-w-0 flex-1 space-y-1">
								<PlanTitle>{t("plan.title")}</PlanTitle>
								<PlanDescription>
									{t("plan.steps", {
										completed: plan.filter((p) => p.status === "completed")
											.length,
										total: plan.length,
									})}
								</PlanDescription>
							</div>
							<PlanAction>
								<PlanTrigger />
							</PlanAction>
						</PlanHeader>
						<PlanContent className={insideProcess ? "px-2 pb-2 pt-0" : "pt-0"}>
							<ol className="space-y-2">
								{plan.map((entry) => (
									<PlanStep
										key={`${entry.status}:${entry.priority}:${entry.content}`}
										status={
											entry.status === "completed"
												? "completed"
												: entry.status === "in_progress"
													? "in_progress"
													: "pending"
										}
									>
										{entry.content}
									</PlanStep>
								))}
							</ol>
						</PlanContent>
					</Plan>
				);
			}
			if (part.type === "tool") {
				const tool = part.tool;
				const state = toolPartState(tool.status);
				const parsedQuestions = cachedAskUserQuestions(tool.input);
				const askRecord = tool.askUser;
				const askUserQuestion = askRecord?.questions.length
					? askRecord.questions
					: parsedQuestions;
				// Interactive form is owned by the composer; transcript
				// shows a compact tool row, a pending note, or the recorded Q&A.
				const askPending =
					!askRecord &&
					Boolean(askUserQuestion) &&
					isPendingAskUserToolStatus(tool.status);
				const terminal = !askUserQuestion ? terminalToolData(tool) : null;
				if (terminal)
					return (
						<TerminalTool
							key={partKey}
							data={terminal}
							tool={tool}
							compact={insideProcess}
							open={
								partOpenState[partKey] ??
								(tool.status === "in_progress" && Boolean(terminal.output))
							}
							onOpenChange={(open) => onPartOpenChange(partKey, open)}
						/>
					);
				return (
					<Tool
						key={partKey}
						className={
							insideProcess
								? "mb-0 rounded-none border-0 bg-transparent shadow-none"
								: undefined
						}
						open={partOpenState[partKey] ?? askPending}
						onOpenChange={(open) => onPartOpenChange(partKey, open)}
					>
						<ToolHeader
							className={insideProcess ? "px-2 py-1.5" : undefined}
							swapIconOnHover={insideProcess}
							title={
								delegateToolTitle(tool, t) ||
								tool.title ||
								t("tool.defaultTitle")
							}
							type={`tool-${tool.kind}`}
							state={state}
						/>
						{askPending ? (
							<AskUserToolPendingNote />
						) : askUserQuestion ? (
							<AskUserToolAnswers
								record={askRecord}
								questions={askUserQuestion}
								className={insideProcess ? "border-t-0 px-2 py-2" : undefined}
							/>
						) : (
							<ToolContent
								className={insideProcess ? "border-t-0 px-2 py-2" : undefined}
							>
								{tool.input !== undefined ? (
									<ToolInput input={tool.input} />
								) : null}
								<ToolOutput
									output={tool.output}
									errorText={
										tool.status === "failed" ? t("tool.failed") : undefined
									}
								/>
							</ToolContent>
						)}
					</Tool>
				);
			}
			if (!part.text) return null;
			const isAnimating =
				Boolean(line.streaming) && index === lastIndex && part.text.length > 0;
			return (
				<div
					key={partKey}
					className="min-w-0"
					data-selection-chat-source={`Chat ${activeTabId}`}
					data-selection-chat-origin="chat"
					data-selection-chat-message={line.id}
				>
					<MessageResponse
						isAnimating={isAnimating}
						enableOpenUiBlocks
						onOpenSource={onOpenSource}
					>
						{part.text}
					</MessageResponse>
				</div>
			);
		};

		const nonTextParts = parts.filter(isNonTextPart);
		const textParts = parts.filter((p) => !isNonTextPart(p));
		const groupNonText = !line.streaming && nonTextParts.length > 0;

		return (
			<div className="flex w-full flex-col gap-3">
				<Message from="assistant">
					<MessageContent className="w-full gap-3 text-base leading-relaxed">
						{groupNonText ? (
							<>
								<AgentProcessCollapsible
									rowKey={rowKey}
									partOpenState={partOpenState}
									onPartOpenChange={onPartOpenChange}
								>
									{nonTextParts.map((part, index) =>
										renderAgentPart(part, index, true),
									)}
								</AgentProcessCollapsible>
								{textParts.map((part, index) =>
									renderAgentPart(part, index, false),
								)}
							</>
						) : isStreaming ? (
							<>
								{/* Default view mirrors the old compact stream: one live line
								    plus answer text. Clicking the line reveals the synchronized
								    reasoning / plan / tool parts in place; clicking again folds
								    them back. */}
								{parts.length === 0 || nonTextParts.length > 0 || phase ? (
									<StreamingActivityRow
										parts={parts}
										streaming={isStreaming}
										phase={phase}
										expanded={showLiveProcess}
										onToggle={
											nonTextParts.length > 0
												? () => onPartOpenChange(liveKey, !showLiveProcess)
												: undefined
										}
									/>
								) : null}
								{showLiveProcess
									? parts.map((part, index) =>
											renderAgentPart(part, index, false),
										)
									: parts.map((part, index) =>
											isNonTextPart(part)
												? null
												: renderAgentPart(part, index, false),
										)}
							</>
						) : (
							parts.map((part, index) => renderAgentPart(part, index, false))
						)}
					</MessageContent>
					{!line.streaming && line.sources?.length ? (
						<div className="px-1">
							<ContextSourceLinks sources={line.sources} />
						</div>
					) : null}
					{!line.streaming && hasAgentText ? (
						<MessageActions className="-mt-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
							<CopyAction getText={() => agentTextFromParts(parts)} />
						</MessageActions>
					) : null}
				</Message>
			</div>
		);
	}
	if (line.kind === "error") {
		const canLogin =
			Boolean(handlers.onAgentLogin) && isAgentAuthFailure(line.text);
		return (
			<Message from="assistant">
				<MessageContent className="text-destructive">
					<MessageResponse>{line.text}</MessageResponse>
					{canLogin ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="mt-2 h-7 gap-1 px-2 text-xs"
							onClick={() => handlers.onAgentLogin?.()}
						>
							<Terminal className="size-3" />
							{t("login.action")}
						</Button>
					) : null}
				</MessageContent>
			</Message>
		);
	}
	return (
		<Checkpoint className="my-1 px-1">
			<CheckpointIcon />
			<CheckpointTrigger
				className="h-auto px-1 py-0.5 text-muted-foreground text-xs"
				variant="ghost"
				tooltip={line.text}
			>
				{line.text}
			</CheckpointTrigger>
		</Checkpoint>
	);
});

/**
 * Renders transcript rows. Must live inside <Conversation> so it can reach
 * the Message Scroller viewport via context. Long transcripts switch to
 * windowed rendering (absolute rows inside a totalSize container); short ones
 * keep the plain flex/gap layout.
 */
function TranscriptBody({
	lines,
	activeTabId,
	activeTabIsRunning,
	submitting,
	switching,
	editingLineId,
	editingText,
	editTextareaRef,
	handlers,
	partOpenState,
	onPartOpenChange,
	forceVirtualize,
	phase,
}: {
	lines: ChatLine[];
	activeTabId: string;
	activeTabIsRunning: boolean;
	submitting: boolean;
	switching: boolean;
	editingLineId: string | null;
	editingText: string;
	editTextareaRef: RefObject<HTMLTextAreaElement | null>;
	handlers: RowHandlers;
	partOpenState: Record<string, boolean>;
	onPartOpenChange: (key: string, open: boolean) => void;
	forceVirtualize?: boolean;
	/** Loading phase, forwarded only to the last streaming agent row. */
	phase?: AgentPhaseState | null;
}) {
	const { rowVirtualizer, virtualized } = useTranscriptVirtualizer({
		lines,
		activeTabId,
		forceVirtualize,
	});

	// PERF: narrow subscriptions — `nonce` only invalidates the navigation
	// promise on the writer side, and a whole-store subscription re-rendered
	// TranscriptBody on every re-navigation.
	const navigationMessageId = useStore(
		selectionNavigationStore,
		(s) => s.messageId,
	);
	const navigationTabId = useStore(selectionNavigationStore, (s) => s.tabId);
	useEffect(() => {
		if (!navigationMessageId || navigationTabId !== activeTabId || !virtualized)
			return;
		const index = lines.findIndex((line) => line.id === navigationMessageId);
		if (index >= 0) {
			rowVirtualizer.scrollToIndex(index, { align: "center" });
			selectionNavigationStore.setState({ messageId: null });
		}
	}, [
		navigationMessageId,
		navigationTabId,
		lines,
		virtualized,
		rowVirtualizer,
		activeTabId,
	]);

	// The edit button can target turns far above the viewport; bring the row
	// into the mounted window when windowed rendering is active.
	useEffect(() => {
		if (!virtualized || !editingLineId) return;
		const index = lines.findIndex((line) => line.id === editingLineId);
		if (index >= 0) {
			rowVirtualizer.scrollToIndex(index, { align: "auto" });
		}
	}, [editingLineId, virtualized, lines, rowVirtualizer]);

	// Only the last streaming agent row carries the phase, so memoized
	// history rows do not re-render on every phase change.
	let lastStreamingAgentId: string | null = null;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line.kind === "agent" && line.streaming) {
			lastStreamingAgentId = line.id;
			break;
		}
	}

	const renderRow = (line: ChatLine) => {
		const isEditing = editingLineId === line.id;
		return (
			<ChatTranscriptRow
				line={line}
				activeTabId={activeTabId}
				activeTabIsRunning={activeTabIsRunning}
				submitting={submitting}
				switching={switching}
				isEditing={isEditing}
				editingText={isEditing ? editingText : ""}
				editTextareaRef={editTextareaRef}
				handlers={handlers}
				partOpenState={partOpenState}
				onPartOpenChange={onPartOpenChange}
				phase={phase && line.id === lastStreamingAgentId ? phase : null}
			/>
		);
	};

	if (!virtualized) {
		return (
			<MessageScrollerContent className="w-full min-h-0">
				{lines.map((line) => (
					<MessageScrollerItem
						key={transcriptLineKey(line, activeTabId)}
						messageId={transcriptLineKey(line, activeTabId)}
						className="[content-visibility:visible]"
					>
						{renderRow(line)}
					</MessageScrollerItem>
				))}
			</MessageScrollerContent>
		);
	}

	return (
		<MessageScrollerContent className="min-h-0 gap-0">
			<MessageScrollerItem
				messageId={`virtual:${activeTabId}`}
				className="relative w-full [content-visibility:visible] [contain-intrinsic-size:none]"
				style={{ height: rowVirtualizer.getTotalSize() }}
			>
				{rowVirtualizer.getVirtualItems().map((virtualRow) => (
					// pb-8 replaces the flex gap-8 spacing (absolute rows have no gap).
					<div
						key={virtualRow.key}
						className="absolute top-0 left-0 w-full pb-6"
						style={{ transform: `translateY(${virtualRow.start}px)` }}
						ref={rowVirtualizer.measureElement}
						data-index={virtualRow.index}
					>
						{renderRow(lines[virtualRow.index])}
					</div>
				))}
			</MessageScrollerItem>
		</MessageScrollerContent>
	);
}

/**
 * Renders the transcript. Subscribes to the active lines itself so the
 * per-frame identity swaps during streaming re-render only this subtree,
 * not the whole panel shell.
 */
export const ChatTranscript = memo(function ChatTranscript({
	activeTabId,
	hydratingSessionId,
	compact = false,
	forceVirtualize = false,
	activeTabIsRunning,
	submitting,
	switching,
	editingLineId,
	editingText,
	editTextareaRef,
	editCompositionProps,
	isEditBlockedByIme,
	onEditingTextChange,
	onCancelEditing,
	onResendEdited,
	onStartEditing,
	onSendSuggestion,
	onAgentLogin,
	onOpenSource,
	agentTemplate = null,
	paper = null,
	phase = null,
}: {
	activeTabId: string;
	hydratingSessionId: string | null;
	compact?: boolean;
	/** Storybook / tests: windowed rendering even below the line threshold. */
	forceVirtualize?: boolean;
	activeTabIsRunning: boolean;
	submitting: boolean;
	switching: boolean;
	editingLineId: string | null;
	editingText: string;
	editTextareaRef: RefObject<HTMLTextAreaElement | null>;
	editCompositionProps: {
		onCompositionStart?: () => void;
		onCompositionEnd?: () => void;
	};
	isEditBlockedByIme: (event: ImeGuardEvent) => boolean;
	onEditingTextChange: (text: string) => void;
	onCancelEditing: () => void;
	onResendEdited: (lineId: string) => void;
	onStartEditing: (lineId: string, text: string) => void;
	onSendSuggestion: (label: string, workflow?: string) => void;
	onAgentLogin?: () => void;
	/** Open a vault path / paper (or external URL) from Sources / inline citation. */
	onOpenSource?: (source: string) => void;
	/** Active agent template — chat-only built-ins (Zhihu) get a bespoke empty state. */
	agentTemplate?: string | null;
	/** Focused paper metadata, used by the Zhihu empty-state discussion cards. */
	paper?: PaperMetadata | null;
	/** Loading phase of the in-flight turn (starting / waiting-model / reconnecting). */
	phase?: AgentPhaseState | null;
}) {
	const { t } = useTranslation("agent");
	// PERF: owned here instead of the panel — streaming flushes swap the
	// lines array identity every rAF frame, and a panel-level subscription
	// re-rendered the whole shell (composer, config bar, switcher) per frame.
	const lines = useActiveChatLines();
	const restoringHistorySession =
		hydratingSessionId === activeTabId && lines.length === 0;
	// Chat-only built-ins (Zhihu) replace the generic suggestions with their own
	// empty state.
	const zhihuEmpty = isChatOnlyAgentTemplate(agentTemplate);

	// Lifted Reasoning/Tool/Plan open state so virtualized rows keep their
	// fold state across unmount/remount. Keyed by `${rowKey}:${part.id}`.
	const [partOpenState, setPartOpenState] = useState<Record<string, boolean>>(
		{},
	);
	// Tab switch resets the table (non-agent line ids can collide across tabs).
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on tab switch
	useEffect(() => {
		setPartOpenState({});
	}, [activeTabId]);
	const handlePartOpenChange = useCallback((key: string, open: boolean) => {
		setPartOpenState((prev) =>
			prev[key] === open ? prev : { ...prev, [key]: open },
		);
	}, []);

	// Latest-callback ref + identity-stable wrappers: parents may pass inline
	// closures, but memoized rows must not re-render on every parent render.
	const latestHandlersRef = useRef<RowHandlers>({
		isEditBlockedByIme,
		onEditingTextChange,
		onCancelEditing,
		onResendEdited,
		onStartEditing,
		onSendSuggestion,
		onAgentLogin,
		onOpenSource,
		editCompositionProps,
	});
	latestHandlersRef.current = {
		isEditBlockedByIme,
		onEditingTextChange,
		onCancelEditing,
		onResendEdited,
		onStartEditing,
		onSendSuggestion,
		onAgentLogin,
		onOpenSource,
		editCompositionProps,
	};
	const hasOpenSource = Boolean(onOpenSource);
	const writing = useStore(workspaceStore, (state) => {
		const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
		return Boolean(tab && (tab.texRoot || isTexPath(tab.path)));
	});
	const suggestions = suggestionItems(writing);
	const rowHandlers = useMemo<RowHandlers>(
		() => ({
			isEditBlockedByIme: (event) =>
				latestHandlersRef.current.isEditBlockedByIme(event),
			onEditingTextChange: (text) =>
				latestHandlersRef.current.onEditingTextChange(text),
			onCancelEditing: () => latestHandlersRef.current.onCancelEditing(),
			onResendEdited: (lineId) =>
				latestHandlersRef.current.onResendEdited(lineId),
			onStartEditing: (lineId, text) =>
				latestHandlersRef.current.onStartEditing(lineId, text),
			onSendSuggestion: (label, workflow) =>
				latestHandlersRef.current.onSendSuggestion(label, workflow),
			onAgentLogin: onAgentLogin
				? () => latestHandlersRef.current.onAgentLogin?.()
				: undefined,
			// Keep undefined when absent so rows preserve "no open handler" UI.
			onOpenSource: hasOpenSource
				? (source) => latestHandlersRef.current.onOpenSource?.(source)
				: undefined,
			editCompositionProps: {
				onCompositionStart: () =>
					latestHandlersRef.current.editCompositionProps.onCompositionStart?.(),
				onCompositionEnd: () =>
					latestHandlersRef.current.editCompositionProps.onCompositionEnd?.(),
			},
		}),
		[hasOpenSource, onAgentLogin],
	);

	return (
		<Conversation className="min-h-0 flex-1">
			<ConversationContent
				scrollClassName={
					compact
						? "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
						: undefined
				}
			>
				<TabScrollToBottom activeTabId={activeTabId} />
				{restoringHistorySession ? (
					<MessageScrollerContent>
						<MessageScrollerItem>
							<HistorySessionShimmer />
						</MessageScrollerItem>
					</MessageScrollerContent>
				) : lines.length === 0 ? (
					<MessageScrollerContent>
						<MessageScrollerItem className="flex w-full flex-col gap-6">
							<ConversationEmptyState
								className={zhihuEmpty ? "px-2 py-8" : undefined}
								title={t("empty.title")}
								description={t(
									writing ? "empty.writingDescription" : "empty.description",
								)}
							>
								{zhihuEmpty ? (
									<ZhihuDiscussions paper={paper} />
								) : (
									<div className="mt-4 flex w-full max-w-sm flex-col items-stretch gap-2">
										{activeTabIsRunning ? (
											<Shimmer className="text-center text-sm">
												{t("empty.waiting")}
											</Shimmer>
										) : (
											suggestions.map((item) => {
												const label = t(`suggestions.${item.key}`);
												return (
													<Suggestion
														key={item.key}
														suggestion={label}
														className="h-auto w-full justify-start whitespace-normal rounded-lg px-3 py-2.5 text-left hover:shadow-raised"
														onClick={(value) =>
															onSendSuggestion(value, item.workflow)
														}
														disabled={activeTabIsRunning}
													/>
												);
											})
										)}
									</div>
								)}
							</ConversationEmptyState>
						</MessageScrollerItem>
					</MessageScrollerContent>
				) : (
					<TranscriptBody
						lines={lines}
						activeTabId={activeTabId}
						activeTabIsRunning={activeTabIsRunning}
						submitting={submitting}
						switching={switching}
						editingLineId={editingLineId}
						editingText={editingText}
						editTextareaRef={editTextareaRef}
						handlers={rowHandlers}
						partOpenState={partOpenState}
						onPartOpenChange={handlePartOpenChange}
						forceVirtualize={forceVirtualize}
						phase={phase}
					/>
				)}
			</ConversationContent>
			<ConversationScrollButton />
		</Conversation>
	);
});
