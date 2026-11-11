import { Loader2 } from "lucide-react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { ScrollBar } from "@/components/ui/scroll-area";
import { PreviewArrow } from "@/components/viewer/pdf/cards/preview-arrow";
import { PDF_FLOAT_CARD } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { usePdfPaperTone } from "@/components/viewer/pdf/hooks/use-pdf-paper-tone";
import {
	computePreviewPlacement,
	PREVIEW_VIEWPORT_PADDING,
} from "@/components/viewer/pdf/preview-placement";
import type {
	CrossrefPreviewState,
	ScreenPoint,
} from "@/components/viewer/pdf/types";
import type { PromptImage } from "@/lib/agent/api";
import { cn } from "@/lib/core/utils";
import type { CrossrefKind } from "@/lib/pdf/citation-dest-keys";
import {
	PDF_PAPER_SHELL_CLASS,
	PDF_PAPER_TINT,
	pdfPaperRasterClass,
} from "@/lib/pdf/page-theme";

const CARD_WIDTH_DEFAULT = 340;
const CARD_WIDTH_REFERENCE = 480;
const CARD_ESTIMATED_HEIGHT_DEFAULT = 260;
const CARD_ESTIMATED_HEIGHT_REFERENCE = 180;
/** Narrowest card when sized to a 1:1 crop. */
const CARD_MIN_WIDTH = 200;
/** Card padding + outer and viewport borders around a 1:1 crop. */
const CARD_CHROME_WIDTH = 20;
/** Header row + padding above / below a 1:1 crop (vertical). */
const CARD_CHROME_HEIGHT = 48;
/** Spinner box height before the crop size is known. */
const LOADING_MIN_HEIGHT = 60;

/**
 * Floats show the whole destination page at the reader's zoom, positioned at
 * the link target. Overflow remains scrollable in both directions so captions
 * beside a figure and tall tables are accessible without squeezing the page.
 * Bibliography entries keep their focused crop.
 */
export function PdfCrossrefPreview({
	screen,
	kind,
	page,
	image,
	referenceImages,
	referenceEntries,
	missingReferences,
	targetSize,
	focusPoint,
	onPointerEnter,
	onPointerLeave,
}: {
	screen: ScreenPoint;
	kind: CrossrefKind;
	page: number;
	image: PromptImage | null;
	referenceImages?: CrossrefPreviewState["referenceImages"];
	referenceEntries?: number[];
	missingReferences?: number[];
	targetSize?: { width: number; height: number };
	focusPoint?: { x: number; y: number };
	onPointerEnter: () => void;
	onPointerLeave: () => void;
}) {
	const { t } = useTranslation("viewer");
	const { pdfTone } = usePdfPaperTone();
	const rootRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const viewportWidth =
		typeof window === "undefined" ? 1200 : window.innerWidth;
	const viewportHeight =
		typeof window === "undefined" ? 800 : window.innerHeight;
	const cardWidth = targetSize
		? Math.min(
				Math.max(CARD_MIN_WIDTH, targetSize.width + CARD_CHROME_WIDTH),
				Math.min(
					viewportWidth - PREVIEW_VIEWPORT_PADDING * 2,
					kind === "reference" ? viewportWidth : viewportWidth * 0.8,
				),
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
			maxContentHeight: kind === "reference" ? undefined : viewportHeight * 0.6,
		});
	const paperTint = PDF_PAPER_TINT[pdfTone];
	const contentHeight = Math.min(targetSize?.height ?? 180, maxContentHeight);
	const imageReady = image !== null;
	const focusX = focusPoint?.x ?? 0;
	const focusY = focusPoint?.y ?? 0;
	const imageWidth = targetSize?.width;
	const imageHeight = targetSize?.height;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new page with the same dimensions and target still needs its initial scroll position.
	useLayoutEffect(() => {
		const viewport = scrollRef.current;
		if (!viewport || !imageReady || !imageWidth || !imageHeight) return;
		viewport.scrollLeft = Math.max(
			0,
			Math.min(
				viewport.scrollWidth - viewport.clientWidth,
				focusX * imageWidth - viewport.clientWidth / 2,
			),
		);
		viewport.scrollTop = Math.max(
			0,
			Math.min(
				viewport.scrollHeight - viewport.clientHeight,
				focusY * imageHeight - viewport.clientHeight / 2,
			),
		);
		// Page/kind changes can reuse the same raster dimensions and focus point.
	}, [imageReady, imageWidth, imageHeight, focusX, focusY, page, kind]);

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
					{referenceEntries?.length ? ` [${referenceEntries.join(", ")}]` : ""}
				</span>
				<span className="text-caption text-muted-foreground tabular-nums">
					{t("figures.page", { page })}
				</span>
			</div>
			{missingReferences?.length ? (
				<p
					role="status"
					className="mb-1.5 px-1 text-caption text-muted-foreground"
				>
					{t("crossref.missingReferences", {
						numbers: missingReferences.join(", "),
					})}
				</p>
			) : null}
			{/* Paper tone follows the page: shell colour behind, multiply tint over
			    the crop, inverted raster in dark mode. */}
			<ScrollAreaPrimitive.Root
				type="always"
				className={cn(
					"relative isolate overflow-hidden rounded-md border border-border/40",
					PDF_PAPER_SHELL_CLASS[pdfTone],
				)}
				style={{
					height: `${contentHeight + 2}px`,
				}}
			>
				<ScrollAreaPrimitive.Viewport
					ref={scrollRef}
					data-pdf-crossref-scroll
					className="h-full w-full overscroll-contain rounded-[inherit] [&>div]:block!"
					onWheel={(event) => event.stopPropagation()}
				>
					{image ? (
						<div className="relative w-max">
							{(
								referenceImages ?? [
									{ id: "page", image, width: imageWidth, height: imageHeight },
								]
							).map((part) => (
								<img
									key={part.id}
									src={`data:${part.image.mimeType};base64,${part.image.data}`}
									alt={kindLabel}
									draggable={false}
									className={cn(
										"pointer-events-none block max-w-none select-none",
										pdfPaperRasterClass(pdfTone),
									)}
									style={{
										width: part.width ? `${part.width}px` : undefined,
										height: part.height ? `${part.height}px` : "auto",
									}}
								/>
							))}
							{paperTint ? (
								<div
									aria-hidden
									className="pointer-events-none absolute inset-0 mix-blend-multiply"
									style={{ backgroundColor: paperTint }}
								/>
							) : null}
						</div>
					) : (
						<div
							className="flex items-center justify-center"
							style={{ height: Math.max(LOADING_MIN_HEIGHT, contentHeight) }}
						>
							<Loader2
								className="size-4 animate-spin text-muted-foreground"
								aria-label={t("crossref.loading")}
							/>
						</div>
					)}
				</ScrollAreaPrimitive.Viewport>
				<ScrollBar className="z-10 [&>[data-slot=scroll-area-thumb]]:bg-current/30" />
				<ScrollBar
					orientation="horizontal"
					className="z-10 [&>[data-slot=scroll-area-thumb]]:bg-current/30"
				/>
				<ScrollAreaPrimitive.Corner />
			</ScrollAreaPrimitive.Root>
		</div>
	);
}
