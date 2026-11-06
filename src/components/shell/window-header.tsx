import type * as React from "react";
import { cn } from "@/lib/core/utils";

/** Frosted 32px drag strip shared by the main, feature, and document windows. */
export function WindowHeader({
	className,
	...props
}: React.ComponentProps<"header">) {
	return (
		<header
			data-titlebar
			className={cn(
				"flex h-8 shrink-0 items-center border-b border-border/50 bg-background/75 backdrop-blur-xl backdrop-saturate-150 select-none supports-backdrop-blur:bg-background/65",
				className,
			)}
			{...props}
		/>
	);
}
