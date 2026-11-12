import { Underline } from "lucide-react";
import { cn } from "@/lib/core/utils";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	HIGHLIGHT_HEX,
	type HighlightColor,
	swatchBorderClass,
	swatchColorClass,
} from "@/lib/pdf/highlight/palette";
import type { PdfTextMarkupKind } from "@/lib/pdf/highlight/types";

/** Quote row shared by note embeds and the composer reference card. */
export function AnnotationQuoteBlock({
	quote,
	translation,
	locationLabel,
	color = DEFAULT_HIGHLIGHT_COLOR,
	shape = "highlight",
	showSwatch = true,
	selectable = false,
	textClassName,
}: {
	quote?: string | null;
	translation?: string | null;
	locationLabel?: string | null;
	color?: HighlightColor;
	/** Text-markup shape; the swatch becomes an underline glyph when set. */
	shape?: PdfTextMarkupKind;
	showSwatch?: boolean;
	/** Let the quote and translation be drag-selected. */
	selectable?: boolean;
	textClassName?: string;
}) {
	const quoteText = quote?.trim() ? quote : null;
	if (!locationLabel && !quoteText) return null;
	return (
		<div>
			{locationLabel || showSwatch ? (
				<div className="flex items-center gap-1.5">
					{showSwatch ? (
						shape === "underline" ? (
							<Underline
								className="size-3 shrink-0"
								style={{ color: HIGHLIGHT_HEX[color] }}
								aria-hidden
							/>
						) : (
							<span
								className={cn(
									"size-2 shrink-0 rounded-full",
									swatchColorClass(color),
								)}
								aria-hidden
							/>
						)
					) : null}
					{locationLabel ? (
						<span
							className={cn(
								"min-w-0 truncate font-medium text-muted-foreground tracking-wide",
								textClassName,
							)}
							title={locationLabel}
						>
							{locationLabel}
						</span>
					) : null}
				</div>
			) : null}
			{quoteText ? (
				<blockquote
					data-annotation-selectable={selectable ? "" : undefined}
					className={cn(
						"border-l-2 pl-2.5 leading-relaxed text-muted-foreground whitespace-pre-wrap break-words",
						locationLabel || showSwatch ? "mt-1.5" : undefined,
						textClassName,
						selectable && "cursor-text select-text",
						showSwatch ? swatchBorderClass(color) : "border-border",
					)}
				>
					{quoteText}
					{translation?.trim() ? (
						<span
							className={cn(
								"mt-1 block leading-relaxed text-muted-foreground/60 whitespace-pre-wrap break-words",
								textClassName,
							)}
						>
							{translation}
						</span>
					) : null}
				</blockquote>
			) : null}
		</div>
	);
}
