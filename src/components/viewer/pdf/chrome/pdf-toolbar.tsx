import type { PdfEngine } from "@embedpdf/models";
import {
	Languages,
	Library,
	Loader2,
	Minus,
	Plus,
	ScanSearch,
} from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import {
	formatPdfZoomPercentage,
	PDF_ZOOM_MAX,
	PDF_ZOOM_MIN,
} from "@/lib/pdf/zoom";
import { formatShortcutById } from "@/lib/shell/shortcuts";

type PdfToolbarProps = {
	zoomLevel: number;
	onZoomIn: () => void;
	onZoomOut: () => void;
	/** Editable zoom percentage (raw text while typing). */
	zoomField: string;
	onZoomFieldChange: (value: string) => void;
	/** True while the field owns focus, so zoom updates do not clobber typing. */
	zoomFieldFocusedRef: RefObject<boolean>;
	/** Escape sets this so the blur that follows discards the edit. */
	zoomFieldCancelRef: RefObject<boolean>;
	onCommitZoomField: (value: string) => void;
	regionSelecting: boolean;
	visualCropPending: boolean;
	engine: PdfEngine | null;
	onToggleRegionSelect: () => void;
	layoutTranslateRunning: boolean;
	layoutTranslateActive: boolean;
	layoutTranslateLabel: string;
	onToggleLayoutTranslate: () => void;
	/** Auto show/hide driven by scroll + pointer proximity (issue #400). */
	visible: boolean;
	/** True when viewing a remote paper that has no local sidecar. */
	isRemotePaper?: boolean;
	/** Import the remote paper into the current vault. */
	onImportToLibrary?: () => void;
	/** True while the import is running. */
	importBusy?: boolean;
};

/** Top-right toolbar: zoom, region select, bulk translate. */
export function PdfToolbar({
	zoomLevel,
	onZoomIn,
	onZoomOut,
	zoomField,
	onZoomFieldChange,
	zoomFieldFocusedRef,
	zoomFieldCancelRef,
	onCommitZoomField,
	regionSelecting,
	visualCropPending,
	engine,
	onToggleRegionSelect,
	layoutTranslateRunning,
	layoutTranslateActive,
	layoutTranslateLabel,
	onToggleLayoutTranslate,
	visible,
	isRemotePaper = false,
	onImportToLibrary,
	importBusy = false,
}: PdfToolbarProps) {
	const { t } = useTranslation("viewer");

	return (
		<div
			className={cn(
				"pointer-events-none absolute top-2 right-3 z-20 flex items-center gap-1 transition-opacity duration-200",
				visible ? "opacity-100" : "opacity-0",
			)}
		>
			<TooltipProvider delayDuration={200}>
				<div
					className={cn(
						"flex h-7 select-none items-center gap-0.5 rounded-lg border border-border/80 bg-background/95 p-0.5 shadow-sm backdrop-blur-sm",
						visible ? "pointer-events-auto" : "pointer-events-none",
					)}
				>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="icon-xs"
								variant="ghost"
								className="shrink-0 self-center"
								aria-label={t("pdf.zoomOut")}
								disabled={zoomLevel <= PDF_ZOOM_MIN}
								onClick={onZoomOut}
							>
								<Minus className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">{t("pdf.zoomOut")}</TooltipContent>
					</Tooltip>
					<div className="flex h-6 shrink-0 items-center self-center">
						<input
							type="text"
							inputMode="decimal"
							maxLength={6}
							value={zoomField}
							aria-label={t("pdf.zoomPercentage")}
							title={t("pdf.zoomPercentage")}
							size={Math.max(zoomField.length, 1)}
							style={{ width: `${Math.max(zoomField.length, 1)}ch` }}
							className="h-6 min-w-[1ch] rounded border border-transparent bg-transparent p-0 text-center font-medium text-muted-foreground text-xs leading-6 tabular-nums outline-none hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
							onChange={(event) => onZoomFieldChange(event.target.value)}
							onFocus={(event) => {
								zoomFieldFocusedRef.current = true;
								event.currentTarget.select();
							}}
							onBlur={(event) => {
								zoomFieldFocusedRef.current = false;
								if (zoomFieldCancelRef.current) {
									zoomFieldCancelRef.current = false;
									onZoomFieldChange(formatPdfZoomPercentage(zoomLevel));
									return;
								}
								onCommitZoomField(event.currentTarget.value);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									event.currentTarget.blur();
								} else if (event.key === "Escape") {
									event.preventDefault();
									zoomFieldCancelRef.current = true;
									event.currentTarget.blur();
								}
							}}
						/>
						<span
							aria-hidden="true"
							className="select-none text-muted-foreground text-xs leading-none"
						>
							%
						</span>
					</div>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="icon-xs"
								variant="ghost"
								className="shrink-0 self-center"
								aria-label={t("pdf.zoomIn")}
								disabled={zoomLevel >= PDF_ZOOM_MAX}
								onClick={onZoomIn}
							>
								<Plus className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">{t("pdf.zoomIn")}</TooltipContent>
					</Tooltip>
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
									{formatShortcutById("visualAnnotation")}
								</span>
							</TooltipContent>
						</Tooltip>
					) : null}
					{!isRemotePaper ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant={layoutTranslateActive ? "secondary" : "ghost"}
									className="shrink-0 self-center"
									aria-label={layoutTranslateLabel}
									aria-pressed={layoutTranslateActive}
									disabled={!engine}
									onClick={onToggleLayoutTranslate}
								>
									{layoutTranslateRunning ? (
										<Loader2 className="size-3.5 animate-spin" aria-hidden />
									) : (
										<Languages className="size-3.5" aria-hidden />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{layoutTranslateLabel}
							</TooltipContent>
						</Tooltip>
					) : null}
				</div>
			</TooltipProvider>
		</div>
	);
}
