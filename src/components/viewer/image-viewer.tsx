import { useTranslation } from "react-i18next";

import { cn } from "@/lib/core/utils";
import { isImageViewerSource } from "@/lib/workspace/viewer";

type ImageViewerProps = {
	/** Local `blob:` URL (or remote https) for the image. */
	source: string | null;
	/** Accessible name (usually file basename). */
	alt?: string;
	className?: string;
};

/**
 * Center-pane image preview: scrollable, contain-fit, no edit tools.
 */
export function ImageViewer({ source, alt, className }: ImageViewerProps) {
	const { t } = useTranslation("viewer");

	if (!isImageViewerSource(source)) {
		return (
			<div
				className={cn(
					"flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm",
					className,
				)}
			>
				{t("image.empty")}
			</div>
		);
	}

	return (
		<div
			className={cn(
				"agentero-scroll-both relative flex h-full min-h-0 w-full min-w-0 items-center justify-center overflow-auto bg-muted/20 p-4",
				className,
			)}
		>
			<img
				src={source}
				alt={alt?.trim() || t("image.altFallback")}
				className="max-h-full max-w-full object-contain shadow-raised"
				draggable={false}
			/>
		</div>
	);
}
