import { Check, CopyIcon, Pencil } from "lucide-react";
import type { RefObject } from "react";
import {
	Fragment,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	ChatAttachedImages,
	ChatVisualAnnotations,
	formatUserLineForCopy,
} from "@/components/agent/chat-visual-annotations";
import {
	transcriptLineKey,
	useTranscriptVirtualizer,
} from "@/components/agent/hooks/use-transcript-virtualizer";
import {
	Checkpoint,
	CheckpointIcon,
	CheckpointTrigger,
} from "@/components/ai-elements/checkpoint";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
	Message,
	MessageAction,
	MessageActions,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	Plan,
	PlanAction,
	PlanContent,
	PlanDescription,
	PlanHeader,
	PlanStep,
	PlanTitle,
	PlanTrigger,
} from "@/components/ai-elements/plan";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
	Source,
	Sources,
	SourcesContent,
	SourcesTrigger,
} from "@/components/ai-elements/sources";
import { Suggestion } from "@/components/ai-elements/suggestion";
import {
	Tool,
	ToolContent,
	ToolHeader,
	ToolInput,
	ToolOutput,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import {
	agentTextFromParts,
	type ChatLine,
	copyText,
	isPendingAskUserToolStatus,
	parseAskUserQuestions,
	SUGGESTION_KEYS,
	SUGGESTION_WORKFLOW,
	toolPartState,
} from "@/lib/agent/chat-state";
import { stripPromptEnvelopeForDisplay } from "@/lib/agent/prompt-display";
import { normalizeAgentSourcePath } from "@/lib/agent/sources";

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
	onOpenSource?: (source: string) => void;
	editCompositionProps: {
		onCompositionStart?: () => void;
		onCompositionEnd?: () => void;
	};
};

/** Copy button with a brief checkmark feedback state. */
function CopyAction({ text }: { text: string }) {
	const { t } = useTranslation("agent");
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		try {
			await copyText(text);
			setCopied(true);
		} catch {
			// Keep the existing silent failure behavior.
		}
	}, [text]);

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
const ChatTranscriptRow = memo(function ChatTranscriptRow({
	line,
	activeTabId,
	agentName,
	activeTabIsRunning,
	submitting,
	switching,
	isEditing,
	editingText,
	editTextareaRef,
	handlers,
	partOpenState,
	onPartOpenChange,
}: {
	line: ChatLine;
	activeTabId: string;
	agentName: string;
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
}) {
	const { t } = useTranslation("agent");
	const { onOpenSource } = handlers;

	if (line.kind === "user") {
		const visuals = line.visualAnnotations ?? [];
		const attachedImages = line.images ?? [];
		if (isEditing) {
			return (
				<Message from="user">
					{/* Chips sit above the bubble, matching composer context chips. */}
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
		const userDisplay = stripPromptEnvelopeForDisplay(line.text);
		// Never render Codex env / Host system envelopes as user bubbles.
		if (!userDisplay && visuals.length === 0 && attachedImages.length === 0)
			return null;
		const copyPayload = formatUserLineForCopy({
			text: userDisplay,
			visualAnnotations: visuals,
			images: attachedImages,
		});
		return (
			<Message from="user">
				{/* Visual / image chips above the text bubble (not inside it). */}
				{visuals.length > 0 ? (
					<ChatVisualAnnotations annotations={visuals} />
				) : null}
				{attachedImages.length > 0 ? (
					<ChatAttachedImages images={attachedImages} />
				) : null}
				{/* Free-text only: skip empty bubble when the turn is image/visual-only. */}
				{userDisplay ? (
					<MessageContent>
						<MessageResponse>{userDisplay}</MessageResponse>
					</MessageContent>
				) : null}
				{/* Align under user content (Message is full-width) */}
				<MessageActions className="-mt-1 ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
					<CopyAction text={copyPayload} />
				</MessageActions>
			</Message>
		);
	}
	if (line.kind === "agent") {
		// Include activeTabId so per-part Reasoning/Tool state never
		// leaks across sessions when history line ids collide
		// (e.g. Codex thread message ids).
		const rowKey = `${activeTabId}:${line.id}`;
		const parts = line.parts;
		const lastIndex = parts.length - 1;
		const agentText = agentTextFromParts(parts);
		const showThinking = Boolean(line.streaming) && parts.length === 0;
		return (
			<div className="flex w-full flex-col gap-2">
				<Message from="assistant">
					<MessageContent>
						<p className="mb-1 font-medium text-muted-foreground text-xs">
							{agentName}
						</p>
						{parts.map((part, index) => {
							const partKey = `${rowKey}:${part.id}`;
							if (part.type === "reasoning") {
								const streaming =
									Boolean(line.streaming) && index === lastIndex;
								if (!part.text.trim() && !streaming) return null;
								return (
									<Reasoning
										key={partKey}
										className="mb-2"
										isStreaming={streaming}
										// Collapsed by default so the transcript stays
										// scannable; expand on click. Also collapsed
										// while streaming (no auto-expand). Open state
										// is lifted to ChatTranscript so virtualized
										// rows survive unmount; defaultOpen={false}
										// still suppresses streaming auto-open.
										defaultOpen={false}
										open={partOpenState[partKey] ?? false}
										onOpenChange={(open) => onPartOpenChange(partKey, open)}
									>
										<ReasoningTrigger />
										<ReasoningContent>{part.text}</ReasoningContent>
									</Reasoning>
								);
							}
							if (part.type === "plan") {
								const plan = part.entries;
								if (plan.length === 0) return null;
								const planStreaming =
									Boolean(line.streaming) &&
									plan.some((p) => p.status !== "completed");
								return (
									<Plan
										key={partKey}
										className="mb-2"
										isStreaming={planStreaming}
										open={partOpenState[partKey] ?? true}
										onOpenChange={(open) => onPartOpenChange(partKey, open)}
									>
										<PlanHeader>
											<div className="min-w-0 flex-1 space-y-1">
												<PlanTitle>{t("plan.title")}</PlanTitle>
												<PlanDescription>
													{t("plan.steps", {
														completed: plan.filter(
															(p) => p.status === "completed",
														).length,
														total: plan.length,
													})}
												</PlanDescription>
											</div>
											<PlanAction>
												<PlanTrigger />
											</PlanAction>
										</PlanHeader>
										<PlanContent className="pt-0">
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
								const askUserQuestion = parseAskUserQuestions(tool.input);
								// Interactive form is owned by the composer; transcript
								// only shows a compact tool row (and a short pending note).
								const askPending =
									Boolean(askUserQuestion) &&
									isPendingAskUserToolStatus(tool.status);
								return (
									<Tool
										key={partKey}
										open={partOpenState[partKey] ?? askPending}
										onOpenChange={(open) => onPartOpenChange(partKey, open)}
									>
										<ToolHeader
											title={tool.title || t("tool.defaultTitle")}
											type={`tool-${tool.kind}`}
											state={state}
										/>
										{askPending ? (
											<AskUserToolPendingNote />
										) : askUserQuestion ? null : (
											<ToolContent>
												{tool.input !== undefined ? (
													<ToolInput input={tool.input} />
												) : null}
												<ToolOutput
													output={tool.output}
													errorText={
														tool.status === "failed"
															? t("tool.failed")
															: undefined
													}
												/>
											</ToolContent>
										)}
									</Tool>
								);
							}
							if (!part.text) return null;
							const isAnimating =
								Boolean(line.streaming) &&
								index === lastIndex &&
								part.text.length > 0;
							return (
								<div key={partKey} className="min-w-0">
									<MessageResponse isAnimating={isAnimating}>
										{part.text}
									</MessageResponse>
								</div>
							);
						})}
						{showThinking ? (
							<Shimmer className="text-sm">{t("thinking")}</Shimmer>
						) : null}
					</MessageContent>
					{!line.streaming && agentText ? (
						<MessageActions className="-mt-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
							<CopyAction text={agentText} />
						</MessageActions>
					) : null}
				</Message>
				{line.sources && line.sources.length > 0 ? (
					<Sources>
						<SourcesTrigger count={line.sources.length} />
						<SourcesContent>
							{line.sources.map((raw) => {
								const s = normalizeAgentSourcePath(raw);
								const isHttp = /^https?:\/\//i.test(s);
								return (
									<Source
										key={s}
										title={s}
										// External URLs are opened by the opener plugin via onClick;
										// do not render them as <a target="_blank"> to avoid Tauri
										// creating an empty in-app webview window.
										href={isHttp ? undefined : s}
										onClick={onOpenSource ? () => onOpenSource(s) : undefined}
									/>
								);
							})}
						</SourcesContent>
					</Sources>
				) : null}
			</div>
		);
	}
	if (line.kind === "error") {
		return (
			<Message from="assistant">
				<MessageContent className="text-destructive">
					<MessageResponse>{line.text}</MessageResponse>
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
 * the StickToBottom scroll viewport via context. Long transcripts switch to
 * windowed rendering (absolute rows inside a totalSize container); short ones
 * keep the plain flex/gap layout.
 */
function TranscriptBody({
	lines,
	activeTabId,
	agentName,
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
}: {
	lines: ChatLine[];
	activeTabId: string;
	agentName: string;
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
}) {
	const { rowVirtualizer, virtualized } = useTranscriptVirtualizer({
		lines,
		activeTabId,
		forceVirtualize,
	});

	// The edit button can target turns far above the viewport; bring the row
	// into the mounted window when windowed rendering is active.
	useEffect(() => {
		if (!virtualized || !editingLineId) return;
		const index = lines.findIndex((line) => line.id === editingLineId);
		if (index >= 0) {
			rowVirtualizer.scrollToIndex(index, { align: "auto" });
		}
	}, [editingLineId, virtualized, lines, rowVirtualizer]);

	const renderRow = (line: ChatLine) => {
		const isEditing = editingLineId === line.id;
		return (
			<ChatTranscriptRow
				line={line}
				activeTabId={activeTabId}
				agentName={agentName}
				activeTabIsRunning={activeTabIsRunning}
				submitting={submitting}
				switching={switching}
				isEditing={isEditing}
				editingText={isEditing ? editingText : ""}
				editTextareaRef={editTextareaRef}
				handlers={handlers}
				partOpenState={partOpenState}
				onPartOpenChange={onPartOpenChange}
			/>
		);
	};

	if (!virtualized) {
		return (
			<div className="flex w-full flex-col gap-8">
				{lines.map((line) => (
					<Fragment key={transcriptLineKey(line, activeTabId)}>
						{renderRow(line)}
					</Fragment>
				))}
			</div>
		);
	}

	return (
		<div
			className="relative w-full"
			style={{ height: rowVirtualizer.getTotalSize() }}
		>
			{rowVirtualizer.getVirtualItems().map((virtualRow) => (
				// pb-8 replaces the flex gap-8 spacing (absolute rows have no gap).
				<div
					key={virtualRow.key}
					className="absolute top-0 left-0 w-full pb-8"
					style={{ transform: `translateY(${virtualRow.start}px)` }}
					ref={rowVirtualizer.measureElement}
					data-index={virtualRow.index}
				>
					{renderRow(lines[virtualRow.index])}
				</div>
			))}
		</div>
	);
}

export function ChatTranscript({
	lines,
	activeTabId,
	agentName,
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
	onOpenSource,
}: {
	lines: ChatLine[];
	activeTabId: string;
	agentName: string;
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
	/** Open a vault path / paper (or external URL) from Sources / inline citation. */
	onOpenSource?: (source: string) => void;
}) {
	const { t } = useTranslation("agent");

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
		onOpenSource,
		editCompositionProps,
	};
	const hasOpenSource = Boolean(onOpenSource);
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
		[hasOpenSource],
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
				{lines.length === 0 ? (
					<div className="flex w-full flex-col gap-8">
						<ConversationEmptyState
							title={t("empty.title")}
							description={t("empty.description")}
						>
							<div className="mt-4 flex w-full max-w-sm flex-col items-stretch gap-2">
								{activeTabIsRunning ? (
									<Shimmer className="text-center text-sm">
										{t("empty.waiting")}
									</Shimmer>
								) : (
									SUGGESTION_KEYS.map((key) => {
										const label = t(`suggestions.${key}`);
										return (
											<Suggestion
												key={key}
												suggestion={label}
												className="h-auto w-full justify-start whitespace-normal rounded-lg px-3 py-2.5 text-left"
												onClick={(v) =>
													onSendSuggestion(v, SUGGESTION_WORKFLOW[key])
												}
												disabled={activeTabIsRunning}
											/>
										);
									})
								)}
							</div>
						</ConversationEmptyState>
					</div>
				) : (
					<TranscriptBody
						lines={lines}
						activeTabId={activeTabId}
						agentName={agentName}
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
					/>
				)}
			</ConversationContent>
			<ConversationScrollButton />
		</Conversation>
	);
}
