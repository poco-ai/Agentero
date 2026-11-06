import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/core/utils";

type QuietIconButtonProps = React.ComponentProps<typeof Button> & {
	/** Destructive actions keep the muted default and only color the hover. */
	tone?: "default" | "destructive";
};

/**
 * Compact muted icon button for dense chrome: panel headers, hover action
 * bars, and PDF overlays. Pair with a Tooltip when the icon is not obvious.
 */
export function QuietIconButton({
	className,
	tone = "default",
	...props
}: QuietIconButtonProps) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			className={cn(
				"size-6 text-muted-foreground",
				tone === "destructive"
					? "hover:text-destructive"
					: "hover:text-foreground",
				className,
			)}
			{...props}
		/>
	);
}
