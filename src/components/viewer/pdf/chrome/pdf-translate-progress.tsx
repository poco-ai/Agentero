import { useTranslation } from "react-i18next";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { PdfTranslateExportButton } from "@/components/viewer/pdf/chrome/pdf-translate-export-button";
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
	/** Mount the export menu only when the generated pages are ready. */
	onExport?: (dual?: boolean) => void;
	onStop: () => void;
};

/**
 * The translation pane's chrome: the job's stage / page count / stop square and
 * the export menu, all in one capsule.
 *
 * 对照 mode splits this pane out beside the reader, so the pane owns the job
 * chrome there: the reader toolbar hides its meter and its export instead of
 * running a second progress surface that starts over at 0%. The readout is the
 * same component the toolbar grows in 译文, so both modes read one progress
 * language — and the export menu is literally the same control.
 *
 * The partial warning is a document-level alarm, not a stage of the job; it
 * sits at the leading edge of the same card, exactly like the reader toolbar
 * keeps it before the meter.
 */
export function PdfTranslateProgressChip({
	layoutTranslateRunning,
	layoutTranslatePreparing = false,
	layoutTranslateWaiting = false,
	layoutTranslateQueued = false,
	layoutTranslateProgress = null,
	layoutTranslatePageCounts = null,
	layoutTranslatePartial = null,
	onExport,
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
	if (!open && !showPartial && !onExport) return null;
	// The stop square belongs to the meter, not to one stage: queued, waiting
	// and local page generation all have to be cancellable, exactly like the
	// reader toolbar's meter. The readout still swaps it for the completed check
	// and hides it while the bar retracts.
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
					<div className="shrink-0">
						<PdfTranslatePartialButton partial={layoutTranslatePartial} />
					</div>
				) : null}
				{onExport ? <PdfTranslateExportButton onExport={onExport} /> : null}
				{open ? (
					<PdfTranslateMeterReadout
						stage={stage}
						pagesLabel={pagesLabel}
						percent={percent}
						indeterminate={indeterminate}
						width={width}
						retracting={retracting}
						lingerFull={lingerFull}
						showStop
						stopLabel={stopLabel}
						onStop={onStop}
					/>
				) : null}
				{open ? (
					<span
						role="progressbar"
						className="sr-only"
						aria-label={stage}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={indeterminate ? undefined : Math.round(ratio * 100)}
					/>
				) : null}
			</div>
		</div>
	);
}
