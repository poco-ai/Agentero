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
	layoutTranslateActive: boolean;
	layoutTranslateLabel: string;
	/**
	 * 0–1 fill. Stays under full while the reflow preview is still blank.
	 * Null before the total is known.
	 */
	layoutTranslateProgress?: number | null;
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

const TRANSLATE_METER_LINGER_MS = 700;

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
	layoutTranslateActive,
	layoutTranslateLabel,
	layoutTranslateProgress = null,
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

	const translateBusy =
		layoutTranslateRunning ||
		layoutTranslatePreparing ||
		layoutTranslateWaiting;
	const [lingerFull, setLingerFull] = useState(false);
	const wasTranslateBusyRef = useRef(false);
	const translateComplete = layoutTranslateProgress === 1;
	useEffect(() => {
		if (translateBusy) {
			wasTranslateBusyRef.current = true;
			setLingerFull(false);
			return;
		}
		if (!translateComplete) {
			setLingerFull(false);
			wasTranslateBusyRef.current = false;
			return;
		}
		if (!wasTranslateBusyRef.current) return;
		wasTranslateBusyRef.current = false;
		setLingerFull(true);
		const id = window.setTimeout(
			() => setLingerFull(false),
			TRANSLATE_METER_LINGER_MS,
		);
		return () => window.clearTimeout(id);
	}, [translateComplete, translateBusy]);

	const meterOpen = translateBusy || lingerFull;
	const meterIndeterminate =
		meterOpen &&
		!lingerFull &&
		(layoutTranslateWaiting || layoutTranslateProgress == null);
	const meterRatio = lingerFull
		? 1
		: Math.max(0, Math.min(1, layoutTranslateProgress ?? 0));
	const meterPercent = Math.round(meterRatio * 100);

	const [meterGrown, setMeterGrown] = useState(false);
	useEffect(() => {
		if (!meterOpen) {
			setMeterGrown(false);
			return;
		}
		const id = requestAnimationFrame(() => setMeterGrown(true));
		return () => cancelAnimationFrame(id);
	}, [meterOpen]);
	const meterWidth =
		meterOpen && meterGrown && !meterIndeterminate ? meterRatio : 0;
	const meterStage = lingerFull
		? t("pdf.layoutTranslate.phaseDone")
		: layoutTranslateWaiting
			? t("pdf.layoutTranslate.phaseLayout")
			: layoutTranslatePreparing
				? t("pdf.layoutTranslate.phaseTypeset")
				: meterIndeterminate
					? t("pdf.layoutTranslate.phaseExtract")
					: t("pdf.layoutTranslate.phaseTranslate");
	const translateAriaLabel =
		meterOpen && !meterIndeterminate
			? `${layoutTranslateLabel} ${t("pdf.layoutTranslate.progress", { percent: meterPercent })}`
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
					aria-valuenow={meterIndeterminate ? undefined : meterPercent}
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
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant={
										layoutTranslateActive ||
										layoutTranslateWaiting ||
										longPressing
											? "secondary"
											: "ghost"
									}
									className={cn(
										"relative h-6! overflow-hidden px-0 transition-[width,border-radius,color,background-color,border-color,box-shadow,transform,opacity] duration-300 ease-out motion-reduce:transition-none",
										meterOpen
											? "w-44! justify-end rounded-lg! bg-transparent! hover:bg-muted/60!"
											: "w-6!",
									)}
									data-full-text-translate
									aria-label={translateAriaLabel}
									aria-pressed={layoutTranslateActive || layoutTranslateWaiting}
									disabled={!engine}
									onPointerDown={handleTranslatePointerDown}
									onPointerUp={handleTranslatePointerUp}
									onPointerLeave={handleTranslatePointerLeave}
									onPointerCancel={handleTranslatePointerLeave}
									onClick={handleTranslateClick}
								>
									{meterOpen ? (
										<>
											<span
												aria-hidden
												className="pointer-events-none absolute inset-x-2 bottom-0 h-0.5 overflow-hidden rounded-full bg-foreground/5"
											>
												<span
													className={cn(
														"absolute inset-y-0 left-0 rounded-full bg-foreground/45 transition-[width] duration-500 ease-out motion-reduce:transition-none",
														meterIndeterminate && "pdf-translate-indeterminate",
													)}
													style={{
														width: meterIndeterminate
															? "30%"
															: `${meterWidth * 100}%`,
													}}
												/>
											</span>
											<span
												aria-hidden
												className="pointer-events-none absolute left-2.5 right-14 truncate text-left text-[0.625rem] font-medium text-foreground/75"
											>
												{meterStage}
											</span>
											{!meterIndeterminate ? (
												<span
													aria-hidden
													className="absolute right-7 text-[0.625rem] text-muted-foreground tabular-nums"
												>
													{meterPercent}%
												</span>
											) : null}
										</>
									) : null}
									<span className="relative z-10 flex size-6 items-center justify-center">
										{lingerFull ? (
											<Check className="size-3.5" aria-hidden />
										) : translateBusy ? (
											<Square
												className="size-2.5 fill-current opacity-60"
												aria-hidden
											/>
										) : (
											<Languages className="size-3.5" aria-hidden />
										)}
									</span>
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{layoutTranslateLabel}
								{meterOpen && !meterIndeterminate ? (
									<span className="ml-2 text-background/70">
										{t("pdf.layoutTranslate.progress", {
											percent: meterPercent,
										})}
									</span>
								) : null}
								{/* Inverted tooltip: mute via text-background, not muted-foreground. */}
								<span className="ml-2 text-background/70">
									{translateShortcut}
								</span>
							</TooltipContent>
						</Tooltip>
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
