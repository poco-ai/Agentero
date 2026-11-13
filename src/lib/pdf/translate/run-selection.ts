/**
 * Container-agnostic engine for one selection-translate run: resolve the
 * configured provider, then either stream an ACP Agent turn
 * (`runOnce({workflow: "translate"})` + `attachAgentRun`) or await a plain
 * translate provider.
 *
 * The owning hook adapts its record container (the persisted `translates`
 * array in `usePdfSelectionTranslate`, the single ephemeral card in
 * `useWebViewSelection`) through the callbacks below. Prompt shape,
 * session-id cache get/set/evict timing, trim logic, callback order, and
 * failure cleanup match the former in-hook implementations exactly —
 * including the no-agent path leaving the streaming chrome alone (the
 * consumer's `markFailed` decides whether it stops).
 */

import { type AgentResultPayload, attachAgentRun, runOnce } from "@/lib/agent";
import type { AgentRunRefs } from "@/lib/agent/run-attach";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	evictAgentTranslateSessionId,
	getAgentTranslateSessionId,
	setAgentTranslateSessionId,
} from "@/lib/pdf/translate/agent-session-cache";
import {
	buildTranslatePrompt,
	displayTranslateError,
	prepareTranslateTask,
	resolveConfiguredTranslateAgent,
	runTranslate,
} from "@/lib/translate";
import {
	buildDictionaryPrompt,
	extractPaperDefinition,
	shouldUseDictionary,
} from "@/lib/translate/dictionary";
import type { TranslateTask } from "@/lib/translate/types";

export type RunSelectionTranslateOptions = AgentRunRefs & {
	/** Source text to translate. */
	text: string;
	/** Provenance shared by the task context and the agent prompt. */
	context: NonNullable<TranslateTask["context"]>;
	/** Session-cache key (paper path or web URL; null disables reuse). */
	paperKey: string | null;
	/** Vault root passed to the Agent run as its cwd. */
	vaultPath?: string | null;
	noAgentText: () => string;
	agentFailedText: () => string;
	/** Append one streamed chunk to the record. */
	appendChunk: (chunk: string) => void;
	/**
	 * Commit the final agent result (trim + record write + error chrome
	 * clear). Return false when the record is no longer current — that also
	 * skips the session-id cache write.
	 */
	commitAgentResult: (ev: AgentResultPayload) => boolean;
	/**
	 * Commit a plain-provider result (already trimmed), including the
	 * streaming-chrome stop — the consumer may guard record staleness.
	 */
	commitProviderResult: (result: string) => void;
	/** Mark the record failed; the consumer owns record/error chrome updates. */
	markFailed: (message: string) => void;
	/** Stop the streaming chrome (agent settle + both catch paths). */
	stopStreaming: () => void;
};

/**
 * Run one selection translate: branch on the configured provider, stream the
 * Agent turn into the consumer's record, or await the plain provider.
 * Listener-registration errors land in the catch path (streaming stopped,
 * failure marked). Returns when the synchronous dispatch is handed off
 * (agent runs keep streaming through the ACP listeners).
 */
export async function runSelectionTranslate({
	text,
	context,
	paperKey,
	vaultPath,
	noAgentText,
	agentFailedText,
	appendChunk,
	commitAgentResult,
	commitProviderResult,
	markFailed,
	stopStreaming,
	disposedRef,
	unsubsRef,
	sessionRef,
	activeSessionRef,
}: RunSelectionTranslateOptions): Promise<void> {
	const { providerId, targetLangName, customPrompt, customSystem, customUser } =
		prepareTranslateTask({
			text,
			context,
		});

	// Phase 2: 判定是否使用词典模式
	const isDictionary = shouldUseDictionary(text);

	// Phase 2: L1 论文内定义提取（暂时返回 undefined）
	const paperDefinition = await extractPaperDefinition(text);

	if (providerId === "agent") {
		// 根据模式选择提示词
		const prompt = isDictionary
			? buildDictionaryPrompt({
					word: text,
					sentence: context.quote || text, // 使用上下文句子，如果没有则使用原文
					targetLang: targetLangName,
					paperDefinition: paperDefinition?.text,
				})
			: buildTranslatePrompt({
					text,
					targetLangName,
					page: context.page,
					surface: context.surface,
					customPrompt,
					customSystem,
					customUser,
				});
		try {
			const resolved = await resolveConfiguredTranslateAgent();
			if (disposedRef.current) return;
			if (!resolved.agentId) {
				const msg = noAgentText();
				notifyError(msg);
				markFailed(msg);
				return;
			}
			const agentId = resolved.agentId;
			const modelId = resolved.modelId;
			const accepted = await runOnce({
				prompt,
				agentId,
				modelId,
				sessionId:
					getAgentTranslateSessionId(paperKey, agentId, modelId) ?? undefined,
				vaultPath: vaultPath ?? undefined,
				workflow: "translate",
				permissionMode: "auto",
				hideFromChatHistory: true,
			});
			await attachAgentRun({
				accepted,
				disposedRef,
				unsubsRef,
				sessionRef,
				activeSessionRef,
				onStream: (ev) => appendChunk(ev.chunk),
				onCompleted: (ev) => {
					const current = commitAgentResult(ev);
					if (
						current &&
						ev.providerSessionId &&
						ev.stopReason !== "cancelled"
					) {
						setAgentTranslateSessionId(
							paperKey,
							agentId,
							modelId,
							ev.providerSessionId,
						);
					}
				},
				onFailed: (ev) => {
					if (disposedRef.current) return;
					evictAgentTranslateSessionId(paperKey, agentId, modelId);
					const msg = ev.error || agentFailedText();
					notifyError(msg);
					markFailed(msg);
				},
				onSettled: () => stopStreaming(),
			});
		} catch (e) {
			if (disposedRef.current) return;
			const message = errorText(e);
			notifyError(message);
			markFailed(message);
			stopStreaming();
		}
		return;
	}

	try {
		const result = await runTranslate({ text, context }, { providerId });
		if (disposedRef.current) return;
		commitProviderResult(result.trim());
	} catch (e) {
		if (disposedRef.current) return;
		const message = displayTranslateError(errorText(e));
		notifyError(message);
		markFailed(message);
		stopStreaming();
	}
}
