/**
 * Structured ask-user UI (elicitation / Grok ext / tool-promote).
 * While active, replaces the bottom composer (mutually exclusive with free-text input).
 */
import { useMemo } from "react";
import { AskUserQuestionForm } from "@/components/agent/ask-user-question-form";
import type { AskUserRequest, ElicitationRequest } from "@/lib/agent";
import { respondAskUser, respondElicitation } from "@/lib/agent/api";
import {
	elicitationContentFromAnswers,
	formatAskUserAnswers,
	questionsFromAskUserDtos,
	questionsFromElicitationFields,
	type ToolAskUserRequest,
} from "@/lib/agent/chat-state";
import { cn } from "@/lib/core/utils";

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
	disabled = false,
	className,
}: {
	elicitationRequest: ElicitationRequest | null;
	onElicitationResolved: () => void;
	askUserRequest: AskUserRequest | null;
	onAskUserResolved: () => void;
	toolAskUserRequest: ToolAskUserRequest | null;
	onToolAskUserResolved: () => void;
	onAnswerToolAskUser: (answer: string, toolCallId: string) => Promise<boolean>;
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

	// Docked at panel bottom while composer is hidden — a bit more bottom inset.
	const shellClass = cn("shrink-0 bg-muted/10 px-3 pb-3 pt-0", className);
	const cardClass =
		"rounded-xl border border-border bg-muted/20 px-3 pb-3 pt-1";

	if (showElicitation && elicitationRequest) {
		const msg = elicitationRequest.message?.trim() ?? "";
		const showMessage = msg.length > 0 && !/^input\s+requested\.?$/i.test(msg);
		return (
			<div className={shellClass}>
				<div className={cardClass}>
					{showMessage ? <p className="mb-2 text-sm leading-5">{msg}</p> : null}
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
							onElicitationResolved();
							return true;
						}}
						onCancel={() => {
							void respondElicitation({
								requestId: elicitationRequest.requestId,
								action: "cancel",
							}).finally(() => onElicitationResolved());
						}}
					/>
				</div>
			</div>
		);
	}

	if (showGrokAsk && askUserRequest) {
		return (
			<div className={shellClass}>
				<div className={cardClass}>
					<AskUserQuestionForm
						key={askUserRequest.requestId}
						questions={askUserQuestions}
						disabled={disabled}
						onSubmit={async (answers) => {
							await respondAskUser({
								requestId: askUserRequest.requestId,
								action: "accept",
								answers,
							});
							onAskUserResolved();
							return true;
						}}
						onCancel={() => {
							void respondAskUser({
								requestId: askUserRequest.requestId,
								action: "cancel",
							}).finally(() => onAskUserResolved());
						}}
					/>
				</div>
			</div>
		);
	}

	if (showToolAsk && toolAskUserRequest) {
		return (
			<div className={shellClass}>
				<div className={cardClass}>
					<AskUserQuestionForm
						key={toolAskUserRequest.toolCallId}
						questions={toolAskUserRequest.questions}
						disabled={disabled}
						onSubmit={async (answers) => {
							const text = formatAskUserAnswers(
								toolAskUserRequest.questions,
								answers,
							);
							return onAnswerToolAskUser(text, toolAskUserRequest.toolCallId);
						}}
						onCancel={() => {
							onToolAskUserResolved();
						}}
					/>
				</div>
			</div>
		);
	}

	return null;
}
