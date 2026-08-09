"use client";

import * as ToolbarPrimitive from "@radix-ui/react-toolbar";
import * as React from "react";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";

export function Toolbar({
	className,
	...props
}: React.ComponentProps<typeof ToolbarPrimitive.Root>) {
	return (
		<ToolbarPrimitive.Root
			className={cn("relative flex select-none items-center", className)}
			{...props}
		/>
	);
}

const toolbarButtonClassName =
	"inline-flex h-8 min-w-8 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-transparent px-1.5 font-medium text-sm outline-none transition-[color,box-shadow] hover:bg-muted hover:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-checked:bg-accent aria-checked:text-accent-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

type ToolbarButtonProps = {
	/** Pass a boolean to render a toggle, so the state gets `aria-checked`. */
	pressed?: boolean;
	tooltip?: React.ReactNode;
} & Omit<
	React.ComponentProps<typeof ToolbarPrimitive.ToggleItem>,
	"asChild" | "value"
>;

export function ToolbarButton({
	children,
	className,
	pressed,
	tooltip,
	...props
}: ToolbarButtonProps) {
	// Tooltip content portals on mount; rendering it during the first pass would
	// attach before the provider above is ready.
	const [mounted, setMounted] = React.useState(false);
	React.useEffect(() => {
		setMounted(true);
	}, []);

	const button =
		typeof pressed === "boolean" ? (
			<ToolbarPrimitive.ToolbarToggleGroup
				className="flex items-center"
				disabled={props.disabled}
				value="single"
				type="single"
			>
				<ToolbarPrimitive.ToggleItem
					className={cn(toolbarButtonClassName, className)}
					value={pressed ? "single" : ""}
					{...props}
				>
					{children}
				</ToolbarPrimitive.ToggleItem>
			</ToolbarPrimitive.ToolbarToggleGroup>
		) : (
			<ToolbarPrimitive.Button
				className={cn(toolbarButtonClassName, className)}
				{...props}
			>
				{children}
			</ToolbarPrimitive.Button>
		);

	if (!tooltip || !mounted) return button;

	return (
		<Tooltip>
			<TooltipTrigger asChild>{button}</TooltipTrigger>
			{/* Must use the same radix package as Tooltip (ui/tooltip → radix-ui).
			    A local @radix-ui/react-tooltip Portal does not share context. */}
			<TooltipContent sideOffset={4}>{tooltip}</TooltipContent>
		</Tooltip>
	);
}
