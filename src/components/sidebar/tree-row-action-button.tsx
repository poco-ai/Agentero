/**
 * Icon action rendered inside a tree row's trailing action slot.
 *
 * Keeps one look for row actions: a compact ghost button whose icon moves from
 * the muted color to the foreground color on hover, inverts with the row when
 * selected, and is announced by the shared tooltip on the right. `trigger` lets
 * a popover own the same button without duplicating styles or the tooltip.
 */
import type { ComponentProps, ReactNode } from "react";
import { TREE_ROW_TEXT_STATE } from "@/components/sidebar/tree-row-styles";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";

const TREE_ROW_ACTION_BUTTON_CLASS = cn(
	"size-5 shrink-0",
	TREE_ROW_TEXT_STATE,
	"hover:bg-transparent active:bg-transparent active:text-foreground aria-expanded:bg-transparent dark:hover:bg-transparent dark:active:bg-transparent group-aria-selected:text-sidebar-primary-foreground group-aria-selected:hover:text-sidebar-primary-foreground group-aria-selected:active:text-sidebar-primary-foreground group-aria-selected:aria-expanded:text-sidebar-primary-foreground [&[data-tree-row-action]_svg]:text-current",
);

type TreeRowActionButtonProps = Omit<
	ComponentProps<typeof Button>,
	"size" | "variant" | "aria-label"
> & {
	/** Accessible name, also the default tooltip body. */
	label: string;
	/** Rich tooltip body; falls back to `label`. */
	tooltip?: ReactNode;
	/** Extra classes for the shared tooltip bubble. */
	tooltipClassName?: string;
	/**
	 * Wrap the button before the tooltip trigger attaches, e.g.
	 * `(button) => <PopoverTrigger asChild>{button}</PopoverTrigger>`.
	 */
	trigger?: (button: ReactNode) => ReactNode;
};

export function TreeRowActionButton({
	label,
	tooltip,
	tooltipClassName,
	trigger,
	className,
	children,
	...props
}: TreeRowActionButtonProps) {
	const button = (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			className={cn(TREE_ROW_ACTION_BUTTON_CLASS, className)}
			data-tree-row-action=""
			aria-label={label}
			{...props}
		>
			{children}
		</Button>
	);

	return (
		<Tooltip disableHoverableContent>
			<TooltipTrigger asChild>
				{trigger ? trigger(button) : button}
			</TooltipTrigger>
			<TooltipContent
				side="right"
				className={cn("cursor-default", tooltipClassName)}
			>
				{tooltip ?? label}
			</TooltipContent>
		</Tooltip>
	);
}
