/**
 * Agent panel session/runtime state: registry, streaming, history, composer context.
 * UI lives in sibling components under `src/components/agent/`.
 */
import {
	type KeyboardEvent,
	type DragEvent as ReactDragEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { AgentPanelProps, QueuedPrompt } from "@/components/agent/types";
import {
	useSelectionStore,
	useUiStore,
	useVisualContextStore,
} from "@/hooks/use-app-stores";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import { useSessionComposerState } from "@/hooks/use-session-composer-state";
import {
	type AgentEffortChoice,
	type AgentListResponse,
	type AgentModeChoice,
	type AgentModelChoice,
	type AgentPlanEvent,
	type AgentResultPayload,
	type AgentSkill,
	type AgentStreamEvent,
	type AgentToolEvent,
	type AskUserRequest,
	type CatalogScanResponse,
	cancelAgentRun,
	type ElicitationRequest,
	ensureCatalogAgent,
	listAgentSkills,
	listAgents,
	listenAgentCollaboration,
	listenAgentCommands,
	listenAgentCompleted,
	listenAgentEffort,
	listenAgentFailed,
	listenAgentFastMode,
	listenAgentModels,
	listenAgentPlan,
	listenAgentStream,
	listenAgentTool,
	listenAgentUsage,
	listSessions,
	loadCollaborationPref,
	loadModelCatalog,
	loadModelFavorites,
	loadModelPref,
	loadSession,
	type PermissionRequest,
	type PromptImage,
	respondAskUser,
	respondElicitation,
	respondPermission,
	runOnce,
	saveCollaborationPref,
	saveModelCatalog,
	saveModelFavorites,
	saveModelPref,
	scanCatalog,
	setDefaultAgent,
	warmAgent,
} from "@/lib/agent";
import {
	type AgentTurnRequest,
	agentSessionStore,
	applyAgentSessionHandoffOnce,
	useActiveChatLines,
	useAgentSessionStore,
} from "@/lib/agent/agent-session-store";
import {
	type AgentOption,
	type AgentPart,
	agentHasContent,
	agentReasoningFromParts,
	agentTextFromParts,
	appendStreamPart,
	applyToolToParts,
	buildOptions,
	type ChatLine,
	type ChatSessionHistoryItem,
	dedupeModelsClient,
	ensureModelsInclude,
	errorChatLine,
	errorText,
	isBackgroundWorkflowHistoryTitle,
	isPendingAskUserToolStatus,
	mapToolStatus,
	nextLineId,
	nextPartId,
	type PendingSessionEvent,
	type PendingTerminalEvent,
	parseAskUserQuestions,
	providerSessionIdForHistoryLoad,
	resolveSelected,
	shouldDeferSessionEvent,
	type ToolAskUserRequest,
	upsertChatSessionTurn,
	upsertPlanPart,
} from "@/lib/agent/chat-state";
import {
	subscribePendingAgentComposerPrompt,
	takePendingAgentComposerPrompt,
} from "@/lib/agent/composer-seed";
import {
	contextPathDisplayName,
	contextPathLabel,
	normalizeContextPath,
	toPathSet,
} from "@/lib/agent/context-path-icon";
import {
	buildMentionCandidatePaths,
	filterMentionOptions,
	loadRecentMentionPaths,
	mentionParentPath,
	mentionPathHasChildren,
	pushRecentMentionPath,
} from "@/lib/agent/mention";
import {
	displayHistoryTitle,
	stripPromptEnvelopeForDisplay,
} from "@/lib/agent/prompt-display";
import {
	consumeSelections,
	currentSelections,
	type SelectionContext,
	selectionsPromptBlock,
	selectionsWithPdfAnchor,
} from "@/lib/agent/selection-store";
import {
	type AcpCommand,
	filterSlashCommands,
	mapAcpCommands,
} from "@/lib/agent/slash-commands";
import {
	classifyStreamChunk,
	promoteOrphanThoughtToText,
	ThinkTagParser,
} from "@/lib/agent/stream-parse";
import {
	consumeVisualDrafts,
	currentVisualDrafts,
	type PdfVisualDraft,
	removeVisualDraft,
} from "@/lib/agent/visual-context-store";
import { isImeKeyboardEvent } from "@/lib/core/ime";
import { joinPath } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { paperDirFromPath } from "@/lib/paper";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import {
	beginTraceContinue,
	buildVisualAnnotationsPrompt,
	completeTrace,
	createRunningTraces,
	failTrace,
	newTraceMessageId,
	readPdfVisualTrace,
	rememberPendingVisualTraces,
	takePendingVisualTraces,
	writePdfVisualTrace,
} from "@/lib/pdf/agent-trace";
import {
	buildVisualTraceHistoryItem,
	isVisualTraceHistoryId,
	visualTraceHistoryId,
} from "@/lib/pdf/agent-trace/open-session";
import {
	appendAskAssistantMessage,
	createAskThreadFromAgentSelection,
	readPdfAskThread,
	rememberPendingAskThreads,
	takePendingAskThreads,
	writePdfAskThread,
} from "@/lib/pdf/ask";
import { loadSettings } from "@/lib/settings";
import { clearAgentSessionOpenRequest } from "@/lib/shell/ui-store";
import { listenAgentSessionHandoff } from "@/lib/shell/workspace-broadcast";
import {
	collectUserPromptTexts,
	nextHistoryIndexOnDown,
	nextHistoryIndexOnUp,
	placeCaretAtEnd,
	shouldNavigateHistoryDown,
	shouldNavigateHistoryUp,
} from "@/lib/ui/prompt-recall";
import { toVaultRelative } from "@/lib/wiki";

/**
 * Debounce before the Chat-open / agent-switch warm spawns its ACP process.
 * `warm_agent` has no cancellation path, so every superseded spawn would run
 * to completion as an orphan; settling the switch first avoids that (Fix #274).
 */
const WARM_SPAWN_DEBOUNCE_MS = 300;

export type UseAgentPanelArgs = Pick<
	AgentPanelProps,
	| "vaultPath"
	| "selectedPath"
	| "selectedPaperTitle"
	| "vaultMarkdownPaths"
	| "vaultDirectoryPaths"
	| "vaultPaperPaths"
	| "paperMetaByRelPath"
	| "paperTreeLabelMode"
>;

export function useAgentPanel({
	vaultPath,
	selectedPath = null,
	selectedPaperTitle = null,
	vaultMarkdownPaths = [],
	vaultDirectoryPaths = [],
	vaultPaperPaths = [],
	paperMetaByRelPath = null,
	paperTreeLabelMode = "title-author",
}: UseAgentPanelArgs) {
	const { t, i18n } = useTranslation("agent");
	/**
	 * Focused document as Vault-relative context path.
	 * Files under a paper resolve to the **paper folder** (minimal unit).
	 */
	const selectedVaultPath = useMemo(() => {
		if (!selectedPath) return null;
		if (
			isLibraryVirtualPath(selectedPath) ||
			isTrashVirtualPath(selectedPath)
		) {
			return null;
		}
		const relative = toVaultRelative(vaultPath, selectedPath);
		if (!relative) return null;
		if (isLibraryVirtualPath(relative) || isTrashVirtualPath(relative)) {
			return null;
		}
		const paperDir = paperDirFromPath(relative, vaultPaperPaths);
		return paperDir ?? relative;
	}, [selectedPath, vaultPath, vaultPaperPaths]);
	/** O(1) lookups for context chip icons (paper → ScrollText, dir → Folder). */
	const directoryPathSet = useMemo(
		() => toPathSet(vaultDirectoryPaths),
		[vaultDirectoryPaths],
	);
	const paperPathSet = useMemo(
		() => toPathSet(vaultPaperPaths),
		[vaultPaperPaths],
	);

	/** Label options shared by chips and @ menu (matches file-tree settings). */
	const pathLabelOptions = useMemo(
		() => ({
			paperPaths: paperPathSet,
			paperMetaByRelPath,
			paperTreeLabelMode,
		}),
		[paperMetaByRelPath, paperPathSet, paperTreeLabelMode],
	);

	const labelForPath = useCallback(
		(path: string) => contextPathLabel(path, pathLabelOptions),
		[pathLabelOptions],
	);

	/** Searchable labels for @ filter (paper titles, not only folder names). */
	const mentionLabelsByPath = useMemo(() => {
		const map = new Map<string, string>();
		for (const p of vaultPaperPaths) {
			const label = contextPathLabel(p, pathLabelOptions);
			if (label && label !== p) map.set(normalizeContextPath(p), label);
		}
		return map;
	}, [pathLabelOptions, vaultPaperPaths]);
	const [registry, setRegistry] = useState<AgentListResponse | null>(null);
	const [catalog, setCatalog] = useState<CatalogScanResponse | null>(null);
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	// Single source of truth shared with PDF visual modal (not a parallel store).
	const lines = useActiveChatLines();
	const setLines = useAgentSessionStore((s) => s.setLines);
	const sessionHistory = useAgentSessionStore((s) => s.sessions);
	const setSessionHistory = useAgentSessionStore((s) => s.setSessions);
	const activeTabId = useAgentSessionStore((s) => s.activeTabId);
	const setActiveTabId = useAgentSessionStore((s) => s.setActiveTabId);
	const startDraft = useAgentSessionStore((s) => s.startDraft);
	const hydrateAndActivateSession = useAgentSessionStore(
		(s) => s.hydrateAndActivateSession,
	);
	const setStoreSubmitting = useAgentSessionStore((s) => s.setSubmitting);
	const [switching, setSwitching] = useState(false);
	const [usage, setUsage] = useState<{ used: number; size: number } | null>(
		null,
	);
	const [usageBySession, setUsageBySession] = useState<
		Record<string, { used: number; size: number }>
	>({});
	const [acpCommandsByAgent, setAcpCommandsByAgent] = useState<
		Record<string, AcpCommand[]>
	>({});
	const [historyOpen, setHistoryOpen] = useState(false);
	const [models, setModels] = useState<AgentModelChoice[]>([]);
	const [modelId, setModelId] = useState<string | null>(null);
	const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
	const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
	const [warming, setWarming] = useState(false);
	const [agentListenersReady, setAgentListenersReady] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [skills, setSkills] = useState<AgentSkill[]>([]);
	const [collaborationOptions, setCollaborationOptions] = useState<
		AgentModeChoice[]
	>([]);
	const [collaborationModeId, setCollaborationModeId] = useState<string | null>(
		null,
	);
	const [effortOptions, setEffortOptions] = useState<AgentEffortChoice[]>([]);
	const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
	const [fastAvailable, setFastAvailable] = useState(false);
	const [fastEnabled, setFastEnabled] = useState(false);
	const [composerMenuDismissed, setComposerMenuDismissed] = useState(false);
	const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
	const [skillActiveIndex, setSkillActiveIndex] = useState(0);
	const [slashActiveIndex, setSlashActiveIndex] = useState(0);
	/** Follow-ups typed while the active session is still running. */
	const [messageQueue, setMessageQueue] = useState<QueuedPrompt[]>([]);
	// Inline edit-and-resend of a sent user message (only when not running).
	const [editingLineId, setEditingLineId] = useState<string | null>(null);
	const [editingText, setEditingText] = useState("");
	const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const {
		isBlockedByIme: isEditBlockedByIme,
		compositionProps: editCompositionProps,
	} = useImeGuard();
	const {
		text: composerText,
		mentionedPaths,
		selectedSkillIds,
		includeSelectedFile,
		activateSession: activateComposerSession,
		completeSubmission: completeComposerSubmission,
		resetSession: resetComposerSession,
		setText: setComposerText,
		setMentionedPaths,
		setSelectedSkillIds,
		setIncludeSelectedFile,
		snapshot: snapshotComposerState,
	} = useSessionComposerState({
		vaultPath,
		agentId: selectedAgentId,
		sessionId: activeTabId,
		// Current paper/file is always in context by default (no click-to-add).
		defaultIncludeSelectedFile: true,
	});

	// Doctor / Settings may seed the composer via a cross-window event.
	useEffect(() => {
		const apply = (text: string) => {
			const next = text.trim();
			if (!next) return;
			setComposerText(next);
			setComposerMenuDismissed(true);
		};
		const pending = takePendingAgentComposerPrompt();
		if (pending) apply(pending);
		return subscribePendingAgentComposerPrompt(apply);
	}, [setComposerText]);

	const activeConversationRef = useRef<string | null>(null);
	const activeTabRef = useRef("draft");
	const selectedAgentIdRef = useRef<string | null>(null);
	const warmGenRef = useRef(0);
	const historyGenRef = useRef(0);
	const historyHydrationGenRef = useRef(0);
	const switchingRef = useRef(false);
	const submittingRef = useRef(false);
	const submissionGenRef = useRef(0);
	/** Prevents overlapping drain of the follow-up waitlist. */
	const drainInFlightRef = useRef(false);
	const messageQueueRef = useRef<QueuedPrompt[]>([]);
	/**
	 * ↑/↓ prompt history: index into chronological user prompts, or null when
	 * not browsing. Draft is restored when stepping past the newest entry.
	 */
	const promptHistoryIndexRef = useRef<number | null>(null);
	const promptHistoryDraftRef = useRef("");
	const promptHistoryAppliedRef = useRef<string | null>(null);
	const pendingTerminalEventsRef = useRef(
		new Map<string, PendingTerminalEvent>(),
	);
	const pendingSessionEventsRef = useRef(
		new Map<string, PendingSessionEvent[]>(),
	);
	/** Runtime id awaiting publication; never the provider id used for resume. */
	const pendingSubmissionSessionIdRef = useRef<string | null>(null);
	const knownSessionIdsRef = useRef(new Set<string>());
	/** Per-session <think> tag parsers for message-channel reasoning (DeepSeek etc.). */
	const thinkParsersRef = useRef(new Map<string, ThinkTagParser>());
	const sessionHistoryRef = useRef<ChatSessionHistoryItem[]>([]);
	const vaultPathRef = useRef(vaultPath);
	const sessionContextGenRef = useRef(0);
	const previousVaultPathRef = useRef(vaultPath);

	const applyModelsEvent = useCallback(
		(ev: {
			agentId: string;
			configId: string;
			currentId: string;
			models: AgentModelChoice[];
		}) => {
			const cur = selectedAgentIdRef.current;
			const pref = loadModelPref(ev.agentId)?.trim() || null;
			const current = ev.currentId?.trim() || null;
			// Keep user/custom prefs and agent current even when not in the fixed
			// official catalog (third-party / gateway model ids; Fix #216).
			const catalogModels = ensureModelsInclude(dedupeModelsClient(ev.models), [
				current,
				pref,
			]);
			if (catalogModels.length === 0) return;
			saveModelCatalog(ev.agentId, {
				configId: ev.configId,
				currentId: ev.currentId,
				models: catalogModels,
			});
			if (cur && cur !== ev.agentId) return;
			setModelId((prev) => {
				const prevId = prev?.trim() || null;
				const next = pref || prevId || current || catalogModels[0]?.id || null;
				// Nested setState: keep free-form selection visible in the picker.
				setModels(ensureModelsInclude(catalogModels, [next, prevId]));
				return next;
			});
		},
		[],
	);

	const applyCollaborationEvent = useCallback(
		(ev: { agentId: string; currentId: string; modes: AgentModeChoice[] }) => {
			const cur = selectedAgentIdRef.current;
			if (cur && cur !== ev.agentId) return;
			if (!ev.modes.length) {
				setCollaborationOptions([]);
				setCollaborationModeId(null);
				return;
			}
			const pref = loadCollaborationPref(ev.agentId)?.trim() || null;
			const current = ev.currentId?.trim() || null;
			const validPref =
				pref && ev.modes.some((mode) => mode.id === pref) ? pref : null;
			setCollaborationOptions(ev.modes);
			setCollaborationModeId((prev) => {
				const prevId = prev?.trim() || null;
				if (prevId && ev.modes.some((mode) => mode.id === prevId)) {
					return prevId;
				}
				return validPref || current || ev.modes[0]?.id || null;
			});
		},
		[],
	);

	const applyEffortEvent = useCallback(
		(ev: {
			agentId: string;
			currentId: string;
			efforts: AgentEffortChoice[];
		}) => {
			const cur = selectedAgentIdRef.current;
			if (cur && cur !== ev.agentId) return;
			setEffortOptions(ev.efforts);
			setReasoningEffort(ev.currentId);
		},
		[],
	);

	const applyFastModeEvent = useCallback(
		(ev: { agentId: string; enabled: boolean }) => {
			const cur = selectedAgentIdRef.current;
			if (cur && cur !== ev.agentId) return;
			setFastAvailable(true);
			setFastEnabled(ev.enabled);
		},
		[],
	);

	const refresh = useCallback(async () => {
		if (!isTauri()) return;
		try {
			const [list, scan, discoveredSkills] = await Promise.all([
				listAgents(),
				scanCatalog(),
				listAgentSkills(vaultPath ?? undefined).catch(() => []),
			]);
			setRegistry(list);
			setCatalog(scan);
			setSkills(discoveredSkills);
			setSelectedAgentId((prev) => prev ?? list.defaultId);
		} catch (e) {
			setLines((prev) => [...prev, errorChatLine(errorText(e))]);
		}
	}, [vaultPath, setLines]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

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
	}, [activeTabId]);

	// Focus the inline editor (and place the caret at the end) when it opens.
	useEffect(() => {
		if (!editingLineId) return;
		const el = editTextareaRef.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, [editingLineId]);

	useEffect(() => {
		sessionHistoryRef.current = sessionHistory;
	}, [sessionHistory]);

	useEffect(() => {
		messageQueueRef.current = messageQueue;
	}, [messageQueue]);

	useEffect(() => {
		vaultPathRef.current = vaultPath;
	}, [vaultPath]);

	const clearMessageQueue = useCallback(() => {
		messageQueueRef.current = [];
		setMessageQueue([]);
		drainInFlightRef.current = false;
	}, []);

	useEffect(() => {
		if (previousVaultPathRef.current === vaultPath) return;
		previousVaultPathRef.current = vaultPath;
		for (const session of sessionHistoryRef.current) {
			if (session.status === "running") {
				void cancelAgentRun(session.id).catch(() => undefined);
			}
		}
		sessionContextGenRef.current += 1;
		historyGenRef.current += 1;
		historyHydrationGenRef.current += 1;
		submissionGenRef.current += 1;
		submittingRef.current = false;
		pendingTerminalEventsRef.current.clear();
		pendingSessionEventsRef.current.clear();
		pendingSubmissionSessionIdRef.current = null;
		knownSessionIdsRef.current.clear();
		thinkParsersRef.current.clear();
		setSubmitting(false);
		setLines([]);
		setSessionHistory([]);
		setUsage(null);
		setUsageBySession({});
		setHistoryOpen(false);
		setComposerMenuDismissed(false);
		setMentionActiveIndex(0);
		setSkillActiveIndex(0);
		setActiveTabId("draft");
		activeTabRef.current = "draft";
		activeConversationRef.current = null;
		clearMessageQueue();
	}, [
		vaultPath,
		clearMessageQueue,
		setLines,
		setSessionHistory,
		setActiveTabId,
	]);

	// Cross-window handoff: first snapshot only (retries may arrive later).
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		void listenAgentSessionHandoff((payload) => {
			const applied = applyAgentSessionHandoffOnce({
				sessions: payload.sessions,
				activeTabId: payload.activeTabId,
				draftLines: payload.draftLines,
			});
			if (!applied) return;
			const agentId =
				payload.selectedAgentId ??
				payload.sessions.find((s) => s.id === payload.activeTabId)?.agentId ??
				payload.sessions[0]?.agentId ??
				null;
			if (agentId) {
				setSelectedAgentId(agentId);
				selectedAgentIdRef.current = agentId;
			}
			const tabId = payload.activeTabId || "draft";
			activeTabRef.current = tabId;
			activeConversationRef.current = tabId === "draft" ? null : tabId;
			knownSessionIdsRef.current = new Set(
				(payload.sessions ?? []).map((s) => s.id),
			);
			// Composer scope follows session id; force activate after handoff.
			activateComposerSession(tabId);
		}).then((u) => {
			unlisten = u;
		});
		return () => {
			unlisten?.();
		};
	}, [activateComposerSession]);

	// Restore last model catalog / preference for the selected agent.
	useEffect(() => {
		selectedAgentIdRef.current = selectedAgentId;
		historyHydrationGenRef.current += 1;
		if (!selectedAgentId) {
			setModels([]);
			setModelId(null);
			setFavoriteIds([]);
			setCollaborationOptions([]);
			setCollaborationModeId(null);
			setEffortOptions([]);
			setReasoningEffort(null);
			setFastAvailable(false);
			setFastEnabled(false);
			setUsage(null);
			setUsageBySession({});
			return;
		}
		setCollaborationOptions([]);
		setCollaborationModeId(loadCollaborationPref(selectedAgentId));
		setEffortOptions([]);
		setReasoningEffort(null);
		setFastAvailable(false);
		setFastEnabled(false);
		setUsage(null);
		setUsageBySession({});
		setFavoriteIds(loadModelFavorites(selectedAgentId));
		const catalog = loadModelCatalog(selectedAgentId);
		const pref = loadModelPref(selectedAgentId);
		if (catalog?.models.length) {
			const preferred =
				(pref?.trim() ? pref.trim() : null) ||
				(catalog.currentId?.trim() ? catalog.currentId.trim() : null) ||
				catalog.models[0]?.id ||
				null;
			const models = ensureModelsInclude(dedupeModelsClient(catalog.models), [
				preferred,
				catalog.currentId,
				pref,
			]);
			setModels(models);
			setModelId(preferred);
		} else {
			const models = ensureModelsInclude([], [pref]);
			setModels(models);
			setModelId(pref?.trim() ? pref.trim() : null);
		}
	}, [selectedAgentId]);

	/**
	 * Shared ACP warm: prefetch models / usage. Used on Chat open and model switch.
	 * `stillValid` gates applying results after racey agent/vault/model changes.
	 */
	const runWarmAgent = useCallback(
		async (args: {
			agentId: string;
			vaultPath: string | null;
			modelId?: string;
			collaborationModeId?: string;
			generation: number;
			/** Apply models/usage only when still the intended warm target. */
			stillValid: () => boolean;
			/**
			 * Clear the warming spinner when this generation is still current.
			 * Defaults to `stillValid`; model-switch uses a looser check so a
			 * superseded model pref does not leave the spinner stuck.
			 */
			stillWarming?: () => boolean;
		}) => {
			setWarming(true);
			try {
				const result = await warmAgent({
					agentId: args.agentId,
					vaultPath: args.vaultPath ?? undefined,
					modelId: args.modelId,
					collaborationModeId: args.collaborationModeId,
				});
				if (args.generation !== warmGenRef.current || !args.stillValid()) {
					return;
				}
				if (result.models) applyModelsEvent(result.models);
				if (
					result.usageUsed != null &&
					result.usageSize != null &&
					result.usageSize > 0
				) {
					setUsage({ used: result.usageUsed, size: result.usageSize });
				}
			} catch {
				// Warm is best-effort; first message can still discover models.
			} finally {
				const keepWarmingCheck = args.stillWarming ?? args.stillValid;
				if (args.generation === warmGenRef.current && keepWarmingCheck()) {
					setWarming(false);
				}
			}
		},
		[applyModelsEvent],
	);

	// When Chat opens (or agent/vault changes), warm ACP in the background for models/context.
	useEffect(() => {
		if (!isTauri() || !selectedAgentId || !agentListenersReady) return;
		// Supersede any in-flight warm immediately (its results are dropped)…
		const gen = ++warmGenRef.current;
		let cancelled = false;
		// …but debounce the spawn itself: warm_agent cannot be cancelled, so a
		// rapid agent/vault switch must not start one ACP process per change.
		const timer = setTimeout(() => {
			const agentId = selectedAgentId;
			const requestVaultPath = vaultPath;
			void runWarmAgent({
				agentId,
				vaultPath: requestVaultPath,
				modelId: loadModelPref(agentId) ?? undefined,
				collaborationModeId: loadCollaborationPref(agentId) ?? undefined,
				generation: gen,
				stillValid: () =>
					!cancelled &&
					selectedAgentIdRef.current === agentId &&
					vaultPathRef.current === requestVaultPath,
			});
		}, WARM_SPAWN_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [selectedAgentId, vaultPath, runWarmAgent, agentListenersReady]);

	const updateSessionLines = useCallback(
		(sessionId: string, update: (lines: ChatLine[]) => ChatLine[]) => {
			// Shared store: modal pin + sidebar both observe the same lines.
			agentSessionStore.getState().updateSessionLines(sessionId, update);
		},
		[],
	);

	/** Only composer-owned sessions (or pending submit) update the chat transcript. */
	const isChatOwnedSession = useCallback((sessionId: string) => {
		if (knownSessionIdsRef.current.has(sessionId)) return true;
		if (pendingSubmissionSessionIdRef.current === sessionId) return true;
		if (activeTabRef.current === sessionId && sessionId !== "draft")
			return true;
		return sessionHistoryRef.current.some((item) => item.id === sessionId);
	}, []);

	const applyStreamEvent = useCallback(
		(ev: AgentStreamEvent) => {
			if (!isChatOwnedSession(ev.sessionId)) return;
			const streamKind = ev.kind ?? "message";
			let parser = thinkParsersRef.current.get(ev.sessionId);
			if (!parser) {
				parser = new ThinkTagParser();
				thinkParsersRef.current.set(ev.sessionId, parser);
			}
			const slices = classifyStreamChunk(streamKind, ev.chunk, parser);
			if (slices.length === 0) return;
			updateSessionLines(ev.sessionId, (prev) => {
				const next = [...prev];
				const last = next[next.length - 1];
				if (last?.kind !== "agent" || !last.streaming) return prev;
				let parts = last.parts;
				for (const slice of slices) {
					if (!slice.text) continue;
					parts = appendStreamPart(parts, slice.kind, slice.text);
				}
				next[next.length - 1] = {
					...last,
					parts,
				};
				return next;
			});
		},
		[isChatOwnedSession, updateSessionLines],
	);

	// OpenCode / Claude / Codex tool-shaped ask → bottom form surface (not transcript).
	// Declared before applyToolEvent so the promote path can set it.
	const [toolAskUserRequest, setToolAskUserRequest] =
		useState<ToolAskUserRequest | null>(null);

	const applyToolEvent = useCallback(
		(ev: AgentToolEvent) => {
			if (!isChatOwnedSession(ev.sessionId)) return;
			updateSessionLines(ev.sessionId, (prev) => {
				const next = [...prev];
				const last = next[next.length - 1];
				if (last?.kind !== "agent" || !last.streaming) return prev;
				next[next.length - 1] = {
					...last,
					parts: applyToolToParts(last.parts, {
						id: ev.toolCallId,
						title: ev.title,
						kind: ev.kind,
						status: ev.status,
						input: ev.input,
						output: ev.output,
						full: ev.full,
					}),
				};
				return next;
			});

			// Promote pending ask-user tools to the bottom surface (hides free-text composer).
			// Surface priority: elicitation > Grok ext > tool; listeners clear tool on host asks.
			const questions = parseAskUserQuestions(ev.input);
			const pending = isPendingAskUserToolStatus(ev.status);
			if (questions && pending) {
				setToolAskUserRequest({
					toolCallId: ev.toolCallId,
					sessionId: ev.sessionId,
					questions,
				});
				return;
			}
			if (questions && !pending) {
				setToolAskUserRequest((prev) =>
					prev?.toolCallId === ev.toolCallId ? null : prev,
				);
			}
		},
		[isChatOwnedSession, updateSessionLines],
	);

	const applyPlanEvent = useCallback(
		(ev: AgentPlanEvent) => {
			if (!isChatOwnedSession(ev.sessionId)) return;
			updateSessionLines(ev.sessionId, (prev) => {
				const next = [...prev];
				const last = next[next.length - 1];
				if (last?.kind !== "agent" || !last.streaming) return prev;
				next[next.length - 1] = {
					...last,
					parts: upsertPlanPart(last.parts, ev.entries),
				};
				return next;
			});
		},
		[isChatOwnedSession, updateSessionLines],
	);

	const deferSessionEvent = useCallback(
		(sessionId: string, event: PendingSessionEvent) => {
			const pending = pendingSessionEventsRef.current.get(sessionId) ?? [];
			pending.push(event);
			pendingSessionEventsRef.current.set(sessionId, pending);
		},
		[],
	);

	const finalizeVisualTraces = useCallback(
		async (
			runtimeSessionId: string,
			outcome:
				| {
						kind: "completed";
						providerSessionId?: string | null;
						answerSnapshot?: string;
						sources?: string[];
				  }
				| {
						kind: "failed";
						error: string;
						providerSessionId?: string | null;
						answerSnapshot?: string;
				  },
		) => {
			const pending = takePendingVisualTraces(runtimeSessionId);
			if (!pending.length) return;
			await Promise.all(
				pending.map(async ({ paperAbsPath, traceId }) => {
					try {
						const current = await readPdfVisualTrace(paperAbsPath, traceId);
						if (!current) return;
						const next =
							outcome.kind === "completed"
								? completeTrace(current, {
										providerSessionId: outcome.providerSessionId ?? undefined,
										answerSnapshot: outcome.answerSnapshot,
										sources: outcome.sources,
									})
								: failTrace(current, {
										error: outcome.error,
										providerSessionId: outcome.providerSessionId ?? undefined,
										answerSnapshot: outcome.answerSnapshot,
									});
						await writePdfVisualTrace(paperAbsPath, next);
					} catch {
						// Trace persistence is best-effort; chat already completed.
					}
				}),
			);
		},
		[],
	);

	/** Finalize PDF selection → ask conversation cards created on this Agent turn. */
	const finalizeAskThreads = useCallback(
		async (
			runtimeSessionId: string,
			outcome:
				| {
						kind: "completed";
						answerSnapshot?: string;
						sources?: string[];
				  }
				| {
						kind: "failed";
						error: string;
						answerSnapshot?: string;
				  },
		) => {
			const pending = takePendingAskThreads(runtimeSessionId);
			if (!pending.length) return;
			const content =
				outcome.kind === "completed"
					? (outcome.answerSnapshot ?? "").trim()
					: (outcome.answerSnapshot ?? outcome.error).trim() || outcome.error;
			if (!content) return;
			const sources =
				outcome.kind === "completed" && outcome.sources?.length
					? outcome.sources.map((uri) => ({ uri }))
					: undefined;
			await Promise.all(
				pending.map(async ({ paperAbsPath, threadId }) => {
					try {
						const current = await readPdfAskThread(paperAbsPath, threadId);
						if (!current) return;
						const next = appendAskAssistantMessage(current, {
							content,
							agentSessionId: runtimeSessionId,
							sources,
						});
						await writePdfAskThread(paperAbsPath, next);
					} catch {
						// Ask card persistence is best-effort; chat already completed.
					}
				}),
			);
		},
		[],
	);

	const completeSession = useCallback(
		(ev: AgentResultPayload) => {
			if (!isChatOwnedSession(ev.sessionId)) return;
			if (ev.providerSessionId) {
				// Durable source session for next turn (Host: resume or load).
				if (activeTabRef.current === ev.sessionId) {
					activeConversationRef.current = ev.providerSessionId;
				}
				setSessionHistory((prev) =>
					prev.map((item) =>
						item.id === ev.sessionId
							? { ...item, providerSessionId: ev.providerSessionId }
							: item,
					),
				);
			}
			if (ev.stopReason === "cancelled") {
				const cancelledLine: ChatLine = {
					id: nextLineId("sys"),
					kind: "system",
					text: t("messages.cancelled"),
				};
				updateSessionLines(ev.sessionId, (prev) => {
					const next = [...prev];
					const last = next[next.length - 1];
					if (last?.kind === "agent" && last.streaming) {
						if (agentHasContent(last.parts)) {
							next[next.length - 1] = {
								...last,
								streaming: false,
							};
						} else {
							next.pop();
						}
					}
					return [...next, cancelledLine];
				});
				setSessionHistory((prev) =>
					prev.map((item) =>
						item.id === ev.sessionId ? { ...item, status: "cancelled" } : item,
					),
				);
				void finalizeVisualTraces(ev.sessionId, {
					kind: "failed",
					error: t("messages.cancelled"),
					providerSessionId: ev.providerSessionId,
					answerSnapshot: ev.content,
				});
				void finalizeAskThreads(ev.sessionId, {
					kind: "failed",
					error: t("messages.cancelled"),
					answerSnapshot: ev.content,
				});
				return;
			}
			thinkParsersRef.current.delete(ev.sessionId);
			updateSessionLines(ev.sessionId, (prev) => {
				const next = [...prev];
				const last = next[next.length - 1];
				if (last?.kind === "agent" && last.streaming) {
					let parts = last.parts;
					if (
						agentReasoningFromParts(parts).trim().length === 0 &&
						ev.reasoning &&
						ev.reasoning.trim().length > 0
					) {
						parts = [
							{
								type: "reasoning",
								id: nextPartId("reasoning"),
								text: ev.reasoning,
							},
							...parts,
						];
					}
					if (agentTextFromParts(parts).trim().length === 0) {
						const content = (ev.content ?? "").trim();
						if (content) {
							parts = [
								...parts,
								{
									type: "text",
									id: nextPartId("text"),
									text: ev.content || content,
								},
							];
						} else {
							// DeepSeek / ACP mis-tag: answer only arrived as thought chunks.
							parts = promoteOrphanThoughtToText(parts) as AgentPart[];
							if (agentTextFromParts(parts).trim().length === 0) {
								parts = [
									...parts,
									{
										type: "text",
										id: nextPartId("text"),
										text: "(empty response)",
									},
								];
							}
						}
					}
					next[next.length - 1] = {
						...last,
						parts,
						sources: ev.sources,
						streaming: false,
					};
					return next;
				}
				return prev;
			});
			setSessionHistory((prev) =>
				prev.map((item) =>
					item.id === ev.sessionId ? { ...item, status: "completed" } : item,
				),
			);
			void finalizeVisualTraces(ev.sessionId, {
				kind: "completed",
				providerSessionId: ev.providerSessionId,
				answerSnapshot: ev.content,
				sources: ev.sources,
			});
			void finalizeAskThreads(ev.sessionId, {
				kind: "completed",
				answerSnapshot: ev.content,
				sources: ev.sources,
			});
		},
		[
			finalizeAskThreads,
			finalizeVisualTraces,
			isChatOwnedSession,
			t,
			updateSessionLines,
			setSessionHistory,
		],
	);

	const failSession = useCallback(
		(sessionId: string, error: string) => {
			if (!isChatOwnedSession(sessionId)) return;
			const failedLine: ChatLine = errorChatLine(error);
			updateSessionLines(sessionId, (prev) => {
				const next = [...prev];
				const last = next[next.length - 1];
				if (last?.kind === "agent" && last.streaming) {
					if (agentHasContent(last.parts)) {
						next[next.length - 1] = {
							...last,
							streaming: false,
						};
					} else {
						next.pop();
					}
				}
				return [...next, failedLine];
			});
			setSessionHistory((prev) =>
				prev.map((item) =>
					item.id === sessionId ? { ...item, status: "failed" } : item,
				),
			);
			void finalizeVisualTraces(sessionId, {
				kind: "failed",
				error,
			});
			void finalizeAskThreads(sessionId, {
				kind: "failed",
				error,
			});
		},
		[
			finalizeAskThreads,
			finalizeVisualTraces,
			isChatOwnedSession,
			updateSessionLines,
			setSessionHistory,
		],
	);

	const shouldDeferTerminalEvent = useCallback((sessionId: string) => {
		return shouldDeferSessionEvent({
			sessionId,
			submitting: submittingRef.current,
			pendingRuntimeSessionId: pendingSubmissionSessionIdRef.current,
			knownSessionIds: knownSessionIdsRef.current,
		});
	}, []);

	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		const unsubs: Array<() => void> = [];
		setAgentListenersReady(false);

		void (async () => {
			const u1 = await listenAgentStream((ev) => {
				if (shouldDeferTerminalEvent(ev.sessionId)) {
					deferSessionEvent(ev.sessionId, { kind: "stream", event: ev });
					return;
				}
				applyStreamEvent(ev);
			});
			const uTool = await listenAgentTool((ev) => {
				if (shouldDeferTerminalEvent(ev.sessionId)) {
					deferSessionEvent(ev.sessionId, { kind: "tool", event: ev });
					return;
				}
				applyToolEvent(ev);
			});
			const uPlan = await listenAgentPlan((ev) => {
				if (shouldDeferTerminalEvent(ev.sessionId)) {
					deferSessionEvent(ev.sessionId, { kind: "plan", event: ev });
					return;
				}
				applyPlanEvent(ev);
			});
			const uUsage = await listenAgentUsage((ev) => {
				if (ev.size <= 0) return;
				if (ev.sessionId === "warm") {
					setUsage({ used: ev.used, size: ev.size });
					return;
				}
				setUsageBySession((prev) => ({
					...prev,
					[ev.sessionId]: { used: ev.used, size: ev.size },
				}));
			});
			const uCommands = await listenAgentCommands((ev) => {
				setAcpCommandsByAgent((prev) => ({
					...prev,
					[ev.agentId]: mapAcpCommands(ev.commands),
				}));
			});
			const uModels = await listenAgentModels((ev) => {
				applyModelsEvent(ev);
			});
			const uCollab = await listenAgentCollaboration((ev) => {
				applyCollaborationEvent(ev);
			});
			const uEffort = await listenAgentEffort((ev) => {
				applyEffortEvent(ev);
			});
			const uFast = await listenAgentFastMode((ev) => {
				applyFastModeEvent(ev);
			});
			const u2 = await listenAgentCompleted((ev) => {
				if (shouldDeferTerminalEvent(ev.sessionId)) {
					pendingTerminalEventsRef.current.set(ev.sessionId, {
						kind: "completed",
						event: ev,
					});
					return;
				}
				completeSession(ev);
			});
			const u3 = await listenAgentFailed((ev) => {
				if (shouldDeferTerminalEvent(ev.sessionId)) {
					pendingTerminalEventsRef.current.set(ev.sessionId, {
						kind: "failed",
						error: ev.error,
					});
					return;
				}
				failSession(ev.sessionId, ev.error);
			});

			if (cancelled) {
				u1();
				uTool();
				uPlan();
				uUsage();
				uCommands();
				uModels();
				uCollab();
				uEffort();
				uFast();
				u2();
				u3();
				return;
			}
			unsubs.push(
				u1,
				uTool,
				uPlan,
				uUsage,
				uCommands,
				uModels,
				uCollab,
				uEffort,
				uFast,
				u2,
				u3,
			);
			setAgentListenersReady(true);
		})();

		return () => {
			cancelled = true;
			for (const u of unsubs) u();
		};
	}, [
		applyCollaborationEvent,
		applyEffortEvent,
		applyFastModeEvent,
		applyModelsEvent,
		applyPlanEvent,
		applyStreamEvent,
		applyToolEvent,
		completeSession,
		deferSessionEvent,
		failSession,
		shouldDeferTerminalEvent,
	]);

	const options = buildOptions(registry, catalog);
	const selected = resolveSelected(options, selectedAgentId, registry);
	const [supportsResume, setSupportsResume] = useState(false);

	const [historyLoaded, setHistoryLoaded] = useState(false);

	const loadAgentHistory = useCallback(async () => {
		if (!isTauri() || !selectedAgentId) {
			setHistoryLoaded(true);
			return;
		}
		const generation = ++historyGenRef.current;
		setHistoryLoaded(false);
		try {
			const result = await listSessions({
				agentId: selectedAgentId,
				vaultPath: vaultPath ?? undefined,
			});
			if (generation !== historyGenRef.current) return;
			setSupportsResume(result.supported);
			if (!result.supported) return;
			const chatSessions = result.sessions.filter(
				(s) => !isBackgroundWorkflowHistoryTitle(s.title ?? ""),
			);
			setSessionHistory((prev) => {
				const existingForAgent = prev.filter(
					(item) => item.agentId === selectedAgentId,
				);
				const existingById = new Map(
					existingForAgent.map((item) => [item.id, item]),
				);
				const existingByProvider = new Map(
					existingForAgent
						.filter((item) => item.providerSessionId?.trim())
						.map((item) => [item.providerSessionId?.trim() as string, item]),
				);
				const imported = chatSessions.map((session) => {
					// A local runtime row may have a different id from the durable
					// provider session returned by session/list after a resumed turn.
					const current =
						existingById.get(session.sessionId) ??
						existingByProvider.get(session.sessionId);
					const startedAt = session.updatedAt
						? new Date(session.updatedAt).toLocaleString(i18n.language)
						: "";
					if (current) {
						const title =
							current.lines.length > 0
								? current.title
								: displayHistoryTitle(
										session.title ?? "",
										session.sessionId.slice(0, 8),
									);
						return {
							...current,
							source:
								current.source === "local"
									? ("local" as const)
									: ("external" as const),
							agentName: selected?.name ?? "Agent",
							title,
							startedAt: current.startedAt || startedAt,
							providerSessionId: session.sessionId,
						};
					}
					return {
						id: session.sessionId,
						agentId: selectedAgentId,
						source: "external" as const,
						title: displayHistoryTitle(
							session.title ?? "",
							session.sessionId.slice(0, 8),
						),
						agentName: selected?.name ?? "Agent",
						startedAt,
						lines: [],
						status: "completed" as const,
						providerSessionId: session.sessionId,
					};
				});
				const importedIds = new Set(
					chatSessions.map((session) => session.sessionId),
				);
				const localOnly = prev.filter(
					(item) =>
						item.agentId === selectedAgentId &&
						!importedIds.has(item.id) &&
						!importedIds.has(item.providerSessionId?.trim() ?? "") &&
						!isBackgroundWorkflowHistoryTitle(item.title) &&
						(item.status === "running" ||
							(item.source === "local" && item.lines.length > 0)),
				);
				return [...localOnly, ...imported];
			});
		} catch {
			// History is supplementary: a failed scan must not block the Composer.
		} finally {
			if (generation === historyGenRef.current) {
				setHistoryLoaded(true);
			}
		}
	}, [
		i18n.language,
		selected?.name,
		selectedAgentId,
		vaultPath,
		setSessionHistory,
	]);

	useEffect(() => {
		void loadAgentHistory();
		return () => {
			historyGenRef.current += 1;
		};
	}, [loadAgentHistory]);

	const agentSessionOpenRequest = useUiStore((s) => s.agentSessionOpenRequest);

	const selectedModelName = useMemo(() => {
		if (!modelId) return null;
		return models.find((m) => m.id === modelId)?.name ?? modelId;
	}, [modelId, models]);

	const groupedModels = useMemo(() => {
		const favItems = favoriteIds
			.map((id) => models.find((m) => m.id === id))
			.filter((m): m is AgentModelChoice => Boolean(m));

		const groups = new Map<string, AgentModelChoice[]>();
		for (const model of models) {
			const group = model.group || t("models.defaultGroup");
			let items = groups.get(group);
			if (!items) {
				items = [];
				groups.set(group, items);
			}
			items.push(model);
		}

		const result: {
			id: string;
			heading: string;
			isFavorites: boolean;
			items: AgentModelChoice[];
		}[] = [];
		if (favItems.length > 0) {
			result.push({
				id: "__favorites__",
				heading: t("models.favorites"),
				isFavorites: true,
				items: favItems,
			});
		}
		for (const [heading, items] of groups) {
			result.push({ id: heading, heading, isFavorites: false, items });
		}
		return result;
	}, [models, favoriteIds, t]);

	const contextPaths = useMemo(() => {
		const paths = [
			...(includeSelectedFile && selectedVaultPath ? [selectedVaultPath] : []),
			...mentionedPaths,
		];
		return [...new Set(paths)];
	}, [includeSelectedFile, mentionedPaths, selectedVaultPath]);

	/** Current paper/file path when included (always-on chip; no dashed + toggle). */
	const currentFilePath =
		includeSelectedFile && selectedVaultPath ? selectedVaultPath : null;

	/** Same paper label mode as the file tree (settings); title fallback if meta missing. */
	const currentFileLabel = useMemo(() => {
		if (!currentFilePath) return "";
		const labeled = labelForPath(currentFilePath);
		if (labeled && labeled !== contextPathDisplayName(currentFilePath)) {
			return labeled;
		}
		const title = selectedPaperTitle?.trim();
		if (title && paperPathSet.has(normalizeContextPath(currentFilePath))) {
			return title;
		}
		return labeled || contextPathDisplayName(currentFilePath);
	}, [currentFilePath, labelForPath, paperPathSet, selectedPaperTitle]);

	// Re-attach when the focused document/paper changes (user can still remove via X).
	useEffect(() => {
		if (!selectedVaultPath) return;
		setIncludeSelectedFile(true);
	}, [selectedVaultPath, setIncludeSelectedFile]);

	const mentionChipPaths = useMemo(
		() => contextPaths.filter((path) => path !== selectedVaultPath),
		[contextPaths, selectedVaultPath],
	);

	// Editor/PDF selection chips: pinned first, live selection last (Cursor-style).
	const activeSelection = useSelectionStore((s) => s.active);
	const pinnedSelections = useSelectionStore((s) => s.pinned);
	const selectionChips = useMemo(
		() =>
			activeSelection
				? [...pinnedSelections, activeSelection]
				: pinnedSelections,
		[activeSelection, pinnedSelections],
	);
	const visualDrafts = useVisualContextStore((s) => s.drafts);

	const mentionMatch = composerText.match(/(^|\s)@([^\s]*)$/);
	/** Raw @query (preserve case for display; matching is case-insensitive). */
	const mentionQueryRaw = mentionMatch?.[2] ?? "";
	const mentionQuery = mentionQueryRaw.toLocaleLowerCase();

	const mentionCandidates = useMemo(
		() =>
			buildMentionCandidatePaths({
				markdownPaths: vaultMarkdownPaths,
				directoryPaths: vaultDirectoryPaths,
				paperPaths: vaultPaperPaths,
			}),
		[vaultDirectoryPaths, vaultMarkdownPaths, vaultPaperPaths],
	);

	const [recentMentionPaths, setRecentMentionPaths] = useState<string[]>(() => {
		try {
			return loadRecentMentionPaths(
				typeof localStorage === "undefined" ? null : localStorage,
				vaultPath,
			);
		} catch {
			return [];
		}
	});

	/**
	 * In-folder browse for `@` menu (null = root: recents + shallow tree).
	 * Chevron on the right drills into directories; papers stay leaves.
	 */
	const [mentionBrowseRoot, setMentionBrowseRoot] = useState<string | null>(
		null,
	);

	// Reload recents when Vault changes; leave any open folder browser.
	useEffect(() => {
		try {
			setRecentMentionPaths(
				loadRecentMentionPaths(
					typeof localStorage === "undefined" ? null : localStorage,
					vaultPath,
				),
			);
		} catch {
			setRecentMentionPaths([]);
		}
		setMentionBrowseRoot(null);
	}, [vaultPath]);

	// Close folder browser when `@` is gone or the menu is dismissed.
	useEffect(() => {
		if (!mentionMatch || composerMenuDismissed) {
			setMentionBrowseRoot(null);
		}
	}, [composerMenuDismissed, mentionMatch]);

	const mentionOptions = useMemo(() => {
		if (!mentionMatch) return [];
		return filterMentionOptions({
			candidates: mentionCandidates,
			query: mentionQuery,
			exclude: contextPaths,
			recent: recentMentionPaths,
			labelsByPath: mentionLabelsByPath,
			browseRoot: mentionBrowseRoot,
			limit: 8,
		});
	}, [
		contextPaths,
		mentionBrowseRoot,
		mentionCandidates,
		mentionLabelsByPath,
		mentionMatch,
		mentionQuery,
		recentMentionPaths,
	]);

	const enterMentionFolder = useCallback((path: string) => {
		setMentionBrowseRoot(path);
		setMentionActiveIndex(0);
		setComposerMenuDismissed(false);
	}, []);

	const leaveMentionFolder = useCallback(() => {
		setMentionBrowseRoot((current) => {
			if (!current) return null;
			return mentionParentPath(current);
		});
		setMentionActiveIndex(0);
	}, []);

	const skillMatch = composerText.match(/(^|\s)\$([^\s]*)$/);
	const skillQuery = skillMatch?.[2]?.toLocaleLowerCase() ?? "";
	const skillOptions = useMemo(() => {
		if (!skillMatch) return [];
		return skills
			.filter((skill) => {
				const searchable =
					`${skill.id} ${skill.name} ${skill.description}`.toLocaleLowerCase();
				return searchable.includes(skillQuery);
			})
			.filter((skill) => !selectedSkillIds.includes(skill.id))
			.slice(0, 6);
	}, [selectedSkillIds, skillMatch, skillQuery, skills]);

	const slashMatch = composerText.match(/(^|\s)\/([^\s]*)$/);
	const slashQuery = slashMatch?.[2]?.toLocaleLowerCase() ?? "";
	const slashCommands = acpCommandsByAgent[selectedAgentId ?? ""] ?? [];
	const slashOptions = useMemo(() => {
		if (!slashMatch) return [];
		return filterSlashCommands(slashCommands, slashQuery);
	}, [slashCommands, slashMatch, slashQuery]);

	const showMentionMenu =
		!composerMenuDismissed &&
		Boolean(mentionMatch) &&
		(mentionOptions.length > 0 || mentionBrowseRoot != null);
	const showSkillMenu = !composerMenuDismissed && skillOptions.length > 0;
	const showSlashMenu = !composerMenuDismissed && slashOptions.length > 0;

	useEffect(() => {
		setMentionActiveIndex((index) =>
			mentionOptions.length
				? Math.max(0, Math.min(index, mentionOptions.length - 1))
				: 0,
		);
	}, [mentionOptions.length]);

	useEffect(() => {
		setSkillActiveIndex((index) =>
			skillOptions.length
				? Math.max(0, Math.min(index, skillOptions.length - 1))
				: 0,
		);
	}, [skillOptions.length]);

	useEffect(() => {
		setSlashActiveIndex((index) =>
			slashOptions.length
				? Math.max(0, Math.min(index, slashOptions.length - 1))
				: 0,
		);
	}, [slashOptions.length]);

	const effortOptionsInDisplayOrder = useMemo(() => {
		const order = ["max", "xhigh", "high", "medium", "low"];
		return [...effortOptions].sort(
			(left, right) =>
				order.indexOf(left.id.toLocaleLowerCase()) -
				order.indexOf(right.id.toLocaleLowerCase()),
		);
	}, [effortOptions]);

	const formatEffort = (value: string) => {
		switch (value.toLocaleLowerCase()) {
			case "max":
				return t("composer.effort.max");
			case "xhigh":
				return t("composer.effort.xhigh");
			case "high":
				return t("composer.effort.high");
			case "medium":
				return t("composer.effort.medium");
			case "low":
				return t("composer.effort.low");
			default:
				return value;
		}
	};

	const selectedCollaborationName = useMemo(() => {
		if (!collaborationModeId) return null;
		return (
			collaborationOptions.find((mode) => mode.id === collaborationModeId)
				?.name ?? collaborationModeId
		);
	}, [collaborationModeId, collaborationOptions]);

	const pickCollaborationMode = useCallback(
		(id: string) => {
			const next = id.trim();
			if (!next || !collaborationOptions.some((mode) => mode.id === next))
				return;
			setCollaborationModeId(next);
			if (!selectedAgentId) return;
			saveCollaborationPref(selectedAgentId, next);
		},
		[collaborationOptions, selectedAgentId],
	);

	const selectedSkills = useMemo(
		() =>
			selectedSkillIds
				.map((id) => skills.find((skill) => skill.id === id))
				.filter((skill): skill is AgentSkill => Boolean(skill)),
		[selectedSkillIds, skills],
	);

	const activeTabSession = sessionHistory.find(
		(session) => session.id === activeTabId,
	);
	const activeTabIsRunning = activeTabSession?.status === "running";
	const activeUsage = usageBySession[activeTabId] ?? usage;
	const hasRunningSessions = sessionHistory.some(
		(session) => session.status === "running",
	);

	const pickModel = (id: string) => {
		const next = id.trim();
		if (!next) return;
		setModelSelectorOpen(false);
		// Free-form / third-party ids may not be in the advertised catalog yet.
		setModels((prev) => ensureModelsInclude(prev, [next]));
		setModelId(next);
		if (!selectedAgentId) return;
		saveModelPref(selectedAgentId, next);
		if (!isTauri() || !agentListenersReady) return;

		const agentId = selectedAgentId;
		const requestVaultPath = vaultPath;
		const generation = ++warmGenRef.current;
		setEffortOptions([]);
		setReasoningEffort(null);
		setFastAvailable(false);
		setFastEnabled(false);
		void runWarmAgent({
			agentId,
			vaultPath: requestVaultPath,
			modelId: next,
			collaborationModeId:
				loadCollaborationPref(agentId) ?? collaborationModeId ?? undefined,
			generation,
			stillValid: () =>
				selectedAgentIdRef.current === agentId &&
				vaultPathRef.current === requestVaultPath &&
				loadModelPref(agentId) === next,
			stillWarming: () =>
				selectedAgentIdRef.current === agentId &&
				vaultPathRef.current === requestVaultPath,
		});
	};

	const toggleFavorite = useCallback(
		(id: string) => {
			if (!selectedAgentId) return;
			setFavoriteIds((prev) => {
				const next = prev.includes(id)
					? prev.filter((x) => x !== id)
					: [...prev, id];
				saveModelFavorites(selectedAgentId, next);
				return next;
			});
		},
		[selectedAgentId],
	);

	const selectAgent = async (opt: AgentOption) => {
		if (
			!isTauri() ||
			switchingRef.current ||
			hasRunningSessions ||
			submittingRef.current
		)
			return;
		if (opt.id && opt.id === selectedAgentId) return;

		switchingRef.current = true;
		setSwitching(true);
		try {
			let agentId = opt.id;
			if (!agentId && opt.templateId) {
				const agent = await ensureCatalogAgent(opt.templateId, true);
				agentId = agent.id;
			} else if (agentId) {
				await setDefaultAgent(agentId);
			} else {
				return;
			}
			sessionContextGenRef.current += 1;
			historyGenRef.current += 1;
			historyHydrationGenRef.current += 1;
			pendingTerminalEventsRef.current.clear();
			pendingSessionEventsRef.current.clear();
			pendingSubmissionSessionIdRef.current = null;
			knownSessionIdsRef.current.clear();
			thinkParsersRef.current.clear();
			selectedAgentIdRef.current = agentId;
			activeConversationRef.current = null;
			activateComposerSession("draft");
			activeTabRef.current = "draft";
			setActiveTabId("draft");
			setLines([]);
			setSessionHistory([]);
			clearMessageQueue();
			setSelectedAgentId(agentId);
			await refresh();
			setLines((p) => [
				...p,
				{
					id: nextLineId("sys"),
					kind: "system",
					text: t("messages.switchedTo", { name: opt.name }),
				},
			]);
		} catch (e) {
			setLines((p) => [...p, errorChatLine(errorText(e))]);
		} finally {
			switchingRef.current = false;
			setSwitching(false);
		}
	};

	// Forward ACP permission requests (ask mode) to the user for an explicit decision.
	const [permissionRequest, setPermissionRequest] =
		useState<PermissionRequest | null>(null);
	// Codex Plan-mode request_user_input → form elicitation.
	const [elicitationRequest, setElicitationRequest] =
		useState<ElicitationRequest | null>(null);
	// Grok `_x.ai/ask_user_question` extension method.
	const [askUserRequest, setAskUserRequest] = useState<AskUserRequest | null>(
		null,
	);

	const permissionRequestRef = useRef(permissionRequest);
	permissionRequestRef.current = permissionRequest;
	useOverlayRegistration("agent-permission", permissionRequest !== null, () => {
		const req = permissionRequestRef.current;
		if (!req) return;
		void respondPermission(req.requestId, null);
		setPermissionRequest(null);
	});

	const elicitationRequestRef = useRef(elicitationRequest);
	elicitationRequestRef.current = elicitationRequest;
	useOverlayRegistration(
		"agent-elicitation",
		elicitationRequest !== null,
		() => {
			const req = elicitationRequestRef.current;
			if (!req) return;
			void respondElicitation({
				requestId: req.requestId,
				action: "cancel",
			});
			setElicitationRequest(null);
		},
	);

	const askUserRequestRef = useRef(askUserRequest);
	askUserRequestRef.current = askUserRequest;
	useOverlayRegistration("agent-ask-user", askUserRequest !== null, () => {
		const req = askUserRequestRef.current;
		if (!req) return;
		void respondAskUser({
			requestId: req.requestId,
			action: "cancel",
		});
		setAskUserRequest(null);
	});

	const toolAskUserRequestRef = useRef(toolAskUserRequest);
	toolAskUserRequestRef.current = toolAskUserRequest;
	useOverlayRegistration(
		"agent-tool-ask-user",
		toolAskUserRequest !== null,
		() => {
			setToolAskUserRequest(null);
		},
	);

	useEffect(() => {
		if (!isTauri()) return;
		let unsub: (() => void) | undefined;
		let cancelled = false;
		void (async () => {
			const { listen } = await import("@tauri-apps/api/event");
			if (cancelled) return;
			unsub = await listen<PermissionRequest>(
				"agent:permission-request",
				({ payload }) => setPermissionRequest(payload),
			);
		})();
		return () => {
			cancelled = true;
			unsub?.();
		};
	}, []);

	useEffect(() => {
		if (!isTauri()) return;
		let unsub: (() => void) | undefined;
		let cancelled = false;
		void (async () => {
			const { listen } = await import("@tauri-apps/api/event");
			if (cancelled) return;
			unsub = await listen<ElicitationRequest>(
				"agent:elicitation-request",
				({ payload }) => {
					// Prefer host elicitation over tool-card promote.
					setToolAskUserRequest(null);
					setElicitationRequest(payload);
				},
			);
		})();
		return () => {
			cancelled = true;
			unsub?.();
		};
	}, []);

	useEffect(() => {
		if (!isTauri()) return;
		let unsub: (() => void) | undefined;
		let cancelled = false;
		void (async () => {
			const { listen } = await import("@tauri-apps/api/event");
			if (cancelled) return;
			unsub = await listen<AskUserRequest>(
				"agent:ask-user-request",
				({ payload }) => {
					// Grok ext is the authoritative respond path; drop tool-promote duplicate.
					setToolAskUserRequest(null);
					setAskUserRequest(payload);
				},
			);
		})();
		return () => {
			cancelled = true;
			unsub?.();
		};
	}, []);

	type SendOptions = {
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
			const contextBlocks: string[] = [];
			if (resolvedContextPaths.length) {
				contextBlocks.push(
					`${t("composer.contextInstruction")}\n${resolvedContextPaths
						.map((path) => `- ${path}`)
						.join("\n")}`,
				);
			}
			if (resolvedSelections.length) {
				contextBlocks.push(selectionsPromptBlock(resolvedSelections));
			}
			if (hasVisualDrafts && !isAcpCommand) {
				contextBlocks.push(
					buildVisualAnnotationsPrompt(
						resolvedVisualDrafts.map((draft) => ({
							page: draft.page,
							comment: draft.comment,
						})),
					),
				);
			}
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
			const promptBodyParts: string[] = [];
			if (text) promptBodyParts.push(text);
			if (!isAcpCommand && contextBlocks.length) {
				promptBodyParts.push(...contextBlocks);
			}
			const prompt =
				isAcpCommand && text
					? text
					: promptBodyParts.join("\n\n") ||
						(hasVisualDrafts
							? buildVisualAnnotationsPrompt(
									resolvedVisualDrafts.map((draft) => ({
										page: draft.page,
										comment: draft.comment,
									})),
								)
							: hasAttachedImages
								? t("composer.imageOnlyPrompt", {
										count: attachedImages.length,
									})
								: "");
			const visualImages = hasVisualDrafts
				? resolvedVisualDrafts.map((draft) => draft.image)
				: [];
			const images =
				visualImages.length || attachedImages.length
					? [...visualImages, ...attachedImages]
					: undefined;
			const visualAnnotations = hasVisualDrafts
				? resolvedVisualDrafts.map((draft) => ({
						id: draft.id,
						page: draft.page,
						comment: draft.comment,
						paperPath: draft.paperPath,
						image: {
							data: draft.image.data,
							mimeType: draft.image.mimeType || "image/png",
						},
					}))
				: undefined;
			const historyTitle =
				text ||
				resolvedVisualDrafts.find((d) => d.comment.trim())?.comment.trim() ||
				(hasVisualDrafts
					? t("composer.visualAnnotationsTitle", {
							count: resolvedVisualDrafts.length,
						})
					: hasAttachedImages
						? t("composer.attachedImagesTitle", {
								count: attachedImages.length,
							})
						: t("composer.visualAnnotation"));
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
			if (hasVisualDrafts) {
				const byPaper = new Map<string, PdfVisualDraft[]>();
				for (const draft of resolvedVisualDrafts) {
					const abs =
						draft.paperAbsPath?.trim() ||
						(vaultPath && draft.paperPath
							? joinPath(vaultPath, draft.paperPath)
							: draft.paperPath);
					if (!abs) continue;
					const list = byPaper.get(abs) ?? [];
					list.push(draft);
					byPaper.set(abs, list);
				}
				const pendingWrites: Array<{
					paperAbsPath: string;
					traceId: string;
				}> = [];
				for (const [paperAbsPath, drafts] of byPaper) {
					try {
						// One mark file per crop so pins hover/delete independently.
						// Prefer the turn text as the first user message (Cmd+Enter /
						// composer). draft.comment is the annotation note only — leave
						// it out of messages so wiki embeds do not show the same text twice.
						const userText = text.trim();
						const now = new Date().toISOString();
						const traces = createRunningTraces({
							paperPath: drafts[0]?.paperPath || paperAbsPath,
							agentId,
							runtimeSessionId: accepted.sessionId,
							messageId: accepted.messageId,
							items: drafts.map((draft) => ({
								id: draft.id,
								page: draft.page,
								rects: draft.rects,
								comment: draft.comment,
								image: {
									data: draft.image.data,
									mimeType: draft.image.mimeType || "image/png",
								},
								messages: userText
									? [
											{
												id: newTraceMessageId(),
												role: "user" as const,
												content: userText,
												createdAt: now,
											},
										]
									: undefined,
							})),
							createdAt: now,
						});
						for (const trace of traces) {
							await writePdfVisualTrace(paperAbsPath, trace);
							pendingWrites.push({ paperAbsPath, traceId: trace.id });
						}
					} catch {
						// Keep chat running even if mark write fails.
					}
				}
				rememberPendingVisualTraces(accepted.sessionId, pendingWrites);
			} else if (continueVisualTraceId && continuePaperAbs) {
				try {
					const current = await readPdfVisualTrace(
						continuePaperAbs,
						continueVisualTraceId,
					);
					if (current) {
						const next = beginTraceContinue(current, {
							runtimeSessionId: accepted.sessionId,
							messageId: accepted.messageId,
							userContent: text,
							// Note-only marks need agentId when attaching the first thread.
							agentId: agentId || current.agent?.agentId || undefined,
						});
						await writePdfVisualTrace(continuePaperAbs, next);
					}
				} catch {
					// Keep chat running even if mark write fails.
				}
				rememberPendingVisualTraces(accepted.sessionId, [
					{
						paperAbsPath: continuePaperAbs,
						traceId: continueVisualTraceId,
					},
				]);
			}
			// PDF text selections with geometry → ask conversation cards (kind ask),
			// not visual-annotation agent-trace marks. One card pin per selection.
			const anchoredSelections =
				!isAcpCommand && text
					? selectionsWithPdfAnchor(resolvedSelections)
					: [];
			if (anchoredSelections.length) {
				const pendingAskWrites: Array<{
					paperAbsPath: string;
					threadId: string;
				}> = [];
				const userContent = text.trim();
				for (const sel of anchoredSelections) {
					try {
						const thread = createAskThreadFromAgentSelection({
							paperPath: sel.sourcePath || sel.paperAbsPath,
							page: sel.page,
							rects: sel.rects,
							quote: sel.text,
							userContent,
							agentSessionId: accepted.sessionId,
						});
						await writePdfAskThread(sel.paperAbsPath, thread);
						pendingAskWrites.push({
							paperAbsPath: sel.paperAbsPath,
							threadId: thread.id,
						});
					} catch {
						// Keep chat running even if ask-card write fails.
					}
				}
				rememberPendingAskThreads(accepted.sessionId, pendingAskWrites);
			}
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
					activeHistory?.startedAt || new Date().toLocaleString(i18n.language),
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
		],
	);

	const resetPromptHistoryBrowse = useCallback(() => {
		promptHistoryIndexRef.current = null;
		promptHistoryDraftRef.current = "";
		promptHistoryAppliedRef.current = null;
	}, []);

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
	const answerToolAskUser = async (answer: string): Promise<boolean> => {
		if (switchingRef.current || submittingRef.current) return false;
		resetPromptHistoryBrowse();
		const text = answer.trim();
		if (!text) return false;

		setToolAskUserRequest(null);

		if (!activeTabIsRunning) {
			return send(text);
		}

		// Queue first so cancel → idle drains it; then free the blocked run.
		const enqueued = enqueueMessage(text);
		if (!enqueued) return false;
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
		i18nLanguage: i18n.language,
		agentName: selected?.name as string | undefined,
	});
	externalTurnCtxRef.current = {
		activateComposerSession,
		t,
		i18nLanguage: i18n.language,
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
	}, [setActiveTabId, setLines]);

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
		// Visual crops were already consumed into marks; re-send as plain images
		// so ACP still receives the multimodal payload without recreating drafts.
		const visualAsImages =
			original?.kind === "user"
				? (original.visualAnnotations ?? []).map((item) => item.image)
				: [];
		const mergedImages = [
			...(resendImages ?? []),
			...visualAsImages.filter((img) => img.data.trim().length > 0),
		];
		setEditingLineId(null);
		setEditingText("");
		await send(text, {
			baseLines,
			...(mergedImages.length ? { images: mergedImages } : {}),
		});
	};

	/** Add Vault-relative path(s) as removable context chips (same as @mention). */
	const attachContextPaths = useCallback(
		(rawPaths: string[]) => {
			const normalized = rawPaths
				.map((p) => toVaultRelative(vaultPath, p.trim()))
				.filter((p) => p.length > 0);
			if (!normalized.length) return;
			setMentionedPaths((prev) => [...new Set([...prev, ...normalized])]);
			// Remember for empty-`@` recent hints (per Vault).
			try {
				const storage =
					typeof localStorage === "undefined" ? null : localStorage;
				let recents: string[] = [];
				for (const path of normalized) {
					recents = pushRecentMentionPath(storage, vaultPath, path);
				}
				if (recents.length) setRecentMentionPaths(recents);
			} catch {
				// ignore quota / private mode
			}
			setComposerMenuDismissed(true);
			// Clear an in-progress @ query so the menu closes after attach.
			setComposerText((prev) =>
				prev.replace(/(^|\s)@[^\s]*$/, (_match, prefix: string) => `${prefix}`),
			);
		},
		[setComposerText, setMentionedPaths, vaultPath],
	);

	const attachMention = useCallback(
		(path: string) => {
			attachContextPaths([path]);
			setMentionBrowseRoot(null);
		},
		[attachContextPaths],
	);

	const removeContextPath = (path: string) => {
		if (path === selectedVaultPath) {
			setIncludeSelectedFile(false);
			return;
		}
		setMentionedPaths((prev) => prev.filter((item) => item !== path));
	};

	/**
	 * Drag from file tree sets `text/plain` vault paths (newline-separated).
	 * Capture as context chips instead of inserting raw path text into the textarea.
	 * Reuses the same chip UI as `@` mentions — not AI Elements Attachments
	 * (those are FileUIPart blobs; ACP context is path-based).
	 */
	const handleComposerDragOver = useCallback((e: ReactDragEvent) => {
		const types = e.dataTransfer?.types;
		if (!types) return;
		const hasText =
			[...types].includes("text/plain") || [...types].includes("Text");
		const hasFiles = [...types].includes("Files");
		// Prefer vault path drops; leave pure OS file drops to PromptInput if any.
		if (hasText && !hasFiles) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		} else if (hasText && hasFiles) {
			// Some platforms advertise both; still accept path payload.
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		}
	}, []);

	const handleComposerDrop = useCallback(
		(e: ReactDragEvent) => {
			const text = e.dataTransfer?.getData("text/plain")?.trim();
			if (!text) return;
			// Ignore non-path payloads (e.g. plain prose selection).
			const lines = text
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			const pathLike = lines.filter(
				(line) =>
					!line.includes("://") &&
					(line.includes("/") ||
						line.includes("\\") ||
						/\.(md|pdf|tex|bib|json|txt|html?)$/i.test(line)),
			);
			if (!pathLike.length) return;
			e.preventDefault();
			e.stopPropagation();
			attachContextPaths(pathLike);
		},
		[attachContextPaths],
	);

	const attachSkill = (skill: AgentSkill) => {
		setSelectedSkillIds((prev) => [...new Set([...prev, skill.id])]);
		setComposerMenuDismissed(true);
		setComposerText((prev) =>
			prev.replace(/(^|\s)\$[^\s]*$/, (_match, prefix: string) => `${prefix}`),
		);
	};

	const handleComposerMenuKeyDown = (
		event: KeyboardEvent<HTMLTextAreaElement>,
	) => {
		// IME: do not treat Enter as mention/skill select while composing.
		// PromptInputTextarea owns compositionend grace + blocks submit; here
		// we only need keyCode 229 / isComposing so menus do not steal the key.
		if (event.key === "Enter" && isImeKeyboardEvent(event)) {
			return;
		}

		if (event.key === "Escape" && activeTabIsRunning) {
			event.preventDefault();
			void cancelCurrentRun();
			return;
		}

		if (
			event.key === "Escape" &&
			(showMentionMenu || showSkillMenu || showSlashMenu)
		) {
			event.preventDefault();
			// While browsing a folder, Esc steps up; only dismiss at root.
			if (showMentionMenu && mentionBrowseRoot) {
				leaveMentionFolder();
				return;
			}
			setComposerMenuDismissed(true);
			setMentionBrowseRoot(null);
			return;
		}

		if (showMentionMenu) {
			if (event.key === "ArrowLeft" && mentionBrowseRoot) {
				event.preventDefault();
				leaveMentionFolder();
				return;
			}
			if (event.key === "ArrowRight") {
				const path =
					mentionOptions[mentionActiveIndex] ?? mentionOptions[0] ?? null;
				if (
					path &&
					mentionPathHasChildren(path, mentionCandidates, paperPathSet)
				) {
					event.preventDefault();
					enterMentionFolder(path);
					return;
				}
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (mentionOptions.length === 0) return;
				setMentionActiveIndex((index) =>
					event.key === "ArrowDown"
						? (index + 1) % mentionOptions.length
						: (index - 1 + mentionOptions.length) % mentionOptions.length,
				);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				const path = mentionOptions[mentionActiveIndex] ?? mentionOptions[0];
				if (path) attachMention(path);
			}
			return;
		}

		if (showSkillMenu) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setSkillActiveIndex((index) =>
					event.key === "ArrowDown"
						? (index + 1) % skillOptions.length
						: (index - 1 + skillOptions.length) % skillOptions.length,
				);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				const skill = skillOptions[skillActiveIndex] ?? skillOptions[0];
				if (skill) attachSkill(skill);
			}
			return;
		}

		if (showSlashMenu) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setSlashActiveIndex((index) =>
					event.key === "ArrowDown"
						? (index + 1) % slashOptions.length
						: (index - 1 + slashOptions.length) % slashOptions.length,
				);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				const command = slashOptions[slashActiveIndex] ?? slashOptions[0];
				if (command) attachSlashCommand(command);
			}
			return;
		}

		// ↑ / ↓ → walk previous user prompts into the composer (shell-style).
		// Does not open inline edit / rollback — Pencil still does that.
		if (switchingRef.current) return;
		const el = event.currentTarget;
		const isBrowsing = promptHistoryIndexRef.current !== null;
		const history = collectUserPromptTexts(
			lines,
			stripPromptEnvelopeForDisplay,
		);

		if (shouldNavigateHistoryUp(event, el, isBrowsing)) {
			if (history.length === 0) return;
			event.preventDefault();
			if (!isBrowsing) {
				promptHistoryDraftRef.current = el.value;
			}
			const nextIndex = nextHistoryIndexOnUp(
				history.length,
				promptHistoryIndexRef.current,
			);
			if (nextIndex === null) return;
			const text = history[nextIndex] ?? "";
			promptHistoryIndexRef.current = nextIndex;
			promptHistoryAppliedRef.current = text;
			setComposerText(text);
			placeCaretAtEnd(el, text);
			return;
		}

		if (shouldNavigateHistoryDown(event, el, isBrowsing)) {
			event.preventDefault();
			const nextIndex = nextHistoryIndexOnDown(
				history.length,
				promptHistoryIndexRef.current,
			);
			if (nextIndex === null) {
				const draft = promptHistoryDraftRef.current;
				promptHistoryIndexRef.current = null;
				promptHistoryDraftRef.current = "";
				promptHistoryAppliedRef.current = null;
				setComposerText(draft);
				placeCaretAtEnd(el, draft);
				return;
			}
			const text = history[nextIndex] ?? "";
			promptHistoryIndexRef.current = nextIndex;
			promptHistoryAppliedRef.current = text;
			setComposerText(text);
			placeCaretAtEnd(el, text);
		}
	};

	/** Clear ↑/↓ history browse when the user edits the recalled text. */
	const onComposerTextChangeFromUser = useCallback(
		(text: string) => {
			if (
				promptHistoryIndexRef.current !== null &&
				text !== promptHistoryAppliedRef.current
			) {
				promptHistoryIndexRef.current = null;
				promptHistoryDraftRef.current = "";
				promptHistoryAppliedRef.current = null;
			}
			setComposerText(text);
		},
		[setComposerText],
	);

	const newConversation = () => {
		if (submittingRef.current) return;
		historyHydrationGenRef.current += 1;
		startDraft();
		resetComposerSession("draft");
		activeTabRef.current = "draft";
		activeConversationRef.current = null;
		clearMessageQueue();
	};

	const attachSlashCommand = useCallback(
		(command: AcpCommand) => {
			setComposerMenuDismissed(true);
			setComposerText((prev) =>
				prev.replace(
					/(^|\s)\/[^\s]*$/,
					(_match, prefix: string) => `${prefix}/${command.name} `,
				),
			);
		},
		[setComposerText],
	);

	/** Strip Host/Codex machine envelopes so Chat never shows system preamble. */
	const sanitizeChatLines = (raw: ChatLine[]): ChatLine[] =>
		raw
			.map((line) => {
				if (line.kind !== "user") return line;
				const text = stripPromptEnvelopeForDisplay(line.text);
				const hasVisual = Boolean(line.visualAnnotations?.length);
				const hasImages = Boolean(line.images?.length);
				if (!text && !hasVisual && !hasImages) return null;
				return {
					...line,
					text: text || "",
					...(line.visualAnnotations?.length
						? { visualAnnotations: line.visualAnnotations }
						: {}),
					...(line.images?.length ? { images: line.images } : {}),
				};
			})
			.filter((line): line is ChatLine => line !== null);

	const openHistorySession = (item: ChatSessionHistoryItem) => {
		if (submittingRef.current) return;
		const providerSessionId = providerSessionIdForHistoryLoad(item);
		const hydrationGeneration = ++historyHydrationGenRef.current;
		setHistoryOpen(false);
		clearMessageQueue();
		if (!supportsResume || item.lines.length > 0) {
			const localLines = sanitizeChatLines(item.lines);
			activateComposerSession(item.id);
			activeTabRef.current = item.id;
			hydrateAndActivateSession(item, localLines);
			// Visual-trace (and other non-resumeable) sessions keep multi-turn
			// context in local lines; never set an ACP resume id for them.
			if (supportsResume && item.resumeable !== false) {
				activeConversationRef.current = providerSessionId;
			} else {
				activeConversationRef.current = null;
			}
			return;
		}
		const requestAgentId = selectedAgentId;
		const requestVaultPath = vaultPath;
		if (!requestAgentId) return;
		void (async () => {
			try {
				const history = await loadSession({
					agentId: requestAgentId,
					sessionId: providerSessionId,
					vaultPath: requestVaultPath ?? undefined,
				});
				if (
					hydrationGeneration !== historyHydrationGenRef.current ||
					selectedAgentIdRef.current !== requestAgentId ||
					vaultPathRef.current !== requestVaultPath
				) {
					return;
				}
				const nextLines = sanitizeChatLines(
					history.lines.map((line) => {
						if (line.kind === "user") {
							return {
								id: line.id,
								kind: "user" as const,
								text: line.text,
							};
						}
						const parts: AgentPart[] = [];
						if (line.parts && line.parts.length > 0) {
							line.parts.forEach((part, index) => {
								const partId = `${line.id}:part-${index}`;
								if (part.type === "reasoning" || part.type === "text") {
									if (part.text.trim().length > 0) {
										parts.push({
											type: part.type,
											id: partId,
											text: part.text,
										});
									}
									return;
								}
								if (part.type === "tool") {
									parts.push({
										type: "tool",
										id: partId,
										tool: {
											id: part.tool.id,
											title: part.tool.title,
											kind: part.tool.kind,
											status: mapToolStatus(part.tool.status),
											input: part.tool.input,
											output: part.tool.output,
										},
									});
									return;
								}
								if (part.entries.length > 0) {
									parts.push({
										type: "plan",
										id: partId,
										entries: part.entries,
									});
								}
							});
						} else {
							if (line.reasoning && line.reasoning.trim().length > 0) {
								parts.push({
									type: "reasoning",
									id: `${line.id}:reasoning`,
									text: line.reasoning,
								});
							}
							parts.push({
								type: "text",
								id: `${line.id}:text`,
								text: line.text,
							});
						}
						return {
							id: line.id,
							kind: "agent" as const,
							parts,
							sources:
								line.sources && line.sources.length > 0
									? line.sources
									: undefined,
						};
					}),
				);
				const firstUser = nextLines.find((l) => l.kind === "user");
				const titleFromBody =
					firstUser?.kind === "user"
						? displayHistoryTitle(firstUser.text, history.title ?? "")
						: displayHistoryTitle(history.title ?? "");
				activeConversationRef.current = providerSessionId;
				activateComposerSession(item.id);
				activeTabRef.current = item.id;
				hydrateAndActivateSession(item, nextLines, titleFromBody);
			} catch (error) {
				if (
					hydrationGeneration !== historyHydrationGenRef.current ||
					selectedAgentIdRef.current !== requestAgentId ||
					vaultPathRef.current !== requestVaultPath
				) {
					return;
				}
				setLines((prev) => [...prev, errorChatLine(errorText(error))]);
			}
		})();
	};

	const openHistorySessionRef = useRef(openHistorySession);
	openHistorySessionRef.current = openHistorySession;

	useEffect(() => {
		const request = agentSessionOpenRequest;
		if (!request) return;
		if (request.agentId && request.agentId !== selectedAgentId) {
			setSelectedAgentId(request.agentId);
			// Wait for history reload after agent switch.
			return;
		}
		if (!historyLoaded) return;

		const vt = request.visualTrace;
		// Prefer stable visual-trace history id so multi-turn pin opens one session.
		const stableId = vt?.traceId
			? visualTraceHistoryId(vt.traceId)
			: request.runtimeSessionId;

		const match = sessionHistoryRef.current.find(
			(item) =>
				item.id === stableId ||
				item.id === request.runtimeSessionId ||
				item.providerSessionId === request.runtimeSessionId ||
				(request.providerSessionId != null &&
					(item.id === request.providerSessionId ||
						item.providerSessionId === request.providerSessionId)),
		);

		if (vt) {
			// Always rebuild lines from mark transcript (full multi-turn + image chip).
			const rebuilt = buildVisualTraceHistoryItem({
				trace: {
					id: vt.traceId,
					page: vt.page,
					comment: vt.comment,
					paperPath: vt.paperPath ?? "",
					image: vt.image,
					agent: {
						agentId: request.agentId,
						runtimeSessionId: request.runtimeSessionId,
						messageId: request.messageId ?? "pending",
						providerSessionId: request.providerSessionId ?? undefined,
						status: vt.status ?? "completed",
						messages: vt.messages,
						answerSnapshot: request.answerSnapshot,
					},
				},
				messages: vt.messages,
				title:
					request.title?.trim() ||
					request.prompt?.trim() ||
					t("composer.visualAnnotation"),
				agentName: selected?.name ?? t("defaultName"),
				startedAt: match?.startedAt || new Date().toLocaleString(i18n.language),
				emptyFallback: t("composer.visualAnnotation"),
				paperAbsPath: request.paperAbsPath,
			});
			// Merge into existing slot if present; drop duplicate runtime-id entries.
			setSessionHistory((prev) => {
				const withoutDupes = prev.filter(
					(item) =>
						item.id !== rebuilt.id &&
						item.id !== request.runtimeSessionId &&
						!(
							request.providerSessionId &&
							(item.id === request.providerSessionId ||
								item.providerSessionId === request.providerSessionId)
						),
				);
				return [rebuilt, ...withoutDupes];
			});
			openHistorySessionRef.current(rebuilt);
			clearAgentSessionOpenRequest();
			return;
		}

		if (match) {
			openHistorySessionRef.current(match);
			clearAgentSessionOpenRequest();
			return;
		}

		const snapshot = request.answerSnapshot?.trim();
		const fallbackLines: ChatLine[] = [
			{
				id: nextLineId("user"),
				kind: "user",
				text:
					request.prompt?.trim() ||
					request.title?.trim() ||
					t("composer.visualAnnotation"),
			},
		];
		if (snapshot) {
			fallbackLines.push({
				id: nextLineId("agent"),
				kind: "agent",
				parts: [
					{
						type: "text",
						id: nextPartId("text"),
						text: snapshot,
					},
				],
				streaming: false,
			});
		} else {
			fallbackLines.push({
				id: nextLineId("sys"),
				kind: "system",
				text: t("messages.sessionUnavailable"),
			});
		}
		const fallback: ChatSessionHistoryItem = {
			id: stableId,
			agentId: request.agentId,
			source: "local",
			title:
				request.title?.trim() ||
				request.prompt?.trim() ||
				t("composer.visualAnnotation"),
			agentName: selected?.name ?? t("defaultName"),
			startedAt: new Date().toLocaleString(i18n.language),
			lines: fallbackLines,
			status: snapshot ? "completed" : "failed",
			providerSessionId: request.providerSessionId ?? null,
		};
		setSessionHistory((prev) => [
			fallback,
			...prev.filter((item) => item.id !== fallback.id),
		]);
		openHistorySessionRef.current(fallback);
		clearAgentSessionOpenRequest();
	}, [
		agentSessionOpenRequest,
		historyLoaded,
		i18n.language,
		selected?.name,
		selectedAgentId,
		t,
		setSessionHistory,
	]);

	return {
		t,
		// Transcript
		lines,
		activeTabId,
		selected,
		activeTabIsRunning,
		submitting,
		switching,
		editingLineId,
		editingText,
		editTextareaRef,
		editCompositionProps,
		isEditBlockedByIme,
		setEditingText,
		cancelEditingMessage,
		resendEditedMessage,
		startEditingMessage,
		send,
		submitComposer,
		messageQueue,
		removeQueuedMessage,
		// History
		sessionHistory,
		historyOpen,
		setHistoryOpen,
		newConversation,
		openHistorySession,
		// Agent switcher
		options,
		selectedAgentId,
		hasRunningSessions,
		selectAgent,
		// Composer
		composerText,
		setComposerText,
		onComposerTextChangeFromUser,
		setComposerMenuDismissed,
		setMentionActiveIndex,
		setSkillActiveIndex,
		setSlashActiveIndex,
		handleComposerMenuKeyDown,
		handleComposerDragOver,
		handleComposerDrop,
		currentFilePath,
		currentFileLabel,
		mentionChipPaths,
		selectionChips,
		visualDrafts,
		removeVisualDraft,
		directoryPathSet,
		paperPathSet,
		labelForPath,
		removeContextPath,
		selectedSkills,
		setSelectedSkillIds,
		showMentionMenu,
		mentionBrowseRoot,
		mentionOptions,
		mentionActiveIndex,
		mentionCandidates,
		leaveMentionFolder,
		enterMentionFolder,
		attachMention,
		showSkillMenu,
		skillOptions,
		skillActiveIndex,
		attachSkill,
		showSlashMenu,
		slashOptions,
		slashActiveIndex,
		attachSlashCommand,
		modelSelectorOpen,
		setModelSelectorOpen,
		models,
		groupedModels,
		modelId,
		selectedModelName,
		favoriteIds,
		warming,
		pickModel,
		toggleFavorite,
		collaborationOptions,
		collaborationModeId,
		selectedCollaborationName,
		pickCollaborationMode,
		effortOptionsInDisplayOrder,
		reasoningEffort,
		setReasoningEffort,
		formatEffort,
		activeUsage,
		fastAvailable,
		fastEnabled,
		setFastEnabled,
		cancelCurrentRun,
		// Permission
		permissionRequest,
		setPermissionRequest,
		// Form elicitation (request_user_input)
		elicitationRequest,
		setElicitationRequest,
		// Grok ask-user extension
		askUserRequest,
		setAskUserRequest,
		// Tool-shaped ask promoted to composer
		toolAskUserRequest,
		setToolAskUserRequest,
		answerToolAskUser,
		// Refs used by composer submit race guards
		switchingRef,
		submittingRef,
	};
}
