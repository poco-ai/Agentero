/**
 * Agent panel session/runtime orchestrator: composes the focused sub-hooks
 * (context, config, session runtime, permission surfaces, send, message edit,
 * composer, history) and owns cross-cutting lifecycle — vault switch reset,
 * cross-window session handoff, agent switch, and new conversation.
 * UI lives in sibling components under `src/components/agent/`.
 */
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useAgentComposer } from "@/components/agent/hooks/use-agent-composer";
import { useAgentConfig } from "@/components/agent/hooks/use-agent-config";
import { useAgentHistory } from "@/components/agent/hooks/use-agent-history";
import { useAgentMessageEdit } from "@/components/agent/hooks/use-agent-message-edit";
import { useAgentPanelContext } from "@/components/agent/hooks/use-agent-panel-context";
import { useAgentPermissionSurfaces } from "@/components/agent/hooks/use-agent-permission-surfaces";
import { useAgentSend } from "@/components/agent/hooks/use-agent-send";
import { useAgentSessionRuntime } from "@/components/agent/hooks/use-agent-session-runtime";
import type { AgentPanelProps } from "@/components/agent/types";
import { useSessionComposerState } from "@/hooks/use-session-composer-state";
import {
	cancelAgentRun,
	ensureCatalogAgent,
	isChatOnlyAgentTemplate,
	openAgentLoginTerminal,
	setDefaultAgent,
} from "@/lib/agent";
import { agentChromeStore } from "@/lib/agent/agent-chrome-store";
import {
	applyAgentSessionHandoffOnce,
	getActiveLines,
	isActiveTabRunning,
	useAgentSessionScope,
	useAgentSessionStore,
} from "@/lib/agent/agent-session-store";
import {
	type AgentOption,
	buildOptions,
	type ChatLine,
	type ChatSessionHistoryItem,
	errorChatLine,
	errorText,
	resolveSelected,
} from "@/lib/agent/chat-state";
import {
	composerScopeKey,
	saveAgentComposerState,
} from "@/lib/agent/composer-state";
import { claimInteractiveRequest } from "@/lib/agent/interactive-claims";
import {
	removeVisualDraft,
	seedVisualDraftSession,
	visualDraftSessionKey,
} from "@/lib/agent/visual-context-store";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { toSafeDisposer } from "@/lib/core/tauri-events";
import {
	broadcastAgentSessionHandoff,
	listenAgentSessionHandoff,
	registerAgentHandoffReaders,
} from "@/lib/shell/workspace-broadcast";
import { currentWindowLabel } from "@/lib/workspace/store";

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
> & {
	/** Start with this harness instead of the registry default (Zen slots). */
	initialAgentId?: string | null;
	/** Report the active harness to the host surface (Zen slot rows). */
	onAgentChange?: (agent: {
		id: string;
		name: string;
		template: string | null;
	}) => void;
	/** One-shot ACP history row to load once the history probe is ready. */
	openHistoryItem?: ChatSessionHistoryItem | null;
	onOpenHistoryHandled?: () => void;
	/** Skip the per-panel ACP session import (Zen rail owns the history list). */
	suppressHistoryImport?: boolean;
};

export function useAgentPanel({
	vaultPath,
	selectedPath = null,
	selectedPaperTitle = null,
	vaultMarkdownPaths = [],
	vaultDirectoryPaths = [],
	vaultPaperPaths = [],
	paperMetaByRelPath = null,
	paperTreeLabelMode = "title-author",
	initialAgentId = null,
	onAgentChange,
	openHistoryItem = null,
	onOpenHistoryHandled,
	suppressHistoryImport = false,
}: UseAgentPanelArgs) {
	const { t, i18n } = useTranslation("agent");
	const { store: sessionStore, scopeId } = useAgentSessionScope();
	/** The shared rail store also drives app chrome and cross-window handoff. */
	const isRailScope = scopeId === null;

	const {
		selectedVaultPath,
		selectedPaperMeta,
		directoryPathSet,
		paperPathSet,
		labelForPath,
		mentionLabelsByPath,
		refs,
		resetSessionContext,
	} = useAgentPanelContext({
		vaultPath,
		selectedPath,
		selectedPaperTitle,
		vaultMarkdownPaths,
		vaultDirectoryPaths,
		vaultPaperPaths,
		paperMetaByRelPath,
		paperTreeLabelMode,
	});
	const {
		activeConversationRef,
		activeTabRef,
		selectedAgentIdRef,
		switchingRef,
		submittingRef,
		submissionGenRef,
		historyHydrationGenRef,
		knownSessionIdsRef,
		sessionHistoryRef,
		vaultPathRef,
	} = refs;

	// Shared store selectors (single source of truth for the transcript).
	// PERF: transcript lines are mirrored into a ref instead of subscribed —
	// streaming flushes swap the array identity every rAF frame, which
	// re-rendered the whole panel shell per frame. ChatTranscript owns the
	// reactive subscription; sub-hooks only read the value at render time,
	// and idle-time line writes always co-occur with a panel re-render
	// (submitting / running / hydrating flips), so closures stay fresh.
	const linesRef = useRef<ChatLine[] | null>(null);
	if (linesRef.current === null) {
		const initial = sessionStore.getState();
		linesRef.current = getActiveLines(
			initial.sessions,
			initial.activeTabId,
			initial.draftLines,
		);
		// A Zen slot can be seeded with the rail's sessions before the first
		// store event fires; claim them now so their streams keep routing here.
		if (sessionHistoryRef.current.length === 0 && initial.sessions.length > 0) {
			sessionHistoryRef.current = initial.sessions;
		}
	}
	const lines = linesRef.current;
	const setLines = useAgentSessionStore((s) => s.setLines);
	const setSessionHistory = useAgentSessionStore((s) => s.setSessions);
	const activeTabId = useAgentSessionStore((s) => s.activeTabId);
	const hydratingSessionId = useAgentSessionStore((s) => s.hydratingSessionId);
	const setActiveTabId = useAgentSessionStore((s) => s.setActiveTabId);
	const startDraft = useAgentSessionStore((s) => s.startDraft);
	const setHydratingSessionId = useAgentSessionStore(
		(s) => s.setHydratingSessionId,
	);
	const hydrateAndActivateSession = useAgentSessionStore(
		(s) => s.hydrateAndActivateSession,
	);

	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
		initialAgentId,
	);
	const [switching, setSwitching] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);

	/**
	 * Sole writer for the submitting flag: mirrors it into submittingRef for
	 * synchronous guards in event callbacks while updating render state.
	 * Never write the ref or the state directly.
	 */
	const setSubmittingFlag = useCallback(
		(value: boolean) => {
			submittingRef.current = value;
			setSubmitting(value);
		},
		[submittingRef],
	);

	const composerState = useSessionComposerState({
		vaultPath,
		agentId: selectedAgentId,
		sessionId: activeTabId,
		// Current paper/file is always in context by default (no click-to-add).
		defaultIncludeSelectedFile: true,
	});
	const {
		text: composerText,
		mentionedPaths,
		includeSelectedFile,
		activateSession: activateComposerSession,
		resetSession: resetComposerSession,
		setText: setComposerText,
		setMentionedPaths,
		setSelectedSkillIds,
		setIncludeSelectedFile,
		snapshot: snapshotComposer,
	} = composerState;

	/** Current paper/file path when included (always-on chip; no dashed + toggle). */
	const selectedFileIncluded =
		includeSelectedFile && selectedVaultPath ? selectedVaultPath : null;

	/**
	 * Mirror the sessions array into the ref for synchronous guards without
	 * re-rendering the panel: the array identity changes on every streamed
	 * chunk, so a selector subscription re-rendered the whole panel ~25×/s.
	 * Also refreshes the lines ref so the next panel render reads fresh
	 * transcript lines without a per-frame subscription.
	 */
	// biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable identity probes for the subscribe-once effect
	useEffect(
		() =>
			sessionStore.subscribe(() => {
				const state = sessionStore.getState();
				sessionHistoryRef.current = state.sessions;
				linesRef.current = getActiveLines(
					state.sessions,
					state.activeTabId,
					state.draftLines,
				);
			}),
		[sessionHistoryRef, linesRef],
	);

	/** Last-seen vault path; drives the vault-switch reset effect below. */
	const previousVaultPathRef = useRef(vaultPath);

	useEffect(() => {
		vaultPathRef.current = vaultPath;
	}, [vaultPath, vaultPathRef]);

	const {
		registry,
		catalog,
		skills,
		models,
		modelId,
		favoriteIds,
		modelSelectorOpen,
		setModelSelectorOpen,
		warming,
		setAgentListenersReady,
		usage,
		setUsage,
		usageBySession,
		setUsageBySession,
		acpCommandsByAgent,
		setAcpCommandsByAgent,
		collaborationOptions,
		collaborationModeId,
		effortOptions,
		reasoningEffort,
		pickReasoningEffort,
		fastAvailable,
		fastEnabled,
		setFastEnabled,
		applyModelsEvent,
		applyCollaborationEvent,
		applyEffortEvent,
		applyFastModeEvent,
		refresh,
		selectedModelName,
		groupedModels,
		selectedCollaborationName,
		pickCollaborationMode,
		pickModel,
		toggleFavorite,
	} = useAgentConfig({
		vaultPath,
		selectedAgentId,
		setSelectedAgentId,
		refs,
		t,
		setLines,
	});

	const options = buildOptions(registry, catalog);
	const selected = resolveSelected(options, selectedAgentId, registry);
	// PERF: depend on the primitive template id — `selected` comes from
	// buildOptions/resolveSelected with a fresh identity every render, which
	// made selectedLogin → onAgentLogin unstable and defeated
	// memo(ChatTranscript).
	const selectedTemplateId = selected?.templateId ?? selected?.template ?? null;
	// Chat-only built-in agents (Zhihu) cannot read Vault files: keep no auto
	// context so the UI matches what is actually sent (no path leakage).
	const chatOnlyAgent = isChatOnlyAgentTemplate(selected?.template);
	const contextPaths = useMemo(() => {
		if (chatOnlyAgent) return [];
		const paths = [
			...(includeSelectedFile && selectedVaultPath ? [selectedVaultPath] : []),
			...mentionedPaths,
		];
		return [...new Set(paths)];
	}, [chatOnlyAgent, includeSelectedFile, mentionedPaths, selectedVaultPath]);
	const currentFilePath = chatOnlyAgent ? null : selectedFileIncluded;
	const selectedLogin = useMemo(() => {
		const templateId = selectedTemplateId;
		if (!templateId || templateId === "custom") return null;
		const entry = catalog?.entries.find(
			(candidate) => candidate.templateId === templateId,
		);
		const command = entry?.loginCommand?.trim();
		if (!command) return null;
		return { templateId, command };
	}, [catalog, selectedTemplateId]);

	const openSelectedAgentLogin = useCallback(async () => {
		if (!selectedLogin) return;
		try {
			await openAgentLoginTerminal(selectedLogin.templateId);
			for (const delay of [2_000, 5_000, 10_000, 20_000]) {
				window.setTimeout(() => {
					// The user is waiting for the login to change the catalog.
					void refresh({ forceCatalog: true });
				}, delay);
			}
		} catch (error) {
			notifyError(errorText(error));
		}
	}, [selectedLogin, refresh]);

	// Keep app chrome (title bar, mobile nav, …) in sync with the active agent;
	// other surfaces (Zen slots) only report their own harness upstream.
	const selectedId = selected?.id ?? null;
	const selectedName = selected?.name ?? null;
	const selectedTemplate = selected?.template ?? null;
	useEffect(() => {
		if (!selectedId) return;
		onAgentChange?.({
			id: selectedId,
			name: selectedName ?? selectedId,
			template: selectedTemplate,
		});
		if (!isRailScope) return;
		agentChromeStore.setState({
			agentId: selectedId,
			name: selectedName ?? selectedId,
			template: selectedTemplate,
		});
	}, [isRailScope, onAgentChange, selectedId, selectedName, selectedTemplate]);

	const activeTabIsRunning = useAgentSessionStore(isActiveTabRunning);
	const activeUsage = usageBySession[activeTabId] ?? usage;
	// Primitive selector: the sessions array identity changes per streamed
	// chunk, so subscribe to the boolean the UI actually needs.
	const hasRunningSessions = useAgentSessionStore((s) =>
		s.sessions.some((session) => session.status === "running"),
	);

	const runtime = useAgentSessionRuntime({
		refs,
		t,
		setSessionHistory,
		applyModelsEvent,
		applyCollaborationEvent,
		applyEffortEvent,
		applyFastModeEvent,
		setUsage,
		setUsageBySession,
		setAcpCommandsByAgent,
		setAgentListenersReady,
	});
	const {
		toolAskUserRequest,
		setToolAskUserRequest,
		isChatOwnedSession,
		phaseBySession,
	} = runtime;

	const {
		permissionRequest,
		setPermissionRequest,
		elicitationRequest,
		setElicitationRequest,
		askUserRequest,
		setAskUserRequest,
	} = useAgentPermissionSurfaces({
		toolAskUserRequest,
		setToolAskUserRequest,
		ownsSession: isChatOwnedSession,
	});

	/** Request-shaping context for the send pipeline (agent/model selection). */
	const turnConfig = {
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
	};

	const {
		send,
		submitComposer,
		messageQueue,
		removeQueuedMessage,
		clearMessageQueue,
		replaceMessageQueue,
		cancelCurrentRun,
		answerToolAskUser,
		recordAskUserAnswers,
	} = useAgentSend({
		refs,
		t,
		i18nLanguage: i18n.language,
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
		composer: composerState,
		turnConfig,
		runtime,
	});

	const {
		editingLineId,
		editingText,
		setEditingText,
		editTextareaRef,
		editCompositionProps,
		isEditBlockedByIme,
		startEditingMessage,
		cancelEditingMessage,
		resendEditedMessage,
	} = useAgentMessageEdit({
		refs,
		activeTabId,
		activeTabIsRunning,
		lines,
		send,
	});

	const {
		setComposerMenuDismissed,
		setMentionActiveIndex,
		setSkillActiveIndex,
		setSlashActiveIndex,
		currentFileLabel,
		mentionChipPaths,
		visualDrafts,
		removeContextPath,
		selectedSkills,
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
		removeSkill,
		showSlashMenu,
		slashOptions,
		slashActiveIndex,
		attachSlashCommand,
		handleComposerMenuKeyDown,
		handleComposerDragOver,
		handleComposerDrop,
		onComposerTextChangeFromUser,
		composerInputRef,
	} = useAgentComposer({
		refs,
		composer: composerState,
		vaultPath,
		vaultMarkdownPaths,
		vaultDirectoryPaths,
		vaultPaperPaths,
		selectedPaperTitle,
		selectedVaultPath,
		paperPathSet,
		labelForPath,
		mentionLabelsByPath,
		contextPaths,
		currentFilePath,
		skills,
		acpCommandsByAgent,
		selectedAgentId,
		sessionId: activeTabId,
		lines,
		activeTabIsRunning,
		cancelCurrentRun,
	});

	// Vault switch: cancel running sessions and reset the whole panel context.
	useEffect(() => {
		if (previousVaultPathRef.current === vaultPath) return;
		previousVaultPathRef.current = vaultPath;
		for (const session of sessionHistoryRef.current) {
			if (session.status === "running") {
				void cancelAgentRun(session.id).catch(() => undefined);
			}
		}
		resetSessionContext();
		submissionGenRef.current += 1;
		setSubmittingFlag(false);
		setLines([]);
		setSessionHistory([]);
		setUsage(null);
		setUsageBySession({});
		setHistoryOpen(false);
		setComposerMenuDismissed(false);
		setMentionActiveIndex(0);
		setSkillActiveIndex(0);
		setActiveTabId("draft");
		setHydratingSessionId(null);
		activeTabRef.current = "draft";
		activeConversationRef.current = null;
		clearMessageQueue();
	}, [
		vaultPath,
		clearMessageQueue,
		setLines,
		setSessionHistory,
		setActiveTabId,
		setHydratingSessionId,
		resetSessionContext,
		setUsage,
		setUsageBySession,
		setComposerMenuDismissed,
		setMentionActiveIndex,
		setSkillActiveIndex,
		activeTabRef,
		setSubmittingFlag,
		activeConversationRef,
		submissionGenRef,
		sessionHistoryRef.current,
	]);

	// Publish unsent composer / queue / asks so a popout snapshot can copy them.
	// localStorage is per webview, so the payload is the copy the feature window gets.
	const handoffLiveRef = useRef({
		queue: messageQueue,
		elicitationRequest,
		askUserRequest,
		selectedAgentId,
	});
	handoffLiveRef.current = {
		queue: messageQueue,
		elicitationRequest,
		askUserRequest,
		selectedAgentId,
	};
	useEffect(() => {
		if (!isRailScope) return;
		registerAgentHandoffReaders({
			composerText: () => snapshotComposer().text,
			mentions: () => snapshotComposer().mentionedPaths,
			skillIds: () => snapshotComposer().selectedSkillIds,
			includeSelectedFile: () => snapshotComposer().includeSelectedFile,
			queue: () => handoffLiveRef.current.queue,
			elicitationRequest: () => handoffLiveRef.current.elicitationRequest,
			askUserRequest: () => handoffLiveRef.current.askUserRequest,
			selectedAgentId: () => handoffLiveRef.current.selectedAgentId,
		});
	}, [isRailScope, snapshotComposer]);

	// Cross-window handoff. The store write happens once (root or this listener).
	// This listener does not apply again when the root already accepted the snapshot.
	useEffect(() => {
		if (!isRailScope) return;
		return toSafeDisposer(
			listenAgentSessionHandoff((payload) => {
				if (payload.kind !== "snapshot") return;
				// The main window hears its own broadcast. Applying it here would
				// roll the live rail back to the frozen frame.
				if (payload.targetLabel !== currentWindowLabel()) return;
				if (!applyAgentSessionHandoffOnce(payload)) return;
				broadcastAgentSessionHandoff({
					kind: "ack",
					deliveryId: payload.deliveryId,
					sourceLabel: payload.sourceLabel,
					targetLabel: payload.targetLabel,
				});
			}),
		);
	}, [isRailScope]);

	const handoff = useAgentSessionStore((s) => s.handoff);
	const handoffConsumedRef = useRef<string | null>(null);
	useLayoutEffect(() => {
		if (!isRailScope || !handoff) return;
		if (handoff.targetLabel !== currentWindowLabel()) return;
		if (handoffConsumedRef.current === handoff.deliveryId) return;
		handoffConsumedRef.current = handoff.deliveryId;
		const tabId = handoff.localSessionId || "draft";
		const agentId = handoff.agentId;
		const scopeKey = composerScopeKey(vaultPath, agentId, null);
		seedVisualDraftSession(
			visualDraftSessionKey(scopeKey, tabId),
			handoff.visualRefs,
		);
		if (scopeKey) {
			try {
				const storage =
					typeof localStorage === "undefined" ? null : localStorage;
				if (storage) {
					saveAgentComposerState(storage, scopeKey, tabId, {
						text: handoff.composerText,
						mentionedPaths: handoff.mentions,
						selectedSkillIds: handoff.composerSkillIds,
						includeSelectedFile: handoff.includeSelectedFile,
					});
				}
			} catch {
				// The in-memory composer below still shows the unsent draft.
			}
		}
		if (agentId) {
			setSelectedAgentId(agentId);
			selectedAgentIdRef.current = agentId;
		}
		// activate reloads this webview's storage (empty until the save above).
		// Field setters run after it so the snapshot wins that batched update.
		activateComposerSession(tabId);
		setComposerText(handoff.composerText);
		setMentionedPaths(handoff.mentions);
		setSelectedSkillIds(handoff.composerSkillIds);
		setIncludeSelectedFile(handoff.includeSelectedFile);
		replaceMessageQueue(handoff.queue);
		activeTabRef.current = tabId;
		activeConversationRef.current = tabId === "draft" ? null : tabId;
		knownSessionIdsRef.current = new Set(
			sessionStore.getState().sessions.map((session) => session.id),
		);
		if (handoff.permissionRequestId) {
			claimInteractiveRequest(handoff.permissionRequestId);
		}
		if (handoff.elicitationRequest) {
			claimInteractiveRequest(handoff.elicitationRequest.requestId);
			setElicitationRequest(handoff.elicitationRequest);
		}
		if (handoff.askUserRequest) {
			claimInteractiveRequest(handoff.askUserRequest.requestId);
			setAskUserRequest(handoff.askUserRequest);
		}
	}, [
		activateComposerSession,
		activeConversationRef,
		activeTabRef,
		handoff,
		isRailScope,
		knownSessionIdsRef,
		replaceMessageQueue,
		selectedAgentIdRef,
		sessionStore,
		setAskUserRequest,
		setComposerText,
		setElicitationRequest,
		setIncludeSelectedFile,
		setMentionedPaths,
		setSelectedSkillIds,
		vaultPath,
	]);

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
			resetSessionContext();
			selectedAgentIdRef.current = agentId;
			activeConversationRef.current = null;
			activateComposerSession("draft");
			activeTabRef.current = "draft";
			setActiveTabId("draft");
			setHydratingSessionId(null);
			setLines([]);
			setSessionHistory([]);
			clearMessageQueue();
			setSelectedAgentId(agentId);
			await refresh({ forceCatalog: true });
		} catch (e) {
			setLines((p) => [...p, errorChatLine(errorText(e))]);
		} finally {
			switchingRef.current = false;
			setSwitching(false);
		}
	};

	const newConversation = () => {
		if (submittingRef.current) return;
		historyHydrationGenRef.current += 1;
		startDraft();
		resetComposerSession("draft");
		activeTabRef.current = "draft";
		activeConversationRef.current = null;
		clearMessageQueue();
	};

	const { openHistorySession, removeHistorySession } = useAgentHistory({
		refs,
		t,
		i18nLanguage: i18n.language,
		vaultPath,
		selectedAgentId,
		selected,
		setSessionHistory,
		setLines,
		hydrateAndActivateSession,
		setHydratingSessionId,
		activateComposerSession,
		setHistoryOpen,
		historyOpen,
		clearMessageQueue,
		importHistory: !suppressHistoryImport,
	});

	// Zen history rows: load straight away (the agent is known from the slot),
	// and keep the pending row until a load actually starts so a registry that
	// is still resolving retries instead of landing on an empty conversation.
	const openHistorySessionRef = useRef(openHistorySession);
	openHistorySessionRef.current = openHistorySession;
	const onOpenHistoryHandledRef = useRef(onOpenHistoryHandled);
	onOpenHistoryHandledRef.current = onOpenHistoryHandled;
	// biome-ignore lint/correctness/useExhaustiveDependencies: submitting is a retry trigger; the load reads it through refs
	useEffect(() => {
		if (!openHistoryItem || !selectedAgentId) return;
		if (!openHistorySessionRef.current(openHistoryItem)) return;
		onOpenHistoryHandledRef.current?.();
	}, [openHistoryItem, selectedAgentId, submitting]);

	return {
		t,
		// Transcript (lines are owned by ChatTranscript's store subscription)
		selectedPaperMeta,
		activeTabId,
		hydratingSessionId,
		selected,
		activeTabIsRunning,
		/** Loading phase of the active tab's in-flight turn (starting / waiting / reconnecting). */
		activePhase: phaseBySession[activeTabId] ?? null,
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
		openSelectedAgentLogin,
		selectedLogin,
		send,
		submitComposer,
		messageQueue,
		removeQueuedMessage,
		// History
		historyOpen,
		setHistoryOpen,
		newConversation,
		openHistorySession,
		removeHistorySession,
		// Agent switcher
		options,
		selectedAgentId,
		hasRunningSessions,
		selectAgent,
		// Composer
		composerText,
		setComposerText,
		onComposerTextChangeFromUser,
		composerInputRef,
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
		removeSkill,
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
		effortOptions,
		reasoningEffort,
		pickReasoningEffort,
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
		recordAskUserAnswers,
		// Refs used by composer submit race guards
		switchingRef,
		submittingRef,
	};
}
