import {
	ChevronLeft,
	ChevronRight,
	MoveHorizontal,
	Palette,
} from "lucide-react";
import type { RefObject } from "react";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SiArxiv } from "react-icons/si";
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
	/** True for remote arXiv papers with no local sidecar. */
	isRemotePaper?: boolean;
};

/** Bottom bar: page nav + zoom slider + PDF paper tone. */
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
	isRemotePaper = false,
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
					"pointer-events-auto flex max-w-full select-none items-center gap-0.5 rounded-lg p-0.5",
					PDF_CHROME_CHIP,
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
				<div className="flex shrink-0 items-center gap-1.5 px-1">
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
				<span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
				{tone}
			</div>
		</TooltipProvider>
	);

	return (
		<div className="pointer-events-none absolute bottom-3 left-1/2 z-20 max-w-[calc(100%-1rem)] -translate-x-1/2">
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
							className="shrink-0 text-muted-foreground"
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
