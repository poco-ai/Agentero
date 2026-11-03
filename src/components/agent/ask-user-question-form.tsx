/**
 * Shared AskUserQuestion UI (AI Elements Suggestion chips).
 * Used by AgentAskUserSurface (bottom dock; replaces free-text composer while open):
 * - ACP tool promote (Codex / Claude / OpenCode / Grok-shaped rawInput)
 * - ACP form elicitation (Codex request_user_input)
 * - Grok ext `_x.ai/ask_user_question`
 *
 * Multi-question UX is paginated: one question per page, prev/next, Submit on last.
 * Options + optional free-text "Other" stay on the same page.
 * Multi-select (Claude/OpenCode/Grok) toggles chips; answers join with ", ".
 *
 * Keyboard (when focus is on the form, not the free-text input):
 * - ↑ / ↓  move option focus
 * - Space  select / toggle focused option
 * - Enter  confirm focused option and go next (or submit on last)
 * - ← / →  previous / next question
 */
import {
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Suggestion } from "@/components/agent/elements/suggestion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AskUserQuestion } from "@/lib/agent/chat-state";
import { cn } from "@/lib/core/utils";

/** Multi-select answers are joined for the follow-up turn / elicitation text. */
const MULTI_JOIN = ", ";

function selectedLabels(
	question: AskUserQuestion,
	answer: string | undefined,
): string[] {
	const value = answer?.trim() ?? "";
	if (!value) return [];
	if (!question.multiSelect) return [value];
	// Prefer exact option-label matching so labels with commas still work.
	const labels = question.options.map((option) => option.label);
	const picked: string[] = [];
	let rest = value;
	for (const label of labels) {
		const parts = rest.split(MULTI_JOIN);
		if (parts.includes(label)) {
			picked.push(label);
			rest = parts.filter((part) => part !== label).join(MULTI_JOIN);
		}
	}
	// Remaining free-text Other (if any).
	if (rest.trim()) picked.push(rest.trim());
	return picked;
}

function isAnswerComplete(
	question: AskUserQuestion,
	answer: string | undefined,
): boolean {
	const value = answer?.trim() ?? "";
	if (question.options.length > 0) {
		// Option selected, or free-text Other when allowed.
		if (value) return true;
		return question.required === false;
	}
	// Free-text only page.
	if (question.required === false) return true;
	return Boolean(value);
}

function isTextFieldTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/** Apply option pick into answers (pure) for Enter confirm path. */
function withOptionSelected(
	questions: AskUserQuestion[],
	answers: string[],
	questionIndex: number,
	label: string,
): string[] {
	const q = questions[questionIndex];
	const next = [...answers];
	if (!q) return next;
	if (q.multiSelect) {
		const existing = selectedLabels(q, answers[questionIndex]).filter((item) =>
			q.options.some((option) => option.label === item),
		);
		const toggled = existing.includes(label) ? existing : [...existing, label];
		next[questionIndex] = toggled.join(MULTI_JOIN);
	} else {
		next[questionIndex] = label;
	}
	return next;
}

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
	/** Optional heading above the questions (composer card). */
	title?: string;
	className?: string;
	/** Selected labels (or free-text) in question order. Returns true when accepted. */
	onSubmit: (answers: string[]) => Promise<boolean>;
	onCancel?: () => void;
}) {
	const { t } = useTranslation("agent");
	/** Effective answer per question: option label or free-text Other. */
	const [answers, setAnswers] = useState<string[]>([]);
	/** Free-text draft when question has options + allowOther (may mirror answers). */
	const [otherDrafts, setOtherDrafts] = useState<string[]>([]);
	const [page, setPage] = useState(0);
	const [sending, setSending] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	/** Keyboard focus among options on the current page. */
	const [focusOption, setFocusOption] = useState(0);
	/** Collapsed: only the question stem row (and cancel). */
	const [collapsed, setCollapsed] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	const total = questions.length;
	const index = total > 0 ? Math.min(page, total - 1) : 0;
	const question = questions[index];
	const optionCount = question?.options.length ?? 0;
	const busy = disabled || sending || submitted;

	// Re-seed keyboard option focus when flipping pages (not when answers change).
	// biome-ignore lint/correctness/useExhaustiveDependencies: optionCount re-seeds when option list length changes
	useEffect(() => {
		setFocusOption(0);
	}, [index, optionCount]);

	// Autofocus the form so arrow keys work without an extra click.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-focus when page index changes
	useEffect(() => {
		if (busy || total === 0 || collapsed) return;
		const node = rootRef.current;
		if (!node) return;
		if (isTextFieldTarget(document.activeElement)) return;
		node.focus({ preventScroll: true });
	}, [busy, collapsed, index, total]);

	if (!questions.length || !question) return null;

	const isFirst = index === 0;
	const isLast = index === total - 1;
	const multi = total > 1;
	const currentAnswer = answers[index] ?? "";
	const otherDraft = otherDrafts[index] ?? "";
	const picked = selectedLabels(question, currentAnswer);
	const showOtherInput =
		Boolean(question.allowOther) || question.options.length === 0;
	const currentReady = isAnswerComplete(question, currentAnswer);
	const allReady = questions.every((q, i) => isAnswerComplete(q, answers[i]));
	// -1 = free-text mode (no option keyboard-focused).
	const safeFocus =
		focusOption < 0 || optionCount === 0
			? -1
			: Math.min(focusOption, optionCount - 1);

	const setOption = (questionIndex: number, label: string) => {
		const q = questions[questionIndex];
		setOtherDrafts((current) => {
			const next = [...current];
			next[questionIndex] = "";
			return next;
		});
		setAnswers((current) => {
			const next = [...current];
			if (q?.multiSelect) {
				const existing = selectedLabels(q, current[questionIndex]).filter(
					(item) => q.options.some((option) => option.label === item),
				);
				const toggled = existing.includes(label)
					? existing.filter((item) => item !== label)
					: [...existing, label];
				next[questionIndex] = toggled.join(MULTI_JOIN);
			} else {
				next[questionIndex] = label;
			}
			return next;
		});
	};

	/**
	 * User moved into free-text "Other": drop option selection + keyboard focus
	 * so Enter does not confirm the previously highlighted option.
	 */
	const clearOptionSelectionForFreeText = (questionIndex: number) => {
		setFocusOption(-1);
		setAnswers((current) => {
			const next = [...current];
			const other = otherDrafts[questionIndex]?.trim() ?? "";
			// Keep free-text draft as the page answer; drop option labels.
			next[questionIndex] = other;
			return next;
		});
	};

	const setOtherText = (questionIndex: number, text: string) => {
		setOtherDrafts((current) => {
			const next = [...current];
			next[questionIndex] = text;
			return next;
		});
		setAnswers((current) => {
			const next = [...current];
			// Free-text wins over option when non-empty; clearing free-text keeps prior option if any.
			if (text.trim()) {
				next[questionIndex] = text;
			} else {
				const q = questions[questionIndex];
				const prev = current[questionIndex];
				const stillOption = q?.options.some((o) => o.label === prev);
				next[questionIndex] = stillOption ? (prev ?? "") : "";
			}
			return next;
		});
	};

	const goPrev = () => {
		if (!isFirst && !busy) setPage((p) => Math.max(0, p - 1));
	};

	const goNext = () => {
		if (!isLast && currentReady && !busy) {
			setPage((p) => Math.min(total - 1, p + 1));
		}
	};

	const doSubmit = (finalAnswers?: string[]) => {
		const payload = finalAnswers ?? answers;
		if (!questions.every((q, i) => isAnswerComplete(q, payload[i])) || busy)
			return;
		setSending(true);
		void onSubmit(payload).then((sent) => {
			setSending(false);
			setSubmitted(sent);
		});
	};

	/** Enter: select focused option (ensure on), then next page or submit. */
	const confirmFocusedAndAdvance = () => {
		if (busy) return;
		// Free-text mode: never force an option on Enter.
		if (safeFocus < 0 || optionCount === 0) {
			if (isLast) doSubmit();
			else goNext();
			return;
		}
		const label = question.options[safeFocus]?.label;
		let nextAnswers = answers;
		if (label) {
			nextAnswers = withOptionSelected(questions, answers, index, label);
			setOtherDrafts((current) => {
				const next = [...current];
				next[index] = "";
				return next;
			});
			setAnswers(nextAnswers);
		}

		if (isLast) {
			doSubmit(nextAnswers);
			return;
		}
		if (isAnswerComplete(question, nextAnswers[index])) {
			setPage((p) => Math.min(total - 1, p + 1));
		}
	};

	const onFormKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (busy) return;
		if (event.nativeEvent.isComposing) return;
		// Free-text field keeps its own keys.
		if (isTextFieldTarget(event.target)) return;

		const key = event.key;
		if (key === "ArrowDown" || key === "ArrowUp") {
			if (optionCount === 0) return;
			event.preventDefault();
			event.stopPropagation();
			setFocusOption((prev) => {
				// Leaving free-text mode: land on first / last option.
				if (prev < 0) {
					return key === "ArrowDown" ? 0 : optionCount - 1;
				}
				const cur = Math.min(prev, optionCount - 1);
				if (key === "ArrowDown") return (cur + 1) % optionCount;
				return (cur - 1 + optionCount) % optionCount;
			});
			return;
		}

		if (key === " " || key === "Spacebar") {
			if (optionCount === 0 || safeFocus < 0) return;
			event.preventDefault();
			event.stopPropagation();
			const label = question.options[safeFocus]?.label;
			if (label) setOption(index, label);
			return;
		}

		if (key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			if (optionCount > 0 && safeFocus >= 0) {
				confirmFocusedAndAdvance();
			} else if (isLast) {
				doSubmit();
			} else {
				goNext();
			}
			return;
		}

		if (key === "ArrowLeft") {
			if (!multi || isFirst) return;
			event.preventDefault();
			event.stopPropagation();
			goPrev();
			return;
		}

		if (key === "ArrowRight") {
			if (!multi || isLast) return;
			event.preventDefault();
			event.stopPropagation();
			goNext();
		}
	};

	const navButtons = multi ? (
		<>
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={isFirst || busy}
				aria-label={t("askUserQuestion.prev")}
				onClick={goPrev}
			>
				<ChevronLeft className="size-3.5" />
				{t("askUserQuestion.prev")}
			</Button>
			{isLast ? (
				<Button
					type="button"
					size="sm"
					disabled={!allReady || busy}
					onClick={() => doSubmit()}
				>
					{submitted
						? t("askUserQuestion.submitted")
						: t("askUserQuestion.submit")}
				</Button>
			) : (
				<Button
					type="button"
					size="sm"
					disabled={!currentReady || busy}
					aria-label={t("askUserQuestion.next")}
					onClick={goNext}
				>
					{t("askUserQuestion.next")}
					<ChevronRight className="size-3.5" />
				</Button>
			)}
		</>
	) : (
		<Button
			type="button"
			size="sm"
			disabled={!allReady || busy}
			onClick={() => doSubmit()}
		>
			{submitted ? t("askUserQuestion.submitted") : t("askUserQuestion.submit")}
		</Button>
	);

	return (
		// Keyboard host for the questionnaire (not a semantic fieldset — nested controls).
		// biome-ignore lint/a11y/useSemanticElements: roving-focus host, not a form fieldset
		<div
			ref={rootRef}
			className={cn("space-y-2 outline-none", className)}
			tabIndex={busy || collapsed ? -1 : 0}
			role="group"
			aria-label={question.question}
			onKeyDown={collapsed ? undefined : onFormKeyDown}
		>
			{/* Top-center collapse control (no top border on the card shell). */}
			<div className="flex justify-center">
				<button
					type="button"
					className={cn(
						"group flex h-5 w-14 items-center justify-center rounded-full",
						"text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-muted-foreground",
						"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					)}
					aria-expanded={!collapsed}
					aria-label={
						collapsed
							? t("askUserQuestion.expand")
							: t("askUserQuestion.collapse")
					}
					title={
						collapsed
							? t("askUserQuestion.expand")
							: t("askUserQuestion.collapse")
					}
					onClick={() => setCollapsed((c) => !c)}
				>
					{collapsed ? (
						<ChevronUp className="size-3.5" aria-hidden />
					) : (
						<ChevronDown className="size-3.5" aria-hidden />
					)}
				</button>
			</div>

			{/* Header: optional title + progress/stem; Cancel top-right */}
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1 space-y-1">
					{title && !collapsed ? (
						<p className="text-muted-foreground text-xs font-medium tracking-wide">
							{title}
						</p>
					) : null}
					<div className="flex items-baseline gap-2">
						{multi ? (
							<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
								{t("askUserQuestion.progress", {
									current: index + 1,
									total,
								})}
							</span>
						) : null}
						<p className="min-w-0 flex-1 text-sm leading-5">
							{question.question}
						</p>
					</div>
				</div>
				{onCancel && !submitted ? (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 shrink-0 px-2 text-muted-foreground"
						disabled={busy}
						onClick={onCancel}
					>
						{t("askUserQuestion.cancel")}
					</Button>
				) : null}
			</div>

			{collapsed ? null : (
				<div
					key={question.id ?? `${index}-${question.question}`}
					className="space-y-2"
				>
					{question.options.length > 0 ? (
						<div
							className="flex flex-col gap-1.5"
							role="listbox"
							aria-label={question.question}
							aria-multiselectable={question.multiSelect ? true : undefined}
						>
							{question.options.map((option, optionIndex) => {
								const selected =
									picked.includes(option.label) && !otherDraft.trim();
								const focused = safeFocus >= 0 && optionIndex === safeFocus;
								return (
									<Suggestion
										key={option.label}
										suggestion={option.label}
										role="option"
										aria-selected={selected}
										aria-pressed={selected}
										disabled={busy}
										variant="outline"
										tabIndex={-1}
										className={cn(
											"h-auto w-full justify-start gap-2.5 whitespace-normal rounded-lg border px-3 py-2.5 text-left shadow-none transition-colors",
											selected
												? "border-primary bg-primary/15 text-foreground ring-2 ring-primary/45 hover:bg-primary/20 hover:text-foreground"
												: "border-border/80 bg-background/60 hover:bg-muted/50",
											// Keyboard focus ring (distinct from selected state).
											focused && !selected
												? "ring-2 ring-ring/60 border-ring/50"
												: null,
											focused && selected
												? "ring-offset-1 ring-offset-background"
												: null,
										)}
										onClick={(answer) => {
											setFocusOption(optionIndex);
											setOption(index, answer);
											// Single-select + multi-page: advance after pick when no Other.
											// Multi-select stays so the user can pick more chips.
											if (
												!question.multiSelect &&
												multi &&
												!isLast &&
												!busy &&
												!question.allowOther
											) {
												setPage((p) => Math.min(total - 1, p + 1));
											}
											rootRef.current?.focus({ preventScroll: true });
										}}
									>
										<span
											className={cn(
												"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
												selected
													? "border-primary bg-primary text-primary-foreground"
													: "border-muted-foreground/35 bg-transparent",
											)}
											aria-hidden
										>
											{selected ? (
												<Check className="size-2.5 stroke-[3]" />
											) : null}
										</span>
										<span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
											<span
												className={cn(
													"text-sm",
													selected ? "font-semibold" : "font-medium",
												)}
											>
												{option.label}
											</span>
											{option.description ? (
												<span
													className={cn(
														"text-xs leading-snug",
														selected
															? "text-foreground/75"
															: "text-muted-foreground",
													)}
												>
													{option.description}
												</span>
											) : null}
										</span>
									</Suggestion>
								);
							})}
						</div>
					) : null}
					{showOtherInput ? (
						<div
							className={cn(
								"rounded-lg transition-[box-shadow,border-color,background-color]",
								question.options.length > 0 && otherDraft.trim()
									? "ring-2 ring-primary/45"
									: null,
							)}
						>
							<Input
								value={
									question.options.length > 0
										? otherDraft
										: (currentAnswer ?? "")
								}
								disabled={busy}
								placeholder={t("askUserQuestion.freeTextPlaceholder")}
								className={cn(
									question.options.length > 0 && otherDraft.trim()
										? "border-primary bg-primary/10"
										: null,
								)}
								onFocus={() => {
									// Typing a custom answer: drop option highlight / selection.
									if (question.options.length > 0) {
										clearOptionSelectionForFreeText(index);
									}
								}}
								onChange={(event) => {
									const text = event.target.value;
									if (question.options.length > 0) {
										// Ensure free-text mode even if focus events were skipped.
										if (focusOption >= 0) setFocusOption(-1);
										setOtherText(index, text);
									} else {
										setAnswers((current) => {
											const next = [...current];
											next[index] = text;
											return next;
										});
									}
								}}
								onKeyDown={(event) => {
									if (event.key !== "Enter" || event.nativeEvent.isComposing)
										return;
									event.preventDefault();
									event.stopPropagation();
									// Only free-text / current answers — never confirm option focus.
									if (isLast) doSubmit();
									else goNext();
								}}
							/>
						</div>
					) : null}
				</div>
			)}

			{collapsed ? null : (
				/* Footer: keyboard hints left · nav / submit right */
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<p className="min-w-0 flex-1 text-muted-foreground text-caption leading-snug">
						{t(
							multi
								? "askUserQuestion.keyboardHintMulti"
								: "askUserQuestion.keyboardHint",
						)}
					</p>
					<div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
						{navButtons}
					</div>
				</div>
			)}
		</div>
	);
}
