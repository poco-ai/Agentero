import {
	ChevronLeft,
	ChevronRight,
	MoveHorizontal,
	Palette,
	X,
} from "lucide-react";
import type { RefObject } from "react";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SiArxiv } from "react-icons/si";
import { LayoutElementSelectIcon } from "@/components/icons/layout-element-select-icon";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { useSettings } from "@/hooks/use-app-stores";
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
import { cn } from "@/lib/core/utils";
import {
	PDF_PAPER_SWATCH_CLASS,
	PDF_PAPER_TONES,
	type PdfPaperTone,
} from "@/lib/pdf/page-theme";
import {
	formatPdfZoomPercentage,
	PDF_ZOOM_MAX,
	PDF_ZOOM_MIN,
} from "@/lib/pdf/zoom";

type PdfBottomBarProps = {
	/** Hidden until the document reports its page count. */
	totalPages: number;
	currentPage: number;
	onGoToPage: (page: number) => void;
	/** Editable page number (raw digits while typing). */
	pageField: string;
	onPageFieldChange: (value: string) => void;
	/** True while the field owns focus, so scrolling does not clobber typing. */
	pageFocusedRef: RefObject<boolean>;
	onCommitPageField: () => void;
	pdfTone: PdfPaperTone;
	onSetPdfTone: (tone: PdfPaperTone) => void;
	/** Current zoom scale (1 = 100%). */
	zoomLevel: number;
	/** Apply a zoom scale from the slider. */
	onZoomChange: (zoom: number) => void;
	/** Fit the page width to the reading area. */
	onFitWidth: () => void;
	/**
	 * Layout element selection. The host omits the toggle on surfaces that hide
	 * the full PDF chrome (plain embeds, immersive reading, remote papers).
	 */
	elementSelecting?: boolean;
	elementSelectionAvailable?: boolean;
	elementSelectionDisabled?: boolean;
	onToggleElementSelection?: () => void;
	/** True for remote arXiv papers with no local sidecar. */
	isRemotePaper?: boolean;
	/** Immersive reading: show an exit control and drop the tone picker. */
	onExitImmersive?: () => void;
	/** False fades the bar without unmounting it. */
	presented?: boolean;
};

/** Bottom bar: page nav, zoom slider, paper tone and element selection. */
export const PdfBottomBar = memo(function PdfBottomBar({
	totalPages,
	currentPage,
	onGoToPage,
	pageField,
	onPageFieldChange,
	pageFocusedRef,
	onCommitPageField,
	pdfTone,
	onSetPdfTone,
	zoomLevel,
	onZoomChange,
	onFitWidth,
	elementSelecting = false,
	elementSelectionAvailable = false,
	elementSelectionDisabled = false,
	onToggleElementSelection,
	isRemotePaper = false,
	onExitImmersive,
	presented = true,
}: PdfBottomBarProps) {
	const { t } = useTranslation("viewer");
	const paginated = useSettings((s) => s.pdfScrollStrategy === "paginated");
	const [tonePickerOpen, setTonePickerOpen] = useState(false);

	if (totalPages <= 0) return null;

	const pageDigits = Math.max(2, String(totalPages).length, pageField.length);
	const zoomPercent = Math.round(zoomLevel * 100);
	const zoomMinPercent = Math.round(PDF_ZOOM_MIN * 100);
	const zoomMaxPercent = Math.round(PDF_ZOOM_MAX * 100);

	const pageFieldNode = (
		<div className="flex min-w-0 shrink items-center">
			{paginated && (
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={t("pdf.previousPage")}
					title={t("pdf.previousPage")}
					disabled={currentPage <= 1}
					onClick={() => onGoToPage(currentPage - 1)}
				>
					<ChevronLeft />
				</Button>
			)}
			<input
				type="text"
				inputMode="numeric"
				className="min-w-6 rounded bg-transparent px-0.5 text-center font-medium text-foreground text-sm tabular-nums outline-none focus:bg-muted"
				style={{ width: `${pageDigits + 1}ch` }}
				aria-label={t("pdf.goToPage")}
				value={pageField}
				onFocus={(e) => {
					pageFocusedRef.current = true;
					e.currentTarget.select();
				}}
				onChange={(e) =>
					onPageFieldChange(e.target.value.replace(/[^0-9]/g, ""))
				}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						onCommitPageField();
						e.currentTarget.blur();
					}
				}}
				onBlur={() => {
					pageFocusedRef.current = false;
					onCommitPageField();
				}}
			/>
			<span className="shrink-0 px-0.5 text-muted-foreground text-sm tabular-nums">
				/ {totalPages}
			</span>
			{paginated && (
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={t("pdf.nextPage")}
					title={t("pdf.nextPage")}
					disabled={currentPage >= totalPages}
					onClick={() => onGoToPage(currentPage + 1)}
				>
					<ChevronRight />
				</Button>
			)}
		</div>
	);

	const tone = (
		<PdfPaperToneButton
			pdfTone={pdfTone}
			onSetPdfTone={onSetPdfTone}
			side="top"
			size="icon-xs"
			open={tonePickerOpen}
			onOpenChange={setTonePickerOpen}
		/>
	);

	const chrome = (
		<TooltipProvider delayDuration={200}>
			<div
				data-pdf-chrome
				className={cn(
					"flex max-w-full select-none items-center gap-0.5 rounded-lg p-0.5 transition-opacity duration-200 focus-within:pointer-events-auto focus-within:opacity-100 motion-reduce:transition-none",
					PDF_CHROME_CHIP,
					presented
						? "pointer-events-auto opacity-100"
						: "pointer-events-none opacity-0",
				)}
			>
				{isRemotePaper ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<div
								className={cn(
									"flex items-center gap-1 rounded px-1.5 py-0.5 text-primary",
									"bg-primary/10",
								)}
							>
								<SiArxiv
									className="size-3.5 shrink-0 text-[#B31B1B]"
									aria-hidden
								/>
								<span className="whitespace-nowrap text-caption font-medium">
									{t("pdf.remoteMode")}
								</span>
							</div>
						</TooltipTrigger>
						<TooltipContent side="top">{t("pdf.remoteMode")}</TooltipContent>
					</Tooltip>
				) : null}
				{pageFieldNode}
				<span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
				<div className="flex shrink-0 items-center gap-1.5 pl-1">
					<input
						type="range"
						min={zoomMinPercent}
						max={zoomMaxPercent}
						step={1}
						value={zoomPercent}
						aria-label={t("pdf.zoomPercentage")}
						aria-valuemin={zoomMinPercent}
						aria-valuemax={zoomMaxPercent}
						aria-valuenow={zoomPercent}
						aria-valuetext={`${formatPdfZoomPercentage(zoomLevel)}%`}
						className="pdf-zoom-slider"
						onChange={(e) => onZoomChange(Number(e.target.value) / 100)}
					/>
					<span
						aria-hidden
						className="min-w-[3.25ch] text-right text-muted-foreground text-xs tabular-nums"
					>
						{formatPdfZoomPercentage(zoomLevel)}%
					</span>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="icon-xs"
								variant="ghost"
								aria-label={t("pdf.zoomFit")}
								onClick={onFitWidth}
							>
								<MoveHorizontal className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="top">{t("pdf.zoomFit")}</TooltipContent>
					</Tooltip>
				</div>
				{/* Fit width, paper tone and element selection are one flat action
				    group: no dividers between them and no per-button color, so they
				    read as peers rather than as separate clusters. */}
				{onExitImmersive ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="icon-xs"
								variant="ghost"
								aria-label={t("pdf.exitImmersive")}
								onClick={onExitImmersive}
							>
								<X className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="top">{t("pdf.exitImmersive")}</TooltipContent>
					</Tooltip>
				) : (
					tone
				)}
				{onToggleElementSelection ? (
					<ElementSelectionButton
						selecting={elementSelecting}
						available={elementSelectionAvailable}
						disabled={elementSelectionDisabled}
						onToggle={onToggleElementSelection}
					/>
				) : null}
			</div>
		</TooltipProvider>
	);

	return (
		// Below the left panels (z-20) on purpose: an open outline / references /
		// figures rail covers the bar instead of reserving a bottom lane for it.
		<div className="pointer-events-none absolute bottom-3 left-1/2 z-10 max-w-[calc(100%-1rem)] -translate-x-1/2">
			{chrome}
		</div>
	);
});

function PdfPaperToneButton({
	pdfTone,
	onSetPdfTone,
	side = "bottom",
	size = "icon-sm",
	open,
	onOpenChange,
}: {
	pdfTone: PdfPaperTone;
	onSetPdfTone: (tone: PdfPaperTone) => void;
	side?: "top" | "bottom";
	size?: "icon-xs" | "icon-sm";
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const { t } = useTranslation("viewer");
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const pickerOpen = open ?? uncontrolledOpen;
	const setPickerOpen = onOpenChange ?? setUncontrolledOpen;

	return (
		<Popover open={pickerOpen} onOpenChange={setPickerOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							type="button"
							size={size}
							variant="ghost"
							className="shrink-0"
							aria-label={t("pdf.paperTone")}
							title={t("pdf.paperTone")}
						>
							<Palette className="size-3.5" />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side={side}>{t("pdf.paperTone")}</TooltipContent>
			</Tooltip>
			<PopoverContent
				side={side}
				align="end"
				className="w-auto flex-row items-center gap-1.5 p-1.5"
			>
				{PDF_PAPER_TONES.map((paperTone) => {
					const label = t(`pdf.paperToneOption.${paperTone}`);
					return (
						<Tooltip key={paperTone}>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={label}
									aria-pressed={pdfTone === paperTone}
									className={cn(
										"size-5 shrink-0 rounded-full ring-1 ring-black/15 transition-transform duration-100 hover:scale-105 active:scale-95 dark:ring-white/25",
										PDF_PAPER_SWATCH_CLASS[paperTone],
										pdfTone === paperTone &&
											"ring-2 ring-foreground/70 ring-offset-1 ring-offset-popover",
									)}
									onClick={() => {
										onSetPdfTone(paperTone);
										setPickerOpen(false);
									}}
								/>
							</TooltipTrigger>
							<TooltipContent side="top">{label}</TooltipContent>
						</Tooltip>
					);
				})}
			</PopoverContent>
		</Popover>
	);
}

/**
 * Layout element selection lives at the far right of the bottom bar: it acts on
 * the page surface above, not on the chrome cluster in the top-right corner.
 */
function ElementSelectionButton({
	selecting,
	available,
	disabled,
	onToggle,
}: {
	selecting: boolean;
	available: boolean;
	disabled: boolean;
	onToggle: () => void;
}) {
	const { t } = useTranslation("viewer");
	const shortcut = useShortcutLabel("layoutElementSelection");
	const label = !available
		? t("figures.selectionNeedsLayout")
		: selecting
			? t("figures.exitElementSelection")
			: t("figures.selectElements");

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					size="icon-xs"
					variant={selecting ? "secondary" : "ghost"}
					className="shrink-0 self-center"
					aria-label={t("figures.selectElements")}
					aria-pressed={selecting}
					disabled={disabled || (!available && !selecting)}
					onClick={onToggle}
				>
					<LayoutElementSelectIcon className="size-3.5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top">
				{label}
				<span className="ml-2 text-background/70">{shortcut}</span>
			</TooltipContent>
		</Tooltip>
	);
}
