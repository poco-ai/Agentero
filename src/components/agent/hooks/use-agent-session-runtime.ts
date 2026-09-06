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
	useState,
} from "react";
import type {
	AgentPanelRefs,
	AgentPanelT,
} from "@/components/agent/hooks/use-agent-panel-context";
import {
	type AgentEffortChoice,
	type AgentModeChoice,
	type AgentModelChoice,
	type AgentPlanEvent,
	type AgentResultPayload,
	type AgentStreamEvent,
	type AgentToolEvent,
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
	listenAgentStream,
	listenAgentTool,
	listenAgentUsage,
} from "@/lib/agent";
import {
	type AgentSessionRecord,
	agentSessionStore,
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
	ThinkTagParser,
} from "@/lib/agent/stream-parse";
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
};

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
	const updateSessionLines = useCallback(
		(sessionId: string, update: (lines: ChatLine[]) => ChatLine[]) => {
			// Shared store: modal pin + sidebar both observe the same lines.
			agentSessionStore.getState().updateSessionLines(sessionId, update);
		},
		[],
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
		[isChatOwnedSession, thinkParsersRef, updateSessionLines],
	);

	// OpenCode / Claude / Codex tool-shaped ask → bottom form surface (not transcript).
	// Declared before applyToolEvent so the promote path can set it.
	const [toolAskUserRequest, setToolAskUserRequest] =
		useState<ToolAskUserRequest | null>(null);

	const applyToolEvent = useCallback(
		(ev: AgentToolEvent) => {
			if (!isChatOwnedSession(ev.sessionId)) return;
			updateSessionLines(ev.sessionId, (prev) =>
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
			thinkParsersRef.current.delete(ev.sessionId);
			updateSessionLines(ev.sessionId, (prev) => {
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
			finalizeAskThreads,
			finalizeVisualTraces,
			isChatOwnedSession,
			t,
			thinkParsersRef,
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
			finalizeAskThreads,
			finalizeVisualTraces,
			isChatOwnedSession,
			updateSessionLines,
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
			const uSessionInfo = await listenAgentSessionInfo((ev) => {
				const title = ev.title ? displayHistoryTitle(ev.title) : "";
				if (!title) return;
				const providerId = ev.providerSessionId?.trim() ?? "";
				agentSessionStore.getState().setSessions((prev) => {
					let changed = false;
					const next = prev.map((s) => {
						const matches =
							s.id === ev.sessionId ||
							(providerId !== "" && s.providerSessionId === providerId);
						// Visual-trace titles are user-meaningful; never override them.
						if (!matches || s.visualTraceId || s.title === title) return s;
						changed = true;
						return { ...s, title };
					});
					return changed ? next : prev;
				});
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
				uSessionInfo();
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
				uSessionInfo,
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
		pendingTerminalEventsRef,
		setAcpCommandsByAgent,
		setAgentListenersReady,
		setUsage,
		setUsageBySession,
		shouldDeferTerminalEvent,
	]);

	return {
		toolAskUserRequest,
		setToolAskUserRequest,
		applyStreamEvent,
		applyToolEvent,
		applyPlanEvent,
		completeSession,
		failSession,
	};
}
