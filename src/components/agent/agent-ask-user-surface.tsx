/**
 * Structured ask-user UI (elicitation / Grok ext / tool-promote).
 * While active, replaces the bottom composer (mutually exclusive with free-text input).
 */
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useMemo } from "react";
import { AskUserQuestionForm } from "@/components/agent/ask-user-question-form";
import type { AskUserRequest, ElicitationRequest } from "@/lib/agent";
import { respondAskUser, respondElicitation } from "@/lib/agent/api";
import {
	type AskUserAnswer,
	type AskUserQuestion,
	elicitationContentFromAnswers,
	formatAskUserAnswers,
	questionsFromAskUserDtos,
	questionsFromElicitationFields,
	type ToolAskUserRequest,
} from "@/lib/agent/chat-state";
import { MOTION_MS } from "@/lib/core/motion";
import { cn } from "@/lib/core/utils";

/**
 * Floating material sheet docked above the composer. Enters with a short
 * spring from below (cross-fade when reduced motion is requested) so the
 * questionnaire reads as a layer arriving over the transcript.
 */
function AskUserSurfaceCard({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	const reduceMotion = useReducedMotion();
	return (
		<div className={cn("shrink-0 px-3 pb-3", className)}>
			<motion.div
				initial={
					reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.99 }
				}
				animate={{ opacity: 1, y: 0, scale: 1 }}
				transition={
					reduceMotion
						? { duration: MOTION_MS.fast / 1000, ease: "easeOut" }
						: { type: "spring", bounce: 0, duration: 0.4 }
				}
				className="relative overflow-hidden rounded-2xl border border-border/60 bg-popover/85 px-4 pt-2 pb-3 shadow-overlay backdrop-blur-xl backdrop-saturate-150 supports-backdrop-blur:bg-popover/70"
			>
				{children}
			</motion.div>
		</div>
	);
}

/** True when the panel should show a questionnaire and hide the composer. */
export function isAskUserSurfaceActive(input: {
	elicitationRequest: ElicitationRequest | null;
	askUserRequest: AskUserRequest | null;
	toolAskUserRequest: ToolAskUserRequest | null;
}): boolean {
	if (
		input.elicitationRequest &&
		questionsFromElicitationFields(input.elicitationRequest.fields).length > 0
	) {
		return true;
	}
	if (
		input.askUserRequest &&
		questionsFromAskUserDtos(input.askUserRequest.questions).length > 0
	) {
		return true;
	}
	return Boolean(
		input.toolAskUserRequest && input.toolAskUserRequest.questions.length > 0,
	);
}

export function AgentAskUserSurface({
	elicitationRequest,
	onElicitationResolved,
	askUserRequest,
	onAskUserResolved,
	toolAskUserRequest,
	onToolAskUserResolved,
	onAnswerToolAskUser,
	onRecordAskUserAnswers,
	disabled = false,
	className,
}: {
	elicitationRequest: ElicitationRequest | null;
	onElicitationResolved: () => void;
	askUserRequest: AskUserRequest | null;
	onAskUserResolved: () => void;
	toolAskUserRequest: ToolAskUserRequest | null;
	onToolAskUserResolved: () => void;
	onAnswerToolAskUser: (input: {
		answer: string;
		toolCallId: string;
		questions: AskUserQuestion[];
		answers: AskUserAnswer[];
	}) => Promise<boolean>;
	/** Persist the answered/cancelled questionnaire on the matching transcript tool card. */
	onRecordAskUserAnswers: (input: {
		sessionId: string;
		toolCallId: string | null | undefined;
		questions: AskUserQuestion[];
		answers?: AskUserAnswer[];
		cancelled?: boolean;
	}) => void;
	disabled?: boolean;
	className?: string;
}) {
	const elicitationQuestions = useMemo(
		() =>
			elicitationRequest
				? questionsFromElicitationFields(elicitationRequest.fields)
				: [],
		[elicitationRequest],
	);
	const askUserQuestions = useMemo(
		() =>
			askUserRequest ? questionsFromAskUserDtos(askUserRequest.questions) : [],
		[askUserRequest],
	);

	// Priority: form elicitation > Grok ext > tool promote (one form only).
	const showElicitation =
		Boolean(elicitationRequest) && elicitationQuestions.length > 0;
	const showGrokAsk =
		!showElicitation && Boolean(askUserRequest) && askUserQuestions.length > 0;
	const showToolAsk =
		!showElicitation &&
		!showGrokAsk &&
		Boolean(toolAskUserRequest) &&
		(toolAskUserRequest?.questions.length ?? 0) > 0;

	if (!showElicitation && !showGrokAsk && !showToolAsk) return null;

	if (showElicitation && elicitationRequest) {
		const msg = elicitationRequest.message?.trim() ?? "";
		const showMessage = msg.length > 0 && !/^input\s+requested\.?$/i.test(msg);
		return (
			<AskUserSurfaceCard className={className}>
				{showMessage ? (
					<p className="mb-1.5 text-sm leading-relaxed text-pretty">{msg}</p>
				) : null}
				<AskUserQuestionForm
					key={elicitationRequest.requestId}
					questions={elicitationQuestions}
					disabled={disabled}
					onSubmit={async (answers) => {
						const content = elicitationContentFromAnswers(
							elicitationQuestions,
							answers,
						);
						await respondElicitation({
							requestId: elicitationRequest.requestId,
							action: "accept",
							content,
						});
						onRecordAskUserAnswers({
							sessionId: elicitationRequest.sessionId,
							toolCallId: elicitationRequest.toolCallId,
							questions: elicitationQuestions,
							answers,
						});
						onElicitationResolved();
						return true;
					}}
					onCancel={() => {
						void respondElicitation({
							requestId: elicitationRequest.requestId,
							action: "cancel",
						}).finally(() => {
							onRecordAskUserAnswers({
								sessionId: elicitationRequest.sessionId,
								toolCallId: elicitationRequest.toolCallId,
								questions: elicitationQuestions,
								cancelled: true,
							});
							onElicitationResolved();
						});
					}}
				/>
			</AskUserSurfaceCard>
		);
	}

	if (showGrokAsk && askUserRequest) {
		return (
			<AskUserSurfaceCard className={className}>
				<AskUserQuestionForm
					key={askUserRequest.requestId}
					questions={askUserQuestions}
					disabled={disabled}
					onSubmit={async (answers) => {
						await respondAskUser({
							requestId: askUserRequest.requestId,
							action: "accept",
							answers: answers.map((answer) =>
								Array.isArray(answer) ? answer.join(", ") : answer,
							),
						});
						onRecordAskUserAnswers({
							sessionId: askUserRequest.sessionId,
							toolCallId: askUserRequest.toolCallId,
							questions: askUserQuestions,
							answers,
						});
						onAskUserResolved();
						return true;
					}}
					onCancel={() => {
						void respondAskUser({
							requestId: askUserRequest.requestId,
							action: "cancel",
						}).finally(() => {
							onRecordAskUserAnswers({
								sessionId: askUserRequest.sessionId,
								toolCallId: askUserRequest.toolCallId,
								questions: askUserQuestions,
								cancelled: true,
							});
							onAskUserResolved();
						});
					}}
				/>
			</AskUserSurfaceCard>
		);
	}

	if (showToolAsk && toolAskUserRequest) {
		return (
			<AskUserSurfaceCard className={className}>
				<AskUserQuestionForm
					key={toolAskUserRequest.toolCallId}
					questions={toolAskUserRequest.questions}
					disabled={disabled}
					onSubmit={async (answers) => {
						const text = formatAskUserAnswers(
							toolAskUserRequest.questions,
							answers,
						);
						return onAnswerToolAskUser({
							answer: text,
							toolCallId: toolAskUserRequest.toolCallId,
							questions: toolAskUserRequest.questions,
							answers,
						});
					}}
					onCancel={() => {
						onRecordAskUserAnswers({
							sessionId: toolAskUserRequest.sessionId,
							toolCallId: toolAskUserRequest.toolCallId,
							questions: toolAskUserRequest.questions,
							cancelled: true,
						});
						onToolAskUserResolved();
					}}
				/>
			</AskUserSurfaceCard>
		);
	}

	return null;
}
