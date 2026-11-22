import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/core/utils";
import { TRANSLATION_SPINNER_SIZE } from "@/lib/pdf/layout/translation-spinner";

/**
 * In-place retry for a paragraph whose translation failed after the
 * reliability layer's retries exhausted.
 *
 * It sits exactly where the running spinner was — the paragraph tail — so a
 * failed page never needs a toast: the warning is the feedback and clicking it
 * retries that paragraph's page (the same path as the page tab's "translate
 * this page"). Kept independent from text layout so it stays clickable above
 * the translated or source glyphs.
 */
export function TranslationRetryMarker({
	x,
	y,
	size,
	label,
	onRetry,
}: {
	x: number;
	y: number;
	size: number;
	label: string;
	onRetry: () => void;
}) {
	const glyph = Math.max(size, TRANSLATION_SPINNER_SIZE);
	const hit = glyph + 4;
	const offset = (hit - size) / 2;
	return (
		<button
			type="button"
			data-translation-retry
			aria-label={label}
			title={label}
			className={cn(
				"pdf-translation-retry pointer-events-auto absolute z-[8] flex cursor-pointer items-center justify-center rounded-full transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			)}
			style={{ left: x - offset, top: y - offset, width: hit, height: hit }}
			onClick={(event) => {
				event.preventDefault();
				event.stopPropagation();
				onRetry();
			}}
			onPointerDown={(event) => event.stopPropagation()}
		>
			<TriangleAlert
				style={{ width: glyph, height: glyph }}
				aria-hidden="true"
			/>
		</button>
	);
}
