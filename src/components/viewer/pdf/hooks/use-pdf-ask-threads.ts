/**
 * Ask (AI Q&A) threads for the EmbedPDF viewer: a text selection becomes a
 * conversation anchored to its rects, persisted as `marks/<id>.json` and reopened
 * from its gutter pin or from the annotations panel.
 *
 * The turn state machine (optimistic user message → runOnce → stream /
 * completed / failed patches) lives in `@/lib/pdf/ask/run-turn`; this hook owns
 * the thread-array container and the persist steps that make an interrupted
 * app run recoverable, so those write points are wired in here, not in the
 * engine.
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
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { CardScreenPoint } from "@/components/viewer/pdf/types";
import { disposeAgentRun, type PromptImage } from "@/lib/agent";
import { pdfAskContextRequest } from "@/lib/agent/context-request";
import {
	createEmptyThread,
	deletePdfAskThread,
	writePdfAskThread,
} from "@/lib/pdf/ask";
import {
	buildPdfAskPrompt,
	rememberPairedAskTranslation,
} from "@/lib/pdf/ask/prompt";
import {
	cancelAskRun,
	dispatchAskTurn,
	type ResolvedAskAgent,
	resendBaseMessages,
	resolveAskAgent,
	runAskTurn,
	stopAskRun,
} from "@/lib/pdf/ask/run-turn";
import { threadHasUserQuestion } from "@/lib/pdf/ask/schema";
import type { PdfAskAnchor, PdfAskThread } from "@/lib/pdf/ask/types";
import type { ActiveSelectionCard } from "@/lib/pdf/selection";

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
	startFromAnchor: (anchor: PdfAskAnchor, translation?: string) => void;
	/**
	 * Resolve the configured PDF-ask agent (default seat + model), reporting a
	 * missing agent through the ask error chrome. Also used by visual marks.
	 */
	resolvePdfAskAgent: () => Promise<ResolvedAskAgent | null>;
	sendAskQuestion: (question: string) => void;
	/** Edit a user turn: drop it and everything after, then re-send. */
	resendAskQuestion: (messageId: string, question: string) => void;
	/** Card hide button: keep a started draft or end a thread with a question, then dismiss. */
	hideAskThread: (draft?: string) => void;
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
	/** Per-run IPC unlisteners of the in-flight ask turn (null when idle). */
	const runUnsubsRef = useRef<UnlistenFn[] | null>(null);
	/** ACP session of the in-flight ask turn (null when idle). */
	const askSessionRef = useRef<string | null>(null);
	/** True once the viewer unmounts; guards runs accepted after teardown. */
	const runDisposedRef = useRef(false);

	// Closing the viewer must not strand the run's IPC listeners (or the run
	// itself): terminal events never arrive for a hung run, so teardown cannot
	// rely on the completed/failed handlers alone.
	useEffect(() => {
		runDisposedRef.current = false;
		return () => {
			disposeAgentRun({
				disposedRef: runDisposedRef,
				unsubsRef: runUnsubsRef,
				sessionRef: askSessionRef,
				activeSessionRef,
			});
		};
	}, [activeSessionRef]);

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

	const patchThread = useCallback(
		(
			threadId: string,
			transform: (thread: PdfAskThread) => PdfAskThread,
			onApplied?: (thread: PdfAskThread) => void,
		) => {
			setThreads((prev) =>
				prev.map((th) => {
					if (th.id !== threadId) return th;
					const done = transform(th);
					onApplied?.(done);
					return done;
				}),
			);
		},
		[setThreads],
	);

	const clearAskError = useCallback(() => {
		setAskError(null);
	}, []);

	const removeThread = useCallback(
		(threadId: string) => {
			setThreads((prev) => prev.filter((th) => th.id !== threadId));
			rememberPairedAskTranslation(threadId, "");
			if (paperAbsPath) void deletePdfAskThread(paperAbsPath, threadId);
		},
		[paperAbsPath, setThreads],
	);

	const closeAskChrome = useCallback((_threadId: string) => {
		// Non-explicit closes keep a started draft (and its pin/highlight); the
		// card itself deletes only when the composer was never touched.
		setAskError(null);
	}, []);

	const openThread = useCallback(
		(thread: PdfAskThread) => openCard({ kind: "ask", id: thread.id }),
		[openCard],
	);

	const createThreadFromAnchor = useCallback(
		(anchor: PdfAskAnchor) => {
			const paperPath = paperRelPath || paperAbsPath || "paper";
			const thread = createEmptyThread({ paperPath, anchor });
			// Keep conversations and started drafts; only untouched empties are
			// dropped when the next Ask starts.
			setThreads((prev) => [
				thread,
				...prev.filter(
					(th) => threadHasUserQuestion(th) || Boolean(th.draft?.trim()),
				),
			]);
			return thread;
		},
		[paperAbsPath, paperRelPath, setThreads],
	);

	const startFromAnchor = useCallback(
		(anchor: PdfAskAnchor, translation?: string) => {
			const thread = createThreadFromAnchor(anchor);
			if (translation?.trim()) {
				rememberPairedAskTranslation(thread.id, translation);
			}
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
		) =>
			runAskTurn({
				thread,
				question,
				agent: agentOpts,
				baseMessages,
				images,
				vaultPath: vaultPath ?? undefined,
				buildPrompt: buildPdfAskPrompt,
				context: pdfAskContextRequest(thread),
				upsertThread,
				patchThread,
				persist,
				setAskError,
				setStreaming,
				failureText: () => t("pdfAsk.agentFailed"),
				disposedRef: runDisposedRef,
				unsubsRef: runUnsubsRef,
				sessionRef: askSessionRef,
				activeSessionRef,
			}),
		[upsertThread, patchThread, persist, vaultPath, t, activeSessionRef],
	);

	const resolvePdfAskAgent = useCallback(
		async () => resolveAskAgent(() => t("pdfAsk.noAgent"), setAskError),
		[t],
	);

	/** A sent question consumes the session-only composer draft. */
	const clearDraft = useCallback(
		(thread: PdfAskThread) => {
			if (thread.draft === undefined) return thread;
			const clean: PdfAskThread = { ...thread, draft: undefined };
			upsertThread(clean);
			return clean;
		},
		[upsertThread],
	);

	const sendAskQuestion = useCallback(
		(question: string) => {
			const card = activeCardRef.current;
			const threadId = card?.kind === "ask" ? card.id : null;
			if (!threadId) return;
			const current = threadsRef.current.find((th) => th.id === threadId);
			if (!current) return;
			const thread = clearDraft(current);
			dispatchAskTurn({
				thread,
				question,
				resolveAgent: resolvePdfAskAgent,
				run: sendToThread,
				onError: setAskError,
			});
		},
		[clearDraft, sendToThread, resolvePdfAskAgent, activeCardRef, threadsRef],
	);

	/** Edit last (or any) user turn: drop that message and everything after, then re-send. */
	const resendAskQuestion = useCallback(
		(messageId: string, question: string) => {
			const card = activeCardRef.current;
			const threadId = card?.kind === "ask" ? card.id : null;
			if (!threadId) return;
			const current = threadsRef.current.find((th) => th.id === threadId);
			if (!current) return;
			const baseMessages = resendBaseMessages(current.messages, messageId);
			if (!baseMessages) return;
			const thread = clearDraft(current);
			dispatchAskTurn({
				thread,
				question,
				baseMessages,
				resolveAgent: resolvePdfAskAgent,
				run: sendToThread,
				onError: setAskError,
			});
		},
		[clearDraft, sendToThread, resolvePdfAskAgent, activeCardRef, threadsRef],
	);

	/** Cancel the run, clear the chrome, and close the card if it is an ask card. */
	const dismissAskChrome = useCallback(() => {
		cancelAskRun(askSessionRef, activeSessionRef);
		setStreaming(false);
		setAskError(null);
		if (activeCardRef.current?.kind === "ask") {
			setActiveCard(null);
			setCardScreen(null);
		}
	}, [activeCardRef, setActiveCard, setCardScreen, activeSessionRef]);

	const hideAskThread = useCallback(
		(draft?: string) => {
			const id =
				activeCardRef.current?.kind === "ask" ? activeCardRef.current.id : null;
			if (id) {
				const thread = threadsRef.current.find((th) => th.id === id);
				if (thread) {
					const text = draft?.trim();
					if (threadHasUserQuestion(thread)) {
						// Keep an unsent follow-up too: the conversation stays ended
						// until it is reopened, and the draft is restored with it.
						const nextDraft = text || undefined;
						if (thread.status !== "ended" || nextDraft !== thread.draft) {
							const ended: PdfAskThread = {
								...thread,
								draft: nextDraft,
								status: "ended",
								updatedAt: new Date().toISOString(),
							};
							upsertThread(ended);
							void persist(ended);
						}
					} else if (text && text !== thread.draft) {
						// Keep a started draft (text, pin and highlight) so reopening
						// continues where the user left off. The card calls
						// deleteAskThread instead when the composer was untouched.
						upsertThread({ ...thread, draft: text });
					}
				}
			}
			dismissAskChrome();
		},
		[upsertThread, persist, dismissAskChrome, activeCardRef, threadsRef],
	);

	const deleteAskThread = useCallback(() => {
		const id =
			activeCardRef.current?.kind === "ask" ? activeCardRef.current.id : null;
		if (id) removeThread(id);
		dismissAskChrome();
	}, [removeThread, dismissAskChrome, activeCardRef]);

	const stopAskStreaming = useCallback(() => {
		stopAskRun(askSessionRef, activeSessionRef, () => setStreaming(false));
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
