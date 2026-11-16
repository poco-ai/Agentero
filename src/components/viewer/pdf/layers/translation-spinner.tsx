import { Loader2 } from "lucide-react";
import { cn } from "@/lib/core/utils";
import type { PdfPaperTone } from "@/lib/pdf/page-theme";

/** Independent from text layout and native selection/copy. */
export function TranslationSpinner({
	x,
	y,
	size,
	tone,
}: {
	x: number;
	y: number;
	size: number;
	tone: PdfPaperTone;
}) {
	return (
		<Loader2
			aria-hidden="true"
			data-translation-spinner
			className={cn(
				"pointer-events-none absolute z-[7] animate-spin select-none motion-reduce:animate-none",
				tone === "dark" ? "text-zinc-100" : "text-zinc-700",
			)}
			style={{ left: x, top: y, width: size, height: size }}
		/>
	);
}
