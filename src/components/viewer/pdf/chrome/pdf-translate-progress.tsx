import { Check, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import {
	PDF_TRANSLATE_METER_PERCENT,
	PDF_TRANSLATE_METER_STAGE,
	PdfTranslateMeterBar,
} from "@/components/viewer/pdf/chrome/pdf-translate-meter";
import { useTranslateMeter } from "@/components/viewer/pdf/hooks/use-translate-meter";
import { cn } from "@/lib/core/utils";

type PdfTranslateProgressChipProps = {
	layoutTranslateRunning: boolean;
	layoutTranslatePreparing?: boolean;
	layoutTranslateWaiting?: boolean;
	layoutTranslateProgress?: number | null;
	/** Pages done ÷ pages in the current stage, when the stage has a count. */
	layoutTranslatePageCounts?: { done: number; total: number } | null;
	onStop: () => void;
};

/**
 * Floating full-text translation meter for the dual-pane translation panel.
 * The panel owns the job but hides the source toolbar, so this keeps the same
 * stage / percentage feedback visible while the translation runs.
 */
export function PdfTranslateProgressChip({
	layoutTranslateRunning,
	layoutTranslatePreparing = false,
	layoutTranslateWaiting = false,
	layoutTranslateProgress = null,
	layoutTranslatePageCounts = null,
	onStop,
}: PdfTranslateProgressChipProps) {
	const { t } = useTranslation("viewer");
	const {
		open,
		indeterminate,
		retracting,
		ratio,
		percent,
		pagesLabel,
		stage,
		width,
		lingerFull,
	} = useTranslateMeter({
		layoutTranslateRunning,
		layoutTranslatePreparing,
		layoutTranslateWaiting,
		layoutTranslateProgress,
		layoutTranslatePageCounts,
	});
	if (!open) return null;
	const cancellable = layoutTranslateRunning || layoutTranslateWaiting;
	const stopLabel = layoutTranslateWaiting
		? t("pdf.layoutTranslate.waiting")
		: t("pdf.layoutTranslate.stop");

	return (
		<div
			data-pdf-chrome
			className={cn(
				"pointer-events-none absolute top-2 right-3 z-20 flex h-7 select-none items-center gap-1.5 rounded-lg pl-2.5",
				cancellable || lingerFull ? "pr-0.5" : "pr-2.5",
				PDF_CHROME_CHIP,
			)}
		>
			<span
				role="progressbar"
				className="sr-only"
				aria-label={stage}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={indeterminate ? undefined : Math.round(ratio * 100)}
			/>
			<span aria-hidden className={PDF_TRANSLATE_METER_STAGE}>
				{stage}
			</span>
			{pagesLabel && !retracting ? (
				<span aria-hidden className={PDF_TRANSLATE_METER_PERCENT}>
					{pagesLabel}
				</span>
			) : null}
			{indeterminate || retracting ? null : (
				<span aria-hidden className={PDF_TRANSLATE_METER_PERCENT}>
					{percent}%
				</span>
			)}
			{cancellable ? (
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					className="pointer-events-auto text-foreground"
					aria-label={stopLabel}
					title={stopLabel}
					onClick={onStop}
				>
					<Square className="size-2.5 fill-current opacity-60" aria-hidden />
				</Button>
			) : lingerFull ? (
				<Check className="size-3.5 text-foreground/70" aria-hidden />
			) : null}
			<PdfTranslateMeterBar indeterminate={indeterminate} width={width} />
		</div>
	);
}
