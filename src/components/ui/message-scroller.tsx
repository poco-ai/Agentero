"use client";

import {
	MessageScroller as Primitive,
	useMessageScroller,
	useMessageScrollerScrollable,
	useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller";
import { ArrowDownIcon } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/core/utils";

// Source: shadcn/ui radix-nova message-scroller registry.
function MessageScrollerProvider(
	props: React.ComponentProps<typeof Primitive.Provider>,
) {
	return <Primitive.Provider {...props} />;
}

function MessageScroller({
	className,
	...props
}: React.ComponentProps<typeof Primitive.Root>) {
	return (
		<Primitive.Root
			data-slot="message-scroller"
			className={cn(
				"group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
				className,
			)}
			{...props}
		/>
	);
}

function MessageScrollerViewport({
	className,
	...props
}: React.ComponentProps<typeof Primitive.Viewport>) {
	return (
		<Primitive.Viewport
			data-slot="message-scroller-viewport"
			className={cn(
				"size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain contain-content data-pending-scroll:invisible",
				className,
			)}
			{...props}
		/>
	);
}

function MessageScrollerContent({
	className,
	...props
}: React.ComponentProps<typeof Primitive.Content>) {
	return (
		<Primitive.Content
			data-slot="message-scroller-content"
			className={cn("flex h-max min-h-full flex-col gap-6", className)}
			{...props}
		/>
	);
}

function MessageScrollerItem({
	className,
	scrollAnchor = false,
	...props
}: React.ComponentProps<typeof Primitive.Item>) {
	return (
		<Primitive.Item
			data-slot="message-scroller-item"
			scrollAnchor={scrollAnchor}
			className={cn(
				"min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
				className,
			)}
			{...props}
		/>
	);
}

function MessageScrollerButton({
	direction = "end",
	className,
	children,
	render,
	variant = "secondary",
	size = "icon-sm",
	...props
}: React.ComponentProps<typeof Primitive.Button> &
	Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
	return (
		<Primitive.Button
			data-slot="message-scroller-button"
			direction={direction}
			className={cn(
				"absolute left-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0",
				direction === "end" ? "bottom-4" : "top-4 [&_svg]:rotate-180",
				className,
			)}
			render={render ?? <Button variant={variant} size={size} />}
			{...props}
		>
			{children ?? <ArrowDownIcon />}
		</Primitive.Button>
	);
}

export {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
	useMessageScroller,
	useMessageScrollerScrollable,
	useMessageScrollerVisibility,
};
