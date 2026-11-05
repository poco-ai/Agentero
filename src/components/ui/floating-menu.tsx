import type * as React from "react";
import { ViewportFloating } from "@/components/ui/viewport-floating";
import { cn } from "@/lib/core/utils";

/** Matches `ContextMenuContent` / `DropdownMenuContent` so custom menus look native. */
const FLOATING_MENU_SURFACE =
	"z-50 min-w-44 rounded-lg bg-popover p-1.5 text-popover-foreground shadow-overlay ring-1 ring-foreground/10";

type FloatingMenuProps = React.ComponentProps<typeof ViewportFloating>;

/**
 * Screen-anchored menu for custom triggers (file tree, Plaza card menus).
 * Radix menus cover normal trigger flows; this keeps their surface and row
 * density when the anchor is a raw pointer position.
 */
export function FloatingMenu({ className, ...props }: FloatingMenuProps) {
	return (
		<ViewportFloating
			{...props}
			role="menu"
			className={cn(FLOATING_MENU_SURFACE, className)}
		/>
	);
}

type FloatingMenuItemProps = React.ComponentProps<"button"> & {
	variant?: "default" | "destructive";
};

export function FloatingMenuItem({
	className,
	variant = "default",
	type,
	...props
}: FloatingMenuItemProps) {
	return (
		<button
			type={type ?? "button"}
			role="menuitem"
			data-variant={variant}
			className={cn(
				"flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				variant === "destructive" &&
					"text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive",
				className,
			)}
			{...props}
		/>
	);
}

export function FloatingMenuSeparator({
	className,
	...props
}: React.ComponentProps<"hr">) {
	return (
		<hr
			className={cn("-mx-1.5 my-1 h-px border-0 bg-border", className)}
			{...props}
		/>
	);
}

export function FloatingMenuShortcut({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"ml-auto pl-4 text-muted-foreground text-xs tracking-wide",
				className,
			)}
			{...props}
		/>
	);
}
