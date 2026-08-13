import { FileUp } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLibraryPdfDrop } from "@/components/library/hooks/use-library-pdf-drop";
import { cn } from "@/lib/core/utils";

/** Library table shell: Finder PDF drop overlay + import confirm. */
export function LibraryPdfDropSurface({
	scopePath,
	className,
	children,
}: {
	scopePath: string | null | undefined;
	className?: string;
	children: ReactNode;
}) {
	const { t } = useTranslation("sidebar");
	const {
		shellRef,
		isPdfDragOver,
		onPdfDragEnter,
		onPdfDragLeave,
		onPdfDragOver,
		onPdfDrop,
	} = useLibraryPdfDrop(scopePath);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: OS file drop target, not a keyboard control
		<div
			ref={shellRef}
			data-library-drop-shell
			className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", className)}
			onDragEnter={onPdfDragEnter}
			onDragLeave={onPdfDragLeave}
			onDragOver={onPdfDragOver}
			onDrop={onPdfDrop}
		>
			{children}
			{isPdfDragOver ? (
				<div
					className={cn(
						"pointer-events-none absolute inset-0 z-20 flex items-center justify-center",
						"border-2 border-primary/50 border-dashed bg-primary/10 backdrop-blur-[1px]",
					)}
					aria-hidden
				>
					<div className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/90 px-3 py-1.5 text-primary text-xs font-medium shadow-sm">
						<FileUp className="size-3.5 shrink-0" />
						<span>{t("papersLibrary.dropPdfHint")}</span>
					</div>
				</div>
			) : null}
		</div>
	);
}
