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

import i18n from "@/i18n";
import { type AgentResultPayload, attachAgentRun, runOnce } from "@/lib/agent";
import type { AgentRunRefs } from "@/lib/agent/run-attach";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	evictAgentTranslateSessionId,
	getAgentTranslateSessionId,
	setAgentTranslateSessionId,
} from "@/lib/pdf/translate/agent-session-cache";
import { loadSettings } from "@/lib/settings";
import {
	buildTranslatePrompt,
	displayTranslateError,
	prepareTranslateTask,
	resolveConfiguredTranslateAgent,
	runTranslate,
} from "@/lib/translate";
import { selectionTranslateMode } from "@/lib/translate/dictionary";
import {
	dictionaryCacheKey,
	readDictionaryCache,
	writeDictionaryCache,
} from "@/lib/translate/dictionary-cache";
import {
	contextualDictionaryResult,
	dictionaryEntriesForContext,
	lookupDictionary,
	renderDictionaryEntries,
} from "@/lib/translate/lexicon";
import {
	readSelectionCache,
	selectionCacheKey,
	writeSelectionCache,
} from "@/lib/translate/selection-cache";
import type {
	SelectionTranslateMode,
	TranslateTask,
} from "@/lib/translate/types";

export type RunSelectionTranslateOptions = AgentRunRefs & {
	/** Source text to translate. */
	text: string;
	mode?: SelectionTranslateMode;
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
	mode,
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
	const {
		providerId,
		targetLangName,
		customPrompt,
		customSystem,
		customUser,
		glossary,
		task,
	} = prepareTranslateTask({
		text,
		context,
	});
	const settings = loadSettings().translate;
	const dictionary =
		(mode ?? selectionTranslateMode(text, settings.dictionary.mode)) ===
		"dictionary";
	context = { ...context, dictionary };
	let cacheKey: string | undefined;
	let selectionKey: string | undefined;
	const cachedResult = async (agent?: {
		agentId?: string;
		modelId?: string;
	}) => {
		if (disposedRef.current) return true;
		if (!dictionary) return false;
		try {
			cacheKey = await dictionaryCacheKey({
				text: text.trim(),
				uiLanguage: i18n.language,
				targetLangName,
				sourceLang: task.sourceLang,
				targetLang: task.targetLang,
				providerId,
				config:
					settings.providerConfigs[
						providerId as keyof typeof settings.providerConfigs
					],
				agent,
				customPrompt,
				customSystem,
				customUser,
				glossary,
				surrounding: context.dictionarySurrounding ?? "",
				reference: localEntry,
			});
			const result = await readDictionaryCache(cacheKey, vaultPath);
			if (disposedRef.current) return true;
			if (result) {
				commitProviderResult(result);
				return true;
			}
		} catch {
			/* Cache availability must never block lookup. */
		}
		return disposedRef.current;
	};
	/**
	 * The same passage under the same request contract gets the previous
	 * answer: re-selecting identical text must not spend another request.
	 */
	const cachedTranslation = async (agent?: {
		agentId?: string;
		modelId?: string;
	}) => {
		if (dictionary) return false;
		try {
			selectionKey = await selectionCacheKey({
				text: text.trim(),
				targetLangName,
				sourceLang: task.sourceLang,
				targetLang: task.targetLang,
				providerId,
				config:
					settings.providerConfigs[
						providerId as keyof typeof settings.providerConfigs
					],
				agent,
				customPrompt,
				customSystem,
				customUser,
				glossary,
			});
			const result = await readSelectionCache(selectionKey, vaultPath);
			if (disposedRef.current) return true;
			if (result) {
				commitProviderResult(result);
				return true;
			}
		} catch {
			/* Cache availability must never block a translation. */
		}
		return disposedRef.current;
	};
	const saveResult = (result: string) => {
		if (disposedRef.current || !result.trim()) return;
		if (cacheKey) void writeDictionaryCache(cacheKey, result, vaultPath);
		else if (selectionKey)
			void writeSelectionCache(selectionKey, result, vaultPath);
	};
	let localEntry = "";
	if (dictionary) {
		let entries = await lookupDictionary(text, task.targetLang);
		if (disposedRef.current) return;
		entries = dictionaryEntriesForContext(
			entries,
			text,
			context.dictionarySurrounding,
		);
		localEntry = renderDictionaryEntries(entries, task.targetLang);
		if (localEntry) {
			if (
				settings.dictionary.mode === "offline-first" ||
				!context.dictionarySurrounding ||
				!["agent", "openaiCompatible"].includes(providerId)
			) {
				commitProviderResult(localEntry);
				return;
			}
			appendChunk(localEntry);
			context = { ...context, dictionaryReference: localEntry };
		}
	}
	const withContext = (result: string) =>
		localEntry && result.trim()
			? contextualDictionaryResult(localEntry, result)
			: localEntry || result;
	const fail = (message: string) => {
		if (localEntry) {
			commitProviderResult(localEntry);
			return;
		}
		notifyError(message);
		markFailed(message);
	};

	if (providerId === "agent") {
		const prompt = buildTranslatePrompt({
			text,
			dictionary,
			targetLangName,
			page: context.page,
			surface: context.surface,
			customPrompt,
			customSystem,
			customUser,
			dictionarySurrounding: context.dictionarySurrounding,
			dictionaryReference: context.dictionaryReference,
			glossary,
		});
		try {
			const resolved = await resolveConfiguredTranslateAgent();
			if (disposedRef.current) return;
			if (!resolved.agentId) {
				const msg = noAgentText();
				fail(msg);
				return;
			}
			if (await cachedResult(resolved)) return;
			if (await cachedTranslation(resolved)) return;
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
				onStream: (ev) => {
					if (!localEntry) appendChunk(ev.chunk);
				},
				onCompleted: (ev) => {
					const current = commitAgentResult(
						localEntry ? { ...ev, content: withContext(ev.content) } : ev,
					);
					if (current && ev.stopReason !== "cancelled" && ev.content.trim())
						saveResult(withContext(ev.content));
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
					fail(msg);
				},
				onSettled: () => stopStreaming(),
			});
		} catch (e) {
			if (disposedRef.current) return;
			const message = errorText(e);
			fail(message);
			stopStreaming();
		}
		return;
	}

	try {
		if (await cachedResult()) return;
		if (await cachedTranslation()) return;
		const result = await runTranslate(
			{
				text,
				context,
				sourceLang: task.sourceLang,
				targetLang: task.targetLang,
			},
			{
				providerId,
				customPrompt,
				customSystem,
				customUser,
				providerConfig:
					settings.providerConfigs[
						providerId as keyof typeof settings.providerConfigs
					],
				onDelta: localEntry ? undefined : appendChunk,
			},
		);
		if (disposedRef.current) return;
		commitProviderResult(withContext(result.trim()));
		saveResult(withContext(result.trim()));
	} catch (e) {
		if (disposedRef.current) return;
		const message = displayTranslateError(errorText(e));
		fail(message);
		stopStreaming();
	}
}
