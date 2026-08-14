import i18n from "@/i18n";
import { cancelAgentRun, isAgentRunActive } from "@/lib/agent";
import {
	enqueueBackgroundTask,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";
import { joinVaultPath, readVaultFile, writeVaultFile } from "@/lib/vault";
import type { DefenseDebrief } from "@/lib/voice-defense/debrief";
import { createDefaultAgentRunner } from "@/lib/voice-defense/preparation/coordinator";
import type { DefenseQuestion } from "@/lib/voice-defense/preparation/schema";
import { DefenseOutputValidationError } from "@/lib/voice-defense/preparation/schema";
import type { VoiceCaption } from "@/lib/voice-defense/protocol";
import { buildDefenseReviewMarkdown } from "@/lib/voice-defense/review/markdown";
import { buildSessionReviewPrompt } from "@/lib/voice-defense/review/prompts";
import {
	type DefenseSessionReview,
	parseDefenseSessionReview,
} from "@/lib/voice-defense/review/schema";
import {
	voiceTranscriptReviewFileName,
	withTranscriptReviewLink,
} from "@/lib/voice-defense/transcript";

export const DEFAULT_REVIEW_TIMEOUT_MS = 8 * 60 * 1000;

type ActiveReview = {
	controller: AbortController;
	sessionId?: string;
};

let activeReview: ActiveReview | null = null;

export function isDefenseReviewActive(): boolean {
	return activeReview !== null;
}

export async function cancelDefenseReview(): Promise<void> {
	const current = activeReview;
	if (!current) return;
	current.controller.abort();
	if (current.sessionId) {
		await cancelAgentRun(current.sessionId).catch(() => undefined);
	}
}

export type DefenseReviewInput = {
	vaultRoot: string;
	title: string;
	transcriptPath: string;
	brief: string;
	briefPath?: string;
	captions: readonly VoiceCaption[];
	questions: readonly DefenseQuestion[];
	debrief: DefenseDebrief | null;
	allowedSourcePaths: readonly string[];
	language: "en" | "zh-CN";
	agentId?: string | null;
	modelId?: string | null;
	reasoningEffort?: string | null;
};

export type DefenseReviewResult = {
	review: DefenseSessionReview;
	reviewPath: string;
};

const runHidden = createDefaultAgentRunner(
	isAgentRunActive,
	DEFAULT_REVIEW_TIMEOUT_MS,
);

async function runReviewAttempt(
	input: DefenseReviewInput,
	signal: AbortSignal,
	onSession: (sessionId: string) => void,
): Promise<DefenseSessionReview> {
	const prompt = buildSessionReviewPrompt({
		language: input.language,
		brief: input.brief,
		captions: input.captions,
		questions: input.questions,
		debrief: input.debrief,
		allowedSourcePaths: input.allowedSourcePaths,
	});
	const result = await runHidden({
		vaultRoot: input.vaultRoot,
		role: "paper-analysis",
		prompt,
		target: input.briefPath || input.transcriptPath,
		request: {
			agentId: input.agentId || undefined,
			modelId: input.modelId || undefined,
			reasoningEffort: input.reasoningEffort || undefined,
			responseLanguage: input.language,
			workflow: "voice_defense_review",
			permissionMode: "restricted",
			autoApprove: false,
			hideFromChatHistory: true,
		},
		signal,
		onStarted: (accepted) => onSession(accepted.sessionId),
		onFinished: () => undefined,
	});
	return parseDefenseSessionReview(result.content, input.allowedSourcePaths);
}

export async function startDefenseReview(
	input: DefenseReviewInput,
): Promise<DefenseReviewResult> {
	if (activeReview) {
		throw new Error("a defense review is already running");
	}
	const controller = new AbortController();
	activeReview = { controller };
	try {
		return await enqueueBackgroundTask(
			{
				kind: "voiceDefenseReview",
				title: i18n.t("app:tasks.voiceDefenseReview"),
				detail: i18n.t("app:tasks.voiceDefenseReviewRunning"),
			},
			async (context) => {
				context.signal.addEventListener("abort", () => controller.abort(), {
					once: true,
				});
				let lastError: unknown;
				for (let attempt = 0; attempt < 2; attempt += 1) {
					try {
						const review = await runReviewAttempt(
							input,
							controller.signal,
							(sessionId) => {
								if (activeReview) activeReview.sessionId = sessionId;
							},
						);
						const reviewPath = voiceTranscriptReviewFileName(
							input.transcriptPath,
						);
						const markdown = buildDefenseReviewMarkdown({
							title: input.title,
							language: input.language,
							transcriptPath: input.transcriptPath,
							briefPath: input.briefPath,
							review,
						});
						await writeVaultFile(
							joinVaultPath(input.vaultRoot, reviewPath),
							markdown,
						);
						try {
							const transcript = await readVaultFile(
								joinVaultPath(input.vaultRoot, input.transcriptPath),
							);
							await writeVaultFile(
								joinVaultPath(input.vaultRoot, input.transcriptPath),
								withTranscriptReviewLink(
									transcript,
									reviewPath,
									review.weakAreas,
								),
							);
						} catch {
							// Review file is the source of truth; linking is best-effort.
						}
						return { review, reviewPath };
					} catch (error) {
						lastError = error;
						if (
							controller.signal.aborted ||
							isBackgroundTaskCancelledError(error)
						) {
							throw error;
						}
						if (
							!(error instanceof DefenseOutputValidationError) ||
							attempt === 1
						) {
							throw error;
						}
					}
				}
				throw lastError instanceof Error
					? lastError
					: new Error(String(lastError));
			},
			{ concurrency: 1, signal: controller.signal },
		);
	} finally {
		activeReview = null;
	}
}
