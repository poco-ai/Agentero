import { Loader2 } from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { PreviewArrow } from "@/components/viewer/pdf/cards/preview-arrow";
import { PDF_FLOAT_CARD } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { usePdfPaperTone } from "@/components/viewer/pdf/hooks/use-pdf-paper-tone";
import {
	computePreviewPlacement,
	PREVIEW_VIEWPORT_PADDING,
} from "@/components/viewer/pdf/preview-placement";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import type { PromptImage } from "@/lib/agent/api";
import { cn } from "@/lib/core/utils";
import type { CrossrefKind } from "@/lib/pdf/citation-dest-keys";
import {
	PDF_PAGE_RASTER_DARK_CLASS,
	PDF_PAPER_SHELL_CLASS,
	PDF_PAPER_TINT,
} from "@/lib/pdf/page-theme";

const CARD_WIDTH_DEFAULT = 340;
const CARD_WIDTH_REFERENCE = 480;
const CARD_ESTIMATED_HEIGHT_DEFAULT = 260;
const CARD_ESTIMATED_HEIGHT_REFERENCE = 180;
/** Narrowest card when sized to a 1:1 crop. */
const CARD_MIN_WIDTH = 200;
/** Card padding + crop border around a 1:1 crop (horizontal). */
const CARD_CHROME_WIDTH = 18;
/** Header row + padding above / below a 1:1 crop (vertical). */
const CARD_CHROME_HEIGHT = 48;
/** Spinner box height before the crop size is known. */
const LOADING_MIN_HEIGHT = 60;

/**
 * Hover card for a `\ref` cross-reference link: a crop of the figure / table /
 * equation / algorithm the link points at. Only mounted when the destination
 * resolved to a layout region; the crop streams in (spinner until ready).
 */
export function PdfCrossrefPreview({
	screen,
	kind,
	page,
	image,
	targetSize,
	onPointerEnter,
	onPointerLeave,
}: {
	screen: ScreenPoint;
	kind: CrossrefKind;
	page: number;
	image: PromptImage | null;
	targetSize?: { width: number; height: number };
	onPointerEnter: () => void;
	onPointerLeave: () => void;
}) {
	const { t } = useTranslation("viewer");
	const { pdfTone } = usePdfPaperTone();
	const rootRef = useRef<HTMLDivElement>(null);
	const viewportWidth =
		typeof window === "undefined" ? 1200 : window.innerWidth;
	const viewportHeight =
		typeof window === "undefined" ? 800 : window.innerHeight;
	const cardWidth = targetSize
		? Math.min(
				Math.max(CARD_MIN_WIDTH, targetSize.width + CARD_CHROME_WIDTH),
				viewportWidth - PREVIEW_VIEWPORT_PADDING * 2,
			)
		: kind === "reference"
			? CARD_WIDTH_REFERENCE
			: CARD_WIDTH_DEFAULT;
	const cardEstimatedHeight = targetSize
		? Math.min(
				targetSize.height + CARD_CHROME_HEIGHT,
				viewportHeight - PREVIEW_VIEWPORT_PADDING * 2,
			)
		: kind === "reference"
			? CARD_ESTIMATED_HEIGHT_REFERENCE
			: CARD_ESTIMATED_HEIGHT_DEFAULT;

	const { placement, left, top, bottom, arrowLeft, maxContentHeight } =
		computePreviewPlacement({
			screen,
			cardWidth,
			cardEstimatedHeight,
			cardChromeHeight: CARD_CHROME_HEIGHT,
			viewportWidth,
			viewportHeight,
		});
	const paperTint = PDF_PAPER_TINT[pdfTone];

	const kindLabel =
		kind === "figure"
			? t("crossref.kindFigure")
			: kind === "table"
				? t("crossref.kindTable")
				: kind === "equation"
					? t("crossref.kindEquation")
					: kind === "algorithm"
						? t("crossref.kindAlgorithm")
						: t("crossref.kindReference");

	// Mount under an existing pointer skips pointerenter — re-arm sticky hover.
	useEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		if (el.matches(":hover")) onPointerEnter();
	}, [onPointerEnter]);

	const handlePointerLeave = (e: ReactPointerEvent<HTMLDivElement>) => {
		const next = e.relatedTarget;
		if (next instanceof Node && e.currentTarget.contains(next)) return;
		onPointerLeave();
	};

	return (
		<div
			ref={rootRef}
			role="dialog"
			aria-label={t("crossref.previewLabel")}
			data-pdf-chrome
			className={cn(
				"fixed z-50 p-2",
				PDF_FLOAT_CARD,
				placement === "bottom" ? "origin-top" : "origin-bottom",
				"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150 motion-reduce:animate-none",
			)}
			style={{ left, top, bottom, width: cardWidth }}
			onPointerEnter={onPointerEnter}
			onPointerLeave={handlePointerLeave}
		>
			<PreviewArrow placement={placement} left={arrowLeft} />
			<div className="mb-1.5 flex items-center justify-between gap-2 px-1">
				<span className="font-medium text-caption text-foreground">
					{kindLabel}
				</span>
				<span className="text-caption text-muted-foreground tabular-nums">
					{t("figures.page", { page })}
				</span>
			</div>
			{/* Paper tone follows the page: shell colour behind, multiply tint over
			    the crop, inverted raster in dark mode. */}
			<div
				className={cn(
					"relative isolate flex items-center justify-center overflow-hidden rounded-md border border-border/40",
					PDF_PAPER_SHELL_CLASS[pdfTone],
				)}
				style={{
					maxHeight: `${maxContentHeight}px`,
					minHeight: targetSize
						? `${Math.min(targetSize.height, maxContentHeight)}px`
						: undefined,
				}}
			>
				{image && paperTint ? (
					<div
						aria-hidden
						className="pointer-events-none absolute inset-0 z-10 mix-blend-multiply"
						style={{ backgroundColor: paperTint }}
					/>
				) : null}
				{image ? (
					<img
						src={`data:${image.mimeType};base64,${image.data}`}
						alt={kindLabel}
						className={cn(
							"max-w-full object-contain",
							pdfTone === "dark" && PDF_PAGE_RASTER_DARK_CLASS,
						)}
						style={{
							maxHeight: `${maxContentHeight}px`,
							width: targetSize ? `${targetSize.width}px` : undefined,
							height: "auto",
						}}
					/>
				) : (
					<div
						className="flex items-center justify-center"
						style={{
							height: targetSize
								? `${Math.max(LOADING_MIN_HEIGHT, Math.min(targetSize.height, maxContentHeight))}px`
								: "96px",
						}}
					>
						<Loader2
							className="size-4 animate-spin text-muted-foreground"
							aria-label={t("crossref.loading")}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
