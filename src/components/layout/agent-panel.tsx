import {
	Check,
	CheckIcon,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	CopyIcon,
	History,
	Pencil,
	Plus,
	Settings,
	Star,
	X,
	Zap,
} from "lucide-react";
import {
	type KeyboardEvent,
	type DragEvent as ReactDragEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	Checkpoint,
	CheckpointIcon,
	CheckpointTrigger,
} from "@/components/ai-elements/checkpoint";
import {
	Context,
	ContextContent,
	ContextContentHeader,
	ContextTrigger,
} from "@/components/ai-elements/context";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
	InlineCitation,
	InlineCitationCard,
	InlineCitationCardBody,
	InlineCitationCardTrigger,
	InlineCitationCarousel,
	InlineCitationCarouselContent,
	InlineCitationCarouselHeader,
	InlineCitationCarouselIndex,
	InlineCitationCarouselItem,
	InlineCitationCarouselNext,
	InlineCitationCarouselPrev,
	InlineCitationSource,
} from "@/components/ai-elements/inline-citation";
import {
	Message,
	MessageAction,
	MessageActions,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	ModelSelector,
	ModelSelectorContent,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorInput,
	ModelSelectorItem,
	ModelSelectorList,
	ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
	Plan,
	PlanAction,
	PlanContent,
	PlanDescription,
	PlanHeader,
	PlanTitle,
	PlanTrigger,
} from "@/components/ai-elements/plan";
import {
	PromptInput,
	PromptInputBody,
	PromptInputButton,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
} from "@/components/ai-elements/prompt-input";
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
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
	Tool,
	ToolContent,
	ToolHeader,
	ToolInput,
	ToolOutput,
} from "@/components/ai-elements/tool";
import { NotesReviewDiff } from "@/components/layout/notes-review-diff";
import { PaneHeader } from "@/components/layout/pane-header";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
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
	type NotesReview,
	type PermissionRequest,
	respondPermission,
	revertNote,
	runOnce,
	saveModelCatalog,
	saveModelFavorites,
	saveModelPref,
	scanCatalog,
	setDefaultAgent,
	warmAgent,
} from "@/lib/agent";
import {
	buildMentionCandidatePaths,
	filterMentionOptions,
	loadRecentMentionPaths,
	mentionParentPath,
	mentionPathHasChildren,
	pushRecentMentionPath,
} from "@/lib/agent-mention";
import {
	type AgentOption,
	buildOptions,
	isBackgroundWorkflowHistoryTitle,
	resolveSelected,
	SUGGESTION_KEYS,
	SUGGESTION_WORKFLOW,
} from "@/lib/agent-options";
import {
	type AgentPart,
	agentHasContent,
	agentReasoningFromParts,
	agentTextFromParts,
	appendStreamPart,
	applyToolToParts,
	dedupeModelsClient,
	nextPartId,
	toolPartState,
	upsertPlanPart,
} from "@/lib/agent-parts";
import {
	displayHistoryTitle,
	stripPromptEnvelopeForDisplay,
} from "@/lib/agent-prompt-display";
import {
	classifyStreamChunk,
	promoteOrphanThoughtToText,
	ThinkTagParser,
} from "@/lib/agent-stream-parse";
import {
	contextPathDisplayName,
	contextPathIcon,
	contextPathLabel,
	normalizeContextPath,
	toPathSet,
} from "@/lib/context-path-icon";
import {
	type PaperMetadata,
	type PaperTreeLabelMode,
	paperDirFromPath,
} from "@/lib/paper-metadata";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/papers-api";
import { loadSettings } from "@/lib/settings";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { toVaultRelative } from "@/lib/wiki";

type AgentPanelProps = {
	vaultPath: string | null;
	selectedPath?: string | null;
	/**
	 * Catalog title for the focused paper (chip label prefers this over folder name).
	 */
	selectedPaperTitle?: string | null;
	vaultMarkdownPaths?: string[];
	/**
	 * Vault-relative directory paths from the file tree.
	 * Used so context chips show a folder icon for org / notes dirs.
	 */
	vaultDirectoryPaths?: string[];
	/**
	 * Vault-relative **paper** folder paths (marker-based under `papers/`).
	 * Chips use the same ScrollText paper icon as the file tree.
	 */
	vaultPaperPaths?: string[];
	/**
	 * Catalog rows by vault-relative paper path — same source as the file tree.
	 * Used so `@` / chips show paper titles per `paperTreeLabelMode`.
	 */
	paperMetaByRelPath?: ReadonlyMap<string, PaperMetadata> | null;
	/** Settings → General: paper labels in file tree (display-only). */
	paperTreeLabelMode?: PaperTreeLabelMode;
	className?: string;
	headerActions?: ReactNode;
	autoFocus?: boolean;
	title?: string;
	/**
	 * `sidebar` — right rail chat (default).
	 * `zen` — full-workbench focus: centered conversation column (AI Elements layout).
	 */
	variant?: "sidebar" | "zen";
	/** Open Settings → Agent (ACP backend registry). */
	onOpenAgentSettings?: () => void;
};

/** Shared chip / mention-row icon (paper / folder / typed file). */
function ContextPathIcon({
	path,
	directoryPaths,
	paperPaths,
}: {
	path: string;
	directoryPaths: ReadonlySet<string>;
	paperPaths: ReadonlySet<string>;
}) {
	const Icon = contextPathIcon(path, { directoryPaths, paperPaths });
	return (
		<Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
	);
}

type ChatLine =
	| { id: string; kind: "user"; text: string }
	| {
			id: string;
			kind: "agent";
			parts: AgentPart[];
			sources?: string[];
			streaming?: boolean;
	  }
	| { id: string; kind: "error"; text: string }
	| { id: string; kind: "system"; text: string };

type ChatSessionHistoryItem = {
	id: string;
	agentId: string;
	source: "local" | "indexed" | "external";
	title: string;
	agentName: string;
	startedAt: string;
	lines: ChatLine[];
	status: "running" | "completed" | "cancelled" | "failed";
};

type PendingTerminalEvent =
	| { kind: "completed"; event: AgentResultPayload }
	| { kind: "failed"; error: string };

type PendingSessionEvent =
	| { kind: "stream"; event: AgentStreamEvent }
	| { kind: "tool"; event: AgentToolEvent }
	| { kind: "plan"; event: AgentPlanEvent };

let chatLineSeq = 0;
function nextLineId(prefix: string) {
	chatLineSeq += 1;
	return `${prefix}-${chatLineSeq}`;
}

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		// ignore
	}
}

export function AgentPanel({
	vaultPath,
	selectedPath = null,
	selectedPaperTitle = null,
	vaultMarkdownPaths = [],
	vaultDirectoryPaths = [],
	vaultPaperPaths = [],
	paperMetaByRelPath = null,
	paperTreeLabelMode = "title-author",
	className,
	headerActions,
	autoFocus = false,
	title = "Chat",
	variant = "sidebar",
	onOpenAgentSettings,
}: AgentPanelProps) {
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
	const [activeTabId, setActiveTabId] = useState("draft");
	// Inline edit-and-resend of a sent user message (only when not running).
	const [editingLineId, setEditingLineId] = useState<string | null>(null);
	const [editingText, setEditingText] = useState("");
	const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
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
			setLines((prev) => [
				...prev,
				{
					id: nextLineId("err"),
					kind: "error",
					text: e instanceof Error ? e.message : String(e),
				},
			]);
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
		vaultPathRef.current = vaultPath;
	}, [vaultPath]);

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
	}, [vaultPath]);

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

	// When Chat opens (or agent/vault changes), warm ACP in the background for models/context.
	useEffect(() => {
		if (!isTauri() || !selectedAgentId || !agentListenersReady) return;
		const gen = ++warmGenRef.current;
		let cancelled = false;
		setWarming(true);
		void (async () => {
			try {
				const pref = loadModelPref(selectedAgentId) ?? undefined;
				const result = await warmAgent({
					agentId: selectedAgentId,
					vaultPath: vaultPath ?? undefined,
					modelId: pref,
				});
				if (cancelled || gen !== warmGenRef.current) return;
				if (result.models) {
					applyModelsEvent(result.models);
				}
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
				if (!cancelled && gen === warmGenRef.current) setWarming(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [selectedAgentId, vaultPath, applyModelsEvent, agentListenersReady]);

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
			if (ev.providerSessionId && activeTabRef.current === ev.sessionId) {
				activeConversationRef.current = ev.providerSessionId;
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
			const failedLine: ChatLine = {
				id: nextLineId("err"),
				kind: "error",
				text: error,
			};
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

	const showMentionMenu =
		!composerMenuDismissed &&
		Boolean(mentionMatch) &&
		(mentionOptions.length > 0 || mentionBrowseRoot != null);
	const showSkillMenu = !composerMenuDismissed && skillOptions.length > 0;

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
	const hasStreamingAgentMessage = lines.some(
		(line) => line.kind === "agent" && line.streaming,
	);
	const composerControlsMuted = hasStreamingAgentMessage;
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
		setWarming(true);
		void (async () => {
			try {
				const result = await warmAgent({
					agentId,
					vaultPath: requestVaultPath ?? undefined,
					modelId: id,
				});
				if (
					generation !== warmGenRef.current ||
					selectedAgentIdRef.current !== agentId ||
					vaultPathRef.current !== requestVaultPath ||
					loadModelPref(agentId) !== id
				) {
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
				// Model selection remains usable even if capability refresh fails.
			} finally {
				if (
					generation === warmGenRef.current &&
					selectedAgentIdRef.current === agentId &&
					vaultPathRef.current === requestVaultPath
				) {
					setWarming(false);
				}
			}
		})();
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
			setLines((p) => [
				...p,
				{
					id: nextLineId("err"),
					kind: "error",
					text: e instanceof Error ? e.message : String(e),
				},
			]);
		} finally {
			switchingRef.current = false;
			setSwitching(false);
		}
	};

	// Forward ACP permission requests (ask mode) to the user for an explicit decision.
	const [permissionRequest, setPermissionRequest] =
		useState<PermissionRequest | null>(null);
	// Trust loop: review a note the agent rewrote (keep / revert).
	const [notesReview, setNotesReview] = useState<NotesReview | null>(null);

	const permissionRequestRef = useRef(permissionRequest);
	permissionRequestRef.current = permissionRequest;
	useOverlayRegistration("agent-permission", permissionRequest !== null, () => {
		const req = permissionRequestRef.current;
		if (!req) return;
		void respondPermission(req.requestId, null);
		setPermissionRequest(null);
	});
	useOverlayRegistration("notes-review", notesReview !== null, () => {
		setNotesReview(null);
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

	// Trust loop: surface agent note rewrites for keep / revert review.
	useEffect(() => {
		if (!isTauri()) return;
		let unsub: (() => void) | undefined;
		let cancelled = false;
		void (async () => {
			const { listen } = await import("@tauri-apps/api/event");
			if (cancelled) return;
			unsub = await listen<NotesReview>("agent:notes-review", ({ payload }) =>
				setNotesReview(payload),
			);
		})();
		return () => {
			cancelled = true;
			unsub?.();
		};
	}, []);

	const send = async (
		textRaw: string,
		baseLinesOverride?: ChatLine[],
		workflow?: string,
	): Promise<boolean> => {
		const text = textRaw.trim();
		if (
			!text ||
			activeTabIsRunning ||
			switchingRef.current ||
			submittingRef.current
		)
			return false;
		const submittedComposerState = {
			...snapshotComposerState(),
			text: textRaw,
		};
		const submissionGeneration = ++submissionGenRef.current;
		const sessionContextGeneration = sessionContextGenRef.current;
		const requestVaultPath = vaultPath;
		submittingRef.current = true;
		setSubmitting(true);
		try {
			if (!isTauri()) {
				setLines((p) => [
					...p,
					{
						id: nextLineId("err"),
						kind: "error",
						text: t("messages.desktopOnly"),
					},
				]);
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
					setLines((p) => [
						...p,
						{
							id: nextLineId("err"),
							kind: "error",
							text: e instanceof Error ? e.message : String(e),
						},
					]);
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

			const agentOk =
				!selected ||
				selected.available ||
				registry?.agents.some((a) => a.id === agentId && a.available);
			if (!agentOk) {
				setLines((p) => [
					...p,
					{
						id: nextLineId("sys"),
						kind: "system",
						text: t("messages.notAvailable", {
							name: selected?.name ?? t("defaultName"),
						}),
					},
				]);
				return false;
			}

			const prompt = contextPaths.length
				? `${text}\n\n${t("composer.contextInstruction")}\n${contextPaths
						.map((path) => `- ${path}`)
						.join("\n")}`
				: text;
			// Workflow suggestions act on the focused paper / mentioned paths so
			// “Summarize” targets the open paper even without an explicit @mention.
			const workflowTarget = workflow
				? (contextPaths[0] ?? selectedVaultPath ?? undefined)
				: contextPaths[0];
			const userLine: ChatLine = { id: nextLineId("user"), kind: "user", text };
			const sessionStartLines = [...(baseLinesOverride ?? lines), userLine];
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
				skillIds: submittedComposerState.selectedSkillIds,
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
				setLines((p) => [
					...p,
					{
						id: nextLineId("err"),
						kind: "error",
						text: e instanceof Error ? e.message : String(e),
					},
				]);
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

	const cancelCurrentRun = async () => {
		const sessionId = activeTabIsRunning ? activeTabId : null;
		if (!sessionId || !isTauri()) return;
		try {
			await cancelAgentRun(sessionId);
		} catch (error) {
			setLines((prev) => [
				...prev,
				{
					id: nextLineId("err"),
					kind: "error",
					text: error instanceof Error ? error.message : String(error),
				},
			]);
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
		await send(text, baseLines);
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
		if (event.key === "Escape" && activeTabIsRunning) {
			event.preventDefault();
			void cancelCurrentRun();
			return;
		}

		if (event.key === "Escape" && (showMentionMenu || showSkillMenu)) {
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
		}
	};

	const newConversation = () => {
		if (submittingRef.current) return;
		historyHydrationGenRef.current += 1;
		setLines([]);
		resetComposerSession("draft");
		setActiveTabId("draft");
		activeTabRef.current = "draft";
		activeConversationRef.current = null;
	};

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
		if (!supportsResume || item.lines.length > 0) {
			activateComposerSession(item.id);
			setLines(sanitizeChatLines(item.lines));
			activeTabRef.current = item.id;
			setActiveTabId(item.id);
			if (supportsResume) {
				activeConversationRef.current = item.id;
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
						return {
							id: line.id,
							kind: "agent" as const,
							parts,
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
				activeConversationRef.current = item.id;
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
				setLines((prev) => [
					...prev,
					{
						id: nextLineId("err"),
						kind: "error",
						text: error instanceof Error ? error.message : String(error),
					},
				]);
			}
		})();
	};

	const historySessionButtons = sessionHistory.map((item) => {
		const isActive = item.id === activeTabId;
		return (
			<button
				key={item.id}
				type="button"
				disabled={submitting}
				className={cn(
					"flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
					isActive
						? "bg-muted text-foreground"
						: "hover:bg-muted/70 focus-visible:bg-muted/70",
				)}
				onClick={() => openHistorySession(item)}
			>
				<span className="text-muted-foreground text-xs leading-none">
					{item.agentName} · {t(`history.status.${item.status}`)} ·{" "}
					{item.id.slice(0, 8)}
				</span>
				<span className="line-clamp-2 font-medium text-sm leading-snug">
					{displayHistoryTitle(item.title, item.id.slice(0, 8))}
				</span>
				<span className="text-muted-foreground text-xs leading-none">
					{item.startedAt}
				</span>
			</button>
		);
	});

	const externalHistoryToggle = null;

	const agentSwitcher = (
		<DropdownMenu>
			<DropdownMenuTrigger
				asChild
				disabled={hasRunningSessions || switching || submitting}
			>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-7 max-w-[9rem] gap-1 px-1.5 font-medium text-sm leading-none"
					aria-label={t("switchAgent")}
					title={t("switchAgent")}
				>
					<span className="truncate">{selected?.name ?? t("defaultName")}</span>
					<ChevronDown className="size-3 shrink-0 opacity-70" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-[200px]">
				{/* Match DropdownMenuLabel height (px-1.5 py-1 text-xs); keep gear inside the row. */}
				<div className="flex h-6 items-center justify-between gap-1 px-1.5">
					<span className="min-w-0 truncate font-medium text-muted-foreground text-xs leading-none">
						{t("agentMenu.title")}
					</span>
					{onOpenAgentSettings ? (
						<button
							type="button"
							className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
							aria-label={t("agentMenu.openSettings")}
							title={t("agentMenu.openSettings")}
							onClick={() => onOpenAgentSettings()}
						>
							<Settings className="size-3" />
						</button>
					) : null}
				</div>
				<DropdownMenuSeparator />
				{options.length === 0 ? (
					<div className="px-2 py-1.5 text-muted-foreground text-xs">
						{t("agentMenu.empty")}
					</div>
				) : (
					options.map((opt) => {
						const isActive =
							selected?.key === opt.key ||
							(opt.id !== null && opt.id === selectedAgentId);
						return (
							<DropdownMenuItem
								key={opt.key}
								className="flex items-center justify-between gap-2"
								onSelect={() => void selectAgent(opt)}
							>
								<span className="min-w-0 truncate">{opt.name}</span>
								{isActive ? (
									<Check className="size-3.5 shrink-0 opacity-80" />
								) : null}
							</DropdownMenuItem>
						);
					})
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);

	/** Sidebar-mode header only: new chat + history popover (+ optional actions). */
	const headerTrailing = (
		<>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				aria-label={t("tabs.new")}
				title={t("tabs.new")}
				disabled={submitting}
				onClick={newConversation}
			>
				<Plus className="size-4" />
			</Button>
			<Popover open={historyOpen} onOpenChange={setHistoryOpen}>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 gap-1 px-1.5 font-normal text-muted-foreground text-sm leading-none hover:text-foreground"
						aria-label={t("history.aria")}
						title={t("history.label")}
						disabled={submitting}
					>
						<History className="size-3.5" />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-80 p-0">
					<PopoverHeader className="border-b px-3 py-2">
						<div className="flex items-center justify-between gap-3">
							<PopoverTitle className="font-medium text-sm leading-none">
								{t("history.title")}
							</PopoverTitle>
							{externalHistoryToggle}
						</div>
						<PopoverDescription className="text-muted-foreground text-sm leading-snug">
							{t("history.description")}
						</PopoverDescription>
					</PopoverHeader>
					{sessionHistory.length === 0 ? (
						<div className="px-3 py-4 text-muted-foreground text-sm leading-none">
							{t("history.empty")}
						</div>
					) : (
						<div className="max-h-72 overflow-y-auto p-1.5">
							{historySessionButtons}
						</div>
					)}
				</PopoverContent>
			</Popover>
			{headerActions}
		</>
	);

	const formatPermissionKind = (kind: string): string => {
		switch (kind) {
			case "allow_once":
				return t("permission.kind.allowOnce");
			case "allow_always":
				return t("permission.kind.allowAlways");
			case "reject_once":
				return t("permission.kind.rejectOnce");
			case "reject_always":
				return t("permission.kind.rejectAlways");
			default:
				return kind;
		}
	};

	return (
		<section
			className={cn(
				"flex h-full min-h-0 bg-background",
				isZen ? "flex-row bg-muted/15" : "flex-col",
				className,
			)}
			aria-label={title}
		>
			{/*
			  Zen left rail — quiet Quest-style nav:
			  soft surface, pill "new" CTA, muted section label, single-line titles.
			*/}
			{isZen ? (
				<aside className="flex w-52 shrink-0 flex-col border-border/40 border-r bg-muted/25 sm:w-56">
					<div className="shrink-0 px-2.5 pt-2.5 pb-1.5">
						<button
							type="button"
							aria-label={t("tabs.new")}
							disabled={submitting}
							onClick={newConversation}
							className={cn(
								"flex h-8 w-full items-center gap-1.5 rounded-lg border border-border/60 bg-background px-2.5 text-left text-sm text-foreground/80 shadow-none transition-colors",
								"hover:bg-background hover:text-foreground",
								"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
								"disabled:cursor-not-allowed disabled:opacity-50",
							)}
						>
							<Plus className="size-3.5 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate font-normal">
								{t("tabs.new")}
							</span>
						</button>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
						<p className="px-2 pb-1 pt-2 text-[11px] font-normal tracking-wide text-muted-foreground/70">
							{t("history.label")}
						</p>
						{sessionHistory.length === 0 ? (
							<p className="px-2 py-1.5 text-[12px] text-muted-foreground/55">
								{t("history.empty")}
							</p>
						) : (
							<ul className="flex flex-col gap-0.5">
								{sessionHistory.map((item) => {
									const isActive = item.id === activeTabId;
									return (
										<li key={item.id}>
											<button
												type="button"
												disabled={submitting}
												title={item.title}
												onClick={() => openHistorySession(item)}
												className={cn(
													"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-snug outline-none transition-colors",
													"focus-visible:ring-1 focus-visible:ring-ring",
													"disabled:cursor-not-allowed disabled:opacity-50",
													isActive
														? "bg-background/80 text-foreground shadow-sm"
														: "text-muted-foreground hover:bg-background/50 hover:text-foreground/80",
												)}
											>
												{item.status === "running" ? (
													<span
														className="size-1.5 shrink-0 rounded-full bg-emerald-500/80"
														aria-hidden
													/>
												) : null}
												<span className="min-w-0 flex-1 truncate font-normal">
													{displayHistoryTitle(item.title, item.id.slice(0, 8))}
												</span>
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</div>
				</aside>
			) : null}

			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{/* Same header chrome in both modes: Agent switcher + trailing actions (zen: no trailing). */}
				<PaneHeader trailing={isZen ? undefined : headerTrailing}>
					{agentSwitcher}
				</PaneHeader>

				{/*
				  Shared AI Elements transcript for sidebar + zen.
				  Zen only changes the scroll viewport width (full pane → scrollbar on the
				  far right) and centers the message column; message components are identical.
				*/}
				<div className="flex min-h-0 flex-1 flex-col">
					<Conversation className="min-h-0 flex-1">
						<ConversationContent
							className={cn(
								isZen &&
									(lines.length === 0
										? "min-h-full justify-center px-0 py-6"
										: "px-0 py-6"),
							)}
						>
							<div
								className={cn(
									"flex w-full flex-col gap-8",
									isZen && "mx-auto max-w-2xl px-4 sm:px-6",
								)}
							>
								{lines.length === 0 ? (
									<ConversationEmptyState
										className={cn(isZen ? "max-w-md p-0" : undefined)}
										title={t("empty.title")}
										description={t("empty.description")}
									>
										<div
											className={cn(
												"mt-4 flex w-full flex-col items-stretch gap-2",
												isZen ? "max-w-md" : "max-w-sm",
											)}
										>
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
																void send(
																	v,
																	undefined,
																	SUGGESTION_WORKFLOW[key],
																)
															}
															disabled={activeTabIsRunning}
														/>
													);
												})
											)}
										</div>
									</ConversationEmptyState>
								) : (
									lines.map((line) => {
										if (line.kind === "user") {
											const isEditing = editingLineId === line.id;
											if (isEditing) {
												return (
													<Message key={line.id} from="user">
														<div className="ml-auto flex w-full flex-col gap-2 rounded-lg bg-secondary px-3 py-2.5 ring-1 ring-primary/40">
															<textarea
																ref={editTextareaRef}
																className="max-h-60 min-h-16 w-full resize-none overflow-y-auto bg-transparent text-foreground text-sm leading-6 outline-none"
																value={editingText}
																onChange={(event) =>
																	setEditingText(event.currentTarget.value)
																}
																onKeyDown={(event) => {
																	if (event.key === "Escape") {
																		event.preventDefault();
																		cancelEditingMessage();
																	} else if (
																		event.key === "Enter" &&
																		!event.shiftKey
																	) {
																		event.preventDefault();
																		void resendEditedMessage(line.id);
																	}
																}}
															/>
															<div className="flex items-center justify-end gap-2">
																<Button
																	type="button"
																	variant="ghost"
																	size="sm"
																	onClick={cancelEditingMessage}
																>
																	{t("edit.cancel")}
																</Button>
																<Button
																	type="button"
																	size="sm"
																	disabled={
																		!editingText.trim() ||
																		submitting ||
																		switching
																	}
																	onClick={() =>
																		void resendEditedMessage(line.id)
																	}
																>
																	{t("edit.resend")}
																</Button>
															</div>
														</div>
													</Message>
												);
											}
											const userDisplay = stripPromptEnvelopeForDisplay(
												line.text,
											);
											// Never render Codex env / Host system envelopes as user bubbles.
											if (!userDisplay) return null;
											return (
												<Message key={line.id} from="user">
													<MessageContent>
														<MessageResponse>{userDisplay}</MessageResponse>
													</MessageContent>
													{/* Align under user bubble (Message is full-width) */}
													<MessageActions className="-mt-1 ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
														{activeTabIsRunning ? null : (
															<MessageAction
																tooltip={t("edit.action")}
																label={t("edit.action")}
																disabled={submitting || switching}
																onClick={() =>
																	startEditingMessage(line.id, userDisplay)
																}
															>
																<Pencil className="size-3.5" />
															</MessageAction>
														)}
														<MessageAction
															tooltip={t("copy")}
															label={t("copy")}
															onClick={() => void copyText(userDisplay)}
														>
															<CopyIcon className="size-3.5" />
														</MessageAction>
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
											let lastTextIndex = -1;
											for (let i = lastIndex; i >= 0; i--) {
												if (parts[i].type === "text") {
													lastTextIndex = i;
													break;
												}
											}
											const agentText = agentTextFromParts(parts);
											const showThinking =
												Boolean(line.streaming) && parts.length === 0;
											return (
												<div
													key={rowKey}
													className="flex w-full flex-col gap-2"
												>
													<Message from="assistant">
														<MessageContent>
															<p className="mb-1 font-medium text-muted-foreground text-xs">
																{selected?.name ?? t("defaultName")}
															</p>
															{parts.map((part, index) => {
																const partKey = `${rowKey}:${part.id}`;
																if (part.type === "reasoning") {
																	const streaming =
																		Boolean(line.streaming) &&
																		index === lastIndex;
																	if (!part.text.trim() && !streaming)
																		return null;
																	return (
																		<Reasoning
																			key={partKey}
																			className="mb-2"
																			isStreaming={streaming}
																		>
																			<ReasoningTrigger />
																			<ReasoningContent>
																				{part.text}
																			</ReasoningContent>
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
																			defaultOpen
																			isStreaming={planStreaming}
																		>
																			<PlanHeader>
																				<div className="min-w-0 flex-1 space-y-1">
																					<PlanTitle>
																						{t("plan.title")}
																					</PlanTitle>
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
																			<PlanContent className="space-y-2 pt-0">
																				{plan.map((entry) => (
																					<div
																						key={`${entry.status}:${entry.priority}:${entry.content}`}
																						className="flex items-start gap-2 text-sm"
																					>
																						<span
																							className={cn(
																								"mt-1 size-1.5 shrink-0 rounded-full",
																								entry.status === "completed" &&
																									"bg-emerald-500",
																								entry.status ===
																									"in_progress" &&
																									"bg-amber-500",
																								entry.status === "pending" &&
																									"bg-muted-foreground/40",
																							)}
																						/>
																						<span
																							className={cn(
																								entry.status === "completed" &&
																									"text-muted-foreground line-through",
																							)}
																						>
																							{entry.content}
																						</span>
																					</div>
																				))}
																			</PlanContent>
																		</Plan>
																	);
																}
																if (part.type === "tool") {
																	const tool = part.tool;
																	const state = toolPartState(tool.status);
																	return (
																		<Tool key={partKey} defaultOpen={false}>
																			<ToolHeader
																				title={
																					tool.title || t("tool.defaultTitle")
																				}
																				type={`tool-${tool.kind}`}
																				state={state}
																			/>
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
																		</Tool>
																	);
																}
																if (!part.text) return null;
																const isAnimating =
																	Boolean(line.streaming) &&
																	index === lastIndex &&
																	part.text.length > 0;
																const showCitation =
																	!line.streaming &&
																	index === lastTextIndex &&
																	Boolean(
																		line.sources && line.sources.length > 0,
																	);
																return (
																	<div key={partKey} className="min-w-0">
																		<MessageResponse isAnimating={isAnimating}>
																			{part.text}
																		</MessageResponse>
																		{showCitation && line.sources ? (
																			<span className="mt-1 inline-flex items-center">
																				<InlineCitation>
																					<InlineCitationCard>
																						<InlineCitationCardTrigger
																							sources={line.sources}
																						/>
																						<InlineCitationCardBody>
																							<InlineCitationCarousel>
																								<InlineCitationCarouselHeader>
																									<InlineCitationCarouselPrev />
																									<InlineCitationCarouselNext />
																									<InlineCitationCarouselIndex />
																								</InlineCitationCarouselHeader>
																								<InlineCitationCarouselContent>
																									{line.sources.map((s) => (
																										<InlineCitationCarouselItem
																											key={s}
																										>
																											<InlineCitationSource
																												title={
																													s
																														.split(/[/\\]/)
																														.pop() || s
																												}
																												url={s}
																												description={
																													/^https?:\/\//i.test(
																														s,
																													)
																														? undefined
																														: t(
																																"citation.vaultPath",
																															)
																												}
																											/>
																										</InlineCitationCarouselItem>
																									))}
																								</InlineCitationCarouselContent>
																							</InlineCitationCarousel>
																						</InlineCitationCardBody>
																					</InlineCitationCard>
																				</InlineCitation>
																			</span>
																		) : null}
																	</div>
																);
															})}
															{showThinking ? (
																<Shimmer className="text-sm">
																	{t("thinking")}
																</Shimmer>
															) : null}
														</MessageContent>
														{!line.streaming && agentText ? (
															<MessageActions className="-mt-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
																<MessageAction
																	tooltip={t("copy")}
																	label={t("copy")}
																	onClick={() => void copyText(agentText)}
																>
																	<CopyIcon className="size-3.5" />
																</MessageAction>
															</MessageActions>
														) : null}
													</Message>
													{line.sources && line.sources.length > 0 ? (
														<Sources>
															<SourcesTrigger count={line.sources.length} />
															<SourcesContent>
																{line.sources.map((s) => (
																	<Source
																		key={s}
																		title={s}
																		href={`#${encodeURIComponent(s)}`}
																	/>
																))}
															</SourcesContent>
														</Sources>
													) : null}
												</div>
											);
										}
										if (line.kind === "error") {
											return (
												<Message key={line.id} from="assistant">
													<MessageContent className="text-destructive">
														<MessageResponse>{line.text}</MessageResponse>
													</MessageContent>
												</Message>
											);
										}
										return (
											<Checkpoint key={line.id} className="my-1 px-1">
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
									})
								)}
							</div>
						</ConversationContent>
						<ConversationScrollButton
							className={cn(
								isZen && "right-4 bottom-4 left-auto translate-x-0",
							)}
						/>
					</Conversation>

					<div
						className={cn(
							"shrink-0 space-y-2",
							isZen
								? "mx-auto w-full max-w-2xl border-0 bg-transparent px-4 pt-1 pb-6 sm:px-6 sm:pb-8"
								: "border-t bg-muted/10 p-3",
						)}
					>
						{lines.length > 0 && !activeTabIsRunning ? (
							<Suggestions className={cn(isZen && "justify-center")}>
								{SUGGESTION_KEYS.map((key) => {
									const label = t(`suggestions.${key}`);
									return (
										<Suggestion
											key={key}
											suggestion={label}
											onClick={(v) =>
												void send(v, undefined, SUGGESTION_WORKFLOW[key])
											}
											disabled={activeTabIsRunning || switching}
										/>
									);
								})}
							</Suggestions>
						) : null}
						<PromptInput
							className={cn(
								"w-full rounded-xl border-border bg-background shadow-none",
								isZen && "rounded-2xl border shadow-sm",
							)}
							inputGroupClassName={cn(
								"overflow-visible",
								!hasStreamingAgentMessage &&
									"has-disabled:bg-transparent has-disabled:opacity-100 dark:has-disabled:bg-input/30",
							)}
							onSubmit={async ({ text }) => {
								if (
									activeTabIsRunning ||
									switchingRef.current ||
									submittingRef.current
								)
									return;
								await send(text);
							}}
						>
							<PromptInputBody>
								<div
									className={cn(
										"relative flex w-full flex-col px-3 pt-3",
										isZen ? "min-h-[120px]" : "min-h-[96px]",
									)}
									onDragOverCapture={handleComposerDragOver}
									onDropCapture={handleComposerDrop}
								>
									{currentFilePath || mentionChipPaths.length > 0 ? (
										<div className="mb-2 flex flex-wrap gap-1.5">
											{currentFilePath ? (
												<button
													type="button"
													className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border bg-muted/20 px-2 text-foreground text-xs transition-colors hover:bg-muted"
													disabled={activeTabIsRunning}
													onClick={() => removeContextPath(currentFilePath)}
													title={t("composer.currentFileRemove")}
												>
													<ContextPathIcon
														path={currentFilePath}
														directoryPaths={directoryPathSet}
														paperPaths={paperPathSet}
													/>
													<span className="truncate" title={currentFilePath}>
														{currentFileLabel}
													</span>
													<X className="size-3 shrink-0 text-muted-foreground" />
												</button>
											) : null}
											{mentionChipPaths.map((path) => {
												const label = labelForPath(path);
												return (
													<button
														key={path}
														type="button"
														className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border bg-muted/20 px-2 text-foreground text-xs transition-colors hover:bg-muted"
														onClick={() => removeContextPath(path)}
														title={t("composer.removeContext", { path })}
													>
														<ContextPathIcon
															path={path}
															directoryPaths={directoryPathSet}
															paperPaths={paperPathSet}
														/>
														<span
															className="max-w-[16rem] truncate"
															title={path}
														>
															{label}
														</span>
														<X className="size-3 shrink-0 text-muted-foreground" />
													</button>
												);
											})}
										</div>
									) : null}
									{selectedSkills.length > 0 ? (
										<div className="mb-2 flex flex-wrap gap-1.5">
											{selectedSkills.map((skill) => (
												<button
													key={skill.id}
													type="button"
													className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border bg-muted/20 px-2 text-foreground text-xs transition-colors hover:bg-muted"
													onClick={() =>
														setSelectedSkillIds((prev) =>
															prev.filter((id) => id !== skill.id),
														)
													}
													title={t("composer.removeSkill", {
														skill: skill.name,
													})}
												>
													<span className="font-mono text-muted-foreground">
														$
													</span>
													<span className="truncate">{skill.name}</span>
													<X className="size-3 shrink-0 text-muted-foreground" />
												</button>
											))}
										</div>
									) : null}
									{showMentionMenu ? (
										<div
											id="agent-mention-menu"
											role="listbox"
											className="absolute right-3 bottom-full left-3 z-20 mb-2 overflow-hidden rounded-lg border bg-popover p-1 shadow-md"
										>
											{mentionBrowseRoot ? (
												<div className="mb-0.5 flex items-center gap-0.5 border-border/60 border-b px-0.5 pb-1">
													<button
														type="button"
														className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
														aria-label={t("composer.mentionBack")}
														title={t("composer.mentionBack")}
														onClick={leaveMentionFolder}
													>
														<ChevronLeft className="size-3.5" aria-hidden />
													</button>
													<span
														className="min-w-0 flex-1 truncate pr-1 text-muted-foreground text-xs"
														title={mentionBrowseRoot}
													>
														{labelForPath(mentionBrowseRoot)}
													</span>
												</div>
											) : null}
											{mentionOptions.length === 0 ? (
												<div className="px-2 py-2 text-muted-foreground text-xs">
													{t("composer.mentionEmptyFolder")}
												</div>
											) : (
												mentionOptions.map((path, index) => {
													const label = labelForPath(path);
													const showPathHint =
														!mentionBrowseRoot &&
														label !== path &&
														path.includes("/");
													const canEnter = mentionPathHasChildren(
														path,
														mentionCandidates,
														paperPathSet,
													);
													return (
														<div
															key={path}
															className={cn(
																"flex w-full items-center gap-0.5 rounded-md text-sm",
																mentionActiveIndex === index
																	? "bg-muted"
																	: "hover:bg-muted/70",
															)}
														>
															<button
																type="button"
																id={`agent-mention-option-${index}`}
																role="option"
																aria-selected={mentionActiveIndex === index}
																className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none"
																onMouseEnter={() =>
																	setMentionActiveIndex(index)
																}
																onClick={() => attachMention(path)}
															>
																<ContextPathIcon
																	path={path}
																	directoryPaths={directoryPathSet}
																	paperPaths={paperPathSet}
																/>
																<span className="min-w-0 flex-1 truncate">
																	<span className="block truncate" title={path}>
																		{label}
																	</span>
																	{showPathHint ? (
																		<span
																			className="block truncate text-[11px] text-muted-foreground"
																			title={path}
																		>
																			{path}
																		</span>
																	) : null}
																</span>
															</button>
															{canEnter ? (
																<button
																	type="button"
																	tabIndex={-1}
																	className="mr-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
																	aria-label={t("composer.mentionEnterFolder", {
																		name: label,
																	})}
																	title={t("composer.mentionEnterFolder", {
																		name: label,
																	})}
																	onMouseEnter={() =>
																		setMentionActiveIndex(index)
																	}
																	onClick={(e) => {
																		e.preventDefault();
																		e.stopPropagation();
																		enterMentionFolder(path);
																	}}
																>
																	<ChevronRight
																		className="size-3.5"
																		aria-hidden
																	/>
																</button>
															) : (
																<span className="mr-0.5 size-7 shrink-0" />
															)}
														</div>
													);
												})
											)}
										</div>
									) : null}
									{showSkillMenu ? (
										<div
											id="agent-skill-menu"
											role="listbox"
											className="absolute right-3 bottom-full left-3 z-20 mb-2 overflow-hidden rounded-lg border bg-popover p-1 shadow-md"
										>
											{skillOptions.map((skill, index) => (
												<button
													key={skill.id}
													id={`agent-skill-option-${index}`}
													type="button"
													role="option"
													aria-selected={skillActiveIndex === index}
													className={cn(
														"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:outline-none",
														skillActiveIndex === index
															? "bg-muted"
															: "hover:bg-muted/70",
													)}
													onMouseEnter={() => setSkillActiveIndex(index)}
													onClick={() => attachSkill(skill)}
												>
													<span className="font-mono text-muted-foreground">
														$
													</span>
													<span className="min-w-0 flex-1 truncate">
														{skill.name}
													</span>
													{skill.description ? (
														<span className="max-w-40 truncate text-muted-foreground text-xs">
															{skill.description}
														</span>
													) : null}
												</button>
											))}
										</div>
									) : null}
									<PromptInputTextarea
										autoFocus={autoFocus || undefined}
										className="min-h-[82px] px-0 py-1 text-[15px] leading-6 placeholder:text-muted-foreground/80"
										value={composerText}
										onChange={(event) => {
											setComposerText(event.currentTarget.value);
											setComposerMenuDismissed(false);
											setMentionActiveIndex(0);
											setSkillActiveIndex(0);
										}}
										onKeyDown={handleComposerMenuKeyDown}
										aria-expanded={showMentionMenu || showSkillMenu}
										aria-autocomplete="list"
										aria-controls={
											showMentionMenu
												? "agent-mention-menu"
												: showSkillMenu
													? "agent-skill-menu"
													: undefined
										}
										aria-activedescendant={
											showMentionMenu
												? `agent-mention-option-${mentionActiveIndex}`
												: showSkillMenu
													? `agent-skill-option-${skillActiveIndex}`
													: undefined
										}
										role="combobox"
										disabled={switching}
										placeholder={
											activeTabIsRunning
												? t("composer.interruptHint")
												: t("composer.placeholder")
										}
									/>
								</div>
							</PromptInputBody>
							<PromptInputFooter className="flex-wrap items-end gap-x-2 gap-y-1.5 px-3 pb-2.5">
								<PromptInputTools className="min-w-0 flex-1 flex-wrap gap-1">
									<ModelSelector
										open={modelSelectorOpen}
										onOpenChange={setModelSelectorOpen}
									>
										<ModelSelectorTrigger asChild>
											<PromptInputButton
												type="button"
												className={cn(
													"h-7 max-w-[min(16rem,100%)] gap-1 px-1.5 text-xs font-medium",
													composerControlsMuted
														? "text-muted-foreground"
														: "text-foreground",
												)}
												disabled={
													activeTabIsRunning || warming || models.length === 0
												}
												tooltip={
													models.length > 0
														? t("models.selectTooltip")
														: t("models.reportedTooltip")
												}
											>
												<span className="truncate text-xs">
													{selectedModelName ??
														(warming
															? t("models.loading")
															: t("models.button"))}
												</span>
												<ChevronDown className="size-3 shrink-0 opacity-70" />
											</PromptInputButton>
										</ModelSelectorTrigger>
										<ModelSelectorContent className="sm:max-w-md">
											<ModelSelectorInput
												placeholder={t("models.searchPlaceholder")}
											/>
											<ModelSelectorList className="max-h-64">
												{groupedModels.map((group) => (
													<ModelSelectorGroup
														key={group.id}
														heading={group.heading}
													>
														{group.items.map((model) => {
															const favorited = favoriteIds.includes(model.id);
															const selected = modelId === model.id;
															return (
																<ModelSelectorItem
																	key={`${group.id}-${model.id}`}
																	value={`${model.name} ${model.id}${
																		group.isFavorites ? "\u200b" : ""
																	}`}
																	onSelect={() => pickModel(model.id)}
																	className={cn(
																		selected &&
																			"bg-accent font-medium text-accent-foreground data-selected:bg-accent",
																	)}
																>
																	<span className="flex-1 truncate">
																		{model.name}
																	</span>
																	<button
																		type="button"
																		aria-label={
																			favorited
																				? t("models.removeFromFavorites")
																				: t("models.addToFavorites")
																		}
																		title={
																			favorited
																				? t("models.removeFromFavorites")
																				: t("models.addToFavorites")
																		}
																		className={cn(
																			"rounded p-0.5 text-muted-foreground transition hover:text-foreground",
																			favorited
																				? "opacity-100"
																				: "opacity-0 group-hover/command-item:opacity-100 group-data-selected/command-item:opacity-100",
																		)}
																		onClick={(e) => {
																			e.stopPropagation();
																			e.preventDefault();
																			toggleFavorite(model.id);
																		}}
																		onPointerDown={(e) => e.stopPropagation()}
																		onMouseDown={(e) => e.stopPropagation()}
																	>
																		<Star
																			className={cn(
																				"size-3.5",
																				favorited &&
																					"fill-current text-amber-500",
																			)}
																		/>
																	</button>
																</ModelSelectorItem>
															);
														})}
													</ModelSelectorGroup>
												))}
												<ModelSelectorEmpty>
													{models.length === 0
														? t("models.emptyNone")
														: t("models.emptyNoMatch")}
												</ModelSelectorEmpty>
											</ModelSelectorList>
										</ModelSelectorContent>
									</ModelSelector>
									{effortOptionsInDisplayOrder.length > 0 ? (
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<PromptInputButton
													type="button"
													className={cn(
														"h-7 max-w-[min(8rem,100%)] gap-1 px-1.5 text-xs font-medium",
														composerControlsMuted
															? "text-muted-foreground"
															: "text-foreground",
													)}
													disabled={activeTabIsRunning}
													tooltip={t("composer.effortTooltip")}
												>
													<span className="truncate">
														{t("composer.effort.label")}:{" "}
														{formatEffort(reasoningEffort ?? "medium")}
													</span>
													<ChevronDown className="size-3 shrink-0 opacity-70" />
												</PromptInputButton>
											</DropdownMenuTrigger>
											<DropdownMenuContent
												align="start"
												className="min-w-28 p-1"
											>
												{effortOptionsInDisplayOrder.map((effort) => (
													<DropdownMenuItem
														key={effort.id}
														className={cn(
															"justify-between rounded-md",
															reasoningEffort === effort.id && "bg-muted",
														)}
														onSelect={() => setReasoningEffort(effort.id)}
													>
														{formatEffort(effort.id)}
														{reasoningEffort === effort.id ? (
															<CheckIcon className="size-3.5 text-muted-foreground" />
														) : null}
													</DropdownMenuItem>
												))}
											</DropdownMenuContent>
										</DropdownMenu>
									) : null}
									{activeUsage && activeUsage.size > 0 ? (
										<Context
											usedTokens={activeUsage.used}
											maxTokens={activeUsage.size}
										>
											<ContextTrigger className="h-7 gap-1 px-1.5 text-xs" />
											<ContextContent>
												<ContextContentHeader />
											</ContextContent>
										</Context>
									) : null}
									{fastAvailable ? (
										<PromptInputButton
											type="button"
											className={cn(
												"size-7",
												composerControlsMuted
													? "text-muted-foreground"
													: "text-foreground",
												fastEnabled && "text-amber-500 hover:text-amber-500",
											)}
											aria-pressed={fastEnabled}
											disabled={activeTabIsRunning}
											onClick={() => setFastEnabled((current) => !current)}
											tooltip={t("composer.fastToggle")}
										>
											<Zap
												className={cn(
													"size-3.5",
													fastEnabled &&
														"fill-amber-400 text-amber-500 dark:fill-amber-300 dark:text-amber-300",
												)}
											/>
										</PromptInputButton>
									) : null}
								</PromptInputTools>
								<PromptInputSubmit
									className="ml-auto shrink-0"
									size="icon-xs"
									status={
										activeTabIsRunning
											? "streaming"
											: submitting
												? "submitted"
												: "ready"
									}
									onStop={
										activeTabIsRunning
											? () => void cancelCurrentRun()
											: undefined
									}
									disabled={
										!activeTabIsRunning &&
										(switching || submitting || !composerText.trim())
									}
								/>
							</PromptInputFooter>
						</PromptInput>
					</div>
				</div>
			</div>
			<Dialog
				open={permissionRequest !== null}
				onOpenChange={(open) => {
					if (!open && permissionRequest) {
						void respondPermission(permissionRequest.requestId, null);
						setPermissionRequest(null);
					}
				}}
			>
				<DialogContent className="max-w-md">
					{permissionRequest ? (
						<>
							<DialogHeader>
								<DialogTitle>{t("permission.title")}</DialogTitle>
								<DialogDescription>{permissionRequest.title}</DialogDescription>
							</DialogHeader>
							{permissionRequest.paths.length ? (
								<div className="flex flex-col gap-1">
									{permissionRequest.paths.map((p) => (
										<code
											key={p}
											className="truncate rounded bg-muted px-1.5 py-0.5 text-xs"
											title={p}
										>
											{p}
										</code>
									))}
								</div>
							) : null}
							<DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
								{permissionRequest.options.map((opt) => (
									<Button
										key={opt.optionId}
										variant={
											opt.kind.startsWith("allow") ? "default" : "outline"
										}
										onClick={() => {
											void respondPermission(
												permissionRequest.requestId,
												opt.optionId,
											);
											setPermissionRequest(null);
										}}
									>
										{opt.name || formatPermissionKind(opt.kind)}
									</Button>
								))}
								<Button
									variant="ghost"
									onClick={() => {
										void respondPermission(permissionRequest.requestId, null);
										setPermissionRequest(null);
									}}
								>
									{t("permission.deny")}
								</Button>
							</DialogFooter>
						</>
					) : null}
				</DialogContent>
			</Dialog>
			<Dialog
				open={notesReview !== null}
				onOpenChange={(open) => {
					if (!open) setNotesReview(null);
				}}
			>
				<DialogContent className="max-w-3xl">
					{notesReview ? (
						<>
							<DialogHeader>
								<DialogTitle>{t("review.title")}</DialogTitle>
								<DialogDescription>
									{t("review.description", {
										name:
											notesReview.path.split(/[\\/]/).pop() ?? notesReview.path,
									})}
								</DialogDescription>
							</DialogHeader>
							<NotesReviewDiff
								before={notesReview.before}
								after={notesReview.after}
							/>
							<DialogFooter>
								<Button
									variant="outline"
									onClick={() => {
										void revertNote(notesReview.path, notesReview.before);
										setNotesReview(null);
									}}
								>
									{t("review.revert")}
								</Button>
								<Button onClick={() => setNotesReview(null)}>
									{t("review.keep")}
								</Button>
							</DialogFooter>
						</>
					) : null}
				</DialogContent>
			</Dialog>
		</section>
	);
}
