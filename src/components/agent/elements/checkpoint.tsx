"use client";

import type { LucideProps } from "lucide-react";
import { BookmarkIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";

export type CheckpointProps = HTMLAttributes<HTMLDivElement>;

export const Checkpoint = ({
	className,
	children,
	...props
}: CheckpointProps) => (
	<Marker
		variant="separator"
		className={cn(
			"flex items-center gap-0.5 overflow-hidden text-muted-foreground",
			className,
		)}
		{...props}
	>
		<MarkerContent className="inline-flex items-center gap-0.5">
			{children}
		</MarkerContent>
	</Marker>
);

export type CheckpointIconProps = LucideProps;

export const CheckpointIcon = ({
	className,
	children,
	...props
}: CheckpointIconProps) => (
	<MarkerIcon>
		{children ?? (
			<BookmarkIcon className={cn("size-4 shrink-0", className)} {...props} />
		)}
	</MarkerIcon>
);

export type CheckpointTriggerProps = ComponentProps<typeof Button> & {
	tooltip?: string;
};

export const CheckpointTrigger = ({
	children,
	variant = "ghost",
	size = "sm",
	tooltip,
	...props
}: CheckpointTriggerProps) =>
	tooltip ? (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button size={size} type="button" variant={variant} {...props}>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent align="start" side="bottom">
				{tooltip}
			</TooltipContent>
		</Tooltip>
	) : (
		<Button size={size} type="button" variant={variant} {...props}>
			{children}
		</Button>
	);
