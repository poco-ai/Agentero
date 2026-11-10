import type { MotionValue } from "motion/react";
import { motion } from "motion/react";
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
 * The 3px progress rail. Sits inset from the chip's rounded silhouette rather
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
