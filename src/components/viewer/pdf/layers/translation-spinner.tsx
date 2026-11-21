import { Loader2 } from "lucide-react";
import { cn } from "@/lib/core/utils";

/**
 * Independent from text layout and native selection/copy. The colour is a
 * paper-mark token, so it is light on dark paper and dark on light paper
 * without a `tone` prop at the call site.
 */
export function TranslationSpinner({
	x,
	y,
	size,
}: {
	x: number;
	y: number;
	size: number;
}) {
	return (
		<Loader2
			aria-hidden="true"
			data-translation-spinner
			className={cn(
				"pdf-translation-spinner pointer-events-none absolute z-[7] animate-spin select-none motion-reduce:animate-none",
			)}
			style={{ left: x, top: y, width: size, height: size }}
		/>
	);
}
