"use client";

import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, useContext, useEffect } from "react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
	MessageContent as MessageBody,
	MessageFooter,
	Message as MessageRoot,
} from "@/components/ui/message";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import { installRenderedMathCopy } from "@/lib/markdown/rendered-math-copy";

export {
	MessageResponse,
	type MessageResponseProps,
} from "@/components/agent/rendering/message-response";

const MessageRole = createContext<UIMessage["role"]>("assistant");

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
	from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
	<MessageRole.Provider value={from}>
		<MessageRoot
			align={from === "user" ? "end" : "start"}
			className={cn(
				"group flex w-full max-w-[95%] flex-col gap-2 data-[align=end]:flex-col",
				from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
				className,
			)}
			{...props}
		/>
	</MessageRole.Provider>
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
	children,
	className,
	...props
}: MessageContentProps) => {
	const from = useContext(MessageRole);
	// Copying a text selection from a rendered AI reply should keep formulas as
	// `$…$` Markdown instead of KaTeX glyph soup. One document listener covers
	// every message; the `data-markdown-copy` marker scopes it to chat surfaces.
	useEffect(() => {
		installRenderedMathCopy();
	}, []);
	return (
		<MessageBody
			data-markdown-copy
			className={cn(
				"flex w-fit min-w-0 max-w-full select-text flex-col gap-2 overflow-hidden text-sm",
				"group-[.is-assistant]:text-foreground",
				className,
			)}
			{...props}
		>
			{from === "user" ? (
				<Bubble align="end" variant="muted" className="max-w-full">
					<BubbleContent className="px-4 py-3">{children}</BubbleContent>
				</Bubble>
			) : (
				children
			)}
		</MessageBody>
	);
};

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
	className,
	children,
	...props
}: MessageActionsProps) => (
	<MessageFooter className={cn("gap-1 px-0", className)} {...props}>
		{children}
	</MessageFooter>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
	tooltip?: string;
	label?: string;
};

export const MessageAction = ({
	tooltip,
	children,
	label,
	variant = "ghost",
	size = "icon-sm",
	...props
}: MessageActionProps) => {
	const button = (
		<Button size={size} type="button" variant={variant} {...props}>
			{children}
			<span className="sr-only">{label || tooltip}</span>
		</Button>
	);

	if (tooltip) {
		return (
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					<TooltipContent>
						<p>{tooltip}</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		);
	}

	return button;
};
