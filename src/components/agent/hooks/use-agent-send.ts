/**
 * Agent turn submission pipeline: the send() turn flow (prompt assembly,
 * runOnce, visual-trace / ask-thread binding, deferred-event replay), the
 * follow-up waitlist + drain, external turns from the PDF pin modal, and
 * cancel / tool-ask answer paths.
 */
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type {
	AgentPanelRefs,
	AgentPanelT,
} from "@/components/agent/hooks/use-agent-panel-context";
import type { QueuedPrompt } from "@/components/agent/types";
import {
	type AgentListResponse,
	type AgentModeChoice,
	type AgentPlanEvent,
	type AgentResultPayload,
	type AgentStreamEvent,
	type AgentToolEvent,
	cancelAgentRun,
	ensureCatalogAgent,
	loadModelPref,
	type PromptImage,
	runOnce,
} from "@/lib/agent";
import {
	type AgentSessionRecord,
	type AgentTurnRequest,
	agentSessionStore,
} from "@/lib/agent/agent-session-store";
import {
	type AgentOption,
	applyToolToLines,
	type ChatLine,
	type ChatSessionHistoryItem,
	errorChatLine,
	errorText,
	type ToolAskUserRequest,
	upsertChatSessionTurn,
} from "@/lib/agent/chat-state";
import type { AgentComposerState } from "@/lib/agent/composer-state";
import {
	consumeSelections,
	currentSelections,
	type SelectionContext,
} from "@/lib/agent/selection-store";
import type { AcpCommand } from "@/lib/agent/slash-commands";
import { assembleTurnPrompt } from "@/lib/agent/turn-prompt";
import {
	consumeVisualDrafts,
	currentVisualDrafts,
	type PdfVisualDraft,
} from "@/lib/agent/visual-context-store";
import { isTauri } from "@/lib/core/tauri";
import {
	bindVisualTracesForTurn,
	isVisualTraceHistoryId,
	visualTraceHistoryId,
} from "@/lib/pdf/agent-trace";
import { bindAskThreadsForTurn } from "@/lib/pdf/ask";
import { nextLineId } from "@/lib/pdf-visual/ids";
import { loadSettings } from "@/lib/settings";

export type SendOptions = {
	baseLines?: ChatLine[];
	workflow?: string;
	/** Frozen context from a waitlisted follow-up (else live composer). */
	contextPaths?: string[];
	skillIds?: string[];
	/** Frozen selection chips from a waitlisted follow-up (else live store). */
	selections?: SelectionContext[];
	/** Frozen visual PDF annotation drafts (else live store). */
	visualDrafts?: PdfVisualDraft[];
	/** Composer image attachments (paste / file pick), frozen or live. */
	images?: PromptImage[];
	/**
	 * Explicit pin binding for follow-ups (pin modal continue). Preferred
	 * over reading sessionHistoryRef which may lag store upserts.
	 */
	visualTraceId?: string;
	paperAbsPath?: string;
	/**
	 * Start a brand-new product + ACP session (Cmd+Enter new pin).
	 * Ignores the Agent panel's currently open conversation / provider id
	 * so we never inherit sidebar transcript or session/load into a new mark.
	 */
	forceNewSession?: boolean;
	/** When true, do not wipe the live composer (already cleared on enqueue). */
	fromQueue?: boolean;
	/**
	 * Force this agent for the turn (e.g. visual pin continue bound to mark
	 * session). Overrides the switcher selection so setState races cannot
	 * send with the wrong provider.
	 */
	agentId?: string;
	/** Optional model for forced agentId; else loadModelPref(agentId). */
	modelId?: string;
};

export type UseAgentSendOptions = {
	refs: Pick<
		AgentPanelRefs,
		| "activeConversationRef"
		| "activeTabRef"
		| "knownSessionIdsRef"
		| "pendingSessionEventsRef"
		| "pendingSubmissionSessionIdRef"
		| "pendingTerminalEventsRef"
		| "promptHistoryAppliedRef"
		| "promptHistoryDraftRef"
		| "promptHistoryIndexRef"
		| "selectedAgentIdRef"
		| "sessionContextGenRef"
		| "sessionHistoryRef"
		| "submissionGenRef"
		| "submittingRef"
		| "switchingRef"
		| "vaultPathRef"
	>;
	t: AgentPanelT;
	i18nLanguage: string;
	vaultPath: string | null;
	lines: ChatLine[];
	setLines: (update: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => void;
	setSessionHistory: (
		update:
			| AgentSessionRecord[]
			| ((prev: AgentSessionRecord[]) => AgentSessionRecord[]),
	) => void;
	setActiveTabId: (id: string) => void;
	activeTabId: string;
	activeTabIsRunning: boolean;
	submitting: boolean;
	switching: boolean;
	setSubmitting: Dispatch<SetStateAction<boolean>>;
	setStoreSubmitting: (v: boolean) => void;
	setHistoryOpen: Dispatch<SetStateAction<boolean>>;
	setSelectedAgentId: Dispatch<SetStateAction<string | null>>;
	selected: AgentOption | undefined;
	registry: AgentListResponse | null;
	refresh: () => Promise<void>;
	modelId: string | null;
	collaborationModeId: string | null;
	collaborationOptions: AgentModeChoice[];
	reasoningEffort: string | null;
	fastAvailable: boolean;
	fastEnabled: boolean;
	acpCommandsByAgent: Record<string, AcpCommand[]>;
	contextPaths: string[];
	selectedVaultPath: string | null;
	snapshotComposerState: () => AgentComposerState;
	completeComposerSubmission: (
		sessionId: string,
		submitted: AgentComposerState,
	) => void;
	setComposerText: Dispatch<SetStateAction<string>>;
	setMentionedPaths: Dispatch<SetStateAction<string[]>>;
	setSelectedSkillIds: Dispatch<SetStateAction<string[]>>;
	activateComposerSession: (sessionId: string) => void;
	applyStreamEvent: (ev: AgentStreamEvent) => void;
	applyToolEvent: (ev: AgentToolEvent) => void;
	applyPlanEvent: (ev: AgentPlanEvent) => void;
	completeSession: (ev: AgentResultPayload) => void;
	failSession: (sessionId: string, error: string) => void;
	setToolAskUserRequest: Dispatch<SetStateAction<ToolAskUserRequest | null>>;
};

export type AgentSend = {
	send: (text: string, options?: SendOptions) => Promise<boolean>;
	submitComposer: (
		text: string,
		workflow?: string,
		images?: PromptImage[],
	) => Promise<boolean>;
	messageQueue: QueuedPrompt[];
	removeQueuedMessage: (id: string) => void;
	clearMessageQueue: () => void;
	cancelCurrentRun: () => Promise<void>;
	answerToolAskUser: (answer: string, toolCallId: string) => Promise<boolean>;
};

export function useAgentSend({
	refs: {
		activeConversationRef,
		activeTabRef,
		knownSessionIdsRef,
		pendingSessionEventsRef,
		pendingSubmissionSessionIdRef,
		pendingTerminalEventsRef,
		promptHistoryAppliedRef,
		promptHistoryDraftRef,
		promptHistoryIndexRef,
		selectedAgentIdRef,
		sessionContextGenRef,
		sessionHistoryRef,
		submissionGenRef,
		submittingRef,
		switchingRef,
		vaultPathRef,
	},
	t,
	i18nLanguage,
	vaultPath,
	lines,
	setLines,
	setSessionHistory,
	setActiveTabId,
	activeTabId,
	activeTabIsRunning,
	submitting,
	switching,
	setSubmitting,
	setStoreSubmitting,
	setHistoryOpen,
	setSelectedAgentId,
	selected,
	registry,
	refresh,
	modelId,
	collaborationModeId,
	collaborationOptions,
	reasoningEffort,
	fastAvailable,
	fastEnabled,
	acpCommandsByAgent,
	contextPaths,
	selectedVaultPath,
	snapshotComposerState,
	completeComposerSubmission,
	setComposerText,
	setMentionedPaths,
	setSelectedSkillIds,
	activateComposerSession,
	applyStreamEvent,
	applyToolEvent,
	applyPlanEvent,
	completeSession,
	failSession,
	setToolAskUserRequest,
}: UseAgentSendOptions): AgentSend {
	/** Follow-ups typed while the active session is still running. */
	const [messageQueue, setMessageQueue] = useState<QueuedPrompt[]>([]);
	/** Prevents overlapping drain of the follow-up waitlist. */
	const drainInFlightRef = useRef(false);
	const messageQueueRef = useRef<QueuedPrompt[]>([]);

	useEffect(() => {
		messageQueueRef.current = messageQueue;
	}, [messageQueue]);

	const clearMessageQueue = useCallback(() => {
		messageQueueRef.current = [];
		setMessageQueue([]);
		drainInFlightRef.current = false;
	}, []);

	const send = async (
		textRaw: string,
		options?: SendOptions,
	): Promise<boolean> => {
		const text = textRaw.trim();
		const resolvedVisualDrafts = options?.visualDrafts ?? currentVisualDrafts();
		const hasVisualDrafts = resolvedVisualDrafts.length > 0;
		const attachedImages = (options?.images ?? []).filter(
			(img) => img.data.trim().length > 0,
		);
		const hasAttachedImages = attachedImages.length > 0;
		if (
			(!text && !hasVisualDrafts && !hasAttachedImages) ||
			activeTabIsRunning ||
			switchingRef.current ||
			submittingRef.current
		)
			return false;
		const fromQueue = options?.fromQueue === true;
		const snap = snapshotComposerState();
		const submittedComposerState = fromQueue
			? {
					text: textRaw,
					mentionedPaths: [],
					selectedSkillIds: options?.skillIds ?? [],
					includeSelectedFile: snap.includeSelectedFile,
				}
			: {
					...snap,
					text: textRaw,
				};
		const resolvedContextPaths = options?.contextPaths ?? contextPaths;
		const resolvedSelections = options?.selections ?? currentSelections();
		const resolvedSkillIds =
			options?.skillIds ?? submittedComposerState.selectedSkillIds;
		const submissionGeneration = ++submissionGenRef.current;
		const sessionContextGeneration = sessionContextGenRef.current;
		const requestVaultPath = vaultPath;
		submittingRef.current = true;
		setSubmitting(true);
		setStoreSubmitting(true);
		try {
			if (!isTauri()) {
				setLines((p) => [...p, errorChatLine(t("messages.desktopOnly"))]);
				return false;
			}

			const forceNewSessionEarly = options?.forceNewSession === true;
			const activeHistoryForAgent = forceNewSessionEarly
				? undefined
				: sessionHistoryRef.current.find(
						(item) => item.id === activeTabRef.current,
					);
			// Priority: explicit option → continuing session's agent → switcher → default.
			// Prevents pin-modal continue from loading Codex session with Grok (pdfAsk default).
			// forceNewSession (Cmd+Enter new pin) never inherits the open panel agent.
			let agentId =
				options?.agentId?.trim() ||
				(activeHistoryForAgent?.providerSessionId &&
				activeHistoryForAgent.agentId
					? activeHistoryForAgent.agentId
					: null) ||
				selected?.id ||
				registry?.defaultId ||
				null;
			if (!agentId && selected?.templateId) {
				try {
					const agent = await ensureCatalogAgent(selected.templateId, true);
					agentId = agent.id;
					setSelectedAgentId(agentId);
					await refresh();
				} catch (e) {
					setLines((p) => [...p, errorChatLine(errorText(e))]);
					return false;
				}
			}

			if (!agentId) {
				setLines((p) => [
					...p,
					{
						id: nextLineId("sys"),
						kind: "system",
						text: t("messages.noAgent"),
					},
				]);
				return false;
			}
			// Keep switcher/ref in sync when the turn forces another agent.
			if (agentId !== selectedAgentIdRef.current) {
				selectedAgentIdRef.current = agentId;
				setSelectedAgentId(agentId);
			}
			const resolvedModelId =
				options?.modelId?.trim() ||
				(agentId === selected?.id ? modelId : null) ||
				loadModelPref(agentId) ||
				undefined;

			// Options are availability-filtered in buildOptions; unavailable agents
			// never appear in the switcher.
			const isAcpCommand = (acpCommandsByAgent[agentId] ?? []).some(
				(command) =>
					text === `/${command.name}` || text.startsWith(`/${command.name} `),
			);
			if (forceNewSessionEarly) {
				// Drop any panel-level continue target before resolving resume.
				activeConversationRef.current = null;
			}
			const activeHistory = forceNewSessionEarly
				? undefined
				: sessionHistoryRef.current.find(
						(item) => item.id === activeTabRef.current,
					);
			// Continue when we have a durable provider session id. Host picks
			// session/resume vs session/load from agent capabilities (Grok: load).
			const providerContinueId = forceNewSessionEarly
				? null
				: activeConversationRef.current?.trim() ||
					activeHistory?.providerSessionId?.trim() ||
					null;
			const resumeAllowed =
				Boolean(providerContinueId) && activeHistory?.resumeable !== false;
			// Prefer explicit baseLines (external turn handler) — React `lines`
			// can still be the previous panel session when setLines([]) has not
			// flushed (Cmd+Enter inheritance bug).
			const priorLines = forceNewSessionEarly
				? (options?.baseLines ?? [])
				: (options?.baseLines ?? lines);
			const { prompt, images, visualAnnotations, historyTitle } =
				assembleTurnPrompt({
					text,
					contextPaths: resolvedContextPaths,
					selections: resolvedSelections,
					visualDrafts: resolvedVisualDrafts,
					attachedImages,
					isAcpCommand,
					t,
				});
			// Workflow suggestions act on the focused paper / mentioned paths so
			// “Summarize” targets the open paper even without an explicit @mention.
			const workflow = isAcpCommand ? undefined : options?.workflow;
			const workflowTarget = workflow
				? (resolvedContextPaths[0] ?? selectedVaultPath ?? undefined)
				: resolvedContextPaths[0];
			const userLine: ChatLine = {
				id: nextLineId("user"),
				kind: "user",
				text,
				...(visualAnnotations?.length ? { visualAnnotations } : {}),
				...(attachedImages.length ? { images: attachedImages } : {}),
			};
			const sessionStartLines = [...priorLines, userLine];
			setLines(sessionStartLines);
			const resumeSessionId = resumeAllowed
				? (providerContinueId ?? undefined)
				: undefined;
			// Terminal/stream events are correlated by the fresh Agentero runtime
			// id, not the provider id used to resume ACP. Keep this empty until the
			// host accepts the request, then bind it to accepted.sessionId below.
			pendingSubmissionSessionIdRef.current = null;
			const accepted = await runOnce({
				agentId,
				sessionId: resumeSessionId,
				prompt,
				isAcpCommand,
				images,
				vaultPath: vaultPath ?? undefined,
				workflow: workflow ?? "free",
				target: workflowTarget,
				modelId: resolvedModelId,
				collaborationModeId:
					collaborationModeId &&
					collaborationOptions.some((mode) => mode.id === collaborationModeId)
						? collaborationModeId
						: undefined,
				reasoningEffort: reasoningEffort ?? undefined,
				fastMode: fastAvailable ? fastEnabled : undefined,
				skillIds: resolvedSkillIds,
				autoApprove: loadSettings().agentPermissionMode === "auto",
				permissionMode: loadSettings().agentPermissionMode,
			});
			if (
				sessionContextGeneration !== sessionContextGenRef.current ||
				requestVaultPath !== vaultPathRef.current
			) {
				pendingTerminalEventsRef.current.delete(accepted.sessionId);
				pendingSessionEventsRef.current.delete(accepted.sessionId);
				void cancelAgentRun(accepted.sessionId).catch(() => undefined);
				return false;
			}
			knownSessionIdsRef.current.add(accepted.sessionId);
			pendingSubmissionSessionIdRef.current = accepted.sessionId;
			// Bind disk finalizers for this runtime session:
			// - first turn with visualDrafts → create mark files
			// - follow-up on a bound pin (no new drafts) → re-register pending
			//   so complete/fail still patches marks/<id>.json
			const historyVisualTraceId =
				activeHistory && "visualTraceId" in activeHistory
					? (activeHistory as { visualTraceId?: string }).visualTraceId
					: undefined;
			const historyPaperAbs =
				activeHistory && "paperAbsPath" in activeHistory
					? (activeHistory as { paperAbsPath?: string }).paperAbsPath
					: undefined;
			const continueVisualTraceId = !hasVisualDrafts
				? options?.visualTraceId?.trim() ||
					historyVisualTraceId?.trim() ||
					undefined
				: undefined;
			const continuePaperAbs = !hasVisualDrafts
				? options?.paperAbsPath?.trim() || historyPaperAbs?.trim() || undefined
				: undefined;
			await bindVisualTracesForTurn({
				runtimeSessionId: accepted.sessionId,
				messageId: accepted.messageId,
				agentId,
				vaultPath,
				userText: text,
				visualDrafts: resolvedVisualDrafts,
				continueVisualTraceId,
				continuePaperAbs,
			});
			await bindAskThreadsForTurn({
				runtimeSessionId: accepted.sessionId,
				userText: text,
				selections: resolvedSelections,
				isAcpCommand,
			});
			// A submitted turn consumes its selection chips (queued turns already did).
			if (!options?.selections) consumeSelections();
			if (!options?.visualDrafts) consumeVisualDrafts();
			const pendingTerminal = pendingTerminalEventsRef.current.get(
				accepted.sessionId,
			);
			pendingTerminalEventsRef.current.delete(accepted.sessionId);
			const pendingSessionEvents =
				pendingSessionEventsRef.current.get(accepted.sessionId) ?? [];
			pendingSessionEventsRef.current.delete(accepted.sessionId);
			const agentLine: ChatLine = {
				id: nextLineId("agent"),
				kind: "agent",
				parts: [],
				streaming: true,
			};
			// Clone so history entry and active view never share array/object identity
			// (prevents cross-session stream updates mutating the wrong transcript).
			const pendingLines: ChatLine[] = [...sessionStartLines, agentLine];
			const historyLines: ChatLine[] = pendingLines.map((line) => {
				if (line.kind === "agent") {
					return { ...line, parts: [...line.parts] };
				}
				return { ...line };
			});
			completeComposerSubmission(accepted.sessionId, submittedComposerState);
			// Runtime session id is the stream correlation key; durable continue
			// uses providerSessionId set on agent:completed (via session/load|resume).
			activeTabRef.current = accepted.sessionId;
			setActiveTabId(accepted.sessionId);
			knownSessionIdsRef.current.add(accepted.sessionId);
			const boundVisualTraceId =
				options?.visualTraceId?.trim() ||
				historyVisualTraceId ||
				resolvedVisualDrafts[0]?.id;
			const boundPaperAbs =
				options?.paperAbsPath?.trim() ||
				historyPaperAbs ||
				resolvedVisualDrafts[0]?.paperAbsPath;
			const nextHistoryItem: ChatSessionHistoryItem = {
				id: accepted.sessionId,
				agentId,
				source: "local",
				title: activeHistory?.title || historyTitle || t("defaultName"),
				agentName: selected?.name ?? t("defaultName"),
				startedAt:
					activeHistory?.startedAt || new Date().toLocaleString(i18nLanguage),
				lines: historyLines,
				status: "running",
				// Carry over pin session provider id until completed event.
				providerSessionId: activeHistory?.providerSessionId ?? null,
				resumeable: true,
				...(boundVisualTraceId ? { visualTraceId: boundVisualTraceId } : {}),
				...(boundPaperAbs ? { paperAbsPath: boundPaperAbs } : {}),
			};
			setSessionHistory((prev) =>
				upsertChatSessionTurn(
					// Drop superseded visual-trace placeholders before applying the
					// provider-id based conversation merge.
					prev.filter(
						(item) =>
							!(
								activeHistory &&
								isVisualTraceHistoryId(activeHistory.id) &&
								item.id === activeHistory.id
							) &&
							!(
								boundVisualTraceId &&
								"visualTraceId" in item &&
								(item as { visualTraceId?: string }).visualTraceId ===
									boundVisualTraceId &&
								item.id !== accepted.sessionId
							),
					),
					nextHistoryItem,
					activeHistory,
				),
			);
			setLines(pendingLines);
			for (const pendingEvent of pendingSessionEvents) {
				if (pendingEvent.kind === "stream") {
					applyStreamEvent(pendingEvent.event);
				} else if (pendingEvent.kind === "tool") {
					applyToolEvent(pendingEvent.event);
				} else {
					applyPlanEvent(pendingEvent.event);
				}
			}
			if (pendingTerminal?.kind === "completed") {
				completeSession(pendingTerminal.event);
			} else if (pendingTerminal?.kind === "failed") {
				failSession(accepted.sessionId, pendingTerminal.error);
			}
			return pendingTerminal?.kind !== "failed";
		} catch (e) {
			if (
				sessionContextGeneration === sessionContextGenRef.current &&
				requestVaultPath === vaultPathRef.current
			) {
				setLines((p) => [...p, errorChatLine(errorText(e))]);
			}
			return false;
		} finally {
			if (submissionGeneration === submissionGenRef.current) {
				pendingSubmissionSessionIdRef.current = null;
				submittingRef.current = false;
				setSubmitting(false);
				setStoreSubmitting(false);
			}
		}
	};

	const enqueueMessage = useCallback(
		(textRaw: string, workflow?: string, images?: PromptImage[]): boolean => {
			const text = textRaw.trim();
			const liveVisualDrafts = currentVisualDrafts();
			const attached = (images ?? []).filter((img) => img.data.trim().length);
			if (
				(!text && !liveVisualDrafts.length && !attached.length) ||
				switchingRef.current
			) {
				return false;
			}
			const snap = snapshotComposerState();
			const paths = [
				...(snap.includeSelectedFile && selectedVaultPath
					? [selectedVaultPath]
					: []),
				...snap.mentionedPaths,
			];
			const frozenVisualDrafts = consumeVisualDrafts();
			const item: QueuedPrompt = {
				id: nextLineId("queue"),
				// Keep the typed text only; visual drafts / images carry their payload.
				text,
				workflow,
				contextPaths: paths,
				skillIds: [...snap.selectedSkillIds],
				selections: consumeSelections(),
				visualDrafts: frozenVisualDrafts,
				...(attached.length ? { images: attached } : {}),
			};
			setMessageQueue((prev) => {
				const next = [...prev, item];
				messageQueueRef.current = next;
				return next;
			});
			// Mirror post-submit composer cleanup for the queued turn.
			setComposerText((current) => (current === textRaw ? "" : current));
			setSelectedSkillIds((prev) =>
				prev.filter((id) => !snap.selectedSkillIds.includes(id)),
			);
			setMentionedPaths((prev) =>
				prev.filter((path) => !snap.mentionedPaths.includes(path)),
			);
			return true;
		},
		[
			selectedVaultPath,
			setComposerText,
			setMentionedPaths,
			setSelectedSkillIds,
			snapshotComposerState,
			switchingRef,
		],
	);

	const resetPromptHistoryBrowse = useCallback(() => {
		promptHistoryIndexRef.current = null;
		promptHistoryDraftRef.current = "";
		promptHistoryAppliedRef.current = null;
	}, [promptHistoryAppliedRef, promptHistoryDraftRef, promptHistoryIndexRef]);

	/** Submit now, or append to the waitlist when the active run is still open. */
	const submitComposer = async (
		textRaw: string,
		workflow?: string,
		images?: PromptImage[],
	): Promise<boolean> => {
		if (switchingRef.current || submittingRef.current) return false;
		resetPromptHistoryBrowse();
		if (activeTabIsRunning) {
			return enqueueMessage(textRaw, workflow, images);
		}
		return send(textRaw, { workflow, images });
	};

	/**
	 * Answer a tool-shaped ask-user form (OpenCode `question`, Claude AskUserQuestion, …).
	 *
	 * The agent turn is usually still `running` (blocked on the tool). Normal
	 * composer submit would only enqueue and never drain until the run ends —
	 * a deadlock. Cancel the stuck turn so the answer can send immediately
	 * (same net effect as enqueue + stop, without the extra click).
	 * Grok ext / elicitation use dedicated respond paths and do not need this.
	 */
	const answerToolAskUser = async (
		answer: string,
		toolCallId: string,
	): Promise<boolean> => {
		if (switchingRef.current || submittingRef.current) return false;
		resetPromptHistoryBrowse();
		const text = answer.trim();
		if (!text) return false;

		const completedLines = applyToolToLines(lines, {
			id: toolCallId,
			status: "completed",
		});

		if (!activeTabIsRunning) {
			setLines(completedLines);
			setToolAskUserRequest(null);
			return send(text, { baseLines: completedLines });
		}

		// Queue first so cancel → idle drains it; then free the blocked run.
		const enqueued = enqueueMessage(text);
		if (!enqueued) return false;
		setLines(completedLines);
		setToolAskUserRequest(null);
		const sessionId = activeTabId;
		if (!sessionId || !isTauri()) return true;
		try {
			await cancelAgentRun(sessionId);
		} catch (error) {
			// Leave the queued answer; user can still stop the run manually.
			setLines((prev) => [...prev, errorChatLine(errorText(error))]);
		}
		return true;
	};

	const removeQueuedMessage = useCallback((id: string) => {
		setMessageQueue((prev) => {
			const next = prev.filter((item) => item.id !== id);
			messageQueueRef.current = next;
			return next;
		});
	}, []);

	const sendRef = useRef(send);
	sendRef.current = send;

	// PDF pin modal submits through the same send pipeline. Keep handler in a
	// ref so we only register once (avoids store setState on every render).
	const externalTurnCtxRef = useRef({
		activateComposerSession,
		t,
		i18nLanguage,
		agentName: selected?.name as string | undefined,
	});
	externalTurnCtxRef.current = {
		activateComposerSession,
		t,
		i18nLanguage,
		agentName: selected?.name,
	};

	useEffect(() => {
		const handler = async (req: AgentTurnRequest): Promise<boolean> => {
			const ctx = externalTurnCtxRef.current;
			const store = agentSessionStore.getState();
			let existing = req.visualTraceId
				? store.findByVisualTraceId(req.visualTraceId)
				: undefined;
			if (!existing && req.providerSessionId) {
				existing = store.findByProviderSessionId(req.providerSessionId);
			}
			// Continue: session/mark agent wins. New: req.agentId (pdfAsk default).
			const boundAgentId =
				req.agentId?.trim() ||
				existing?.agentId?.trim() ||
				selectedAgentIdRef.current ||
				null;
			if (boundAgentId && boundAgentId !== selectedAgentIdRef.current) {
				selectedAgentIdRef.current = boundAgentId;
				setSelectedAgentId(boundAgentId);
			}
			// Transcript + resume target must be decided here and passed into
			// send via options — setLines/setActiveTabId are async and send
			// would otherwise inherit the sidebar's open conversation.
			let baseLines: ChatLine[] = [];
			let forceNewSession = false;
			if (existing) {
				// Ensure pin binding fields survive even if the live session row
				// was created before paperAbsPath was stored.
				const needsBind =
					(req.visualTraceId && existing.visualTraceId !== req.visualTraceId) ||
					(req.paperAbsPath && existing.paperAbsPath !== req.paperAbsPath) ||
					(req.providerSessionId &&
						existing.providerSessionId !== req.providerSessionId);
				const bound = needsBind
					? {
							...existing,
							...(req.visualTraceId
								? { visualTraceId: req.visualTraceId }
								: {}),
							...(req.paperAbsPath ? { paperAbsPath: req.paperAbsPath } : {}),
							...(req.providerSessionId
								? { providerSessionId: req.providerSessionId }
								: {}),
						}
					: existing;
				if (needsBind) {
					store.upsertSession(bound, { activate: true });
				}
				ctx.activateComposerSession(bound.id);
				setActiveTabId(bound.id);
				setLines(bound.lines);
				activeTabRef.current = bound.id;
				baseLines = bound.lines;
				if (bound.providerSessionId || req.providerSessionId) {
					activeConversationRef.current =
						bound.providerSessionId ?? req.providerSessionId ?? null;
				}
			} else if (req.seedLines?.length && req.visualTraceId) {
				const seeded = {
					id: visualTraceHistoryId(req.visualTraceId),
					agentId: boundAgentId || selectedAgentIdRef.current || "agent",
					source: "local" as const,
					title: req.title?.trim() || ctx.t("composer.visualAnnotation"),
					agentName: ctx.agentName ?? ctx.t("defaultName"),
					startedAt: new Date().toLocaleString(ctx.i18nLanguage),
					lines: req.seedLines,
					status: "completed" as const,
					providerSessionId: req.providerSessionId ?? null,
					resumeable: true,
					visualTraceId: req.visualTraceId,
					paperAbsPath: req.paperAbsPath,
				};
				store.upsertSession(seeded, { activate: true });
				ctx.activateComposerSession(seeded.id);
				activeTabRef.current = seeded.id;
				baseLines = req.seedLines;
				if (req.providerSessionId) {
					activeConversationRef.current = req.providerSessionId;
				}
			} else {
				// New pin (Cmd+Enter) or external turn without prior session:
				// never inherit the Agent panel's open Codex/Grok conversation.
				forceNewSession = true;
				setActiveTabId("draft");
				activeTabRef.current = "draft";
				setLines([]);
				ctx.activateComposerSession("draft");
				activeConversationRef.current = null;
				baseLines = [];
			}
			setHistoryOpen(false);
			// Keep ref in sync before send (upsert may not have flushed React yet).
			sessionHistoryRef.current = agentSessionStore.getState().sessions;
			return sendRef.current(req.text, {
				visualDrafts: req.visualDrafts,
				images: req.images,
				fromQueue: true,
				baseLines,
				forceNewSession,
				...(req.visualTraceId ? { visualTraceId: req.visualTraceId } : {}),
				...(req.paperAbsPath ? { paperAbsPath: req.paperAbsPath } : {}),
				...(boundAgentId ? { agentId: boundAgentId } : {}),
				...(req.modelId ? { modelId: req.modelId } : {}),
			});
		};
		agentSessionStore.getState().registerSendHandler(handler);
		return () => {
			agentSessionStore.getState().registerSendHandler(null);
		};
		// Register once — handler reads sendRef / externalTurnCtxRef for latest.
		// Stable store setters only; handler body uses refs for everything else.
	}, [
		setActiveTabId,
		setLines,
		setHistoryOpen,
		setSelectedAgentId,
		activeConversationRef,
		activeTabRef,
		selectedAgentIdRef,
		sessionHistoryRef,
	]);

	// Drain waitlist once the active session is idle again.
	useEffect(() => {
		if (activeTabIsRunning || submitting || switching) return;
		if (messageQueue.length === 0) return;
		if (drainInFlightRef.current) return;

		const head = messageQueue[0];
		if (!head) return;
		drainInFlightRef.current = true;
		setMessageQueue((prev) => {
			const next = prev.filter((item) => item.id !== head.id);
			messageQueueRef.current = next;
			return next;
		});

		void (async () => {
			try {
				await sendRef.current(head.text, {
					workflow: head.workflow,
					contextPaths: head.contextPaths,
					skillIds: head.skillIds,
					selections: head.selections,
					visualDrafts: head.visualDrafts,
					images: head.images,
					fromQueue: true,
				});
			} finally {
				drainInFlightRef.current = false;
			}
		})();
	}, [activeTabIsRunning, submitting, switching, messageQueue]);

	const cancelCurrentRun = async () => {
		const sessionId = activeTabIsRunning ? activeTabId : null;
		if (!sessionId || !isTauri()) return;
		try {
			await cancelAgentRun(sessionId);
			// Drop promoted tool-ask form for this turn.
			setToolAskUserRequest((prev) =>
				prev?.sessionId === sessionId ? null : prev,
			);
		} catch (error) {
			setLines((prev) => [...prev, errorChatLine(errorText(error))]);
		}
	};

	return {
		send,
		submitComposer,
		messageQueue,
		removeQueuedMessage,
		clearMessageQueue,
		cancelCurrentRun,
		answerToolAskUser,
	};
}
