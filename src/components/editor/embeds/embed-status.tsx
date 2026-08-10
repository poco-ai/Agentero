"use client";

import { cn } from "@/lib/core/utils";

/**
 * Inline placeholder shared by every embed kind for loading / missing / error.
 * Rendered as a `span` because embeds live inside inline Plate nodes.
 */
export function EmbedStatus({
	message,
	/** Annotation embeds sit in a tighter card and use reduced padding. */
	compact,
	className,
	/**
	 * Mark the placeholder as pending so note export (`waitForExportReady`)
	 * waits for the async embed content instead of capturing the placeholder.
	 */
	exportPending,
}: {
	message: string;
	compact?: boolean;
	className?: string;
	exportPending?: boolean;
}) {
	return (
		<span
			data-export-pending={exportPending ? "true" : undefined}
			className={cn(
				"block text-muted-foreground text-sm",
				compact ? "px-3 py-2" : "px-4 py-3",
				className,
			)}
		>
			{message}
		</span>
	);
}
