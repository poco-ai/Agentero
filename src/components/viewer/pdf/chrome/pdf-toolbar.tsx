import type { PdfEngine } from "@embedpdf/models";
import {
	Check,
	Download,
	Highlighter,
	Languages,
	Library,
	Loader2,
	ScanSearch,
	Square,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import {
	PDF_TRANSLATE_METER_PERCENT,
	PDF_TRANSLATE_METER_STAGE,
	PdfTranslateMeterBar,
} from "@/components/viewer/pdf/chrome/pdf-translate-meter";
import { PdfTranslatePartialButton } from "@/components/viewer/pdf/chrome/pdf-translate-partial-button";
import type { PdfLayoutTranslatePartial } from "@/components/viewer/pdf/hooks/use-pdf-layout-translate";
import { useTranslateMeter } from "@/components/viewer/pdf/hooks/use-translate-meter";
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
import { cn } from "@/lib/core/utils";

type PdfToolbarProps = {
	onExportTranslatedPdf?: (dual?: boolean) => void;
	regionSelecting: boolean;
	visualCropPending: boolean;
	engine: PdfEngine | null;
	onToggleRegionSelect: () => void;
	layoutTranslateRunning: boolean;
	/** Final corrected preview is still building after items settled. */
	layoutTranslatePreparing?: boolean;
	/** Queued behind layout analysis; plain click cancels the wait. */
	layoutTranslateWaiting?: boolean;
	layoutTranslateQueued?: boolean;
	layoutTranslateActive: boolean;
	layoutTranslateLabel: string;
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

/** Top-right toolbar: region select, bulk translate. Always visible. */
export const PdfToolbar = memo(function PdfToolbar({
	onExportTranslatedPdf,
	regionSelecting,
	visualCropPending,
	engine,
	onToggleRegionSelect,
	layoutTranslateRunning,
	layoutTranslatePreparing = false,
	layoutTranslateWaiting = false,
	layoutTranslateQueued = false,
	layoutTranslateActive,
	layoutTranslateLabel,
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
	const visualShortcut = useShortcutLabel("visualAnnotation");
	const translateShortcut = useShortcutLabel("layoutTranslate");

	const LONG_PRESS_MS = 300;
	const longPressTimerRef = useRef<number | null>(null);
	const longPressTriggeredRef = useRef(false);
	const suppressNextClickRef = useRef(false);
	const [longPressing, setLongPressing] = useState(false);

	const clearLongPressTimer = useCallback(() => {
		if (longPressTimerRef.current != null) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	}, []);

	useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

	const handleTranslatePointerDown = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			if (event.button !== 0) return;
			if (layoutTranslateActive || layoutTranslateRunning) return;
			if (layoutTranslateWaiting) return;
			setLongPressing(true);
			longPressTriggeredRef.current = false;
			suppressNextClickRef.current = false;
			longPressTimerRef.current = window.setTimeout(() => {
				longPressTriggeredRef.current = true;
				suppressNextClickRef.current = true;
				setLongPressing(true);
				onToggleLayoutTranslate();
			}, LONG_PRESS_MS);
		},
		[
			layoutTranslateActive,
			layoutTranslateRunning,
			layoutTranslateWaiting,
			onToggleLayoutTranslate,
		],
	);

	const handleTranslatePointerUp = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			clearLongPressTimer();
			setLongPressing(false);
			if (event.button !== 0) return;
			if (!longPressTriggeredRef.current) return;
			longPressTriggeredRef.current = false;
			if (layoutTranslateActive || layoutTranslateRunning) {
				onToggleLayoutTranslate();
			}
		},
		[
			clearLongPressTimer,
			layoutTranslateActive,
			layoutTranslateRunning,
			onToggleLayoutTranslate,
		],
	);

	const handleTranslatePointerLeave = useCallback(() => {
		clearLongPressTimer();
		setLongPressing(false);
		if (!longPressTriggeredRef.current) return;
		longPressTriggeredRef.current = false;
		suppressNextClickRef.current = true;
		if (layoutTranslateActive || layoutTranslateRunning) {
			onToggleLayoutTranslate();
		}
	}, [
		clearLongPressTimer,
		layoutTranslateActive,
		layoutTranslateRunning,
		onToggleLayoutTranslate,
	]);

	const handleTranslateClick = useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			if (suppressNextClickRef.current) {
				event.preventDefault();
				suppressNextClickRef.current = false;
				return;
			}
			onToggleLayoutTranslate();
		},
		[onToggleLayoutTranslate],
	);

	const translateMeter = useTranslateMeter({
		layoutTranslateRunning,
		layoutTranslatePreparing,
		layoutTranslateWaiting,
		layoutTranslateQueued,
		layoutTranslateProgress,
		layoutTranslatePageCounts,
	});
	const {
		busy: translateBusy,
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
	const translateAriaLabel = translateBusy
		? layoutTranslateWaiting
			? t("pdf.layoutTranslate.waiting")
			: t("pdf.layoutTranslate.stop")
		: layoutTranslateLabel;
	const asideClass = cn(
		"grid min-w-0 transition-[grid-template-columns,opacity] duration-300 ease-out motion-reduce:transition-none",
		meterOpen
			? "pointer-events-none grid-cols-[0fr] opacity-0"
			: "grid-cols-[1fr] opacity-100",
	);

	return (
		<div className="pointer-events-none absolute top-2 right-3 z-20 flex origin-top-right items-center gap-1">
			{meterOpen ? (
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
						"pointer-events-auto flex h-7 select-none items-center rounded-lg p-0.5",
						meterOpen ? "gap-0" : "gap-0.5",
						PDF_CHROME_CHIP,
					)}
				>
					{/* Partial-translation warning sits first: it is a document-level
					    state, so it stays put when the translate button expands. */}
					{!isRemotePaper && layoutTranslatePartial?.visible ? (
						<div className="shrink-0">
							<PdfTranslatePartialButton partial={layoutTranslatePartial} />
						</div>
					) : null}
					{onExportTranslatedPdf ? (
						<div className={asideClass} inert={meterOpen}>
							<div className="min-w-0 overflow-hidden">
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											size="icon-xs"
											variant="ghost"
											aria-label={t("pdf.layoutTranslate.exportPdf")}
										>
											<Download className="size-3.5" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent>
										<DropdownMenuItem
											onSelect={() => onExportTranslatedPdf(false)}
										>
											{t("pdf.layoutTranslate.exportPdf")}
										</DropdownMenuItem>
										<DropdownMenuItem
											onSelect={() => onExportTranslatedPdf(true)}
										>
											{t("pdf.layoutTranslate.exportDualPdf")}
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
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
					{!isRemotePaper ? (
						<div className={asideClass} inert={meterOpen}>
							<div className="min-w-0 overflow-hidden">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											size="icon-xs"
											variant={regionSelecting ? "secondary" : "ghost"}
											className="shrink-0 self-center"
											aria-label={t("pdfExplain.selectRegion")}
											aria-pressed={regionSelecting}
											disabled={visualCropPending || !engine}
											onClick={onToggleRegionSelect}
										>
											<ScanSearch
												className={cn(
													"size-3.5",
													visualCropPending && "animate-pulse",
												)}
											/>
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">
										{regionSelecting
											? t("pdfExplain.cancelRegion")
											: t("pdfExplain.selectRegion")}
										{/* Inverted tooltip: mute via text-background, not muted-foreground. */}
										<span className="ml-2 text-background/70">
											{visualShortcut}
										</span>
									</TooltipContent>
								</Tooltip>
							</div>
						</div>
					) : null}
					{!isRemotePaper ? (
						<div
							data-full-text-translate
							className={cn(
								"relative flex h-6 shrink-0 items-center justify-end overflow-hidden transition-[width,border-radius,background-color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
								meterOpen ? "w-44 rounded-lg" : "w-6",
							)}
						>
							{/* The running surface is a readout, not a control: only the
							    trailing square cancels, so the expanded card is not a
							    button and does not swallow clicks. */}
							{meterOpen ? (
								<>
									<span className="pointer-events-none absolute inset-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-reduce:animate-none">
										<span className="absolute top-0 right-7 bottom-[5px] left-2.5 flex items-center gap-2">
											{/* String concat, not `cn`: tailwind-merge mistakes
											    `text-caption` for a text color and drops it. */}
											<span
												aria-hidden
												className={`min-w-0 flex-1 truncate ${PDF_TRANSLATE_METER_STAGE}`}
											>
												{meterStage}
											</span>
											{meterPagesLabel && !meterRetracting ? (
												<span
													aria-hidden
													className={PDF_TRANSLATE_METER_PERCENT}
												>
													{meterPagesLabel}
												</span>
											) : null}
											{!meterIndeterminate && !meterRetracting ? (
												<span
													aria-hidden
													className={PDF_TRANSLATE_METER_PERCENT}
												>
													{meterPercent}%
												</span>
											) : null}
										</span>
										<PdfTranslateMeterBar
											indeterminate={meterIndeterminate}
											width={smoothWidth}
										/>
									</span>
									{lingerFull ? (
										<span className="pointer-events-none absolute top-0 right-0 flex size-6 items-center justify-center text-foreground/70">
											<Check className="size-3.5" aria-hidden />
										</span>
									) : meterRetracting ? null : (
										<Button
											type="button"
											size="icon-xs"
											variant="ghost"
											className="absolute top-0 right-0 size-6 text-foreground"
											aria-label={translateAriaLabel}
											title={translateAriaLabel}
											disabled={!engine}
											onClick={onToggleLayoutTranslate}
										>
											<Square
												className="size-2.5 fill-current opacity-60"
												aria-hidden
											/>
										</Button>
									)}
								</>
							) : (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											size="icon-xs"
											variant={
												layoutTranslateActive || longPressing
													? "secondary"
													: "ghost"
											}
											className="size-6"
											aria-label={translateAriaLabel}
											aria-pressed={
												layoutTranslateActive || layoutTranslateWaiting
											}
											disabled={!engine}
											onPointerDown={handleTranslatePointerDown}
											onPointerUp={handleTranslatePointerUp}
											onPointerLeave={handleTranslatePointerLeave}
											onPointerCancel={handleTranslatePointerLeave}
											onClick={handleTranslateClick}
										>
											<Languages className="size-3.5" aria-hidden />
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">
										{translateAriaLabel}
										{/* Inverted tooltip: mute via text-background, not muted-foreground. */}
										<span className="ml-2 text-background/70">
											{translateShortcut}
										</span>
									</TooltipContent>
								</Tooltip>
							)}
						</div>
					) : null}
					{!isRemotePaper && onSmartHighlight ? (
						<div className={asideClass} inert={meterOpen}>
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
