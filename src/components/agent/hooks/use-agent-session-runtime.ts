/**
 * Agent session runtime: applies stream/tool/plan events to owned sessions,
 * finalizes turns (complete/fail), defers events during submission races, and
 * owns the host event listeners plus the tool-shaped ask-user surface state.
 */
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import type {
	AgentPanelRefs,
	AgentPanelT,
} from "@/components/agent/hooks/use-agent-panel-context";
import {
	type AgentEffortChoice,
	type AgentModeChoice,
	type AgentModelChoice,
	type AgentPhaseState,
	type AgentPlanEvent,
	type AgentResultPayload,
	type AgentStreamEvent,
	type AgentToolEvent,
	CODEX_INSTRUCTION_BUDGET_PHASE,
	displayHistoryTitle,
	listenAgentCollaboration,
	listenAgentCommands,
	listenAgentCompleted,
	listenAgentEffort,
	listenAgentFailed,
	listenAgentFastMode,
	listenAgentModels,
	listenAgentPlan,
	listenAgentSessionInfo,
	listenAgentStatus,
	listenAgentStream,
	listenAgentTool,
	listenAgentUsage,
} from "@/lib/agent";
import {
	type AgentSessionRecord,
	type AgentSessionStoreApi,
	useAgentSessionScope,
} from "@/lib/agent/agent-session-store";
import {
	type AgentPart,
	agentHasContent,
	agentReasoningFromParts,
	agentTextFromParts,
	appendStreamPart,
	applyToolToLines,
	type ChatLine,
	errorChatLine,
	failIncompleteTools,
	isPendingAskUserToolStatus,
	type PendingSessionEvent,
	parseAskUserQuestions,
	shouldDeferSessionEvent,
	type ToolAskUserRequest,
	upsertPlanPart,
} from "@/lib/agent/chat-state";
import { type AcpCommand, mapAcpCommands } from "@/lib/agent/slash-commands";
import {
	classifyStreamChunk,
	promoteOrphanThoughtToText,
	type StreamSlice,
	ThinkTagParser,
} from "@/lib/agent/stream-parse";
import { notifyError, notifyWarning } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import {
	completeTrace,
	failTrace,
	readPdfVisualTrace,
	takePendingVisualTraces,
	writePdfVisualTrace,
} from "@/lib/pdf/agent-trace";
import {
	appendAskAssistantMessage,
	readPdfAskThread,
	takePendingAskThreads,
	writePdfAskThread,
} from "@/lib/pdf/ask";
import { nextLineId, nextPartId } from "@/lib/pdf-visual/ids";
import { playCue } from "@/lib/ui/sound";

export type UseAgentSessionRuntimeOptions = {
	refs: Pick<
		AgentPanelRefs,
		| "activeConversationRef"
		| "activeTabRef"
		| "knownSessionIdsRef"
		| "pendingSessionEventsRef"
		| "pendingSubmissionSessionIdRef"
		| "pendingTerminalEventsRef"
		| "sessionHistoryRef"
		| "submittingRef"
		| "thinkParsersRef"
	>;
	t: AgentPanelT;
	setSessionHistory: (
		update:
			| AgentSessionRecord[]
			| ((prev: AgentSessionRecord[]) => AgentSessionRecord[]),
	) => void;
	applyModelsEvent: (ev: {
		agentId: string;
		configId: string;
		currentId: string;
		models: AgentModelChoice[];
	}) => void;
	applyCollaborationEvent: (ev: {
		agentId: string;
		currentId: string;
		modes: AgentModeChoice[];
	}) => void;
	applyEffortEvent: (ev: {
		agentId: string;
		currentId: string;
		efforts: AgentEffortChoice[];
	}) => void;
	applyFastModeEvent: (ev: { agentId: string; enabled: boolean }) => void;
	setUsage: Dispatch<SetStateAction<{ used: number; size: number } | null>>;
	setUsageBySession: Dispatch<
		SetStateAction<Record<string, { used: number; size: number }>>
	>;
	setAcpCommandsByAgent: Dispatch<SetStateAction<Record<string, AcpCommand[]>>>;
	setAgentListenersReady: Dispatch<SetStateAction<boolean>>;
};

export type AgentSessionRuntime = {
	toolAskUserRequest: ToolAskUserRequest | null;
	setToolAskUserRequest: Dispatch<SetStateAction<ToolAskUserRequest | null>>;
	applyStreamEvent: (ev: AgentStreamEvent) => void;
	applyToolEvent: (ev: AgentToolEvent) => void;
	applyPlanEvent: (ev: AgentPlanEvent) => void;
	completeSession: (ev: AgentResultPayload) => void;
	failSession: (sessionId: string, error: string) => void;
	/** Whether this chat surface owns the session (stream / dialog routing). */
	isChatOwnedSession: (sessionId: string) => boolean;
	/** Live turn phase per session (drives the streaming activity label/orb). */
	phaseBySession: Record<string, AgentPhaseState>;
};

/**
 * One Tauri subscription per window. Panel unmount does not unsubscribe —
 * callbacks read this map, which the mounted runtime refreshes every render,
 * and the previous entry keeps applying events into the session store until
 * the same scope mounts again. `pagehide` is the only unsubscribe.
 */
type AgentRuntimeListener = {
	shouldDeferTerminalEvent: (sessionId: string) => boolean;
	deferSessionEvent: (sessionId: string, event: PendingSessionEvent) => void;
	applyStreamEvent: (ev: AgentStreamEvent) => void;
	applyToolEvent: (ev: AgentToolEvent) => void;
	applyPlanEvent: (ev: AgentPlanEvent) => void;
	setUsage: UseAgentSessionRuntimeOptions["setUsage"];
	setUsageBySession: UseAgentSessionRuntimeOptions["setUsageBySession"];
	setAcpCommandsByAgent: UseAgentSessionRuntimeOptions["setAcpCommandsByAgent"];
	applyModelsEvent: UseAgentSessionRuntimeOptions["applyModelsEvent"];
	applyCollaborationEvent: UseAgentSessionRuntimeOptions["applyCollaborationEvent"];
	applyEffortEvent: UseAgentSessionRuntimeOptions["applyEffortEvent"];
	applyFastModeEvent: UseAgentSessionRuntimeOptions["applyFastModeEvent"];
	completeSession: (ev: AgentResultPayload) => void;
	failSession: (sessionId: string, error: string) => void;
	isChatOwnedSession: (sessionId: string) => boolean;
	showCodexInstructionWarning: () => void;
	setPhaseBySession: Dispatch<SetStateAction<Record<string, AgentPhaseState>>>;
	setAgentListenersReady: UseAgentSessionRuntimeOptions["setAgentListenersReady"];
	pendingTerminalEventsRef: UseAgentSessionRuntimeOptions["refs"]["pendingTerminalEventsRef"];
	sessionStore: AgentSessionStoreApi;
};

const agentRuntimeListeners = new Map<string, AgentRuntimeListener>();

let agentRuntimeListenPromise: Promise<void> | null = null;
let agentRuntimeUnsubs: Array<() => void> | null = null;
let agentRuntimePageHidden = false;
let agentRuntimePagehideBound = false;

function bindAgentRuntimePagehide(): void {
	if (agentRuntimePagehideBound || typeof window === "undefined") return;
	agentRuntimePagehideBound = true;
	window.addEventListener("pagehide", () => {
		agentRuntimePageHidden = true;
		const unsubs = agentRuntimeUnsubs;
		agentRuntimeUnsubs = [];
		if (!unsubs) return;
		for (const unsub of unsubs) unsub();
	});
}

function keepOrDropUnsub(unsub: () => void, bucket: Array<() => void>): void {
	if (agentRuntimePageHidden) {
		unsub();
		return;
	}
	bucket.push(unsub);
}

async function subscribeAgentRuntimeListeners(): Promise<void> {
	const bucket: Array<() => void> = [];
	const collect = async (pending: Promise<() => void>) => {
		keepOrDropUnsub(await pending, bucket);
	};
	try {
		await collect(
			listenAgentStream((ev) => {
				for (const listener of agentRuntimeListeners.values()) {
					if (listener.shouldDeferTerminalEvent(ev.sessionId)) {
						listener.deferSessionEvent(ev.sessionId, {
							kind: "stream",
							event: ev,
						});
						continue;
					}
					listener.applyStreamEvent(ev);
				}
			}),
		);
		await collect(
			listenAgentTool((ev) => {
				for (const listener of agentRuntimeListeners.values()) {
					if (listener.shouldDeferTerminalEvent(ev.sessionId)) {
						listener.deferSessionEvent(ev.sessionId, {
							kind: "tool",
							event: ev,
						});
						continue;
					}
					listener.applyToolEvent(ev);
				}
			}),
		);
		await collect(
			listenAgentPlan((ev) => {
				for (const listener of agentRuntimeListeners.values()) {
					if (listener.shouldDeferTerminalEvent(ev.sessionId)) {
						listener.deferSessionEvent(ev.sessionId, {
							kind: "plan",
							event: ev,
						});
						continue;
					}
					listener.applyPlanEvent(ev);
				}
			}),
		);
		await collect(
			listenAgentUsage((ev) => {
				if (ev.size <= 0) return;
				for (const listener of agentRuntimeListeners.values()) {
					if (ev.sessionId === "warm") {
						listener.setUsage({ used: ev.used, size: ev.size });
						continue;
					}
					listener.setUsageBySession((prev) => ({
						...prev,
						[ev.sessionId]: { used: ev.used, size: ev.size },
					}));
				}
			}),
		);
		await collect(
			listenAgentCommands((ev) => {
				for (const listener of agentRuntimeListeners.values()) {
					listener.setAcpCommandsByAgent((prev) => ({
						...prev,
						[ev.agentId]: mapAcpCommands(ev.commands),
					}));
				}
			}),
		);
		await collect(
			listenAgentSessionInfo((ev) => {
				const title = ev.title ? displayHistoryTitle(ev.title) : "";
				if (!title) return;
				const providerId = ev.providerSessionId?.trim() ?? "";
				for (const listener of agentRuntimeListeners.values()) {
					listener.sessionStore.getState().setSessions((prev) => {
						let changed = false;
						const next = prev.map((s) => {
							const matches =
								s.id === ev.sessionId ||
								(providerId !== "" && s.providerSessionId === providerId);
							// Visual-trace and user-renamed titles are meaningful; never override.
							if (
								!matches ||
								s.visualTraceId ||
								s.titleLocked ||
								s.title === title
							) {
								return s;
							}
							changed = true;
							return { ...s, title };
						});
						return changed ? next : prev;
					});
				}
			}),
		);
		await collect(
			listenAgentModels((ev) => {
				for (const listener of agentRuntimeListeners.values()) {
					listener.applyModelsEvent(ev);
				}
			}),
		);
		await collect(
			listenAgentCollaboration((ev) => {
				for (const listener of agentRuntimeListeners.values()) {
					listener.applyCollaborationEvent(ev);
				}
			}),
		);
		await collect(
			listenAgentEffort((ev) => {
				for (const listener of agentRuntimeListeners.values()) {
					listener.applyEffortEvent(ev);
				}
			}),
		);
		await collect(
			listenAgentFastMode((ev) => {
				for (const listener of agentRuntimeListeners.values()) {
					listener.applyFastModeEvent(ev);
				}
			}),
		);
		await collect(
			listenAgentCompleted((ev) => {
				for (const listener of agentRuntimeListeners.values()) {
					if (listener.shouldDeferTerminalEvent(ev.sessionId)) {
						listener.pendingTerminalEventsRef.current.set(ev.sessionId, {
							kind: "completed",
							event: ev,
						});
						continue;
					}
					listener.completeSession(ev);
				}
			}),
		);
		await collect(
			listenAgentFailed((ev) => {
				for (const listener of agentRuntimeListeners.values()) {
					if (listener.shouldDeferTerminalEvent(ev.sessionId)) {
						listener.pendingTerminalEventsRef.current.set(ev.sessionId, {
							kind: "failed",
							error: ev.error,
						});
						continue;
					}
					listener.failSession(ev.sessionId, ev.error);
				}
			}),
		);
		await collect(
			listenAgentStatus((ev) => {
				for (const listener of agentRuntimeListeners.values()) {
					if (!listener.isChatOwnedSession(ev.sessionId)) continue;
					if (
						ev.phase === "notice-error" ||
						ev.phase === "notice-warning" ||
						ev.phase === "notice-info"
					) {
						if (ev.detail) {
							const show =
								ev.phase === "notice-error"
									? notifyError
									: ev.phase === "notice-warning"
										? notifyWarning
										: toast.info;
							show(ev.detail);
						}
						continue;
					}
					if (ev.phase === CODEX_INSTRUCTION_BUDGET_PHASE) {
						listener.showCodexInstructionWarning();
						continue;
					}
					const phase = ev.phase;
					if (
						phase !== "starting" &&
						phase !== "waiting-model" &&
						phase !== "reconnecting"
					) {
						continue;
					}
					const detail = ev.detail?.trim();
					listener.setPhaseBySession((prev) => {
						const current = prev[ev.sessionId];
						if (
							current?.phase === phase &&
							current.detail === (detail || undefined)
						) {
							return prev;
						}
						return {
							...prev,
							[ev.sessionId]: {
								phase,
								detail: detail || undefined,
							},
						};
					});
				}
			}),
		);
		agentRuntimeUnsubs = bucket;
		if (agentRuntimePageHidden) {
			const pending = agentRuntimeUnsubs ?? [];
			agentRuntimeUnsubs = [];
			for (const unsub of pending) unsub();
		}
	} catch (error) {
		for (const unsub of bucket) unsub();
		if (agentRuntimeUnsubs === bucket) agentRuntimeUnsubs = [];
		throw error;
	}
}

/** Start the window subscription, or wait if a mount is already in `listen`. */
function ensureAgentRuntimeListeners(): Promise<void> {
	if (!agentRuntimeListenPromise) {
		agentRuntimeListenPromise = subscribeAgentRuntimeListeners().catch(
			(error: unknown) => {
				agentRuntimeListenPromise = null;
				throw error;
			},
		);
	}
	return agentRuntimeListenPromise;
}

export function useAgentSessionRuntime({
	refs: {
		activeConversationRef,
		activeTabRef,
		knownSessionIdsRef,
		pendingSessionEventsRef,
		pendingSubmissionSessionIdRef,
		pendingTerminalEventsRef,
		sessionHistoryRef,
		submittingRef,
		thinkParsersRef,
	},
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
}: UseAgentSessionRuntimeOptions): AgentSessionRuntime {
	const { store: sessionStore, scopeId } = useAgentSessionScope();
	const listenerScopeKey = scopeId ?? "rail";
	const updateSessionLines = useCallback(
		(sessionId: string, update: (lines: ChatLine[]) => ChatLine[]) => {
			// Shared store: modal pin + sidebar both observe the same lines.
			sessionStore.getState().updateSessionLines(sessionId, update);
		},
		[sessionStore],
	);

	/**
	 * Streamed chunks arrive ~25×/s and each one used to trigger a store update
	 * plus a full panel re-render. Buffer the classified slices per session and
	 * flush once per animation frame so streaming aligns with the render loop.
	 * Non-stream updates flush the buffer first, preserving event order.
	 */
	const streamBufferRef = useRef<Map<string, StreamSlice[]>>(new Map());
	const streamFlushFrameRef = useRef(0);

	const flushStreamBuffer = useCallback(
		(sessionId: string) => {
			const buffer = streamBufferRef.current.get(sessionId);
			if (!buffer?.length) return;
			streamBufferRef.current.delete(sessionId);
			updateSessionLines(sessionId, (prev) => {
				const next = [...prev];
				const last = next[next.length - 1];
				if (last?.kind !== "agent" || !last.streaming) return prev;
				let parts = last.parts;
				for (const slice of buffer) {
					parts = appendStreamPart(parts, slice.kind, slice.text);
				}
				next[next.length - 1] = {
					...last,
					parts,
				};
				return next;
			});
		},
		[updateSessionLines],
	);

	const flushAllStreamBuffers = useCallback(() => {
		for (const sessionId of [...streamBufferRef.current.keys()]) {
			flushStreamBuffer(sessionId);
		}
	}, [flushStreamBuffer]);

	/** Apply a non-stream update after any buffered chunks of the same session. */
	const updateSessionLinesOrdered = useCallback(
		(sessionId: string, update: (lines: ChatLine[]) => ChatLine[]) => {
			flushStreamBuffer(sessionId);
			updateSessionLines(sessionId, update);
		},
		[flushStreamBuffer, updateSessionLines],
	);

	/** Only composer-owned sessions (or pending submit) update the chat transcript. */
	const isChatOwnedSession = useCallback(
		(sessionId: string) => {
			if (knownSessionIdsRef.current.has(sessionId)) return true;
			if (pendingSubmissionSessionIdRef.current === sessionId) return true;
			if (activeTabRef.current === sessionId && sessionId !== "draft")
				return true;
			return sessionHistoryRef.current.some((item) => item.id === sessionId);
		},
		[
			activeTabRef,
			knownSessionIdsRef,
			pendingSubmissionSessionIdRef,
			sessionHistoryRef,
		],
	);

	// OpenCode / Claude / Codex tool-shaped ask → bottom form surface (not transcript).
	// Declared before applyToolEvent so the promote path can set it.
	const [toolAskUserRequest, setToolAskUserRequest] =
		useState<ToolAskUserRequest | null>(null);

	/** Backend loading phase of the current turn, keyed by runtime session. */
	const [phaseBySession, setPhaseBySession] = useState<
		Record<string, AgentPhaseState>
	>({});

	/** Drop the phase once real output arrives / the turn finalizes. */
	const clearPhase = useCallback((sessionId: string) => {
		setPhaseBySession((prev) => {
			if (!prev[sessionId]) return prev;
			const next = { ...prev };
			delete next[sessionId];
			return next;
		});
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
			// Real model output arrived — the loading phase is over.
			clearPhase(ev.sessionId);
			const buffer = streamBufferRef.current.get(ev.sessionId) ?? [];
			for (const slice of slices) {
				if (slice.text) buffer.push(slice);
			}
			if (!buffer.length) return;
			streamBufferRef.current.set(ev.sessionId, buffer);
			if (streamFlushFrameRef.current) return;
			streamFlushFrameRef.current = requestAnimationFrame(() => {
				streamFlushFrameRef.current = 0;
				flushAllStreamBuffers();
			});
		},
		[clearPhase, flushAllStreamBuffers, isChatOwnedSession, thinkParsersRef],
	);

	const applyToolEvent = useCallback(
		(ev: AgentToolEvent) => {
			if (!isChatOwnedSession(ev.sessionId)) return;
			clearPhase(ev.sessionId);
			updateSessionLinesOrdered(ev.sessionId, (prev) =>
				applyToolToLines(prev, {
					id: ev.toolCallId,
					title: ev.title,
					kind: ev.kind,
					status: ev.status,
					input: ev.input,
					output: ev.output,
					full: ev.full,
				}),
			);

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
		[clearPhase, isChatOwnedSession, updateSessionLinesOrdered],
	);

	const applyPlanEvent = useCallback(
		(ev: AgentPlanEvent) => {
			if (!isChatOwnedSession(ev.sessionId)) return;
			clearPhase(ev.sessionId);
			updateSessionLinesOrdered(ev.sessionId, (prev) => {
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
		[clearPhase, isChatOwnedSession, updateSessionLinesOrdered],
	);

	const deferSessionEvent = useCallback(
		(sessionId: string, event: PendingSessionEvent) => {
			const pending = pendingSessionEventsRef.current.get(sessionId) ?? [];
			pending.push(event);
			pendingSessionEventsRef.current.set(sessionId, pending);
		},
		[pendingSessionEventsRef],
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
			clearPhase(ev.sessionId);
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
				updateSessionLinesOrdered(ev.sessionId, (prev) => {
					const next = [...prev];
					const last = next[next.length - 1];
					if (last?.kind === "agent" && last.streaming) {
						if (agentHasContent(last.parts)) {
							next[next.length - 1] = {
								...last,
								parts: failIncompleteTools(last.parts),
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
			playCue("done");
			thinkParsersRef.current.delete(ev.sessionId);
			updateSessionLinesOrdered(ev.sessionId, (prev) => {
				const next = [...prev];
				const last = next[next.length - 1];
				if (last?.kind === "agent" && last.streaming) {
					let parts = failIncompleteTools(last.parts);
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
						promptOnly: ev.promptOnly,
						artifacts: ev.artifacts,
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
			activeConversationRef,
			activeTabRef,
			clearPhase,
			finalizeAskThreads,
			finalizeVisualTraces,
			isChatOwnedSession,
			t,
			thinkParsersRef,
			updateSessionLinesOrdered,
			setSessionHistory,
		],
	);

	const failSession = useCallback(
		(sessionId: string, error: string) => {
			if (!isChatOwnedSession(sessionId)) return;
			playCue("error");
			clearPhase(sessionId);
			const failedLine: ChatLine = errorChatLine(error);
			updateSessionLinesOrdered(sessionId, (prev) => {
				const next = [...prev];
				const last = next[next.length - 1];
				if (last?.kind === "agent" && last.streaming) {
					if (agentHasContent(last.parts)) {
						next[next.length - 1] = {
							...last,
							parts: failIncompleteTools(last.parts),
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
			clearPhase,
			finalizeAskThreads,
			finalizeVisualTraces,
			isChatOwnedSession,
			updateSessionLinesOrdered,
			setSessionHistory,
		],
	);

	const shouldDeferTerminalEvent = useCallback(
		(sessionId: string) => {
			return shouldDeferSessionEvent({
				sessionId,
				submitting: submittingRef.current,
				pendingRuntimeSessionId: pendingSubmissionSessionIdRef.current,
				knownSessionIds: knownSessionIdsRef.current,
			});
		},
		[knownSessionIdsRef, pendingSubmissionSessionIdRef, submittingRef],
	);

	const flushAllStreamBuffersRef = useRef(flushAllStreamBuffers);
	flushAllStreamBuffersRef.current = flushAllStreamBuffers;
	// Latest callbacks for the window-level listeners. Left in place on unmount
	// so events during the gap still land in this scope's store.
	agentRuntimeListeners.set(listenerScopeKey, {
		shouldDeferTerminalEvent,
		deferSessionEvent,
		applyStreamEvent,
		applyToolEvent,
		applyPlanEvent,
		setUsage,
		setUsageBySession,
		setAcpCommandsByAgent,
		applyModelsEvent,
		applyCollaborationEvent,
		applyEffortEvent,
		applyFastModeEvent,
		completeSession,
		failSession,
		isChatOwnedSession,
		showCodexInstructionWarning: () =>
			notifyWarning(t("codexInstructionBudget.title"), {
				description: t("codexInstructionBudget.description"),
				id: CODEX_INSTRUCTION_BUDGET_PHASE,
				duration: Number.POSITIVE_INFINITY,
			}),
		setPhaseBySession,
		setAgentListenersReady,
		pendingTerminalEventsRef,
		sessionStore,
	});

	useEffect(() => {
		if (!isTauri()) return;
		bindAgentRuntimePagehide();
		let active = true;
		void ensureAgentRuntimeListeners().then(
			() => {
				if (!active) return;
				agentRuntimeListeners
					.get(listenerScopeKey)
					?.setAgentListenersReady(true);
			},
			() => undefined,
		);
		return () => {
			active = false;
			if (streamFlushFrameRef.current) {
				cancelAnimationFrame(streamFlushFrameRef.current);
				streamFlushFrameRef.current = 0;
			}
			flushAllStreamBuffersRef.current();
		};
	}, [listenerScopeKey]);

	return {
		toolAskUserRequest,
		setToolAskUserRequest,
		applyStreamEvent,
		applyToolEvent,
		applyPlanEvent,
		completeSession,
		failSession,
		isChatOwnedSession,
		phaseBySession,
	};
}
