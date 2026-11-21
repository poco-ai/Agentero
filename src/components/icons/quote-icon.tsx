import { type LucideIcon, type LucideProps, Quote } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/core/utils";

/**
 * Lucide `quote`, optically calibrated for icon rows.
 *
 * Both marks are outlined, so the glyph carries roughly twice the contour of
 * the H1/H2/H3, bold, italic and list icons it is drawn next to: at the row's
 * shared 16px / 2px stroke it reads bigger and heavier than the rest of the
 * bar. Draw it one step smaller (14px) with a proportionally thinner stroke.
 * Callers may still override the size class for denser rows such as chips.
 */
export const QuoteIcon: LucideIcon = forwardRef<SVGSVGElement, LucideProps>(
	function QuoteIcon({ className, strokeWidth = 1.8, ...props }, ref) {
		return (
			<Quote
				ref={ref}
				{...props}
				strokeWidth={strokeWidth}
				className={cn("size-3.5", className)}
			/>
		);
	},
);
