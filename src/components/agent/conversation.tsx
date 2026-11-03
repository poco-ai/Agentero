"use client";

import type { ComponentProps, RefObject } from "react";
import { createContext, useContext, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	MessageScroller,
	MessageScrollerButton,
	type MessageScrollerContent,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { prefersReducedMotion } from "@/lib/core/motion";
import { cn } from "@/lib/core/utils";

export type ConversationProps = ComponentProps<typeof MessageScroller>;

const ConversationViewportContext =
	createContext<RefObject<HTMLDivElement | null> | null>(null);

/** Business adapter for the transcript virtualizer; upstream owns scrolling. */
export function useConversationViewport() {
	const viewport = useContext(ConversationViewportContext);
	if (!viewport) throw new Error("Missing Conversation provider");
	return viewport;
}

export const Conversation = ({ className, ...props }: ConversationProps) => {
	const viewport = useRef<HTMLDivElement>(null);
	return (
		<ConversationViewportContext.Provider value={viewport}>
			<MessageScrollerProvider autoScroll defaultScrollPosition="end">
				<MessageScroller
					className={cn("relative flex-1 overflow-y-hidden", className)}
					{...props}
				/>
			</MessageScrollerProvider>
		</ConversationViewportContext.Provider>
	);
};

export type ConversationContentProps = ComponentProps<
	typeof MessageScrollerContent
> & {
	/** Class on the scroll viewport (scrollbar lives here — use full width of the chat pane). */
	scrollClassName?: string;
};

export const ConversationContent = ({
	className,
	scrollClassName,
	...props
}: ConversationContentProps) => {
	const viewport = useConversationViewport();
	const { t } = useTranslation("aiElements");
	return (
		<MessageScrollerViewport
			ref={viewport}
			aria-label={t("conversation.messages")}
			className={cn(
				"agentero-scroll [scrollbar-gutter:stable]",
				scrollClassName,
			)}
		>
			<div className={cn("flex flex-col gap-6 p-4", className)} {...props} />
		</MessageScrollerViewport>
	);
};

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
	title?: string;
	description?: string;
	icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
	className,
	title,
	description,
	icon,
	children,
	...props
}: ConversationEmptyStateProps) => {
	const { t } = useTranslation("aiElements");
	const resolvedTitle = title ?? t("conversation.empty.title");
	const resolvedDescription =
		description ?? t("conversation.empty.description");

	return (
		<div
			className={cn(
				"flex size-full select-none flex-col items-center justify-center gap-3 p-8 text-center",
				className,
			)}
			{...props}
		>
			{children ?? (
				<>
					{icon && <div className="text-muted-foreground">{icon}</div>}
					<div className="space-y-1">
						<h3 className="font-medium text-sm">{resolvedTitle}</h3>
						{resolvedDescription && (
							<p className="text-muted-foreground text-sm">
								{resolvedDescription}
							</p>
						)}
					</div>
				</>
			)}
		</div>
	);
};

export type ConversationScrollButtonProps = ComponentProps<
	typeof MessageScrollerButton
>;

export const ConversationScrollButton = ({
	className,
	...props
}: ConversationScrollButtonProps) => {
	const { t } = useTranslation("aiElements");

	return (
		<MessageScrollerButton
			className={cn(
				"absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
				className,
			)}
			behavior={prefersReducedMotion() ? "instant" : "smooth"}
			aria-label={t("conversation.scrollToEnd")}
			size="icon"
			type="button"
			variant="outline"
			{...props}
		/>
	);
};
