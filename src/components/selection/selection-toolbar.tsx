import type * as React from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";

type SelectionToolbarProps = React.ComponentProps<"div"> & {
	/** Frost the bar while it covers the text it belongs to. */
	dimmed?: boolean;
};

/**
 * Floating action bar for a text selection. Callers own the anchor math and
 * pass `fixed` / `absolute` positioning; this keeps the surface, height, and
 * dimming identical across PDF, Plaza, and annotation menus.
 */
export function SelectionToolbar({
	className,
	dimmed = false,
	...props
}: SelectionToolbarProps) {
	return (
		<div
			role="toolbar"
			className={cn(
				"flex h-8 items-center gap-0.5 rounded-lg border border-border/80 bg-background px-1 shadow-overlay ring-1 ring-foreground/10 transition-[background-color,opacity] duration-150 dark:ring-white/10",
				dimmed &&
					"bg-background/80 opacity-70 backdrop-blur-sm hover:bg-background hover:opacity-100",
				className,
			)}
			{...props}
		/>
	);
}

export function SelectionToolbarDivider({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("mx-0.5 h-4 w-px shrink-0 bg-border", className)}
			{...props}
		/>
	);
}

type SelectionToolbarActionProps = Omit<
	React.ComponentProps<"button">,
	"children"
> & {
	label: string;
	shortcut?: string;
	/** Overrides the default `label + shortcut` accessible name. */
	ariaLabel?: string;
};

/** Text action with an optional shortcut hint. */
export function SelectionToolbarAction({
	label,
	shortcut,
	ariaLabel,
	className,
	onPointerDown,
	...props
}: SelectionToolbarActionProps) {
	return (
		<button
			type="button"
			aria-label={
				ariaLabel ?? (shortcut !== undefined ? `${label} ${shortcut}` : label)
			}
			className={cn(
				"inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-caption text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100",
				className,
			)}
			onPointerDown={(event) => {
				onPointerDown?.(event);
				if (!event.defaultPrevented) event.preventDefault();
			}}
			{...props}
		>
			<span>{label}</span>
			{shortcut !== undefined ? (
				<kbd className="translate-y-px scale-90 font-normal text-caption text-muted-foreground/80 tabular-nums">
					{shortcut}
				</kbd>
			) : null}
		</button>
	);
}

type SelectionToolbarIconButtonProps = {
	label: string;
	shortcut?: string;
	/** Hover tooltip text; defaults to `label`. */
	tooltip?: React.ReactNode;
	tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
	onClick?: () => void;
	disabled?: boolean;
	className?: string;
	children: React.ReactNode;
};

/** Icon action on the selection bar; keeps the selection while clicking. */
export function SelectionToolbarIconButton({
	label,
	shortcut,
	tooltip,
	tooltipSide = "top",
	onClick,
	disabled,
	className,
	children,
}: SelectionToolbarIconButtonProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={shortcut !== undefined ? `${label} ${shortcut}` : label}
					disabled={disabled}
					className={className}
					onPointerDown={(event) => event.preventDefault()}
					onClick={onClick}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent side={tooltipSide}>{tooltip ?? label}</TooltipContent>
		</Tooltip>
	);
}
