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
import { useImeGuard } from "@/hooks/use-ime-guard";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import { useSessionComposerState } from "@/hooks/use-session-composer-state";
import {
	type AgentEffortChoice,
	type AgentListResponse,
	type AgentModelChoice,
	type AgentPlanEvent,
	type AgentResultPayload,
	type AgentSkill,
	type AgentStreamEvent,
	type AgentToolEvent,
	type CatalogScanResponse,
	cancelAgentRun,
	ensureCatalogAgent,
	listAgentSkills,
	listAgents,
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
	loadModelCatalog,
	loadModelFavorites,
	loadModelPref,
	loadSession,
	type PermissionRequest,
	respondPermission,
	runOnce,
	saveModelCatalog,
	saveModelFavorites,
	saveModelPref,
	scanCatalog,
	setDefaultAgent,
	warmAgent,
} from "@/lib/agent";
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
	errorChatLine,
	errorText,
	isBackgroundWorkflowHistoryTitle,
	mapToolStatus,
	nextLineId,
	nextPartId,
	type PendingSessionEvent,
	type PendingTerminalEvent,
	resolveSelected,
	upsertPlanPart,
} from "@/lib/agent/chat-state";
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
	buildSlashCommands,
	filterSlashCommands,
	type SlashCommand,
	skillMentionStyleForTemplate,
} from "@/lib/agent/slash-commands";
import {
	classifyStreamChunk,
	promoteOrphanThoughtToText,
	ThinkTagParser,
} from "@/lib/agent/stream-parse";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { isImeKeyboardEvent } from "@/lib/core/ime";
import { isTauri } from "@/lib/core/tauri";
import { paperDirFromPath } from "@/lib/paper";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import { loadSettings } from "@/lib/settings";
import {
	collectUserPromptTexts,
	nextHistoryIndexOnDown,
	nextHistoryIndexOnUp,
	placeCaretAtEnd,
	shouldNavigateHistoryDown,
	shouldNavigateHistoryUp,
} from "@/lib/ui/prompt-recall";
import { toVaultRelative } from "@/lib/wiki";

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
	| "variant"
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
	variant = "sidebar",
}: UseAgentPanelArgs) {
	const isZen = variant === "zen";
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
	const [lines, setLines] = useState<ChatLine[]>([]);
	const [sessionHistory, setSessionHistory] = useState<
		ChatSessionHistoryItem[]
	>([]);
	const [switching, setSwitching] = useState(false);
	const [usage, setUsage] = useState<{ used: number; size: number } | null>(
		null,
	);
	const [usageBySession, setUsageBySession] = useState<
		Record<string, { used: number; size: number }>
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
	const [effortOptions, setEffortOptions] = useState<AgentEffortChoice[]>([]);
	const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
	const [fastAvailable, setFastAvailable] = useState(false);
	const [fastEnabled, setFastEnabled] = useState(false);
	const [composerMenuDismissed, setComposerMenuDismissed] = useState(false);
	const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
	const [skillActiveIndex, setSkillActiveIndex] = useState(0);
	const [slashActiveIndex, setSlashActiveIndex] = useState(0);
	const [activeTabId, setActiveTabId] = useState("draft");
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
			if (ev.models.length === 0) return;
			// Defense in depth: host already dedupes; keep unique by id then name.
			const models = dedupeModelsClient(ev.models);
			saveModelCatalog(ev.agentId, {
				configId: ev.configId,
				currentId: ev.currentId,
				models,
			});
			const cur = selectedAgentIdRef.current;
			if (cur && cur !== ev.agentId) return;
			setModels(models);
			setModelId((prev) => {
				const pref = loadModelPref(ev.agentId);
				if (pref && models.some((m) => m.id === pref)) return pref;
				if (prev && models.some((m) => m.id === prev)) return prev;
				return ev.currentId || models[0]?.id || null;
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
	}, [vaultPath]);

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
	}, [vaultPath, clearMessageQueue]);

	// Restore last model catalog / preference for the selected agent.
	useEffect(() => {
		selectedAgentIdRef.current = selectedAgentId;
		historyHydrationGenRef.current += 1;
		if (!selectedAgentId) {
			setModels([]);
			setModelId(null);
			setFavoriteIds([]);
			setEffortOptions([]);
			setReasoningEffort(null);
			setFastAvailable(false);
			setFastEnabled(false);
			setUsage(null);
			setUsageBySession({});
			return;
		}
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
			const models = dedupeModelsClient(catalog.models);
			setModels(models);
			const preferred =
				(pref && models.some((m) => m.id === pref) && pref) ||
				(catalog.currentId &&
					models.some((m) => m.id === catalog.currentId) &&
					catalog.currentId) ||
				models[0]?.id ||
				null;
			setModelId(preferred);
		} else {
			setModels([]);
			setModelId(pref);
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
		const gen = ++warmGenRef.current;
		let cancelled = false;
		const agentId = selectedAgentId;
		const requestVaultPath = vaultPath;
		void runWarmAgent({
			agentId,
			vaultPath: requestVaultPath,
			modelId: loadModelPref(agentId) ?? undefined,
			generation: gen,
			stillValid: () =>
				!cancelled &&
				selectedAgentIdRef.current === agentId &&
				vaultPathRef.current === requestVaultPath,
		});
		return () => {
			cancelled = true;
		};
	}, [selectedAgentId, vaultPath, runWarmAgent, agentListenersReady]);

	const updateSessionLines = useCallback(
		(sessionId: string, update: (lines: ChatLine[]) => ChatLine[]) => {
			// Compute once per session entry so concurrent tabs never share an
			// updater applied against the wrong `lines` snapshot (tab-switch race).
			setSessionHistory((prev) => {
				const idx = prev.findIndex((item) => item.id === sessionId);
				if (idx < 0) return prev;
				const newLines = update(prev[idx].lines);
				if (newLines === prev[idx].lines) return prev;
				const next = prev.slice();
				next[idx] = { ...prev[idx], lines: newLines };
				return next;
			});
			// Sync active transcript only if still viewing this session.
			// Use a value (not a second updater) so a late flush after tab switch
			// cannot append another session's stream chunks into the new view.
			if (activeTabRef.current === sessionId) {
				setLines((prev) => {
					if (activeTabRef.current !== sessionId) return prev;
					return update(prev);
				});
			}
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

	const completeSession = useCallback(
		(ev: AgentResultPayload) => {
			if (!isChatOwnedSession(ev.sessionId)) return;
			if (ev.providerSessionId) {
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
		},
		[isChatOwnedSession, t, updateSessionLines],
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
		},
		[isChatOwnedSession, updateSessionLines],
	);

	const shouldDeferTerminalEvent = useCallback((sessionId: string) => {
		if (!submittingRef.current) return false;
		const expectedSessionId = pendingSubmissionSessionIdRef.current;
		return (
			expectedSessionId === sessionId ||
			(expectedSessionId === null && !knownSessionIdsRef.current.has(sessionId))
		);
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
			const uModels = await listenAgentModels((ev) => {
				applyModelsEvent(ev);
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
				uModels();
				uEffort();
				uFast();
				u2();
				u3();
				return;
			}
			unsubs.push(u1, uTool, uPlan, uUsage, uModels, uEffort, uFast, u2, u3);
			setAgentListenersReady(true);
		})();

		return () => {
			cancelled = true;
			for (const u of unsubs) u();
		};
	}, [
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

	const loadAgentHistory = useCallback(async () => {
		if (!isTauri() || !selectedAgentId) return;
		const generation = ++historyGenRef.current;
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
				const existing = new Map(
					prev
						.filter((item) => item.agentId === selectedAgentId)
						.map((item) => [item.id, item]),
				);
				const imported = chatSessions.map((session) => {
					const current = existing.get(session.sessionId);
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
						!isBackgroundWorkflowHistoryTitle(item.title) &&
						(item.status === "running" ||
							(item.source === "local" && item.lines.length > 0)),
				);
				return [...localOnly, ...imported];
			});
		} catch {
			// History is supplementary: a failed scan must not block the Composer.
		}
	}, [i18n.language, selected?.name, selectedAgentId, vaultPath]);

	useEffect(() => {
		void loadAgentHistory();
		return () => {
			historyGenRef.current += 1;
		};
	}, [loadAgentHistory]);

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
	const slashCommands = useMemo(
		() =>
			buildSlashCommands(skills, {
				skillMentionStyle: skillMentionStyleForTemplate(selected?.template),
			}),
		[skills, selected?.template],
	);
	const slashOptions = useMemo(() => {
		if (!slashMatch) return [];
		return filterSlashCommands(slashCommands, slashQuery, {
			hasContext: contextPaths.length > 0,
			selectedSkillIds,
		});
	}, [
		contextPaths.length,
		selectedSkillIds,
		slashCommands,
		slashMatch,
		slashQuery,
	]);

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
		setModelSelectorOpen(false);
		setModelId(id);
		if (!selectedAgentId) return;
		saveModelPref(selectedAgentId, id);
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
			modelId: id,
			generation,
			stillValid: () =>
				selectedAgentIdRef.current === agentId &&
				vaultPathRef.current === requestVaultPath &&
				loadModelPref(agentId) === id,
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

	const permissionRequestRef = useRef(permissionRequest);
	permissionRequestRef.current = permissionRequest;
	useOverlayRegistration("agent-permission", permissionRequest !== null, () => {
		const req = permissionRequestRef.current;
		if (!req) return;
		void respondPermission(req.requestId, null);
		setPermissionRequest(null);
	});

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

	type SendOptions = {
		baseLines?: ChatLine[];
		workflow?: string;
		/** Frozen context from a waitlisted follow-up (else live composer). */
		contextPaths?: string[];
		skillIds?: string[];
		/** When true, do not wipe the live composer (already cleared on enqueue). */
		fromQueue?: boolean;
	};

	const send = async (
		textRaw: string,
		options?: SendOptions,
	): Promise<boolean> => {
		const text = textRaw.trim();
		if (
			!text ||
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
		const resolvedSkillIds =
			options?.skillIds ?? submittedComposerState.selectedSkillIds;
		const submissionGeneration = ++submissionGenRef.current;
		const sessionContextGeneration = sessionContextGenRef.current;
		const requestVaultPath = vaultPath;
		submittingRef.current = true;
		setSubmitting(true);
		try {
			if (!isTauri()) {
				setLines((p) => [...p, errorChatLine(t("messages.desktopOnly"))]);
				return false;
			}

			let agentId = selected?.id ?? registry?.defaultId ?? null;
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

			// Options are availability-filtered in buildOptions; unavailable agents
			// never appear in the switcher.
			const prompt = resolvedContextPaths.length
				? `${text}\n\n${t("composer.contextInstruction")}\n${resolvedContextPaths
						.map((path) => `- ${path}`)
						.join("\n")}`
				: text;
			// Workflow suggestions act on the focused paper / mentioned paths so
			// “Summarize” targets the open paper even without an explicit @mention.
			const workflow = options?.workflow;
			const workflowTarget = workflow
				? (resolvedContextPaths[0] ?? selectedVaultPath ?? undefined)
				: resolvedContextPaths[0];
			const userLine: ChatLine = { id: nextLineId("user"), kind: "user", text };
			const sessionStartLines = [...(options?.baseLines ?? lines), userLine];
			setLines(sessionStartLines);
			pendingSubmissionSessionIdRef.current = supportsResume
				? activeConversationRef.current
				: null;
			const accepted = await runOnce({
				agentId,
				sessionId: supportsResume
					? (activeConversationRef.current ?? undefined)
					: undefined,
				prompt,
				vaultPath: vaultPath ?? undefined,
				workflow: workflow ?? "free",
				target: workflowTarget,
				modelId: modelId ?? undefined,
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
			activeTabRef.current = accepted.sessionId;
			setActiveTabId(accepted.sessionId);
			setSessionHistory((prev) => [
				{
					id: accepted.sessionId,
					agentId,
					source: "local",
					title: text,
					agentName: selected?.name ?? t("defaultName"),
					startedAt: new Date().toLocaleString(i18n.language),
					lines: historyLines,
					status: "running",
				},
				...prev.filter((item) => item.id !== accepted.sessionId),
			]);
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
			}
		}
	};

	const enqueueMessage = useCallback(
		(textRaw: string, workflow?: string): boolean => {
			const text = textRaw.trim();
			if (!text || switchingRef.current) return false;
			const snap = snapshotComposerState();
			const paths = [
				...(snap.includeSelectedFile && selectedVaultPath
					? [selectedVaultPath]
					: []),
				...snap.mentionedPaths,
			];
			const item: QueuedPrompt = {
				id: nextLineId("queue"),
				text,
				workflow,
				contextPaths: paths,
				skillIds: [...snap.selectedSkillIds],
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
	): Promise<void> => {
		if (switchingRef.current || submittingRef.current) return;
		resetPromptHistoryBrowse();
		if (activeTabIsRunning) {
			enqueueMessage(textRaw, workflow);
			return;
		}
		await send(textRaw, { workflow });
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
		const baseLines = lines.slice(0, index);
		setEditingLineId(null);
		setEditingText("");
		await send(text, { baseLines });
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

	const clearConversation = useCallback(() => {
		setLines([]);
		resetComposerSession("draft");
		setActiveTabId("draft");
		activeTabRef.current = "draft";
		activeConversationRef.current = null;
		clearMessageQueue();
	}, [clearMessageQueue, resetComposerSession]);

	const copyLastReply = useCallback(async () => {
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (line.kind !== "agent") continue;
			const text = agentTextFromParts(line.parts).trim();
			if (!text) continue;
			await copyTextToClipboard(text);
			return;
		}
	}, [lines]);

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
			if (event.key === "Enter") {
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
		setLines([]);
		resetComposerSession("draft");
		setActiveTabId("draft");
		activeTabRef.current = "draft";
		activeConversationRef.current = null;
		clearMessageQueue();
	};

	const newConversationRef = useRef(newConversation);
	newConversationRef.current = newConversation;
	const cancelCurrentRunRef = useRef(cancelCurrentRun);
	cancelCurrentRunRef.current = cancelCurrentRun;

	const attachSlashCommand = useCallback(
		(command: SlashCommand) => {
			setComposerMenuDismissed(true);
			if (command.kind === "action") {
				void command.run?.({
					newConversation: () => newConversationRef.current(),
					clearConversation,
					cancelRun: () => void cancelCurrentRunRef.current(),
					copyLastReply,
				});
				setComposerText((prev) =>
					prev.replace(
						/(^|\s)\/[^\s]*$/,
						(_match, prefix: string) => `${prefix}`,
					),
				);
				return;
			}
			const skillId = command.skillId;
			if (skillId) {
				setSelectedSkillIds((prev) => [...new Set([...prev, skillId])]);
			}
			const template = command.template ?? "";
			setComposerText((prev) =>
				prev.replace(
					/(^|\s)\/[^\s]*$/,
					(_match, prefix: string) => `${prefix}${template}`,
				),
			);
		},
		[clearConversation, copyLastReply, setSelectedSkillIds, setComposerText],
	);

	/** Strip Host/Codex machine envelopes so Chat never shows system preamble. */
	const sanitizeChatLines = (raw: ChatLine[]): ChatLine[] =>
		raw
			.map((line) => {
				if (line.kind !== "user") return line;
				const text = stripPromptEnvelopeForDisplay(line.text);
				return text ? { ...line, text } : null;
			})
			.filter((line): line is ChatLine => line !== null);

	const openHistorySession = (item: ChatSessionHistoryItem) => {
		if (submittingRef.current) return;
		const hydrationGeneration = ++historyHydrationGenRef.current;
		setHistoryOpen(false);
		clearMessageQueue();
		if (!supportsResume || item.lines.length > 0) {
			activateComposerSession(item.id);
			setLines(sanitizeChatLines(item.lines));
			activeTabRef.current = item.id;
			setActiveTabId(item.id);
			if (supportsResume) {
				activeConversationRef.current = item.providerSessionId ?? item.id;
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
					sessionId: item.id,
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
				setSessionHistory((prev) =>
					prev.map((entry) =>
						entry.id === item.id && entry.agentId === requestAgentId
							? {
									...entry,
									title: titleFromBody,
									lines: nextLines,
								}
							: entry,
					),
				);
				activeConversationRef.current = item.providerSessionId ?? item.id;
				activateComposerSession(item.id);
				activeTabRef.current = item.id;
				setActiveTabId(item.id);
				setLines(nextLines);
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

	return {
		isZen,
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
		// Refs used by composer submit race guards
		switchingRef,
		submittingRef,
	};
}
