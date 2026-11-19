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
 * capsule. Sharing the anatomy (fixed 11rem surface, caption typography, rail
 * inset, trailing control) keeps both panes speaking one progress language
 * instead of two near-miss pills. The caller owns a relative, sized container.
 */
export function PdfTranslateMeterReadout({
	stage,
	pagesLabel,
	percent,
	indeterminate,
	width,
	retracting,
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
	retracting: boolean;
	lingerFull: boolean;
	/** Only the callers that can actually cancel pass true while running. */
	showStop: boolean;
	stopLabel: string;
	onStop: () => void;
	stopDisabled?: boolean;
}) {
	return (
		<>
			<span className="pointer-events-none absolute inset-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-reduce:animate-none">
				<span className="absolute top-0 right-7 bottom-[5px] left-2.5 flex items-center gap-2">
					{/* String concat, not `cn`: tailwind-merge mistakes
					    `text-caption` for a text color and drops it. */}
					<span
						aria-hidden
						className={`min-w-0 flex-1 truncate ${PDF_TRANSLATE_METER_STAGE}`}
					>
						{stage}
					</span>
					{pagesLabel && !retracting ? (
						<span aria-hidden className={PDF_TRANSLATE_METER_PERCENT}>
							{pagesLabel}
						</span>
					) : null}
					{indeterminate || retracting ? null : (
						<span aria-hidden className={PDF_TRANSLATE_METER_PERCENT}>
							{percent}%
						</span>
					)}
				</span>
				<PdfTranslateMeterBar indeterminate={indeterminate} width={width} />
			</span>
			{lingerFull ? (
				<span className="pointer-events-none absolute top-0 right-0 flex size-6 items-center justify-center text-foreground/70">
					<Check className="size-3.5" aria-hidden />
				</span>
			) : retracting || !showStop ? null : (
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					className="pointer-events-auto absolute top-0 right-0 size-6 text-foreground"
					aria-label={stopLabel}
					title={stopLabel}
					disabled={stopDisabled}
					onClick={onStop}
				>
					<Square className="size-2.5 fill-current opacity-60" aria-hidden />
				</Button>
			)}
		</>
	);
}
