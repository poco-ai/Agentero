import { type CSSProperties, type ElementType, memo } from "react";
import { cn } from "@/lib/core/utils";

export interface TextShimmerProps {
	children: string;
	as?: ElementType;
	className?: string;
	duration?: number;
	spread?: number;
}

/** Project text labels composed with the upstream shadcn shimmer utility. */
export const Shimmer = memo(
	({
		children,
		as: Component = "p",
		className,
		duration = 2,
		spread = 2,
	}: TextShimmerProps) => (
		<Component
			className={cn(
				"shimmer inline-block motion-reduce:shimmer-none",
				className,
			)}
			style={
				{
					"--shimmer-duration": `${duration}s`,
					"--shimmer-spread": `${children.length * spread}px`,
				} as CSSProperties
			}
		>
			{children}
		</Component>
	),
);
