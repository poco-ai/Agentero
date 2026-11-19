import { useTranslation } from "react-i18next";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { PdfTranslateMeterReadout } from "@/components/viewer/pdf/chrome/pdf-translate-meter";
import { PdfTranslatePartialButton } from "@/components/viewer/pdf/chrome/pdf-translate-partial-button";
import type { PdfLayoutTranslatePartial } from "@/components/viewer/pdf/hooks/use-pdf-layout-translate";
import { useTranslateMeter } from "@/components/viewer/pdf/hooks/use-translate-meter";
import { cn } from "@/lib/core/utils";

type PdfTranslateProgressChipProps = {
	layoutTranslateRunning: boolean;
	layoutTranslatePreparing?: boolean;
	layoutTranslateWaiting?: boolean;
	layoutTranslateQueued?: boolean;
	layoutTranslateProgress?: number | null;
	/** Pages done ÷ pages in the current stage, when the stage has a count. */
	layoutTranslatePageCounts?: { done: number; total: number } | null;
	layoutTranslatePartial?: PdfLayoutTranslatePartial | null;
	onStop: () => void;
};

/**
 * Floating full-text translation meter for the dual-pane translation panel.
 * The panel owns the job but hides the source toolbar, so this keeps the same
 * stage / percentage feedback visible while the translation runs, and the
 * shared recovery actions available after a partial run or cache hydrate.
 *
 * The meter copies the reader toolbar's expanded translate button — the same
 * 11rem readout surface, caption type, inset rail and trailing stop square —
 * so the two panes do not show two dialects of the same progress. The partial
 * warning is a document-level alarm, not a stage of the job; it sits at the
 * leading edge of the same card, exactly like the reader toolbar keeps it
 * before the expanding meter.
 */
export function PdfTranslateProgressChip({
	layoutTranslateRunning,
	layoutTranslatePreparing = false,
	layoutTranslateWaiting = false,
	layoutTranslateQueued = false,
	layoutTranslateProgress = null,
	layoutTranslatePageCounts = null,
	layoutTranslatePartial = null,
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
		layoutTranslateQueued,
		layoutTranslateProgress,
		layoutTranslatePageCounts,
	});
	const showPartial = layoutTranslatePartial?.visible;
	if (!open && !showPartial) return null;
	const cancellable = layoutTranslateRunning || layoutTranslateWaiting;
	const stopLabel = layoutTranslateWaiting
		? t("pdf.layoutTranslate.waiting")
		: t("pdf.layoutTranslate.stop");

	return (
		<div className="pointer-events-none absolute top-2 right-3 z-20 flex select-none items-center gap-1">
			<div
				data-pdf-chrome
				className={cn(
					"pointer-events-auto flex h-7 items-center gap-0.5 rounded-lg p-0.5",
					PDF_CHROME_CHIP,
				)}
			>
				{showPartial ? (
					<PdfTranslatePartialButton partial={layoutTranslatePartial} />
				) : null}
				{open ? (
					<div className="relative h-6 w-44">
						<PdfTranslateMeterReadout
							stage={stage}
							pagesLabel={pagesLabel}
							percent={percent}
							indeterminate={indeterminate}
							width={width}
							retracting={retracting}
							lingerFull={lingerFull}
							showStop={cancellable}
							stopLabel={stopLabel}
							onStop={onStop}
						/>
					</div>
				) : null}
				<span
					role="progressbar"
					className="sr-only"
					aria-label={stage}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={indeterminate ? undefined : Math.round(ratio * 100)}
				/>
			</div>
		</div>
	);
}
