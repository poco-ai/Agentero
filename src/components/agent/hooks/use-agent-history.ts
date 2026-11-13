/**
 * Session history: provider session listing (resume support) and opening a
 * history row (local hydrate vs remote session/load).
 */
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useState,
} from "react";
import type {
	AgentPanelRefs,
	AgentPanelT,
} from "@/components/agent/hooks/use-agent-panel-context";
import { formatLocaleTimestamp } from "@/i18n";
import {
	type AcpDeleteSessionResult,
	type AcpLoadSessionResult,
	type AcpSessionInfo,
	cancelAgentRun,
	deleteSession,
	listSessions,
	loadSession,
} from "@/lib/agent";
import {
	type AgentSessionRecord,
	type AgentSessionStoreApi,
	agentSessionStore,
	useAgentSessionStoreApi,
} from "@/lib/agent/agent-session-store";
import {
	type AgentOption,
	type AgentPart,
	type ChatLine,
	type ChatSessionHistoryItem,
	errorChatLine,
	errorText,
	isBackgroundWorkflowHistoryTitle,
	mapToolStatus,
	providerSessionIdForHistoryLoad,
} from "@/lib/agent/chat-state";
import {
	hasTranscriptChips,
	inlineMarkupToPlain,
} from "@/lib/agent/composer-inline-tokens";
import {
	applyCachedHistoryTitles,
	forgetEmptyAcpSession,
	getCachedHistoryTitle,
	getOverriddenHistoryTitle,
	isDismissedAcpSession,
	isEmptyAcpSession,
	rememberDismissedAcpSession,
	rememberEmptyAcpSession,
	setCachedHistoryTitle,
	setUserHistoryTitle,
} from "@/lib/agent/history-title-cache";
import {
	displayHistoryTitle,
	stripPromptEnvelopeForDisplay,
} from "@/lib/agent/prompt-display";
import { isTauri } from "@/lib/core/tauri";
import { mapLimit } from "@/lib/core/utils";
import { nextLineId } from "@/lib/pdf-visual/ids";

/** Strip Host/Codex machine envelopes so Chat never shows system preamble. */
export const sanitizeChatLines = (raw: ChatLine[]): ChatLine[] =>
	raw
		.map((line) => {
			if (line.kind !== "user") return line;
			const text = stripPromptEnvelopeForDisplay(line.text);
			const hasVisual = Boolean(line.visualAnnotations?.length);
			const hasImages = Boolean(line.images?.length);
			const hasChips = Boolean(line.markup && hasTranscriptChips(line.markup));
			if (!text && !hasVisual && !hasImages && !hasChips) return null;
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

/** Derive a human-readable title from a loaded ACP session's first user turn. */
export function titleFromLoadedHistory(history: AcpLoadSessionResult): string {
	const firstUser = history.lines.find((line) => line.kind === "user");
	if (firstUser) {
		return displayHistoryTitle(firstUser.text, history.title ?? "");
	}
	return displayHistoryTitle(history.title ?? "");
}

/** First user-turn label from already-hydrated local lines (empty if none). */
export function titleFromSessionLines(
	lines: AgentSessionRecord["lines"],
): string {
	const firstUser = lines.find((line) => line.kind === "user");
	if (firstUser?.kind !== "user") return "";
	const source =
		firstUser.markup && hasTranscriptChips(firstUser.markup)
			? inlineMarkupToPlain(firstUser.markup)
			: firstUser.text;
	return displayHistoryTitle(source, "");
}

/**
 * True when `title` is a session-id placeholder (#484), not a human label.
 * Matches exact id, the historical 8-char slice, or any leading slice of the
 * id (Kimi `ses_…` ids often left short leftovers in the store).
 */
export function isSessionIdPrefixTitle(
	title: string,
	sessionId: string,
): boolean {
	const trimmed = title.trim();
	const id = sessionId.trim();
	if (!trimmed || !id) return false;
	if (trimmed === id) return true;
	if (trimmed === id.slice(0, 8)) return true;
	// Prior bad seeds / OCR-short ids: title is a prefix of the real session id.
	if (trimmed.length >= 6 && id.startsWith(trimmed)) return true;
	return false;
}

type HydrateTitleOptions = {
	generation: number;
	historyGenRef: { current: number };
	selectedAgentId: string;
	vaultPath: string | null;
	setSessionHistory: (
		update:
			| AgentSessionRecord[]
			| ((prev: AgentSessionRecord[]) => AgentSessionRecord[]),
	) => void;
};

/** Concurrent `session/load` calls while preloading history titles. */
const TITLE_HYDRATION_CONCURRENCY = 5;

/** Background-hydrate titles for ACP sessions that arrived without one. */
export async function hydrateSessionTitles(
	items: AgentSessionRecord[],
	opts: HydrateTitleOptions,
): Promise<void> {
	const {
		generation,
		historyGenRef,
		selectedAgentId,
		vaultPath,
		setSessionHistory,
	} = opts;
	if (generation !== historyGenRef.current) return;
	if (items.length === 0) return;

	await mapLimit(items, TITLE_HYDRATION_CONCURRENCY, async (item) => {
		if (generation !== historyGenRef.current) return;

		try {
			const providerSessionId = providerSessionIdForHistoryLoad(item);
			const cached = getCachedHistoryTitle(selectedAgentId, providerSessionId);
			if (cached) {
				setSessionHistory((prev) =>
					prev.map((s) =>
						s.id === item.id && s.agentId === item.agentId && !s.titleLocked
							? { ...s, title: cached }
							: s,
					),
				);
				return;
			}

			const history = await loadSession({
				agentId: selectedAgentId,
				sessionId: providerSessionId,
				vaultPath: vaultPath ?? undefined,
			});
			if (generation !== historyGenRef.current) return;

			if (history.lines.length === 0) {
				// A title with no transcript is still an empty warm session.
				// Remember it so the next list does not bring the row back.
				rememberEmptyAcpSession(selectedAgentId, providerSessionId);
				setSessionHistory((prev) =>
					prev.filter(
						(s) =>
							!(
								s.id === item.id &&
								s.agentId === item.agentId &&
								s.lines.length === 0
							),
					),
				);
				return;
			}
			const title = titleFromLoadedHistory(history);
			if (!title) return;

			setCachedHistoryTitle(selectedAgentId, providerSessionId, title);
			setSessionHistory((prev) =>
				prev.map((s) =>
					s.id === item.id && s.agentId === item.agentId && !s.titleLocked
						? { ...s, title }
						: s,
				),
			);
		} catch {
			// Title is supplementary; a failed load must not block the drawer.
		}
	});
}

/** Sessions that still need a human title (empty or id-prefix leftover). */
export function sessionsNeedingTitleHydration(
	sessions: AgentSessionRecord[],
	agentId: string,
): AgentSessionRecord[] {
	return sessions.filter((session) => {
		if (session.agentId !== agentId) return false;
		if (session.titleLocked) return false;
		if (session.lines.length > 0 && titleFromSessionLines(session.lines)) {
			return false;
		}
		const title = session.title.trim();
		if (!title) return true;
		const providerId = providerSessionIdForHistoryLoad(session);
		return (
			isSessionIdPrefixTitle(title, session.id) ||
			isSessionIdPrefixTitle(title, providerId)
		);
	});
}

/** Rename a history row and persist the title as a user override (#710). */
export function renameHistorySessionTitle(
	item: Pick<
		AgentSessionRecord,
		"id" | "agentId" | "providerSessionId" | "title"
	>,
	nextTitle: string,
	store: AgentSessionStoreApi = agentSessionStore,
): string | null {
	const cleaned = nextTitle.trim();
	if (!cleaned) return null;
	const title = displayHistoryTitle(cleaned, "");
	if (!title) return null;
	setUserHistoryTitle(item.agentId, item.id, title, item.providerSessionId);
	store
		.getState()
		.setSessions((prev) =>
			prev.map((session) =>
				session.id === item.id && session.agentId === item.agentId
					? { ...session, title, titleLocked: true }
					: session,
			),
		);
	return title;
}

/**
 * Hide a history row and ask the agent to delete it when it can.
 *
 * The host records the id before `session/delete`, so a later list cannot
 * bring the row back. A running turn is cancelled first. Deleting the open
 * conversation returns to a blank draft.
 */
export async function deleteHistorySession(
	item: Pick<
		AgentSessionRecord,
		"id" | "agentId" | "providerSessionId" | "status"
	>,
	vaultPath: string | null,
	store: AgentSessionStoreApi = agentSessionStore,
): Promise<AcpDeleteSessionResult> {
	const providerId = item.providerSessionId?.trim() || item.id;
	if (item.status === "running") {
		try {
			await cancelAgentRun(item.id);
		} catch {
			// The turn may already have finished. Still hide the row.
		}
	}
	const result = await deleteSession({
		agentId: item.agentId,
		sessionId: providerId,
		vaultPath: vaultPath ?? undefined,
	});
	rememberDismissedAcpSession(item.agentId, providerId);
	if (item.id !== providerId) {
		rememberDismissedAcpSession(item.agentId, item.id);
	}
	const state = store.getState();
	const removed =
		state.activeTabId === item.id || state.activeTabId === providerId;
	state.setSessions((prev) =>
		prev.filter(
			(session) =>
				!(
					session.agentId === item.agentId &&
					(session.id === item.id ||
						session.id === providerId ||
						session.providerSessionId === providerId ||
						session.providerSessionId === item.id)
				),
		),
	);
	if (removed) store.getState().startDraft();
	return result;
}

type MergeImportedSessionsResult = {
	sessions: AgentSessionRecord[];
	hydrationCandidates: AgentSessionRecord[];
};

/**
 * Merge ACP `session/list` results with the local session store.
 * Returns the merged list plus external sessions that lack an ACP title and
 * have no local transcript — these are candidates for background title hydration.
 */
export function mergeImportedSessions(
	prev: AgentSessionRecord[],
	chatSessions: AcpSessionInfo[],
	selectedAgentId: string,
	agentName: string,
	i18nLanguage: string,
): MergeImportedSessionsResult {
	const existingForAgent = prev.filter(
		(item) => item.agentId === selectedAgentId,
	);
	const existingById = new Map(existingForAgent.map((item) => [item.id, item]));
	const existingByProvider = new Map(
		existingForAgent
			.filter((item) => item.providerSessionId?.trim())
			.map((item) => [item.providerSessionId?.trim() as string, item]),
	);

	const hydrationCandidates: AgentSessionRecord[] = [];

	const listed = chatSessions.filter((session) => {
		if (isDismissedAcpSession(selectedAgentId, session.sessionId)) {
			return false;
		}
		const current =
			existingById.get(session.sessionId) ??
			existingByProvider.get(session.sessionId);
		if (current && current.lines.length > 0) {
			forgetEmptyAcpSession(selectedAgentId, session.sessionId);
			return true;
		}
		return !isEmptyAcpSession(selectedAgentId, session.sessionId);
	});

	const imported = listed.map((session) => {
		const current =
			existingById.get(session.sessionId) ??
			existingByProvider.get(session.sessionId);
		const startedAt = session.updatedAt
			? formatLocaleTimestamp(session.updatedAt, i18nLanguage)
			: "";
		const acpTitle = session.title?.trim() ?? "";
		// Prefer ACP title → first local user turn → keep a prior human title.
		// Never seed with the session-id prefix: that blocks HistorySessionList's
		// user-prompt fallback (#484) because displayHistoryTitle treats any
		// non-empty string as a real title.
		// User renames (#710) always win via titleLocked / override cache.
		const fromLines = current ? titleFromSessionLines(current.lines) : "";
		const priorTitle = current?.title?.trim() ?? "";
		const priorIsIdPlaceholder =
			Boolean(priorTitle) &&
			(isSessionIdPrefixTitle(priorTitle, session.sessionId) ||
				(current != null && isSessionIdPrefixTitle(priorTitle, current.id)));
		const overridden =
			getOverriddenHistoryTitle(
				selectedAgentId,
				current?.id ?? session.sessionId,
				session.sessionId,
			) ||
			(current?.titleLocked && priorTitle && !priorIsIdPlaceholder
				? priorTitle
				: null);
		const title = overridden
			? overridden
			: acpTitle
				? displayHistoryTitle(acpTitle, "")
				: fromLines || (priorTitle && !priorIsIdPlaceholder ? priorTitle : "");

		if (current) {
			const record: AgentSessionRecord = {
				...current,
				source:
					current.source === "local"
						? ("local" as const)
						: ("external" as const),
				agentName,
				title,
				titleLocked: Boolean(overridden) || current.titleLocked,
				startedAt: current.startedAt || startedAt,
				providerSessionId: session.sessionId,
			};
			if (!acpTitle && !title && current.lines.length === 0) {
				hydrationCandidates.push(record);
			}
			return record;
		}

		const record: AgentSessionRecord = {
			id: session.sessionId,
			agentId: selectedAgentId,
			source: "external" as const,
			title,
			...(overridden ? { titleLocked: true as const } : {}),
			agentName,
			startedAt,
			lines: [],
			status: "completed" as const,
			providerSessionId: session.sessionId,
		};
		if (!acpTitle && !overridden) {
			hydrationCandidates.push(record);
		}
		return record;
	});

	const importedIds = new Set(listed.map((session) => session.sessionId));
	const localOnly = prev.filter((item) => {
		const providerId = item.providerSessionId?.trim() ?? "";
		return (
			item.agentId === selectedAgentId &&
			!isDismissedAcpSession(selectedAgentId, item.id) &&
			(providerId === "" ||
				!isDismissedAcpSession(selectedAgentId, providerId)) &&
			!importedIds.has(item.id) &&
			!importedIds.has(providerId) &&
			!isBackgroundWorkflowHistoryTitle(item.title) &&
			(item.status === "running" ||
				(item.source === "local" && item.lines.length > 0))
		);
	});

	return {
		sessions: [...localOnly, ...imported],
		hydrationCandidates,
	};
}

export type UseAgentHistoryOptions = {
	refs: Pick<
		AgentPanelRefs,
		| "activeConversationRef"
		| "activeTabRef"
		| "historyGenRef"
		| "historyHydrationGenRef"
		| "selectedAgentIdRef"
		| "sessionHistoryRef"
		| "submittingRef"
		| "vaultPathRef"
	>;
	t: AgentPanelT;
	i18nLanguage: string;
	vaultPath: string | null;
	selectedAgentId: string | null;
	selected: AgentOption | undefined;
	setSessionHistory: (
		update:
			| AgentSessionRecord[]
			| ((prev: AgentSessionRecord[]) => AgentSessionRecord[]),
	) => void;
	setLines: (update: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => void;
	hydrateAndActivateSession: (
		session: AgentSessionRecord,
		lines: ChatLine[],
		title?: string,
	) => void;
	setHydratingSessionId: (id: string | null) => void;
	activateComposerSession: (sessionId: string) => void;
	setHistoryOpen: Dispatch<SetStateAction<boolean>>;
	/** When true, finish hydrating any still-untitled rows in the open drawer. */
	historyOpen: boolean;
	clearMessageQueue: () => void;
};

export type AgentHistory = {
	openHistorySession: (item: ChatSessionHistoryItem) => void;
	removeHistorySession: (
		item: ChatSessionHistoryItem,
	) => Promise<AcpDeleteSessionResult>;
};

export function useAgentHistory({
	refs: {
		activeConversationRef,
		activeTabRef,
		historyGenRef,
		historyHydrationGenRef,
		selectedAgentIdRef,
		sessionHistoryRef,
		submittingRef,
		vaultPathRef,
	},
	t,
	i18nLanguage,
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
}: UseAgentHistoryOptions): AgentHistory {
	const sessionStore = useAgentSessionStoreApi();
	const [supportsResume, setSupportsResume] = useState(false);

	const [historyLoaded, setHistoryLoaded] = useState(false);

	const runTitleHydration = useCallback(
		(items: AgentSessionRecord[], generation: number) => {
			if (!selectedAgentId || items.length === 0) return;
			void hydrateSessionTitles(items, {
				generation,
				historyGenRef,
				selectedAgentId,
				vaultPath,
				setSessionHistory,
			});
		},
		[historyGenRef, selectedAgentId, setSessionHistory, vaultPath],
	);

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
			const { sessions: mergedSessions, hydrationCandidates } =
				mergeImportedSessions(
					sessionStore.getState().sessions,
					chatSessions,
					selectedAgentId,
					selected?.name ?? "Agent",
					i18nLanguage,
				);
			// Instant titles from prior session/load results (localStorage).
			const nextSessions = applyCachedHistoryTitles(
				selectedAgentId,
				mergedSessions,
			) as AgentSessionRecord[];
			setSessionHistory(nextSessions);

			const needHydration = sessionsNeedingTitleHydration(
				nextSessions,
				selectedAgentId,
			);
			const candidates =
				needHydration.length > 0 ? needHydration : hydrationCandidates;
			if (candidates.length > 0 && generation === historyGenRef.current) {
				runTitleHydration(candidates, generation);
			}
		} catch {
			// History is supplementary: a failed scan must not block the Composer.
		} finally {
			if (generation === historyGenRef.current) {
				setHistoryLoaded(true);
			}
		}
	}, [
		i18nLanguage,
		selected?.name,
		selectedAgentId,
		vaultPath,
		setSessionHistory,
		sessionStore,
		historyGenRef,
		runTitleHydration,
	]);

	useEffect(() => {
		void loadAgentHistory();
		return () => {
			historyGenRef.current += 1;
		};
	}, [loadAgentHistory, historyGenRef]);

	// Opening the drawer: finish any titles still missing so the user does not
	// have to click into a row just to learn what it was about (#484).
	useEffect(() => {
		if (!historyOpen || !selectedAgentId || !historyLoaded) return;
		const pending = sessionsNeedingTitleHydration(
			sessionHistoryRef.current,
			selectedAgentId,
		);
		if (pending.length === 0) return;
		runTitleHydration(pending, historyGenRef.current);
	}, [
		historyOpen,
		historyLoaded,
		selectedAgentId,
		runTitleHydration,
		historyGenRef,
		sessionHistoryRef,
	]);

	const openHistorySession = (item: ChatSessionHistoryItem) => {
		if (submittingRef.current) return;
		const providerSessionId = providerSessionIdForHistoryLoad(item);
		const hydrationGeneration = ++historyHydrationGenRef.current;
		setHistoryOpen(false);
		clearMessageQueue();
		if (!supportsResume || item.lines.length > 0) {
			const localLines = sanitizeChatLines(item.lines);
			setHydratingSessionId(null);
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
		setHydratingSessionId(item.id);
		activateComposerSession(item.id);
		activeTabRef.current = item.id;
		activeConversationRef.current = providerSessionId;
		sessionStore.getState().upsertSession(
			{
				...item,
				lines: [],
			},
			{ activate: true },
		);
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
								...(line.visualAnnotations?.length
									? { visualAnnotations: line.visualAnnotations }
									: {}),
								...(line.images?.length ? { images: line.images } : {}),
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
				if (nextLines.length === 0) {
					nextLines.push({
						id: nextLineId("sys"),
						kind: "system",
						text: t("messages.sessionEmpty"),
					});
				}
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
				setHydratingSessionId(null);
				setLines((prev) => [...prev, errorChatLine(errorText(error))]);
			}
		})();
	};

	const removeHistorySession = useCallback(
		async (item: ChatSessionHistoryItem) => {
			const providerId = item.providerSessionId?.trim() || item.id;
			const active =
				activeTabRef.current === item.id ||
				activeTabRef.current === providerId ||
				sessionStore.getState().activeTabId === item.id ||
				sessionStore.getState().activeTabId === providerId;
			// Drop the continue target before the RPC returns so a queued send
			// cannot resume the conversation being removed. The visible tab
			// stays until the delete succeeds.
			if (active) {
				activeConversationRef.current = null;
				clearMessageQueue();
			}
			const result = await deleteHistorySession(
				item,
				vaultPathRef.current,
				sessionStore,
			);
			if (active) {
				activeTabRef.current = "draft";
				activateComposerSession("draft");
			}
			return result;
		},
		[
			activateComposerSession,
			activeConversationRef,
			activeTabRef,
			clearMessageQueue,
			sessionStore,
			vaultPathRef,
		],
	);

	return {
		openHistorySession,
		removeHistorySession,
	};
}
