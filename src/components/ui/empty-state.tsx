import type * as React from "react";
import { cn } from "@/lib/core/utils";

/** Centered message for a viewer surface with nothing to render. */
export function EmptyState({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm",
				className,
			)}
			{...props}
		/>
	);
}
