import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ContextRequest } from "@/lib/agent/context-request";
import { type AgentRunRefs, disposeAgentRun } from "@/lib/agent/run-attach";
import { errorText } from "@/lib/core/error";
import { createEmptyThread } from "@/lib/pdf/ask";
import {
	resendBaseMessages,
	resolveAskAgent,
	runAskTurn,
} from "@/lib/pdf/ask/run-turn";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import { getVaultPath } from "@/lib/vault/store";

export type SelectionAskState<S> = { thread: PdfAskThread; screen: S };
export function createSelectionAskThread(
	sourcePath: string,
	quote: string,
): PdfAskThread {
	return createEmptyThread({
		paperPath: sourcePath,
		anchor: { page: 1, rects: [], quote, trigger: "selection" },
	});
}

/** Ephemeral Ask with request-local cancellation, including delayed Agent discovery. */
export function useSelectionAsk<S>({
	buildPrompt,
	context,
	activeSessionRef,
}: {
	buildPrompt: (thread: PdfAskThread, question: string) => string;
	context?: (thread: PdfAskThread) => ContextRequest | null;
	activeSessionRef: RefObject<string | null>;
}) {
	const { t } = useTranslation("viewer");
	const [ask, setAskState] = useState<SelectionAskState<S> | null>(null);
	const [streaming, setStreaming] = useState(false);
	const [askError, setAskError] = useState<string | null>(null);
	const current = useRef(ask);
	const run = useRef<AgentRunRefs | null>(null);
	const busy = useRef(false);
	const stopAskStreaming = useCallback(() => {
		if (run.current) disposeAgentRun(run.current);
		run.current = null;
		busy.current = false;
		setStreaming(false);
	}, []);
	const setAsk = useCallback(
		(value: SelectionAskState<S> | null) => {
			stopAskStreaming();
			current.current = value;
			setAskState(value);
			setAskError(null);
		},
		[stopAskStreaming],
	);
	const hideAsk = useCallback(() => setAsk(null), [setAsk]);
	useEffect(
		() => () => {
			if (run.current) disposeAgentRun(run.current);
		},
		[],
	);
	const send = useCallback(
		(question: string, baseMessages?: PdfAskThread["messages"]) => {
			const selected = current.current;
			if (!selected || !question.trim() || busy.current) return;
			if (run.current) disposeAgentRun(run.current);
			const refs: AgentRunRefs = {
				disposedRef: { current: false },
				unsubsRef: { current: null },
				sessionRef: { current: null },
				activeSessionRef,
			};
			run.current = refs;
			busy.current = true;
			const isCurrent = () =>
				run.current === refs &&
				!refs.disposedRef.current &&
				current.current?.thread.id === selected.thread.id;
			const fail = (error: string | null) => {
				if (isCurrent()) setAskError(error);
			};
			const update = (thread: PdfAskThread) => {
				if (!isCurrent() || !current.current) return;
				current.current = { ...current.current, thread };
				setAskState(current.current);
			};
			// Capture context before discovery yields: a newer source cannot alter this turn.
			const requestContext = context?.(selected.thread) ?? undefined;
			const promptSource = buildPrompt;
			setStreaming(true);
			setAskError(null);
			void (async () => {
				try {
					const agent = await resolveAskAgent(() => t("pdfAsk.noAgent"), fail);
					if (!isCurrent()) return;
					if (!agent) {
						setStreaming(false);
						busy.current = false;
						return;
					}
					await runAskTurn({
						thread: selected.thread,
						question,
						agent,
						baseMessages,
						vaultPath: getVaultPath() ?? undefined,
						buildPrompt: promptSource,
						context: requestContext,
						...refs,
						upsertThread: update,
						patchThread: (id, transform, applied) => {
							if (!isCurrent() || current.current?.thread.id !== id) return;
							const thread = transform(current.current.thread);
							update(thread);
							applied?.(thread);
						},
						setAskError: fail,
						setStreaming: (value) => {
							if (!isCurrent()) return;
							setStreaming(value);
							busy.current = value;
						},
						failureText: () => t("pdfAsk.agentFailed"),
					});
				} catch (error) {
					fail(errorText(error));
					if (isCurrent()) {
						setStreaming(false);
						busy.current = false;
					}
				}
			})();
		},
		[activeSessionRef, buildPrompt, context, t],
	);
	const sendAskQuestion = useCallback(
		(question: string) => send(question),
		[send],
	);
	const resendAskQuestion = useCallback(
		(id: string, question: string) => {
			const selected = current.current;
			if (!selected) return;
			const base = resendBaseMessages(selected.thread.messages, id);
			if (base) send(question, base);
		},
		[send],
	);
	return {
		ask,
		setAsk,
		streaming,
		askError,
		sendAskQuestion,
		resendAskQuestion,
		hideAsk,
		deleteAsk: hideAsk,
		stopAskStreaming,
	};
}
