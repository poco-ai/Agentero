import { ChevronDown, ChevronUp } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Questionnaire,
	QuestionnaireActions,
	QuestionnaireChoice,
	QuestionnaireChoiceDescription,
	QuestionnaireChoices,
	QuestionnaireError,
	QuestionnaireInput,
	QuestionnaireItem,
	QuestionnaireNext,
	QuestionnairePrevious,
	QuestionnaireProgress,
	QuestionnaireSkip,
	QuestionnaireSubmit,
	QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import type { AskUserAnswer, AskUserQuestion } from "@/lib/agent/chat-state";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";

/** ACP response adapters consume labels in question order; UI state belongs to Questionnaire. */
export function AskUserQuestionForm({
	questions,
	disabled = false,
	title,
	className,
	onSubmit,
	onCancel,
}: {
	questions: AskUserQuestion[];
	disabled?: boolean;
	title?: string;
	className?: string;
	onSubmit: (answers: AskUserAnswer[]) => Promise<boolean>;
	onCancel?: () => void;
}) {
	const { t } = useTranslation("agent");
	const [collapsed, setCollapsed] = useState(false);
	const [sending, setSending] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	const submitting = useRef(false);
	const busy = disabled || sending || submitted;
	if (!questions.length) return null;
	const items = questions.map((question, index) => ({
		name: `question-${index}`,
		required: question.required !== false,
		choices: question.options.map((option) => ({
			value: option.label,
			disabled: busy,
		})),
	}));

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (busy || submitting.current) return;
		const data = new FormData(event.currentTarget);
		// Capture before disabling controls: disabled inputs do not belong to FormData.
		const answers = items.map((item, index) => {
			const values = data
				.getAll(item.name)
				.map(String)
				.map((value) => value.trim())
				.filter(Boolean);
			return questions[index].multiSelect ? values : (values[0] ?? "");
		});
		submitting.current = true;
		setSending(true);
		try {
			setSubmitted(await onSubmit(answers));
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			submitting.current = false;
			setSending(false);
		}
	};

	return (
		<div className={cn("space-y-2", className)}>
			<div className="flex justify-center">
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					className="h-5 w-14 rounded-full text-muted-foreground"
					aria-expanded={!collapsed}
					aria-label={t(
						collapsed ? "askUserQuestion.expand" : "askUserQuestion.collapse",
					)}
					onClick={() => setCollapsed((value) => !value)}
				>
					{collapsed ? (
						<ChevronUp className="size-3.5" />
					) : (
						<ChevronDown className="size-3.5" />
					)}
				</Button>
			</div>
			<div className="flex items-start justify-between gap-2">
				{title ? (
					<p className="text-xs font-medium text-muted-foreground">{title}</p>
				) : null}
				{onCancel && !submitted ? (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="ml-auto h-7 px-2 text-muted-foreground"
						disabled={busy}
						onClick={onCancel}
					>
						{t("askUserQuestion.cancel")}
					</Button>
				) : null}
			</div>
			<Questionnaire
				items={items}
				onSubmit={(event) => void submit(event)}
				className={cn(
					"gap-2",
					collapsed &&
						"[&_[data-slot=questionnaire-choices]]:hidden [&_[data-slot=questionnaire-actions]]:hidden [&_[data-slot=questionnaire-progress]]:hidden",
				)}
				inert={collapsed}
				aria-label={title ?? questions[0]?.question}
			>
				<QuestionnaireProgress
					className="text-xs"
					aria-label={title ?? questions[0]?.question}
					render={(props, state) => (
						<div
							{...props}
							role="progressbar"
							aria-valuetext={t("askUserQuestion.progress", state)}
						>
							{t("askUserQuestion.progress", state)}
						</div>
					)}
				/>
				{questions.map((question, index) => (
					<QuestionnaireItem
						key={items[index].name}
						name={items[index].name}
						required={items[index].required}
						multiple={question.multiSelect}
						className="space-y-2"
						aria-disabled={busy}
					>
						<QuestionnaireTitle className="text-sm leading-5">
							{question.question}
						</QuestionnaireTitle>
						<QuestionnaireChoices className="gap-1.5">
							{question.options.map((option) => (
								<QuestionnaireChoice
									key={option.label}
									value={option.label}
									disabled={busy}
									className="data-checked:bg-primary/10"
								>
									<span className="font-medium">{option.label}</span>
									{option.description ? (
										<QuestionnaireChoiceDescription className="text-xs text-muted-foreground">
											{option.description}
										</QuestionnaireChoiceDescription>
									) : null}
								</QuestionnaireChoice>
							))}
							{question.allowOther || !question.options.length ? (
								<QuestionnaireInput
									disabled={busy}
									aria-label={t("askUserQuestion.freeTextPlaceholder")}
									placeholder={t("askUserQuestion.freeTextPlaceholder")}
								/>
							) : null}
						</QuestionnaireChoices>
						<QuestionnaireError>
							{t("askUserQuestion.answerRequired")}
						</QuestionnaireError>
					</QuestionnaireItem>
				))}
				<QuestionnaireActions className="gap-2">
					<QuestionnairePrevious size="sm" disabled={busy}>
						{t("askUserQuestion.prev")}
					</QuestionnairePrevious>
					<QuestionnaireNext size="sm" disabled={busy}>
						{t("askUserQuestion.next")}
					</QuestionnaireNext>
					<QuestionnaireSkip size="sm" disabled={busy}>
						{t("askUserQuestion.skip")}
					</QuestionnaireSkip>
					<QuestionnaireSubmit size="sm" disabled={busy}>
						{t(
							submitted
								? "askUserQuestion.submitted"
								: "askUserQuestion.submit",
						)}
					</QuestionnaireSubmit>
				</QuestionnaireActions>
			</Questionnaire>
		</div>
	);
}
