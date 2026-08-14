import {
	Check,
	Clock,
	ExternalLink,
	ListChecks,
	Loader2,
	MessagesSquare,
	RotateCcw,
	Save,
	Sparkles,
	X,
} from "lucide-react";
import { motion } from "motion/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { isMacOS, isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import type {
	DefenseDebrief,
	DefenseSessionReview,
	VoiceCaption,
} from "@/lib/voice-defense";

function formatDuration(totalSeconds: number) {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const rise = (delay: number) => ({
	initial: { opacity: 0, y: 14 },
	animate: { opacity: 1, y: 0 },
	transition: { duration: 0.35, ease: "easeOut" as const, delay },
});

/** Footer pills opt out of the shared Button press-scale; WKWebView otherwise
 *  double-paints rounded-full neighbors when the evaluating label grows. */
const footerPress =
	"overflow-hidden active:not-aria-[haspopup]:translate-y-0 active:not-aria-[haspopup]:scale-100";
const footerPrimary = cn(
	"relative isolate z-10 h-10 rounded-full px-6 text-[15px]",
	footerPress,
);
const footerGhost = cn(
	"relative isolate h-10 rounded-full text-muted-foreground",
	footerPress,
);

/**
 * The debrief: session stats, a peek at the transcript, and explicit exits.
 * Nothing is written to the Vault automatically — saving the transcript is a
 * deliberate action here, and closing without it discards the session.
 */
export function EndedAct({
	windowMode,
	title,
	durationSeconds,
	questionCount,
	captions,
	debrief,
	review,
	reviewPath,
	reviewing,
	savedPath,
	saving,
	canRestart,
	onSaveTranscript,
	onOpenTranscript,
	onEvaluate,
	onOpenReview,
	onRestart,
	onClose,
}: {
	/** Native Viva windows use the system title-bar close control. */
	windowMode: boolean;
	title: string;
	durationSeconds: number | null;
	questionCount: number;
	captions: VoiceCaption[];
	/** Prepared-outline coverage; null when the session had no prepared run. */
	debrief: DefenseDebrief | null;
	review: DefenseSessionReview | null;
	reviewPath: string | null;
	reviewing: boolean;
	savedPath: string | null;
	saving: boolean;
	canRestart: boolean;
	onSaveTranscript: (() => void) | null;
	onOpenTranscript: (() => void) | null;
	onEvaluate: (() => void) | null;
	onOpenReview: (() => void) | null;
	onRestart: () => void;
	onClose: () => void;
}) {
	const { t } = useTranslation("agent");
	const macDesktop = useMemo(() => isTauri() && isMacOS(), []);
	const showCustomClose = !windowMode;
	const preview = captions.slice(0, 4);
	const missedQuestions =
		debrief?.questions.filter((entry) => !entry.asked) ?? [];
	const hasTranscriptAction = Boolean(
		(savedPath && onOpenTranscript) || onSaveTranscript,
	);
	const roleLabel = (role: VoiceCaption["role"]) =>
		t(
			role === "assistant"
				? "voiceDefense.role.assistant"
				: "voiceDefense.role.user",
		);
	return (
		<div className="relative flex h-full flex-col overflow-hidden bg-background text-foreground">
			<div
				className={cn(
					"flex h-11 shrink-0 items-center justify-end pr-3",
					macDesktop ? "pl-[92px]" : "pl-4",
				)}
			>
				<div className="h-full min-w-0 flex-1" data-tauri-drag-region />
				{showCustomClose ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="relative z-10 shrink-0 rounded-full"
								aria-label={t("voiceDefense.close")}
								onClick={onClose}
							>
								<X aria-hidden />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("voiceDefense.close")}</TooltipContent>
					</Tooltip>
				) : null}
			</div>
			<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-2xl flex-col px-6 pt-8 pb-10">
					<motion.div {...rise(0)}>
						<h1 className="font-semibold text-3xl tracking-tight">
							{t("voiceDefense.ended.title")}
						</h1>
						<p className="mt-2 truncate text-[15px] text-muted-foreground">
							{title}
						</p>
					</motion.div>

					<motion.div
						{...rise(0.08)}
						className="mt-10 flex items-stretch gap-8"
					>
						<div className="space-y-1.5">
							<p className="flex items-center gap-1.5 text-muted-foreground text-sm">
								<Clock className="size-3.5" aria-hidden />
								{t("voiceDefense.ended.durationLabel")}
							</p>
							<p className="font-light text-5xl tabular-nums tracking-tight">
								{durationSeconds !== null
									? formatDuration(durationSeconds)
									: "—"}
							</p>
						</div>
						<div className="w-px bg-border" aria-hidden />
						<div className="space-y-1.5">
							<p className="flex items-center gap-1.5 text-muted-foreground text-sm">
								<MessagesSquare className="size-3.5" aria-hidden />
								{t("voiceDefense.ended.questionsLabel")}
							</p>
							<p className="font-light text-5xl tabular-nums tracking-tight">
								{questionCount}
							</p>
						</div>
						{debrief && debrief.totalCount > 0 ? (
							<>
								<div className="w-px bg-border" aria-hidden />
								<div className="space-y-1.5">
									<p className="flex items-center gap-1.5 text-muted-foreground text-sm">
										<ListChecks className="size-3.5" aria-hidden />
										{t("voiceDefense.ended.coverageLabel")}
									</p>
									<p className="font-light text-5xl tabular-nums tracking-tight">
										{debrief.askedCount}
										<span className="text-2xl text-muted-foreground/70">
											{" "}
											/ {debrief.totalCount}
										</span>
									</p>
								</div>
							</>
						) : null}
					</motion.div>

					{debrief && debrief.totalCount > 0 ? (
						<motion.div {...rise(0.12)} className="mt-12">
							<p className="font-medium text-sm">
								{missedQuestions.length > 0
									? t("voiceDefense.ended.missedTitle", {
											count: missedQuestions.length,
										})
									: t("voiceDefense.ended.allCoveredTitle")}
							</p>
							{missedQuestions.length > 0 ? (
								<div className="mt-5 space-y-5 border-amber-500/40 border-l pl-5">
									{missedQuestions.map((entry) => (
										<div key={entry.question.question} className="space-y-1">
											<p className="text-[15px] leading-6">
												{entry.question.question}
											</p>
											<p className="line-clamp-2 text-muted-foreground text-sm leading-6">
												{entry.question.answerOutline}
											</p>
										</div>
									))}
								</div>
							) : (
								<p className="mt-3 flex items-center gap-1.5 text-muted-foreground text-sm">
									<Check
										className="size-4 text-emerald-600 dark:text-emerald-400"
										aria-hidden
									/>
									{t("voiceDefense.ended.allCoveredHint")}
								</p>
							)}
							{onSaveTranscript || savedPath ? (
								<p className="mt-4 text-muted-foreground/70 text-xs leading-relaxed">
									{t("voiceDefense.ended.debriefSaveHint")}
								</p>
							) : null}
						</motion.div>
					) : null}

					{review ? (
						<motion.div {...rise(0.14)} className="mt-12">
							<p className="font-medium text-sm">
								{t("voiceDefense.ended.overallLabel")}
								<span className="ml-2 text-muted-foreground">
									{t(`voiceDefense.ended.overall.${review.overall}`)}
								</span>
							</p>
							<p className="mt-3 text-[15px] leading-6">{review.summary}</p>
							{review.weakAreas.length > 0 ? (
								<div className="mt-5 space-y-2">
									<p className="text-muted-foreground text-sm">
										{t("voiceDefense.ended.weakAreasTitle")}
									</p>
									<ul className="space-y-1.5 border-border border-l pl-5">
										{review.weakAreas.map((area) => (
											<li key={area} className="text-[15px] leading-6">
												{area}
											</li>
										))}
									</ul>
								</div>
							) : null}
						</motion.div>
					) : null}

					{preview.length > 0 ? (
						<motion.div {...rise(0.16)} className="mt-12">
							<p className="font-medium text-sm">
								{t("voiceDefense.ended.previewTitle")}
							</p>
							<div className="mt-5 space-y-5 border-border border-l pl-5">
								{preview.map((caption) => (
									<div key={caption.id} className="space-y-1">
										<p
											className={cn(
												"font-medium text-[12px]",
												caption.role === "assistant"
													? "text-sky-600 dark:text-sky-400"
													: "text-emerald-600 dark:text-emerald-400",
											)}
										>
											{roleLabel(caption.role)}
										</p>
										<p className="whitespace-pre-wrap text-[15px] leading-6">
											{caption.text}
										</p>
									</div>
								))}
								{captions.length > preview.length ? (
									<p className="text-muted-foreground text-sm">
										{t("voiceDefense.ended.previewMore", {
											count: captions.length - preview.length,
										})}
									</p>
								) : null}
							</div>
						</motion.div>
					) : null}
				</div>
			</div>

			{/* In-flow footer: the actions never cover the content. */}
			<footer className="shrink-0 border-border/50 border-t px-6 py-3.5">
				<div className="mx-auto flex w-full max-w-2xl flex-wrap items-center justify-center gap-x-4 gap-y-2">
					{savedPath && onOpenTranscript ? (
						<Button
							type="button"
							onClick={onOpenTranscript}
							className={footerPrimary}
						>
							<ExternalLink aria-hidden />
							{t("voiceDefense.openTranscript")}
						</Button>
					) : onSaveTranscript ? (
						<Button
							type="button"
							disabled={saving}
							onClick={onSaveTranscript}
							className={footerPrimary}
						>
							{saving ? (
								<Loader2 className="animate-spin" aria-hidden />
							) : (
								<Save aria-hidden />
							)}
							{t("voiceDefense.ended.save")}
						</Button>
					) : showCustomClose ? (
						<Button type="button" onClick={onClose} className={footerPrimary}>
							{t("voiceDefense.close")}
						</Button>
					) : null}
					{reviewPath && onOpenReview ? (
						<Button
							type="button"
							variant="ghost"
							onClick={onOpenReview}
							className={footerGhost}
						>
							<ExternalLink aria-hidden />
							{t("voiceDefense.ended.openReview")}
						</Button>
					) : reviewing ? (
						<span
							className="inline-flex h-10 shrink-0 items-center gap-1.5 px-3 text-[15px] text-muted-foreground"
							aria-live="polite"
						>
							<Loader2 className="size-4 animate-spin" aria-hidden />
							{t("voiceDefense.ended.evaluating")}
						</span>
					) : onEvaluate ? (
						<Button
							type="button"
							variant="ghost"
							disabled={saving}
							onClick={onEvaluate}
							className={footerGhost}
						>
							<Sparkles aria-hidden />
							{t("voiceDefense.ended.evaluate")}
						</Button>
					) : null}
					{canRestart ? (
						<Button
							type="button"
							variant="ghost"
							disabled={saving}
							onClick={onRestart}
							className={footerGhost}
						>
							<RotateCcw aria-hidden />
							{t("voiceDefense.ended.again")}
						</Button>
					) : null}
					{showCustomClose && hasTranscriptAction ? (
						<Button
							type="button"
							variant="ghost"
							onClick={onClose}
							className={footerGhost}
						>
							<X aria-hidden />
							{t("voiceDefense.close")}
						</Button>
					) : null}
				</div>
			</footer>
		</div>
	);
}
