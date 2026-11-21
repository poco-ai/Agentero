import { Check, Square } from "lucide-react";
import type { MotionValue } from "motion/react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/core/utils";

/**
 * Shared full-text translation meter vocabulary.
 *
 * Mirrors the app's `ui/progress` recipe (rounded track, ink fill, tabular
 * percentage) so the reader chrome speaks the same progress language as the
 * figures panel and the background-task HUD. The track uses a foreground veil
 * instead of `bg-muted`, which disappears over the translucent chrome chip.
 */
export const PDF_TRANSLATE_METER_STAGE =
	"truncate text-caption font-medium leading-none text-foreground/80";

export const PDF_TRANSLATE_METER_PERCENT =
	"shrink-0 text-caption leading-none text-muted-foreground tabular-nums";

/**
 * The 4px progress rail. Sits inset from the chip's rounded silhouette rather
 * than flush against the edge, so it reads as content inside the material.
 */
export function PdfTranslateMeterBar({
	indeterminate,
	width,
	className,
}: {
	indeterminate: boolean;
	width: MotionValue<string> | string;
	className?: string;
}) {
	return (
		<span
			aria-hidden
			className={cn(
				"pointer-events-none absolute bottom-0.5 left-2.5 right-7 h-1 overflow-hidden rounded-full bg-foreground/10",
				className,
			)}
		>
			<motion.span
				className={cn(
					"absolute inset-y-0 left-0 rounded-full bg-primary",
					indeterminate && "pdf-translate-indeterminate",
				)}
				style={{ width: indeterminate ? "30%" : width }}
			/>
		</span>
	);
}

/**
 * The running readout that fills an expanded meter: stage caption, page count,
 * percentage, cancel square, and rail. The reader toolbar grows it out of the
 * translate button; the dual-pane translation panel mounts it in its own
 * capsule. Sharing the anatomy (caption typography, rail inset, trailing
 * control) keeps both panes speaking one progress language instead of two
 * near-miss pills.
 *
 * The readout is sized by its content. Once the job can report page counts the
 * caption is dropped: it was always the first thing to truncate (`正…`) and it
 * only repeated what the count already says. The chip therefore tracks the
 * numbers instead of holding a fixed width open for a caption nobody can read.
 */
export function PdfTranslateMeterReadout({
	stage,
	pagesLabel,
	percent,
	indeterminate,
	width,
	retracting = false,
	lingerFull,
	showStop,
	stopLabel,
	onStop,
	stopDisabled = false,
}: {
	stage: string;
	pagesLabel: string | null;
	percent: number;
	indeterminate: boolean;
	width: MotionValue<string> | string;
	/** Cancelled: fade the numbers while the rail drains, keeping the width. */
	retracting?: boolean;
	lingerFull: boolean;
	/** Only the callers that can actually cancel pass true while running. */
	showStop: boolean;
	stopLabel: string;
	onStop: () => void;
	stopDisabled?: boolean;
}) {
	// The caption speaks only while there is no page count to speak for it. A
	// caption next to a count was always the thing that truncated.
	const caption = pagesLabel ? null : stage;
	return (
		<span className="relative flex h-6 items-center">
			<span
				className={cn(
					"pointer-events-none flex min-w-0 items-center gap-2 pb-0.5 pl-2.5 pr-1 transition-opacity duration-150",
					// Cancelling: the numbers fade while the rail drains, so the chip
					// keeps its width for the retract instead of collapsing around it.
					retracting && "opacity-0",
				)}
			>
				{caption ? (
					<span
						aria-hidden
						// String concat, not `cn`: tailwind-merge mistakes
						// `text-caption` for a text color and drops it.
						className={`max-w-36 ${PDF_TRANSLATE_METER_STAGE}`}
					>
						{caption}
					</span>
				) : null}
				{pagesLabel ? (
					<span aria-hidden className={PDF_TRANSLATE_METER_PERCENT}>
						{pagesLabel}
					</span>
				) : null}
				{indeterminate ? null : (
					<span aria-hidden className={PDF_TRANSLATE_METER_PERCENT}>
						{percent}%
					</span>
				)}
			</span>
			<span className="flex size-6 shrink-0 items-center justify-center">
				{lingerFull ? (
					<Check className="size-3.5 text-foreground/70" aria-hidden />
				) : showStop && !retracting ? (
					<Button
						type="button"
						size="icon-xs"
						variant="ghost"
						className="size-6 text-foreground"
						aria-label={stopLabel}
						title={stopLabel}
						disabled={stopDisabled}
						onClick={onStop}
					>
						<Square className="size-2.5 fill-current opacity-60" aria-hidden />
					</Button>
				) : null}
			</span>
			<PdfTranslateMeterBar indeterminate={indeterminate} width={width} />
		</span>
	);
}
