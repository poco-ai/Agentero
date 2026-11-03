/**
 * Agent turn submission pipeline: the send() turn flow (prompt assembly,
 * runOnce, visual-trace / ask-thread binding, deferred-event replay), the
 * follow-up waitlist + drain, external turns from the PDF pin modal, and
 * cancel / tool-ask answer paths.
 *
 * The turn flow is split into named phases (resolve agent → resume target →
 * prompt assembly → run → bind artifacts → commit history → replay events);
 * store-derived values (transcript, history, active tab) are read straight
 * from the agent session store instead of being mirrored through props.
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
import type { AgentSessionRuntime } from "@/components/agent/hooks/use-agent-session-runtime";
import type { QueuedPrompt } from "@/components/agent/types";
import type { SessionComposerStateApi } from "@/hooks/use-session-composer-state";
import { formatLocaleTimestamp } from "@/i18n";
import {
	type AgentListResponse,
	type AgentModeChoice,
	agentTemplateById,
	cancelAgentRun,
	ensureCatalogAgent,
	isChatOnlyAgentTemplate,
	loadModelPref,
	loadReasoningEffortPref,
	type PromptImage,
	runOnce,
} from "@/lib/agent";
import {
	type AgentTurnRequest,
	agentSessionStore,
	isActiveTabRunning,
	useAgentSessionStore,
} from "@/lib/agent/agent-session-store";
import {
	planAnnotationRefs,
	visualDraftsInAnnotationOrder,
} from "@/lib/agent/annotation-prompt";
import {
	type AgentOption,
	type AskUserAnswer,
	type AskUserQuestion,
	applyToolToLines,
	buildLocalTranscriptPrompt,
	type ChatLine,
	type ChatSessionHistoryItem,
	errorChatLine,
	errorText,
	type PendingSessionEvent,
	type PendingTerminalEvent,
	shouldAttachLocalTranscript,
	upsertChatSessionTurn,
} from "@/lib/agent/chat-state";
import {
	extractSelectionTokens,
	extractVisualIds,
	stripInlineTokens,
} from "@/lib/agent/composer-inline-tokens";
import type { AgentComposerState } from "@/lib/agent/composer-state";
import { sidebarContextRequest } from "@/lib/agent/context-request";
import {
	isPlazaMentionPath,
	parseNeedFulltextIds,
	plazaMentionPathForArxivId,
} from "@/lib/agent/plaza-mention";
import { preparePlazaScratch } from "@/lib/agent/plaza-scratch";
import {
	consumeSelections,
	currentSelections,
	type SelectionContext,
} from "@/lib/agent/selection-store";
import type { AcpCommand } from "@/lib/agent/slash-commands";
import { assembleTurnPrompt } from "@/lib/agent/turn-prompt";
import {
	activeVisualDraftSessionKey,
	type PdfVisualDraft,
	takeVisualDrafts,
	visualDraftsForSession,
} from "@/lib/agent/visual-context-store";
import { isTauri } from "@/lib/core/tauri";
import type { PaperMetadata } from "@/lib/paper";
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

/** Request-shaping context for a turn: agent / model / effort / fast selection. */
export type AgentTurnConfig = {
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
	/** Render-time transcript snapshot used as the base for the next turn. */
	lines: ChatLine[];
	submitting: boolean;
	switching: boolean;
	/** Sole writer for the submitting flag (ref + render state in lockstep). */
	setSubmittingFlag: (value: boolean) => void;
	setHistoryOpen: Dispatch<SetStateAction<boolean>>;
	setSelectedAgentId: Dispatch<SetStateAction<string | null>>;
	selectedVaultPath: string | null;
	/** Catalog metadata for the focused paper (chat-only agent context). */
	selectedPaperMeta: PaperMetadata | null;
	contextPaths: string[];
	/** Live composer state plus the session-scoped persistence API. */
	composer: SessionComposerStateApi;
	turnConfig: AgentTurnConfig;
	/** Session runtime event appliers + completion handlers. */
	runtime: AgentSessionRuntime;
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
	answerToolAskUser: (input: {
		answer: string;
		toolCallId: string;
		questions: AskUserQuestion[];
		answers: AskUserAnswer[];
	}) => Promise<boolean>;
	recordAskUserAnswers: (input: {
		sessionId: string;
		toolCallId: string | null | undefined;
		questions: AskUserQuestion[];
		answers?: AskUserAnswer[];
		cancelled?: boolean;
	}) => void;
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
	submitting,
	switching,
	setSubmittingFlag,
	setHistoryOpen,
	setSelectedAgentId,
	selectedVaultPath,
	selectedPaperMeta,
	contextPaths,
	composer: {
		snapshot: snapshotComposerState,
		completeSubmission: completeComposerSubmission,
		setText: setComposerText,
		setMentionedPaths,
		setSelectedSkillIds,
		activateSession: activateComposerSession,
	},
	turnConfig: {
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
	},
	runtime: {
		applyStreamEvent,
		applyToolEvent,
		applyPlanEvent,
		completeSession,
		failSession,
		setToolAskUserRequest,
	},
}: UseAgentSendOptions): AgentSend {
	// Store-direct values (single source of truth for the transcript).
	const setLines = useAgentSessionStore((s) => s.setLines);
	const setSessionHistory = useAgentSessionStore((s) => s.setSessions);
	const setActiveTabId = useAgentSessionStore((s) => s.setActiveTabId);
	const activeTabId = useAgentSessionStore((s) => s.activeTabId);
	const activeTabIsRunning = useAgentSessionStore(isActiveTabRunning);

	/** Follow-ups typed while the active session is still running. */
	const [messageQueue, setMessageQueue] = useState<QueuedPrompt[]>([]);
	/** Prevents overlapping drain of the follow-up waitlist. */
	const drainInFlightRef = useRef(false);

	const clearMessageQueue = useCallback(() => {
		setMessageQueue([]);
		drainInFlightRef.current = false;
	}, []);

	// ---- Turn phases (closures over the options above) ---------------------

	/**
	 * Resolve the agent a turn runs on and its model prefs:
	 * explicit option → continuing session's agent → switcher → default →
	 * catalog fallback. Prevents pin-modal continue from loading a Codex
	 * session with Grok (pdfAsk default). forceNewSession (Cmd+Enter new
	 * pin) never inherits the open panel agent. Returns null after writing
	 * an error line.
	 */
	const resolveTurnAgentAndModel = async (
		options: SendOptions | undefined,
		forceNewSession: boolean,
	): Promise<{
		agentId: string;
		modelId: string | undefined;
		preferredEffort: string | null;
	} | null> => {
		const activeHistoryForAgent = forceNewSession
			? undefined
			: sessionHistoryRef.current.find(
					(item) => item.id === activeTabRef.current,
				);
		let agentId =
			options?.agentId?.trim() ||
			(activeHistoryForAgent?.providerSessionId && activeHistoryForAgent.agentId
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
				return null;
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
			return null;
		}
		// Keep switcher/ref in sync when the turn forces another agent.
		if (agentId !== selectedAgentIdRef.current) {
			selectedAgentIdRef.current = agentId;
			setSelectedAgentId(agentId);
		}
		return {
			agentId,
			modelId:
				options?.modelId?.trim() ||
				(agentId === selected?.id ? modelId : null) ||
				loadModelPref(agentId) ||
				undefined,
			preferredEffort: loadReasoningEffortPref(agentId),
		};
	};

	/**
	 * Where this turn continues (read-only): the continuing history row (if
	 * any), the durable provider session id to resume (host picks
	 * session/resume vs session/load from agent capabilities, e.g. Grok:
	 * load), and the transcript to build on. The caller drops the panel's
	 * continue target first when forceNewSession is set.
	 */
	const resolveResumeTarget = (
		options: SendOptions | undefined,
		forceNewSession: boolean,
	): {
		activeHistory: ChatSessionHistoryItem | undefined;
		providerContinueId: string | null;
		resumeAllowed: boolean;
		priorLines: ChatLine[];
	} => {
		const activeHistory = forceNewSession
			? undefined
			: sessionHistoryRef.current.find(
					(item) => item.id === activeTabRef.current,
				);
		const providerContinueId = forceNewSession
			? null
			: activeConversationRef.current?.trim() ||
				activeHistory?.providerSessionId?.trim() ||
				null;
		const resumeAllowed =
			Boolean(providerContinueId) && activeHistory?.resumeable !== false;
		// Prefer explicit baseLines (external turn handler) — React `lines`
		// can still be the previous panel session when setLines([]) has not
		// flushed (Cmd+Enter inheritance bug).
		const priorLines = forceNewSession
			? (options?.baseLines ?? [])
			: (options?.baseLines ?? lines);
		return { activeHistory, providerContinueId, resumeAllowed, priorLines };
	};

	/**
	 * Scratch full text for @-mentioned plaza papers: the host downloads +
	 * converts them outside the vault so the agent never imports papers
	 * just to read them. Best-effort; falls back to abstract-only context.
	 */
	const preparePlazaScratchFor = async (
		resolvedContextPaths: string[],
		isAcpCommand: boolean,
	): Promise<Map<string, string>> => {
		const plazaContextPaths = resolvedContextPaths.filter((path) =>
			isPlazaMentionPath(path),
		);
		if (plazaContextPaths.length === 0 || isAcpCommand) {
			return new Map<string, string>();
		}
		return preparePlazaScratch(plazaContextPaths);
	};

	/**
	 * Workflow suggestions act on the focused paper / mentioned paths so
	 * “Summarize” targets the open paper even without an explicit @mention.
	 * Plaza mentions are virtual refs, never workflow filesystem targets.
	 */
	const resolveWorkflowTarget = (
		resolvedContextPaths: string[],
		workflow: string | undefined,
	): string | undefined => {
		const workflowVaultTarget = resolvedContextPaths.find(
			(path) => !isPlazaMentionPath(path),
		);
		return workflow
			? (workflowVaultTarget ?? selectedVaultPath ?? undefined)
			: workflowVaultTarget;
	};

	/** Assemble and dispatch the runOnce request for a resolved turn. */
	const startTurn = (turn: {
		agentId: string;
		resumeSessionId: string | undefined;
		prompt: string;
		isAcpCommand: boolean;
		images: PromptImage[] | undefined;
		workflow: string | undefined;
		workflowTarget: string | undefined;
		modelId: string | undefined;
		preferredEffort: string | null;
		skillIds: string[];
		context: ReturnType<typeof sidebarContextRequest>;
		resumeTranscript?: string;
	}) =>
		runOnce({
			agentId: turn.agentId,
			sessionId: turn.resumeSessionId,
			prompt: turn.prompt,
			isAcpCommand: turn.isAcpCommand,
			images: turn.images,
			vaultPath: vaultPath ?? undefined,
			workflow: turn.workflow ?? "free",
			target: turn.workflowTarget,
			modelId: turn.modelId,
			collaborationModeId:
				collaborationModeId &&
				collaborationOptions.some((mode) => mode.id === collaborationModeId)
					? collaborationModeId
					: undefined,
			reasoningEffort:
				turn.preferredEffort === null
					? undefined
					: turn.agentId === selected?.id
						? (reasoningEffort ?? turn.preferredEffort)
						: turn.preferredEffort,
			preferHighestReasoningEffort: turn.preferredEffort === null,
			fastMode: fastAvailable ? fastEnabled : undefined,
			skillIds: turn.skillIds,
			permissionMode: loadSettings().agentPermissionMode,
			context: turn.context ?? undefined,
			resumeTranscript: turn.resumeTranscript,
		});

	/**
	 * Pin binding for a session opened from a visual mark. Composer reference
	 * crops are not a pin: they must not become this session's mark id.
	 */
	const visualTraceBinding = (
		activeHistory: ChatSessionHistoryItem | undefined,
		options: SendOptions | undefined,
	): {
		continueVisualTraceId: string | undefined;
		continuePaperAbs: string | undefined;
		boundVisualTraceId: string | undefined;
		boundPaperAbs: string | undefined;
	} => {
		const historyVisualTraceId =
			activeHistory && "visualTraceId" in activeHistory
				? (activeHistory as { visualTraceId?: string }).visualTraceId
				: undefined;
		const historyPaperAbs =
			activeHistory && "paperAbsPath" in activeHistory
				? (activeHistory as { paperAbsPath?: string }).paperAbsPath
				: undefined;
		const continueVisualTraceId =
			options?.visualTraceId?.trim() ||
			historyVisualTraceId?.trim() ||
			undefined;
		const continuePaperAbs =
			options?.paperAbsPath?.trim() || historyPaperAbs?.trim() || undefined;
		return {
			continueVisualTraceId,
			continuePaperAbs,
			boundVisualTraceId: continueVisualTraceId,
			boundPaperAbs: continuePaperAbs,
		};
	};

	/**
	 * Publish the accepted turn across the panel: agent placeholder line,
	 * composer session handoff, active-tab switch, and history upsert
	 * (dropping superseded visual-trace placeholders before the provider-id
	 * based conversation merge).
	 */
	const publishAcceptedTurn = (turn: {
		sessionId: string;
		agentId: string;
		activeHistory: ChatSessionHistoryItem | undefined;
		historyTitle: string | undefined;
		binding: ReturnType<typeof visualTraceBinding>;
		sessionStartLines: ChatLine[];
		submittedComposerState: AgentComposerState;
	}) => {
		const agentLine: ChatLine = {
			id: nextLineId("agent"),
			kind: "agent",
			parts: [],
			streaming: true,
		};
		// Clone so history entry and active view never share array/object identity
		// (prevents cross-session stream updates mutating the wrong transcript).
		const pendingLines: ChatLine[] = [...turn.sessionStartLines, agentLine];
		const historyLines: ChatLine[] = pendingLines.map((line) => {
			if (line.kind === "agent") {
				return { ...line, parts: [...line.parts] };
			}
			return { ...line };
		});
		completeComposerSubmission(turn.sessionId, turn.submittedComposerState);
		// Runtime session id is the stream correlation key; durable continue
		// uses providerSessionId set on agent:completed (via session/load|resume).
		activeTabRef.current = turn.sessionId;
		setActiveTabId(turn.sessionId);
		knownSessionIdsRef.current.add(turn.sessionId);
		const nextHistoryItem: ChatSessionHistoryItem = {
			id: turn.sessionId,
			agentId: turn.agentId,
			source: "local",
			title: turn.activeHistory?.title || turn.historyTitle || t("defaultName"),
			agentName: selected?.name ?? t("defaultName"),
			startedAt:
				turn.activeHistory?.startedAt ||
				formatLocaleTimestamp(new Date(), i18nLanguage),
			lines: historyLines,
			status: "running",
			// Carry over pin session provider id until completed event.
			providerSessionId: turn.activeHistory?.providerSessionId ?? null,
			resumeable: true,
			...(turn.binding.boundVisualTraceId
				? { visualTraceId: turn.binding.boundVisualTraceId }
				: {}),
			...(turn.binding.boundPaperAbs
				? { paperAbsPath: turn.binding.boundPaperAbs }
				: {}),
		};
		setSessionHistory((prev) =>
			upsertChatSessionTurn(
				prev.filter(
					(item) =>
						!(
							turn.activeHistory &&
							isVisualTraceHistoryId(turn.activeHistory.id) &&
							item.id === turn.activeHistory.id
						) &&
						!(
							turn.binding.boundVisualTraceId &&
							"visualTraceId" in item &&
							(item as { visualTraceId?: string }).visualTraceId ===
								turn.binding.boundVisualTraceId &&
							item.id !== turn.sessionId
						),
				),
				nextHistoryItem,
				turn.activeHistory,
			),
		);
		setLines(pendingLines);
	};

	/** Replay events the runtime parked while the submission was in flight. */
	const replayDeferredEvents = (
		sessionId: string,
		pendingSessionEvents: PendingSessionEvent[],
		pendingTerminal: PendingTerminalEvent | undefined,
	): boolean => {
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
			failSession(sessionId, pendingTerminal.error);
		}
		return pendingTerminal?.kind !== "failed";
	};

	// ---- send --------------------------------------------------------------

	const send = async (
		textRaw: string,
		options?: SendOptions,
	): Promise<boolean> => {
		// Inline @/$ markers stay in the draft; the user bubble / ACP body is plain.
		const text = stripInlineTokens(textRaw).trim();
		const draftSessionKey = activeVisualDraftSessionKey();
		const annotationRefs = planAnnotationRefs(textRaw);
		const resolvedVisualDrafts =
			options?.visualDrafts ??
			visualDraftsInAnnotationOrder(
				annotationRefs,
				visualDraftsForSession(draftSessionKey),
			);
		const hasVisualDrafts = resolvedVisualDrafts.length > 0;
		const attachedImages = (options?.images ?? []).filter(
			(img) => img.data.trim().length > 0,
		);
		const hasAttachedImages = attachedImages.length > 0;
		const fromQueue = options?.fromQueue === true;
		const snap = snapshotComposerState();
		const hasInlineContext =
			snap.mentionedPaths.length > 0 ||
			snap.selectedSkillIds.length > 0 ||
			(snap.includeSelectedFile && Boolean(selectedVaultPath));
		if (
			(!text && !hasVisualDrafts && !hasAttachedImages && !hasInlineContext) ||
			activeTabIsRunning ||
			switchingRef.current ||
			submittingRef.current
		)
			return false;
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
		const inlineSelections = extractSelectionTokens(textRaw);
		const storeSelections = currentSelections();
		const resolvedSelections =
			options?.selections ??
			(inlineSelections.length > 0 ? inlineSelections : storeSelections);
		const resolvedSkillIds =
			options?.skillIds ?? submittedComposerState.selectedSkillIds;
		const submissionGeneration = ++submissionGenRef.current;
		const sessionContextGeneration = sessionContextGenRef.current;
		const requestVaultPath = vaultPath;
		setSubmittingFlag(true);
		try {
			if (!isTauri()) {
				setLines((p) => [...p, errorChatLine(t("messages.desktopOnly"))]);
				return false;
			}

			const forceNewSession = options?.forceNewSession === true;
			const agent = await resolveTurnAgentAndModel(options, forceNewSession);
			if (!agent) return false;
			// Options are availability-filtered in buildOptions; unavailable agents
			// never appear in the switcher.
			const isAcpCommand = (acpCommandsByAgent[agent.agentId] ?? []).some(
				(command) =>
					text === `/${command.name}` || text.startsWith(`/${command.name} `),
			);
			if (forceNewSession) {
				// Drop any panel-level continue target before resolving resume.
				activeConversationRef.current = null;
			}
			const target = resolveResumeTarget(options, forceNewSession);
			// Chat-only built-in agents (e.g. the Zhihu agent) cannot read Vault
			// files; injecting the read-instruction block would leak local paths to
			// a third-party service, so drop the auto-added context entirely and
			// send only public paper metadata instead.
			const chatOnly = isChatOnlyAgentTemplate(
				agentTemplateById(registry, agent.agentId),
			);
			const turnContextPaths = chatOnly ? [] : resolvedContextPaths;
			// Chat-only agents get the focused paper's public metadata (never a
			// local path) so they can answer about "this paper".
			const turnPaper = chatOnly ? (selectedPaperMeta ?? null) : null;
			const plazaScratchByPath = await preparePlazaScratchFor(
				turnContextPaths,
				isAcpCommand,
			);
			const { prompt, images, visualAnnotations, historyTitle } =
				assembleTurnPrompt({
					text: textRaw,
					contextPaths: turnContextPaths,
					paper: turnPaper,
					visualDrafts: resolvedVisualDrafts,
					attachedImages,
					isAcpCommand,
					plazaScratchByPath,
					t,
				});
			const attachTranscript =
				!isAcpCommand &&
				shouldAttachLocalTranscript({
					resumeAllowed: target.resumeAllowed,
					historyStatus: target.activeHistory?.status,
				});
			const priorTranscript = isAcpCommand
				? ""
				: buildLocalTranscriptPrompt(target.priorLines);
			const promptWithHistory =
				attachTranscript && priorTranscript
					? `${priorTranscript}\n\n${prompt}`
					: prompt;
			// Resume is decided before the host sees the context fingerprint.
			// Hold the transcript aside so a refused resume can still show it.
			const resumeTranscript =
				!attachTranscript && priorTranscript ? priorTranscript : undefined;
			const workflow = isAcpCommand ? undefined : options?.workflow;
			const userLine: ChatLine = {
				id: nextLineId("user"),
				kind: "user",
				text,
				...(visualAnnotations?.length ? { visualAnnotations } : {}),
				...(resolvedSelections.length
					? {
							selections: resolvedSelections.map((selection) =>
								structuredClone(selection),
							),
						}
					: {}),
				...(attachedImages.length ? { images: attachedImages } : {}),
			};
			const sessionStartLines = [...target.priorLines, userLine];
			setLines(sessionStartLines);
			// Terminal/stream events are correlated by the fresh Agentero runtime
			// id, not the provider id used to resume ACP. Keep this empty until the
			// host accepts the request, then bind it to accepted.sessionId below.
			pendingSubmissionSessionIdRef.current = null;
			const accepted = await startTurn({
				agentId: agent.agentId,
				resumeSessionId: target.resumeAllowed
					? (target.providerContinueId ?? undefined)
					: undefined,
				prompt: promptWithHistory,
				isAcpCommand,
				images,
				workflow,
				workflowTarget: resolveWorkflowTarget(turnContextPaths, workflow),
				modelId: agent.modelId,
				preferredEffort: agent.preferredEffort,
				skillIds: resolvedSkillIds,
				context: isAcpCommand
					? null
					: sidebarContextRequest({
							contextPaths: turnContextPaths,
							selections: resolvedSelections,
							selectionAnnotations: new Map(
								annotationRefs.flatMap((ref) =>
									ref.kind === "selection"
										? [[ref.selection.id, ref.n] as const]
										: [],
								),
							),
						}),
				resumeTranscript,
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
			const binding = visualTraceBinding(target.activeHistory, options);
			// Reference crops stay in the prompt. Only a session opened from a
			// visual mark patches that mark when the turn completes.
			await bindVisualTracesForTurn({
				runtimeSessionId: accepted.sessionId,
				messageId: accepted.messageId,
				agentId: agent.agentId,
				userText: text,
				continueVisualTraceId: binding.continueVisualTraceId,
				continuePaperAbs: binding.continuePaperAbs,
			});
			await bindAskThreadsForTurn({
				runtimeSessionId: accepted.sessionId,
				userText: text,
				selections: resolvedSelections,
				isAcpCommand,
			});
			// A submitted turn consumes its selection chips (queued turns already did).
			if (!options?.selections) consumeSelections();
			if (!options?.visualDrafts) {
				takeVisualDrafts(extractVisualIds(textRaw), draftSessionKey);
			}
			const pendingTerminal = pendingTerminalEventsRef.current.get(
				accepted.sessionId,
			);
			pendingTerminalEventsRef.current.delete(accepted.sessionId);
			const pendingSessionEvents =
				pendingSessionEventsRef.current.get(accepted.sessionId) ?? [];
			pendingSessionEventsRef.current.delete(accepted.sessionId);
			publishAcceptedTurn({
				sessionId: accepted.sessionId,
				agentId: agent.agentId,
				activeHistory: target.activeHistory,
				historyTitle,
				binding,
				sessionStartLines,
				submittedComposerState,
			});
			return replayDeferredEvents(
				accepted.sessionId,
				pendingSessionEvents,
				pendingTerminal,
			);
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
				setSubmittingFlag(false);
			}
		}
	};

	const enqueueMessage = useCallback(
		(textRaw: string, workflow?: string, images?: PromptImage[]): boolean => {
			const text = stripInlineTokens(textRaw).trim();
			const draftSessionKey = activeVisualDraftSessionKey();
			const referencedVisualDrafts = visualDraftsInAnnotationOrder(
				planAnnotationRefs(textRaw),
				visualDraftsForSession(draftSessionKey),
			);
			const attached = (images ?? []).filter((img) => img.data.trim().length);
			const snap = snapshotComposerState();
			const hasInlineContext =
				snap.mentionedPaths.length > 0 ||
				snap.selectedSkillIds.length > 0 ||
				(snap.includeSelectedFile && Boolean(selectedVaultPath));
			if (
				(!text &&
					!referencedVisualDrafts.length &&
					!attached.length &&
					!hasInlineContext) ||
				switchingRef.current
			) {
				return false;
			}
			const paths = [
				...(snap.includeSelectedFile && selectedVaultPath
					? [selectedVaultPath]
					: []),
				...snap.mentionedPaths,
			];
			const frozenVisualDrafts = takeVisualDrafts(
				referencedVisualDrafts.map((draft) => draft.id),
				draftSessionKey,
			);
			const inlineSelections = extractSelectionTokens(textRaw);
			const item: QueuedPrompt = {
				id: nextLineId("queue"),
				// Keep reference tokens so a later send can put [Annotation N]
				// back where the block sat. The queue row shows the stripped text.
				text: textRaw,
				workflow,
				contextPaths: paths,
				skillIds: [...snap.selectedSkillIds],
				selections:
					inlineSelections.length > 0 ? inlineSelections : consumeSelections(),
				visualDrafts: frozenVisualDrafts,
				...(attached.length ? { images: attached } : {}),
			};
			setMessageQueue((prev) => [...prev, item]);
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
	const answerToolAskUser = async (input: {
		answer: string;
		toolCallId: string;
		questions: AskUserQuestion[];
		answers: AskUserAnswer[];
	}): Promise<boolean> => {
		if (switchingRef.current || submittingRef.current) return false;
		resetPromptHistoryBrowse();
		const text = input.answer.trim();
		if (!text) return false;

		const completedLines = applyToolToLines(lines, {
			id: input.toolCallId,
			status: "completed",
			askUser: { questions: input.questions, answers: input.answers },
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

	/**
	 * Persist an answered / cancelled ext or elicitation questionnaire on the
	 * matching transcript tool card. The provider's tool mirror often carries
	 * no output, so this local record is what the collapsed card can show.
	 */
	const recordAskUserAnswers = useCallback(
		(input: {
			sessionId: string;
			toolCallId: string | null | undefined;
			questions: AskUserQuestion[];
			answers?: AskUserAnswer[];
			cancelled?: boolean;
		}) => {
			const toolCallId = input.toolCallId?.trim();
			if (!toolCallId) return;
			agentSessionStore.getState().updateSessionLines(input.sessionId, (prev) =>
				applyToolToLines(prev, {
					id: toolCallId,
					...(input.cancelled ? {} : { status: "completed" }),
					askUser: {
						questions: input.questions,
						answers: input.answers ?? [],
						...(input.cancelled ? { cancelled: true } : {}),
					},
				}),
			);
		},
		[],
	);

	const removeQueuedMessage = useCallback((id: string) => {
		setMessageQueue((prev) => prev.filter((item) => item.id !== id));
	}, []);

	const sendRef = useRef(send);
	sendRef.current = send;

	/**
	 * NEED_FULLTEXT auto-continuation: a finished plaza-catalog turn whose
	 * reply starts with `NEED_FULLTEXT <id>…` asked for specific full texts.
	 * Prepare their scratch copies (existing host command) and auto-send a
	 * follow-up turn carrying the papers, so the user goes from topic filter
	 * to final report without manual @-ing. One shot per runtime session id;
	 * skipped whenever the user has taken over (queued a message).
	 */
	const handledNeedFulltextRef = useRef(new Set<string>());
	useEffect(() => {
		if (activeTabIsRunning || submitting || switching) return;
		if (messageQueue.length > 0) return;
		const last = lines[lines.length - 1];
		if (last?.kind !== "agent") return;
		const replyText = last.parts
			.filter(
				(part): part is { type: "text"; id: string; text: string } =>
					part.type === "text",
			)
			.map((part) => part.text)
			.join("\n");
		const ids = parseNeedFulltextIds(replyText);
		if (!ids) return;
		if (!activeTabId || handledNeedFulltextRef.current.has(activeTabId)) {
			return;
		}
		handledNeedFulltextRef.current.add(activeTabId);
		const paths = ids
			.map((id) => plazaMentionPathForArxivId(id))
			.filter((path): path is string => Boolean(path));
		if (paths.length === 0) return;
		void sendRef.current(t("composer.plazaFulltextFollowup"), {
			contextPaths: paths,
		});
	}, [
		activeTabId,
		activeTabIsRunning,
		lines,
		messageQueue.length,
		submitting,
		switching,
		t,
	]);

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
					startedAt: formatLocaleTimestamp(new Date(), ctx.i18nLanguage),
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

	/**
	 * The waitlist drains reactively: any transition of the active tab back
	 * to idle (run completed / failed / cancelled in the session store) or
	 * the end of a submit / agent switch re-runs this effect, which pops the
	 * queue head and sends it. drainInFlightRef prevents overlapping sends.
	 */
	useEffect(() => {
		if (activeTabIsRunning || submitting || switching) return;
		if (messageQueue.length === 0) return;
		if (drainInFlightRef.current) return;

		const head = messageQueue[0];
		if (!head) return;
		drainInFlightRef.current = true;
		setMessageQueue((prev) => prev.filter((item) => item.id !== head.id));

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
		recordAskUserAnswers,
	};
}
