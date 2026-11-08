/**
 * Container-agnostic engine for one ask-thread turn: optimistic user message →
 * `runOnce({workflow: "free"})` → armed assistant placeholder →
 * `attachAgentRun` stream / completed / failed patches, plus the resolver /
 * dispatch / resend / stop mechanics every ask surface shares.
 *
 * The owning hook adapts its state container (a single ephemeral card in
 * `useSelectionAsk`, the persisted thread array in `usePdfAskThreads`) through
 * `upsertThread` / `patchThread` and optionally persists turn snapshots. All
 * ids, timestamps, callback order, and failure cleanup match the former
 * in-hook implementations exactly.
 */

import type { RefObject } from "react";
import {
	attachAgentRun,
	cancelAgentRun,
	listAgents,
	type PromptImage,
	runOnce,
} from "@/lib/agent";
import type { ContextRequest } from "@/lib/agent/context-request";
import type { AgentRunRefs } from "@/lib/agent/run-attach";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { newMessageId } from "@/lib/pdf/ask/io";
import type { PdfAskMessage, PdfAskThread } from "@/lib/pdf/ask/types";
import { loadSettings } from "@/lib/settings";
import { resolveTranslateAgent } from "@/lib/translate";

export type ResolvedAskAgent = Awaited<
	ReturnType<typeof resolveTranslateAgent>
>;

/**
 * Resolve the configured PDF-ask agent (default seat + model). A missing
 * agent notifies and reports through the ask error chrome.
 */
export async function resolveAskAgent(
	noAgentText: () => string,
	onError: (message: string) => void,
): Promise<ResolvedAskAgent | null> {
	const registry = await listAgents().catch(() => null);
	const resolved = resolveTranslateAgent(loadSettings().pdfAsk, registry);
	if (!resolved.agentId) {
		const msg = noAgentText();
		notifyError(msg);
		onError(msg);
		return null;
	}
	return resolved;
}

/** Cancel the in-flight ask run (if any) and clear both session slots. */
export function cancelAskRun(
	sessionRef: RefObject<string | null>,
	activeSessionRef: RefObject<string | null>,
): void {
	const sid = sessionRef.current;
	if (!sid) return;
	sessionRef.current = null;
	if (activeSessionRef.current === sid) activeSessionRef.current = null;
	void cancelAgentRun(sid).catch(() => undefined);
}

/** Stop button: cancel + clear refs, then stop the streaming chrome. */
export function stopAskRun(
	sessionRef: RefObject<string | null>,
	activeSessionRef: RefObject<string | null>,
	onStopped: () => void,
): void {
	if (!sessionRef.current) return;
	cancelAskRun(sessionRef, activeSessionRef);
	onStopped();
}

/** Edit-a-user-turn base: messages before the edited one, or null when absent. */
export function resendBaseMessages(
	messages: PdfAskMessage[],
	messageId: string,
): PdfAskMessage[] | null {
	const index = messages.findIndex(
		(m) => m.id === messageId && m.role === "user",
	);
	if (index < 0) return null;
	return messages.slice(0, index);
}

export type DispatchAskTurnOptions = {
	thread: PdfAskThread;
	question: string;
	/** When set (edit/resend), the turn replaces the transcript from this base. */
	baseMessages?: PdfAskMessage[];
	resolveAgent: () => Promise<ResolvedAskAgent | null>;
	run: (
		thread: PdfAskThread,
		question: string,
		agent?: { agentId?: string; modelId?: string },
		baseMessages?: PdfAskMessage[],
	) => unknown;
	onError: (message: string) => void;
};

/** Resolve the ask agent, then fire one turn; resolve failures go to the ask error chrome. */
export function dispatchAskTurn({
	thread,
	question,
	baseMessages,
	resolveAgent,
	run,
	onError,
}: DispatchAskTurnOptions): void {
	void (async () => {
		try {
			const resolved = await resolveAgent();
			if (!resolved) return;
			void run(
				thread,
				question,
				{
					agentId: resolved.agentId,
					modelId: resolved.modelId,
				},
				baseMessages,
			);
		} catch (e) {
			const message = errorText(e);
			notifyError(message);
			onError(message);
		}
	})();
}

/**
 * Patch the live thread by id when the container still holds it. A transform
 * may return the same thread reference to signal no change.
 */
export type AskTurnPatch = (
	threadId: string,
	transform: (thread: PdfAskThread) => PdfAskThread,
	onApplied?: (thread: PdfAskThread) => void,
) => void;

export type RunAskTurnOptions = AgentRunRefs & {
	thread: PdfAskThread;
	question: string;
	agent?: { agentId?: string; modelId?: string };
	/** Replace-from base for resend (defaults to the full history). */
	baseMessages?: PdfAskMessage[];
	/** Visual PDF crops attached to this turn. */
	images?: PromptImage[];
	vaultPath?: string;
	buildPrompt: (thread: PdfAskThread, latestUserQuestion: string) => string;
	/** Host context plan for this turn. Web and plaza asks omit it. */
	context?: ContextRequest;
	/** Merge the turn's thread snapshot into the owning container. */
	upsertThread: (thread: PdfAskThread) => void;
	patchThread: AskTurnPatch;
	/** Optional persistence of turn snapshots (terminal events included). */
	persist?: (thread: PdfAskThread) => void;
	setAskError: (message: string | null) => void;
	setStreaming: (streaming: boolean) => void;
	failureText: () => string;
};

/**
 * Run one ask turn against a thread snapshot: append the optimistic user
 * message, accept the run, then stream / complete / fail the assistant reply
 * back into the container. Listener-registration errors land in the catch
 * path (streaming stopped, error surfaced).
 */
export async function runAskTurn({
	thread,
	question,
	agent,
	baseMessages,
	images,
	vaultPath,
	buildPrompt,
	context,
	upsertThread,
	patchThread,
	persist,
	setAskError,
	setStreaming,
	failureText,
	disposedRef,
	unsubsRef,
	sessionRef,
	activeSessionRef,
}: RunAskTurnOptions): Promise<void> {
	const threadId = thread.id;
	if (!question.trim()) return;
	const userMsg = {
		id: newMessageId(),
		role: "user" as const,
		content: question,
		createdAt: new Date().toISOString(),
	};
	const prior = baseMessages ?? thread.messages;
	const withUser: PdfAskThread = {
		...thread,
		status: "open",
		messages: [...prior, userMsg],
		updatedAt: new Date().toISOString(),
	};
	upsertThread(withUser);
	void persist?.(withUser);
	setAskError(null);
	setStreaming(true);

	const assistantId = newMessageId();
	const prompt = buildPrompt(withUser, question);
	const persistApplied = persist
		? (done: PdfAskThread) => void persist(done)
		: undefined;
	try {
		const accepted = await runOnce({
			prompt,
			agentId: agent?.agentId,
			modelId: agent?.modelId,
			images,
			vaultPath,
			context,
			workflow: "free",
			permissionMode: "auto",
			hideFromChatHistory: true,
		});
		const withAssistant: PdfAskThread = {
			...withUser,
			messages: [
				...withUser.messages,
				{
					id: assistantId,
					role: "assistant",
					content: "",
					createdAt: new Date().toISOString(),
					agentSessionId: accepted.sessionId,
				},
			],
		};
		await attachAgentRun({
			accepted,
			disposedRef,
			unsubsRef,
			sessionRef,
			activeSessionRef,
			onArmed: () => {
				upsertThread(withAssistant);
				// The `withUser` write schedules a marks refresh. Persist the
				// assistant placeholder (and its session id) too, otherwise that
				// refresh reloads a snapshot without the message the stream and
				// completed handlers below need to patch.
				void persist?.(withAssistant);
			},
			onStream: (ev) =>
				patchThread(threadId, (th) => {
					const msgs = [...th.messages];
					const last = msgs[msgs.length - 1];
					if (last?.id !== assistantId) return th;
					msgs[msgs.length - 1] = {
						...last,
						content: last.content + ev.chunk,
					};
					return { ...th, messages: msgs };
				}),
			onCompleted: (ev) =>
				patchThread(
					threadId,
					(th) => {
						const msgs = [...th.messages];
						const last = msgs[msgs.length - 1];
						if (last?.id === assistantId) {
							msgs[msgs.length - 1] = {
								...last,
								content: ev.content || last.content,
								sources: (ev.sources ?? []).map((uri) => ({ uri })),
							};
						}
						return {
							...th,
							messages: msgs,
							updatedAt: new Date().toISOString(),
						};
					},
					persistApplied,
				),
			onFailed: (ev) => {
				setAskError(ev.error || failureText());
				patchThread(
					threadId,
					(th) => ({
						...th,
						messages: th.messages.filter((m) => m.id !== assistantId),
					}),
					persistApplied,
				);
			},
			onSettled: () => setStreaming(false),
		});
	} catch (e) {
		setStreaming(false);
		setAskError(e instanceof Error ? e.message : failureText());
	}
}
