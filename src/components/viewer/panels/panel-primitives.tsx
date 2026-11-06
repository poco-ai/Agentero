import type * as React from "react";
import { cn } from "@/lib/core/utils";

/** Hoverable row card shared by the PDF annotations / references panels. */
export function PanelCard({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"group relative rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:border-border/60 hover:bg-muted/40",
				className,
			)}
			{...props}
		/>
	);
}

/** Reveals on card hover or keyboard focus inside the card. */
export function PanelCardActions({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"absolute top-2 right-2 flex items-center gap-0.5 rounded-lg bg-background/80 p-0.5 opacity-0 shadow-raised ring-1 ring-border/60 backdrop-blur-sm transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100",
				className,
			)}
			{...props}
		/>
	);
}

type PanelCardButtonProps = Omit<
	React.ComponentProps<"div">,
	"onClick" | "role" | "tabIndex"
> & {
	onActivate?: () => void;
};

/** Focusable card body; Enter and Space activate it like a native button. */
export function PanelCardButton({
	className,
	onActivate,
	onKeyDown,
	children,
	...props
}: PanelCardButtonProps) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: a real button cannot contain the card's action buttons
		<div
			role="button"
			tabIndex={0}
			className={cn(
				"block w-full cursor-pointer rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
				className,
			)}
			onClick={onActivate}
			onKeyDown={(event) => {
				onKeyDown?.(event);
				if (event.defaultPrevented) return;
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onActivate?.();
				}
			}}
			{...props}
		>
			{children}
		</div>
	);
}

/** Centered icon + copy used when a panel has nothing to list. */
export function PanelEmptyState({
	icon,
	text,
	children,
	className,
}: {
	icon: React.ReactNode;
	text: string;
	children?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center",
				className,
			)}
		>
			<div className="flex size-12 items-center justify-center rounded-2xl bg-muted/70 text-muted-foreground">
				{icon}
			</div>
			<p className="max-w-[15rem] text-muted-foreground text-xs leading-relaxed">
				{text}
			</p>
			{children}
		</div>
	);
}
