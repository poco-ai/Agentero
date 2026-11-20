import type { PdfEngine } from "@embedpdf/models";
import { Highlighter, Library, Loader2 } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { PdfTranslateExportButton } from "@/components/viewer/pdf/chrome/pdf-translate-export-button";
import { PdfTranslateMeterReadout } from "@/components/viewer/pdf/chrome/pdf-translate-meter";
import { PdfTranslatePartialButton } from "@/components/viewer/pdf/chrome/pdf-translate-partial-button";
import { PdfViewModeSwitch } from "@/components/viewer/pdf/chrome/pdf-view-mode-switch";
import type { PdfLayoutTranslatePartial } from "@/components/viewer/pdf/hooks/use-pdf-layout-translate";
import { useTranslateMeter } from "@/components/viewer/pdf/hooks/use-translate-meter";
import { cn } from "@/lib/core/utils";
import type { PdfViewMode } from "@/lib/pdf/view-mode";

type PdfToolbarProps = {
	onExportTranslatedPdf?: (dual?: boolean) => void;
	engine: PdfEngine | null;
	layoutTranslateRunning: boolean;
	/** Final corrected preview is still building after items settled. */
	layoutTranslatePreparing?: boolean;
	/** Queued behind layout analysis; plain click cancels the wait. */
	layoutTranslateWaiting?: boolean;
	layoutTranslateQueued?: boolean;
	/** Current reading view; dual means the translation pane is open beside. */
	viewMode: PdfViewMode;
	onSelectViewMode: (mode: PdfViewMode) => void;
	/** False on surfaces without a workspace pane (inline embeds). */
	canCompare?: boolean;
	/** Partial-translation entry; hidden while the meter is running. */
	layoutTranslatePartial?: PdfLayoutTranslatePartial | null;
	/**
	 * 0–1 fill. Stays under full while the reflow preview is still blank.
	 * Null before the total is known.
	 */
	layoutTranslateProgress?: number | null;
	/** Pages done ÷ pages in the current stage, when the stage has a count. */
	layoutTranslatePageCounts?: { done: number; total: number } | null;
	onToggleLayoutTranslate: () => void;
	/** True while jEV smart highlights are being generated. */
	smartHighlightBusy?: boolean;
	/** Trigger jEV smart highlighting for the current paper. */
	onSmartHighlight?: () => void;
	/** True when viewing a remote paper that has no local sidecar. */
	isRemotePaper?: boolean;
	/** Import the remote paper into the current vault. */
	onImportToLibrary?: () => void;
	/** True while the import is running. */
	importBusy?: boolean;
};

/** Top-right toolbar: reading view switch, bulk translate and smart highlight. */
export const PdfToolbar = memo(function PdfToolbar({
	onExportTranslatedPdf,
	engine,
	layoutTranslateRunning,
	layoutTranslatePreparing = false,
	layoutTranslateWaiting = false,
	layoutTranslateQueued = false,
	viewMode,
	onSelectViewMode,
	canCompare = true,
	layoutTranslatePartial = null,
	layoutTranslateProgress = null,
	layoutTranslatePageCounts = null,
	onToggleLayoutTranslate,
	smartHighlightBusy = false,
	onSmartHighlight,
	isRemotePaper = false,
	onImportToLibrary,
	importBusy = false,
}: PdfToolbarProps) {
	const { t } = useTranslation("viewer");
	// 原文 has no translation task, so none of its progress / failure / export
	// surfaces belong there. They appear only in 译文 and 对照.
	const translationView = viewMode !== "original";
	// 对照 splits the translation pane out beside the reader, and that pane owns
	// the job: its capsule shows the stage, the page count and the export menu.
	// Keeping a second meter here restarted at 0% beside the pane's real one.
	const jobChrome = translationView && viewMode !== "dual";

	const translateMeter = useTranslateMeter({
		layoutTranslateRunning,
		layoutTranslatePreparing,
		layoutTranslateWaiting,
		layoutTranslateQueued,
		layoutTranslateProgress,
		layoutTranslatePageCounts,
	});
	const {
		open: meterOpen,
		indeterminate: meterIndeterminate,
		retracting: meterRetracting,
		ratio: meterRatio,
		percent: meterPercent,
		pagesLabel: meterPagesLabel,
		stage: meterStage,
		width: smoothWidth,
		lingerFull,
	} = translateMeter;
	// The meter is the only task surface left in the toolbar: stop / cancel.
	const translateAriaLabel = layoutTranslateWaiting
		? t("pdf.layoutTranslate.waiting")
		: t("pdf.layoutTranslate.stop");
	const meterActive = meterOpen && jobChrome;
	const asideClass = cn(
		"grid min-w-0 transition-[grid-template-columns,opacity] duration-300 ease-out motion-reduce:transition-none",
		meterActive
			? "pointer-events-none grid-cols-[0fr] opacity-0"
			: "grid-cols-[1fr] opacity-100",
	);

	return (
		<div className="pointer-events-none absolute top-2 right-3 z-20 flex origin-top-right items-center gap-1">
			{meterOpen && jobChrome ? (
				<span
					role="progressbar"
					className="sr-only"
					aria-label={meterStage}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={
						meterIndeterminate ? undefined : Math.round(meterRatio * 100)
					}
				/>
			) : null}
			<TooltipProvider delayDuration={200}>
				<div
					data-pdf-chrome
					className={cn(
						"pointer-events-auto flex h-7 select-none items-center gap-0.5 rounded-lg p-0.5",
						PDF_CHROME_CHIP,
					)}
				>
					{/* Partial-translation warning sits first: it is a document-level
					    state, so it stays put when the translate button expands. */}
					{jobChrome && !isRemotePaper && layoutTranslatePartial?.visible ? (
						<div className="shrink-0">
							<PdfTranslatePartialButton partial={layoutTranslatePartial} />
						</div>
					) : null}
					{jobChrome && onExportTranslatedPdf ? (
						<div className={asideClass} inert={meterActive}>
							<div className="min-w-0 overflow-hidden">
								<PdfTranslateExportButton onExport={onExportTranslatedPdf} />
							</div>
						</div>
					) : null}
					{isRemotePaper ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									className="shrink-0 self-center"
									aria-label={t("pdf.importToLibrary")}
									disabled={importBusy}
									onClick={onImportToLibrary}
								>
									{importBusy ? (
										<Loader2 className="size-3.5 animate-spin" aria-hidden />
									) : (
										<Library className="size-3.5" aria-hidden />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("pdf.importToLibrary")}
							</TooltipContent>
						</Tooltip>
					) : null}
					{jobChrome && !isRemotePaper ? (
						/* Progress sits left of the view switch so the reader can still
						   change views while the translation runs. The running surface is
						   a readout, not a control: only the trailing square cancels. */
						<div
							data-translate-meter
							inert={!meterOpen}
							className={cn(
								"grid min-w-0 shrink-0 transition-[grid-template-columns,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
								meterOpen
									? "grid-cols-[1fr] opacity-100"
									: "pointer-events-none grid-cols-[0fr] opacity-0",
							)}
						>
							<div className="min-w-0 overflow-hidden">
								{/* Stays mounted while collapsed so the grid track can
								    animate both ways; `inert` keeps it untabbable. */}
								<PdfTranslateMeterReadout
									stage={meterStage}
									pagesLabel={meterPagesLabel}
									percent={meterPercent}
									indeterminate={meterIndeterminate}
									width={smoothWidth}
									retracting={meterRetracting}
									lingerFull={lingerFull}
									showStop
									stopLabel={translateAriaLabel}
									onStop={onToggleLayoutTranslate}
									stopDisabled={!engine}
								/>
							</div>
						</div>
					) : null}
					{!isRemotePaper ? (
						<div
							data-full-text-translate
							className="relative flex h-6 shrink-0 items-center"
						>
							<PdfViewModeSwitch
								mode={viewMode}
								onSelect={onSelectViewMode}
								disabled={!engine}
								dualDisabled={!canCompare}
							/>
						</div>
					) : null}
					{!isRemotePaper && onSmartHighlight ? (
						<div className={asideClass} inert={meterActive}>
							<div className="min-w-0 overflow-hidden">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											size="icon-xs"
											variant="ghost"
											className="shrink-0 self-center"
											aria-label={t("pdf.smartHighlight")}
											disabled={!engine || smartHighlightBusy}
											onClick={onSmartHighlight}
										>
											{smartHighlightBusy ? (
												<Loader2
													className="size-3.5 animate-spin"
													aria-hidden
												/>
											) : (
												<Highlighter className="size-3.5" aria-hidden />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">
										{t("pdf.smartHighlight")}
									</TooltipContent>
								</Tooltip>
							</div>
						</div>
					) : null}
				</div>
			</TooltipProvider>
		</div>
	);
});
