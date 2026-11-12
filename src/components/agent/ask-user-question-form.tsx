import { CheckIcon, ChevronDown, ChevronUp, PlusIcon } from "lucide-react";
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
	/** Questions whose inline "Other" field is expanded (question index). */
	const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
	const [otherFilled, setOtherFilled] = useState<Record<number, boolean>>({});
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
		<div className={cn("flex flex-col gap-1.5", className)}>
			{/* Sheet grabber at rest, chevron on hover — one control, less chrome. */}
			<div className="relative flex items-center justify-center">
				<Button
					type="button"
					variant="ghost"
					className="group relative h-5 w-16 rounded-full hover:bg-transparent active:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent dark:active:bg-transparent"
					aria-expanded={!collapsed}
					aria-label={t(
						collapsed ? "askUserQuestion.expand" : "askUserQuestion.collapse",
					)}
					onClick={() => setCollapsed((value) => !value)}
				>
					<span
						aria-hidden="true"
						className="absolute h-1 w-9 rounded-full bg-foreground/15 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
					/>
					{collapsed ? (
						<ChevronUp className="absolute size-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" />
					) : (
						<ChevronDown className="absolute size-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" />
					)}
				</Button>
				{onCancel && !submitted ? (
					<Button
						type="button"
						variant="ghost"
						className="-mr-2 absolute top-1/2 right-0 -translate-y-1/2 text-muted-foreground hover:text-foreground"
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
					"gap-2.5",
					collapsed &&
						"[&_[data-slot=questionnaire-choices]]:hidden [&_[data-slot=questionnaire-actions]]:hidden [&_[data-slot=questionnaire-progress]]:hidden",
				)}
				aria-label={title ?? questions[0]?.question}
			>
				<div className="flex items-center gap-2 empty:hidden">
					<QuestionnaireProgress
						className="text-caption text-muted-foreground/80"
						aria-label={title ?? questions[0]?.question}
						render={(props, state) =>
							state.total > 1 ? (
								<div
									{...props}
									role="progressbar"
									aria-valuetext={t("askUserQuestion.progress", state)}
								>
									{t("askUserQuestion.progress", state)}
								</div>
							) : null
						}
					/>
				</div>
				{questions.map((question, index) => (
					<QuestionnaireItem
						key={items[index].name}
						name={items[index].name}
						required={items[index].required}
						multiple={question.multiSelect}
						className="gap-2.5"
						aria-disabled={busy}
					>
						<QuestionnaireTitle className="mb-0 text-base leading-snug font-semibold tracking-tight text-pretty">
							{question.question}
						</QuestionnaireTitle>
						<QuestionnaireChoices className="gap-0 overflow-hidden rounded-xl bg-foreground/[0.035] ring-1 ring-foreground/[0.06] [&>*:last-child]:border-b-0">
							{question.options.map((option) => (
								<QuestionnaireChoice
									key={option.label}
									value={option.label}
									disabled={busy}
									onChange={() => {
										if (!question.multiSelect && otherOpen[index]) {
											setOtherOpen((prev) => ({ ...prev, [index]: false }));
											setOtherFilled((prev) => ({ ...prev, [index]: false }));
										}
									}}
									className="rounded-none border-x-0 border-t-0 border-b border-b-border/50 bg-transparent px-4 py-3 transition-[background-color,transform] duration-150 hover:bg-foreground/[0.04] active:scale-[0.997] data-checked:border-b-border/50 data-checked:bg-primary/[0.08] data-checked:hover:bg-primary/[0.11] has-[>input:focus-visible]:ring-inset dark:bg-transparent dark:data-checked:bg-primary/[0.12] dark:data-checked:hover:bg-primary/[0.16]"
								>
									<span className="font-medium">{option.label}</span>
									{option.description ? (
										<QuestionnaireChoiceDescription className="text-xs text-muted-foreground">
											{option.description}
										</QuestionnaireChoiceDescription>
									) : null}
								</QuestionnaireChoice>
							))}
							{question.allowOther && question.options.length > 0 ? (
								otherOpen[index] ? (
									<div
										className={cn(
											"flex items-center gap-2.5 border-b border-b-border/50 px-4 py-3 transition-colors",
											otherFilled[index]
												? "bg-primary/[0.08] dark:bg-primary/[0.12]"
												: null,
										)}
									>
										<span
											aria-hidden="true"
											className={cn(
												"flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
												otherFilled[index]
													? "border-primary bg-primary text-primary-foreground"
													: "border-input text-muted-foreground",
											)}
										>
											{otherFilled[index] ? (
												question.multiSelect ? (
													<CheckIcon className="size-2.5" />
												) : (
													<span className="size-2 rounded-full bg-primary-foreground" />
												)
											) : (
												<PlusIcon className="size-2.5" />
											)}
										</span>
										<QuestionnaireInput
											autoFocus
											disabled={busy}
											aria-label={t("askUserQuestion.other")}
											placeholder={t("askUserQuestion.freeTextPlaceholder")}
											onChange={(event) =>
												setOtherFilled((prev) => ({
													...prev,
													[index]: event.target.value.trim().length > 0,
												}))
											}
											className="h-auto min-h-0 w-full rounded-none border-0 bg-transparent p-0 text-sm focus-visible:ring-0 dark:bg-transparent"
										/>
									</div>
								) : (
									<button
										type="button"
										disabled={busy}
										className="flex w-full items-center gap-2.5 border-b border-b-border/50 px-4 py-3 text-start text-sm text-muted-foreground transition-[background-color,transform] duration-150 hover:bg-foreground/[0.04] active:scale-[0.997] disabled:pointer-events-none disabled:opacity-50"
										onClick={() =>
											setOtherOpen((prev) => ({ ...prev, [index]: true }))
										}
									>
										<span
											aria-hidden="true"
											className="flex size-4 shrink-0 items-center justify-center rounded-full border border-input"
										>
											<PlusIcon className="size-2.5" />
										</span>
										{t("askUserQuestion.other")}
									</button>
								)
							) : null}
							{!question.options.length ? (
								<div className="border-b border-b-border/50">
									<QuestionnaireInput
										disabled={busy}
										className="h-auto min-h-11 rounded-none border-0 bg-transparent px-4 py-3 focus-visible:ring-0 dark:bg-transparent"
										aria-label={t("askUserQuestion.freeTextPlaceholder")}
										placeholder={t("askUserQuestion.freeTextPlaceholder")}
									/>
								</div>
							) : null}
						</QuestionnaireChoices>
						<QuestionnaireError>
							{t("askUserQuestion.answerRequired")}
						</QuestionnaireError>
					</QuestionnaireItem>
				))}
				<QuestionnaireActions className="gap-1.5">
					<QuestionnairePrevious
						variant="ghost"
						className="text-muted-foreground"
						disabled={busy}
					>
						{t("askUserQuestion.prev")}
					</QuestionnairePrevious>
					<QuestionnaireNext disabled={busy}>
						{t("askUserQuestion.next")}
					</QuestionnaireNext>
					<QuestionnaireSkip
						variant="ghost"
						className="text-muted-foreground"
						disabled={busy}
					>
						{t("askUserQuestion.skip")}
					</QuestionnaireSkip>
					<QuestionnaireSubmit disabled={busy}>
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
