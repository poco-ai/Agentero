/**
 * Ask (AI Q&A) threads for the EmbedPDF viewer: a text selection becomes a
 * conversation anchored to its rects, persisted as `marks/<id>.json` and reopened
 * from its gutter pin or from the annotations panel.
 *
 * Its own hook because a turn is a small state machine that nothing else shares:
 * optimistic user message → `runOnce` → three ACP listeners (stream / completed /
 * failed) that append into the *thread array* rather than into local state, with
 * one cleanup closure per turn. Persisting on every terminal event is what makes
 * an interrupted app run recoverable, so those write points are part of the
 * machine, not of the caller.
 *
 * Boundaries:
 * - the thread array lives in {@link usePdfMarksIo}: setters and the mirror ref
 *   are injected, never re-declared here;
 * - card placement / hover lives in {@link usePdfCards}: this hook only opens
 *   ask cards and tears down their chrome;
 * - `activeSessionRef` is shared with the translate cluster (at most one PDF
 *   agent run is in flight), so the parent owns it and injects it into both;
 * - `resolvePdfAskAgent` is owned here because it reports through the ask error
 *   chrome, and returned so the visual-mark cluster can reuse the same default
 *   agent resolution;
 * - the selection menu owns its own teardown, so the parent closes the menu and
 *   hands this hook the anchor.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { CardScreenPoint } from "@/components/viewer/embed/pdf-viewer-types";
import {
	cancelAgentRun,
	listAgents,
	listenAgentCompleted,
	listenAgentFailed,
	listenAgentStream,
	type PromptImage,
	runOnce,
} from "@/lib/agent";
import { notifyError } from "@/lib/core/notify";
import {
	createEmptyThread,
	deletePdfAskThread,
	newMessageId,
	writePdfAskThread,
} from "@/lib/pdf/ask";
import { buildPdfAskPrompt } from "@/lib/pdf/ask/prompt";
import { threadHasUserQuestion } from "@/lib/pdf/ask/schema";
import type { PdfAskAnchor, PdfAskThread } from "@/lib/pdf/ask/types";
import type { ActiveSelectionCard } from "@/lib/pdf/selection";
import { loadSettings } from "@/lib/settings";
import { resolveTranslateAgent } from "@/lib/translate";

/** Agent seat + model chosen for a PDF-ask turn (also reused by visual marks). */
type ResolvedAskAgent = Awaited<ReturnType<typeof resolveTranslateAgent>>;

export type UsePdfAskThreadsOptions = {
	/** Sidecar root for `marks/<id>.json` (null for loose PDFs — nothing persists). */
	paperAbsPath: string | null;
	/** Vault-relative provenance stamped into new threads. */
	paperRelPath: string | null;
	/** Vault root passed to the Agent run as its cwd. */
	vaultPath: string | null;
	/** Persisted ask threads; owned by {@link usePdfMarksIo}. */
	threadsRef: RefObject<PdfAskThread[]>;
	setThreads: Dispatch<SetStateAction<PdfAskThread[]>>;
	upsertThread: (thread: PdfAskThread) => void;
	/** Cards cluster; owned by {@link usePdfCards}. */
	openCard: (card: ActiveSelectionCard) => void;
	activeCardRef: RefObject<ActiveSelectionCard | null>;
	setActiveCard: Dispatch<SetStateAction<ActiveSelectionCard | null>>;
	setCardScreen: Dispatch<SetStateAction<CardScreenPoint | null>>;
	/**
	 * Single in-flight PDF agent run, shared with the translate cluster.
	 * Parent-owned so either cluster can cancel the other's session token.
	 */
	activeSessionRef: RefObject<string | null>;
};

export type PdfAskThreads = {
	/** True while an ask turn is streaming into the open card. */
	streaming: boolean;
	askError: string | null;
	/** Open (or re-open) a thread's conversation card. */
	openThread: (thread: PdfAskThread) => void;
	/** Selection-menu action: create an empty thread and open its card. */
	startFromAnchor: (anchor: PdfAskAnchor) => void;
	/**
	 * Resolve the configured PDF-ask agent (default seat + model), reporting a
	 * missing agent through the ask error chrome. Also used by visual marks.
	 */
	resolvePdfAskAgent: () => Promise<ResolvedAskAgent | null>;
	sendAskQuestion: (question: string) => void;
	/** Edit a user turn: drop it and everything after, then re-send. */
	resendAskQuestion: (messageId: string, question: string) => void;
	/** Card hide button: end the thread (or drop an empty draft) and dismiss. */
	hideAskThread: () => void;
	deleteAskThread: () => void;
	stopAskStreaming: () => void;
	/** Per-kind chrome reset when an ask card opens (wired into `usePdfCards`). */
	clearAskError: () => void;
	/** Per-kind chrome reset when an ask card closes (wired into `usePdfCards`). */
	closeAskChrome: (threadId: string) => void;
};

export function usePdfAskThreads({
	paperAbsPath,
	paperRelPath,
	vaultPath,
	threadsRef,
	setThreads,
	upsertThread,
	openCard,
	activeCardRef,
	setActiveCard,
	setCardScreen,
	activeSessionRef,
}: UsePdfAskThreadsOptions): PdfAskThreads {
	const { t } = useTranslation("viewer");
	const [streaming, setStreaming] = useState(false);
	const [askError, setAskError] = useState<string | null>(null);

	const persist = useCallback(
		async (thread: PdfAskThread) => {
			if (!paperAbsPath) return;
			try {
				await writePdfAskThread(paperAbsPath, thread);
			} catch {
				// keep UI responsive
			}
		},
		[paperAbsPath],
	);

	/** A card closed without a question was never a thread — drop the draft. */
	const discardIfEmptyDraft = useCallback(
		(threadId: string | null) => {
			if (!threadId) return;
			const th = threadsRef.current.find((t) => t.id === threadId);
			if (!th || threadHasUserQuestion(th)) return;
			setThreads((prev) => prev.filter((t) => t.id !== threadId));
		},
		[setThreads, threadsRef],
	);

	const clearAskError = useCallback(() => {
		setAskError(null);
	}, []);

	const closeAskChrome = useCallback(
		(threadId: string) => {
			discardIfEmptyDraft(threadId);
			setAskError(null);
		},
		[discardIfEmptyDraft],
	);

	const openThread = useCallback(
		(thread: PdfAskThread) => openCard({ kind: "ask", id: thread.id }),
		[openCard],
	);

	const createThreadFromAnchor = useCallback(
		(anchor: PdfAskAnchor) => {
			const paperPath = paperRelPath || paperAbsPath || "paper";
			const thread = createEmptyThread({ paperPath, anchor });
			setThreads((prev) => [thread, ...prev.filter(threadHasUserQuestion)]);
			return thread;
		},
		[paperAbsPath, paperRelPath, setThreads],
	);

	const startFromAnchor = useCallback(
		(anchor: PdfAskAnchor) => {
			const thread = createThreadFromAnchor(anchor);
			openThread(thread);
		},
		[createThreadFromAnchor, openThread],
	);

	const sendToThread = useCallback(
		async (
			thread: PdfAskThread,
			question: string,
			agentOpts?: { agentId?: string; modelId?: string },
			/** When set (edit/resend), replace the transcript from this base instead of appending to full history. */
			baseMessages?: PdfAskThread["messages"],
			/** Visual PDF crops attached to this turn. */
			images?: PromptImage[],
		) => {
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
			void persist(withUser);
			setAskError(null);
			setStreaming(true);

			const assistantId = newMessageId();
			const prompt = buildPdfAskPrompt(withUser, question);
			try {
				const accepted = await runOnce({
					prompt,
					agentId: agentOpts?.agentId,
					modelId: agentOpts?.modelId,
					images,
					vaultPath: vaultPath ?? undefined,
					workflow: "free",
					autoApprove: true,
					hideFromChatHistory: true,
				});
				activeSessionRef.current = accepted.sessionId;
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
				upsertThread(withAssistant);
				const sessionId = accepted.sessionId;
				const unsubs: UnlistenFn[] = [];
				const cleanup = () => {
					for (const u of unsubs) u();
					if (activeSessionRef.current === sessionId)
						activeSessionRef.current = null;
					setStreaming(false);
				};
				unsubs.push(
					await listenAgentStream((ev) => {
						if (ev.sessionId !== sessionId) return;
						if ((ev.kind ?? "message") === "thought") return;
						setThreads((prev) =>
							prev.map((th) => {
								if (th.id !== threadId) return th;
								const msgs = [...th.messages];
								const last = msgs[msgs.length - 1];
								if (last?.id !== assistantId) return th;
								msgs[msgs.length - 1] = {
									...last,
									content: last.content + ev.chunk,
								};
								return { ...th, messages: msgs };
							}),
						);
					}),
				);
				unsubs.push(
					await listenAgentCompleted((ev) => {
						if (ev.sessionId !== sessionId) return;
						setThreads((prev) =>
							prev.map((th) => {
								if (th.id !== threadId) return th;
								const msgs = [...th.messages];
								const last = msgs[msgs.length - 1];
								if (last?.id === assistantId) {
									msgs[msgs.length - 1] = {
										...last,
										content: ev.content || last.content,
										sources: (ev.sources ?? []).map((uri) => ({ uri })),
									};
								}
								const done: PdfAskThread = {
									...th,
									messages: msgs,
									updatedAt: new Date().toISOString(),
								};
								void persist(done);
								return done;
							}),
						);
						cleanup();
					}),
				);
				unsubs.push(
					await listenAgentFailed((ev) => {
						if (ev.sessionId !== sessionId) return;
						setAskError(ev.error || t("pdfAsk.agentFailed"));
						setThreads((prev) =>
							prev.map((th) => {
								if (th.id !== threadId) return th;
								const msgs = th.messages.filter((m) => m.id !== assistantId);
								const done = { ...th, messages: msgs };
								void persist(done);
								return done;
							}),
						);
						cleanup();
					}),
				);
			} catch (e) {
				setStreaming(false);
				setAskError(e instanceof Error ? e.message : t("pdfAsk.agentFailed"));
			}
		},
		[upsertThread, persist, vaultPath, t, setThreads, activeSessionRef],
	);

	const resolvePdfAskAgent = useCallback(async () => {
		const registry = await listAgents().catch(() => null);
		const resolved = resolveTranslateAgent(loadSettings().pdfAsk, registry);
		if (!resolved.agentId) {
			const msg = t("pdfAsk.noAgent");
			notifyError(msg);
			setAskError(msg);
			return null;
		}
		return resolved;
	}, [t]);

	const sendAskQuestion = useCallback(
		(question: string) => {
			const card = activeCardRef.current;
			const threadId = card?.kind === "ask" ? card.id : null;
			if (!threadId) return;
			const thread = threadsRef.current.find((th) => th.id === threadId);
			if (!thread) return;
			void (async () => {
				try {
					const resolved = await resolvePdfAskAgent();
					if (!resolved) return;
					void sendToThread(thread, question, {
						agentId: resolved.agentId,
						modelId: resolved.modelId,
					});
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					notifyError(message);
					setAskError(message);
				}
			})();
		},
		[sendToThread, resolvePdfAskAgent, activeCardRef, threadsRef],
	);

	/** Edit last (or any) user turn: drop that message and everything after, then re-send. */
	const resendAskQuestion = useCallback(
		(messageId: string, question: string) => {
			const card = activeCardRef.current;
			const threadId = card?.kind === "ask" ? card.id : null;
			if (!threadId) return;
			const thread = threadsRef.current.find((th) => th.id === threadId);
			if (!thread) return;
			const index = thread.messages.findIndex(
				(m) => m.id === messageId && m.role === "user",
			);
			if (index < 0) return;
			const baseMessages = thread.messages.slice(0, index);
			void (async () => {
				try {
					const resolved = await resolvePdfAskAgent();
					if (!resolved) return;
					void sendToThread(
						thread,
						question,
						{
							agentId: resolved.agentId,
							modelId: resolved.modelId,
						},
						baseMessages,
					);
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					notifyError(message);
					setAskError(message);
				}
			})();
		},
		[sendToThread, resolvePdfAskAgent, activeCardRef, threadsRef],
	);

	/** Cancel the run, clear the chrome, and close the card if it is an ask card. */
	const dismissAskChrome = useCallback(() => {
		if (activeSessionRef.current) {
			void cancelAgentRun(activeSessionRef.current).catch(() => undefined);
			activeSessionRef.current = null;
		}
		setStreaming(false);
		setAskError(null);
		if (activeCardRef.current?.kind === "ask") {
			setActiveCard(null);
			setCardScreen(null);
		}
	}, [activeCardRef, setActiveCard, setCardScreen, activeSessionRef]);

	const hideAskThread = useCallback(() => {
		const id =
			activeCardRef.current?.kind === "ask" ? activeCardRef.current.id : null;
		if (id) {
			const thread = threadsRef.current.find((th) => th.id === id);
			if (thread) {
				if (!threadHasUserQuestion(thread)) {
					setThreads((prev) => prev.filter((t) => t.id !== thread.id));
				} else if (thread.status !== "ended") {
					const ended: PdfAskThread = {
						...thread,
						status: "ended",
						updatedAt: new Date().toISOString(),
					};
					upsertThread(ended);
					void persist(ended);
				}
			}
		}
		dismissAskChrome();
	}, [
		upsertThread,
		persist,
		dismissAskChrome,
		activeCardRef,
		setThreads,
		threadsRef,
	]);

	const deleteAskThread = useCallback(() => {
		const id =
			activeCardRef.current?.kind === "ask" ? activeCardRef.current.id : null;
		if (id) {
			setThreads((prev) => prev.filter((th) => th.id !== id));
			if (paperAbsPath) void deletePdfAskThread(paperAbsPath, id);
		}
		dismissAskChrome();
	}, [paperAbsPath, dismissAskChrome, activeCardRef, setThreads]);

	const stopAskStreaming = useCallback(() => {
		const sid = activeSessionRef.current;
		if (!sid) return;
		void cancelAgentRun(sid).catch(() => undefined);
		activeSessionRef.current = null;
		setStreaming(false);
	}, [activeSessionRef]);

	return {
		streaming,
		askError,
		openThread,
		startFromAnchor,
		resolvePdfAskAgent,
		sendAskQuestion,
		resendAskQuestion,
		hideAskThread,
		deleteAskThread,
		stopAskStreaming,
		clearAskError,
		closeAskChrome,
	};
}
