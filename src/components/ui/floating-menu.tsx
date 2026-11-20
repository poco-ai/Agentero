import type * as React from "react";
import { ViewportFloating } from "@/components/ui/viewport-floating";
import { cn } from "@/lib/core/utils";

/**
 * Pointer-anchored menu surface, tuned like a macOS context menu: a compact
 * translucent material (blur + light hairline), 10px corners, and tight insets.
 * `prefers-reduced-transparency` falls back to the solid popover token.
 */
const FLOATING_MENU_SURFACE =
	"z-50 min-w-44 rounded-[10px] bg-popover/90 p-1 text-popover-foreground shadow-overlay ring-1 ring-foreground/[0.08] backdrop-blur-xl [@media(prefers-reduced-transparency:reduce)]:bg-popover [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none";

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
				"flex w-full cursor-default items-center gap-2.5 rounded-[6px] px-2.5 py-[5px] text-left text-[13px] leading-[18px] tracking-[0.005em] outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground active:bg-accent/80 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
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
			// macOS-style separator: inset hairline at low contrast, never a full-width rule.
			className={cn("mx-2 my-1 h-px border-0 bg-border/60", className)}
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
				"ml-auto pl-4 text-[11px] text-muted-foreground leading-[18px] tracking-[0.02em] tabular-nums",
				className,
			)}
			{...props}
		/>
	);
}
